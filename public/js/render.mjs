// 画布渲染：网格 + 方块、风车切换动画、导出用的离屏绘制。
// 悬停高亮由 board.mjs 通过 shared 的渲染钩子挂进来。

import { COLORS, EXPORT_SCALE, SWITCH_SETTLE, SWITCH_SPIN_RATE } from './config.mjs';
import { valueToColor } from './color.mjs';
import { getGridState, isBoardReady } from './board.mjs';
import { lineWidthFor, makeCamera } from './camera.mjs';
import { closeOptionsPanel } from './ring.mjs';
import {
    animations,
    board,
    canvas,
    clamp,
    ctx,
    paintOverlays,
    pendingRequests,
    setRenderHooks
} from './shared.mjs';

// 绘制棋盘。
// cam.scale  棋盘内部坐标 → 目标像素的比例
// cam.ox/oy  棋盘内部坐标 (0, 0) 在目标画布上的位置（可为小数，内部会取整）
// cam.lineW  网格线宽（物理像素）
// cam.view   只绘制该像素范围内的格子（屏幕上用，导出时省略）
// cam.skip   跳过的方块集合（正在播放翻转动画的格子）
export function paintBoard(g, cam) {
    const gridState = getGridState();
    const scale = cam.scale;
    const lineW = cam.lineW;
    const pitchLocal = board.cellSize + board.gap;
    const pitchPx = pitchLocal * scale;

    // 所有坐标都取整到物理像素，保证网格线粗细完全一致、方块边缘不发虚
    const px = (v) => Math.round(cam.ox + v * scale);
    const py = (v) => Math.round(cam.oy + v * scale);
    const contentRight = px(board.padding + (board.cols - 1) * pitchLocal + board.cellSize);
    const contentBottom = py(board.padding + (board.rows - 1) * pitchLocal + board.cellSize);
    const colEdge = (c) => (c >= board.cols ? contentRight : px(board.padding + c * pitchLocal));
    const rowEdge = (r) => (r >= board.rows ? contentBottom : py(board.padding + r * pitchLocal));

    // 可见的格子范围
    let c0 = 0, c1 = board.cols, r0 = 0, r1 = board.rows;
    if (cam.view) {
        c0 = clamp(Math.floor((cam.view.x0 - cam.ox) / pitchPx) - 1, 0, board.cols);
        c1 = clamp(Math.ceil((cam.view.x1 - cam.ox) / pitchPx) + 1, 0, board.cols);
        r0 = clamp(Math.floor((cam.view.y0 - cam.oy) / pitchPx) - 1, 0, board.rows);
        r1 = clamp(Math.ceil((cam.view.y1 - cam.oy) / pitchPx) + 1, 0, board.rows);
    }

    // 只画指定的一块（导出选区用）
    if (cam.crop) {
        c0 = clamp(cam.crop.c0, 0, board.cols);
        c1 = clamp(cam.crop.c1, c0, board.cols);
        r0 = clamp(cam.crop.r0, 0, board.rows);
        r1 = clamp(cam.crop.r1, r0, board.rows);
    }

    // 每一列 / 每一行的边界（多算一格用于右/下边缘）
    const xs = [];
    for (let c = c0; c <= c1; c++) xs.push(colEdge(c));
    const ys = [];
    for (let r = r0; r <= r1; r++) ys.push(rowEdge(r));

    // 1) 先铺网格线颜色的底板，它同时充当最外圈边框
    const left = xs[0];
    const top = ys[0];
    const right = xs[xs.length - 1];
    const bottom = ys[ys.length - 1];
    g.fillStyle = COLORS.gap;
    g.fillRect(left - lineW, top - lineW, right - left + lineW * 2, bottom - top + lineW * 2);

    // 2) 再画方块。每格颜色可能不同，所以只在颜色变化时切换 fillStyle
    let lastColor = null;

    for (let r = r0; r < r1; r++) {
        const y = ys[r - r0];
        const h = ys[r - r0 + 1] - y - lineW;
        if (h <= 0) continue;

        for (let c = c0; c < c1; c++) {
            const index = r * board.cols + c;
            if (cam.skip && cam.skip.has(index)) continue;

            const x = xs[c - c0];
            const w = xs[c - c0 + 1] - x - lineW;
            if (w <= 0) continue;

            const color = valueToColor(gridState[index]);
            if (color !== lastColor) {
                g.fillStyle = color;
                lastColor = color;
            }

            g.fillRect(x, y, w, h);
        }
    }
}

// 每帧一画：背景 → 棋盘 → 各模块挂上来的叠加层（风车动画、悬停高亮）
function drawFrame(now) {
    if (!isBoardReady()) return;

    const cam = makeCamera();

    // 背景
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 棋盘
    paintBoard(ctx, {
        scale: cam.scale,
        ox: cam.ox,
        oy: cam.oy,
        lineW: cam.lineW,
        view: { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height },
        skip: animations.size > 0 ? animations : null
    });

    drawSwitches(now, cam);
    paintOverlays(now, cam);
}

