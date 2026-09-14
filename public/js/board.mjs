// 棋盘数据：状态解码、命中测试、悬停高亮（含取色模式的特殊表现）。

import {
    CELL_BYTES,
    HOVER_SCALE,
    HOVER_TAU,
    HOVER_TINT,
    HOVER_WAVE_AMPLITUDE,
    HOVER_WAVE_PERIOD,
    PICK_HOVER_SCALE,
    PRESET_MAX,
    RGB_MASK,
    SWITCH_DURATION
} from './config.mjs';
import { customValue, valueIsDark, valueToColor } from './color.mjs';
import {
    animations,
    board,
    ctx,
    hoverStates,
    isPickMode,
    pendingRequests,
    pendingTimers,
    requestOverlayRender,
    requestRender,
    setRenderHooks,
    startSwitch,
    viewport,
    viewState
} from './shared.mjs';

// gridState[i] 是单元格颜色值：0 = 黑，1..N = 预设颜色，>= 16 = 24bit 自定义颜色
let gridState = new Uint8Array(0);

export function getGridState() {
    return gridState;
}

export function isBoardReady() {
    return board.cols > 0;
}

// 批量改色（开发者工具）：两种形状，都只带"变了的部分"
//   · 矩形：{ start, runs }，runs 是 [跳过多少格, 连续多少格, 颜色值]
//   · 散落格子（闭合区域）：{ indices }，整片区域用同一个颜色
// 没被提到的格子保持原样；颜色确实不同的格子会播一遍风车动画
export function applyRegionPayload({ start, runs, indices, value, rgb, isBlack }) {
    const plain = typeof rgb === 'number' ? rgb : (typeof value === 'number' ? value : (isBlack ? 0 : 1));
    const now = performance.now();
    let touched = 0;

    const setCell = (index, cellValue) => {
        if (index < 0 || index >= gridState.length || gridState[index] === cellValue) return;

        startSwitch(index, gridState[index], cellValue, now, now + SWITCH_DURATION);
        gridState[index] = cellValue;
        touched++;
    };

    if (Array.isArray(indices)) {
        for (const raw of indices) setCell(Number(raw), plain);

        requestRender();
        return touched;
    }

    if (typeof runs !== 'string' || runs.length === 0) return 0;

    // runs 是 base64 文本，先转成字节数组再读 varint：
    // readVarint 是按字节下标取值的（二进制状态也共用它），传字符串会把字符当数字算成 0
    const bytes = toBytes(runs);
    if (!bytes) return 0;

    const cursor = { pos: 0 };
    let index = Number(start) || 0;

    while (cursor.pos < bytes.length) {
        index += readVarint(bytes, cursor);

        const run = readVarint(bytes, cursor);
        const cellValue = readVarint(bytes, cursor);

        if (run <= 0 || index >= gridState.length) break;

        const end = Math.min(gridState.length, index + run);
        for (let i = index; i < end; i++) setCell(i, cellValue);

        index = end;
    }

    requestRender();
    return touched;
}

// 没有 runs 时的兜底（旧服务端 / 兼容路径）：整片区域套用同一个取值
export function applyPlainRegion({ start, width, height, value, rgb, isBlack }) {
    const plain = typeof rgb === 'number' ? rgb : (typeof value === 'number' ? value : (isBlack ? 0 : 1));

    let touched = 0;
    for (let row = 0; row < height; row++) {
        const rowStart = Number(start) + row * board.cols;

        for (let col = 0; col < width; col++) {
            const index = rowStart + col;
            if (index < 0 || index >= gridState.length || gridState[index] === plain) continue;

            gridState[index] = plain;
            touched++;
        }
    }

    requestRender();
    return touched;
}

