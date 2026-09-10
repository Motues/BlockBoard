// 握手里告诉服务端自己认识哪些状态格式（见 src/server.ts 的 init-game）：
//   rgb24 = 24bit 取值（>= 16 是自定义颜色）+ 3 字节/格 的稠密状态
//   rle   = RLE 紧凑状态（跳过黑格，通常只有几十字节）
// 服务端会据此只发一份状态，而不是把几种格式都塞过来
const STATE_CAPS = ['rgb24', 'rle'];

const socket = io({ auth: { caps: STATE_CAPS } });
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

// --- UI 元素获取 ---
const settingsButton = document.getElementById('settings-button');
const optionsPanel = document.getElementById('options-panel');
const menuIcon = document.getElementById('menu-icon');
const closeIcon = document.getElementById('close-icon');

let isPanelOpen = false;

// --- 配置 ---
const ZOOM_CONFIG = {
    // 最大缩放倍数（相对 1 倍原始大小），例如 8 表示最大放大到 800%
    MAX_SCALE: 8,
    // 滚轮灵敏度，数值越大缩放越快
    WHEEL_SENSITIVITY: 0.0015
};

// 状态切换动画（风车）时长(ms)
// 动画在"点击瞬间"就开始，所以这是最短时长：
//   · 服务器很快 → 动画在 SWITCH_DURATION 内转完并淡出成最终颜色
//   · 服务器很慢 → 风车一直转，直到响应到达后再用 SWITCH_SETTLE 收尾
// 也就是「响应时间 + 动画时间 ≥ SWITCH_DURATION」始终成立
const SWITCH_DURATION = 380;
const SWITCH_SETTLE = 90;      // 收到响应后，从风车淡出为最终颜色的收尾时长(ms)
const SWITCH_SPIN_PERIOD = 400; // 风车转一整圈需要的时间(ms)，越大转得越慢（等待服务器期间也是这个速度）
const SWITCH_SPIN_RATE = 1 / SWITCH_SPIN_PERIOD; // 圈/ms
const PENDING_TIMEOUT = 8000;   // 等待服务器回包的超时保护(ms)
const EXPORT_SCALE = 2;         // 导出图片相对棋盘的分辨率倍数
const MIN_LINE_PITCH = 6;       // 格子间距小于该物理像素数时不画网格线
const HOVER_SCALE = 0.1;        // 悬停时方块放大的比例（1.1 倍）
const HOVER_TAU = 70;           // 悬停缩放的缓动时间常数(ms)，越大越柔和
const HOVER_TINT = 0.1;         // 悬停方块相较周围像素的明暗偏移（黑块提亮 / 白块压暗）
const HOVER_WAVE_PERIOD = 1200; // 波浪从左上角滚到右下角的周期(ms)
const HOVER_WAVE_AMPLITUDE = 0.22; // 波浪明暗的最大强度
const GAP_SIZE = 1;             // 格子之间的缝隙（棋盘内部坐标，单位 px）
const PADDING_SIZE = 1;         // 棋盘四周留白（棋盘内部坐标，单位 px）

// --- 颜色（与 styles.css 中的 CSS 变量保持一致）---
function readColorVar(style, name, fallback) {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
}

const rootStyle = getComputedStyle(document.documentElement);
const COLORS = {
    bg: readColorVar(rootStyle, '--bg-color', '#222222'),
    gap: readColorVar(rootStyle, '--grid-gap-color', '#444444'),
    black: readColorVar(rootStyle, '--cell-black', '#070707'),
    white: readColorVar(rootStyle, '--cell-white', '#eeeeee')
};

// --- 画笔颜色（右键圆环里选择）---
// 预设颜色编号与服务端的单元格取值一一对应：0 = 黑，1..N = 下面的预设颜色
// 预设都是低饱和度（灰调）的颜色，1 号与默认的"白块"一致
// 圆心的彩虹圆另外支持任意 24bit RGB 自定义颜色
// name 用「中文 / English」格式，会显示在圆环色块的提示里
const BRUSH_PRESETS = [
    { color: '#eeeeee', name: '灰白（默认）/ Off White (default)' },
    { color: '#cbb9a3', name: '米杏 / Beige' },
    { color: '#c79a83', name: '陶土 / Terracotta' },
    { color: '#b6bb92', name: '橄榄 / Olive' },
    { color: '#9dba9c', name: '灰绿 / Sage' },
    { color: '#9bb8bd', name: '灰青 / Teal' },
    { color: '#a6a8c0', name: '灰紫 / Lavender' },
    { color: '#c4a5ae', name: '灰粉 / Dusty Rose' }
];
const BRUSH_STORAGE_KEY = 'blockboard-brush-color';
const BLACK_VALUE = 0;

// --- 单元格取值（与 src/state.ts 保持一致）---
//   0x000000           → 黑色
//   0x000001..0x00000F → 预设颜色编号（对应 VALUE_COLORS）
//   >= 0x000010        → 自定义颜色，值本身就是 24bit RGB
// 预设编号占掉了 0x00..0x0F，自定义颜色落到这一段（#000000..#00000F，肉眼都是纯黑）
// 会被抬到 0x000010 再存
const PRESET_MAX = 15;
const RGB_MIN = PRESET_MAX + 1;
const RGB_MASK = 0x00ffffff;

function isCustomValue(value) {
    return value > PRESET_MAX;
}

// 24bit RGB → 单元格取值
function customValue(rgb) {
    const value = rgb & RGB_MASK;
    return value > PRESET_MAX ? value : RGB_MIN;
}

