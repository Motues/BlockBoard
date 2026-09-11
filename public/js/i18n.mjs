// 界面语言（中文 / English）
//   · 第一次进入按浏览器语言决定：中文环境用中文，其余一律英文
//   · 选择存在 localStorage（blockboard-language），之后可以在设置弹窗里改
//   · 静态文字靠 index.html 上的 data-i18n / data-i18n-title / data-i18n-aria-label /
//     data-i18n-placeholder 属性刷新；动态文字由各模块在"渲染的时候"调用 t()，
//     语言切换时通过 onLangChange 重新渲染一遍

const LANG_KEY = 'blockboard-language';
const SUPPORTED = ['zh', 'en'];
// 除了中文都用英文
const FALLBACK = 'en';

const DICT = {
    en: {
        'common.online': 'Online',
        'common.madeBy': 'Made by',
        'common.save': 'Save',
        'common.close': 'Close',
        'common.cancel': 'Cancel',

        'button.menu': 'Menu',
        'button.devTools': 'Developer tools',
        'button.settings': 'Settings',

        'hint.swipe': 'You can swipe the page to create',
        'hint.paint': 'Click a block to paint, click it again to erase',
        'hint.zoom': 'Scroll or pinch to zoom the board',
        'hint.brush': 'Short press the right button to pick a brush color',
        'hint.pan': 'Hold and drag the right button to move the board',
        'hint.rgb': 'Click the rainbow circle for any RGB color',
        'hint.eyedropper': 'Use the eyedropper in the palette to copy a block color',

        'option.brushColor': 'Brush Color',
        'option.resetView': 'Reset View',
        'option.saveImage': 'Save as Image',
        'option.showHelp': 'Show Help',

        'picker.title': 'Custom color',
        'picker.recent': 'Recent',
        'picker.done': 'Done',
        'picker.eyedropper': 'Eyedropper',

        'settings.title': 'Settings',
        'settings.language': 'Language',
        'settings.languageHint': 'The first visit follows your browser language; the choice made here wins from then on.',
        'settings.devPassword': 'Developer password',
        'settings.devPasswordHint': 'Kept in this browser only, and used to sign in when you click the developer tools button. Save it empty to forget it.',
        'settings.saved': 'Settings saved',

        'dev.mode': 'Developer mode',
        'dev.exit': 'Exit',
        'dev.toolsTitle': 'Developer tools',
        'dev.loginHint': 'Enter the password the server was started with',
        'dev.password': 'Password',
        'dev.login': 'Login',
        'dev.on': 'Developer mode on',
        'dev.off': 'Developer mode off',
        'dev.restored': 'Developer mode session restored',
        'dev.alreadyOn': 'Developer mode is already on — use Exit on the banner to leave',
        'dev.wrongPassword': 'Wrong password, please enter it again',
        'dev.locked': 'Too many attempts, please try again later',
        'dev.disabled': 'This server has the developer tools disabled (set DEV_PASSWORD)',
        'dev.sessionExpired': 'Session expired, please sign in again',
        'dev.opFailed': 'Operation failed',
        'dev.regionNotClosed': 'Region is not closed (it reaches the board edge) — enclose it with a color first',
        'dev.customColor': 'Custom color…',
        'dev.painted': '{label}: {n} cells',
        'dev.fillDone': 'Filled',
        'dev.resetDone': 'Reset',
        'dev.fillRegionDone': 'Closed region filled',
        'dev.needSelection': 'Marquee-select an area first (hold the left button down and drag)',
        'dev.needSelectionShort': 'Marquee-select an area first',
        'dev.selectHint': 'Drag with the left button to select an area, then right-click for the menu',
        'dev.contextHint': 'Right-click a block for the menu, or marquee-select an area first',
        'dev.selected': 'Selected {w} x {h} ({n} cells) — right-click for the menu',
        'dev.fillWithBrush': 'Fill with the brush color',
        'dev.resetBlack': 'Reset to black',
        'dev.exportSelection': 'Export selection',
        'dev.clearSelection': 'Clear selection',
        'dev.selectionTitle': 'Selection {w} x {h} ({n} cells)',
        'dev.blockTitle': 'Block {c}, {r}',
        'dev.fillRegion': 'Fill this closed region with the brush color',
        'dev.fillRegionBlack': 'Fill this closed region with black',
        'dev.useRectangle': 'Use the rectangle instead',
        'dev.noRectangle': 'No rectangle selected yet',
        'dev.noSelection': 'Nothing is selected yet',
        'dev.exportFailed': 'Export failed',
        'dev.exported': 'Exported the {w} x {h} selection',
        'dev.tooLarge': 'That is too many cells to change at once',

        'preset.offWhite': 'Off White (default)',
        'preset.beige': 'Beige',
        'preset.terracotta': 'Terracotta',
        'preset.olive': 'Olive',
        'preset.sage': 'Sage',
        'preset.teal': 'Teal',
        'preset.lavender': 'Lavender',
        'preset.dustyRose': 'Dusty Rose'
    },

    zh: {
        // 页脚和中英文保持一致：作者名不翻译
        'common.online': '在线人数',
        'common.madeBy': 'Made by',
        'common.save': '保存',
        'common.close': '关闭',
        'common.cancel': '取消',

        'button.menu': '菜单',
        'button.devTools': '开发者工具',
        'button.settings': '设置',

        'hint.swipe': '滑动页面即可创作',
        'hint.paint': '点击方块上色，再点一次擦除',
        'hint.zoom': '滚轮 / 双指缩放棋盘',
        'hint.brush': '右键短按选择画笔颜色',
        'hint.pan': '右键长按拖动来移动棋盘',
        'hint.rgb': '点圆心的彩虹圆选任意 RGB 颜色',
        'hint.eyedropper': '用调色盘里的吸管复制方块颜色',

        'option.brushColor': '画笔颜色',
        'option.resetView': '重置视图',
        'option.saveImage': '保存为图片',
        'option.showHelp': '显示帮助',

        'picker.title': '自定义颜色',
        'picker.recent': '最近使用',
        'picker.done': '完成',
        'picker.eyedropper': '取色器',

        'settings.title': '设置',
        'settings.language': '语言',
        'settings.languageHint': '首次进入按浏览器语言自动选择，之后以这里的选择为准。',
        'settings.devPassword': '开发者密码',
        'settings.devPasswordHint': '只保存在这台设备的浏览器里，点开发者工具时会用它自动登录；留空保存即清除。',
        'settings.saved': '设置已保存',

        'dev.mode': '开发者模式',
        'dev.exit': '退出',
        'dev.toolsTitle': '开发者工具',
        'dev.loginHint': '输入服务器预设的密码以开启',
        'dev.password': '密码',
        'dev.login': '登录',
        'dev.on': '已开启开发者模式',
        'dev.off': '已退出开发者模式',
        'dev.restored': '开发者模式仍然有效',
        'dev.alreadyOn': '开发者模式已开启，点提示条上的「退出」可关闭',
        'dev.wrongPassword': '密码不正确，请重新输入',
        'dev.locked': '尝试次数过多，请稍后再试',
        'dev.disabled': '服务端没有启用开发者工具（请设置 DEV_PASSWORD）',
        'dev.sessionExpired': '登录已失效，请重新登录',
        'dev.opFailed': '操作失败',
        'dev.regionNotClosed': '区域没有闭合（连到了棋盘边缘），请先用颜色把区域围起来',
        'dev.customColor': '自定义颜色…',
        'dev.painted': '{label}：{n} 个方块',
        'dev.fillDone': '已填充',
        'dev.resetDone': '已重置',
        'dev.fillRegionDone': '已填充闭合区域',
        'dev.needSelection': '请先左键拖拽框选一块区域',
        'dev.needSelectionShort': '先左键拖拽框选一块区域',
        'dev.selectHint': '左键拖拽框选一块区域，右键打开操作菜单',
        'dev.contextHint': '右键方块打开菜单，或先左键拖拽框选一块区域',
        'dev.selected': '已选中 {w} x {h}（{n} 格），右键打开操作菜单',
        'dev.fillWithBrush': '填成当前画笔色',
        'dev.resetBlack': '重置为黑',
        'dev.exportSelection': '导出选区',
        'dev.clearSelection': '取消选区',
        'dev.selectionTitle': '选区 {w} x {h}（{n} 格）',
        'dev.blockTitle': '方块 {c}, {r}',
        'dev.fillRegion': '填充这个闭合区域（当前画笔色）',
        'dev.fillRegionBlack': '填充这个闭合区域为黑',
        'dev.useRectangle': '改用矩形选区',
        'dev.noRectangle': '还没有矩形选区',
        'dev.noSelection': '还没有选区',
        'dev.exportFailed': '导出图片失败',
        'dev.exported': '已导出 {w} x {h} 的选区',
        'dev.tooLarge': '一次修改的方块太多了',

        'preset.offWhite': '灰白（默认）',
        'preset.beige': '米杏',
        'preset.terracotta': '陶土',
        'preset.olive': '橄榄',
        'preset.sage': '灰绿',
        'preset.teal': '灰青',
        'preset.lavender': '灰紫',
        'preset.dustyRose': '灰粉'
    }
};

