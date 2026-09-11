// 调色盘：HSV 选色、色号输入、最近使用的颜色，以及取色器（吸管）模式与取色浮窗。

import { RGB_MASK } from './config.mjs';
import {
    applyBrushFromRgb,
    commitRecentColor,
    getBrushRgb,
    getRecentColors,
    onBrushChange,
    rememberColor,
    setBrushRgb as setBrushRgbValue
} from './brush.mjs';
import {
    colorLuminance,
    hsvToRgb,
    parseHexColor,
    rgbComponentsToText,
    rgbToHex,
    rgbToHsv,
    valueRgb
} from './color.mjs';
import { onLangChange, t } from './i18n.mjs';
import {
    clamp,
    colorPickerEl,
    isPickMode,
    markHoverDirty,
    markPickJustHandled,
    requestRender,
    serverCaps,
    setPickMode,
    viewport
} from './shared.mjs';
import { getGridState } from './board.mjs';
import { updateBrushCursor } from './cursor.mjs';

const tooltipEl = document.getElementById('pick-tooltip');
const tooltipHexEl = document.getElementById('pick-tooltip-hex');
const tooltipChipEl = document.getElementById('pick-tooltip-chip');

let pickerOpen = false;
let pickerHsv = { h: 0, s: 0, v: 1 };
let pickerRgb = 0xeeeeee;
let pickerDrag = false;
// 取色后重新打开调色盘时，先把画笔恢复成上次关面板时的颜色，
// 免得拖过又没确认的临时颜色把吸管取到的颜色盖掉
let committedRgb = 0xeeeeee;
// 开发者工具借调色盘选颜色时挂上来的回调：关闭 / 完成时把当前颜色交出去
let pickHandler = null;

// 调色盘关闭时把画笔恢复成"上次确认的颜色"（由 main.mjs 在启动时初始化）
export function primePickerBrush(rgb) {
    committedRgb = rgb & RGB_MASK;
}

// 开发者工具用：把调色盘当"选色对话框"打开，选完通过回调返回颜色。
// anchor 给了就贴着那个点展开（否则按画笔圆环的位置定位）
export function openColorPickerFor(onPick, anchor) {
    pickHandler = typeof onPick === 'function' ? onPick : null;
    openColorPicker(anchor);
}

// 开发者工具用：让调色盘以某个颜色为起点打开
export function primePickerFromRgb(rgb) {
    pickerRgb = rgb & RGB_MASK;
    pickerHsv = rgbToHsv(pickerRgb);
}

export function isColorPickerOpen() {
    return pickerOpen;
}

export function openColorPicker(anchor) {
    if (!serverAllowsRgb()) return; // 老服务端不认识自定义颜色

    const picker = colorPickerEl;
    const ring = document.getElementById('brush-ring');

    // 普通流程：画笔先回到上次确认的颜色，再让调色盘以它为起点。
    // 开发者工具借调色盘选色时（pickHandler）不改画笔，用 primePickerFromRgb 指定的起点
    if (!pickerOpen && !pickHandler) {
        applyBrushFromRgb(committedRgb);
        syncPickerFromBrush();
    }

    // 先量尺寸再定位（隐藏时用的是 visibility: hidden，尺寸依然可测）
    const ringHalf = ring.offsetWidth / 2;
    const margin = 12;
    const gap = 14;
    const w = picker.offsetWidth;
    const h = picker.offsetHeight;

    // 有锚点（例如从开发者菜单里点「自定义颜色」）就贴着锚点展开，
    // 否则按画笔圆环的位置来
    let anchorX = viewport.w / 2;
    let anchorY = viewport.h / 2;
    let half = 0;

    if (anchor && typeof anchor.x === 'number') {
        anchorX = anchor.x;
        anchorY = anchor.y;
    } else {
        const ringRect = ring.getBoundingClientRect();
        anchorX = ringRect.left + ringRect.width / 2;
        anchorY = ringRect.top + ringRect.height / 2;
        half = ringHalf;
    }

    // 优先放在锚点右边，放不下就放左边，最后再夹进屏幕
    let x = anchorX + half + gap;
    if (x + w > viewport.w - margin) {
        x = anchorX - half - gap - w;
    }
    x = clamp(x, margin, Math.max(margin, viewport.w - w - margin));

    const y = clamp(anchorY - h / 2, margin, Math.max(margin, viewport.h - h - margin));

    picker.style.left = Math.round(x) + 'px';
    picker.style.top = Math.round(y) + 'px';
    picker.classList.remove('hidden');
    renderPicker();

    pickerOpen = true;

    // 允许鼠标滚轮缩放棋盘时不要误改色相：焦点留给色号输入框之外的地方
    document.getElementById('picker-hex').blur();
}

