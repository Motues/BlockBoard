// 开发者工具（客户端）：
//   · 用服务器预设的密码换一个 token（存 localStorage，刷新页面仍然有效）
//   · 底部的「开发者工具」按钮：本地存过密码就直接拿它登录（不弹窗）；
//     没存过就弹出密码框让用户配置，成功后把密码记在本地；密码被服务端拒绝时
//     清掉本地密码并重新弹窗验证
//   · 开启后屏幕上常驻提示条，可随时退出（退出会通知服务端作废 token）
//   · 左键拖拽（按住不动到长按阈值再拖也行）= 矩形框选；左键短按 = 该方块的操作菜单；
//     右键 = 当前选区/区域的菜单
//   · 闭合区域填充：客户端做 flood fill，碰不到棋盘边缘才算"闭合"，否则报错
//   · 选区可以填成当前画笔色 / 调色盘里选的颜色，也可以重置为黑、导出为 PNG 或 JSON

import {
    RIGHT_DRAG_SLOP,
    RGB_MASK
} from './config.mjs';
import {
    applyBrushFromRgb,
    getBrushColor,
    getBrushIndex,
    getBrushRgb,
    isCustomBrush,
    setBrushIndex
} from './brush.mjs';
import { applyRegionPayload, getGridState, hitTest } from './board.mjs';
import { onLangChange, t } from './i18n.mjs';
import { openColorPickerFor, primePickerFromRgb } from './picker.mjs';
import { renderRegionToCanvas, saveAsPng } from './render.mjs';
import { closeOptionsPanel } from './ring.mjs';
import {
    clearSavedDevPassword,
    getSavedDevPassword,
    setSavedDevPassword
} from './settings.mjs';
import { toast } from './toast.mjs';
import {
    board,
    clamp,
    ctx,
    devEvents,
    getDevSelection,
    isDevMode,
    requestRender as redraw,
    setDevMode,
    setDevSelection,
    setRenderHooks,
    viewport,
    viewState
} from './shared.mjs';

const DEV_TOKEN_KEY = 'blockboard-dev-token';
// 框选长按阈值：比右键的短按稍微长一点，避免和"单击方块"抢
const SELECT_LONGPRESS_MS = 260;

const bannerEl = document.getElementById('dev-banner');
const devToolsButtonEl = document.getElementById('devtools-button');
const loginEl = document.getElementById('dev-login');
const loginHintEl = document.getElementById('dev-login-hint');
const passwordEl = document.getElementById('dev-password');
const menuEl = document.getElementById('dev-menu');
const menuTitleEl = document.getElementById('dev-menu-title');
const menuBodyEl = document.getElementById('dev-menu-body');

let devToken = '';
let devEnabled = false;     // 服务端是否配置了密码
let devChecked = false;     // 有没有问过服务端"开发者工具开没开"
let selectionDrag = null;   // { x0, y0, x1, y1 } 单位为棋盘列/行，拖拽中实时更新
let regionCells = [];       // 客户端算好的闭合区域（格子下标）
let regionBoundary = [];    // 闭合区域的边界格子，用于画高亮
let leftPress = null;       // { x, y, timer, long, col, row }
let menuOpen = false;

// --- 与服务器通讯 ---
async function api(path, options = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (devToken) headers['x-dev-token'] = devToken;

    const response = await fetch(path, Object.assign({}, options, { headers }));
    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }

    return { status: response.status, data: data || {} };
}

// --- 登录 / 退出 ---
function storeToken(token) {
    devToken = token || '';
    try {
        if (devToken) localStorage.setItem(DEV_TOKEN_KEY, devToken);
        else localStorage.removeItem(DEV_TOKEN_KEY);
    } catch {
        // 隐私模式下写不了，忽略
    }
}

function readStoredToken() {
    try {
        return localStorage.getItem(DEV_TOKEN_KEY) || '';
    } catch {
        return '';
    }
}

function enterDevMode() {
    setDevMode(true);
    bannerEl.classList.remove('hidden');

    // 登录框只是入口：进来之后它就该消失，别留在屏幕中间挡住棋盘
    closeDevPanel();

    // 打开时把设置面板收起来，免得挡住棋盘
    closeOptionsPanel();
}

