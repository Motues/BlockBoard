// 界面语言（中文 / 繁體中文 / English / 日本語 / 한국어）
//   · 第一次进入按浏览器语言决定：中文环境用中文（按繁简分流），
//     日/韩环境各用各的，其余一律英文
//   · 选择存在 localStorage（blockboard-language），之后可以在设置弹窗里改
//   · 静态文字靠 index.html 上的 data-i18n / data-i18n-title / data-i18n-aria-label /
//     data-i18n-placeholder 属性刷新；动态文字由各模块在"渲染的时候"调用 t()，
//     语言切换时通过 onLangChange 重新渲染一遍

const LANG_KEY = 'blockboard-language';

// 内部语言码：'zh' 指简体，'zh-Hant' 指繁体
const SUPPORTED = ['zh', 'zh-Hant', 'en', 'ja', 'ko'];

// 除了中文都用英文
const FALLBACK = 'en';

// 设置弹窗里可以直接用这份列表渲染语言选项
export const LANGUAGES = [
    { code: 'zh', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' }
];

const DICT = {
    en: {
        'common.online': 'Online',
        'common.save': 'Save',
        'common.close': 'Close',
        'common.cancel': 'Cancel',

        'button.menu': 'Menu',
        'button.devTools': 'Developer tools',
        'button.settings': 'Settings',

        'hint.click': 'Click a block to paint, click it again to erase',
        'hint.zoom': 'Scroll to zoom the board',
        'hint.brush': 'Short press the right button to pick a brush color',
        'hint.pan': 'Hold and drag the right button to move the board',
        'hint.rgb': 'Click the rainbow circle for any RGB color',
        'hint.eyedropper': 'Use the eyedropper in the palette to copy a block color',
        'hint.shortcuts': 'Keys: C palette · I eyedropper · 1-8 colors · Esc close',
        'hint.tap': 'Tap a block to paint, tap it again to erase',
        'hint.longPress': 'Long press a block to pick a brush color',
        'hint.drag': 'Drag with one finger to move the board',
        'hint.pinch': 'Pinch with two fingers to zoom',
        'hint.menu': 'The button at the bottom right has reset view and save as image',

        'option.brushColor': 'Brush Color',
        'option.resetView': 'Reset View',
        'option.saveImage': 'Save as Image',
        'option.showHelp': 'Show Help',

        'picker.title': 'Custom color',
        'picker.recent': 'Recent',
        'picker.done': 'Done',
        'picker.eyedropper': 'Eyedropper',

        'conn.offline': 'Disconnected from the server — reconnecting…',
        'conn.failed': 'Cannot reach the server (it may not be running)',

        'loading.title': 'Loading board…',
        'loading.connecting': 'Connecting to the server…',
        'loading.receiving': 'Receiving the board…',
        'loading.receivingChunks': 'Receiving the board… {done}/{total}',
        'loading.syncing': 'Syncing the board…',
        'loading.failed': 'Cannot reach the server — still trying…',

        'edgeHint.title': 'Edge mouse gestures block right-drag',
        'edgeHint.text': 'A web page cannot turn off the mouse gestures built into Edge, so holding the right button to drag the board is taken over by the browser. Open the mouse gesture settings below (or paste the address into the address bar) and turn off "Enable mouse gestures"; newer builds also let you add this site to the gesture block list.',
        'edgeHint.open': 'Open Edge settings',
        'edgeHint.dismiss': 'Got it',
        'edgeHint.copied': 'Address copied. If no settings tab opened, paste it into the address bar.',
        'edgeHint.copyFailed': 'Copy failed — type the address above into the address bar.',

        'settings.title': 'Settings',
        'settings.language': 'Language',
        'settings.languageHint': 'The first visit follows your browser language; the choice made here wins from then on.',
        'settings.devPassword': 'Developer password',
        'settings.devPasswordHint': 'Kept in this browser only, and used to sign in when you click the developer tools button. Save it empty to forget it.',
        'settings.saved': 'Settings saved',

        'transfer.title': 'Data backup',
        'transfer.hint': 'Packs game-config.json and the board save into one .bbx file. Importing overwrites the board and game-config.json on the server, so it signs in with the developer password above (save it there first).',
        'transfer.export': 'Export data',
        'transfer.file': 'Choose file…',
        'transfer.import': 'Import save',
        'transfer.importConfirm': 'Overwrite now?',
        'transfer.exporting': 'Exporting…',
        'transfer.importing': 'Importing…',
        'transfer.exported': 'Exported {size}',
        'transfer.imported': 'Imported: board {cols} x {rows}{size}',
        'transfer.sizeChanged': ' (board size changed — all clients resynced)',
        'transfer.noFile': 'Choose a backup file first',
        'transfer.needPassword': 'Enter the developer password above first',
        'transfer.badPassword': 'Wrong developer password',
        'transfer.locked': 'Too many attempts, please try again later',
        'transfer.disabled': 'This server has management disabled (set DEV_PASSWORD)',
        'transfer.badPackage': 'Not a valid BlockBoard backup (the file may be damaged)',
        'transfer.tooLarge': 'That file is too large',
        'transfer.failed': 'Operation failed',

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
        'dev.exportPng': 'Export as image (PNG)',
        'dev.exportJson': 'Export as JSON',
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
        'dev.importJson': 'Import JSON…',
        'dev.importTitle': 'Import selection JSON',
        'dev.importInfo': 'File: {w} x {h} cells, its own origin is ({x}, {y})',
        'dev.importInfoNoOrigin': 'File: {w} x {h} cells (the file has no origin)',
        'dev.importUseFile': 'Use the origin in the file ({x}, {y})',
        'dev.importUseHere': 'Use this position ({x}, {y})',
        'dev.importPick': 'Click the board to choose the origin',
        'dev.importPicking': 'Click the board to place the top-left corner of the JSON (Esc to cancel)',
        'dev.importDone': 'Imported {w} x {h} cells',
        'dev.importBadFile': 'Not a valid selection JSON file',
        'dev.tooLarge': 'That is too many cells to change at once',
        'dev.outOfRange': 'The area is outside the board — select again',

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
        'common.save': '保存',
        'common.close': '关闭',
        'common.cancel': '取消',

        'button.menu': '菜单',
        'button.devTools': '开发者工具',
        'button.settings': '设置',

        'hint.click': '点击方块上色，再点一次擦除',
        'hint.zoom': '滚轮缩放棋盘',
        'hint.brush': '右键短按选择画笔颜色',
        'hint.pan': '右键长按拖动来移动棋盘',
        'hint.rgb': '点圆心的彩虹圆选任意 RGB 颜色',
        'hint.eyedropper': '用调色盘里的吸管复制方块颜色',
        'hint.shortcuts': '快捷键：C 调色盘 · I 取色器 · 1–8 切换颜色 · Esc 关闭',
        'hint.tap': '轻点方块上色，再点一次擦除',
        'hint.longPress': '长按方块选画笔颜色',
        'hint.drag': '单指拖动移动棋盘',
        'hint.pinch': '双指捏合缩放棋盘',
        'hint.menu': '右下角按钮里可以重置视图、保存图片',

        'option.brushColor': '画笔颜色',
        'option.resetView': '重置视图',
        'option.saveImage': '保存为图片',
        'option.showHelp': '显示帮助',

        'picker.title': '自定义颜色',
        'picker.recent': '最近使用',
        'picker.done': '完成',
        'picker.eyedropper': '取色器',

        'conn.offline': '与服务端断开，正在重连…',
        'conn.failed': '连接不上服务器（服务端可能没有在运行）',

        'loading.title': '正在加载画板…',
        'loading.connecting': '正在连接服务器…',
        'loading.receiving': '正在接收画板数据…',
        'loading.receivingChunks': '正在接收画板数据… {done}/{total}',
        'loading.syncing': '正在同步画板数据…',
        'loading.failed': '连接不上服务器，仍在重试…',

        'edgeHint.title': 'Edge 鼠标手势会占用右键拖动',
        'edgeHint.text': '网页无法关闭 Edge 自带的鼠标手势，右键长按拖动会被浏览器抢走，棋盘就拖不动了。打开下面的鼠标手势设置页（或把地址粘贴到地址栏），关掉「启用鼠标手势」；较新版本也可以把本站加入手势阻止列表。',
        'edgeHint.open': '打开 Edge 设置',
        'edgeHint.dismiss': '知道了',
        'edgeHint.copied': '已复制设置地址。若没有打开设置页，请粘贴到地址栏。',
        'edgeHint.copyFailed': '复制失败，请把上面的地址手动输入地址栏。',

        'settings.title': '设置',
        'settings.language': '语言',
        'settings.languageHint': '首次进入按浏览器语言自动选择，之后以这里的选择为准。',
        'settings.devPassword': '开发者密码',
        'settings.devPasswordHint': '只保存在这台设备的浏览器里，点开发者工具时会用它自动登录；留空保存即清除。',
        'settings.saved': '设置已保存',

        'transfer.title': '数据备份',
        'transfer.hint': '把 game-config.json 和棋盘存档打包成一个 .bbx 文件。导入会覆盖服务端的棋盘与 game-config.json，用的是上面那栏的开发者密码（请先保存它）。',
        'transfer.export': '导出数据',
        'transfer.file': '选择文件…',
        'transfer.import': '导入存档',
        'transfer.importConfirm': '确认覆盖？',
        'transfer.exporting': '正在导出…',
        'transfer.importing': '正在导入…',
        'transfer.exported': '已导出 {size}',
        'transfer.imported': '导入完成：棋盘 {cols} x {rows}{size}',
        'transfer.sizeChanged': '（棋盘尺寸已变更，所有客户端已重新同步）',
        'transfer.noFile': '请先选择一个备份文件',
        'transfer.needPassword': '请先在上面填写并保存开发者密码',
        'transfer.badPassword': '开发者密码不正确',
        'transfer.locked': '尝试次数过多，请稍后再试',
        'transfer.disabled': '服务端没有启用管理功能（请设置 DEV_PASSWORD）',
        'transfer.badPackage': '不是有效的 BlockBoard 备份文件（文件可能损坏）',
        'transfer.tooLarge': '文件太大了',
        'transfer.failed': '操作失败',

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
        'dev.exportPng': '导出为图片（PNG）',
        'dev.exportJson': '导出为 JSON',
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
        'dev.importJson': '导入 JSON…',
        'dev.importTitle': '导入选区 JSON',
        'dev.importInfo': '文件：{w} x {h} 个方块，自带起点 ({x}, {y})',
        'dev.importInfoNoOrigin': '文件：{w} x {h} 个方块（文件里没有起点）',
        'dev.importUseFile': '用文件自带的起点 ({x}, {y})',
        'dev.importUseHere': '用当前位置 ({x}, {y})',
        'dev.importPick': '点击棋盘选择起点',
        'dev.importPicking': '左键点击棋盘，放置 JSON 的左上角（Esc 取消）',
        'dev.importDone': '已导入 {w} x {h} 个方块',
        'dev.importBadFile': '不是有效的选区 JSON 文件',
        'dev.tooLarge': '一次修改的方块太多了',
        'dev.outOfRange': '选区超出了棋盘范围，请重新框选',

        'preset.offWhite': '灰白（默认）',
        'preset.beige': '米杏',
        'preset.terracotta': '陶土',
        'preset.olive': '橄榄',
        'preset.sage': '灰绿',
        'preset.teal': '灰青',
        'preset.lavender': '灰紫',
        'preset.dustyRose': '灰粉'
    },

    'zh-Hant': {
        'common.online': '線上人數',
        'common.save': '儲存',
        'common.close': '關閉',
        'common.cancel': '取消',

        'button.menu': '選單',
        'button.devTools': '開發者工具',
        'button.settings': '設定',

        'hint.click': '點擊方塊上色，再點一次擦除',
        'hint.zoom': '滾輪縮放棋盤',
        'hint.brush': '右鍵短按選擇畫筆顏色',
        'hint.pan': '右鍵長按拖動來移動棋盤',
        'hint.rgb': '點圓心的彩虹圓選任意 RGB 顏色',
        'hint.eyedropper': '用調色盤裡的吸管複製方塊顏色',
        'hint.shortcuts': '快速鍵：C 調色盤 · I 吸管 · 1–8 切換顏色 · Esc 關閉',
        'hint.tap': '輕點方塊上色，再點一次擦除',
        'hint.longPress': '長按方塊選畫筆顏色',
        'hint.drag': '單指拖動移動棋盤',
        'hint.pinch': '雙指捏合縮放棋盤',
        'hint.menu': '右下角按鈕裡可以重置視圖、儲存圖片',

        'option.brushColor': '畫筆顏色',
        'option.resetView': '重設視圖',
        'option.saveImage': '儲存為圖片',
        'option.showHelp': '顯示說明',

        'picker.title': '自訂顏色',
        'picker.recent': '最近使用',
        'picker.done': '完成',
        'picker.eyedropper': '取色器',

        'conn.offline': '與伺服器斷開，正在重新連線…',
        'conn.failed': '連不上伺服器（伺服器可能沒有在執行）',

        'loading.title': '正在載入畫板…',
        'loading.connecting': '正在連線伺服器…',
        'loading.receiving': '正在接收畫板資料…',
        'loading.receivingChunks': '正在接收畫板資料… {done}/{total}',
        'loading.syncing': '正在同步畫板資料…',
        'loading.failed': '連不上伺服器，仍在重試…',

        'edgeHint.title': 'Edge 滑鼠手勢會佔用右鍵拖曳',
        'edgeHint.text': '網頁無法關閉 Edge 內建的滑鼠手勢，長按右鍵拖曳會被瀏覽器接管，棋盤就拖不動了。開啟下面的滑鼠手勢設定頁（或把網址貼到網址列），關閉「啟用滑鼠手勢」；較新版本也可以把本站加入手勢封鎖清單。',
        'edgeHint.open': '開啟 Edge 設定',
        'edgeHint.dismiss': '知道了',
        'edgeHint.copied': '已複製設定網址。若沒有開啟設定頁，請貼到網址列。',
        'edgeHint.copyFailed': '複製失敗，請把上面的網址手動輸入網址列。',

        'settings.title': '設定',
        'settings.language': '語言',
        'settings.languageHint': '首次進入依瀏覽器語言自動選擇，之後以此處的選擇為準。',
        'settings.devPassword': '開發者密碼',
        'settings.devPasswordHint': '只儲存在這台裝置的瀏覽器裡，點開發者工具時會用它自動登入；留空儲存即清除。',
        'settings.saved': '設定已儲存',

        'transfer.title': '資料備份',
        'transfer.hint': '把 game-config.json 和棋盤存檔打包成一個 .bbx 檔案。匯入會覆蓋伺服器的棋盤與 game-config.json，用的是上面那欄的開發者密碼（請先儲存它）。',
        'transfer.export': '匯出資料',
        'transfer.file': '選擇檔案…',
        'transfer.import': '匯入存檔',
        'transfer.importConfirm': '確認覆蓋？',
        'transfer.exporting': '正在匯出…',
        'transfer.importing': '正在匯入…',
        'transfer.exported': '已匯出 {size}',
        'transfer.imported': '匯入完成：棋盤 {cols} x {rows}{size}',
        'transfer.sizeChanged': '（棋盤尺寸已變更，所有客戶端已重新同步）',
        'transfer.noFile': '請先選擇一個備份檔案',
        'transfer.needPassword': '請先在上面填寫並儲存開發者密碼',
        'transfer.badPassword': '開發者密碼不正確',
        'transfer.locked': '嘗試次數過多，請稍後再試',
        'transfer.disabled': '伺服器端沒有啟用管理功能（請設定 DEV_PASSWORD）',
        'transfer.badPackage': '不是有效的 BlockBoard 備份檔案（檔案可能損壞）',
        'transfer.tooLarge': '檔案太大了',
        'transfer.failed': '操作失敗',

        'dev.mode': '開發者模式',
        'dev.exit': '離開',
        'dev.toolsTitle': '開發者工具',
        'dev.loginHint': '輸入伺服器預設的密碼以開啟',
        'dev.password': '密碼',
        'dev.login': '登入',
        'dev.on': '已開啟開發者模式',
        'dev.off': '已離開開發者模式',
        'dev.restored': '開發者模式仍然有效',
        'dev.alreadyOn': '開發者模式已開啟，點提示條上的「離開」可關閉',
        'dev.wrongPassword': '密碼不正確，請重新輸入',
        'dev.locked': '嘗試次數過多，請稍後再試',
        'dev.disabled': '伺服器端沒有啟用開發者工具（請設定 DEV_PASSWORD）',
        'dev.sessionExpired': '登入已失效，請重新登入',
        'dev.opFailed': '操作失敗',
        'dev.regionNotClosed': '區域沒有閉合（連到了棋盤邊緣），請先用顏色把區域圍起來',
        'dev.customColor': '自訂顏色…',
        'dev.painted': '{label}：{n} 個方塊',
        'dev.fillDone': '已填充',
        'dev.resetDone': '已重設',
        'dev.fillRegionDone': '已填充閉合區域',
        'dev.needSelection': '請先左鍵拖曳框選一塊區域',
        'dev.needSelectionShort': '先左鍵拖曳框選一塊區域',
        'dev.selectHint': '左鍵拖曳框選一塊區域，右鍵開啟操作選單',
        'dev.contextHint': '右鍵方塊開啟選單，或先左鍵拖曳框選一塊區域',
        'dev.selected': '已選取 {w} x {h}（{n} 格），右鍵開啟操作選單',
        'dev.fillWithBrush': '填成目前畫筆色',
        'dev.resetBlack': '重設為黑',
        'dev.exportPng': '匯出為圖片（PNG）',
        'dev.exportJson': '匯出為 JSON',
        'dev.clearSelection': '取消選取',
        'dev.selectionTitle': '選取範圍 {w} x {h}（{n} 格）',
        'dev.blockTitle': '方塊 {c}, {r}',
        'dev.fillRegion': '填充這個閉合區域（目前畫筆色）',
        'dev.fillRegionBlack': '填充這個閉合區域為黑',
        'dev.useRectangle': '改用矩形選取',
        'dev.noRectangle': '還沒有矩形選取範圍',
        'dev.noSelection': '還沒有選取範圍',
        'dev.exportFailed': '匯出圖片失敗',
        'dev.exported': '已匯出 {w} x {h} 的選取範圍',
        'dev.importJson': '匯入 JSON…',
        'dev.importTitle': '匯入選取範圍 JSON',
        'dev.importInfo': '檔案：{w} x {h} 個方塊，自帶起點 ({x}, {y})',
        'dev.importInfoNoOrigin': '檔案：{w} x {h} 個方塊（檔案裡沒有起點）',
        'dev.importUseFile': '用檔案自帶的起點 ({x}, {y})',
        'dev.importUseHere': '用目前位置 ({x}, {y})',
        'dev.importPick': '點擊棋盤選擇起點',
        'dev.importPicking': '左鍵點擊棋盤，放置 JSON 的左上角（Esc 取消）',
        'dev.importDone': '已匯入 {w} x {h} 個方塊',
        'dev.importBadFile': '不是有效的選取範圍 JSON 檔案',
        'dev.tooLarge': '一次修改的方塊太多了',
        'dev.outOfRange': '選取範圍超出了棋盤，請重新框選',

        'preset.offWhite': '灰白（預設）',
        'preset.beige': '米杏',
        'preset.terracotta': '陶土',
        'preset.olive': '橄欖',
        'preset.sage': '灰綠',
        'preset.teal': '灰青',
        'preset.lavender': '灰紫',
        'preset.dustyRose': '灰粉'
    },

    ja: {
        'common.online': 'オンライン人数',
        'common.save': '保存',
        'common.close': '閉じる',
        'common.cancel': 'キャンセル',

        'button.menu': 'メニュー',
        'button.devTools': '開発者ツール',
        'button.settings': '設定',

        'hint.click': 'ブロックをクリックして塗り、もう一度クリックで消せます',
        'hint.zoom': 'スクロールでボードを拡大縮小',
        'hint.brush': '右ボタンを短く押すとブラシの色を選べます',
        'hint.pan': '右ボタンを長押ししてドラッグするとボードを移動できます',
        'hint.rgb': '中央の虹色の円をクリックすると任意の RGB カラーを選べます',
        'hint.eyedropper': 'パレットのスポイトでブロックの色をコピーできます',
        'hint.shortcuts': 'キー: C パレット · I スポイト · 1–8 色切替 · Esc 閉じる',
        'hint.tap': 'ブロックをタップして塗り、もう一度タップで消せます',
        'hint.longPress': 'ブロックを長押しするとブラシの色を選べます',
        'hint.drag': '1 本指でドラッグするとボードを移動できます',
        'hint.pinch': '2 本指でピンチすると拡大縮小できます',
        'hint.menu': '右下のボタンに表示リセットと画像保存があります',

        'option.brushColor': 'ブラシの色',
        'option.resetView': '表示をリセット',
        'option.saveImage': '画像として保存',
        'option.showHelp': 'ヘルプを表示',

        'picker.title': 'カスタムカラー',
        'picker.recent': '最近使用した色',
        'picker.done': '完了',
        'picker.eyedropper': 'スポイト',

        'conn.offline': 'サーバーとの接続が切れました。再接続中…',
        'conn.failed': 'サーバーに接続できません（起動していない可能性があります）',

        'loading.title': 'ボードを読み込み中…',
        'loading.connecting': 'サーバーに接続しています…',
        'loading.receiving': 'ボードのデータを受信中…',
        'loading.receivingChunks': 'ボードのデータを受信中… {done}/{total}',
        'loading.syncing': 'ボードを同期しています…',
        'loading.failed': 'サーバーに接続できません。再試行中…',

        'edgeHint.title': 'Edge のマウスジェスチャーが右ドラッグを奪います',
        'edgeHint.text': 'Edge 内蔵のマウスジェスチャーは Web ページからは無効にできません。右ボタンを押したままドラッグするとブラウザーに取られて、ボードを動かせません。下のマウスジェスチャー設定ページを開いて（またはアドレスをアドレスバーに貼り付けて）「マウスジェスチャーを有効にする」をオフにしてください。新しいビルドではこのサイトをブロックリストに追加できます。',
        'edgeHint.open': 'Edge の設定を開く',
        'edgeHint.dismiss': '了解',
        'edgeHint.copied': '設定のアドレスをコピーしました。設定ページが開かない場合はアドレスバーに貼り付けてください。',
        'edgeHint.copyFailed': 'コピーできませんでした。上のアドレスをアドレスバーに入力してください。',

        'settings.title': '設定',
        'settings.language': '言語',
        'settings.languageHint': '初回はブラウザの言語に従い、以降はここで選んだ言語が使われます。',
        'settings.devPassword': '開発者パスワード',
        'settings.devPasswordHint': 'このブラウザにのみ保存され、開発者ツールを開くときの自動ログインに使われます。空にして保存すると削除されます。',
        'settings.saved': '設定を保存しました',

        'transfer.title': 'データのバックアップ',
        'transfer.hint': 'game-config.json とボードのセーブデータを 1 つの .bbx ファイルにまとめます。インポートはサーバーのボードと game-config.json を上書きするため、上の開発者パスワードで認証します（先に保存してください）。',
        'transfer.export': 'データを書き出す',
        'transfer.file': 'ファイルを選択…',
        'transfer.import': 'セーブデータを読み込む',
        'transfer.importConfirm': '上書きしますか？',
        'transfer.exporting': '書き出し中…',
        'transfer.importing': '読み込み中…',
        'transfer.exported': '{size} を書き出しました',
        'transfer.imported': '読み込み完了：ボード {cols} x {rows}{size}',
        'transfer.sizeChanged': '（ボードのサイズが変わったため、全クライアントを再同期しました）',
        'transfer.noFile': '先にバックアップファイルを選んでください',
        'transfer.needPassword': '先に上の開発者パスワードを入力して保存してください',
        'transfer.badPassword': '開発者パスワードが正しくありません',
        'transfer.locked': '試行回数が多すぎます。しばらくしてからお試しください',
        'transfer.disabled': 'このサーバーでは管理機能が無効です（DEV_PASSWORD を設定してください）',
        'transfer.badPackage': '有効な BlockBoard のバックアップではありません（ファイルが壊れている可能性があります）',
        'transfer.tooLarge': 'ファイルが大きすぎます',
        'transfer.failed': '操作に失敗しました',

        'dev.mode': '開発者モード',
        'dev.exit': '終了',
        'dev.toolsTitle': '開発者ツール',
        'dev.loginHint': 'サーバーに設定されたパスワードを入力してください',
        'dev.password': 'パスワード',
        'dev.login': 'ログイン',
        'dev.on': '開発者モードをオンにしました',
        'dev.off': '開発者モードをオフにしました',
        'dev.restored': '開発者モードは有効なままです',
        'dev.alreadyOn': '開発者モードはすでにオンです — バナーの「終了」で解除できます',
        'dev.wrongPassword': 'パスワードが正しくありません。もう一度入力してください',
        'dev.locked': '試行回数が多すぎます。しばらくしてからお試しください',
        'dev.disabled': 'このサーバーでは開発者ツールが無効です（DEV_PASSWORD を設定してください）',
        'dev.sessionExpired': 'セッションが切れました。もう一度ログインしてください',
        'dev.opFailed': '操作に失敗しました',
        'dev.regionNotClosed': '領域が閉じていません（ボードの端に接している）— 先に色で領域を囲んでください',
        'dev.customColor': 'カスタムカラー…',
        'dev.painted': '{label}：{n} ブロック',
        'dev.fillDone': '塗りつぶしました',
        'dev.resetDone': 'リセットしました',
        'dev.fillRegionDone': '閉じた領域を塗りつぶしました',
        'dev.needSelection': '先に左ボタンでドラッグして範囲を選択してください',
        'dev.needSelectionShort': '先に左ボタンでドラッグして範囲を選択してください',
        'dev.selectHint': '左ボタンでドラッグして範囲を選択し、右クリックでメニューを開きます',
        'dev.contextHint': 'ブロックを右クリックでメニュー、または先に左ボタンでドラッグして範囲を選択してください',
        'dev.selected': '{w} x {h}（{n} マス）を選択中 — 右クリックでメニュー',
        'dev.fillWithBrush': '現在のブラシ色で塗りつぶす',
        'dev.resetBlack': '黒にリセット',
        'dev.exportPng': '画像（PNG）として書き出す',
        'dev.exportJson': 'JSON として書き出す',
        'dev.clearSelection': '選択を解除',
        'dev.selectionTitle': '選択範囲 {w} x {h}（{n} マス）',
        'dev.blockTitle': 'ブロック {c}, {r}',
        'dev.fillRegion': 'この閉じた領域を現在のブラシ色で塗りつぶす',
        'dev.fillRegionBlack': 'この閉じた領域を黒で塗りつぶす',
        'dev.useRectangle': '矩形選択に切り替える',
        'dev.noRectangle': '矩形選択はまだありません',
        'dev.noSelection': 'まだ選択範囲がありません',
        'dev.exportFailed': '書き出しに失敗しました',
        'dev.exported': '{w} x {h} の選択範囲を書き出しました',
        'dev.importJson': 'JSON を読み込む…',
        'dev.importTitle': '選択範囲の JSON を読み込む',
        'dev.importInfo': 'ファイル: {w} x {h} マス、ファイル内の起点は ({x}, {y})',
        'dev.importInfoNoOrigin': 'ファイル: {w} x {h} マス（ファイルに起点がありません）',
        'dev.importUseFile': 'ファイル内の起点を使う ({x}, {y})',
        'dev.importUseHere': 'この位置を使う ({x}, {y})',
        'dev.importPick': 'ボードをクリックして起点を選ぶ',
        'dev.importPicking': 'ボードをクリックして JSON の左上を置いてください（Esc でキャンセル）',
        'dev.importDone': '{w} x {h} マスを読み込みました',
        'dev.importBadFile': '有効な選択範囲の JSON ファイルではありません',
        'dev.tooLarge': '一度に変更するブロックが多すぎます',
        'dev.outOfRange': '選択範囲がボードの外にあります — 選び直してください',

        'preset.offWhite': 'オフホワイト（既定）',
        'preset.beige': 'ベージュ',
        'preset.terracotta': 'テラコッタ',
        'preset.olive': 'オリーブ',
        'preset.sage': 'セージ',
        'preset.teal': 'ティール',
        'preset.lavender': 'ラベンダー',
        'preset.dustyRose': 'ダスティローズ'
    },

    ko: {
        'common.online': '접속자 수',
        'common.save': '저장',
        'common.close': '닫기',
        'common.cancel': '취소',

        'button.menu': '메뉴',
        'button.devTools': '개발자 도구',
        'button.settings': '설정',

        'hint.click': '블록을 클릭해 색칠하고, 다시 클릭하면 지워져요',
        'hint.zoom': '스크롤로 보드를 확대·축소할 수 있어요',
        'hint.brush': '오른쪽 버튼을 짧게 누르면 브러시 색을 고를 수 있어요',
        'hint.pan': '오른쪽 버튼을 길게 누르고 드래그하면 보드를 움직일 수 있어요',
        'hint.rgb': '가운데 무지개 원을 누르면 원하는 RGB 색을 고를 수 있어요',
        'hint.eyedropper': '팔레트의 스포이트로 블록 색을 복사할 수 있어요',
        'hint.shortcuts': '단축키: C 팔레트 · I 스포이트 · 1–8 색 전환 · Esc 닫기',
        'hint.tap': '블록을 탭해 색칠하고, 다시 탭하면 지워져요',
        'hint.longPress': '블록을 길게 누르면 브러시 색을 고를 수 있어요',
        'hint.drag': '한 손가락으로 드래그하면 보드를 움직일 수 있어요',
        'hint.pinch': '두 손가락으로 벌리거나 오므려 확대·축소할 수 있어요',
        'hint.menu': '오른쪽 아래 버튼에 화면 초기화와 이미지 저장이 있어요',

        'option.brushColor': '브러시 색',
        'option.resetView': '보기 초기화',
        'option.saveImage': '이미지로 저장',
        'option.showHelp': '도움말 보기',

        'picker.title': '사용자 지정 색',
        'picker.recent': '최근 사용',
        'picker.done': '완료',
        'picker.eyedropper': '스포이트',

        'conn.offline': '서버와 연결이 끊어졌습니다. 다시 연결하는 중…',
        'conn.failed': '서버에 연결할 수 없습니다 (서버가 실행 중이 아닐 수 있습니다)',

        'loading.title': '보드를 불러오는 중…',
        'loading.connecting': '서버에 연결하는 중…',
        'loading.receiving': '보드 데이터를 받는 중…',
        'loading.receivingChunks': '보드 데이터를 받는 중… {done}/{total}',
        'loading.syncing': '보드를 동기화하는 중…',
        'loading.failed': '서버에 연결할 수 없습니다. 계속 재시도 중…',

        'edgeHint.title': 'Edge 마우스 제스처가 오른쪽 드래그를 가로챕니다',
        'edgeHint.text': 'Edge에 내장된 마우스 제스처는 웹 페이지에서 끌 수 없습니다. 오른쪽 버튼을 누른 채 드래그하면 브라우저가 가로채서 보드를 움직일 수 없습니다. 아래 마우스 제스처 설정 페이지를 열고(또는 주소를 주소 표시줄에 붙여넣고) 「마우스 제스처 사용」을 끄세요. 최신 버전에서는 이 사이트를 차단 목록에 추가할 수도 있습니다.',
        'edgeHint.open': 'Edge 설정 열기',
        'edgeHint.dismiss': '확인',
        'edgeHint.copied': '설정 주소를 복사했습니다. 설정 페이지가 열리지 않으면 주소 표시줄에 붙여넣으세요.',
        'edgeHint.copyFailed': '복사하지 못했습니다. 위 주소를 주소 표시줄에 직접 입력하세요.',

        'settings.title': '설정',
        'settings.language': '언어',
        'settings.languageHint': '첫 방문 시 브라우저 언어를 따르고, 이후에는 여기서 고른 언어가 적용됩니다.',
        'settings.devPassword': '개발자 비밀번호',
        'settings.devPasswordHint': '이 브라우저에만 저장되며, 개발자 도구 버튼을 누를 때 자동 로그인에 사용됩니다. 비워서 저장하면 삭제됩니다.',
        'settings.saved': '설정이 저장되었습니다',

        'transfer.title': '데이터 백업',
        'transfer.hint': 'game-config.json과 보드 저장 데이터를 하나의 .bbx 파일로 묶습니다. 가져오기는 서버의 보드와 game-config.json을 덮어쓰므로 위의 개발자 비밀번호로 인증합니다(먼저 저장해 주세요).',
        'transfer.export': '데이터 내보내기',
        'transfer.file': '파일 선택…',
        'transfer.import': '저장 데이터 가져오기',
        'transfer.importConfirm': '덮어쓸까요?',
        'transfer.exporting': '내보내는 중…',
        'transfer.importing': '가져오는 중…',
        'transfer.exported': '{size} 내보냈습니다',
        'transfer.imported': '가져오기 완료: 보드 {cols} x {rows}{size}',
        'transfer.sizeChanged': ' (보드 크기가 바뀌어 모든 클라이언트를 다시 동기화했습니다)',
        'transfer.noFile': '먼저 백업 파일을 선택하세요',
        'transfer.needPassword': '먼저 위에 개발자 비밀번호를 입력해 저장하세요',
        'transfer.badPassword': '개발자 비밀번호가 올바르지 않습니다',
        'transfer.locked': '시도 횟수가 너무 많습니다. 나중에 다시 시도해 주세요',
        'transfer.disabled': '이 서버는 관리 기능이 비활성화되어 있습니다 (DEV_PASSWORD 설정 필요)',
        'transfer.badPackage': '유효한 BlockBoard 백업이 아닙니다 (파일이 손상되었을 수 있습니다)',
        'transfer.tooLarge': '파일이 너무 큽니다',
        'transfer.failed': '작업 실패',

        'dev.mode': '개발자 모드',
        'dev.exit': '나가기',
        'dev.toolsTitle': '개발자 도구',
        'dev.loginHint': '서버에 설정된 비밀번호를 입력하세요',
        'dev.password': '비밀번호',
        'dev.login': '로그인',
        'dev.on': '개발자 모드를 켰습니다',
        'dev.off': '개발자 모드를 종료했습니다',
        'dev.restored': '개발자 모드가 계속 유지됩니다',
        'dev.alreadyOn': '개발자 모드가 이미 켜져 있습니다 — 배너의 「나가기」를 눌러 종료하세요',
        'dev.wrongPassword': '비밀번호가 올바르지 않습니다. 다시 입력해 주세요',
        'dev.locked': '시도 횟수가 너무 많습니다. 나중에 다시 시도해 주세요',
        'dev.disabled': '이 서버는 개발자 도구가 비활성화되어 있습니다 (DEV_PASSWORD 설정 필요)',
        'dev.sessionExpired': '로그인이 만료되었습니다. 다시 로그인해 주세요',
        'dev.opFailed': '작업 실패',
        'dev.regionNotClosed': '영역이 닫히지 않았습니다 (보드 가장자리에 닿아 있음) — 먼저 색으로 영역을 둘러싸 주세요',
        'dev.customColor': '사용자 지정 색…',
        'dev.painted': '{label}: {n}개 블록',
        'dev.fillDone': '채웠습니다',
        'dev.resetDone': '초기화했습니다',
        'dev.fillRegionDone': '닫힌 영역을 채웠습니다',
        'dev.needSelection': '먼저 왼쪽 버튼을 누른 채 드래그해 영역을 선택하세요',
        'dev.needSelectionShort': '먼저 왼쪽 버튼으로 드래그해 영역을 선택하세요',
        'dev.selectHint': '왼쪽 버튼으로 드래그해 영역을 선택한 뒤 오른쪽 클릭으로 메뉴를 여세요',
        'dev.contextHint': '블록을 오른쪽 클릭해 메뉴를 열거나, 먼저 왼쪽 버튼으로 드래그해 영역을 선택하세요',
        'dev.selected': '{w} x {h} ({n}칸) 선택됨 — 오른쪽 클릭으로 메뉴를 여세요',
        'dev.fillWithBrush': '현재 브러시 색으로 채우기',
        'dev.resetBlack': '검은색으로 초기화',
        'dev.exportPng': '이미지(PNG)로 내보내기',
        'dev.exportJson': 'JSON으로 내보내기',
        'dev.clearSelection': '선택 해제',
        'dev.selectionTitle': '선택 영역 {w} x {h} ({n}칸)',
        'dev.blockTitle': '블록 {c}, {r}',
        'dev.fillRegion': '이 닫힌 영역을 현재 브러시 색으로 채우기',
        'dev.fillRegionBlack': '이 닫힌 영역을 검은색으로 채우기',
        'dev.useRectangle': '사각형 선택으로 바꾸기',
        'dev.noRectangle': '아직 사각형 선택 영역이 없습니다',
        'dev.noSelection': '아직 선택된 영역이 없습니다',
        'dev.exportFailed': '내보내기 실패',
        'dev.exported': '{w} x {h} 선택 영역을 내보냈습니다',
        'dev.importJson': 'JSON 가져오기…',
        'dev.importTitle': '선택 영역 JSON 가져오기',
        'dev.importInfo': '파일: {w} x {h}칸, 파일의 시작점은 ({x}, {y})',
        'dev.importInfoNoOrigin': '파일: {w} x {h}칸 (파일에 시작점이 없음)',
        'dev.importUseFile': '파일의 시작점 사용 ({x}, {y})',
        'dev.importUseHere': '현재 위치 사용 ({x}, {y})',
        'dev.importPick': '보드를 클릭해 시작점 선택',
        'dev.importPicking': '보드를 클릭해 JSON의 왼쪽 위를 놓으세요 (Esc 취소)',
        'dev.importDone': '{w} x {h}칸을 가져왔습니다',
        'dev.importBadFile': '유효한 선택 영역 JSON 파일이 아닙니다',
        'dev.tooLarge': '한 번에 바꾸기에는 블록이 너무 많습니다',
        'dev.outOfRange': '선택 영역이 보드 범위를 벗어났습니다 — 다시 선택해 주세요',

        'preset.offWhite': '오프화이트 (기본)',
        'preset.beige': '베이지',
        'preset.terracotta': '테라코타',
        'preset.olive': '올리브',
        'preset.sage': '세이지',
        'preset.teal': '틸',
        'preset.lavender': '라벤더',
        'preset.dustyRose': '더스티 로즈'
    }
};

// 某个语言缺键时的兜底顺序（繁体不会掉到简体，免得繁简混排）
const FALLBACK_CHAIN = {
    zh: ['zh', 'en'],
    'zh-Hant': ['zh-Hant', 'en'],
    en: ['en'],
    ja: ['ja', 'en'],
    ko: ['ko', 'en']
};

// <html lang> 用的标签
const HTML_LANG = {
    zh: 'zh-CN',
    'zh-Hant': 'zh-Hant',
    en: 'en',
    ja: 'ja',
    ko: 'ko'
};

let lang = FALLBACK;
const listeners = [];

// 浏览器语言标签（zh-CN / zh-Hans / zh-TW / zh-Hant-HK / ja-JP / ko-KR…）
// 统一收敛成内部支持的五个值
function normalize(value) {
    const tag = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    if (!tag) return FALLBACK;

    // 中文先分繁简：zh-TW / zh-HK / zh-MO / zh-Hant / zh-Hant-HK 都算繁体，
    // 其余（zh、zh-CN、zh-Hans、zh-SG…）算简体
    if (tag === 'zh' || tag.startsWith('zh-')) {
        return /^zh-(hant|tw|hk|mo)(-|$)/.test(tag) ? 'zh-Hant' : 'zh';
    }

    if (tag === 'ko' || tag.startsWith('ko-')) return 'ko';
    if (tag === 'ja' || tag.startsWith('ja-')) return 'ja';

    // 除了中文/日文/韩文都用英文
    return 'en';
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
    const chain = FALLBACK_CHAIN[lang] || [lang, FALLBACK];
    let text;

    for (const code of chain) {
        const table = DICT[code];
        if (table && table[key] !== undefined) {
            text = table[key];
            break;
        }
    }

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
    document.documentElement.lang = HTML_LANG[next] || next;

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