// 运行期共享状态：socket / 画布 / 视口 / 视图状态 / 待确认队列 / 渲染调度 / 取色模式开关。
// 各功能模块都从这里取状态，避免模块之间互相 import 成环。

import { GAP_SIZE, PADDING_SIZE, SWITCH_SPIN_RATE } from './config.mjs';

// 握手里告诉服务端自己认识哪些状态格式（见 src/server.ts 的 init-game）：
//   rgb24 = 24bit 取值（>= 16 是自定义颜色）+ 3 字节/格 的稠密状态
//   rle   = RLE 紧凑状态（跳过黑格，通常只有几十字节）
// 服务端会据此只发一份状态，而不是把几种格式都塞过来
const STATE_CAPS = ['rgb24', 'rle'];

export const socket = io({ auth: { caps: STATE_CAPS } });

export const canvas = document.getElementById('board');
export const ctx = canvas.getContext('2d');

export const menuButton = document.getElementById('menu-button');
export const optionsPanel = document.getElementById('options-panel');
export const menuIcon = document.getElementById('menu-icon');
export const closeIcon = document.getElementById('close-icon');

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

// 合并同一帧内的多次重绘请求
export function requestRender() {
    if (rafId === null) {
        rafId = requestAnimationFrame(frame);
    }
}

function frame(now) {
    rafId = null;

    // 先清掉已经播放完的动画：这样下一帧 painter 会把方块按最终颜色补画完整，
    // 不会留下"被跳过又没人画"的空洞
    cleanupAnimations(now);

    renderHooks.render(now);

    // 有动画、等待服务器回包或有悬停高亮时继续保持刷新
    if (requiresMoreFrames()) {
        requestRender();
    }
}

function cleanupAnimations(now) {
    if (animations.size === 0) return;
    for (const [index, anim] of animations) {
        // 还在等服务器的方块：风车一直转，不能提前结束
        if (pendingRequests.has(index)) continue;
        if (now >= anim.end) {
            animations.delete(index);
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