function exitDevMode() {
    setDevMode(false);
    bannerEl.classList.add('hidden');
    closeMenu();
    regionCells = [];
    regionBoundary = [];
    selectionDrag = null;
    redraw();
}

// 服务端的错误码 → i18n 键（服务端返回的 message 是中英混排的，只当兜底文案）
const DEV_ERROR_KEYS = {
    'bad-password': 'dev.wrongPassword',
    locked: 'dev.locked',
    disabled: 'dev.disabled',
    unauthorized: 'dev.sessionExpired',
    'too-large': 'dev.tooLarge'
};

function devErrorMessage(reason, fallback) {
    const key = DEV_ERROR_KEYS[reason];
    return key ? t(key) : (fallback || t('dev.opFailed'));
}

// 登录框里当前显示的提示：key 有值就按当前语言取，否则用服务端返回的兜底文案
let loginHint = { key: '', text: '' };

function refreshLoginHint() {
    loginHintEl.classList.toggle('dev-login-hint-error', Boolean(loginHint.key || loginHint.text));
    loginHintEl.textContent = loginHint.key
        ? t(loginHint.key)
        : (loginHint.text || t('dev.loginHint'));
}

// 换 token 并进入开发者模式。
//   options.silent = 用本地保存的密码自动登录：失败时不改动屏幕上的登录框，
//   由调用方决定是弹窗还是只提示
async function login(password, options = {}) {
    const { status, data } = await api('/api/dev/login', {
        method: 'POST',
        body: JSON.stringify({ password })
    });

    if (status === 200 && data.ok) {
        storeToken(data.token);
        // 记住密码：下次点「开发者工具」就不用再输一遍
        setSavedDevPassword(password);
        enterDevMode();
        toast(t('dev.on'));
        return { ok: true };
    }

    const reason = data.error || (status === 401 ? 'bad-password' : 'failed');

    if (!options.silent) {
        const key = DEV_ERROR_KEYS[reason] || '';
        loginHint = { key, text: key ? '' : (data.message || '') };
        refreshLoginHint();
    }

    return { ok: false, reason };
}

async function logout() {
    if (devToken) {
        try {
            await api('/api/dev/logout', { method: 'POST' });
        } catch {
            // 服务端不可达也不要卡住退出
        }
    }

    storeToken('');
    exitDevMode();
    toast(t('dev.off'));
}

// 问一下服务端：开发者工具开了吗、上次的 token 还有效吗
async function fetchDevSession() {
    try {
        const { data } = await api('/api/dev/session');
        devChecked = true;
        devEnabled = data.enabled === true;
        return data;
    } catch {
        // 服务端不可达：这次不算数，点按钮时会再问一次
        devChecked = false;
        devEnabled = false;
        return {};
    }
}

// 页面加载时恢复上次的登录状态
async function restoreSession() {
    const data = await fetchDevSession();
    if (!data.enabled) return;

    if (data.active && readStoredToken()) {
        devToken = readStoredToken();
        enterDevMode();
        toast(t('dev.restored'));
    } else {
        storeToken('');
    }
}

// 底部「开发者工具」按钮：
//   · 已经开着 → 提示怎么退出
//   · 本地存过密码 → 直接拿它登录，不弹窗
//   · 没存过密码 → 弹窗让用户输入，成功后密码会存到本地
//   · 密码被服务端拒绝 → 清掉本地密码并弹窗重新验证
export async function openDevTools() {
    if (isDevMode()) {
        toast(t('dev.alreadyOn'));
        return;
    }

    if (!devChecked) await fetchDevSession();
    if (!devChecked) {
        // 还是问不到：服务端不可达
        toast(t('dev.opFailed'), 'error');
        return;
    }
    if (!devEnabled) {
        toast(t('dev.disabled'), 'error');
        return;
    }

    const saved = getSavedDevPassword();
    if (!saved) {
        openDevPanel();
        return;
    }

    let result;
    try {
        result = await login(saved, { silent: true });
    } catch {
        toast(t('dev.opFailed'), 'error');
        return;
    }

    if (result.ok) return;

    // 被锁 / 被禁用：本地密码不一定是错的，只提示
    if (result.reason === 'locked') {
        toast(t('dev.locked'), 'error');
        return;
    }
    if (result.reason === 'disabled') {
        toast(t('dev.disabled'), 'error');
        return;
    }

    clearSavedDevPassword();
    openDevPanel({ key: 'dev.wrongPassword' });
}

