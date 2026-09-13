// 与服务端的连接：处理 init-game / state-chunk / state-done / sync-delta / sync-done /
// update-square(s) / update-region / paint-rejected / online-users，
// 并绑定与画布无关的全局 UI 事件（设置面板、提示弹窗、Esc、点空白处关面板）。
//
// 首屏状态有三条路（服务端在 init-game 的 stateMode 里说明走哪条）：
//   inline —— 一条消息把整盘状态发下来（小棋盘，最常见）
//   chunks —— 分块下发（state-chunk ... state-done），期间收到的实时广播先缓冲，收齐后回放
//   client —— 本机缓存（或分块中途）已经有状态了，服务端只补发差量（sync-delta）

import { SWITCH_DURATION, SWITCH_SETTLE } from './config.mjs';
import { setBrushIndex } from './brush.mjs';
import { customValue } from './color.mjs';
import { applyRegionPayload, applyStateChunk, getGridState, initBoard, restoreGridState, toBytes } from './board.mjs';
import { resetView, resizeCanvas } from './camera.mjs';
import { bindCanvasEvents } from './interactions.mjs';
import { closeColorPicker, isColorPickerOpen, stopPicking } from './picker.mjs';
import { closeBrushRing, showHintPopup, toggleOptionsPanel } from './ring.mjs';
import { t } from './i18n.mjs';
import { markCacheDirty } from './state-cache.mjs';
import { toast } from './toast.mjs';
import {
    animations,
    board,
    clearPending,
    consumePickJustHandled,
    getCachedState,
    isPickMode,
    markRingJustClosed,
    menuButton,
    requestRender,
    serverCaps,
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
export function initConnection() {
    socket.on('init-game', (data) => {
        const { config, maxColorIndex, rgbSupport, stateRgb, state32, stateMode, rev, epoch } = data;
        serverCaps.color = typeof maxColorIndex === 'number';
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
                socket.emit('sync-request', {});
                return;
            }

            initBoard(config, data, { resizeCanvas, resetView }, { keepState: true });
            syncInfo.claimable = true;
            return;
        }

        // --- 分块下发：先摆好空棋盘，等 state-chunk 逐块填 ---
        if (mode === 'chunks') {
            assembling = true;
            // 收齐之前不能拿旧版本号去跟服务端对账（中间断线会少收几块）
            syncInfo.claimable = false;
            initBoard(config, data, { resizeCanvas, resetView });
            return;
        }

        // --- 一条消息装下整盘 ---
        initBoard(config, data, { resizeCanvas, resetView });
        setSyncRev(rev);
        syncInfo.ready = true;
        syncInfo.claimable = true;
        markCacheDirty();
    });

    // 分块下发的一块：按行偏移写进棋盘。每块独立编码，收到就画（首屏能渐进出现）
    socket.on('state-chunk', (chunk) => {
        if (!chunk) return;

        const bytes = toBytes(chunk.data);
        if (!bytes) return;

        if (applyStateChunk(bytes, chunk.encoding, Number(chunk.rowStart) || 0, Number(chunk.rows) || 0) > 0) {
            requestRender();
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
    });

    socket.on('disconnect', () => {
        setOnlineText('—');
        showConnectionNotice('conn.offline');
    });

    socket.on('connect_error', () => {
        setOnlineText('—');
        showConnectionNotice('conn.failed');
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

    // Esc：先退出取色模式，再依次收起调色盘与圆环
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;

        if (isPickMode()) {
            stopPicking();
            return;
        }

        closeColorPicker();
        closeBrushRing();
    });

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
