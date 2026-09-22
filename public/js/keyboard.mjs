// 键盘快捷键（桌面端为主；触屏没有键盘，这些分支自然用不到）：
//   · Esc —— 从最上面那层开始一层层收：取色模式 → 调色盘 → 画笔圆环 → 选项面板 →
//             开发者工具那层（登录框 / 导入面板 / 右键菜单 / 选区）→ 帮助弹窗
//   · C   —— 打开调色盘（居中弹出）
//   · I   —— 吸管取色器：进 / 出
//   · 1–8 —— 直接切到第 N 个预设色（和画笔圆环上的色块编号一一对应）
//
// 两条纪律：
//   1. 在输入框里打字（色号、开发者密码、设置里的密码）时不抢键，带 Ctrl / Cmd / Alt
//      的组合也不碰；
//   2. 清理开发者工具那层不 import devtools，而是往 shared.mjs 的 devEvents 上转发
//      'dismiss'，由 devtools 自己按"最上面那层"收 —— 和 leftdown / contextmenu 同一套。

import { BRUSH_PRESETS } from './config.mjs';
import { commitRecentColor, setBrushIndex } from './brush.mjs';
import {
    closeColorPicker,
    isColorPickerOpen,
    openColorPicker,
    startPicking,
    stopPicking
} from './picker.mjs';
import {
    closeBrushRing,
    closeHintPopup,
    closeOptionsPanel
} from './ring.mjs';
import { emitDevEvent, isPickMode, viewport } from './shared.mjs';

// 正在输入框 / 可编辑区域里打字吗？（打字时的字母数字都属于用户，不属于快捷键）
function isTypingTarget(target) {
    if (!target || !target.tagName) return false;

    const tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

// 前面挡着浮层吗（设置弹窗 / 开发者登录框 / 导入 JSON 面板）？
// 有浮层时只让 Esc 干活：在弹窗里按 C 不该再弹出一个调色盘
function hasOverlayOpen() {
    return ['#settings-modal', '#dev-login', '#dev-import'].some((selector) => {
        const el = document.querySelector(selector);
        return Boolean(el) && !el.classList.contains('hidden');
    });
}

function onKeyDown(e) {
    // Ctrl / Cmd / Alt 组合留给浏览器（复制、粘贴、刷新…）
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') {
        // 一层一层收：上面这些弹层 / 模式收掉了就不再往下传
        if (isPickMode()) {
            stopPicking();
            return;
        }

        if (isColorPickerOpen()) {
            closeColorPicker();
            return;
        }

        if (closeBrushRing()) return;
        if (closeOptionsPanel()) return;

        // 开发者工具那层比帮助弹窗更靠上（登录框 / 导入面板 / 右键菜单 / 选区高亮），
        // 先把这次 Esc 转给它，它没收掉任何东西时再由下面收帮助弹窗
        emitDevEvent('dismiss', {});
        closeHintPopup();
        return;
    }

    if (isTypingTarget(e.target) || hasOverlayOpen()) return;

    // C：调色盘。没给锚点时它会按画笔圆环的位置定位，而圆环可能还没出现过，所以显式居中
    if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        openColorPicker({ x: viewport.w / 2, y: viewport.h / 2, center: true });
        return;
    }

    // I：吸管取色器
    if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();

        if (isPickMode()) stopPicking();
        else startPicking();
        return;
    }

    // 1..8：直接切预设色（预设一共 BRUSH_PRESETS.length 个，超出的键不管）
    if (/^[1-9]$/.test(e.key)) {
        const index = Number(e.key);
        if (index > BRUSH_PRESETS.length) return;

        e.preventDefault();
        setBrushIndex(index);
        // 和点圆环上的色块一样：主动选中的颜色要记进"最近使用"
        commitRecentColor();
    }
}

export function bindKeyboardShortcuts() {
    document.addEventListener('keydown', onKeyDown);
}
