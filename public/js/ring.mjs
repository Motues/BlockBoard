// 画笔颜色圆环（右键短按呼出）：预设色块、圆心彩虹圆、设置面板入口。

import { BRUSH_PRESETS } from './config.mjs';
import { onLangChange, t } from './i18n.mjs';
import {
    commitRecentColor,
    getBrushColor,
    getBrushIndex,
    isCustomBrush,
    onBrushChange,
    setBrushIndex
} from './brush.mjs';
import { closeColorPicker, openColorPicker } from './picker.mjs';
import {
    brushRingEl,
    clamp,
    menuButton,
    optionsPanel,
    touchDevice,
    viewport
} from './shared.mjs';

const PANEL_TRANSITION_MS = 300; // 与 styles.css 里 #options-panel 的过渡时长一致

let ringOpen = false;
let panelOpen = false;
const swatches = [];

export function isBrushRingOpen() {
    return ringOpen;
}

// 按预设生成圆环上的色块
export function buildBrushRing() {
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
        swatch.title = t(preset.nameKey);
        swatch.style.background = preset.color;
        swatch.addEventListener('click', () => {
            // 用户主动选中预设色：记进"最近使用"
            setBrushIndex(i + 1);
            commitRecentColor();
            closeBrushRing();
        });

        slot.appendChild(swatch);
        brushRingEl.appendChild(slot);
        swatches.push(swatch);
    });

    // 圆心的彩虹圆：点击打开调色盘
    document.getElementById('brush-ring-center').addEventListener('click', () => {
        closeBrushRing();
        openColorPicker();
    });

    refreshRingActive();
}

// 色块提示是动态写入的，换语言要重新刷一遍
function refreshRingTitles() {
    for (const swatch of swatches) {
        const preset = BRUSH_PRESETS[Number(swatch.dataset.index) - 1];
        if (preset) swatch.title = t(preset.nameKey);
    }
}

// 画笔变化后刷新高亮（预设块 + 圆心外圈）
export function refreshRingActive() {
    for (const swatch of swatches) {
        const active = !isCustomBrush() && Number(swatch.dataset.index) === getBrushIndex();
        swatch.classList.toggle('active', active);
    }

    // 圆心：中间的小圆固定是彩虹，外圈显示当前自定义颜色，没选时透明
    const center = document.getElementById('brush-ring-center');
    if (!center) return;

    center.classList.toggle('active', isCustomBrush());
    center.style.background = isCustomBrush() ? getBrushColor() : 'transparent';
}

export function openBrushRing(clientX, clientY) {
    // 圆环和调色盘不会同时显示
    closeColorPicker();

    // 贴着屏幕边缘时把圆环收回来，避免被裁掉
    const margin = brushRingEl.offsetWidth / 2 + 8;
    const x = clamp(clientX, margin, Math.max(margin, viewport.w - margin));
    const y = clamp(clientY, margin, Math.max(margin, viewport.h - margin));

    brushRingEl.style.left = x + 'px';
    brushRingEl.style.top = y + 'px';
    brushRingEl.classList.add('open');
    ringOpen = true;

    refreshRingActive();
}

// 返回是否真的收起了（用来判断这次点击要不要被吞掉）
export function closeBrushRing() {
    if (!ringOpen) return false;

    ringOpen = false;
    brushRingEl.classList.remove('open');
    return true;
}

// 从设置面板里打开（给没有右键的触摸设备用）
export function openBrushRingFromPanel() {
    const rect = optionsPanel.getBoundingClientRect();
    openBrushRing(rect.left - 130, rect.top + rect.height / 2);
}

// --- 设置面板 ---
export function toggleOptionsPanel() {
    panelOpen = !panelOpen;

    if (panelOpen) {
        // 1. 确保元素立即可见，并取消 pointer-events: none;
        optionsPanel.style.visibility = 'visible';

        // 2. 移除 hidden 类触发 opacity 和 transform 渐变
        optionsPanel.classList.remove('hidden');
    } else {
        // 1. 添加 hidden 类触发 opacity 和 transform 渐变
        optionsPanel.classList.add('hidden');

        // 2. 渐变持续时间后，再彻底移除元素的可见性 (完成渐变)
        setTimeout(() => {
            if (!panelOpen) {
                optionsPanel.style.visibility = 'hidden';
            }
        }, PANEL_TRANSITION_MS);
    }

    // 3. 切换按钮图标：只改 class，「...」与「X」交给 CSS 做交叉淡入淡出 + 旋转，
    //    不再用 display 硬切（硬切会跳一帧，看起来不丝滑）
    menuButton.classList.toggle('open', panelOpen);
    menuButton.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
}

// 关闭选项面板。返回"这次是不是真的收掉了"：Esc 靠它决定还要不要继续往下收
export function closeOptionsPanel() {
    if (!panelOpen) return false;

    toggleOptionsPanel();
    return true;
}

// 提示弹窗
export function showHintPopup() {
    const hintPopup = document.getElementById('hint-popup');

    // 触屏和桌面端的操作完全不同，文案分两份，只显示当前设备那一份
    hintPopup.classList.toggle('touch', touchDevice);
    hintPopup.classList.remove('hidden');

    // 10 秒后自动隐藏
    setTimeout(() => {
        hintPopup.classList.add('hidden');
    }, 10000);
}

// 收起帮助弹窗。返回"这次是不是真的收掉了"（Esc 用）
export function closeHintPopup() {
    const hintPopup = document.getElementById('hint-popup');

    if (hintPopup.classList.contains('hidden')) return false;

    hintPopup.classList.add('hidden');
    return true;
}

// 画笔变化后刷新圆环状态（悬停光标由 brush.mjs 统一负责）
onBrushChange(refreshRingActive);

// 换语言后刷新色块提示
onLangChange(refreshRingTitles);
