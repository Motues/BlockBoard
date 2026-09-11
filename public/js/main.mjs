// 入口：把各部分接起来并启动。
// 模块依赖方向（不出现环）：
//   shared ← board / camera / render / interactions / ring / picker / connection
//   模块之间：ring → picker → brush → cursor → shared

import { getBrushRgb, loadBrush, loadRecentColors } from './brush.mjs';
import { updateBrushCursor } from './cursor.mjs';
import { bindPickerEvents, primePickerBrush, renderRecentColors } from './picker.mjs';
import {
    buildBrushRing,
    closeHintPopup,
    openBrushRingFromPanel,
    refreshRingActive,
    showHintPopup
} from './ring.mjs';
import { bindUiEvents, initConnection } from './connection.mjs';
import { resetView, resizeCanvas, watchDevicePixelRatio } from './camera.mjs';
import { saveAsImage } from './render.mjs';
import { requestRender } from './shared.mjs';

// index.html 里还有几处内联 onclick="..."，它们只能看见全局函数。
// 模块作用域对外是不可见的，所以这里把这几个入口挂到 window 上。
function exposeGlobals() {
    Object.assign(window, {
        closeHintPopup,
        showHintPopup,
        openBrushRingFromPanel,
        resetView,
        saveAsImage
    });
}

// 先把本地保存的画笔 / 最近颜色读回来
loadBrush();
loadRecentColors();

// 调色盘是以当前画笔为起点打开的，记下"上次确认的颜色"
primePickerBrush(getBrushRgb());

exposeGlobals();
buildBrushRing();
bindPickerEvents();
initConnection();
bindUiEvents();

// 首屏
renderRecentColors();
refreshRingActive();
updateBrushCursor();
resizeCanvas();
watchDevicePixelRatio();
requestRender();
