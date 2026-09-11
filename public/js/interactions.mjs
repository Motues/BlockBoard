// 画布上的交互：点击涂色 / 擦除、左键拖动平移、右键短按呼出圆环与长按拖动、
// 触屏单指平移与双指缩放、滚轮缩放、取色模式的点击取色。

import {
    PENDING_TIMEOUT,
    RIGHT_BUTTON,
    RIGHT_DRAG_SLOP,
    RIGHT_LONGPRESS_MS,
    SWITCH_DURATION,
    ZOOM_CONFIG
} from './config.mjs';
import {
    applyBrushFromRgb,
    getBrushIndex,
    getBrushRgb,
    isCustomBrush,
    rememberColor
} from './brush.mjs';
import { customValue, isCustomValue, rgbToHex, valueRgb } from './color.mjs';
import { getGridState, hitTest, updateHover } from './board.mjs';
import {
    calculateBoundaries,
    clampView,
    getMaxScale,
    getMinScale,
    resizeCanvas,
    zoomAtPoint
} from './camera.mjs';
import { hidePickTooltip, showPickTooltip, stopPicking } from './picker.mjs';
import { closeBrushRing, openBrushRing } from './ring.mjs';
import {
    animations,
    board,
    canvas,
    clamp,
    clearPending,
    emitDevEvent,
    getPoint,
    hoverSupported,
    isDevMode,
    isPickMode,
    markHoverDirty,
    markPickJustHandled,
    pendingRequests,
    pendingTimers,
    requestRender,
    serverCaps,
    setPinchState,
    socket,
    startSwitch,
    viewport,
    viewState
} from './shared.mjs';

// 右键按下中（还没变成拖动）
let rightPress = null;
let rightPanning = false;            // 这一次右键是否已经变成拖动
let suppressNextContextMenu = false; // 这次右键已经变成拖动，松开时的 contextmenu 要吞掉

// 双指缩放状态（触摸屏）；同时写回 shared，方便其它模块读取
let pinch = null;
function updatePinchState(value) {
    pinch = value;
    setPinchState(value);
}

// --- 悬停 ---
function onHoverMove(e) {
    if (!hoverSupported) return;

    const index = e.target === canvas ? hitTest(e.clientX, e.clientY) : -1;

    updateHover(index);
    if (isPickMode()) {
        if (index < 0) hidePickTooltip();
        else showPickTooltip(valueRgb(getGridState()[index]), e.clientX, e.clientY);
    }
}

