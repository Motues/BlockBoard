// 运行期共享状态：socket / 画布 / 视口 / 视图状态 / 待确认队列 / 渲染调度 / 取色模式开关。
// 各功能模块都从这里取状态，避免模块之间互相 import 成环。

import { GAP_SIZE, PADDING_SIZE, SWITCH_SPIN_RATE } from './config.mjs';
import { loadCachedState } from './state-cache.mjs';

// 握手里告诉服务端自己认识哪些状态格式（见 src/server.ts 的 init-game）：
//   rgb24 = 24bit 取值（>= 16 是自定义颜色）+ 3 字节/格 的稠密状态
//   rle   = RLE 紧凑状态（跳过黑格，通常只有几十字节）
//   bin   = 状态用二进制发（ArrayBuffer），省掉 base64 的 33% 与客户端的 atob
//   batch = 认识合并广播 update-squares（一个 16ms 窗口内的多条单格改动合成一条）
//   chunk = 认识分块下发（state-chunk / state-done）：大棋盘不会一次性塞一条几 MB 的消息
//   sync  = 认识增量同步（sync-delta / sync-done）：重连时只补发差量
// 服务端会据此只发一份状态，并且只发客户端认识的格式
const STATE_CAPS = ['rgb24', 'rle', 'bin', 'batch', 'chunk', 'sync'];

// --- 本地缓存与同步版本号 ---
// 先把上次缓存的棋盘读出来（IndexedDB）：握手时带上它的 epoch / rev，
// 服务端能接上就只发差量，接不上就发全量。读缓存是异步的，所以这里用顶层 await ——
// 反正拿到 init-game 之前棋盘也没法画，导入本模块的模块会等它完成
let cachedState = null;
try {
    cachedState = await loadCachedState();
} catch {
    cachedState = null;
}

// epoch = 服务端的棋盘坐标空间世代；rev = 已应用到的状态变更消息版本号。
//   ready     = 本机这份状态是完整的（分块下发收齐 / 差量应用完才为真），没 ready 不能写缓存
//   claimable = 上面那个 epoch / rev 有没有"本机完整状态"兜底。分块下发中途为 false：
//               这时握手只能报"我没有"，否则服务端会以为我们持有对应版本的状态，只补差量，
//               结果是把差量套在一份残缺的棋盘上
export const syncInfo = {
    epoch: cachedState && Number.isInteger(cachedState.epoch) ? cachedState.epoch : 0,
    rev: cachedState && Number.isInteger(cachedState.rev) ? cachedState.rev : 0,
    ready: false,
    claimable: Boolean(cachedState)
};

export function getCachedState() {
    return cachedState;
}

/** 版本号只增不减：差量是绝对写入，乱序/重复应用都不会出错 */
export function setSyncRev(rev) {
    if (Number.isInteger(rev) && rev > syncInfo.rev) syncInfo.rev = rev;
}

export const socket = io({
    // 由 main.mjs 在所有模块接好之后显式 connect()：
    // 这样能保证 init-game 的处理器已经挂上，也不会漏掉第一帧之前的任何事件
    autoConnect: false,
    // 回调形式：每次（重）连都取当前的 epoch / rev。
    // 报不出可信的版本号时就报 0 / -1，让服务端发全量。
    //
    // 注意 socket.io-client 4.8 只支持这两种写法（见客户端 onopen：
    // `typeof this.auth == "function"` 时它调用 this.auth(cb)，否则发 this.auth 本身）：
    //   auth: (cb) => cb({ ... })      回调式（这里用的）
    //   auth: { ... }                  对象式（每个连接用同一份，取不到最新版本号）
    // **返回值的写法是无效的**：socket.io 不会看返回值，CONNECT 包永远发不出去 ——
    // 表现为传输层连上了（transport=websocket、connected=false），但 init-game 永远收不到，
    // 棋盘空白、在线人数停在 "..."、导出图片报 "board not ready"
    auth: (done) => done({
        caps: STATE_CAPS,
        epoch: syncInfo.claimable ? syncInfo.epoch : 0,
        rev: syncInfo.claimable ? syncInfo.rev : -1
    })
});

