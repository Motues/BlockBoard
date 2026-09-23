// 相机：视口尺寸、缩放与平移的边界、坐标换算，以及"棋盘内部坐标 → 物理像素"的取整。
// 缩放不是跳变的：滚轮 / 双指捏合只改"目标值"，由渲染循环每帧按指数缓动逼近，
// 所以这个模块既算相机，也负责把缩放动画挂进渲染循环（见文件末尾）。

import { MIN_LINE_PITCH, ZOOM_CONFIG } from './config.mjs';
import {
    board,
    canvas,
    clamp,
    markHoverDirty,
    requestRender,
    setRenderHooks,
    viewport,
    viewState
} from './shared.mjs';

// 还没走完的缩放动画：
//   targetScale        要收敛到的缩放倍数
//   anchorX / anchorY  锚点在屏幕上的位置（CSS px，滚轮是光标、捏合是双指中点）
//   localX / localY    锚点对应的棋盘坐标，动画期间始终钉在 anchor 上
//   last               上一帧的时间戳（算 dt 用）
let zoomAnim = null;

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

// 以屏幕上的某个点为锚点缩放（滚轮缩放时，光标下的内容不会跑掉）。
// 只把目标记下来，真正的推进交给 updateZoomAnimation —— 这样滚轮连滚是叠在一起的
// 一段连续运动，而不是一格一跳。
export function zoomAtPoint(targetScale, anchorX, anchorY) {
    const nextScale = clamp(targetScale, getMinScale(), getMaxScale());
    if (nextScale === viewState.scale) return;

    const centerX = viewport.w / 2;
    const centerY = viewport.h / 2;
    // 锚点当前对应的棋盘坐标
    const localX = (anchorX - centerX - viewState.translateX) / viewState.scale;
    const localY = (anchorY - centerY - viewState.translateY) / viewState.scale;

    zoomAnim = {
        targetScale: nextScale,
        anchorX,
        anchorY,
        localX,
        localY,
        // 时间基准取"记下目标值的这一刻"：下一帧的 dt 才是真实间隔
        last: performance.now()
    };

    markHoverDirty();
    requestRender();
}

// 收掉还没走完的缩放动画。直接开始拖动 / 双指接管时必须调：
// 否则动画还会继续改 scale，把手指刚做的平移一起带歪。
export function cancelZoomAnimation() {
    zoomAnim = null;
}

// 当前缩放的目标值：动画没在跑时就是实际缩放。
// 滚轮连滚要基于它继续乘，而不是每次都从 viewState.scale 重算（见 interactions.mjs 的 onWheel）
export function getZoomTargetScale() {
    return zoomAnim ? zoomAnim.targetScale : viewState.scale;
}

// 缩放动画的推进：每帧把 scale 朝目标推进一段，并解算配套的平移。
// 用指数缓动（时间常数 ZOOM_CONFIG.SMOOTH_TAU）而不是固定时长：
//   · 与帧率无关，掉帧时也不会走过头；
//   · 中途再次滚轮只是改目标值，运动自然续上，看不出接缝。
// 平移按"锚点那块棋盘坐标钉在屏幕上不动"解算，所以整个动画期间光标底下那一点不跑。
function updateZoomAnimation(now) {
    if (!zoomAnim) return;

    const active = zoomAnim;
    const dt = clamp(now - active.last, 0, 48);
    active.last = now;

    const ratio = 1 - Math.exp(-dt / ZOOM_CONFIG.SMOOTH_TAU);
    const from = viewState.scale;
    let next = from + (active.targetScale - from) * ratio;

    // 已经贴到目标值：收敛到精确值，这一帧算完就收工（下一帧不再自转）
    if (Math.abs(active.targetScale - next) < 0.0005) {
        next = active.targetScale;
        zoomAnim = null;
    }

    viewState.scale = next;
    if (zoomAnim) {
        viewState.translateX = active.anchorX - viewport.w / 2 - active.localX * next;
        viewState.translateY = active.anchorY - viewport.h / 2 - active.localY * next;
    } else {
        // 最后一帧：按缩放比例把平移一起缩放，锚点仍然不动（增量式，不必再解一次锚点）
        const k = next / from;
        viewState.translateX = viewport.w / 2 - (viewport.w / 2 - viewState.translateX) * k;
        viewState.translateY = viewport.h / 2 - (viewport.h / 2 - viewState.translateY) * k;
    }

    clampView();
}

// 恢复默认视图：100% 缩放并居中（瞬间到位，没有平滑动画）
export function resetView() {
    cancelZoomAnimation();
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

// 把缩放动画挂进渲染循环：
//   · updateZoomAnimation 在 paint 阶段推进 —— 此时本帧的棋盘已经按"上一帧的相机"画完，
//     改 viewState 只影响下一帧（若放到 render 之前，这一帧画出来的东西会缺一块）
//   · needsMoreFrames 在动画没走完时让渲染循环继续自转（用 shared 的 scheduleFrame，
//     不自增 boardRevision —— 相机每帧都在变，棋盘缓存本来就每帧重建）
setRenderHooks({
    paint: updateZoomAnimation,
    needsMoreFrames: () => zoomAnim !== null
});