// --- 点击方块 ---
function onCanvasClick(e) {
    // 点在 UI 面板 / 画笔圆环上时不触发方块
    if (e.target.closest('.glass-panel, #brush-ring')) return;

    // 开发者模式：左键交给 devtools（长按框选 / 短按弹方块菜单），不再直接上色
    if (isDevMode()) return;

    // 取色模式：点哪个方块就取哪个方块的颜色（拖动过视图不算）
    if (isPickMode()) {
        if (viewState.hasMoved) return;

        const index = hitTest(e.clientX, e.clientY);
        if (index < 0) return;

        markPickJustHandled();
        pickCellAt(index);
        return;
    }

    if (viewState.hasMoved) return;

    const index = hitTest(e.clientX, e.clientY);
    if (index < 0 || pendingRequests.has(index)) return;

    // 老服务端存不了自定义颜色，点了也不会生效
    if (isCustomBrush() && !serverCaps.rgb) return;

    const now = performance.now();
    const current = getGridState()[index];

    // 和画笔同色 -> 擦成黑色；否则涂成画笔颜色（服务端用同样的规则）
    let target;
    let payload;
    if (isCustomBrush()) {
        // 服务端不认识客户端的预设调色板，所以自定义颜色只和"完全相同的自定义颜色"比较
        const brushValue = customValue(getBrushRgb());
        target = current === brushValue ? 0 : brushValue;
        payload = { index: index, rgb: getBrushRgb() };
    } else {
        const brushIndex = getBrushIndex();
        target = current === brushIndex ? 0 : brushIndex;
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

    socket.emit(serverCaps.color ? 'paint-square' : 'toggle-square',
        serverCaps.color ? payload : index);
}

// 取色：把方块颜色设为画笔颜色，然后退出取色模式
function pickCellAt(index) {
    const picked = getGridState()[index];
    const rgb = valueRgb(picked);

    // 老服务端存不了自定义颜色：取到的自定义色先提示一下，仍然退出取色模式
    if (isCustomValue(picked) && !serverCaps.rgb) {
        console.warn('This server does not support custom colors');
    }
    // 预设色走预设编号，自定义色走 24bit 自定义通道
    else {
        applyBrushFromRgb(rgb);
        rememberColor(rgbToHex(rgb));
    }

    stopPicking();
}

// --- 拖拽平移 ---
// 左键：只用来点方块（开发者模式下是框选 / 弹菜单），不参与平移 —— 平移靠右键长按拖动、
//      触屏单指拖动和滚轮缩放
function onPointerDown(e) {
    // 点在这些 UI 上时不参与画布交互（底部按钮条 / 各弹窗与面板）
    if (e.target.closest('#bottom-ui') || e.target.closest('#options-panel') ||
        e.target.closest('#brush-ring') || e.target.closest('#color-picker') ||
        e.target.closest('#dev-menu') || e.target.closest('#dev-login') ||
        e.target.closest('#settings-modal') || e.target.closest('#dev-banner') ||
        e.target.closest('#dev-toast') || e.target.closest('#hint-popup')) {
        viewState.panning = false;
        return;
    }

    // 开发者模式：左键长按框选 / 短按打开方块菜单（转发给 devtools.mjs）
    if (isDevMode() && e.type === 'mousedown' && e.button === 0) {
        e.preventDefault();
        emitDevEvent('leftdown', { event: e, col: hitColumn(e), row: hitRow(e) });
        return;
    }

    // 桌面端右键：按下时先按兵不动，等它表明是"长按/拖动"还是"短按"
    if (e.type === 'mousedown' && e.button === RIGHT_BUTTON) {
        e.preventDefault();

        // 圆环开着的时候拖页面，圆环会留在原地，先收起
        closeBrushRing();

        const point = getPoint(e);
        rightPress = {
            x: point.x,
            y: point.y,
            timer: setTimeout(() => {
                rightPress = null;
                beginRightPan(point.x, point.y);
            }, RIGHT_LONGPRESS_MS)
        };
        return;
    }

    if (e.type === 'mousedown' && e.button !== 0) return;

    // 触屏单指平移：鼠标左键不再拖动视图
    if (e.type === 'mousedown') return;

    viewState.panning = true;
    viewState.hasMoved = false;

    const point = getPoint(e);
    viewState.startX = point.x - viewState.translateX;
    viewState.startY = point.y - viewState.translateY;

    viewState.clickStartX = point.x;
    viewState.clickStartY = point.y;
}

// 命中的方块坐标（开发者模式用；未命中返回 -1）
function hitColumn(e) {
    const index = hitTestFor(e);
    return index < 0 ? -1 : index % board.cols;
}

function hitRow(e) {
    const index = hitTestFor(e);
    if (index < 0) return -1;
    const col = index % board.cols;
    return (index - col) / board.cols;
}

function hitTestFor(e) {
    return e.target === canvas ? hitTest(e.clientX, e.clientY) : -1;
}

// 开发者模式下：指针带着按下的左键离开窗口 / 窗口失焦时，那次 mouseup 不会再来，
// 通知 devtools 收尾（否则框选会一直粘在光标上）
function cancelDevPress() {
    if (isDevMode()) emitDevEvent('leftcancel', {});
}

// 右键按住到长按阈值：开始拖动棋盘
function beginRightPan(x, y) {
    suppressNextContextMenu = true; // 这一次右键不再是"短按"，别弹圆环
    rightPanning = true;
    viewState.panning = true;
    viewState.hasMoved = false;     // 松手后不要再当点击处理
    viewState.startX = x - viewState.translateX;
    viewState.startY = y - viewState.translateY;
    viewState.clickStartX = x;
    viewState.clickStartY = y;
    markHoverDirty();
}

// 右键还没到长按就移动：超过容差立即升级成拖动（比等满 220ms 更跟手）
function handleRightPressMove(e) {
    if (!rightPress) return false;

    const point = getPoint(e);
    if (Math.hypot(point.x - rightPress.x, point.y - rightPress.y) < RIGHT_DRAG_SLOP) return true;

    clearTimeout(rightPress.timer);
    rightPress = null;
    beginRightPan(point.x, point.y);
    return true;
}

function onPointerMove(e) {
    // 右键按下、还没决定是拖动还是点击：先什么都不做
    if (handleRightPressMove(e) && rightPress) return;

    // 开发者模式：框选 / 长按判定
    if (isDevMode()) {
        emitDevEvent('leftmove', { event: e, col: hitColumn(e), row: hitRow(e) });
    }

    if (!viewState.panning) {
        // 未拖动时更新悬停高亮（移到面板上则收起）
        onHoverMove(e);
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

function onPointerUp(e) {
    viewState.panning = false;

    // 开发者模式：收尾框选 / 弹方块菜单
    if (isDevMode() && e && e.type === 'mouseup' && e.button === 0) {
        emitDevEvent('leftup', { event: e, col: hitColumn(e), row: hitRow(e) });
        return;
    }

    // 右键没进入拖动就松开 = 短按：交给随后的 contextmenu 呼出颜色圆环
    if (rightPress) {
        clearTimeout(rightPress.timer);
        rightPress = null;
    }

    // 拖过的那次右键：浏览器紧接着还会发一个 contextmenu，吞掉它，也不弹圆环
    if (e && e.type === 'mouseup' && e.button === RIGHT_BUTTON) {
        suppressNextContextMenu = rightPanning;
        rightPanning = false;
        // 拖动视图时按下的那次点击不该落在方块上
        viewState.hasMoved = suppressNextContextMenu;
    }
}

function onContextMenu(e) {
    // 这一次右键已经变成拖动棋盘了：吞掉浏览器菜单，也不弹圆环
    if (suppressNextContextMenu) {
        suppressNextContextMenu = false;
        e.preventDefault();
        return;
    }

    const inRing = e.target.closest && e.target.closest('#brush-ring');

    // 在圆环上再次右键就收起
    if (inRing) {
        e.preventDefault();
        closeBrushRing();
        return;
    }

    // 开发者模式：右键打开操作菜单（选区 / 闭合区域），不再呼出画笔圆环
    if (isDevMode()) {
        e.preventDefault();
        closeBrushRing();
        emitDevEvent('contextmenu', { event: e });
        return;
    }

    // 其它 UI（页脚、设置按钮等）保留浏览器默认菜单
    if (e.target !== canvas) return;

    e.preventDefault();
    openBrushRing(e.clientX, e.clientY);
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
    const centerX = viewport.w / 2;
    const centerY = viewport.h / 2;
    const mid = getTouchMidpoint(e);

    updatePinchState({
        startDistance: Math.max(1, getTouchDistance(e)),
        startScale: viewState.scale,
        // 双指中点对应的棋盘坐标，缩放过程中保持这一点不动
        localX: (mid.x - centerX - viewState.translateX) / viewState.scale,
        localY: (mid.y - centerY - viewState.translateY) / viewState.scale
    });

    viewState.panning = false;
    viewState.hasMoved = true; // 双指操作结束后不要误触方块
    markHoverDirty();
}

// 双指变单指时，用剩下的手指继续平移
function resumePanWithTouch(e) {
    updatePinchState(null);

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
        if (!pinch) startPinch(e);

        const centerX = viewport.w / 2;
        const centerY = viewport.h / 2;
        const mid = getTouchMidpoint(e);
        const distance = Math.max(1, getTouchDistance(e));

        // 缩放比例由双指间距变化决定，并限制在最小 / 最大范围内
        const nextScale = clamp(
            pinch.startScale * (distance / pinch.startDistance),
            getMinScale(),
            getMaxScale()
        );

        viewState.scale = nextScale;
        // 双指中点移动时同时完成平移，缩放中心跟随手指
        viewState.translateX = mid.x - centerX - pinch.localX * nextScale;
        viewState.translateY = mid.y - centerY - pinch.localY * nextScale;

        clampView();
        markHoverDirty();
        requestRender();
        return;
    }

    if (pinch) {
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

    updatePinchState(null);
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

// --- 事件绑定 ---
export function bindCanvasEvents() {
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
        if (rightPress) {
            clearTimeout(rightPress.timer);
            rightPress = null;
        }
        cancelDevPress();
        onPointerUp();
        updateHover(-1);
        if (isPickMode()) hidePickTooltip();
    });

    // 阻止 Safari 的双指手势缩放页面
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('gesturechange', (e) => e.preventDefault());

    // 切到别的窗口时同样收不到 mouseup
    window.addEventListener('blur', cancelDevPress);

    // 窗口大小变化时，重新校验缩放与位置，防止留在无效区域
    window.addEventListener('resize', () => {
        resizeCanvas();
        clampView();
        markHoverDirty();
        requestRender();
    });
}