// 关调色盘（点击吸管走 startPicking，不会到这里）
export function closeColorPicker() {
    if (!pickerOpen) return;

    // 普通流程：关面板 = 确认这次选的颜色，记进"最近使用"；
    // 开发者工具借调色盘选色时不碰画笔，只把颜色回调出去
    if (pickHandler) {
        const handler = pickHandler;
        pickHandler = null;
        handler(pickerRgb & RGB_MASK);
    } else {
        commitRecentColor();
        committedRgb = getBrushRgb();
    }

    pickerOpen = false;
    pickerDrag = false;
    colorPickerEl.classList.add('hidden');
}

// --- 取色器（吸管）---
// 进入后鼠标变成吸管，棋盘上的方块放大但不再有波浪，
// 悬停时跟随鼠标显示当前颜色的十六进制码，点一下就把它设为画笔颜色并退出取色模式
export function startPicking() {
    closeColorPicker();

    if (isPickMode()) return;

    setPickMode(true);

    updateBrushCursor();
    markHoverDirty();
}

export function stopPicking() {
    if (!isPickMode()) return;

    setPickMode(false);

    hidePickTooltip();
    updateBrushCursor();
    markHoverDirty();
    requestRender();
}

// 浮窗跟着鼠标走，并夹在视口里
export function showPickTooltip(rgb, clientX, clientY) {
    const hex = rgbToHex(rgb);

    tooltipChipEl.style.background = hex;
    tooltipHexEl.textContent = hex;
    tooltipEl.classList.remove('hidden');

    const rect = tooltipEl.getBoundingClientRect();
    const margin = 8;
    const x = clamp(clientX + 18, margin, Math.max(margin, viewport.w - rect.width - margin));
    const y = clientY + rect.height + 20 > viewport.h
        ? clientY - rect.height - 16
        : clientY + 18;

    tooltipEl.style.left = Math.round(x) + 'px';
    tooltipEl.style.top = Math.round(Math.max(margin, y)) + 'px';
}

export function hidePickTooltip() {
    tooltipEl.classList.add('hidden');
}

// 取色模式下移动鼠标：更新浮窗（index < 0 表示没指在方块上）
export function updatePickHover(index, clientX, clientY) {
    if (index < 0) {
        hidePickTooltip();
        return;
    }

    showPickTooltip(valueRgb(getGridState()[index]), clientX, clientY);
}

// --- 调色盘自身 ---

// 调色盘的当前颜色 → 画笔（即时生效）
function applyPickerColor() {
    setBrushRgbValue(pickerRgb);
}

// 把调色盘的状态画到界面上：SV 面板底色、游标、色相滑条、预览、色号
function renderPicker(options) {
    const opts = options || {};
    const hue = pickerHsv.h;
    const sv = document.getElementById('picker-sv');
    const cursor = document.getElementById('picker-sv-cursor');
    const hueSlider = document.getElementById('picker-hue');
    const hexInput = document.getElementById('picker-hex');
    const preview = document.getElementById('picker-preview');

    // 面板底色：白 → 纯色相，再叠一层透明 → 黑
    sv.style.background =
        `linear-gradient(to top, #000, rgba(0, 0, 0, 0)),` +
        `linear-gradient(to right, #fff, hsl(${hue.toFixed(1)}, 100%, 50%))`;

    cursor.style.left = (pickerHsv.s * 100).toFixed(2) + '%';
    cursor.style.top = ((1 - pickerHsv.v) * 100).toFixed(2) + '%';

    hueSlider.value = String(Math.round(hue));

    preview.style.background = rgbToHex(pickerRgb);
    document.getElementById('picker-rgb').textContent = rgbComponentsToText(pickerRgb);

    // 吸管按钮的底色跟着当前颜色走；浅色底上换成深色图标，不然图标看不见
    colorPickerEl.style.setProperty('--picker-color', rgbToHex(pickerRgb));
    colorPickerEl.style.setProperty('--picker-fg', colorLuminance(pickerRgb) > 0.55 ? '#1a1a1a' : '#ffffff');

    // 用户正在输入时不要回写输入框，免得打字打到一半被覆盖
    if (!opts.fromHex) {
        hexInput.value = rgbToHex(pickerRgb);
        hexInput.classList.remove('invalid');
    }
}

// 拖动 / 滑动只改 HSV 里的一个分量：
// 这样拖到灰色（饱和度 0）时色相不会被丢掉，滑条不会突然跳回红色
function setPickerHsv(h, s, v) {
    pickerHsv = { h: ((h % 360) + 360) % 360, s: clamp(s, 0, 1), v: clamp(v, 0, 1) };
    pickerRgb = hsvToRgb(pickerHsv.h, pickerHsv.s, pickerHsv.v);

    renderPicker();
    applyPickerColor();
}