export const canvas = document.getElementById('board');
export const ctx = canvas.getContext('2d');

export const menuButton = document.getElementById('menu-button');
export const optionsPanel = document.getElementById('options-panel');

export const brushRingEl = document.getElementById('brush-ring');
export const colorPickerEl = document.getElementById('color-picker');

// --- 棋盘几何（棋盘内部坐标）---
export const board = {
    cols: 0,
    rows: 0,
    cellSize: 0,
    gap: GAP_SIZE,
    padding: PADDING_SIZE,
    width: 0,   // 总宽（含缝隙与留白）
    height: 0
};

// --- 视图状态（平移 / 缩放 / 悬停命中 / 拖动判定）---
export const viewState = {
    panning: false,
    startX: 0,
    startY: 0,
    translateX: 0,
    translateY: 0,
    scale: 1,
    hasMoved: false,
    clickStartX: 0,
    clickStartY: 0,
    hoverIndex: -1
};

// 视口尺寸（CSS px）与设备像素比
export const viewport = { w: 0, h: 0, dpr: 1 };

// 双指缩放状态（触摸屏）
export let pinchState = null;
export function setPinchState(value) {
    pinchState = value;
}

// --- 与服务器交互的待确认队列 ---
export const pendingRequests = new Set(); // 已发出、等待服务器确认的方块
export const pendingTimers = new Map();   // 超时保护的定时器

// --- 动画与悬停（按方块下标索引）---
export const animations = new Map();  // index -> { from, to, start, end, angle0 }
export const hoverStates = new Map(); // index -> { value, target, last } 悬停缩放缓动状态

// --- 服务端能力（收到 init-game 后确定）---
export const serverCaps = {
    color: false, // 认识预设颜色协议
    rgb: false    // 认识自定义 24bit 颜色
};

// --- 服务端信息（收到 init-game 后确定）---
export const serverInfo = {
    version: '' // 服务端 package.json 里的版本号，设置弹窗左下角显示；老服务端没这个字段就为空
};

// --- 取色器（吸管）---
let pickMode = false;          // 是否处于取色模式
let pickJustHandled = false;   // 这一次点击由取色处理了，别让"点外面关面板"的逻辑再处理一遍

export function isPickMode() {
    return pickMode;
}

export function setPickMode(value) {
    pickMode = value;
}

export function consumePickJustHandled() {
    const handled = pickJustHandled;
    pickJustHandled = false;
    return handled;
}

export function markPickJustHandled() {
    pickJustHandled = true;
}

// 触屏上画笔圆环是模态的：点圆环外面只收起圆环，这次点击不该顺手涂色。
// （桌面端不用它 —— 那里压根不用点外面来收圆环）
let ringJustClosed = false;

export function consumeRingJustClosed() {
    const closed = ringJustClosed;
    ringJustClosed = false;
    return closed;
}

export function markRingJustClosed() {
    ringJustClosed = true;
}

// --- 开发者模式 ---
// 开关由 devtools.mjs 维护（登录成功后打开），交互与渲染只读这里的状态
let devMode = false;
let devSelection = null; // { x0, y0, x1, y1 } 棋盘坐标下的矩形选区（含端点）

export function isDevMode() {
    return devMode;
}

export function setDevMode(value) {
    devMode = Boolean(value);
    if (!devMode) devSelection = null;
}

export function getDevSelection() {
    return devSelection;
}

export function setDevSelection(rect) {
    devSelection = rect;
}

// interactions.mjs 把画布上的按下 / 移动 / 松手 / 右键转发到 devtools，
// 走事件而不是互相 import，避免 interactions ←→ devtools 形成循环依赖
export const devEvents = new EventTarget();

export function emitDevEvent(type, detail) {
    devEvents.dispatchEvent(new CustomEvent(type, { detail }));
}

