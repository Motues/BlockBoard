// 入口：把各部分接起来并启动。
// 模块依赖方向（不出现环）：
//   shared ← board / camera / render / interactions / ring / picker / connection
//   模块之间：ring → picker → brush → cursor → shared
//             i18n ← settings ← devtools（toast 独立，谁都能用）

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
import { bindSettingsEvents } from './settings.mjs';
import { resetView, resizeCanvas, watchDevicePixelRatio } from './camera.mjs';
import { saveAsImage } from './render.mjs';
import { requestRender } from './shared.mjs';

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

exposeGlobals();
buildBrushRing();
bindPickerEvents();
initConnection();
bindUiEvents();
bindDevEvents();
bindSettingsEvents();

// 首屏
renderRecentColors();
refreshRingActive();
updateBrushCursor();
resizeCanvas();
watchDevicePixelRatio();
requestRender();
