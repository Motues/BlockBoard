// 画布渲染：网格 + 方块、风车切换动画、导出用的离屏绘制。
// 悬停高亮由 board.mjs 通过 shared 的渲染钩子挂进来。
//
// 屏幕上的画面分三层：
//   1) 棋盘层（背景 + 网格 + 方块）—— 只在"状态或相机变了"时重画，
//      结果存在离屏 canvas 里，其余帧直接 drawImage 一次（悬停/风车每帧都在动，
//      但棋盘本身没动，这一层缓存能省掉每帧的整盘重画）
//   2) 风车动画层（drawSwitches）
//   3) 覆盖层（paintOverlays：悬停高亮、开发者选区）
// 缓存是否可用由 shared 的 getBoardRevision() + 相机参数决定：requestRender() 会自增版本号，
// 只有悬停变化时走 requestOverlayRender()（不动版本号），这一层才能被复用。

import { COLORS, EXPORT_SCALE, MIN_LINE_PITCH, SWITCH_SETTLE, SWITCH_SPIN_RATE } from './config.mjs';
import { valueRgb, valueToColor } from './color.mjs';
import { getGridState, isBoardReady } from './board.mjs';
import { lineWidthFor, makeCamera } from './camera.mjs';
import { closeOptionsPanel } from './ring.mjs';
import {
    animations,
    board,
    canvas,
    clamp,
    ctx,
    getBoardRevision,
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

    // 2) 再画方块。每格颜色可能不同，所以只在颜色变化时切换 fillStyle。
    //    比较的是取值本身（数字），valueToColor 只在颜色真的换了时才调用 ——
    //    自定义颜色的那条路径要拼字符串，逐格调用是渲染里最贵的一笔开销。
    //    注意不能把相邻同色格并成一个 fillRect：格子之间那条缝隙（lineW）是网格线的
    //    可见部分，合并会把网格线盖掉；缩得太小（连网格线都不画了）时由 paintBoardLod 接手
    let lastValue = -1;

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

            const cellValue = gridState[index];
            if (cellValue !== lastValue) {
                g.fillStyle = valueToColor(cellValue);
                lastValue = cellValue;
            }

            g.fillRect(x, y, w, h);
        }
    }
}

// --- 缩到很小的时候：1 像素/格 的位图 ---
// 格子只有几个物理像素、连网格线都不画了的时候，逐格 fillRect 是纯浪费：
// 把可见范围填进一张"1 像素/格"的小画布，再一次性放大贴上来（最近邻，格子边界依然清楚）。
// 成本从 O(可见格数) 次 fillRect 降到 1 次 drawImage，且位图只在状态 / 可见范围变化时重建。

// ImageData 的字节顺序是 RGBA，用 Uint32 视图写的时候要看机器字节序
const LOD_LITTLE_ENDIAN = (() => {
    const probe = new Uint32Array([1]);
    return new Uint8Array(probe.buffer)[0] === 1;
})();

const lod = {
    canvas: null,
    g: null,
    image: null,
    width: 0,
    height: 0,
    key: ''
};

