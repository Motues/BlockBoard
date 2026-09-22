# 前端

## 客户端布局

| 模块 | 职责 |
| --- | --- |
| `main.mjs` | 入口：读 `localStorage`、把各部分接起来并启动首帧 |
| `config.mjs` | 全部常量、预设调色板 `BRUSH_PRESETS` 与单元格取值范围 |
| `shared.mjs` | 运行期共享状态：socket、画布、棋盘几何、视图状态、待确认队列、渲染调度、渲染钩子 |
| `color.mjs` | 颜色计算：`#rrggbb` ↔ 24bit ↔ HSV、单元格取值 ↔ 颜色 |
| `brush.mjs` | 当前画笔与最近颜色列表（持久化） |
| `cursor.mjs` | CSS 光标：画笔圆点，取色模式下换成吸管 |
| `board.mjs` | 棋盘状态解码（含二进制状态）、命中测试、悬停高亮、批量改色广播落地 |
| `camera.mjs` | 视口、缩放/平移边界、棋盘坐标 ↔ 屏幕坐标 |
| `render.mjs` | 棋盘层离屏缓存、1 像素/格 LOD 位图、网格绘制、风车切换动画、PNG 导出、区域导出 |
| `interactions.mjs` | 画布上的指针/触摸/滚轮输入，并把事件转发给开发者工具 |
| `devtools.mjs` | 开发者模式：登录、框选、右键菜单、闭合区域填充、导出 |
| `ring.mjs` | 画笔圆环、选项面板、帮助弹窗 |
| `picker.mjs` | 调色盘、最近颜色色块、取色器模式 |
| `connection.mjs` | socket 事件与全局 UI 绑定；首屏三条路与实时广播落地 |
| `i18n.mjs` | 语言状态、`t()`、`applyStaticI18n()`、`onLangChange()` |
| `settings.mjs` | 居中的设置弹窗 + 浏览器本地开发者密码存取 + 数据导出/导入 |
| `state-cache.mjs` | 棋盘状态 IndexedDB 缓存（增量同步用）、节流写盘；不 import 任何模块 |
| `loader.mjs` | 首屏加载动画：订阅 `connection` 上报的加载状态，就绪后淡出并从 DOM 摘掉 |
| `edge-hint.mjs` | 桌面版 Edge 鼠标手势提示卡片 |
| `toast.mjs` | 底部居中浮层提示，开发者工具与设置共用 |

## 依赖方向

- `shared.mjs` 保存状态与渲染钩子，功能模块从它取状态，彼此不互相 import：各模块用 `setRenderHooks({ paint, needsMoreFrames, markHoverDirty })` 挂进渲染循环，用 `onBrushChange` / `onLangChange` 接收变化。
- 功能模块之间唯一链：`ring → picker → brush → cursor`。
- `i18n ← settings ← devtools`：设置弹窗依赖 i18n，开发者工具依赖设置里的密码存取。`toast` 与 `edge-hint` 是独立叶子，只依赖 `i18n`。
- `connection → loader` 单向：`connection.mjs` 只上报加载状态（`onLoadStatus`），`loader.mjs` 订阅并画。加载状态信号分散在首屏三条路里，反过来让 connection 画 DOM 会把它和界面绑死。
- `state-cache.mjs` 是叶子：`shared.mjs` 顶层 `await` 读它，`connection.mjs` 报“状态变了”，`main.mjs` 喂“当前状态 + epoch/rev”写盘。因为这个顶层 await，导入 `shared.mjs` 的模块都会等缓存读完才开始执行。
- `interactions` 不 import `devtools`：画布左键按下/移动/松手/右键通过 `shared.mjs` 的 `devEvents`（`EventTarget`）转发成 `leftdown` / `leftmove` / `leftup` / `leftcancel` / `contextmenu`，避免成环。

## 功能行为

设置弹窗（`settings.mjs`）三块：语言下拉、开发者密码、数据备份。语言边选边生效（预览），点「关闭」退回打开时那一种；密码与数据备份密码不写进服务端，但只有点「保存」才落盘（`blockboard-dev-password`）。数据备份用同一个开发者密码，不再单独要。左下角是 `BlockBoard | v1.7.0`：两个链接都写在 `index.html` 里（产品名 → 仓库），版本号在 `openSettingsPanel()` 里取 `shared.mjs` 的 `serverInfo.version`（来自 `init-game` 的 `version`，即服务端 `package.json` 的版本）填进 `#settings-version`，并拼成 `releases/tag/v<版本>` 的 href；老服务端不发版本号就把分隔符和版本号一起 `hidden`。hover 时两个链接都由默认的灰变成正文色（`.settings-made-by a:hover`，见 `public/styles.css`）。这行是语言无关的，不参与 i18n。

画笔颜色：