// --- 颜色换算：24bit 整数 ↔ #rrggbb ↔ HSV ---

// '#abc' / '#aabbcc' / 'aabbcc' 都能解析，解析不了返回 null
function parseHexColor(text) {
    const raw = String(text).trim().replace(/^#/, '');

    if (/^[0-9a-f]{3}$/i.test(raw)) {
        return parseInt(raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2], 16);
    }
    if (/^[0-9a-f]{6}$/i.test(raw)) {
        return parseInt(raw, 16);
    }

    return null;
}

function rgbToHex(rgb) {
    return '#' + (rgb & RGB_MASK).toString(16).padStart(6, '0');
}

function rgbComponents(rgb) {
    return {
        r: (rgb >> 16) & 0xff,
        g: (rgb >> 8) & 0xff,
        b: rgb & 0xff
    };
}

function rgbComponentsToText(rgb) {
    const { r, g, b } = rgbComponents(rgb);
    return `${r}, ${g}, ${b}`;
}

function rgbToHsv(rgb) {
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

function hsvToRgb(h, s, v) {
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
function colorLuminance(rgb) {
    const { r, g, b } = rgbComponents(rgb);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// 1 号颜色跟随 CSS 变量 --cell-white，改主题色时不用改两处
BRUSH_PRESETS[0].color = COLORS.white;

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
function valueToColor(value) {
    if (isCustomValue(value)) return rgbToHex(value);
    return VALUE_COLORS[value] || COLORS.white;
}

// 颜色值 → 24bit RGB
function valueRgb(value) {
    if (isCustomValue(value)) return value & RGB_MASK;
    return typeof VALUE_RGB[value] === 'number' ? VALUE_RGB[value] : 0xffffff;
}

function valueIsDark(value) {
    return colorLuminance(valueRgb(value)) < 0.5;
}

// --- 当前画笔 ---
// 预设颜色：brushIndex 是 1..BRUSH_PRESETS.length
// 自定义颜色：brushIndex 为 0，真正的色值在 brushRgb 里
let brushIndex = 1;
let brushRgb = VALUE_RGB[1];
let brushColor = VALUE_COLORS[1];

function isCustomBrush() {
    return brushIndex === 0;
}

// --- 棋盘数据 ---
// gridState[i] 是 0..15 的颜色值：0 = 黑，1..N = BRUSH_PRESETS 里的颜色
let board = {
    cols: 0,
    rows: 0,
    cellSize: 0,
    gap: GAP_SIZE,
    padding: PADDING_SIZE,
    width: 0,   // 棋盘内部坐标下的总宽（含缝隙与留白）
    height: 0
};

let gridState = new Uint8Array(0);
let pendingRequests = new Set();     // 已发出、等待服务器确认的方块
let pendingTimers = new Map();       // 超时保护的定时器
let animations = new Map();          // index -> { from, to, start }
let hoverStates = new Map();         // index -> { value, target, last }  悬停缩放的缓动状态

// --- 视图状态 ---
let viewState = {
    panning: false,
    startX: 0,
    startY: 0,
    translateX: 0,
    translateY: 0,
    scale: 1,
    hasMoved: false,
    hoverIndex: -1
};

// 视口尺寸（CSS px）与设备像素比
let viewport = { w: 0, h: 0, dpr: 1 };

// 双指缩放状态（触摸屏）
let pinchState = null;

// 桌面端才启用悬停高亮
const hoverSupported = window.matchMedia('(hover: hover)').matches;

// 显示提示弹窗并在一段时间后自动隐藏
function showHintPopup() {
    const hintPopup = document.getElementById('hint-popup');

    // 显示提示弹窗
    hintPopup.classList.remove('hidden');

    // 10秒后自动隐藏提示弹窗
    setTimeout(() => {
        hintPopup.classList.add('hidden');
    }, 10000);
}

// 关闭提示弹窗
function closeHintPopup() {
    const hintPopup = document.getElementById('hint-popup');
    hintPopup.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', function() {
    const hintPopup = document.getElementById('hint-popup');

    // 页面加载后延迟1秒显示提示弹窗
    setTimeout(() => {
        hintPopup.classList.remove('hidden');
    }, 1000);

    // 10秒后自动隐藏提示弹窗
    setTimeout(() => {
        hintPopup.classList.add('hidden');
    }, 11000);
});

// --- 设置按钮点击处理 (已优化渐变效果) ---
function toggleOptionsPanel() {
    isPanelOpen = !isPanelOpen;
    const transitionDuration = 300; // 0.3s

    if (isPanelOpen) {
        // 1. 确保元素立即可见，并取消 pointer-events: none;
        optionsPanel.style.visibility = 'visible';

        // 2. 移除 hidden 类触发 opacity 和 transform 渐变
        optionsPanel.classList.remove('hidden');

        // 3. 切换按钮图标
        menuIcon.style.display = 'none';
        closeIcon.style.display = 'block';
    } else {
        // 1. 添加 hidden 类触发 opacity 和 transform 渐变
        optionsPanel.classList.add('hidden');

        // 2. 渐变持续时间后，再彻底移除元素的可见性 (完成渐变)
        setTimeout(() => {
            if (!isPanelOpen) {
                optionsPanel.style.visibility = 'hidden';
            }
        }, transitionDuration);

        // 3. 立即切换按钮图标
        menuIcon.style.display = 'block';
        closeIcon.style.display = 'none';
    }
}

// 绑定设置按钮事件
settingsButton.addEventListener('click', toggleOptionsPanel);

// --- 画笔颜色圆环（右键呼出）---
let brushRingOpen = false;
let brushSwatches = [];

// 按预设生成圆环上的色块
function buildBrushRing() {
    const ring = document.getElementById('brush-ring');
    const radius = 74; // 色块离圆心的距离

    BRUSH_PRESETS.forEach((preset, i) => {
        const angle = (360 / BRUSH_PRESETS.length) * i - 90; // 从正上方开始排

        const slot = document.createElement('div');
        slot.className = 'brush-slot';
        slot.style.transform = `rotate(${angle}deg) translateY(-${radius}px) rotate(${-angle}deg)`;

        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'brush-swatch';
        swatch.dataset.index = String(i + 1);
        swatch.title = preset.name;
        swatch.style.background = preset.color;
        swatch.addEventListener('click', () => {
            setBrushIndex(i + 1);
            closeBrushRing();
        });

        slot.appendChild(swatch);
        ring.appendChild(slot);
        brushSwatches.push(swatch);
    });

    // 圆心的彩虹圆：点击打开调色盘
    const center = document.getElementById('brush-ring-center');
    center.addEventListener('click', () => {
        closeBrushRing();
        openColorPicker();
    });
}

function openBrushRing(clientX, clientY) {
    const ring = document.getElementById('brush-ring');

    // 圆环和调色盘不会同时显示
    closeColorPicker();

    // 贴着屏幕边缘时把圆环收回来，避免被裁掉
    const margin = ring.offsetWidth / 2 + 8;
    const x = clamp(clientX, margin, Math.max(margin, viewport.w - margin));
    const y = clamp(clientY, margin, Math.max(margin, viewport.h - margin));

    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    ring.classList.add('open');
    brushRingOpen = true;

    highlightActiveSwatch();
}

function closeBrushRing() {
    if (!brushRingOpen) return;
    brushRingOpen = false;
    document.getElementById('brush-ring').classList.remove('open');
}

// 从设置面板里打开（给没有右键的触摸设备用）
function openBrushRingFromPanel() {
    const rect = optionsPanel.getBoundingClientRect();
    openBrushRing(rect.left - 130, rect.top + rect.height / 2);
}

function onContextMenu(e) {
    const inRing = e.target.closest && e.target.closest('#brush-ring');

    // 在圆环上再次右键就收起
    if (inRing) {
        e.preventDefault();
        closeBrushRing();
        return;
    }

    // 其它 UI（页脚、设置按钮等）保留浏览器默认菜单
    if (e.target !== canvas) return;

    e.preventDefault();
    openBrushRing(e.clientX, e.clientY);
}

// 选择预设颜色
function setBrushIndex(index) {
    brushIndex = clamp(Math.round(index), 1, BRUSH_PRESETS.length);
    brushRgb = valueRgb(brushIndex);
    brushColor = VALUE_COLORS[brushIndex];

    saveBrush();
    applyBrush();
}

// 选择自定义颜色（24bit RGB）
function setBrushRgb(rgb) {
    brushIndex = 0;
    brushRgb = rgb & RGB_MASK;
    brushColor = rgbToHex(brushRgb);

    saveBrush();
    applyBrush();
}

function saveBrush() {
    try {
        // 预设存编号，自定义颜色存 #rrggbb
        localStorage.setItem(BRUSH_STORAGE_KEY, isCustomBrush() ? brushColor : String(brushIndex));
    } catch (e) {
        // 隐私模式等场景下写不了，忽略
    }
}

function loadBrush() {
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
            brushColor = VALUE_COLORS[brushIndex];
        }
        return;
    }

    // 存的是颜色（上一版存过预设的十六进制色值）：和预设色一样就当预设用，否则算自定义颜色
    const rgb = parseHexColor(text);
    if (rgb === null) return;

    const found = BRUSH_PRESETS.findIndex((preset) => parseHexColor(preset.color) === rgb);
    if (found >= 0) {
        brushIndex = found + 1;
        brushRgb = valueRgb(brushIndex);
        brushColor = VALUE_COLORS[brushIndex];
    } else {
        brushIndex = 0;
        brushRgb = rgb;
        brushColor = rgbToHex(rgb);
    }
}

