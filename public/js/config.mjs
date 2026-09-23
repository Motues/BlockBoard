// 全部常量与「客户端本地调色板」。
// 这里只放不随运行状态变化的东西，方便调手感时集中改。

// --- 棋盘布局（棋盘内部坐标，单位 px；与服务端下发的 cellSize 搭配）---
export const GAP_SIZE = 1;      // 格子之间的缝隙
export const PADDING_SIZE = 1;  // 棋盘四周留白

// --- 缩放 ---
export const ZOOM_CONFIG = {
    // 最大缩放倍数（相对 1 倍原始大小），例如 8 表示最大放大到 800%
    MAX_SCALE: 8,
    // 滚轮灵敏度，数值越大缩放越快
    WHEEL_SENSITIVITY: 0.0015,
    // 缩放平滑的时间常数(ms)：每一帧把当前值朝目标值推进 (1 - e^(-dt/tau))。
    // 越大越"飘"，越小越跟手；120 大约是滚一格 ~150ms 收住、快速连滚能叠成一段连续运动。
    // 与 HOVER_TAU 同一套指数缓动（见 board.mjs 的悬停放大），因此与帧率无关
    SMOOTH_TAU: 120
};

// --- 方块切换动画（风车）---
// 动画在"点击瞬间"就开始，所以这是最短时长：
//   · 服务器很快 → 动画在 SWITCH_DURATION 内转完并淡出成最终颜色
//   · 服务器很慢 → 风车一直转，直到响应到达后再用 SWITCH_SETTLE 收尾
// 也就是「响应时间 + 动画时间 ≥ SWITCH_DURATION」始终成立
export const SWITCH_DURATION = 380;
export const SWITCH_SETTLE = 90;        // 收到响应后，从风车淡出为最终颜色的收尾时长(ms)
export const SWITCH_SPIN_PERIOD = 400;  // 风车转一整圈需要的时间(ms)
export const SWITCH_SPIN_RATE = 1 / SWITCH_SPIN_PERIOD; // 圈/ms
export const PENDING_TIMEOUT = 8000;    // 等待服务器回包的超时保护(ms)

// --- 渲染 ---
export const EXPORT_SCALE = 2;   // 导出图片相对棋盘的分辨率倍数
export const MIN_LINE_PITCH = 6; // 格子间距小于该物理像素数时不画网格线

// --- 悬停高亮 ---
export const HOVER_SCALE = 0.1;           // 悬停时方块放大的比例（1.1 倍）
export const HOVER_TAU = 70;              // 悬停缩放的缓动时间常数(ms)，越大越柔和
export const HOVER_TINT = 0.1;            // 悬停方块相较周围像素的明暗偏移（黑块提亮 / 白块压暗）
export const HOVER_WAVE_PERIOD = 1200;    // 波浪从左上角滚到右下角的周期(ms)
export const HOVER_WAVE_AMPLITUDE = 0.22; // 波浪明暗的最大强度
export const PICK_HOVER_SCALE = 0.2;      // 取色模式下悬停方块的放大比例（1.2 倍，比普通悬停更明显）

// --- 桌面端右键：短按呼出画笔圆环，长按（或按下后拖动）拖动棋盘 ---
export const RIGHT_BUTTON = 2;          // MouseEvent.button 里的右键
export const RIGHT_LONGPRESS_MS = 220;  // 按住超过这个时间就算长按（进入拖动）
export const RIGHT_DRAG_SLOP = 6;       // 按下后移动超过这个像素数也立即算拖动，不必等满长按时间

// --- 触屏：长按呼出画笔圆环，轻点切换方块状态，拖动平移 ---
// 比右键的 220ms 长一些：手指比鼠标抖，太短会把"轻点"误判成长按
export const TOUCH_LONGPRESS_MS = 420;
export const TOUCH_DRAG_SLOP = 8;       // 移动超过这个像素数就判定为拖动（平移），不再当作轻点

// --- 颜色（与 styles.css 中的 CSS 变量保持一致）---
function readColorVar(style, name, fallback) {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
}

const rootStyle = getComputedStyle(document.documentElement);

export const COLORS = {
    bg: readColorVar(rootStyle, '--bg-color', '#222222'),
    gap: readColorVar(rootStyle, '--grid-gap-color', '#444444'),
    black: readColorVar(rootStyle, '--cell-black', '#070707'),
    white: readColorVar(rootStyle, '--cell-white', '#eeeeee')
};

// --- 画笔预设颜色（右键圆环里的色块）---
// 预设颜色编号与服务端的单元格取值一一对应：0 = 黑，1..N = 下面的预设颜色
// 预设都是低饱和度（灰调）的颜色，1 号与默认的"白块"一致
// 圆心的彩虹圆另外支持任意 24bit RGB 自定义颜色
// nameKey 是 i18n.mjs 里的名字键（中文 / English 各一份），由 ring.mjs 取出来当色块提示
// 1 号颜色直接取 CSS 变量 --cell-white，改主题色时不用改两处
export const BRUSH_PRESETS = [
    { color: COLORS.white, nameKey: 'preset.offWhite' },
    { color: '#cbb9a3', nameKey: 'preset.beige' },
    { color: '#c79a83', nameKey: 'preset.terracotta' },
    { color: '#b6bb92', nameKey: 'preset.olive' },
    { color: '#9dba9c', nameKey: 'preset.sage' },
    { color: '#9bb8bd', nameKey: 'preset.teal' },
    { color: '#a6a8c0', nameKey: 'preset.lavender' },
    { color: '#c4a5ae', nameKey: 'preset.dustyRose' }
];

// --- localStorage 键名 ---
export const BRUSH_STORAGE_KEY = 'blockboard-brush-color';
// 最近使用的颜色：存 #rrggbb 的 JSON 数组，最新在前
export const RECENT_STORAGE_KEY = 'blockboard-recent-colors';
export const RECENT_MAX = 10;

// --- 单元格取值（与 src/state.ts 保持一致）---
//   0x000000           → 黑色
//   0x000001..0x00000F → 预设颜色编号（对应 VALUE_COLORS）
//   >= 0x000010        → 自定义颜色，值本身就是 24bit RGB
// 预设编号占掉了 0x00..0x0F，自定义颜色落到这一段（#000000..#00000F，肉眼都是纯黑）
// 会被抬到 0x000010 再存
export const BLACK_VALUE = 0;
export const PRESET_MAX = 15;
export const RGB_MIN = PRESET_MAX + 1;
export const RGB_MASK = 0x00ffffff;
/** 稠密状态 / 本地缓存里每格占的字节数（24bit） */
export const CELL_BYTES = 3;