- 预设色编号存 `blockboard-brush-color`，自定义颜色存 `#rrggbb`（`brush.mjs`）。
- 调色盘（`picker.mjs`）打开时起点是“上次确认过的颜色”（`main.mjs` 的 `primePickerBrush`），不是当前画笔 —— 否则选到一半取消会把画笔带歪。
- 色号输入框：`#rgb` / `#rrggbb` 都认，合法值边打边生效，但**不**把输入框改写成 `#rrggbb`；`parseHexColor` 本身认三位简写，一旦在 `input` 时回写，打到第三个字符就会被定成 `#223344`，后面的位再也打不进去。输入期间不合法只标红不提交；收工（回车）才补全成 `#rrggbb`，失焦只提交、不重写用户输入的样子。打字期间 `onBrushChange` 也不回写（`isHexEditing()`），否则每次输入都会把还没打完的值冲掉。
- 取色器（`picker.mjs` 的 `pickCellAt`）：进入取色模式后 `cursor.mjs` 换吸管光标，`board.mjs` 让指向格子放大（`PICK_HOVER_SCALE`，不带波浪动画），旁边跟 `#rrggbb` 小浮窗；点中方块后立刻 `stopPicking()`。这一下不能被当成涂色（原因见画布输入 `pointerPhase`）。
- 最近使用：`blockboard-recent-colors`，`#rrggbb` JSON 数组，最新在前、去重、最多 10 条、跳过纯黑；`brush.mjs` 读写，`picker.mjs` 只渲染。

画笔圆环（桌面端右键短按，阈值见画布输入）：面板里是预设色 + 圆心彩虹圆；移动端圆环是模态的，点圆环外只收圆环、那一下不涂色。

底部「菜单」按钮（`ring.mjs`）：点开选项面板，面板里是画笔颜色/重置视图/保存为图片/显示帮助（+ 移动端多一个「设置」项）。按钮上的「…」与「X」用 `.open` 类做交叉过渡。帮助弹窗 `#hint-popup` 页面加载后 1 秒弹出（`connection.mjs` 的 `bindUiEvents` 里 `setTimeout(showHintPopup, 1000)`），10 秒后自动收起；桌面端与触屏两份文案。「保存为图片」走 `render.mjs` 的 `saveAsImage`，挂在 `window` 上供 `index.html` 内联 `onclick` 调用。

## 渲染调度

渲染循环按需自转：`requestRender()` 只申请一帧，`frame()` 末尾只有 `requiresMoreFrames()` 为真（有风车动画、有待确认回包、或悬停缓动没走完）才继续排下一帧，完全静止时循环停下。任何改变画面状态的入口都必须自己 `requestRender()`。

| 函数 | 用途 | 副作用 |
| --- | --- | --- |
| `requestRender()` | 格子颜色/相机/版面变了 | `markBoardDirty()` 自增 `boardRevision`，棋盘层缓存失效 |
| `requestOverlayRender()` | 只有覆盖层（悬停高亮）变了 | 只排一帧，不动版本号 |

`render.mjs` 的棋盘层缓存（离屏 canvas）靠 `boardRevision` + 相机参数做键：悬停/风车每帧动但棋盘像素没动，那些帧只做一次 `drawImage`。`frame()` 自己续帧时必须用内部 `scheduleFrame()`（不自增版本号），否则每帧打掉缓存；`cleanupAnimations()` 删风车后必须 `markBoardDirty()`，因为它改变“棋盘要跳过哪些格子”的集合。

## 大棋盘渲染

逐格 `fillRect` 成本 O(可见格数)，一两百万格单帧几百毫秒，所以两层处理：

- 逐格路径（格子间距 ≥ `MIN_LINE_PITCH` = 6 物理像素）：只比较格子取值（数字），取值变化时才调用 `valueToColor()`（自定义色拼字符串最贵）。
- LOD 路径（间距更小、连网格线都不画）：把可见范围填进“1 像素/格”的 `ImageData`（`Uint32` 视图按字节序打包 RGBA，`packCell()`），再用 `imageSmoothingEnabled = false` 放大贴上来，成本从 O(格数) 次 `fillRect` 变成 1 次 `drawImage`。位图按 `boardRevision + 可见范围` 缓存，平移时只重填不重新分配。

不能把相邻同色格并成一个 `fillRect`：格子之间那条缝隙就是网格线可见部分，合并会盖掉网格线（缩到看不见网格线的情况已由 LOD 接手）。

## 显隐动画

弹窗一律用 `.hidden` 类切换显隐，“看得见 → 看不见”要渐变，必须同时满足：

1. `.hidden` 里写 `opacity: 0` 和 `visibility: hidden`；
2. 元素自己的 `transition` 里包含 `visibility`（`.glass-panel` 已带）。

