// 入口：把各部分接起来并启动。
// 模块依赖方向（不出现环）：
//   shared ← board / camera / render / interactions / ring / picker / connection
//   模块之间：ring → picker → brush → cursor → shared
//             i18n ← settings ← devtools（toast / edge-hint 独立，只依赖 i18n）
//             state-cache 是叶子（不 import 任何模块）：shared 在顶层 await 里读它，
//             connection 往里报"状态变了"，main 负责把"当前状态 + epoch/rev"喂给它写盘

import { getBrushRgb, loadBrush, loadRecentColors } from './brush.mjs';
import { updateBrushCursor } from './cursor.mjs';
import { initI18n } from './i18n.mjs';
import { bindPickerEvents, primePickerBrush, renderRecentColors } from './picker.mjs';
import {
    buildBrushRing,
    closeHintPopup,
    openBrushRingFromPanel,
    refreshRingActive,
    showHintPopup
} from './ring.mjs';
import { bindUiEvents, initConnection } from './connection.mjs';
import { bindDevEvents } from './devtools.mjs';
import { initEdgeHint } from './edge-hint.mjs';
import { bindSettingsEvents } from './settings.mjs';
import { initBoardLoader } from './loader.mjs';
import { resetView, resizeCanvas, watchDevicePixelRatio } from './camera.mjs';
import { saveAsImage } from './render.mjs';
import { getGridState } from './board.mjs';
import { encodeDenseState, flushCacheNow, setCacheProvider } from './state-cache.mjs';
import { board, requestRender, socket, syncInfo } from './shared.mjs';

// index.html 里还有几处内联 onclick="..."，它们只能看见全局函数。
// 模块作用域对外是不可见的，所以这里把这几个入口挂到 window 上。
// （底部的开发者工具 / 设置 / 菜单按钮不是内联的，在各自的模块里绑定）
function exposeGlobals() {
    Object.assign(window, {
        closeHintPopup,
        showHintPopup,
        openBrushRingFromPanel,
        resetView,
        saveAsImage
    });
}

// 先把语言定下来：第一次进入按浏览器语言选，其余模块的渲染都跟着它走
initI18n();

// 再把本地保存的画笔 / 最近颜色读回来
loadBrush();
loadRecentColors();

// 调色盘是以当前画笔为起点打开的，记下"上次确认的颜色"
primePickerBrush(getBrushRgb());

// --- 增量同步的本地缓存 ---
// 只有拿到服务端权威的 epoch / rev（syncInfo.ready）之后才允许写盘：
// 分块下发收齐、差量应用完之前，本机这份状态是残缺的，写下去会让下次重连对不上。
// 棋盘大到一定程度就不缓存了：几十 MB 的 IndexedDB 写入不值得（那种规模本来就该走分块）
const CACHE_MAX_BYTES = 12 * 1024 * 1024;

setCacheProvider(() => {
    if (!syncInfo.ready || !board.cols || !board.rows) return null;

    const state = getGridState();
    if (state.length !== board.cols * board.rows) return null;
    if (state.length * 3 > CACHE_MAX_BYTES) return null;

    return {
        epoch: syncInfo.epoch,
        rev: syncInfo.rev,
        cols: board.cols,
        rows: board.rows,
        bytes: encodeDenseState(state)
    };
});

// 页面被切走 / 关闭前尽量落一次盘（平时的写盘是节流的）
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushCacheNow();
});
window.addEventListener('pagehide', flushCacheNow);

exposeGlobals();
buildBrushRing();
bindPickerEvents();
// 必须在 initConnection() 之前挂上：首屏的 init-game 可能紧接着就来，
// 挂晚了会漏掉"棋盘已就绪"那一条，加载遮罩就一直转下去了
initBoardLoader();
initConnection();
bindUiEvents();
bindDevEvents();
bindSettingsEvents();

// Edge 的鼠标手势会抢走右键拖动（网页关不掉），桌面版 Edge 上提示一次
initEdgeHint();

// 首屏
renderRecentColors();
refreshRingActive();
updateBrushCursor();
resizeCanvas();
watchDevicePixelRatio();
requestRender();

// 所有模块都接好了才连：这样 init-game 的处理器一定挂上了，
// 握手也能带上从本地缓存读出来的 epoch / rev（见 shared.mjs）
socket.connect();
