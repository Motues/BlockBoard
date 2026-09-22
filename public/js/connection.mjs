// 与服务端的连接：处理 init-game / state-chunk / state-done / sync-delta / sync-done /
// update-square(s) / update-region / paint-rejected / online-users，
// 并绑定与画布无关的全局 UI 事件（设置面板、提示弹窗、点空白处关面板）。
// 键盘快捷键（含 Esc）在 keyboard.mjs，这里不再挂 keydown。
//
// 首屏状态有三条路（服务端在 init-game 的 stateMode 里说明走哪条）：
//   inline —— 一条消息把整盘状态发下来（小棋盘，最常见）
//   chunks —— 分块下发（state-chunk ... state-done），期间收到的实时广播先缓冲，收齐后回放
//   client —— 本机缓存（或分块中途）已经有状态了，服务端只补发差量（sync-delta）

import { SWITCH_DURATION, SWITCH_SETTLE } from './config.mjs';
import { setBrushIndex } from './brush.mjs';
import { customValue } from './color.mjs';
import {
    applyRegionPayload,
    applyStateChunk,
    getGridState,
    initBoard,
    resetBoardGeometry,
    restoreGridState,
    toBytes
} from './board.mjs';
import { resetView, resizeCanvas } from './camera.mjs';
import { bindCanvasEvents } from './interactions.mjs';
import { closeColorPicker, isColorPickerOpen } from './picker.mjs';
import { closeBrushRing, showHintPopup, toggleOptionsPanel } from './ring.mjs';
import { t } from './i18n.mjs';
import { clearCachedState, markCacheDirty } from './state-cache.mjs';
import { toast } from './toast.mjs';
import {
    animations,
    board,
    clearPending,
    consumePickJustHandled,
    getCachedState,
    markRingJustClosed,
    menuButton,
    requestRender,
    serverCaps,
    serverInfo,
    setSyncRev,
    socket,
    startSwitch,
    syncInfo,
    touchDevice,
    canvas
} from './shared.mjs';

// 分块下发进行中：实时广播先排队，等 state-done 之后按顺序回放
let assembling = false;
const bufferedEvents = [];
// 已经收下的行数（首屏分块进度用）
let receivedRows = 0;

// --- 首屏加载状态上报（js/loader.mjs 订阅）---
// 状态：'connect'（等服务器）/ 'receive'（分块下发中）/ 'sync'（在补差量）/ 'failed'（连不上）；
// 另外两种形状：{ type: 'receive', done, total } 带分块进度；null 表示棋盘已就绪（遮罩该收了）。
// 这里只上报，不碰 DOM —— 画那个动画是 loader.mjs 的事，省得两个模块互相依赖。
const loadStatusListeners = [];

export function onLoadStatus(handler) {
    if (typeof handler === 'function') loadStatusListeners.push(handler);
}

function emitLoadStatus(status) {
    for (const handler of loadStatusListeners) {
        try {
            handler(status);
        } catch (error) {
            console.error('Load status handler failed:', error);
        }
    }
}

// 断线提示的节流：socket.io 会不断重试，别让每次失败都弹一次
const CONNECTION_NOTICE_INTERVAL_MS = 10000;
let connectionNoticeAt = 0;

function setOnlineText(text) {
    const el = document.getElementById('onlineCount');
    if (el) el.textContent = text;
}

function showConnectionNotice(key) {
    const now = Date.now();
    if (now - connectionNoticeAt < CONNECTION_NOTICE_INTERVAL_MS) return;

    connectionNoticeAt = now;
    toast(t(key), 'error');
}

// 新服务端会在 init-game 里带上 maxColorIndex，据此判断能否用颜色协议；
// 带上 rgbSupport / stateRgb / state32 就说明它支持自定义 24bit 颜色
//
// options.rebind：整页重建之后重新挂一遍处理器（正常启动只调用一次，不传即可）
let connectionBound = false;