`visibility` 是离散属性，单独过渡它时：`visible → hidden` 在过渡结束才真正隐藏，`hidden → visible` 在过渡一开始就可见 —— 正好“先淡出、再隐藏”。只写 `visibility: hidden` 不放进 `transition`，关闭时瞬间消失。

底部菜单按钮「…」与「X」不能用 `display` 硬切（跳一帧）：两个图标绝对定位叠在按钮里，按钮加 `.open` 类，CSS 做 `opacity` + `rotate/scale` 交叉过渡。

## Edge 鼠标手势

Edge 自带「鼠标手势」是浏览器级功能：长按右键拖动会被 Edge 抢去执行手势，网页关不掉、拿不到那次拖动，右键拖动无法平移棋盘。微软确认没有让网页接管右键拖动的接口，只能用户去浏览器设置关，所以客户端只做提示：

- 只在桌面版 Edge 提示：UA 含 `Edg/`（移动端 `EdgA/` / `EdgiOS/`），且 `(hover: hover) and (pointer: fine)`。
- 页面加载 `SHOW_DELAY_MS`（1.6s）后在左下角弹 `#edge-hint`；点「知道了」写 `blockboard-edge-gesture-hint = 1`，之后不再提示。
- 「打开 Edge 设置」按钮：`window.open(SETTINGS_URL)`，`SETTINGS_URL` 是 `edge://settings/appearance/browserBehavior/mouseGestures`。`edge://` 通常打不开（Chromium 会拦），所以无论成功与否都把地址复制到剪贴板，`initEdgeHint()` 还把同一常量写进卡片 `.edge-hint-path`（`index.html` 里那份只是脚本执行前兜底），状态行提示“若没有打开设置页，请粘贴到地址栏”。
- 卡片不 import 任何功能模块：静态文案走 `data-i18n`，点击后状态行用 `t('edgeHint.copied' / 'edgeHint.copyFailed')`。

## 国际化

- 键名固定 `blockboard-language`，支持 `zh` / `zh-Hant` / `en` / `ja` / `ko`。
- 检测规则：先用 `localStorage`；没有或不合法看 `navigator.language`：中文按繁简分流（`zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant*` 算繁体），日、韩各用各的，其余英文，并写回 `localStorage`。
- 静态文字在 `index.html` 标 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`，`applyStaticI18n()` 刷成当前语言。
- 动态文字一律 `t(key, params)`（`{name}` 占位符替换），必须在渲染时调用，不能把结果缓存成常量。
- 语言切换走 `onLangChange(handler)`：`ring` / `picker` / `devtools` 注册回调后重绘自己的文字。静态文案（含 `edge-hint`）由 `applyStaticI18n()` 统一刷新。
- 帮助弹窗 `#hint-popup` 有两份文案：`.hint-text-desktop` 与 `.hint-text-touch`，由 `showHintPopup()` 按 `shared.mjs` 的 `touchDevice` 给弹窗加 `touch` 类决定。键名分开（`hint.click` / `hint.zoom` / `hint.brush` / `hint.pan` / … 与 `hint.tap` / `hint.longPress` / `hint.drag` / `hint.pinch` / `hint.menu`），改操作方式两套都要动。

## 画布输入：桌面端与触屏

| 操作 | 桌面端 | 触屏 |
| --- | --- | --- |
| 涂色/擦除 | 左键点方块 | 轻点方块 |
| 选画笔颜色 | 右键短按呼出圆环 | 长按方块呼出圆环 |
| 平移画布 | 右键长按（或按下后拖动） | 单指拖动 |
| 缩放 | 滚轮 | 双指捏合 |
| 收起圆环 | 右键 / Esc / 点外面 | 点圆环外任意处（圆环模态） |

- 触屏轻点不是 `click` 直接判定：`touchstart` 先把这次按下记成“可能是轻点”（`touchTap`，同时记当时操作模式 `pointerPhase`），`touchend` 才定案 —— 拖动超过 `TOUCH_DRAG_SLOP`、变成双指、或长按生效都会作废。
- `pointerPhase` 必须在下按时记：取色成功后 `pickCellAt` 会立刻 `stopPicking()`，`click` 里再读 `isPickMode()` 已是 false，会把取色那一下当普通涂色。
- 触屏长按阈值 `TOUCH_LONGPRESS_MS = 420`（比右键 220 长，手指会抖）。长按生效后 `suppressTouchContextMenu` 要留到 `onContextMenu` 再清：浏览器补发的 `contextmenu` 在 `touchend` 之后才到，抬手时就清会拦不住。
- 圆环模态：点圆环外只收起、不涂色（`markRingJustClosed()` → `interactions` 里 `consumeRingJustClosed()` 直接 return）；点色块仍正常选中（色块在 `#brush-ring` 内，`onPointerDown` 不会收它）。
- 圆环里的点击（预设色块、圆心彩虹圆）在 `connection.mjs` 的 document 捕获监听里**必须直接放行**（`inRing` 就 return）：控件靠自己的 `click` 干活，如果这里对它们也 `stopPropagation`，触屏上点色块不换色、点圆心调色盘弹不出来 —— 桌面端看起来正常只是因为这层挡不住鼠标 click（触摸的 click 在鼠标事件之后，会被 `stopPropagation` 吞掉）。
- 开发者模式下触屏不接管手势：长按/框选由 `devtools` 负责，这里只记 `pointerPhase`。