// 切换动画：方块一半黑一半白，绕中心旋转，像风车
//   · 点击瞬间就开始转，不用等服务器
//   · 还没收到响应时一直转（不会提前停下）
//   · 收到响应后，用 SWITCH_SETTLE 的时间淡出成最终颜色
function drawSwitches(now, cam) {
    if (animations.size === 0) return;

    for (const [index, anim] of animations) {
        const box = cam.cellBox(index);
        const w = box.w - cam.lineW;
        const h = box.h - cam.lineW;
        if (w <= 0 || h <= 0) continue;

        const cx = box.x + w / 2;
        const cy = box.y + h / 2;
        // 旋转半径：覆盖到最远的角，保证任何角度都铺满
        const radius = Math.ceil(Math.hypot(w, h) / 2) + 1;
        const angle = anim.angle0 + SWITCH_SPIN_RATE * (now - anim.start) * Math.PI * 2;

        // 收尾淡出：等服务器期间不淡出（fade 恒为 0），响应到达后才开始
        const pending = pendingRequests.has(index);
        const fade = pending
            ? 0
            : clamp((1 - Math.max(0, anim.end - now) / SWITCH_SETTLE), 0, 1);

        // 风车两半：一边是原色、一边是新色，转完落到新色
        const fromColor = valueToColor(anim.from);
        const toColor = valueToColor(anim.to);

        ctx.save();
        ctx.beginPath();
        ctx.rect(box.x, box.y, w, h);
        ctx.clip();

        // 风车：两个半平面绕中心旋转。
        // 过中心任意角度的分割线，在正方形里都正好各占一半面积
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.fillStyle = fromColor;
        ctx.fillRect(-radius, -radius, radius * 2, radius);
        ctx.fillStyle = toColor;
        ctx.fillRect(-radius, 0, radius * 2, radius);
        ctx.restore();

        // 淡出成最终颜色
        if (fade > 0) {
            ctx.globalAlpha = fade;
            ctx.fillStyle = toColor;
            ctx.fillRect(box.x, box.y, w, h);
        }

        ctx.restore();
    }
}

// --- 图片保存功能 ---
// 导出的是离屏画布，与屏幕上的 UI 无关，所以不需要隐藏面板
export function saveAsImage() {
    try {
        if (!isBoardReady()) throw new Error('board not ready');

        const scale = EXPORT_SCALE;
        const pitchPx = (board.cellSize + board.gap) * scale;
        const lineW = lineWidthFor(scale, pitchPx);

        // 让绘制内容的左上角正好落在 (0, 0)
        const ox = lineW - board.padding * scale;
        const oy = lineW - board.padding * scale;
        const outW = Math.ceil((board.width - board.padding) * scale + lineW + ox);
        const outH = Math.ceil((board.height - board.padding) * scale + lineW + oy);

        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;

        const g = out.getContext('2d');
        g.fillStyle = COLORS.bg;
        g.fillRect(0, 0, outW, outH);
        paintBoard(g, { scale, ox, oy, lineW });

        const link = document.createElement('a');
        link.download = 'BlockBoard_Snapshot.png';
        link.href = out.toDataURL('image/png');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    } catch (error) {
        console.error('Error exporting image:', error);
    }

    // 截图后自动关闭选项面板
    closeOptionsPanel();
}

// 下载一张已经画好的离屏画布
export function saveAsPng(canvasEl, filename) {
    const link = document.createElement('a');
    link.download = filename;
    link.href = canvasEl.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 把棋盘上的一块矩形区域画成离屏画布（开发者工具导出选区用）
export function renderRegionToCanvas(colStart, rowStart, colCount, rowCount, scale) {
    const pitch = board.cellSize + board.gap;
    const lineW = lineWidthFor(scale, pitch * scale);

    // 区域左上角的棋盘内部坐标：去掉外圈的 padding，让内容贴着画布边缘
    const localX = board.padding + colStart * pitch;
    const localY = board.padding + rowStart * pitch;

    const width = Math.ceil(((colCount - 1) * pitch + board.cellSize) * scale + lineW * 2);
    const height = Math.ceil(((rowCount - 1) * pitch + board.cellSize) * scale + lineW * 2);

    const out = document.createElement('canvas');
    out.width = Math.max(1, width);
    out.height = Math.max(1, height);

    const g = out.getContext('2d');

    // paintBoard 是按整个棋盘画的，这里把相机移到区域左上角，并只画这一片
    paintBoard(g, {
        scale,
        ox: lineW - localX * scale,
        oy: lineW - localY * scale,
        lineW,
        view: { x0: 0, y0: 0, x1: out.width, y1: out.height },
        crop: {
            c0: colStart,
            c1: colStart + colCount,
            r0: rowStart,
            r1: rowStart + rowCount
        }
    });

    return out;
}

// 把主绘制挂进渲染循环（frame 由 shared.mjs 调度）
setRenderHooks({ render: drawFrame });