// 登录框：hint.key / hint.text 传了就用它当提示（密码错误时会带着错误文案打开）
export function openDevPanel(hint) {
    if (isDevMode()) {
        toast(t('dev.alreadyOn'));
        return;
    }

    loginHint = {
        key: hint && hint.key ? hint.key : '',
        text: hint && hint.text ? hint.text : ''
    };
    refreshLoginHint();

    passwordEl.value = '';
    loginEl.classList.remove('hidden');
    passwordEl.focus();
}

function closeDevPanel() {
    loginEl.classList.add('hidden');
    passwordEl.value = '';

    // 收起后别再让输入框占着焦点，否则打字 / 回车还会落到这个看不见的框里
    passwordEl.blur();
}

// --- 选区（棋盘列/行坐标，含端点）---
function normalizeRect(rect) {
    return {
        x0: Math.min(rect.x0, rect.x1),
        y0: Math.min(rect.y0, rect.y1),
        x1: Math.max(rect.x0, rect.x1),
        y1: Math.max(rect.y0, rect.y1)
    };
}

function selectionSize(rect) {
    if (!rect) return { width: 0, height: 0, count: 0 };

    const norm = normalizeRect(rect);
    const width = norm.x1 - norm.x0 + 1;
    const height = norm.y1 - norm.y0 + 1;

    return { width, height, count: width * height, rect: norm };
}

function hasSelection() {
    const rect = getDevSelection();
    return Boolean(rect) && selectionSize(rect).count > 0;
}

function clearSelection() {
    setDevSelection(null);
    regionCells = [];
    regionBoundary = [];
    closeMenu();
    redraw();
}

// 操作完成后收起选区与区域高亮：结果直接看得见，下一次操作重新开始
function clearTargets() {
    setDevSelection(null);
    regionCells = [];
    regionBoundary = [];
    redraw();
}

// --- 闭合区域（客户端 flood fill）---
// 从 (col, row) 出发，按"颜色相同 + 四连通"扩散。区域只要碰到棋盘边缘就说明没有闭合
function computeClosedRegion(col, row) {
    const cols = board.cols;
    const rows = board.rows;
    const gridState = getGridState();
    const startIndex = row * cols + col;
    const target = gridState[startIndex];

    const seen = new Uint8Array(cols * rows);
    const queue = [startIndex];
    seen[startIndex] = 1;

    const cells = [];
    let touchesEdge = false;

    while (queue.length > 0) {
        const index = queue.pop();
        const c = index % cols;
        const r = (index - c) / cols;

        cells.push(index);
        if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1) touchesEdge = true;

        const neighbours = [
            c > 0 ? index - 1 : -1,
            c < cols - 1 ? index + 1 : -1,
            r > 0 ? index - cols : -1,
            r < rows - 1 ? index + cols : -1
        ];

        for (const next of neighbours) {
            if (next < 0 || seen[next] || gridState[next] !== target) continue;

            seen[next] = 1;
            queue.push(next);
        }
    }

    return { cells, touchesEdge };
}

// 区域的外轮廓：自身属于区域、但四邻里有一个不属于区域（或出界）
function computeBoundary(cells) {
    const cols = board.cols;
    const rows = board.rows;
    const inside = new Set(cells);
    const boundary = [];

    for (const index of cells) {
        const c = index % cols;
        const r = (index - c) / cols;

        const isEdge = c === 0 || r === 0 || c === cols - 1 || r === rows - 1 ||
            !inside.has(index - 1) || !inside.has(index + 1) ||
            !inside.has(index - cols) || !inside.has(index + cols);

        if (isEdge) boundary.push(index);
    }

    return boundary;
}

function regionFromCell(col, row) {
    const { cells, touchesEdge } = computeClosedRegion(col, row);

    if (touchesEdge) {
        return { ok: false, message: t('dev.regionNotClosed') };
    }

    return { ok: true, cells, boundary: computeBoundary(cells) };
}

// --- 右键菜单 ---
function closeMenu() {
    menuOpen = false;
    menuEl.classList.add('hidden');
}