// 单元格取值 → ImageData 里的一格（0xAABBGGRR）
function packCell(value) {
    const rgb = valueRgb(value);
    const r = (rgb >> 16) & 0xff;
    const g = (rgb >> 8) & 0xff;
    const b = rgb & 0xff;

    return LOD_LITTLE_ENDIAN
        ? ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
        : (((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0);
}

function lodImageData(width, height) {
    if (!lod.image || lod.width < width || lod.height < height) {
        // 取可见范围的上界做一次分配，之后平移只改变脏矩形，不再重新分配
        lod.width = Math.max(width, lod.width);
        lod.height = Math.max(height, lod.height);
        lod.image = new ImageData(lod.width, lod.height);
    }
    return lod.image;
}

// 把可见范围的格子画成 1 像素/格 的位图并放大贴上来
function paintBoardLod(g, cam) {
    const pitchLocal = board.cellSize + board.gap;
    const pitchPx = pitchLocal * cam.scale;
    const view = { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };

    // 可见格子范围（和 paintBoard 同一套算法，外扩一格）
    const c0 = clamp(Math.floor((view.x0 - cam.ox) / pitchPx) - 1, 0, board.cols);
    const c1 = clamp(Math.ceil((view.x1 - cam.ox) / pitchPx) + 1, 0, board.cols);
    const r0 = clamp(Math.floor((view.y0 - cam.oy) / pitchPx) - 1, 0, board.rows);
    const r1 = clamp(Math.ceil((view.y1 - cam.oy) / pitchPx) + 1, 0, board.rows);

    const w = c1 - c0;
    const h = r1 - r0;
    if (w <= 0 || h <= 0) return;

    // 整个棋盘先铺一层缝隙色当外框（这一层就是网格线颜色）
    g.fillStyle = COLORS.gap;
    g.fillRect(
        cam.px(0),
        cam.py(0),
        Math.max(0, cam.px(board.width) - cam.px(0)),
        Math.max(0, cam.py(board.height) - cam.py(0))
    );

    const key = `${getBoardRevision()}|${c0},${r0},${w}x${h}`;

    if (lod.key !== key) {
        // 先确定位图尺寸（必要时扩容），再保证 canvas 装得下
        const image = lodImageData(w, h);

        if (!lod.canvas) lod.canvas = document.createElement('canvas');
        if (lod.canvas.width < lod.width || lod.canvas.height < lod.height) {
            lod.canvas.width = lod.width;
            lod.canvas.height = lod.height;
        }

        const lg = lod.g || (lod.g = lod.canvas.getContext('2d'));
        const packed = new Uint32Array(image.data.buffer);
        const gridState = getGridState();
        const cols = board.cols;

        for (let row = 0; row < h; row++) {
            const srcRow = (r0 + row) * cols + c0;
            const dstRow = row * lod.width;

            for (let col = 0; col < w; col++) {
                packed[dstRow + col] = packCell(gridState[srcRow + col]);
            }
        }

        lg.putImageData(image, 0, 0, 0, 0, w, h);
        lod.key = key;
    }

    // 最近邻放大：格子边界保持清晰，不糊
    g.imageSmoothingEnabled = false;
    g.drawImage(
        lod.canvas,
        0, 0, w, h,
        cam.px(board.padding + c0 * pitchLocal),
        cam.py(board.padding + r0 * pitchLocal),
        Math.max(1, cam.px(board.padding + c1 * pitchLocal) - cam.px(board.padding + c0 * pitchLocal)),
        Math.max(1, cam.py(board.padding + r1 * pitchLocal) - cam.py(board.padding + r0 * pitchLocal))
    );
    g.imageSmoothingEnabled = true;
}

// 棋盘层（背景 + 棋盘）画进离屏 canvas
function paintBoardLayer(g, cam) {
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, canvas.width, canvas.height);

    // 格子小到画不出网格线时走位图路径
    const pitchPx = (board.cellSize + board.gap) * cam.scale;
    if (pitchPx < MIN_LINE_PITCH) {
        paintBoardLod(g, cam);
        return;
    }

    paintBoard(g, {
        scale: cam.scale,
        ox: cam.ox,
        oy: cam.oy,
        lineW: cam.lineW,
        view: { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height },
        // 正在播放风车动画的格子由 drawSwitches 单独画，这里跳过
        skip: animations.size > 0 ? animations : null
    });
}

// 棋盘层的缓存：键 = 相机参数（缩放 / 平移 / 线宽 / 画布尺寸）+ 棋盘版本号
const boardLayer = { canvas: null, g: null, key: '' };

function drawBoardLayer(cam) {
    const key = `${cam.scale}|${cam.ox}|${cam.oy}|${cam.lineW}|${canvas.width}x${canvas.height}|${getBoardRevision()}`;

    if (boardLayer.key !== key) {
        if (!boardLayer.canvas) boardLayer.canvas = document.createElement('canvas');
        if (boardLayer.canvas.width !== canvas.width || boardLayer.canvas.height !== canvas.height) {
            boardLayer.canvas.width = canvas.width;
            boardLayer.canvas.height = canvas.height;
        }

        const g = boardLayer.g || (boardLayer.g = boardLayer.canvas.getContext('2d'));
        paintBoardLayer(g, cam);
        boardLayer.key = key;
    }

    ctx.drawImage(boardLayer.canvas, 0, 0);
}

// 每帧一画：棋盘层（有缓存就 blit）→ 风车动画 → 各模块挂上来的覆盖层
function drawFrame(now) {
    if (!isBoardReady()) return;

    const cam = makeCamera();

    drawBoardLayer(cam);
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
