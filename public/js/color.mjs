// 颜色换算：24bit 整数 ↔ #rrggbb ↔ HSV，以及「单元格取值 → 颜色」。

import {
    BLACK_VALUE,
    BRUSH_PRESETS,
    COLORS,
    PRESET_MAX,
    RGB_MASK,
    RGB_MIN
} from './config.mjs';

// '#abc' / '#aabbcc' / 'aabbcc' 都能解析，解析不了返回 null
export function parseHexColor(text) {
    const raw = String(text).trim().replace(/^#/, '');

    if (/^[0-9a-f]{3}$/i.test(raw)) {
        return parseInt(raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2], 16);
    }
    if (/^[0-9a-f]{6}$/i.test(raw)) {
        return parseInt(raw, 16);
    }

    return null;
}

export function rgbToHex(rgb) {
    return '#' + (rgb & RGB_MASK).toString(16).padStart(6, '0');
}

export function rgbComponents(rgb) {
    return {
        r: (rgb >> 16) & 0xff,
        g: (rgb >> 8) & 0xff,
        b: rgb & 0xff
    };
}

export function rgbComponentsToText(rgb) {
    const { r, g, b } = rgbComponents(rgb);
    return `${r}, ${g}, ${b}`;
}

export function rgbToHsv(rgb) {
    const { r, g, b } = rgbComponents(rgb);
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;

    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const delta = max - min;

    let h = 0;
    if (delta !== 0) {
        if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
        else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
        else h = 60 * ((rn - gn) / delta + 4);
    }
    if (h < 0) h += 360;

    return { h: h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb(h, s, v) {
    const c = v * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const m = v - c;

    let base;
    if (hp < 1) base = [c, x, 0];
    else if (hp < 2) base = [x, c, 0];
    else if (hp < 3) base = [0, c, x];
    else if (hp < 4) base = [0, x, c];
    else if (hp < 5) base = [x, 0, c];
    else base = [c, 0, x];

    const to255 = (n) => Math.round((n + m) * 255);
    return ((to255(base[0]) << 16) | (to255(base[1]) << 8) | to255(base[2])) >>> 0;
}

// 感知亮度 0..1：悬停时决定用亮色还是暗色叠加（黑块提亮 / 亮块压暗）
export function colorLuminance(rgb) {
    const { r, g, b } = rgbComponents(rgb);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// 预设色 → 编号（1..N），不是预设色返回 -1。
// 调色盘 / 取色器拿到的是 24bit 颜色，命中预设就存编号，跟服务端的取值协议保持一致
export function presetIndexForRgb(rgb) {
    for (let i = 0; i < BRUSH_PRESETS.length; i++) {
        if (parseHexColor(BRUSH_PRESETS[i].color) === rgb) return i + 1;
    }
    return -1;
}

export function isCustomValue(value) {
    return value > PRESET_MAX;
}

// 24bit RGB → 单元格取值
export function customValue(rgb) {
    const value = rgb & RGB_MASK;
    return value > PRESET_MAX ? value : RGB_MIN;
}

// --- 颜色值 ↔ 实际颜色 ---
// 颜色值 → 实际颜色（16 项，覆盖 4bit 的全部取值）
const VALUE_COLORS = new Array(16).fill(COLORS.white);
// 颜色值 → 24bit RGB（自定义颜色的比较与亮度计算用得上）
const VALUE_RGB = new Array(16).fill(0xffffff);

VALUE_COLORS[BLACK_VALUE] = COLORS.black;
VALUE_RGB[BLACK_VALUE] = 0x000000;

BRUSH_PRESETS.forEach((preset, i) => {
    VALUE_COLORS[i + 1] = preset.color;

    const rgb = parseHexColor(preset.color);
    VALUE_RGB[i + 1] = rgb === null ? 0xffffff : rgb;
});

// 颜色值 → CSS 颜色；自定义颜色当场换算成 #rrggbb
export function valueToColor(value) {
    if (isCustomValue(value)) return rgbToHex(value);
    return VALUE_COLORS[value] || COLORS.white;
}

// 颜色值 → 24bit RGB
export function valueRgb(value) {
    if (isCustomValue(value)) return value & RGB_MASK;
    return typeof VALUE_RGB[value] === 'number' ? VALUE_RGB[value] : 0xffffff;
}

export function valueIsDark(value) {
    return colorLuminance(valueRgb(value)) < 0.5;
}
