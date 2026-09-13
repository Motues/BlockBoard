// 与服务端的连接：处理 init-game / update-square / update-squares / update-region /
// paint-rejected / online-users，并绑定与画布无关的全局 UI 事件
// （设置面板、提示弹窗、Esc、点空白处关面板）。

import { SWITCH_DURATION, SWITCH_SETTLE } from './config.mjs';
import { setBrushIndex } from './brush.mjs';
import { customValue } from './color.mjs';
import { getGridState, initBoard, applyRegionPayload } from './board.mjs';
import { resetView, resizeCanvas } from './camera.mjs';
import { bindCanvasEvents } from './interactions.mjs';
import { closeColorPicker, isColorPickerOpen, stopPicking } from './picker.mjs';
import { closeBrushRing, showHintPopup, toggleOptionsPanel } from './ring.mjs';
import {
    animations,
    clearPending,
    consumePickJustHandled,
    isPickMode,
    menuButton,
    requestRender,
    serverCaps,
    socket,
    startSwitch,
    canvas
} from './shared.mjs';

// 新服务端会在 init-game 里带上 maxColorIndex，据此判断能否用颜色协议；
// 带上 rgbSupport / state32 就说明它支持自定义 24bit 颜色
export function initConnection() {
    socket.on('init-game', (data) => {
        const { config, maxColorIndex, rgbSupport, stateRgb, state32 } = data;
        serverCaps.color = typeof maxColorIndex === 'number';
        // 状态可能是 stateRgb（新服务端，base64 字符串或二进制附件）或 state32（上一版服务端），
        // 都在说明它支持自定义颜色
        serverCaps.rgb = rgbSupport === true ||
            (stateRgb !== undefined && stateRgb !== null) ||
            typeof state32 === 'string';

        // 老服务端存不了自定义颜色：禁用圆心，并把自定义画笔退回预设色
        document.getElementById('brush-ring-center').classList.toggle('unsupported', !serverCaps.rgb);
        if (!serverCaps.rgb) {
            setBrushIndex(1);
        }

        initBoard(config, data, { resizeCanvas, resetView });
    });

    // 收到服务器广播：方块的颜色值确定
    socket.on('update-square', ({ index, value, isBlack, rgb }) => {
        applySquareUpdate(index, value, isBlack, rgb);
    });

    // 合并广播：一个 16ms 窗口内的多条单格改动。
    // value 是 24bit 取值本身（0 = 黑，1..15 = 预设编号，>= 16 = 自定义色），
    // 认识 rgb24 的客户端都认识它，所以不用再带兼容字段
    socket.on('update-squares', ({ cells }) => {
        if (!Array.isArray(cells)) return;

        for (const entry of cells) {
            if (!Array.isArray(entry)) continue;
            applySquareUpdate(Number(entry[0]), entry[1], undefined, undefined);
        }
    });

    // 服务端把这次点击挡掉了（令牌桶满了）：把乐观动画收回去，
    // 否则要等 PENDING_TIMEOUT（8 秒）才恢复
    socket.on('paint-rejected', ({ index }) => {
        clearPending(index);
        animations.delete(index);
        requestRender();
    });

    socket.on('online-users', (count) => {
        document.getElementById('onlineCount').textContent = count;
    });

    // 开发者工具的批量改色广播：服务端只发变化的部分
    socket.on('update-region', (payload) => {
        applyRegionPayload(payload);
    });
}

// 落地一条单格改动（单格广播与合并广播共用）
function applySquareUpdate(index, value, isBlack, rgb) {
    const gridState = getGridState();
    const cellIndex = Number(index);
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= gridState.length) return;

    // rgb 是自定义 24bit 颜色；value / isBlack 用于新老服务端的兼容
    const target = typeof rgb === 'number'
        ? customValue(rgb)
        : typeof value === 'number'
            ? value
            : (isBlack ? 0 : 1);

    const now = performance.now();

    // 响应到了，解除等待（风车不再"无限转"）
    clearPending(cellIndex);

    const anim = animations.get(cellIndex);
    if (anim) {
        // 自己点击时启动的动画：补上权威颜色，并留出收尾淡出的时间。
        // 服务器慢的时候 end 早已过去，这里会顺势延长到"响应后再收尾"
        anim.to = target;
        anim.end = Math.max(anim.end, now + SWITCH_SETTLE);
    } else if (gridState[cellIndex] !== target) {
        // 别人切换的方块：自己也播一遍同样的风车动画
        startSwitch(cellIndex, gridState[cellIndex], target, now, now + SWITCH_DURATION);
    }

    gridState[cellIndex] = target;
    requestRender();
}

// --- 界面事件（与画布交互无关的部分）---
export function bindUiEvents() {
    bindCanvasEvents();

    // 页面加载后延迟 1 秒显示提示弹窗（showHintPopup 内部会在 10 秒后自动收起）
    setTimeout(showHintPopup, 1000);

    // 设置面板
    menuButton.addEventListener('click', toggleOptionsPanel);

    // Esc：先退出取色模式，再依次收起调色盘与圆环
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;

        if (isPickMode()) {
            stopPicking();
            return;
        }

        closeColorPicker();
        closeBrushRing();
    });

    // 点空白处收起面板；取色模式下的那次点击已经被画布交互处理过了，不重复处理
    document.addEventListener('click', (e) => {
        if (consumePickJustHandled()) return;

        const inRing = e.target.closest && e.target.closest('#brush-ring');
        const inPicker = e.target.closest && e.target.closest('#color-picker');

        // 调色盘：点外面就收起来（选中的颜色会保留）
        if (isColorPickerOpen() && !inPicker && !inRing) {
            closeColorPicker();
        }

        if (!closeBrushRing()) return;

        // 只有点在棋盘上时才吞掉这次点击；点面板按钮的话照常执行按钮功能
        if (e.target === canvas) {
            e.stopPropagation();
        }
    }, true);
}