## 客户端开发者模式交互

- 入口是底部按钮条里的「开发者工具」按钮（`#devtools-button`，绑定在 `bindDevEvents()`）。按钮条还有「设置」（`#settings-button`）和「菜单」（`#menu-button`）：样式在 `styles.css` 的 `.bottom-button`，三个按钮不显示悬浮提示（只有 `data-i18n-aria-label`）。
- 移动端适配（`@media (hover: none) and (pointer: coarse)`）：`#devtools-button` 直接隐藏（开发者模式依赖左键框选 + 右键菜单），`#settings-button` 也隐藏，但选项面板多一个 `.option-item.mobile-only` 的「设置」项（`#settings-option`，点击先 `closeOptionsPanel()` 再 `openSettingsPanel()`）。
- 左键框选：`beginSelection` / `extendSelection`。长按阈值 `SELECT_LONGPRESS_MS = 260`；按下后移动超过 `RIGHT_DRAG_SLOP = 6` px 立即升级为框选（不必等满长按）；指针离开窗口或窗口失焦时 `interactions` 转发 `leftcancel`，由 `handleLeftCancel` 收尾，否则框选粘在光标上。
- 左键短按（`viewState.hasMoved` 为假）把操作目标切成「该方块所在的闭合区域」，并取消已有矩形选区。
- 右键菜单：填成画笔色、重置为黑、从调色盘选自定义颜色、导出选区/区域、取消选区。菜单里不再列预设调色板颜色，颜色入口只留调色盘（`pushCustomColorAction` → `chooseCustomColor`，选色过程临时借用调色盘，选完把画笔恢复原样，所以开发者工具取色不会改掉用户画笔）。
- 闭合区域 flood fill 在客户端算：`computeClosedRegion` 做“颜色相同 + 四连通”扩散，碰到棋盘边缘判未闭合提示，不算通过；`computeBoundary` 另算一圈轮廓用于高亮。
- 导入换过尺寸后（`board-reset` 只重算几何，不动这里的选区）：放大棋盘时服务端按当前尺寸放行，新范围立刻能用；缩小棋盘时留下的旧选区会被 `selectionInsideBoard` / `allIndicesInsideBoard` 挡下并清掉提示重新框选，不拿越界坐标去撞服务端。
- 导出：`renderRegionToCanvas` + `saveAsPng` 出 PNG，另外把选区取值按二维数组写成 JSON。
- `restoreSession()` 页面加载时调 `GET /api/dev/session`：服务端没启用只记 `devEnabled = false`；启用且本地 token 有效直接进入开发者模式。
- 底部「开发者工具」按钮（`openDevTools`）：本地存过密码就直接 `login(saved, { silent: true })` 换 token，不弹窗；没存过弹密码框，登录成功后把密码写进 `blockboard-dev-password`；服务端 401（`bad-password`）清本地密码并重新弹窗；`locked` / `disabled` 只弹提示。服务端错误码经 `DEV_ERROR_KEYS` 映射成 i18n，服务端 `message` 只当兜底。`login(password, { silent: true })` 静默模式不改屏幕登录框，由调用方决定后续动作。

## 本地存储键

| 键 | 内容 |
| --- | --- |
| `blockboard-dev-token` | 开发者会话 token（服务端内存那份的本地副本） |
| `blockboard-dev-password` | 设置弹窗保存的开发者密码，点开发者工具按钮时自动登录 |
| `blockboard-language` | 界面语言（`zh` / `zh-Hant` / `en` / `ja` / `ko`） |
| `blockboard-brush-color` | 当前画笔：预设存编号，自定义颜色存 `#rrggbb` |
| `blockboard-recent-colors` | 最近使用画笔颜色（`#rrggbb` JSON 数组，最新在前，最多 10 条，跳过纯黑） |
| `blockboard-edge-gesture-hint` | 桌面版 Edge 鼠标手势提示是否已点「知道了」（`1` = 不再提示） |

数据导出/导入没有自己的密码字段：用的就是开发者密码（服务端校验的也是它），所以既不重复输入、也不多存一份。

浏览器隐私模式下 `localStorage` 可能写不进去，所有读写都包 try/catch 并静默忽略。