export function initConnection(options) {
    if (connectionBound && !(options && options.rebind)) return;
    connectionBound = true;

    socket.on('init-game', (data) => {
        const { config, maxColorIndex, rgbSupport, stateRgb, state32, stateMode, rev, epoch, version } = data;
        serverCaps.color = typeof maxColorIndex === 'number';
        // 版本号给设置弹窗左下角用（“BlockBoard | v1.7.1”）；老服务端不发这个字段，保持空
        serverInfo.version = typeof version === 'string' ? version : '';
        // 状态可能是 stateRgb（新服务端，base64 字符串或二进制附件）或 state32（上一版服务端），
        // 都在说明它支持自定义颜色
        serverCaps.rgb = rgbSupport === true ||
            (stateRgb !== undefined && stateRgb !== null) ||
            typeof state32 === 'string';

        // 老服务端存不了自定义颜色：禁用圆心，并把自定义画笔退回预设色
        document.getElementById('brush-ring-center').classList.toggle('unsupported', !serverCaps.rgb);
        if (!serverCaps.rgb) {
            setBrushIndex(1);
        }

        if (Number.isInteger(epoch)) syncInfo.epoch = epoch;

        const mode = typeof stateMode === 'string' ? stateMode : 'inline';
        assembling = false;
        bufferedEvents.length = 0;

        // --- 增量：本机状态已经在了，服务端只补差量 ---
        if (mode === 'client') {
            // 断线重连（页面没刷新）时，内存里那份状态就是最新的，
            // 别拿可能还落后几秒的 IndexedDB 缓存把它盖回去
            const live = syncInfo.ready &&
                board.cols === config.cols &&
                board.rows === config.rows;

            let usable = live;

            if (!live) {
                const cached = getCachedState();
                usable = Boolean(cached &&
                    cached.cols === config.cols &&
                    cached.rows === config.rows &&
                    restoreGridState(toBytes(cached.bytes), config.cols * config.rows));
            }

            if (!usable) {
                // 缓存缺失 / 尺寸对不上 / 解不出来：直接要一次完整状态
                syncInfo.claimable = false;
                emitLoadStatus('sync');
                socket.emit('sync-request', {});
                return;
            }

            initBoard(config, data, { resizeCanvas, resetView }, { keepState: true });
            syncInfo.claimable = true;

            // 本机已经有完整状态了：服务端接下来只会发一点差量，遮罩没必要等它
            // （这里故意跳过一次渲染，好让上面那句 initBoard 先把首帧画出来）
            emitLoadStatus(null);
            return;
        }

        // --- 分块下发：先摆好空棋盘，等 state-chunk 逐块填 ---
        if (mode === 'chunks') {
            assembling = true;
            // 收齐之前不能拿旧版本号去跟服务端对账（中间断线会少收几块）
            syncInfo.claimable = false;
            receivedRows = 0;
            emitLoadStatus({ type: 'receive', done: 0, total: Math.max(1, Number(data.chunks) || 1) });
            initBoard(config, data, { resizeCanvas, resetView });
            return;
        }

        // --- 一条消息装下整盘 ---
        initBoard(config, data, { resizeCanvas, resetView });
        setSyncRev(rev);
        syncInfo.ready = true;
        syncInfo.claimable = true;
        markCacheDirty();
        emitLoadStatus(null);
    });

    // 分块下发的一块：按行偏移写进棋盘。每块独立编码，收到就画（首屏能渐进出现）
    socket.on('state-chunk', (chunk) => {
        if (!chunk) return;

        const bytes = toBytes(chunk.data);
        if (!bytes) return;

        const rows = Number(chunk.rows) || 0;
        if (applyStateChunk(bytes, chunk.encoding, Number(chunk.rowStart) || 0, rows) > 0) {
            requestRender();
        }

        if (assembling) {
            receivedRows += rows;
            emitLoadStatus({
                type: 'receive',
                done: receivedRows,
                total: Math.max(receivedRows, board.rows || receivedRows)
            });
        }
    });

    // 分块下发结束：先把缓冲的实时广播回放掉，再认版本号 ——
    // 顺序反了的话，中间那一刻的快照会声称"我已经到 rev X"，其实还差几条缓冲消息
    socket.on('state-done', ({ rev } = {}) => {
        assembling = false;

        const pending = bufferedEvents.splice(0, bufferedEvents.length);
        for (const item of pending) applyStateEvent(item.event, item.payload);

        setSyncRev(rev);
        syncInfo.ready = true;
        syncInfo.claimable = true;

        markCacheDirty();
        requestRender();
        emitLoadStatus(null);
    });

    // 增量同步：服务端把日志里的状态变更重放过来
    socket.on('sync-delta', ({ patches } = {}) => {
        if (!Array.isArray(patches)) return;

        for (const patch of patches) {
            if (!patch || typeof patch.event !== 'string') continue;
            applyStateEvent(patch.event, patch.payload);
        }
    });

    socket.on('sync-done', ({ rev } = {}) => {
        setSyncRev(rev);
        syncInfo.ready = true;
        syncInfo.claimable = true;
        markCacheDirty();
        requestRender();
        emitLoadStatus(null);
    });

    // 服务端导入了一份备份（可能连棋盘尺寸都换了）：手里的坐标与版本号全部作废。
    // 清掉棋盘与本地缓存，主动要一份全量 —— epoch 已经换了，服务端一定会走全量那条路
    socket.on('board-reset', (payload) => {
        assembling = false;
        bufferedEvents.length = 0;
        receivedRows = 0;
        clearPending();

        const config = (payload && payload.config) || null;
        resetBoardGeometry(config);

        syncInfo.epoch = Number.isInteger(payload && payload.epoch) ? payload.epoch : 0;
        syncInfo.rev = 0;
        syncInfo.ready = false;
        syncInfo.claimable = false;

        void clearCachedState();
        requestRender();

        // 整盘都作废了，重新拉一次：遮罩重新亮起来（loader 已经摘掉的话这句是空操作）
        emitLoadStatus('sync');

        // 稍等一拍再要：万一这条广播比导入接口的响应先到，别赶在服务端把状态换好之前去要
        setTimeout(() => socket.emit('sync-request', {}), 50);
    });

    // 收到服务器广播：方块的颜色值确定
    socket.on('update-square', (payload) => {
        if (assembling) {
            bufferedEvents.push({ event: 'update-square', payload });
            return;
        }

        applyStateEvent('update-square', payload);
    });

    // 合并广播：一个 16ms 窗口内的多条单格改动。
    // value 是 24bit 取值本身（0 = 黑，1..15 = 预设编号，>= 16 = 自定义色），
    // 认识 rgb24 的客户端都认识它，所以不用再带兼容字段
    socket.on('update-squares', (payload) => {
        if (assembling) {
            bufferedEvents.push({ event: 'update-squares', payload });
            return;
        }

        applyStateEvent('update-squares', payload);
    });

    // 服务端把这次点击挡掉了（令牌桶满了）：把乐观动画收回去，
    // 否则要等 PENDING_TIMEOUT（8 秒）才恢复
    socket.on('paint-rejected', ({ index }) => {
        clearPending(index);
        animations.delete(index);
        requestRender();
    });

    socket.on('online-users', (count) => {
        document.getElementById('onlineCount').textContent = count;
    });

    // 连接状态：服务端没起来 / 掉线时，画布是空的、人数也不显示，
    // 光看界面分不清"服务端没连上"和"页面坏了"，所以这里明确报出来
    socket.on('connect', () => {
        connectionNoticeAt = 0;
        // 重连成功：如果加载遮罩还在（首屏就没连上过），状态要从"连不上"退回"连接中"
        emitLoadStatus('connect');
    });

    socket.on('disconnect', () => {
        setOnlineText('—');
        showConnectionNotice('conn.offline');
    });

    socket.on('connect_error', () => {
        setOnlineText('—');
        showConnectionNotice('conn.failed');
        // 首屏这一下连不上时，遮罩上的文案要说清楚，不能一直转圈
        emitLoadStatus('failed');
    });

    // 开发者工具的批量改色广播：服务端只发变化的部分
    socket.on('update-region', (payload) => {
        if (assembling) {
            bufferedEvents.push({ event: 'update-region', payload });
            return;
        }

        applyStateEvent('update-region', payload);
    });
}

