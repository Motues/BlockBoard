// 当前画笔 + 最近使用的颜色（localStorage 持久化）。
// 画笔变化后通过监听器通知界面（圆环高亮、调色盘同步、取色浮层），
// 这样调色盘只依赖画笔，不会反过来形成循环依赖。

import {
    BRUSH_PRESETS,
    BRUSH_STORAGE_KEY,
    RECENT_MAX,
    RECENT_STORAGE_KEY,
    RGB_MASK
} from './config.mjs';
import { parseHexColor, presetIndexForRgb, rgbToHex, valueRgb } from './color.mjs';
import { clamp } from './shared.mjs';
import { setBrushCursorSource, updateBrushCursor } from './cursor.mjs';

// 光标要知道当前画笔颜色，这里把读法注入进去（避免 brush ←→ cursor 互相 import）
setBrushCursorSource(getBrushColor);

// 预设颜色：brushIndex 是 1..BRUSH_PRESETS.length
// 自定义颜色：brushIndex 为 0，真正的色值在 brushRgb 里
let brushIndex = 1;
let brushRgb = valueRgb(1);
let brushColor = BRUSH_PRESETS[0].color;

// 最近使用的颜色（#rrggbb，最新在前，最多 RECENT_MAX 条）
let recentColors = [];

// 画笔变化的监听器
const listeners = [];

export function onBrushChange(fn) {
    listeners.push(fn);
}

function notifyBrushChange() {
    for (const fn of listeners) fn();
}

export function isCustomBrush() {
    return brushIndex === 0;
}

export function getBrushIndex() {
    return brushIndex;
}

export function getBrushRgb() {
    return brushRgb;
}

export function getBrushColor() {
    return brushColor;
}

export function getRecentColors() {
    return recentColors;
}

// 按 24bit 颜色选中画笔：命中预设就用预设编号，否则走自定义颜色
export function applyBrushFromRgb(rgb) {
    const value = rgb & RGB_MASK;
    const found = presetIndexForRgb(value);

    if (found > 0) setBrushIndex(found);
    else setBrushRgb(value);
}

// 选择预设颜色
export function setBrushIndex(index) {
    brushIndex = clamp(Math.round(index), 1, BRUSH_PRESETS.length);
    brushRgb = valueRgb(brushIndex);
    brushColor = BRUSH_PRESETS[brushIndex - 1].color;

    saveBrush();
    applyBrush();
}

// 选择自定义颜色（24bit RGB）
export function setBrushRgb(rgb) {
    brushIndex = 0;
    brushRgb = rgb & RGB_MASK;
    brushColor = rgbToHex(brushRgb);

    saveBrush();
    applyBrush();
}

// 画笔变化后统一刷新界面：光标、圆环高亮、圆心预览、重绘，并通知监听器
function applyBrush() {
    updateBrushCursor();
    notifyBrushChange();
}

// --- localStorage ---
function saveBrush() {
    try {
        // 预设存编号，自定义颜色存 #rrggbb
        localStorage.setItem(BRUSH_STORAGE_KEY, isCustomBrush() ? brushColor : String(brushIndex));
    } catch (e) {
        // 隐私模式等场景下写不了，忽略
    }
}

export function loadBrush() {
    let saved = null;
    try {
        saved = localStorage.getItem(BRUSH_STORAGE_KEY);
    } catch (e) {
        saved = null;
    }
    if (!saved) return;

    const text = String(saved).trim();

    // 预设颜色存的是编号
    if (/^\d+$/.test(text)) {
        const asIndex = Number(text);
        if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= BRUSH_PRESETS.length) {
            brushIndex = asIndex;
            brushRgb = valueRgb(brushIndex);
            brushColor = BRUSH_PRESETS[brushIndex - 1].color;
        }
        return;
    }

    // 存的是颜色（上一版存过预设的十六进制色值）：和预设色一样就当预设用，否则算自定义颜色
    const rgb = parseHexColor(text);
    if (rgb === null) return;

    const found = presetIndexForRgb(rgb);
    if (found > 0) {
        brushIndex = found;
        brushRgb = valueRgb(brushIndex);
        brushColor = BRUSH_PRESETS[brushIndex - 1].color;
    } else {
        brushIndex = 0;
        brushRgb = rgb;
        brushColor = rgbToHex(rgb);
    }
}

function saveRecentColors() {
    try {
        localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recentColors));
    } catch (e) {
        // 隐私模式等场景下写不了，忽略
    }
}

export function loadRecentColors() {
    let saved = null;
    try {
        saved = localStorage.getItem(RECENT_STORAGE_KEY);
    } catch (e) {
        saved = null;
    }
    if (!saved) return;

    let parsed = null;
    try {
        parsed = JSON.parse(saved);
    } catch (e) {
        return; // 存坏了就当没有
    }
    if (!Array.isArray(parsed)) return;

    for (const entry of parsed) {
        const rgb = parseHexColor(entry);
        if (rgb === null) continue;

        // 统一成小写 #rrggbb，顺便去掉重复（不记录纯黑：黑色是擦除色，选中它就是回到预设）
        const hex = rgbToHex(rgb);
        if (hex === '#000000' || recentColors.includes(hex)) continue;

        recentColors.push(hex);
        if (recentColors.length >= RECENT_MAX) break;
    }
}

// 某个颜色写进最近列表：去重后提到最前，超过上限就丢掉最旧的
export function rememberColor(hex) {
    if (hex === '#000000') return;

    const index = recentColors.indexOf(hex);
    if (index >= 0) recentColors.splice(index, 1);

    recentColors.unshift(hex);
    if (recentColors.length > RECENT_MAX) recentColors.length = RECENT_MAX;

    saveRecentColors();
    notifyBrushChange(); // 界面重画"最近使用"那一行
}

// 当前画笔颜色写进最近列表
export function commitRecentColor() {
    rememberColor(brushColor);
}