// --- 初始化棋盘 ---
// resize / resetView 由 camera.mjs 提供，通过 initBoard 的第二个参数注入，
// 避免 board 反过来 import camera
// options.keepState：棋盘状态已经在本机了（走增量同步 / 分块下发中途重连），
// 不要用 payload 里的状态把它冲掉，只更新几何与视图
export function initBoard(config, payload, hooks, options) {
    const { resizeCanvas, resetView } = hooks;
    const keepState = Boolean(options && options.keepState);

    board.cols = config.cols;
    board.rows = config.rows;
    board.cellSize = config.cellSize;
    board.width = board.cols * board.cellSize + (board.cols - 1) * board.gap + board.padding * 2;
    board.height = board.rows * board.cellSize + (board.rows - 1) * board.gap + board.padding * 2;

    if (!keepState) {
        gridState = decodeBoardState(payload, board.cols * board.rows);
    }

    // 长度对不上（棋盘尺寸变了、缓存残缺）时重建一份全黑，别让旧数组越界
    if (gridState.length !== board.cols * board.rows) {
        gridState = new Uint32Array(board.cols * board.rows);
    }

    for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
    }
    pendingTimers.clear();
    pendingRequests.clear();
    animations.clear();
    hoverStates.clear();

    resizeCanvas();
    resetView();
}

/**
 * 服务端导入了一份备份之后调用：棋盘（连同尺寸）整个换了。
 * 直接扔掉手里的格子数据、按新配置重算几何，等随后的全量下发重新填满。
 * 绘制相关的缓存由 requestRender() 的 boardRevision 作废，这里不用管。
 */
export function resetBoardGeometry(config) {
    if (config && Number.isFinite(Number(config.cols)) && Number.isFinite(Number(config.rows))) {
        board.cols = Number(config.cols);
        board.rows = Number(config.rows);
        board.cellSize = Number(config.cellSize) || board.cellSize;
        board.width = board.cols * board.cellSize + (board.cols - 1) * board.gap + board.padding * 2;
        board.height = board.rows * board.cellSize + (board.rows - 1) * board.gap + board.padding * 2;
    }

    gridState = new Uint32Array(Math.max(0, board.cols * board.rows));

    for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
    }
    pendingTimers.clear();
    pendingRequests.clear();
    animations.clear();
    hoverStates.clear();
}

/**
 * 分块下发：把一块（若干行）的状态写进棋盘。
 * encoding 带 -bin 后缀只是说明 data 是二进制，解码方式与不带后缀的一致。
 * 返回写进去的格子数（0 表示这块没用上）
 */
export function applyStateChunk(bytes, encoding, rowStart, rows) {
    if (!bytes || !board.cols || gridState.length === 0) return 0;

    const start = rowStart * board.cols;
    const count = Math.min(rows * board.cols, gridState.length - start);
    if (count <= 0) return 0;

    if (typeof encoding === 'string' && encoding.indexOf('rle') === 0) {
        decodeRleInto(bytes, gridState, start, count);
    } else {
        decodeDenseInto(bytes, gridState, start, count, CELL_BYTES);
    }

    return count;
}

/**
 * 用本地缓存里的稠密字节（3 字节/格）恢复棋盘状态。
 * 长度对不上返回 false（调用方应该向服务端要一次全量）
 */
export function restoreGridState(bytes, total) {
    if (!bytes || bytes.length < total * CELL_BYTES) return false;

    gridState = new Uint32Array(total);
    decodeDenseInto(bytes, gridState, 0, total, CELL_BYTES);

    return true;
}