// 画笔变化后统一刷新界面：光标、圆环高亮、圆心预览、重绘。
// 注意：这里不回写调色盘 —— 调色盘以自身的 HSV 状态为准，
// 拖到灰色时色相才不会被 RGB 反算冲掉
function applyBrush() {
    updateBrushCursor();
    highlightActiveSwatch();
    requestRender();
}

function highlightActiveSwatch() {
    for (const swatch of brushSwatches) {
        const active = !isCustomBrush() && Number(swatch.dataset.index) === brushIndex;
        swatch.classList.toggle('active', active);
    }

    // 圆心：中间的小圆固定是彩虹，外圈显示当前自定义颜色，没选时透明
    const center = document.getElementById('brush-ring-center');

    center.classList.toggle('active', isCustomBrush());
    center.style.background = isCustomBrush() ? brushColor : 'transparent';
}

// 鼠标指针上的小圆跟着画笔颜色变
function updateBrushCursor() {
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">' +
        `<circle cx="16" cy="16" r="10" fill="${brushColor}" fill-opacity="0.35"/>` +
        `<circle cx="16" cy="16" r="5" fill="${brushColor}"/>` +
        '</svg>';

    document.body.style.cursor =
        `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 16 16, auto`;
}

// 圆环打开时，点空白处只收起圆环，不顺手切换方块
document.addEventListener('click', (e) => {
    const inRing = e.target.closest && e.target.closest('#brush-ring');
    const inPicker = e.target.closest && e.target.closest('#color-picker');

    // 调色盘：点外面就收起来（选中的颜色会保留）
    if (pickerOpen && !inPicker && !inRing) {
        closeColorPicker();
    }

    if (!brushRingOpen) return;
    if (inRing) return;

    closeBrushRing();

    // 只有点在棋盘上时才吞掉这次点击；点面板按钮的话照常执行按钮功能
    if (e.target === canvas) {
        e.stopPropagation();
    }
}, true);

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    closeColorPicker();
    closeBrushRing();
});