// --- 小工具 ---
export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function getPoint(e) {
    if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

// 视口中心
export function getViewportCenter() {
    return { x: viewport.w / 2, y: viewport.h / 2 };
}

// 桌面端才启用悬停高亮
export const hoverSupported = window.matchMedia('(hover: hover)').matches;

// 触屏设备：画笔圆环靠长按呼出（没有右键），提示弹窗也换一份文案
export const touchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// --- 渲染调度 ---
// 各模块把"每帧要做什么"注册进来：
//   paint(now, cam)          在相机之上再画一层（悬停高亮、风车动画）
//   needsMoreFrames()        还有动画 / 悬停缓动没走完吗
//   markHoverDirty()         视图变了，原来的悬停位置失效
const renderHooks = {
    render: () => {},
    paint: [],
    needsMoreFrames: [],
    markHoverDirty: []
};

export function setRenderHooks(hooks) {
    if (hooks.render) renderHooks.render = hooks.render;
    if (hooks.paint) renderHooks.paint.push(hooks.paint);
    if (hooks.needsMoreFrames) renderHooks.needsMoreFrames.push(hooks.needsMoreFrames);
    if (hooks.markHoverDirty) renderHooks.markHoverDirty.push(hooks.markHoverDirty);
}

// 依次画所有注册的附加层
export function paintOverlays(now, cam) {
    for (const paint of renderHooks.paint) paint(now, cam);
}

function requiresMoreFrames() {
    if (animations.size > 0 || pendingRequests.size > 0) return true;
    for (const needs of renderHooks.needsMoreFrames) {
        if (needs()) return true;
    }
    return false;
}

export function markHoverDirty() {
    for (const mark of renderHooks.markHoverDirty) mark();
}

let rafId = null;

// 棋盘（格子颜色 + 风车动画）的版本号：渲染层用它判断离屏棋盘缓存还能不能用
let boardRevision = 0;

export function markBoardDirty() {
    boardRevision += 1;
}

export function getBoardRevision() {
    return boardRevision;
}

function scheduleFrame() {
    if (rafId === null) {
        rafId = requestAnimationFrame(frame);
    }
}

// 画面变了：保守地让棋盘缓存失效，再排一帧
export function requestRender() {
    markBoardDirty();
    scheduleFrame();
}

// 只有覆盖层（悬停高亮）变了：棋盘像素没动，直接复用缓存的棋盘位图
export function requestOverlayRender() {
    scheduleFrame();
}

function frame(now) {
    rafId = null;

    // 先清掉已经播放完的动画：这样下一帧 painter 会把方块按最终颜色补画完整，
    // 不会留下"被跳过又没人画"的空洞
    cleanupAnimations(now);

    renderHooks.render(now);

    // 有动画、等待服务器回包或有悬停高亮时继续保持刷新。
    // 这里用不自增版本号的 scheduleFrame：自转的帧不该让棋盘缓存失效
    if (requiresMoreFrames()) {
        scheduleFrame();
    }
}

function cleanupAnimations(now) {
    if (animations.size === 0) return;
    for (const [index, anim] of animations) {
        // 还在等服务器的方块：风车一直转，不能提前结束
        if (pendingRequests.has(index)) continue;
        if (now >= anim.end) {
            animations.delete(index);
            // 动画集合决定棋盘要跳过哪些格子，删掉一个就得重画棋盘层
            markBoardDirty();
        }
    }
}

// 启动一次切换动画（风车）
// from/to 动画前后的颜色值
// start   动画开始时间
// end     计划结束时间；如果此时还在等服务器，风车会继续转，不会被提前结束
export function startSwitch(index, from, to, start, end) {
    const prev = animations.get(index);
    // 接着上一次的角度继续转，避免连续点击时风车"跳一下"
    const angle0 = prev
        ? (SWITCH_SPIN_RATE * (start - prev.start) * Math.PI * 2) % (Math.PI * 2)
        : 0;

    animations.set(index, { from, to, start, end, angle0 });
    requestRender();
}

// 服务器超时/回包后清除等待状态
export function clearPending(index) {
    const timer = pendingTimers.get(index);
    if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(index);
    }
    pendingRequests.delete(index);
}