function openMenuAt(clientX, clientY, title, actions) {
    menuTitleEl.textContent = title;
    menuBodyEl.innerHTML = '';

    for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dev-menu-item';

        if (action.swatch) {
            const chip = document.createElement('span');
            chip.className = 'dev-menu-swatch';
            chip.style.background = action.swatch;
            button.appendChild(chip);
        }

        const label = document.createElement('span');
        label.textContent = action.label;
        button.appendChild(label);

        if (action.danger) button.classList.add('dev-menu-danger');
        if (action.hint) button.title = action.hint;

        button.addEventListener('click', () => {
            closeMenu();
            action.run();
        });

        menuBodyEl.appendChild(button);
    }

    menuEl.classList.remove('hidden');
    menuOpen = true;

    // 贴着屏幕边缘时把菜单收回来
    const rect = menuEl.getBoundingClientRect();
    const margin = 8;
    const x = clamp(clientX + 6, margin, Math.max(margin, window.innerWidth - rect.width - margin));
    const y = clamp(clientY + 6, margin, Math.max(margin, window.innerHeight - rect.height - margin));

    menuEl.style.left = Math.round(x) + 'px';
    menuEl.style.top = Math.round(y) + 'px';
}

// 颜色入口：只留调色盘（预设色列表按需求去掉了），执行时把颜色交给 onPick
function pushCustomColorAction(actions, onPick, anchor) {
    actions.push({
        label: t('dev.customColor'),
        swatch: 'conic-gradient(from 0deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
        run: () => chooseCustomColor(onPick, anchor)
    });
}

// 借调色盘选一个颜色：选的过程中会即时同步到画笔，确认后把画笔恢复原样，
// 再把选到的颜色交给 onPick —— 这样开发者工具的取色不会改掉用户的画笔
function chooseCustomColor(onPick, anchor) {
    const savedIndex = getBrushIndex();
    const savedRgb = getBrushRgb();

    primePickerFromRgb(savedRgb);

    openColorPickerFor((rgb) => {
        // 先恢复画笔（预设色用编号，自定义色用色值）
        if (savedIndex > 0) setBrushIndex(savedIndex);
        else applyBrushFromRgb(savedRgb);

        onPick(rgb & RGB_MASK);
    }, anchor);
}

// --- 批量改色 ---
async function paintIndices(indices, color, label) {
    const { status, data } = await api('/api/dev/paint', {
        method: 'POST',
        body: JSON.stringify({ cells: indices, color })
    });

    if (status === 401) {
        storeToken('');
        exitDevMode();
        toast(t('dev.sessionExpired'), 'error');
        return false;
    }

    if (status !== 200 || !data.ok) {
        toast(devErrorMessage(data.error, data.message), 'error');
        return false;
    }

    // 立刻在本机套用，不用等服务端广播绕一圈
    if (data.range) applyRegionPayload(data.range);

    clearTargets();
    toast(t('dev.painted', { label, n: data.changed }));
    return true;
}

async function paintSelection(color, label) {
    const rect = getDevSelection();
    if (!hasSelection()) {
        toast(t('dev.needSelection'), 'error');
        return false;
    }

    const norm = normalizeRect(rect);
    const { status, data } = await api('/api/dev/paint', {
        method: 'POST',
        body: JSON.stringify({ x0: norm.x0, y0: norm.y0, x1: norm.x1, y1: norm.y1, color })
    });

    if (status === 401) {
        storeToken('');
        exitDevMode();
        toast(t('dev.sessionExpired'), 'error');
        return false;
    }

    if (status !== 200 || !data.ok) {
        toast(devErrorMessage(data.error, data.message), 'error');
        return false;
    }

    if (data.range) applyRegionPayload(data.range);

    clearTargets();
    toast(t('dev.painted', { label, n: data.changed }));
    return true;
}

// 菜单里执行颜色操作：优先作用在闭合区域上，否则作用在矩形选区上
function applyColorChoice(color, label) {
    if (regionCells.length > 0) return paintIndices(regionCells, color, label);
    return paintSelection(color, label);
}