// 服务端下发的棋盘状态可能是几种形态：
//   1. stateRgb + stateEncoding（当前）：24bit
//        'rle' / 'dense'       —— base64 文本（老协议 / 老服务端）
//        'rle-bin' / 'dense-bin' —— 二进制（socket.io 的二进制附件，浏览器里是 ArrayBuffer）
//   2. state32（上一版服务端）：24bit，4 字节/格
//   3. state：4bit，旧服务端 / 没刷新过的旧页面
function decodeBoardState(payload, total) {
    if (payload.stateRgb !== undefined && payload.stateRgb !== null) {
        const bytes = toBytes(payload.stateRgb);
        if (!bytes) return new Uint32Array(total);

        const encoding = typeof payload.stateEncoding === 'string' ? payload.stateEncoding : '';
        return encoding.indexOf('rle') === 0
            ? decodeRleState(bytes, total)
            : decodeStateRgb(bytes, total, 3);
    }

    if (payload.state32 !== undefined && payload.state32 !== null) {
        const bytes = toBytes(payload.state32);
        if (!bytes) return new Uint32Array(total);

        // 上一版服务端：只有明确写了 stateFormat: 'rgb24' 才是 3 字节/格，
        // 更早的那版不发 stateFormat，是 4 字节/格
        return decodeStateRgb(bytes, total, payload.stateFormat === 'rgb24' ? 3 : 4);
    }

    return decodeState(payload.state, total);
}

// 把服务端发来的状态统一成字节数组。
// socket.io 的二进制附件在浏览器里是 ArrayBuffer（engine.io 把 WebSocket 的 binaryType
// 设成了 arraybuffer），另外兼容 Uint8Array、Node 的 Buffer（ArrayBufferView）、
// 以及 JSON 化的 { type: 'Buffer', data: [...] } 和 base64 字符串。
// 增量同步的 connection.mjs 也会用它（分块数据、缓存里的字节）
export function toBytes(data) {
    if (!data) return null;

    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    if (typeof data === 'string') {
        try {
            const binary = atob(data);
            const out = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
            return out;
        } catch {
            return null;
        }
    }

    if (data.type === 'Buffer' && Array.isArray(data.data)) return Uint8Array.from(data.data);

    return null;
}

// 解码旧协议的服务端状态（只可能是老服务端发的 base64）。
//   4bit/格 的 Base64（每字节两格，低 4 位在前）
//   布尔数组（true = 黑）
function decodeState(state, total) {
    const out = new Uint32Array(total);

    if (typeof state === 'string') {
        const bytes = toBytes(state);
        if (!bytes) return out;

        for (let i = 0; i < total; i++) {
            const byte = bytes[i >> 1];
            if (byte === undefined) break;

            out[i] = (i & 1) ? ((byte >> 4) & 0x0f) : (byte & 0x0f);
        }
        return out;
    }

    if (Array.isArray(state)) {
        for (let i = 0; i < total; i++) {
            out[i] = state[i] === false ? 1 : 0;
        }
    }

    return out;
}

// 解码 24bit/格 的状态（裸字节，不再经过 base64）。
//   bytesPerCell = 3：当前格式，每格 3 字节小端
//   bytesPerCell = 4：上一版格式，每格 4 字节，高 8 位是"自定义颜色"标记
function decodeStateRgb(bytes, total, bytesPerCell) {
    const out = new Uint32Array(total);
    decodeDenseInto(bytes, out, 0, total, bytesPerCell);

    return out;
}

// 把稠密状态写进 out[offset .. offset+count)
function decodeDenseInto(bytes, out, offset, count, bytesPerCell) {
    const step = bytesPerCell === 4 ? 4 : 3;

    for (let i = 0; i < count; i++) {
        const source = i * step;
        const target = offset + i;
        if (source + step > bytes.length || target >= out.length) break;

        if (step === 4) {
            // 上一版：高 8 位是标记位，低 24 位才是颜色
            const raw = (
                bytes[source] |
                (bytes[source + 1] << 8) |
                (bytes[source + 2] << 16) |
                (bytes[source + 3] << 24)
            ) >>> 0;

            out[target] = (raw & 0x01000000) ? customValue(raw & RGB_MASK) : (raw & PRESET_MAX);
            continue;
        }

        out[target] = (
            bytes[source] |
            (bytes[source + 1] << 8) |
            (bytes[source + 2] << 16)
        ) >>> 0;
    }
}

// 读取 varint（每字节 7 位，最高位是"还有后续字节"标志）
function readVarint(bytes, cursor) {
    let value = 0;
    let scale = 1;

    while (cursor.pos < bytes.length) {
        const byte = bytes[cursor.pos++];
        value += (byte & 0x7f) * scale;

        if ((byte & 0x80) === 0) break;
        scale *= 128;
    }

    return value;
}