// --- 调色盘（圆心的彩虹圆点开）---
// 拖动饱和度 / 明度面板或色相滑条选色，也可以直接输入 16 进制色号。
// 选色是即时生效的：拖到哪里，画笔就是什么颜色
let pickerOpen = false;
let pickerHsv = { h: 0, s: 0, v: 1 };
let pickerRgb = 0xeeeeee;
let pickerDrag = false;

function openColorPicker() {
    if (!serverSupportsRgb) return; // 老服务端不认识自定义颜色

    const picker = document.getElementById('color-picker');
    const ring = document.getElementById('brush-ring');

    // 从当前画笔出发，画笔是预设色时也把它作为调色盘的起点
    syncPickerFromBrush();

    // 先量尺寸再定位（隐藏时用的是 visibility: hidden，尺寸依然可测）
    const ringRect = ring.getBoundingClientRect();
    const ringHalf = ring.offsetWidth / 2;
    const margin = 12;
    const gap = 14;
    const w = picker.offsetWidth;
    const h = picker.offsetHeight;

    const centerX = ringRect.left + ringRect.width / 2;
    const centerY = ringRect.top + ringRect.height / 2;

    // 优先放在圆环右边，放不下就放左边，最后再夹进屏幕
    let x = centerX + ringHalf + gap;
    if (x + w > viewport.w - margin) {
        x = centerX - ringHalf - gap - w;
    }
    x = clamp(x, margin, Math.max(margin, viewport.w - w - margin));

    const y = clamp(centerY - h / 2, margin, Math.max(margin, viewport.h - h - margin));

    picker.style.left = Math.round(x) + 'px';
    picker.style.top = Math.round(y) + 'px';
    picker.classList.remove('hidden');

    pickerOpen = true;

    // 允许鼠标滚轮缩放棋盘时不要误改色相：焦点留给色号输入框之外的地方
    document.getElementById('picker-hex').blur();
}

function closeColorPicker() {
    if (!pickerOpen) return;

    pickerOpen = false;
    pickerDrag = false;
    document.getElementById('color-picker').classList.add('hidden');
}

