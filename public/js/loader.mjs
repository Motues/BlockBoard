// 首屏加载动画：logo 居中 + 外面一圈 3×3 圆点胀缩（见 styles.css 的 .loader / .board-loader）。
//
// 为什么把它单独拆一个模块：它是唯一一个"在棋盘状态到位之前就必须看得见"的界面，
// 而棋盘状态到位的信号分散在 connection.mjs 的三条路（inline / chunks / client）里。
// 所以 connection 只负责上报状态，模块只负责画，两边靠 onLoadStatus 这个监听器解耦。
//
// 规则：
//   · 状态用**累计语义**（失败只会从"连接中"升级成"连不上"，不会反过来），
//     免得 socket.io 反复重连时文案乱跳；
//   · 结束要同时满足"棋盘就绪"和"最短展示时间"：网络太快时闪一下反而像故障；
//   · 隐藏后自己从 DOM 里摘掉，不留在那儿挡着（也省掉一层固定定位的合成开销）。

import { onLangChange, t } from './i18n.mjs';
import { onLoadStatus } from './connection.mjs';

/** 最短展示时间（ms）：比这更快就不显示，免得看起来像闪了一下 */
const MIN_VISIBLE_MS = 700;
/** 淡出时长（ms）：和 styles.css 里 .board-loader 的 transition 对齐 */
const FADE_OUT_MS = 320;

// 首次展示的时刻。**必须在脚本执行时就记下来**：模块是 main.mjs 一开始就 import 的，
// 离"打开页面"最近。如果等到 initBoardLoader() 才记，前面 buildBrushRing() 之类同步
// 初始化的耗时会被算进来，最短展示时间就不准了。
let shownAt = performance.now();

let state = 'connect';
let progress = null;
let ready = false;
let finished = false;
let bound = false;

// 用函数现取节点，而不是在模块顶层存下来：顶层 `document` 只有一份，
// 一旦页面被替换（多标签页 / 刷新后复用同一份模块），存下来的引用就指向被丢弃的旧文档了
function loaderEl() {
    return document.getElementById('board-loader');
}

function statusTextEl() {
    return document.getElementById('board-loader-status');
}

/** 把当前状态画到屏幕上；语言切换时也重画一遍（文案是动态的，不能用 data-i18n） */
function render() {
    const statusEl = statusTextEl();
    if (!statusEl) return;

    let text;

    if (state === 'failed') {
        text = t('loading.failed');
    } else if (state === 'receive') {
        text = progress
            ? t('loading.receivingChunks', { done: progress.done, total: progress.total })
            : t('loading.receiving');
    } else if (state === 'sync') {
        text = t('loading.syncing');
    } else {
        text = t('loading.connecting');
    }

    statusEl.textContent = text;
    statusEl.classList.toggle('error', state === 'failed');
}

function finish() {
    if (finished || !ready) return;

    const el = loaderEl();
    if (!el) return;

    finished = true;
    el.classList.add('hidden');

    // 摘掉整个遮罩（不只是清空内容），之后渲染循环不用再管它
    setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
    }, FADE_OUT_MS);
}

function hideWhenSettled() {
    if (!ready) return;

    const waited = performance.now() - shownAt;
    if (waited >= MIN_VISIBLE_MS) {
        finish();
        return;
    }

    setTimeout(finish, MIN_VISIBLE_MS - waited);
}

export function initBoardLoader(options) {
    // 正常启动只调用一次；带上 rebind 可以重新绑一遍（并复位状态），
    // 给"同一个模块实例换了一份 document"的场合用
    if (bound && !(options && options.rebind)) return;

    if (bound) {
        shownAt = performance.now();
        state = 'connect';
        progress = null;
        ready = false;
        finished = false;
    }

    bound = true;

    onLoadStatus((status) => {
        if (finished) return;

        // null = 棋盘状态已经完整（服务端后续的实时广播不再需要遮罩）
        if (status === null) {
            ready = true;
            hideWhenSettled();
            return;
        }

        if (typeof status === 'string') {
            // 失败是终态：已经连不上了就别再退回"连接中"（重连成功时会发一次 connect 复位）
            if (status === 'failed') state = 'failed';
            else if (status === 'receive') state = 'receive';
            else if (status === 'sync') state = 'sync';
            else state = 'connect';

            progress = null;
            render();
            return;
        }

        if (status && status.type === 'receive') {
            state = 'receive';
            progress = { done: status.done, total: status.total };
            render();
        }
    });

    onLangChange(render);
    render();
}