// 解码 RLE 紧凑状态（与 src/state.ts 的 encodeRle 对应）：
// 每个色块三个 varint = [跳过多少个黑格, 连续同色多少格, 颜色值]，
// 没被覆盖的格子保持黑色
function decodeRleState(bytes, total) {
    const out = new Uint32Array(total);
    decodeRleInto(bytes, out, 0, total);

    return out;
}

// 把 RLE 写进 out[offset .. offset+count)；跳过计数从这段的起点算起
function decodeRleInto(bytes, out, offset, count) {
    const cursor = { pos: 0 };
    let index = offset;

    while (cursor.pos < bytes.length) {
        index += readVarint(bytes, cursor);

        const run = readVarint(bytes, cursor);
        const value = readVarint(bytes, cursor);

        if (run <= 0 || index >= offset + count) break;

        const end = Math.min(offset + count, index + run);
        for (let i = index; i < end; i++) out[i] = value;

        index = end;
    }
}

// --- 命中测试：屏幕坐标 → 方块下标（CSS px）---
export function hitTest(clientX, clientY) {
    if (!board.cols) return -1;

    const localX = (clientX - viewport.w / 2 - viewState.translateX) / viewState.scale + board.width / 2;
    const localY = (clientY - viewport.h / 2 - viewState.translateY) / viewState.scale + board.height / 2;

    const pitch = board.cellSize + board.gap;
    const fx = localX - board.padding;
    const fy = localY - board.padding;
    if (fx < 0 || fy < 0) return -1;

    const c = Math.floor(fx / pitch);
    const r = Math.floor(fy / pitch);
    if (c < 0 || c >= board.cols || r < 0 || r >= board.rows) return -1;

    // 落在缝隙上：只有当缝隙在屏幕上够宽（≥1 像素）时才算未命中
    const gapOnScreen = board.gap * viewState.scale;
    if (gapOnScreen >= 1) {
        if (fx - c * pitch > board.cellSize || fy - r * pitch > board.cellSize) return -1;
    }

    return r * board.cols + c;
}

// --- 悬停高亮 ---
// 改变某个格子的悬停目标（1 = 放大，0 = 收起）
function setHoverTarget(state, target) {
    if (state.target === target) return;
    state.target = target;
    // 从改变的那一刻重新计时，避免长时间静止后第一帧跳变
    state.last = performance.now();
}

// 指向的格子变化时更新悬停（index < 0 表示没指在方块上）
export function updateHover(index) {
    if (index === viewState.hoverIndex) return;
    viewState.hoverIndex = index;

    // 新格子放大，其余格子收起
    for (const [i, state] of hoverStates) {
        if (i !== index) setHoverTarget(state, 0);
    }

    if (index >= 0) {
        let state = hoverStates.get(index);
        if (!state) {
            state = { value: 0, target: 0, last: performance.now() };
            hoverStates.set(index, state);
        }
        setHoverTarget(state, 1);
    }

    // 悬停只影响覆盖层（高亮 / 放大），棋盘本身的像素没动：
    // 渲染层可以复用缓存的棋盘位图，不必整盘重画
    requestOverlayRender();
}

// 悬停缓动还要不要继续：有缓动没走完，或者还有方块处于悬停（波浪一直在滚）
function hoverNeedsFrame() {
    for (const state of hoverStates.values()) {
        if (state.value !== state.target || state.value > 0) return true;
    }
    return false;
}

