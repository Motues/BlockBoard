// 鼠标指针：普通模式是画笔颜色的小圆，取色模式是吸管。
//
// 吸管的形状取自 Material Symbols 的"取色/绘制"图标（24x24 路径），
// 为了在任意底色上都看得清，这里不做纯填充，而是描边成剪影：
// 先描一圈粗白边当外轮廓，再叠一圈黑边与灰蓝色填充，深色底和浅色底都不会糊掉。

import { isPickMode } from './shared.mjs';

const DROPPER_VIEW_BOX = 24;

// 图标路径：笔杆 + 笔头 + 内部镂空 + 笔帽，共 4 段子路径
const DROPPER_PATH =
    'M5 19h1.425L16.2 9.225L14.775 7.8L5 17.575z' +
    'm-1 2q-.425 0-.712-.288T3 20v-2.425q0-.4.15-.763t.425-.637L16.2 3.575' +
    'q.3-.275.663-.425t.762-.15t.775.15t.65.45L20.425 5q.3.275.437.65T21 6.4' +
    'q0 .4-.138.763t-.437.662l-12.6 12.6q-.275.275-.638.425t-.762.15z' +
    'M19 6.4L17.6 5z' +
    'm-3.525 2.125l-.7-.725L16.2 9.225z';

const DROPPER_FILL = '#9aa4b2';

const DROPPER_SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 ${DROPPER_VIEW_BOX} ${DROPPER_VIEW_BOX}">` +
    `<path d="${DROPPER_PATH}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="${DROPPER_PATH}" fill="${DROPPER_FILL}" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/>` +
    '</svg>';

// 图标笔尖在 24x24 里是左下角 (3, 22)，作为光标热点
const DROPPER_HOTSPOT = { x: 3, y: 22 };

function cursorStyle(svg, hotspotX, hotspotY, fallback) {
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, ${fallback}`;
}

// brush.mjs 注入"当前画笔颜色"的读法（见 setBrushCursorSource），
// 这样 cursor 不需要 import brush，避免两者互相引用
let readBrushColor = () => '#eeeeee';
export function setBrushCursorSource(fn) {
    readBrushColor = fn;
}

export function updateBrushCursor() {
    // 取色模式：吸管
    if (isPickMode()) {
        document.body.style.cursor =
            cursorStyle(DROPPER_SVG, DROPPER_HOTSPOT.x, DROPPER_HOTSPOT.y, 'crosshair');
        return;
    }

    // 普通模式：画笔颜色的小圆
    const brushColor = readBrushColor();
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
        `<circle cx="16" cy="16" r="10" fill="${brushColor}" fill-opacity="0.35"/>` +
        `<circle cx="16" cy="16" r="5" fill="${brushColor}"/>` +
        '</svg>';

    document.body.style.cursor = cursorStyle(svg, 16, 16, 'auto');
}
