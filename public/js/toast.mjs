// 底部居中的浮层提示：开发者工具、设置等模块共用。
// 元素仍然是 index.html 里的 #dev-toast（位置与样式都在 styles.css 里）

const toastEl = document.getElementById('dev-toast');

let toastTimer = 0;

export function toast(message, kind) {
    toastEl.textContent = message;
    toastEl.classList.remove('hidden', 'dev-toast-error');
    if (kind === 'error') toastEl.classList.add('dev-toast-error');

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
}