// 悬停高亮的绘制：缓动放大 + 阴影 + 滚动的波浪 + 轻微变色
// value 在 0（普通）与 1（完全悬停）之间按指数缓动逼近 target，
// 这样移入是渐大、移出是渐小，中途换格子也会自然过渡
function paintHover(now, cam) {
    if (hoverStates.size === 0) return;

    // 分两趟：先画正在收起的，再画正在放大的，保证放大中的方块在最上层
    for (let target = 0; target <= 1; target++) {
        for (const [index, state] of hoverStates) {
            if (state.target !== target) continue;
            // 正在播放风车动画的方块不画悬停高亮，避免盖住动画
            if (animations.has(index)) continue;

            const dt = Math.min(48, Math.max(0, now - state.last));
            state.last = now;

            // 指数缓动：与帧率无关，时间常数 HOVER_TAU
            state.value += (state.target - state.value) * (1 - Math.exp(-dt / HOVER_TAU));
            if (Math.abs(state.target - state.value) < 0.002) {
                state.value = state.target;
            }

            // 已经完全收起且不再需要显示
            if (state.target === 0 && state.value === 0) {
                hoverStates.delete(index);
                continue;
            }

            const box = cam.cellBox(index);
            const w = box.w - cam.lineW;
            const h = box.h - cam.lineW;
            if (w <= 0 || h <= 0) continue;

            drawHoverCell(now, index, box.x, box.y, w, h, state.value);
        }
    }
}

// 单个悬停方块：放大 + 阴影 + 轻微变色 + 一条沿左上→右下滚动的波浪
// 取色模式下波浪关掉，只留下放大与描边感的变色，方便对准要取的方块
function drawHoverCell(now, index, x, y, w, h, value) {
    const cellValue = gridState[index];
    // 深色块提亮、浅色块压暗：自定义颜色按亮度判断
    const isDark = valueIsDark(cellValue);
    const pickMode = isPickMode();

    // 取色时方块放得更大一点
    const scaleRatio = 1 + (pickMode ? PICK_HOVER_SCALE : HOVER_SCALE) * value;
    const gw = Math.max(1, Math.round(w * scaleRatio));
    const gh = Math.max(1, Math.round(h * scaleRatio));
    const gx = x + Math.round((w - gw) / 2);
    const gy = y + Math.round((h - gh) / 2);

    ctx.save();
    ctx.globalAlpha = value;

    // 1) 底色 + 阴影：让方块浮起来
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = Math.max(1, Math.round(8 * viewport.dpr * value));
    ctx.fillStyle = valueToColor(cellValue);
    ctx.fillRect(gx, gy, gw, gh);

    // 2) 轻微变色：深色块提亮一点、浅色块压暗一点，和周围一模一样的像素区分开
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = isDark
        ? `rgba(255, 255, 255, ${HOVER_TINT})`
        : `rgba(0, 0, 0, ${HOVER_TINT})`;
    ctx.fillRect(gx, gy, gw, gh);

    // 3) 波浪：沿左上→右下方向的余弦波，相位随时间推进，波峰不断向右下滚动
    //    深色块用白色波峰、浅色块用黑色波谷，保证两种底色下都看得见
    //    取色模式下不画波浪（要求"选中的方块没有波浪效果"）
    if (!pickMode) {
        const phase = (now % HOVER_WAVE_PERIOD) / HOVER_WAVE_PERIOD;
        const gradient = ctx.createLinearGradient(gx, gy, gx + gw, gy + gh);
        const steps = 12;

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const wave = Math.sin(2 * Math.PI * (t - phase));
            const amplitude = Math.max(0, isDark ? wave : -wave) * HOVER_WAVE_AMPLITUDE;
            const rgb = isDark ? '255, 255, 255' : '0, 0, 0';
            gradient.addColorStop(t, `rgba(${rgb}, ${amplitude.toFixed(3)})`);
        }

        ctx.fillStyle = gradient;
        ctx.fillRect(gx, gy, gw, gh);
    }

    ctx.restore();
}

// 把悬停绘制挂进渲染循环
setRenderHooks({
    paint: paintHover,
    needsMoreFrames: hoverNeedsFrame,
    markHoverDirty: () => {
        viewState.hoverIndex = -1;
        for (const state of hoverStates.values()) {
            setHoverTarget(state, 0);
        }
    }
});
