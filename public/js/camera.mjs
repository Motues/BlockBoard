// 相机：视口尺寸、缩放与平移的边界、坐标换算，以及"棋盘内部坐标 → 物理像素"的取整。

import { MIN_LINE_PITCH, ZOOM_CONFIG } from './config.mjs';
import {
    board,
    canvas,
    clamp,
    markHoverDirty,
    requestRender,
    viewport,
    viewState
} from './shared.mjs';

// --- 画布尺寸 / 设备像素比 ---
export function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(window.innerWidth * dpr));
    const h = Math.max(1, Math.round(window.innerHeight * dpr));

    viewport.w = window.innerWidth;
    viewport.h = window.innerHeight;
    viewport.dpr = dpr;

    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
}

// 设备像素比变化（例如窗口被拖到另一块屏幕）时重建画布
export function watchDevicePixelRatio() {
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
        media.removeEventListener('change', onChange);
        resizeCanvas();
        clampView();
        markHoverDirty();
        requestRender();
        watchDevicePixelRatio();
    };
    media.addEventListener('change', onChange);
}

// 最小缩放：让棋盘的长边或宽边刚好与屏幕相等（此时整块棋盘完整可见，不能更小）
export function getMinScale() {
    if (!board.width || !board.height) return 1;

    const fitWidth = viewport.w / board.width;
    const fitHeight = viewport.h / board.height;

    // 棋盘本来就比屏幕小时不放大，仍然以 1 倍作为最小值
    return Math.min(1, fitWidth, fitHeight);
}

// 最大缩放：避免无限放大导致方块过大 / 渲染压力
export function getMaxScale() {
    return Math.max(ZOOM_CONFIG.MAX_SCALE, getMinScale());
}

// 依据当前缩放计算平移边界：棋盘居中，超出的部分平均分配到两侧
export function calculateBoundaries(scale = viewState.scale) {
    const limitX = Math.max(0, (board.width * scale - viewport.w) / 2);
    const limitY = Math.max(0, (board.height * scale - viewport.h) / 2);

    return {
        minX: -limitX,
        maxX: limitX,
        minY: -limitY,
        maxY: limitY
    };
}

// 把缩放与平移同时限制在合法范围内
export function clampView() {
    viewState.scale = clamp(viewState.scale, getMinScale(), getMaxScale());

    const bounds = calculateBoundaries();
    viewState.translateX = clamp(viewState.translateX, bounds.minX, bounds.maxX);
    viewState.translateY = clamp(viewState.translateY, bounds.minY, bounds.maxY);
}

// 以屏幕上的某个点为锚点缩放（滚轮缩放时，光标下的内容不会跑掉）
export function zoomAtPoint(targetScale, anchorX, anchorY) {
    const nextScale = clamp(targetScale, getMinScale(), getMaxScale());
    if (nextScale === viewState.scale) return;

    const centerX = viewport.w / 2;
    const centerY = viewport.h / 2;
    // 锚点当前对应的棋盘坐标
    const localX = (anchorX - centerX - viewState.translateX) / viewState.scale;
    const localY = (anchorY - centerY - viewState.translateY) / viewState.scale;

    viewState.scale = nextScale;
    // 缩放后让同一个棋盘坐标重新落在锚点上
    viewState.translateX = anchorX - centerX - localX * nextScale;
    viewState.translateY = anchorY - centerY - localY * nextScale;

    clampView();
    markHoverDirty();
    requestRender();
}

// 恢复默认视图：100% 缩放并居中
export function resetView() {
    viewState.scale = clamp(1, getMinScale(), getMaxScale());
    viewState.translateX = 0;
    viewState.translateY = 0;
    markHoverDirty();
    clampView();
    requestRender();
}

// --- 坐标换算 ---

// 棋盘内部坐标 → 屏幕物理像素的比例
export function screenScale() {
    return viewState.scale * viewport.dpr;
}

// 棋盘内部坐标 (0, 0) 落在哪个物理像素上
export function screenOrigin() {
    const scale = screenScale();
    return {
        x: canvas.width / 2 + viewState.translateX * viewport.dpr - (board.width / 2) * scale,
        y: canvas.height / 2 + viewState.translateY * viewport.dpr - (board.height / 2) * scale
    };
}

// 这一帧的相机参数：比例、原点、线宽，以及把棋盘坐标取整到物理像素的换算
export function makeCamera() {
    const scale = screenScale();
    const origin = screenOrigin();
    const lineW = lineWidthFor(scale, (board.cellSize + board.gap) * scale);

    return {
        scale,
        ox: origin.x,
        oy: origin.y,
        lineW,
        px: (v) => Math.round(origin.x + v * scale),
        py: (v) => Math.round(origin.y + v * scale),
        // 第 index 个方块（含右侧与下方的缝隙）在物理像素中的矩形
        cellBox: (index) => cellBox(index, scale, origin)
    };
}

// 网格线宽：与格子等比（保持原来的 1:26 观感），最小 1 个物理像素
export function lineWidthFor(scale, pitchPx) {
    if (pitchPx < MIN_LINE_PITCH) return 0;
    return Math.max(1, Math.round(scale));
}

// 第 index 个方块（含右侧与下方的缝隙）在物理像素中的矩形
function cellBox(index, scale, origin) {
    const pitch = board.cellSize + board.gap;
    const c = index % board.cols;
    const r = Math.floor(index / board.cols);

    const x = Math.round(origin.x + (board.padding + c * pitch) * scale);
    const y = Math.round(origin.y + (board.padding + r * pitch) * scale);

    const right = (c + 1 >= board.cols)
        ? Math.round(origin.x + (board.padding + (board.cols - 1) * pitch + board.cellSize) * scale)
        : Math.round(origin.x + (board.padding + (c + 1) * pitch) * scale);
    const bottom = (r + 1 >= board.rows)
        ? Math.round(origin.y + (board.padding + (board.rows - 1) * pitch + board.cellSize) * scale)
        : Math.round(origin.y + (board.padding + (r + 1) * pitch) * scale);

    return { x, y, w: right - x, h: bottom - y };
}