// 调色盘的当前颜色 → 画笔（即时生效）
function applyPickerColor() {
    setBrushRgb(pickerRgb);
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
    // 预设色直接换算成 24bit 作为起点
    setPickerRgb(isCustomBrush() ? brushRgb : valueRgb(brushIndex));
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

// --- Socket ---
// 新服务端会在 init-game 里带上 maxColorIndex，据此判断能否用颜色协议；
// 带上 rgbSupport / state32 就说明它支持自定义 24bit 颜色
let serverSupportsColor = false;
let serverSupportsRgb = false;

socket.on('init-game', (data) => {
    const { config, maxColorIndex, rgbSupport, stateRgb, state32 } = data;
    serverSupportsColor = typeof maxColorIndex === 'number';
    // 状态可能是 stateRgb（新服务端）或 state32（上一版服务端），都说明它支持自定义颜色
    serverSupportsRgb = rgbSupport === true ||
        typeof stateRgb === 'string' ||
        typeof state32 === 'string';

    // 老服务端存不了自定义颜色：禁用圆心，并把自定义画笔退回预设色
    document.getElementById('brush-ring-center').classList.toggle('unsupported', !serverSupportsRgb);
    if (!serverSupportsRgb && isCustomBrush()) {
        setBrushIndex(1);
    }

    initBoard(config, data);
});

// 收到服务器广播：方块的颜色值确定
socket.on('update-square', ({ index, value, isBlack, rgb }) => {
    // rgb 是自定义 24bit 颜色；value / isBlack 用于新老服务端的兼容
    const target = typeof rgb === 'number'
        ? customValue(rgb)
        : typeof value === 'number'
            ? value
            : (isBlack ? BLACK_VALUE : 1);

    const now = performance.now();

    // 响应到了，解除等待（风车不再"无限转"）
    clearPending(index);

    const anim = animations.get(index);
    if (anim) {
        // 自己点击时启动的动画：补上权威颜色，并留出收尾淡出的时间。
        // 服务器慢的时候 end 早已过去，这里会顺势延长到"响应后再收尾"
        anim.to = target;
        anim.end = Math.max(anim.end, now + SWITCH_SETTLE);
    } else if (gridState[index] !== target) {
        // 别人切换的方块：自己也播一遍同样的风车动画
        startSwitch(index, gridState[index], target, now, now + SWITCH_DURATION);
    }

    gridState[index] = target;
    requestRender();
});

socket.on('online-users', (count) => {
    document.getElementById('onlineCount').textContent = count;
});

// --- 初始化棋盘 ---
function initBoard(config, payload) {
    board.cols = config.cols;
    board.rows = config.rows;
    board.cellSize = config.cellSize;
    board.gap = GAP_SIZE;
    board.padding = PADDING_SIZE;
    board.width = board.cols * board.cellSize + (board.cols - 1) * board.gap + board.padding * 2;
    board.height = board.rows * board.cellSize + (board.rows - 1) * board.gap + board.padding * 2;

    gridState = decodeBoardState(payload, board.cols * board.rows);

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

// 服务端下发的棋盘状态可能是三种形态：
//   1. stateRgb + stateEncoding（当前）：24bit，'rle' 是紧凑格式、'dense' 是 3 字节/格
//   2. state32（上一版服务端）：24bit，4 字节/格
//   3. state：4bit，旧服务端 / 没刷新过的旧页面
function decodeBoardState(payload, total) {
    if (typeof payload.stateRgb === 'string') {
        return payload.stateEncoding === 'rle'
            ? decodeRleState(payload.stateRgb, total)
            : decodeStateRgb(payload.stateRgb, total, 3);
    }

    if (typeof payload.state32 === 'string') {
        // 上一版服务端：只有明确写了 stateFormat: 'rgb24' 才是 3 字节/格，
        // 更早的那版不发 stateFormat，是 4 字节/格
        return decodeStateRgb(payload.state32, total, payload.stateFormat === 'rgb24' ? 3 : 4);
    }

    return decodeState(payload.state, total);
}

// 解码服务端状态（旧协议）。
//   4bit/格 的 Base64（每字节两格，低 4 位在前）
//   布尔数组（true = 黑）
function decodeState(state, total) {
    const out = new Uint32Array(total);

    if (typeof state === 'string') {
        const binary = atob(state);

        for (let i = 0; i < total; i++) {
            const byte = binary.charCodeAt(i >> 1);
            if (Number.isNaN(byte)) break;

            out[i] = (i & 1) ? ((byte >> 4) & 0x0f) : (byte & 0x0f);
        }
        return out;
    }

    if (Array.isArray(state)) {
        for (let i = 0; i < total; i++) {
            out[i] = state[i] === false ? 1 : BLACK_VALUE;
        }
    }

    return out;
}

// 解码服务端状态（24bit/格）。
//   bytesPerCell = 3：当前格式，每格 3 字节小端
//   bytesPerCell = 4：上一版格式，每格 4 字节，高 8 位是"自定义颜色"标记
function decodeStateRgb(encoded, total, bytesPerCell) {
    const out = new Uint32Array(total);
    const binary = atob(encoded);
    const step = bytesPerCell === 4 ? 4 : 3;

    for (let i = 0; i < total; i++) {
        const offset = i * step;
        if (offset + step > binary.length) break;

        if (step === 4) {
            // 上一版：高 8 位是标记位，低 24 位才是颜色
            const raw = (
                binary.charCodeAt(offset) |
                (binary.charCodeAt(offset + 1) << 8) |
                (binary.charCodeAt(offset + 2) << 16) |
                (binary.charCodeAt(offset + 3) << 24)
            ) >>> 0;

            out[i] = (raw & 0x01000000) ? customValue(raw & RGB_MASK) : (raw & PRESET_MAX);
            continue;
        }

        out[i] = (
            binary.charCodeAt(offset) |
            (binary.charCodeAt(offset + 1) << 8) |
            (binary.charCodeAt(offset + 2) << 16)
        ) >>> 0;
    }

    return out;
}

// 读取 varint（每字节 7 位，最高位是"还有后续字节"标志）
function readVarint(binary, cursor) {
    let value = 0;
    let scale = 1;

    while (cursor.pos < binary.length) {
        const byte = binary.charCodeAt(cursor.pos++);
        value += (byte & 0x7f) * scale;

        if ((byte & 0x80) === 0) break;
        scale *= 128;
    }

    return value;
}

// 解码 RLE 紧凑状态（与 src/state.ts 的 encodeRle 对应）：
// 每个色块三个 varint = [跳过多少个黑格, 连续同色多少格, 颜色值]，
// 没被覆盖的格子保持黑色
function decodeRleState(encoded, total) {
    const out = new Uint32Array(total);
    const binary = atob(encoded);
    const cursor = { pos: 0 };
    let index = 0;

    while (cursor.pos < binary.length) {
        index += readVarint(binary, cursor);

        const run = readVarint(binary, cursor);
        const value = readVarint(binary, cursor);

        if (run <= 0 || index >= total) break;

        const end = Math.min(total, index + run);
        for (let i = index; i < end; i++) out[i] = value;

        index = end;
    }

    return out;
}

// --- 画布尺寸 / 设备像素比 ---
function resizeCanvas() {
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

// --- 视图控制（平移 + 缩放）---

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// 视口中心
function getViewportCenter() {
    return { x: viewport.w / 2, y: viewport.h / 2 };
}

// 最小缩放：让棋盘的长边或宽边刚好与屏幕相等（此时整块棋盘完整可见，不能更小）
function getMinScale() {
    if (!board.width || !board.height) return 1;

    const fitWidth = viewport.w / board.width;
    const fitHeight = viewport.h / board.height;

    // 棋盘本来就比屏幕小时不放大，仍然以 1 倍作为最小值
    return Math.min(1, fitWidth, fitHeight);
}

// 最大缩放：避免无限放大导致方块过大 / 渲染压力
function getMaxScale() {
    return Math.max(ZOOM_CONFIG.MAX_SCALE, getMinScale());
}

// 依据当前缩放计算平移边界：棋盘居中，超出的部分平均分配到两侧
function calculateBoundaries(scale = viewState.scale) {
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
function clampView() {
    viewState.scale = clamp(viewState.scale, getMinScale(), getMaxScale());

    const bounds = calculateBoundaries();
    viewState.translateX = clamp(viewState.translateX, bounds.minX, bounds.maxX);
    viewState.translateY = clamp(viewState.translateY, bounds.minY, bounds.maxY);
}

// 以屏幕上的某个点为锚点缩放（滚轮缩放时，光标下的内容不会跑掉）
function zoomAtPoint(targetScale, anchorX, anchorY) {
    const nextScale = clamp(targetScale, getMinScale(), getMaxScale());
    if (nextScale === viewState.scale) return;

    const center = getViewportCenter();
    // 锚点当前对应的棋盘坐标
    const localX = (anchorX - center.x - viewState.translateX) / viewState.scale;
    const localY = (anchorY - center.y - viewState.translateY) / viewState.scale;

    viewState.scale = nextScale;
    // 缩放后让同一个棋盘坐标重新落在锚点上
    viewState.translateX = anchorX - center.x - localX * nextScale;
    viewState.translateY = anchorY - center.y - localY * nextScale;

    clampView();
    markHoverDirty();
    requestRender();
}

// 恢复默认视图：100% 缩放并居中
function resetView() {
    viewState.scale = clamp(1, getMinScale(), getMaxScale());
    viewState.translateX = 0;
    viewState.translateY = 0;
    markHoverDirty();
    clampView();
    requestRender();
}

// --- 渲染 ---

let rafId = null;

// 合并同一帧内的多次重绘请求
function requestRender() {
    if (rafId === null) {
        rafId = requestAnimationFrame(frame);
    }
}

function frame(now) {
    rafId = null;

    // 先清掉已经播放完的动画：这样下一帧 paintBoard 会把方块按最终颜色补画完整，
    // 不会留下"被跳过又没人画"的空洞
    cleanupAnimations(now);

    render(now);

    // 有动画、等待服务器回包或有悬停高亮时继续保持刷新
    if (animations.size > 0 || pendingRequests.size > 0 || hoverNeedsFrame()) {
        requestRender();
    }
}

function cleanupAnimations(now) {
    if (animations.size === 0) return;
    for (const [index, anim] of animations) {
        // 还在等服务器的方块：风车一直转，不能提前结束
        if (pendingRequests.has(index)) continue;
        if (now >= anim.end) {
            animations.delete(index);
        }
    }
}

// 棋盘内部坐标 → 屏幕物理像素的比例
function screenScale() {
    return viewState.scale * viewport.dpr;
}

// 棋盘内部坐标 (0, 0) 落在哪个物理像素上
function screenOrigin() {
    const scale = screenScale();
    return {
        x: canvas.width / 2 + viewState.translateX * viewport.dpr - (board.width / 2) * scale,
        y: canvas.height / 2 + viewState.translateY * viewport.dpr - (board.height / 2) * scale
    };
}

// 网格线宽：与格子等比（保持原来的 1:26 观感），最小 1 个物理像素
function lineWidthFor(scale, pitchPx) {
    if (pitchPx < MIN_LINE_PITCH) return 0;
    return Math.max(1, Math.round(scale));
}

// 绘制棋盘。
// cam.scale  棋盘内部坐标 → 目标像素的比例
// cam.ox/oy  棋盘内部坐标 (0, 0) 在目标画布上的位置（可为小数，内部会取整）
// cam.lineW  网格线宽（物理像素）
// cam.view   只绘制该像素范围内的格子（屏幕上用，导出时省略）
// cam.skip   跳过的方块集合（正在播放翻转动画的格子）
function paintBoard(g, cam) {
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

function render(now = performance.now()) {
    if (!board.cols) return;

    const scale = screenScale();
    const origin = screenOrigin();
    const pitchPx = (board.cellSize + board.gap) * scale;
    const lineW = lineWidthFor(scale, pitchPx);

    // 背景
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 棋盘
    paintBoard(ctx, {
        scale,
        ox: origin.x,
        oy: origin.y,
        lineW,
        view: { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height },
        skip: animations.size > 0 ? animations : null
    });

    drawSwitches(now, scale, origin, lineW);
    drawHover(now, scale, origin, lineW);
}

// 切换动画：方块一半黑一半白，绕中心旋转，像风车
//   · 点击瞬间就开始转，不用等服务器
//   · 还没收到响应时一直转（不会提前停下）
//   · 收到响应后，用 SWITCH_SETTLE 的时间淡出成最终颜色
function drawSwitches(now, scale, origin, lineW) {
    if (animations.size === 0) return;

    for (const [index, anim] of animations) {
        const box = cellBox(index, scale, origin);
        const w = box.w - lineW;
        const h = box.h - lineW;
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

// 悬停高亮：缓动放大 + 阴影 + 滚动的波浪 + 轻微变色
// value 在 0（普通）与 1（完全悬停）之间按指数缓动逼近 target，
// 这样移入是渐大、移出是渐小，中途换格子也会自然过渡
function drawHover(now, scale, origin, lineW) {
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

            const box = cellBox(index, scale, origin);
            const w = box.w - lineW;
            const h = box.h - lineW;
            if (w <= 0 || h <= 0) continue;

            drawHoverCell(now, index, box.x, box.y, w, h, state.value);
        }
    }
}

// 单个悬停方块：放大 + 阴影 + 轻微变色 + 一条沿左上→右下滚动的波浪
function drawHoverCell(now, index, x, y, w, h, value) {
    const cellValue = gridState[index];
    // 深色块提亮、浅色块压暗：自定义颜色按亮度判断
    const isDark = valueIsDark(cellValue);

    const gw = Math.max(1, Math.round(w * (1 + HOVER_SCALE * value)));
    const gh = Math.max(1, Math.round(h * (1 + HOVER_SCALE * value)));
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

    ctx.restore();
}

// 是否还需要继续刷新：有缓动没走完，或者还有方块处于悬停（波浪一直在滚）
function hoverNeedsFrame() {
    for (const state of hoverStates.values()) {
        if (state.value !== state.target || state.value > 0) return true;
    }
    return false;
}

// 改变某个格子的悬停目标（1 = 放大，0 = 收起）
function setHoverTarget(state, target) {
    if (state.target === target) return;
    state.target = target;
    // 从改变的那一刻重新计时，避免长时间静止后第一帧跳变
    state.last = performance.now();
}

// --- 命中测试：屏幕坐标 → 方块下标（CSS px）---
function hitTest(clientX, clientY) {
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

// --- 点击方块 ---
function onCanvasClick(e) {
    // 点在 UI 面板 / 画笔圆环上时不触发方块
    if (e.target.closest('.glass-panel, #brush-ring')) return;
    if (viewState.hasMoved) return;

    const index = hitTest(e.clientX, e.clientY);
    if (index < 0 || pendingRequests.has(index)) return;

    // 老服务端存不了自定义颜色，点了也不会生效
    if (isCustomBrush() && !serverSupportsRgb) return;

    const now = performance.now();
    const current = gridState[index];

    // 和画笔同色 → 擦成黑色；否则涂成画笔颜色（服务端用同样的规则）
    let target;
    let payload;
    if (isCustomBrush()) {
        // 服务端不认识客户端的预设调色板，所以自定义颜色只和"完全相同的自定义颜色"比较
        const brushValue = customValue(brushRgb);
        target = current === brushValue ? BLACK_VALUE : brushValue;
        payload = { index: index, rgb: brushRgb };
    } else {
        target = current === brushIndex ? BLACK_VALUE : brushIndex;
        payload = { index: index, brush: brushIndex };
    }

    // 立刻开始风车动画，不等服务器；颜色先按本地预测，回包后再纠正
    startSwitch(index, current, target, now, now + SWITCH_DURATION);

    pendingRequests.add(index);
    // 超时保护：服务器长时间不回包时，收回风车、保持原来的颜色
    pendingTimers.set(index, setTimeout(() => {
        clearPending(index);
        animations.delete(index);
        requestRender();
    }, PENDING_TIMEOUT));

    requestRender();

    socket.emit(serverSupportsColor ? 'paint-square' : 'toggle-square',
        serverSupportsColor ? payload : index);
}

// 启动一次切换动画（风车）
// from/to 动画前后的颜色值
// start   动画开始时间
// end     计划结束时间；如果此时还在等服务器，风车会继续转，不会被提前结束
function startSwitch(index, from, to, start, end) {
    const prev = animations.get(index);
    // 接着上一次的角度继续转，避免连续点击时风车"跳一下"
    const angle0 = prev
        ? (SWITCH_SPIN_RATE * (start - prev.start) * Math.PI * 2) % (Math.PI * 2)
        : 0;

    animations.set(index, { from, to, start, end, angle0 });
    requestRender();
}

// 服务器超时/回包后清除等待状态
function clearPending(index) {
    const timer = pendingTimers.get(index);
    if (timer) {
        clearTimeout(timer);
        pendingTimers.delete(index);
    }
    pendingRequests.delete(index);
}

// --- 拖拽平移 ---
function onPointerDown(e) {
    if (e.target.closest('#settings-button') || e.target.closest('#options-panel') ||
        e.target.closest('#brush-ring') || e.target.closest('#color-picker')) {
        viewState.panning = false;
        return;
    }

    if (e.type === 'mousedown' && e.button !== 0) return;

    viewState.panning = true;
    viewState.hasMoved = false;

    const point = getPoint(e);
    viewState.startX = point.x - viewState.translateX;
    viewState.startY = point.y - viewState.translateY;

    viewState.clickStartX = point.x;
    viewState.clickStartY = point.y;
}

function onPointerMove(e) {
    if (!viewState.panning) {
        // 未拖动时更新悬停高亮（移到面板上则收起）
        if (hoverSupported) {
            updateHover(e.target === canvas ? hitTest(e.clientX, e.clientY) : -1);
        }
        return;
    }
    e.preventDefault();

    const point = getPoint(e);
    viewState.translateX = point.x - viewState.startX;
    viewState.translateY = point.y - viewState.startY;

    // 实时获取边界并应用（边界随缩放变化）
    const bounds = calculateBoundaries();
    viewState.translateX = clamp(viewState.translateX, bounds.minX, bounds.maxX);
    viewState.translateY = clamp(viewState.translateY, bounds.minY, bounds.maxY);

    // 移动阈值判断
    if (Math.abs(point.x - viewState.clickStartX) > 5 ||
        Math.abs(point.y - viewState.clickStartY) > 5) {
        viewState.hasMoved = true;
    }

    markHoverDirty();
    requestRender();
}

function onPointerUp() {
    viewState.panning = false;
}

function getPoint(e) {
    if (e.touches) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
}

// 拖动 / 缩放后原来的悬停位置可能已经不对了，让它淡出收起
function markHoverDirty() {
    viewState.hoverIndex = -1;
    for (const state of hoverStates.values()) {
        setHoverTarget(state, 0);
    }
}

function updateHover(index) {
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

    requestRender();
}

// --- 触屏：单指平移，双指缩放 ---
function getTouchMidpoint(e) {
    const a = e.touches[0], b = e.touches[1];
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

function getTouchDistance(e) {
    const a = e.touches[0], b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

// 以双指中点为锚点开始缩放
function startPinch(e) {
    const center = getViewportCenter();
    const mid = getTouchMidpoint(e);

    pinchState = {
        startDistance: Math.max(1, getTouchDistance(e)),
        startScale: viewState.scale,
        // 双指中点对应的棋盘坐标，缩放过程中保持这一点不动
        localX: (mid.x - center.x - viewState.translateX) / viewState.scale,
        localY: (mid.y - center.y - viewState.translateY) / viewState.scale
    };

    viewState.panning = false;
    viewState.hasMoved = true; // 双指操作结束后不要误触方块
    markHoverDirty();
}

// 双指变单指时，用剩下的手指继续平移
function resumePanWithTouch(e) {
    pinchState = null;

    const point = getPoint(e);
    viewState.panning = true;
    viewState.startX = point.x - viewState.translateX;
    viewState.startY = point.y - viewState.translateY;
    viewState.clickStartX = point.x;
    viewState.clickStartY = point.y;
    viewState.hasMoved = true;
}

function onTouchStart(e) {
    if (e.touches.length >= 2) {
        e.preventDefault();
        startPinch(e);
        return;
    }

    onPointerDown(e);
}

function onTouchMove(e) {
    if (e.touches.length >= 2) {
        e.preventDefault();
        if (!pinchState) startPinch(e);

        const center = getViewportCenter();
        const mid = getTouchMidpoint(e);
        const distance = Math.max(1, getTouchDistance(e));

        // 缩放比例由双指间距变化决定，并限制在最小 / 最大范围内
        const nextScale = clamp(
            pinchState.startScale * (distance / pinchState.startDistance),
            getMinScale(),
            getMaxScale()
        );

        viewState.scale = nextScale;
        // 双指中点移动时同时完成平移，缩放中心跟随手指
        viewState.translateX = mid.x - center.x - pinchState.localX * nextScale;
        viewState.translateY = mid.y - center.y - pinchState.localY * nextScale;

        clampView();
        markHoverDirty();
        requestRender();
        return;
    }

    if (pinchState) {
        resumePanWithTouch(e);
        return;
    }

    onPointerMove(e);
}

function onTouchEnd(e) {
    if (e.touches.length >= 2) return;

    if (e.touches.length === 1) {
        // 抬起一根手指后，用剩下这根手指继续平移，避免视图跳变
        resumePanWithTouch(e);
        return;
    }

    pinchState = null;
    onPointerUp();
}

// --- 滚轮缩放（桌面端鼠标 / 触控板） ---
function onWheel(e) {
    e.preventDefault();

    // 统一不同 deltaMode 的滚动量（像素 / 行 / 页）
    let delta = e.deltaY;
    if (e.deltaMode === 1) {
        delta *= 16;
    } else if (e.deltaMode === 2) {
        delta *= window.innerHeight;
    }

    // 指数缩放：每一次滚动的视觉变化量一致
    const factor = Math.exp(-delta * ZOOM_CONFIG.WHEEL_SENSITIVITY);
    zoomAtPoint(viewState.scale * factor, e.clientX, e.clientY);
}

const container = document.body;
container.addEventListener('mousedown', onPointerDown);
container.addEventListener('touchstart', onTouchStart, { passive: false });
container.addEventListener('mousemove', onPointerMove);
container.addEventListener('touchmove', onTouchMove, { passive: false });
container.addEventListener('mouseup', onPointerUp);
container.addEventListener('touchend', onTouchEnd);
container.addEventListener('touchcancel', onTouchEnd);
container.addEventListener('wheel', onWheel, { passive: false });
container.addEventListener('click', onCanvasClick);
container.addEventListener('contextmenu', onContextMenu);
container.addEventListener('mouseleave', () => {
    onPointerUp();
    updateHover(-1);
});

// 阻止 Safari 的双指手势缩放页面
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

// 窗口大小变化时，重新校验缩放与位置，防止留在无效区域
window.addEventListener('resize', () => {
    resizeCanvas();
    clampView();
    markHoverDirty();
    requestRender();
});

// 设备像素比变化（例如窗口被拖到另一块屏幕）时重建画布
function watchDevicePixelRatio() {
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
        media.removeEventListener('change', onChange);
        resizeCanvas();
        clampView();
        requestRender();
        watchDevicePixelRatio();
    };
    media.addEventListener('change', onChange);
}

// --- 图片保存功能 ---
// 导出的是离屏画布，与屏幕上的 UI 无关，所以不需要隐藏面板
function saveAsImage() {
    try {
        if (!board.cols) throw new Error('board not ready');

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
    toggleOptionsPanel();
}

// --- 启动 ---
loadBrush();
buildBrushRing();
highlightActiveSwatch();
updateBrushCursor();
resizeCanvas();
watchDevicePixelRatio();
requestRender();