// --- 选区 / 区域菜单 ---
function openSelectionMenu(clientX, clientY) {
    if (!hasSelection()) {
        toast(t('dev.needSelection'), 'error');
        return;
    }

    const size = selectionSize(getDevSelection());
    const actions = [
        {
            label: t('dev.fillWithBrush'),
            swatch: getBrushColor(),
            run: () => paintSelection(currentBrushValue(), t('dev.fillDone'))
        },
        {
            label: t('dev.resetBlack'),
            swatch: '#070707',
            run: () => paintSelection(0, t('dev.resetDone'))
        }
    ];

    pushCustomColorAction(actions, (value) => applyColorChoice(value, t('dev.fillDone')), { x: clientX, y: clientY });

    actions.push({ label: t('dev.exportSelection'), run: exportSelection });
    actions.push({ label: t('dev.clearSelection'), run: clearSelection });

    openMenuAt(
        clientX,
        clientY,
        t('dev.selectionTitle', { w: size.width, h: size.height, n: size.count }),
        actions
    );
}

function openRegionMenu(clientX, clientY, col, row) {
    const actions = [
        {
            label: t('dev.fillRegion'),
            swatch: getBrushColor(),
            run: () => runRegionFill(col, row, currentBrushValue())
        },
        {
            label: t('dev.fillRegionBlack'),
            swatch: '#070707',
            run: () => runRegionFill(col, row, 0)
        }
    ];

    pushCustomColorAction(actions, (value) => runRegionFill(col, row, value), { x: clientX, y: clientY });

    actions.push({
        label: hasSelection() ? t('dev.useRectangle') : t('dev.noRectangle'),
        run: () => {
            if (!hasSelection()) {
                toast(t('dev.needSelectionShort'), 'error');
                return;
            }
            regionCells = [];
            regionBoundary = [];
            redraw();
        }
    });

    openMenuAt(clientX, clientY, t('dev.blockTitle', { c: col + 1, r: row + 1 }), actions);
}

function runRegionFill(col, row, color) {
    const region = regionFromCell(col, row);

    if (!region.ok) {
        toast(region.message, 'error');
        return;
    }

    regionCells = region.cells;
    regionBoundary = region.boundary;
    redraw();

    return paintIndices(regionCells, color, t('dev.fillRegionDone'));
}

// 当前画笔的单元格取值：自定义颜色直接用 24bit，预设色用编号
function currentBrushValue() {
    return isCustomBrush() ? (getBrushRgb() & RGB_MASK) : getBrushIndex();
}

// --- 导出选区 ---
function exportSelection() {
    const size = selectionSize(getDevSelection());
    if (!size.count) {
        toast(t('dev.noSelection'), 'error');
        return;
    }

    const name = `${size.rect.x0}-${size.rect.y0}_${size.width}x${size.height}`;
    const gridState = getGridState();

    // PNG：复用棋盘绘制，只画选中这一片
    try {
        const image = renderRegionToCanvas(size.rect.x0, size.rect.y0, size.width, size.height, 4);
        image.getContext('2d').fillStyle = 'rgba(0, 0, 0, 0)';
        saveAsPng(image, `BlockBoard_${name}.png`);
    } catch (error) {
        console.error('Failed to export the selection as an image:', error);
        toast(t('dev.exportFailed'), 'error');
    }

    // JSON：把取值原样列出来，方便备份或脚本处理
    const cells = [];
    for (let row = size.rect.y0; row <= size.rect.y1; row++) {
        const line = [];
        for (let col = size.rect.x0; col <= size.rect.x1; col++) {
            line.push(gridState[row * board.cols + col]);
        }
        cells.push(line);
    }

    const payload = {
        x: size.rect.x0,
        y: size.rect.y0,
        width: size.width,
        height: size.height,
        // 与单元格协议一致：0 黑、1..15 预设编号、>= 16 为 24bit RGB
        cells
    };

    try {
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.download = `BlockBoard_${name}.json`;
        link.href = URL.createObjectURL(blob);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
        console.error('Failed to export the selection as JSON:', error);
    }

    toast(t('dev.exported', { w: size.width, h: size.height }));
}