// 已经知道确切颜色时（色号输入、打开调色盘）反过来算出 HSV
function setPickerRgb(rgb, options) {
    pickerRgb = rgb & RGB_MASK;
    pickerHsv = rgbToHsv(pickerRgb);

    renderPicker(options);
}

// 画笔 → 调色盘（打开调色盘时同步一次）
function syncPickerFromBrush() {
    // 自定义颜色用画笔自己的色值，预设色直接换算成 24bit 作为起点
    setPickerRgb(getBrushRgb());
}

// 拖动 / 点击 SV 面板：横向是饱和度，纵向是明度
function pickerPointToSv(clientX, clientY) {
    const sv = document.getElementById('picker-sv');
    const rect = sv.getBoundingClientRect();

    const s = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const v = 1 - clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);

    return { s, v };
}

function onPickerSvMove(clientX, clientY) {
    const { s, v } = pickerPointToSv(clientX, clientY);

    setPickerHsv(pickerHsv.h, s, v);
}

// 最近使用的颜色
export function renderRecentColors() {
    const wrap = document.getElementById('picker-recent');
    wrap.innerHTML = '';

    const recentColors = getRecentColors();
    if (recentColors.length === 0) return;

    const label = document.createElement('div');
    label.className = 'picker-recent-label';
    label.textContent = t('picker.recent');
    wrap.appendChild(label);

    const list = document.createElement('div');
    list.className = 'picker-recent';

    for (const hex of recentColors) {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'picker-recent-swatch';
        swatch.style.background = hex;
        swatch.title = hex;

        // 点一下就换成这个颜色（预设色会走预设编号，服务端才认识）
        swatch.addEventListener('click', () => {
            applyBrushFromRgb(parseHexColor(hex));
            rememberColor(hex);
        });

        list.appendChild(swatch);
    }

    wrap.appendChild(list);

    // 当前画笔色在最近列表里高亮
    highlightActiveRecent();
}

function highlightActiveRecent() {
    const brushColor = rgbToHex(getBrushRgb());
    for (const swatch of document.querySelectorAll('.picker-recent-swatch')) {
        swatch.classList.toggle('active', swatch.title === brushColor);
    }
}

// 调色盘里的自定义颜色要服务端认识才可用（由 connection.mjs 在 init-game 里判定）
function serverAllowsRgb() {
    return serverCaps.rgb;
}

// --- 事件绑定 ---
export function bindPickerEvents() {
    document.getElementById('picker-sv').addEventListener('pointerdown', (e) => {
        e.preventDefault();

        pickerDrag = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onPickerSvMove(e.clientX, e.clientY);
    });

    document.getElementById('picker-sv').addEventListener('pointermove', (e) => {
        if (!pickerDrag) return;
        onPickerSvMove(e.clientX, e.clientY);
    });

    document.getElementById('picker-sv').addEventListener('pointerup', (e) => {
        pickerDrag = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    });

    document.getElementById('picker-sv').addEventListener('pointercancel', () => {
        pickerDrag = false;
    });

    // 色相滑条
    document.getElementById('picker-hue').addEventListener('input', (e) => {
        setPickerHsv(Number(e.target.value), pickerHsv.s, pickerHsv.v);
    });

    // 色号输入框：#rgb / #rrggbb 都认，输入过程中不合法就先标红
    document.getElementById('picker-hex').addEventListener('input', (e) => {
        const rgb = parseHexColor(e.target.value);

        if (rgb === null) {
            e.target.classList.add('invalid');
            return;
        }

        e.target.classList.remove('invalid');
        setPickerRgb(rgb, { fromHex: true });
        applyPickerColor();
    });

    document.getElementById('picker-hex').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.target.blur();
            closeColorPicker();
        }
    });

    // 完成：关掉调色盘（颜色在选的时候就已经生效）
    document.getElementById('picker-done').addEventListener('click', () => {
        closeColorPicker();
    });

    // 吸管：关掉调色盘，进入取色模式（鼠标变吸管，点方块即取它的颜色）
    document.getElementById('picker-eyedropper').addEventListener('click', () => {
        startPicking();
    });
}

// 画笔变化时：刷新"最近使用"与当前色高亮；调色盘开着的话同步一次 HSV 起点
onBrushChange(() => {
    renderRecentColors();

    // 调色盘没有打开时不要回写 pickerHsv：拖到灰色（饱和度 0）时色相会被 RGB 反算冲掉
    if (pickerOpen) syncPickerFromBrush();
});

// "最近使用"这一行的小标题是动态生成的，换语言要重画
onLangChange(renderRecentColors);