let lang = FALLBACK;
const listeners = [];

// 浏览器语言标签（zh-CN / zh-Hans / zh-TW…）统一收敛成支持的两个值
function normalize(value) {
    return String(value || '').trim().toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function readStored() {
    try {
        return localStorage.getItem(LANG_KEY) || '';
    } catch {
        return '';
    }
}

export function getLang() {
    return lang;
}

// 取一段界面文字：t('dev.selected', { w: 3, h: 2, n: 6 })
// 找不到的键直接回显键名，方便开发时发现漏配
export function t(key, params) {
    const table = DICT[lang] || DICT[FALLBACK];
    const text = table[key] !== undefined ? table[key] : DICT[FALLBACK][key];

    if (text === undefined) return key;
    if (!params) return text;

    return text.replace(/\{(\w+)\}/g, (match, name) => (
        params[name] === undefined ? match : String(params[name])
    ));
}

export function onLangChange(handler) {
    if (typeof handler === 'function') listeners.push(handler);
}

// 把 index.html 里带 data-i18n* 的元素刷成当前语言
export function applyStaticI18n(root) {
    const scope = root || document;

    for (const el of scope.querySelectorAll('[data-i18n]')) {
        el.textContent = t(el.dataset.i18n);
    }

    for (const el of scope.querySelectorAll('[data-i18n-title]')) {
        const text = t(el.dataset.i18nTitle);

        // 选项面板里的图标是用 CSS 的 attr(data-title) 画自己的提示气泡的，
        // 这类元素要写回 data-title（写 title 只会多出一个系统原生提示）；
        // 其余元素没有自定义气泡，直接写原生 title
        if (el.hasAttribute('data-title')) el.setAttribute('data-title', text);
        else el.title = text;
    }

    // 只有无障碍读屏用的名字，不会显示成提示气泡
    for (const el of scope.querySelectorAll('[data-i18n-aria-label]')) {
        el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    }

    for (const el of scope.querySelectorAll('[data-i18n-placeholder]')) {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    }
}

function applyLang(next) {
    lang = next;
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';

    applyStaticI18n();
    for (const handler of listeners) handler(next);
}

// 启动时调用：决定这次用什么语言，第一次进入顺便把它存下来
export function initI18n() {
    const stored = readStored();
    const initial = SUPPORTED.indexOf(stored) >= 0
        ? stored
        : normalize(typeof navigator === 'undefined' ? '' : navigator.language);

    if (stored !== initial) {
        try {
            localStorage.setItem(LANG_KEY, initial);
        } catch {
            // 隐私模式下写不了，忽略
        }
    }

    applyLang(initial);
    return initial;
}

// 设置弹窗里改语言（默认同时存到本地）
export function setLang(next, options) {
    const value = SUPPORTED.indexOf(next) >= 0 ? next : normalize(next);

    if (!options || options.persist !== false) {
        try {
            localStorage.setItem(LANG_KEY, value);
        } catch {
            // 忽略
        }
    }

    if (value === lang) {
        applyStaticI18n();
        return value;
    }

    applyLang(value);
    return value;
}