// 落地一条状态变更事件（实时广播与增量重放共用同一套）
function applyStateEvent(event, payload) {
    if (!payload) return;

    if (event === 'update-square') {
        applySquareUpdate(payload.index, payload.value, payload.isBlack, payload.rgb);
        setSyncRev(payload.rev);
        markCacheDirty();
        return;
    }

    if (event === 'update-squares') {
        const cells = payload.cells;
        if (Array.isArray(cells)) {
            for (const entry of cells) {
                if (!Array.isArray(entry)) continue;
                applySquareUpdate(Number(entry[0]), entry[1], undefined, undefined);
            }
        }

        setSyncRev(payload.rev);
        markCacheDirty();
        return;
    }

    if (event === 'update-region') {
        applyRegionPayload(payload);
        setSyncRev(payload.rev);
        markCacheDirty();
    }
}

// 落地一条单格改动（单格广播与合并广播共用）
function applySquareUpdate(index, value, isBlack, rgb) {
    const gridState = getGridState();
    const cellIndex = Number(index);
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= gridState.length) return;

    // rgb 是自定义 24bit 颜色；value / isBlack 用于新老服务端的兼容
    const target = typeof rgb === 'number'
        ? customValue(rgb)
        : typeof value === 'number'
            ? value
            : (isBlack ? 0 : 1);

    const now = performance.now();

    // 响应到了，解除等待（风车不再"无限转"）
    clearPending(cellIndex);

    const anim = animations.get(cellIndex);
    if (anim) {
        // 自己点击时启动的动画：补上权威颜色，并留出收尾淡出的时间。
        // 服务器慢的时候 end 早已过去，这里会顺势延长到"响应后再收尾"
        anim.to = target;
        anim.end = Math.max(anim.end, now + SWITCH_SETTLE);
    } else if (gridState[cellIndex] !== target) {
        // 别人切换的方块：自己也播一遍同样的风车动画
        startSwitch(cellIndex, gridState[cellIndex], target, now, now + SWITCH_DURATION);
    }

    gridState[cellIndex] = target;
    requestRender();
}