// --- 选区绘制（挂在渲染循环里）---
function paintDevOverlay(now, cam) {
    if (!isDevMode()) return;

    const rect = getDevSelection();
    if (rect) {
        const norm = normalizeRect(rect);
        const pitch = board.cellSize + board.gap;
        const x = cam.px(board.padding + norm.x0 * pitch);
        const y = cam.py(board.padding + norm.y0 * pitch);
        const right = cam.px(board.padding + norm.x1 * pitch + board.cellSize);
        const bottom = cam.py(board.padding + norm.y1 * pitch + board.cellSize);

        ctx.fillStyle = 'rgba(76, 209, 55, 0.18)';
        ctx.fillRect(x, y, right - x, bottom - y);

        ctx.save();
        ctx.strokeStyle = '#4cd137';
        ctx.lineWidth = Math.max(1, Math.round(viewport.dpr));
        ctx.setLineDash([6 * viewport.dpr, 4 * viewport.dpr]);
        ctx.strokeRect(x, y, right - x, bottom - y);
        ctx.restore();
    }

    // 闭合区域的边界：用四个角上的亮点标出来
    if (regionBoundary.length > 0) {
        ctx.fillStyle = 'rgba(255, 209, 55, 0.75)';
        const size = Math.max(2, Math.round(4 * viewport.dpr));

        for (const index of regionBoundary) {
            const box = cam.cellBox(index);

            ctx.fillRect(box.x, box.y, size, size);
            ctx.fillRect(box.x + box.w - size, box.y, size, size);
            ctx.fillRect(box.x, box.y + box.h - size, size, size);
            ctx.fillRect(box.x + box.w - size, box.y + box.h - size, size, size);
        }
    }
}

// --- 左键：拖拽框选 / 短按方块菜单 ---
// 这三个由 interactions.mjs 在左键的按下 / 移动 / 松手时调用

// 把这次左键按下变成一次矩形框选：
//   · 按住不动到长按阈值（SELECT_LONGPRESS_MS）会走到这里
//   · 按下后直接拖动超过容差也会走到这里 —— 不必先"罚站"260ms 才能拖，
//     否则用户按住就拖时那次按下会在计时器到点前被判定作废，什么都框不出来
function beginSelection(col, row) {
    const press = leftPress;
    if (!press) return;

    // 起点优先用按下的那一格；按下时没落在方块上（例如从棋盘外拖进来）就用当前格
    const startCol = press.col >= 0 ? press.col : col;
    const startRow = press.row >= 0 ? press.row : row;

    // 起点和当前位置都在棋盘外：没有可以框选的东西
    if (startCol < 0 || startRow < 0) return;

    clearTimeout(press.timer);
    leftPress = null;

    viewState.hasMoved = true; // 松手时不要再当点击处理
    selectionDrag = { x0: startCol, y0: startRow, x1: startCol, y1: startRow };
    regionCells = [];
    regionBoundary = [];
    setDevSelection(selectionDrag);
    redraw();
}

// 拖拽中：选区跟着光标长大（光标移出棋盘时停在最后一格）
function extendSelection(col, row) {
    if (!selectionDrag || col < 0 || row < 0) return;
    if (selectionDrag.x1 === col && selectionDrag.y1 === row) return;

    selectionDrag.x1 = col;
    selectionDrag.y1 = row;
    setDevSelection(selectionDrag);
    redraw();
}

function handleLeftDown(e, col, row) {
    closeMenu();

    leftPress = {
        x: e.clientX,
        y: e.clientY,
        col,
        row,
        timer: setTimeout(() => beginSelection(col, row), SELECT_LONGPRESS_MS)
    };
}

function handleLeftMove(e, col, row) {
    if (selectionDrag) {
        extendSelection(col, row);
        return;
    }

    if (!leftPress) return;

    // 还没到长按就移动超过容差：直接开始框选（和右键"按下后拖动即平移"的手感一致）
    if (Math.hypot(e.clientX - leftPress.x, e.clientY - leftPress.y) > RIGHT_DRAG_SLOP) {
        beginSelection(col, row);
        extendSelection(col, row);
    }
}

function handleLeftUp(e, col, row) {
    if (selectionDrag) {
        extendSelection(col, row);
        selectionDrag = null;

        const size = selectionSize(getDevSelection());
        toast(t('dev.selected', { w: size.width, h: size.height, n: size.count }));
        return;
    }

    if (!leftPress) return;

    clearTimeout(leftPress.timer);
    const press = leftPress;
    leftPress = null;

    // 短按方块 = 把操作目标切到"这个方块的闭合区域"。
    // 有矩形选区时顺手取消选区，否则右键会优先针对选区操作，点方块就没反应了
    if (hasSelection()) clearTargets();

    // 按在棋盘外：没有可以定位的方块，只提示一下用法
    if (press.col < 0 || press.row < 0) {
        toast(t('dev.selectHint'));
        return;
    }

    openRegionMenu(e.clientX, e.clientY, press.col, press.row);
}

