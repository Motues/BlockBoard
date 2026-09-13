// Edge 鼠标手势提示（左下角的小卡片）。
//
// Edge 自带的「鼠标手势」是浏览器级功能：长按右键拖动会被 Edge 抢去执行手势，
// 网页既关不掉它、也收不到那次拖动，棋盘因此拖不动。
//   · 只在桌面版 Edge 上提示（移动端 Edge 是 EdgA / EdgiOS，没有鼠标手势）
//   · 点「知道了」后写 localStorage，之后不再打扰
//   · 「打开 Edge 设置」按钮：edge:// 属于浏览器内部页面，网页通常打不开，
//     所以无论是否打开成功都把地址复制到剪贴板，卡片上也会把地址显示出来让人手动复制

import { t } from './i18n.mjs';

const HINT_KEY = 'blockboard-edge-gesture-hint';
// Edge 的鼠标手势设置页（设置 → 外观 → 鼠标手势）
const SETTINGS_URL = 'edge://settings/appearance/browserBehavior/mouseGestures';
const SHOW_DELAY_MS = 1600; // 等首屏和帮助弹窗先出来

const hintEl = document.getElementById('edge-hint');
const pathEl = document.getElementById('edge-hint-path');
const statusEl = document.getElementById('edge-hint-status');
const openButton = document.getElementById('edge-hint-open');
const closeButton = document.getElementById('edge-hint-close');

let shown = false;

// 已经在卡片上点过「知道了」
function isDismissed() {
    try {
        return localStorage.getItem(HINT_KEY) === '1';
    } catch {
        // 隐私模式下读不了，当成没点过
        return false;
    }
}

function rememberDismissed() {
    try {
        localStorage.setItem(HINT_KEY, '1');
    } catch {
        // 写不了就算了，下次还会提示
    }
}

// 桌面版 Edge：UA 里是 "Edg/"，移动端是 "EdgA/" / "EdgiOS/"
function isDesktopEdge() {
    const ua = navigator.userAgent || '';
    return /Edg\//.test(ua) && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
}

function hide() {
    if (hintEl) hintEl.classList.add('hidden');
}

function show() {
    if (!hintEl || shown) return;

    shown = true;
    hintEl.classList.remove('hidden');
}

// 复制到剪贴板：优先用异步接口（localhost 也算安全上下文），
// 不可用时退回临时 textarea + execCommand
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // 继续走下面的兜底
    }

    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';

        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);

        return ok;
    } catch {
        return false;
    }
}

// 试着在新页面里打开 Edge 设置，并把地址复制一份兜底
function openEdgeSettings() {
    try {
        window.open(SETTINGS_URL, '_blank');
    } catch {
        // 浏览器不允许网页打开 edge:// 时忽略
    }

    setStatus(t('edgeHint.copied'));

    copyToClipboard(SETTINGS_URL).then((copied) => {
        if (!copied) setStatus(t('edgeHint.copyFailed'));
    });
}

export function initEdgeHint() {
    // 卡片上印出来的地址始终和按钮用的是同一个常量
    if (pathEl) pathEl.textContent = SETTINGS_URL;

    if (openButton) openButton.addEventListener('click', openEdgeSettings);

    if (closeButton) {
        closeButton.addEventListener('click', () => {
            hide();
            rememberDismissed();
        });
    }

    if (!hintEl || !isDesktopEdge() || isDismissed()) return;

    setTimeout(show, SHOW_DELAY_MS);
}