// --- 界面事件（与画布交互无关的部分）---
export function bindUiEvents() {
    bindCanvasEvents();

    // 页面加载后延迟 1 秒显示提示弹窗（showHintPopup 内部会在 10 秒后自动收起）
    setTimeout(showHintPopup, 1000);

    // 设置面板
    menuButton.addEventListener('click', toggleOptionsPanel);

    // 点空白处收起面板；取色模式下的那次点击已经被画布交互处理过了，不重复处理
    document.addEventListener('click', (e) => {
        if (consumePickJustHandled()) return;

        const target = e.target;
        const inRing = target.closest && target.closest('#brush-ring');
        const inPicker = target.closest && target.closest('#color-picker');

        // 调色盘：只有点在它**外面**才收起来。面板里的每一次点击（拖 SV 面板、拉动色相条、
        // 点最近颜色、点「完成」）都必须留在面板里，否则一点就没了 —— 颜色是边选边生效的，
        // 「完成」只是关闭动作
        if (isColorPickerOpen() && !inPicker && !inRing) {
            closeColorPicker();
        }

        // 点在圆环里（某个色块 / 圆心的彩虹圆）：这是选中动作，不是"点外面收圆环"。
        // 这里必须放行 —— 圆环上的控件靠自己的 click 处理器干活（选色 / 打开调色盘），
        // 早先的实现在触屏上对它们也 stopPropagation，click 到不了控件，
        // 于是"点了色块不换色""点圆心调色盘弹不出来"，还得再点一次右键（见 doc/frontend.md）。
        if (inRing) return;

        // 收起画笔圆环。圆环没开着就没什么可做的了
        if (!closeBrushRing()) return;

        // 触屏：圆环是模态的，点外面只收起它，这次点击不落到方块上；
        // 桌面端保持原样（点在棋盘上时吞掉这次点击）
        if (touchDevice) {
            markRingJustClosed();
        }

        if (touchDevice || target === canvas) {
            e.stopPropagation();
        }
    }, true);
}