// 左键还没松手，指针就离开了窗口 / 窗口失去焦点：那次 mouseup 永远不会来了。
// 这里收尾，否则框选会一直粘在光标上（移动鼠标时选区还在长大）
function handleLeftCancel() {
    if (leftPress) {
        clearTimeout(leftPress.timer);
        leftPress = null;
    }

    if (!selectionDrag) return;

    selectionDrag = null;
    // 已经框出来的部分留着，等用户右键操作；一格都没有就清干净
    if (!hasSelection()) setDevSelection(null);
    redraw();
}

// 取消还没落定的一次左键按下（例如右键抢先打开了菜单）
function cancelPendingPress() {
    if (!leftPress) return;
    clearTimeout(leftPress.timer);
    leftPress = null;
}

function handleContextMenu(e) {
    cancelPendingPress();

    const index = hitTest(e.clientX, e.clientY);

    if (index < 0) {
        // 点在棋盘外：有选区就用选区菜单，否则什么都不做
        if (hasSelection()) openSelectionMenu(e.clientX, e.clientY);
        else toast(t('dev.contextHint'));
        return;
    }

    // 有选区时优先针对选区操作；否则针对"这个方块所在的闭合区域"
    if (hasSelection()) openSelectionMenu(e.clientX, e.clientY);
    else {
        const col = index % board.cols;
        openRegionMenu(e.clientX, e.clientY, col, (index - col) / board.cols);
    }
}

// interactions.mjs 把左键与右键转发过来（开发者模式下不参与普通上色与平移）
function bindInteraction() {
    devEvents.addEventListener('leftdown', (e) => handleLeftDown(e.detail.event, e.detail.col, e.detail.row));
    devEvents.addEventListener('leftmove', (e) => handleLeftMove(e.detail.event, e.detail.col, e.detail.row));
    devEvents.addEventListener('leftup', (e) => handleLeftUp(e.detail.event, e.detail.col, e.detail.row));
    // 指针带着按下的左键离开窗口 / 窗口失焦：那次松手收不到了，收尾一下
    devEvents.addEventListener('leftcancel', handleLeftCancel);
    devEvents.addEventListener('contextmenu', (e) => handleContextMenu(e.detail.event));
}

// --- 事件绑定 ---
// 登录框里的提交（按钮 / 回车共用）：网络错误也要有反馈，不能只留一个静默的失败
async function submitLogin() {
    try {
        await login(passwordEl.value.trim());
    } catch {
        toast(t('dev.opFailed'), 'error');
    }
}

export function bindDevEvents() {
    // 底部「开发者工具」按钮：本地存过密码就直接登录，没存过才弹窗
    devToolsButtonEl.addEventListener('click', openDevTools);

    document.getElementById('dev-banner-exit').addEventListener('click', logout);
    document.getElementById('dev-login-submit').addEventListener('click', submitLogin);
    document.getElementById('dev-login-cancel').addEventListener('click', closeDevPanel);

    passwordEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitLogin();
        if (e.key === 'Escape') closeDevPanel();
    });

    // 换语言时，登录框里已经显示出来的提示也要跟着换
    onLangChange(refreshLoginHint);

    // 点别处关掉右键菜单
    document.addEventListener('click', (e) => {
        if (!menuOpen) return;
        if (e.target.closest && e.target.closest('#dev-menu')) return;
        closeMenu();
    }, true);

    // 点别处关掉登录框
    document.addEventListener('click', (e) => {
        if (loginEl.classList.contains('hidden')) return;
        if (e.target.closest && (e.target.closest('#dev-login') || e.target.closest('.option-item'))) return;
        closeDevPanel();
    }, true);

    // 窗口尺寸变化时选区位置会变，重画一次
    window.addEventListener('resize', redraw);

    bindInteraction();
    restoreSession();
}

// 渲染钩子：选区与闭合区域的高亮
setRenderHooks({ paint: paintDevOverlay });
