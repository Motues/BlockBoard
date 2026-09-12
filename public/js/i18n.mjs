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
    },

    'zh-Hant': {
        'common.online': '線上人數',
        'common.madeBy': 'Made by',
        'common.save': '儲存',
        'common.close': '關閉',
        'common.cancel': '取消',

        'button.menu': '選單',
        'button.devTools': '開發者工具',
        'button.settings': '設定',

        'hint.swipe': '滑動頁面即可創作',
        'hint.paint': '點擊方塊上色，再點一次擦除',
        'hint.zoom': '滾輪 / 雙指縮放棋盤',
        'hint.brush': '右鍵短按選擇畫筆顏色',
        'hint.pan': '右鍵長按拖動來移動棋盤',
        'hint.rgb': '點圓心的彩虹圓選任意 RGB 顏色',
        'hint.eyedropper': '用調色盤裡的吸管複製方塊顏色',

        'option.brushColor': '畫筆顏色',
        'option.resetView': '重設視圖',
        'option.saveImage': '儲存為圖片',
        'option.showHelp': '顯示說明',

        'picker.title': '自訂顏色',
        'picker.recent': '最近使用',
        'picker.done': '完成',
        'picker.eyedropper': '取色器',

        'settings.title': '設定',
        'settings.language': '語言',
        'settings.languageHint': '首次進入依瀏覽器語言自動選擇，之後以此處的選擇為準。',
        'settings.devPassword': '開發者密碼',
        'settings.devPasswordHint': '只儲存在這台裝置的瀏覽器裡，點開發者工具時會用它自動登入；留空儲存即清除。',
        'settings.saved': '設定已儲存',

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
        'dev.exportSelection': '匯出選取範圍',
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
        'dev.tooLarge': '一次修改的方塊太多了',

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
        'common.madeBy': 'Made by',
        'common.save': '保存',
        'common.close': '閉じる',
        'common.cancel': 'キャンセル',

        'button.menu': 'メニュー',
        'button.devTools': '開発者ツール',
        'button.settings': '設定',

        'hint.swipe': 'ページをスワイプして描けます',
        'hint.paint': 'ブロックをクリックして塗り、もう一度クリックで消せます',
        'hint.zoom': 'スクロール / ピンチでボードを拡大縮小',
        'hint.brush': '右ボタンを短く押すとブラシの色を選べます',
        'hint.pan': '右ボタンを長押ししてドラッグするとボードを移動できます',
        'hint.rgb': '中央の虹色の円をクリックすると任意の RGB カラーを選べます',
        'hint.eyedropper': 'パレットのスポイトでブロックの色をコピーできます',

        'option.brushColor': 'ブラシの色',
        'option.resetView': '表示をリセット',
        'option.saveImage': '画像として保存',
        'option.showHelp': 'ヘルプを表示',

        'picker.title': 'カスタムカラー',
        'picker.recent': '最近使用した色',
        'picker.done': '完了',
        'picker.eyedropper': 'スポイト',

        'settings.title': '設定',
        'settings.language': '言語',
        'settings.languageHint': '初回はブラウザの言語に従い、以降はここで選んだ言語が使われます。',
        'settings.devPassword': '開発者パスワード',
        'settings.devPasswordHint': 'このブラウザにのみ保存され、開発者ツールを開くときの自動ログインに使われます。空にして保存すると削除されます。',
        'settings.saved': '設定を保存しました',

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
        'dev.exportSelection': '選択範囲を書き出す',
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
        'dev.tooLarge': '一度に変更するブロックが多すぎます',

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
        'common.madeBy': 'Made by',
        'common.save': '저장',
        'common.close': '닫기',
        'common.cancel': '취소',

        'button.menu': '메뉴',
        'button.devTools': '개발자 도구',
        'button.settings': '설정',

        'hint.swipe': '페이지를 밀어서 그릴 수 있어요',
        'hint.paint': '블록을 클릭해 색칠하고, 다시 클릭하면 지워져요',
        'hint.zoom': '스크롤 / 핀치로 보드를 확대·축소할 수 있어요',
        'hint.brush': '오른쪽 버튼을 짧게 누르면 브러시 색을 고를 수 있어요',
        'hint.pan': '오른쪽 버튼을 길게 누르고 드래그하면 보드를 움직일 수 있어요',
        'hint.rgb': '가운데 무지개 원을 누르면 원하는 RGB 색을 고를 수 있어요',
        'hint.eyedropper': '팔레트의 스포이트로 블록 색을 복사할 수 있어요',

        'option.brushColor': '브러시 색',
        'option.resetView': '보기 초기화',
        'option.saveImage': '이미지로 저장',
        'option.showHelp': '도움말 보기',

        'picker.title': '사용자 지정 색',
        'picker.recent': '최근 사용',
        'picker.done': '완료',
        'picker.eyedropper': '스포이트',

        'settings.title': '설정',
        'settings.language': '언어',
        'settings.languageHint': '첫 방문 시 브라우저 언어를 따르고, 이후에는 여기서 고른 언어가 적용됩니다.',
        'settings.devPassword': '개발자 비밀번호',
        'settings.devPasswordHint': '이 브라우저에만 저장되며, 개발자 도구 버튼을 누를 때 자동 로그인에 사용됩니다. 비워서 저장하면 삭제됩니다.',
        'settings.saved': '설정이 저장되었습니다',

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
        'dev.exportSelection': '선택 영역 내보내기',
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
        'dev.tooLarge': '한 번에 바꾸기에는 블록이 너무 많습니다',

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