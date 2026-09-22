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
//   · 「导入 JSON」把导出的那种选区 JSON 写回棋盘：起点可以用文件自带的、当前位置
//     （有选区就是选区左上角，没有就是右键点的那个方块），或者自己点棋盘选；
//     放不下 / 文件不合法都只报错，不会拿越界坐标去撞服务端

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
import { valueToColor } from './color.mjs';
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
    // 导入这件事也要收干净：面板关掉、点选起点作废（否则退出后还挂着一个等待状态）
    importPicking = null;
    importContext = null;
    closeImportPanel();
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
    'too-large': 'dev.tooLarge',
    'out-of-range': 'dev.outOfRange',
    'bad-range': 'dev.outOfRange',
    'bad-cell': 'dev.outOfRange',
    // 导入 JSON 才会遇到的两种：形状不对 / 取值非法，都当成"文件不对"
    'bad-shape': 'dev.importBadFile',
    'bad-value': 'dev.importBadFile'
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
        // quiet：导入途中发现 token 过期时静默重登用，不必再喊一次"已开启开发者模式"
        if (!options.quiet) toast(t('dev.on'));
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

// 选区是不是还在当前棋盘范围内。
// 导入换掉尺寸后（board-reset 只重算几何，不动这里的选区）旧选区可能落到棋盘外面；
// 这种选区不但填不了色，还会让"点在棋盘外但有选区"的分支弹出选区菜单
function selectionInsideBoard(rect) {
    const norm = normalizeRect(rect);

    return norm.x0 >= 0 && norm.y0 >= 0 && norm.x1 < board.cols && norm.y1 < board.rows;
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
// 客户端算好的下标也过一遍当前棋盘边界：导入换过尺寸、又恰好卡在重同步中间时，
// 老坐标不该再发出去（服务端也会拒，但这里先挡住能少一次往返）
function allIndicesInsideBoard(indices) {
    const total = board.cols * board.rows;

    for (const index of indices) {
        if (!Number.isInteger(index) || index < 0 || index >= total) return false;
    }

    return true;
}

async function paintIndices(indices, color, label) {
    if (!allIndicesInsideBoard(indices)) {
        clearTargets();
        toast(t('dev.outOfRange'), 'error');
        return false;
    }

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

    // 选区留在旧尺寸上（导入换过尺寸又重同步完）：清掉它并提示重新框选，
    // 不要拿越界坐标去撞服务端的边界检查
    if (!selectionInsideBoard(norm)) {
        clearTargets();
        toast(t('dev.outOfRange'), 'error');
        return false;
    }

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

    // 当前位置 = 选区左上角（有选区时才有意义）
    actions.push({ label: t('dev.exportPng'), run: exportSelectionImage });
    actions.push({ label: t('dev.exportJson'), run: exportSelectionJson });
    actions.push({
        label: t('dev.importJson'),
        run: () => requestImportJson({ x: size.rect.x0, y: size.rect.y0 })
    });
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

    // 没有选区时，"当前位置"就是这个方块（导入 JSON 的左上角落点）
    actions.push({
        label: t('dev.importJson'),
        run: () => requestImportJson({ x: col, y: row })
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
// 两个动作分开：菜单里是「导出为图片」「导出为 JSON」，不再一次下载两个文件
function selectionSizeOrNull() {
    if (!hasSelection()) {
        toast(t('dev.noSelection'), 'error');
        return null;
    }

    const size = selectionSize(getDevSelection());

    // 选区留在旧尺寸上（导入换过尺寸又重同步完）时坐标可能已经越界，
    // 直接读会把 undefined 写进 JSON，这里先挡住
    if (!selectionInsideBoard(size.rect)) {
        toast(t('dev.outOfRange'), 'error');
        return null;
    }

    return size;
}

function selectionName(size) {
    return `${size.rect.x0}-${size.rect.y0}_${size.width}x${size.height}`;
}

// 选区取值 → 二维数组载荷（导出 JSON 与导入共用同一套形状）
// 与单元格协议一致：0 黑、1..15 预设编号、>= 16 为 24bit RGB
function regionPayload(rect) {
    const gridState = getGridState();
    const cells = [];

    for (let row = rect.y0; row <= rect.y1; row++) {
        const line = [];
        for (let col = rect.x0; col <= rect.x1; col++) {
            line.push(gridState[row * board.cols + col]);
        }
        cells.push(line);
    }

    return {
        format: 'blockboard-region',
        version: 1,
        x: rect.x0,
        y: rect.y0,
        width: rect.x1 - rect.x0 + 1,
        height: rect.y1 - rect.y0 + 1,
        cells
    };
}

function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const link = document.createElement('a');

    link.download = name;
    link.href = URL.createObjectURL(blob);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function exportSelectionImage() {
    const size = selectionSizeOrNull();
    if (!size) return;

    // PNG：复用棋盘绘制，只画选中这一片
    try {
        const image = renderRegionToCanvas(size.rect.x0, size.rect.y0, size.width, size.height, 4);
        image.getContext('2d').fillStyle = 'rgba(0, 0, 0, 0)';
        saveAsPng(image, `BlockBoard_${selectionName(size)}.png`);
        toast(t('dev.exported', { w: size.width, h: size.height }));
    } catch (error) {
        console.error('Failed to export the selection as an image:', error);
        toast(t('dev.exportFailed'), 'error');
    }
}

function exportSelectionJson() {
    const size = selectionSizeOrNull();
    if (!size) return;

    try {
        downloadFile(
            `BlockBoard_${selectionName(size)}.json`,
            JSON.stringify(regionPayload(size.rect), null, 2),
            'application/json'
        );
        toast(t('dev.exported', { w: size.width, h: size.height }));
    } catch (error) {
        console.error('Failed to export the selection as JSON:', error);
        toast(t('dev.exportFailed'), 'error');
    }
}

// --- 导入选区 JSON ---
// 流程：右键菜单点「导入 JSON…」→ 选文件 → 面板里选用哪个起点
//   · 文件自带的起点（导出时写进去的 x / y）
//   · 触发菜单时的"当前位置"：有选区就是选区左上角，没有就是右键点的那个方块
//   · 点棋盘自己选：进入等待状态，左键点一下棋盘定左上角（Esc 取消）
// 起点放不下就报错（超出棋盘），不会拿越界坐标去撞服务端
const importFileEl = document.getElementById('dev-import-file');
const importEl = document.getElementById('dev-import');
const importInfoEl = document.getElementById('dev-import-info');
const importActionsEl = document.getElementById('dev-import-actions');

/** 单次 draw 请求最多写多少格（服务端 MAX_REGION_CELLS 是 200000，这里留点余量） */
const DRAW_CHUNK_CELLS = 100000;
/** 服务端单次请求的硬上限：宽过它的选区切不开（一行就超了），只能拒掉 */
const DRAW_MAX_CELLS = 200000;
/** 选区 JSON 的读取上限：再大就该用 .bbx 备份，而不是往内存里塞 */
const IMPORT_MAX_BYTES = 32 * 1024 * 1024;
/** 点选起点时画画面预览的格子上限：再大就只留绿色框（几十万次 fillRect 会卡一下） */
const IMPORT_PREVIEW_MAX_CELLS = 400000;
/** 落点预览的透明度：透一点底色出来，和棋盘上真画上去的区分开 */
const IMPORT_PREVIEW_ALPHA = 0.6;

let importContext = null;   // 触发导入时的"当前位置"起点 { x, y }
let importPicking = null;   // { data, preview }：正在等用户点棋盘选起点

function isImportPanelOpen() {
    return !importEl.classList.contains('hidden');
}

function closeImportPanel() {
    importEl.classList.add('hidden');
    importActionsEl.innerHTML = '';
    importInfoEl.textContent = '';
}

// 菜单里的「导入 JSON…」：先记下当前位置，再打开文件框（change 时才解析）
function requestImportJson(origin) {
    importContext = origin && origin.x >= 0 && origin.y >= 0 ? { x: origin.x, y: origin.y } : null;

    importFileEl.value = '';
    importFileEl.click();
}

// 导出的 JSON（以及手写的同形状文件）→ 内部结构；不合法返回 null
function parseRegionJson(text) {
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        return null;
    }

    if (!data || typeof data !== 'object' || !Array.isArray(data.cells)) return null;

    const rows = data.cells;
    if (rows.length === 0 || !Array.isArray(rows[0])) return null;

    const width = rows[0].length;
    if (width === 0) return null;

    const cells = [];

    for (const row of rows) {
        if (!Array.isArray(row) || row.length !== width) return null;

        const line = [];
        for (const raw of row) {
            const value = Number(raw);
            // 取值必须落在单元格协议里：0..0xffffff
            if (!Number.isInteger(value) || value < 0 || value > RGB_MASK) return null;
            line.push(value);
        }
        cells.push(line);
    }

    const hasOrigin = Number.isInteger(data.x) && Number.isInteger(data.y) && data.x >= 0 && data.y >= 0;

    return {
        width,
        height: rows.length,
        cells,
        x: hasOrigin ? data.x : 0,
        y: hasOrigin ? data.y : 0,
        hasOrigin
    };
}

function pushImportOrigin(label, run) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dev-menu-item';

    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);

    button.addEventListener('click', () => run());
    importActionsEl.appendChild(button);
}

function openImportPanel(data) {
    closeMenu();

    importInfoEl.textContent = data.hasOrigin
        ? t('dev.importInfo', { w: data.width, h: data.height, x: data.x, y: data.y })
        : t('dev.importInfoNoOrigin', { w: data.width, h: data.height });
    importActionsEl.innerHTML = '';

    if (data.hasOrigin) {
        pushImportOrigin(
            t('dev.importUseFile', { x: data.x, y: data.y }),
            () => applyImport(data, data.x, data.y)
        );
    }

    if (importContext) {
        const { x, y } = importContext;
        pushImportOrigin(t('dev.importUseHere', { x, y }), () => applyImport(data, x, y));
    }

    pushImportOrigin(t('dev.importPick'), () => beginImportPick(data));

    importEl.classList.remove('hidden');
}

// 取消导入：正在点选起点的话，把预览出来的选区也一起清掉
function cancelImport() {
    const wasPicking = Boolean(importPicking);

    importPicking = null;
    importContext = null;
    closeImportPanel();

    if (wasPicking) {
        setDevSelection(null);
        regionCells = [];
        regionBoundary = [];
        redraw();
    }
}

// 点选起点时的落点预览：把 JSON 的取值画成"1 像素 1 格"的离屏 canvas，
// 落点预览时按棋盘几何整体放大贴上（和平移缩小时的 LOD 同一个思路，别逐格 fillRect 上屏）
function buildImportPreview(data) {
    if (data.width * data.height > IMPORT_PREVIEW_MAX_CELLS) return null;

    const preview = document.createElement('canvas');
    preview.width = data.width;
    preview.height = data.height;

    const g = preview.getContext('2d');

    for (let row = 0; row < data.height; row++) {
        const line = data.cells[row];

        for (let col = 0; col < data.width; col++) {
            g.fillStyle = valueToColor(line[col]);
            g.fillRect(col, row, 1, 1);
        }
    }

    return preview;
}

function beginImportPick(data) {
    closeImportPanel();

    importPicking = { data, preview: buildImportPreview(data) };
    setDevSelection(null);
    regionCells = [];
    regionBoundary = [];
    redraw();

    toast(t('dev.importPicking'));
}

// 点选起点模式下跟着光标预览落点：光标移到哪，JSON 的左上角就跟到哪
function previewImport(col, row) {
    if (!importPicking || col < 0 || row < 0) return;

    const { data } = importPicking;
    const rect = { x0: col, y0: row, x1: col + data.width - 1, y1: row + data.height - 1 };

    if (hasSelection()) {
        const current = normalizeRect(getDevSelection());
        if (current.x0 === rect.x0 && current.y0 === rect.y0 &&
            current.x1 === rect.x1 && current.y1 === rect.y1) {
            return;
        }
    }

    setDevSelection(rect);
    redraw();

    // 提示语在点选期间一直挂着（toast 3.2 秒会自己消失，落点在动就再报一次）
    toast(t('dev.importPicking'));
}

// 落点放不下就只报错，留在点选模式里让用户换个地方点（Esc 取消）
function tryImportAt(col, row) {
    if (!importPicking || col < 0 || row < 0) return;

    const { data } = importPicking;

    if (col + data.width > board.cols || row + data.height > board.rows) {
        toast(t('dev.outOfRange'), 'error');
        return;
    }

    importPicking = null;
    applyImport(data, col, row);
}

// 会话过期时用本地保存的密码静默重登一次。
// 导入途中被踢出开发者模式太突兀（服务端重启、token 到期都会 401），而且"导入"不是
// 登出入口：重登失败也只提示，不清 token、不退模式，由用户自己决定要不要退出。
async function trySilentRelogin() {
    const saved = getSavedDevPassword();
    if (!saved) return false;

    try {
        const result = await login(saved, { silent: true, quiet: true });
        return result.ok;
    } catch {
        return false;
    }
}

// 逐格写入的单次请求：401 时（且允许时）静默重登一次再原样重试这一块
async function postDrawRequest(payload, allowRelogin) {
    const { status, data: result } = await api('/api/dev/draw', {
        method: 'POST',
        body: JSON.stringify(payload)
    });

    if (status === 401 && allowRelogin && await trySilentRelogin()) {
        return postDrawRequest(payload, false);
    }

    return { status, data: result };
}

// 逐格写到服务端：一次请求最多 DRAW_CHUNK_CELLS 格，按整行切（起点跟着往下挪），
// 响应的 range 里颜色写在 runs 的每一段上，直接在本机套用，不用等广播绕一圈
async function applyImport(data, originX, originY) {
    closeImportPanel();
    importContext = null;

    if (originX < 0 || originY < 0 ||
        originX + data.width > board.cols || originY + data.height > board.rows) {
        toast(t('dev.outOfRange'), 'error');
        return false;
    }

    if (data.width > DRAW_MAX_CELLS) {
        toast(t('dev.tooLarge'), 'error');
        return false;
    }

    const rowsPerChunk = Math.max(1, Math.floor(DRAW_CHUNK_CELLS / data.width));

    try {
        for (let offset = 0; offset < data.height; offset += rowsPerChunk) {
            const rows = data.cells.slice(offset, offset + rowsPerChunk);

            const { status, data: result } = await postDrawRequest({
                x: originX,
                y: originY + offset,
                width: data.width,
                height: rows.length,
                cells: rows
            }, true);

            if (status === 401) {
                // 重登也失败：只提示，不退出开发者模式
                toast(t('dev.sessionExpired'), 'error');
                return false;
            }

            if (status !== 200 || !result.ok) {
                toast(devErrorMessage(result.error, result.message), 'error');
                return false;
            }

            if (result.range) applyRegionPayload(result.range);
        }
    } catch {
        toast(t('dev.opFailed'), 'error');
        return false;
    }

    clearTargets();
    toast(t('dev.importDone', { w: data.width, h: data.height }));
    return true;
}

// 文件框选中文件后：读文本 → 校验 → 弹起点面板
async function onImportFilePicked() {
    const file = importFileEl.files && importFileEl.files[0];
    if (!file) return;

    if (file.size > IMPORT_MAX_BYTES) {
        toast(t('dev.tooLarge'), 'error');
        return;
    }

    let text = '';
    try {
        text = await file.text();
    } catch {
        toast(t('dev.importBadFile'), 'error');
        return;
    }

    const data = parseRegionJson(text);
    if (!data) {
        toast(t('dev.importBadFile'), 'error');
        return;
    }

    openImportPanel(data);
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

        // 点选导入起点时：先把 JSON 的画面半透明贴上去（有画面就不铺绿色底色，免得串色），
        // 绿色虚线框无论如何都留着
        const preview = importPicking ? importPicking.preview : null;

        if (preview) {
            ctx.save();
            ctx.globalAlpha = IMPORT_PREVIEW_ALPHA;
            // 一格一像素的位图放大贴，关掉插值才是方块而不是糊成一团
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(preview, x, y, right - x, bottom - y);
            ctx.restore();
        } else {
            ctx.fillStyle = 'rgba(76, 209, 55, 0.18)';
            ctx.fillRect(x, y, right - x, bottom - y);
        }

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

    // 导入面板开着（模态）或正在点选起点：这次按下不参与框选
    if (isImportPanelOpen() || importPicking) return;

    leftPress = {
        x: e.clientX,
        y: e.clientY,
        col,
        row,
        timer: setTimeout(() => beginSelection(col, row), SELECT_LONGPRESS_MS)
    };
}

function handleLeftMove(e, col, row) {
    // 点选起点：跟着光标预览落点
    if (importPicking) {
        previewImport(col, row);
        return;
    }

    if (isImportPanelOpen()) return;

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
    // 点选起点：这一下就是起点，不再当框选 / 方块菜单处理
    if (importPicking) {
        tryImportAt(col, row);
        return;
    }

    if (isImportPanelOpen()) return;

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

    // 导入面板开着时不弹新菜单（模态，避免把这次右键当成新操作的起点）
    if (isImportPanelOpen() || importPicking) return;

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
    // Esc：由 keyboard.mjs 统一转发（免得两边各写一份 Esc 逻辑）
    devEvents.addEventListener('dismiss', dismissDevOverlays);
}

// Esc 的开发者侧收尾：按"最上面那层"的顺序一次收一个
//   · 登录框 → 导入面板（含点选起点）→ 右键菜单 → 选区 / 闭合区域高亮
// 由 keyboard.mjs 往 devEvents 上转 'dismiss' 调过来，返回是否真的收掉了什么
function dismissDevOverlays() {
    if (!loginEl.classList.contains('hidden')) {
        closeDevPanel();
        return true;
    }

    if (importPicking || isImportPanelOpen()) {
        cancelImport();
        return true;
    }

    if (menuOpen) {
        closeMenu();
        return true;
    }

    if (hasSelection() || regionCells.length > 0) {
        clearSelection();
        return true;
    }

    return false;
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

    // 导入选区 JSON：选完文件弹起点面板，取消就整件事作废
    importFileEl.addEventListener('change', onImportFilePicked);
    document.getElementById('dev-import-cancel').addEventListener('click', cancelImport);

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
