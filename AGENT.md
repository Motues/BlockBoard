# BlockBoard 设计与架构（AGENT 参考）

本文写给参与开发的贡献者和 AI agent；面向使用者的说明在 [README.md](./README.md) / [README.zh-CN.md](./README.zh-CN.md)，本文只讲实现细节。

## 项目结构

服务端按功能拆分，依赖方向单向（`server` → `board-sync` → `board-state` → `board-persist` / `board-config`）：

- `src/server.ts` —— 入口：Hono 应用、静态资源、socket.io 连线、启动与退出。只做装配。
- `src/board-config.ts` —— 棋盘配置，以及**可下发给客户端的配置**（`publicConfig()` 剥离 `devPassword`）。敏感字段只有这一个出口。配置是**运行期可变**的（数据导入会换掉它），所以别把 `rows` / `cols` 缓存成常量，用 `liveConfig` / `getTotalSquares()` / `publicConfig()` 取当前值。
- `src/board-persist.ts` —— 存档读写（v3 / v2 / 老格式）与尺寸变更时的重排，以及把配置写回 `game-config.json`（`writeGameConfig`）。
- `src/board-state.ts` —— 棋盘状态：格子数据、epoch / `syncRev`、全盘编码快照缓存、改色、广播合并、自动存档、导入时的整盘替换（`replaceGrid`）。不 import socket。
- `src/board-sync.ts` —— socket.io 协议：首屏状态下发（单帧 / 分块 / 增量）、实时广播、增量日志、令牌桶、导入后的全员重同步（`resetBoardForClients`）。
- `src/board-transfer.ts` —— 数据导出 / 导入的打包文件格式（BBEX）与导入的应用 + 回滚。
- `src/state.ts` —— 取值约定与编解码（24bit / 4bit / 1bit、RLE、批量差量 runs、重排）。编码一律先出 `Buffer`（`encodeStateBuffer` / `encodeLegacyStateBuffer` / `encodeRleBuffer`），字符串版只是它的 base64 包装；存档是带 magic、尺寸、epoch、rev 与 deflate 的 v3 格式（`buildSaveFile` / `parseSaveFile`，v2 也能读）。
- `src/dev-api.ts` —— 开发者工具的服务端部分：密码解析（`resolveDevPassword()`）、密码换 token、token 校验、批量改色接口、数据导出 / 导入接口。
- `src/minify.ts` —— 前端资源压缩：启动时用 esbuild 把 `public/` 下的 js / css 去注释、压行、改局部变量名，结果常驻内存后由中间件发出（见下文「前端资源压缩」）。
- `public/` —— 纯 ES module 客户端，无打包、无构建步骤，由 `public/index.html` 通过 `public/js/main.mjs` 加载。**源码就是发给浏览器的那一套的可读版本**，压缩只发生在发送时，磁盘上不做中间产物。
- `game-config.json` —— 棋盘尺寸、端口、开发者密码、会话时长。
- `data/` —— 运行时生成的存档目录（`board-state.dat`、`board-size.json`），不进版本库。
- [FEATURE.md](./FEATURE.md) —— 还没做的同步优化（分块下发 / 增量同步 / 瓦片）。

`board-state` 需要广播或写盘时，通过 `initBoardState()` 注入的回调（`onFlushPending` / `onPersist` / `onRegionPaint`）回调到 `server.ts`，从而不必反过来 import `board-sync`。

> `init-game` 下发的 `config` 走 `publicConfig()`，**不再包含 `devPassword`**：以前直接把 `game-config.json` 整个 spread 进去，
> 等于把开发者密码明文发给每个客户端（浏览器控制台里就能看到）。加字段时注意别再把敏感项塞进 `gameConfig` 直接下发。

## 静态资源与缓存（`src/server.ts`）

`public/**` 由 `serveStatic` 托管；在它前面挂了一层中间件，给 `.html / .js / .mjs / .css / .json`
加 `Cache-Control: no-cache`（浏览器每次回源校验）。Hono 的 serveStatic 不发 ETag、也不处理
条件请求，所以实际效果接近"每次都重新下载"——本地/局域网这点开销可以忽略。

**为什么必须有它**：这个项目没有打包步骤，模块之间是裸的相对路径 `import`（`./shared.mjs`），
URL 上挂不了版本号（只有入口 `main.js?v=x` 与 `styles.css?v=x` 有）。只靠 `Last-Modified` 的话，
浏览器会按启发式把旧模块缓存住，出现"新页面 + 旧模块"的混合，整个模块图会加载失败，
表现就是**画布和在线人数都不出来**（`node --check` 与静态检查都发现不了），而且普通刷新未必恢复。
踩过一次，**别删这层中间件**。

前端还会显式报连接状态（`connection.mjs`）：`disconnect` / `connect_error` 时把在线人数显示成 `—`
并弹一次 toast（10 秒节流）。这样"服务端没在运行"和"页面坏了"能一眼分开。

### 前端资源压缩（`src/minify.ts`）

发给浏览器的 js / css 是**运行时压过一遍的**：启动时 `minifyPublicAssets()` 用 esbuild 的
`transform`（不打包）把 `public/js/*.mjs` 与 `public/styles.css` 逐个压成一行、去掉注释、
局部变量改名，结果放进 `minified`，由挂在 `serveStatic` **之前**的 `serveMinified()` 直接发出。
实测 21 个文件 262 KB → 119 KB（-55%），启动时几十毫秒，之后每个文件只压一次，全在内存里。

几个必须记住的点：

- **中间件要在模块顶层 `app.use` 注册**，不能在压缩完成后再注册：Hono 的中间件栈在第一个请求
  进来时就定下来了，之后 `app.use` 不再生效 —— 踩过一次，表现是"日志说压好了，页面拿到的还是源码"。
  所以传进 `serveMinified()` 的是 `() => minified`（每请求取一次），压完之前返回 `null`、请求自动
  回落到源码，页面不会因为压缩没做完而打不开。
- `target` 必须写 `esnext`：客户端有顶层 await（`shared.mjs` 顶层读 IndexedDB），写 `es2020`
  会直接报 "Top-level await is not available" 把整个文件跳过（踩过一次）。
- `charset` 必须写 `utf8`：esbuild 默认 `ascii`，会把中日韩文案转成 `\uXXXX`，`i18n.mjs`
  压完反而更大。
- 压缩**只压不改结构**：不打包，每个 `.mjs` 仍是独立 ES module，相对路径 `import` 照旧。
  代价是**跨模块的导入 / 导出名保留原名**（`initBoardLoader`、`t`… 在 Network 面板里仍然可读），
  真正的"混淆"需要打包成单文件才能做到 —— 那会改掉本项目"裸相对路径 import"的部署形态，没做。
- 某个文件压失败只记一行日志并跳过（照旧发源码），`minifyPublicAssets()` 不抛错；
  esbuild 是**运行时依赖**（放在 `dependencies` 里），生产装包只装 dependencies 时压缩才有效。

## 客户端布局

| 模块 | 职责 |
| --- | --- |
| `main.mjs` | 入口：读 `localStorage`、把各部分接起来并启动首帧 |
| `config.mjs` | 全部常量、预设调色板 `BRUSH_PRESETS` 与单元格取值范围 |
| `shared.mjs` | 运行期共享状态：socket、画布、棋盘几何、视图状态、待确认队列、渲染调度、渲染钩子 |
| `color.mjs` | 颜色计算：`#rrggbb` ↔ 24bit ↔ HSV、单元格取值 ↔ 颜色 |
| `brush.mjs` | 当前画笔与最近颜色列表（持久化） |
| `cursor.mjs` | CSS 光标：画笔圆点，取色模式下换成吸管 |
| `board.mjs` | 棋盘状态解码（含二进制状态）、命中测试、悬停高亮、批量改色广播的落地 |
| `camera.mjs` | 视口、缩放 / 平移边界、棋盘坐标 ↔ 屏幕坐标 |
| `render.mjs` | 棋盘层离屏缓存、1 像素/格 的 LOD 位图、网格绘制、风车切换动画、PNG 导出、区域导出 |
| `interactions.mjs` | 画布上的指针 / 触摸 / 滚轮输入，并把事件转发给开发者工具 |
| `devtools.mjs` | 开发者模式：登录、框选、右键菜单、闭合区域填充、导出 |
| `ring.mjs` | 画笔圆环、选项面板、帮助弹窗 |
| `picker.mjs` | 调色盘、最近颜色色块、取色器模式 |
| `connection.mjs` | socket 事件与全局 UI 绑定；首屏状态的三条路（单帧 / 分块 / 增量）与实时广播的落地 |
| `i18n.mjs` | 语言状态、`t()`、`applyStaticI18n()`、`onLangChange()` |
| `settings.mjs` | 居中的设置弹窗 + 浏览器本地的开发者密码存取 + 数据导出 / 导入（复用同一个密码，不重复输入） |
| `state-cache.mjs` | 棋盘状态的 IndexedDB 缓存（增量同步用）、节流写盘；不 import 任何模块 |
| `loader.mjs` | 首屏加载动画（logo + 外面一圈 3×3 圆点胀缩，`#board-loader`）：订阅 `connection` 上报的加载状态，就绪后淡出并从 DOM 摘掉 |
| `edge-hint.mjs` | 桌面版 Edge 的鼠标手势提示卡片（含跳转 Edge 设置的按钮） |
| `toast.mjs` | 底部居中的浮层提示，开发者工具与设置共用 |

### 依赖方向

- `shared.mjs` 保存状态与渲染钩子，功能模块一律从它取状态，**彼此之间不互相 import**：
  各模块用 `setRenderHooks({ paint, needsMoreFrames, markHoverDirty })` 挂进渲染循环，
  用 `onBrushChange` / `onLangChange` 之类的监听器接收变化。
- 功能模块之间的链只有一条：`ring → picker → brush → cursor`。
- `i18n ← settings ← devtools`：设置弹窗依赖 i18n，开发者工具依赖设置里的密码存取。
  `toast` 与 `edge-hint` 是独立叶子，只依赖 `i18n`。
- `connection → loader`（单向）：`connection.mjs` 只**上报**加载状态（`onLoadStatus`），
  `loader.mjs` 订阅它并负责画。加载状态的信号分散在首屏的三条路里，反过来让 connection
  去画 DOM 会把它和界面绑死，所以这里刻意做成单向的（见下文「首屏加载动画」）。
- `state-cache.mjs` 是叶子（**不 import 任何模块**，避免和 `shared.mjs` 成环）：
  `shared.mjs` 在顶层 `await` 里读它（握手要带上缓存里的 epoch / rev），
  `connection.mjs` 往里报"状态变了"，`main.mjs` 把"当前状态 + epoch/rev"喂给它写盘。
  因为这个顶层 `await`，导入 `shared.mjs` 的模块都会等缓存读完才开始执行 —— 反正拿到
  `init-game` 之前棋盘也没法画。
- `interactions` 不 import `devtools`：画布上的左键按下 / 移动 / 松手 / 右键通过 `shared.mjs` 的
  `devEvents`（一个 `EventTarget`）转发成 `leftdown` / `leftmove` / `leftup` / `leftcancel` / `contextmenu`
  事件，避免 `interactions ←→ devtools` 成环。

### 客户端功能行为

设置弹窗（`settings.mjs`）里有三块：语言下拉、开发者密码、数据备份。语言是**边选边生效**的
（预览），点「关闭」会退回打开弹窗时的那一种；密码与数据备份的密码都不写进服务端，
但**只有点「保存」才会落盘**（`blockboard-dev-password`）。数据备份用的是同一个开发者密码，
不再单独要一遍（见「数据导出 / 导入」）。

画笔颜色：

- 预设色编号存在 `blockboard-brush-color`，自定义颜色存 `#rrggbb`（`brush.mjs`）。
- 调色盘（`picker.mjs`）打开时的起点是"上次确认过的颜色"（`main.mjs` 里的 `primePickerBrush`），
  不是当前画笔 —— 否则选到一半取消会把画笔也带歪。
- **取色器**（`picker.mjs` 的 `pickCellAt`）：进入取色模式后 `cursor.mjs` 换吸管光标，
  `board.mjs` 让指向的格子放大（用 `PICK_HOVER_SCALE`，不带平时的波浪动画），
  旁边跟一个显示 `#rrggbb` 的小浮窗；点中方块后立刻 `stopPicking()`。
  注意这一下**不能被当成涂色**（原因见「画布输入」里的 `pointerPhase`）。
- **最近使用**：`blockboard-recent-colors`，`#rrggbb` 的 JSON 数组，最新在前、去重、最多 10 条、
  跳过纯黑（黑色是擦除色）；`brush.mjs` 负责读写，`picker.mjs` 只负责渲染。

画笔圆环（桌面端右键短按，阈值见「画布输入」的表格）：面板里是预设色 + 圆心彩虹圆；
移动端圆环是**模态**的，点圆环外只收圆环、那一下不涂色。

底部「菜单」按钮（`ring.mjs`）：点开选项面板，面板里是画笔颜色 / 重置视图 / 保存为图片 / 显示帮助
（+ 移动端多一个「设置」项）。按钮上的「…」与「X」是用 `.open` 类做交叉过渡的（见「显隐动画」）。
帮助弹窗 `#hint-popup` 在页面加载后 1 秒弹出（`connection.mjs` 的 `bindUiEvents` 里
`setTimeout(showHintPopup, 1000)`），10 秒后自动收起；**桌面端与触屏两份文案**（见「国际化」）。
「保存为图片」走 `render.mjs` 的 `saveAsImage`，它挂在 `window` 上供 `index.html` 的内联 `onclick` 调用。

> README 里只写"右键短按呼出圆环""点彩虹圆选任意颜色"这类操作说明，具体阈值、localStorage 键、
> 函数名都放这里 —— 用户不需要知道 220 ms 和 6 px 这两个数。

### 首屏加载动画（`loader.mjs` + `index.html` 的 `#board-loader`）

网络不好时，页面要等 `init-game` / `state-chunk…state-done` 把状态传完才有东西可画。
这段时间用一层全屏遮罩盖住，中间就是**一圈 3×3 的圆点在胀缩** —— 就是 `.loader` 那一段。
（原来中间还压着一个 `logo-dark.svg`，已经去掉了：现在点阵自己占据正中。）

- **`styles.css` 里 `.loader` + `@keyframes l26` 是外部示例原样搬来的**，
  `index.html` 里就一个 `<div class="loader"></div>`。**要改动画先照着示例改，别自己另起一套** ——
  这个片段本身就是能跑的成品，改之前先确认"确实非改不可"。
- 示例的几何（九条偏移、spread、`border-radius`、时长）**一字未改**；
  相对示例动了三处，每一处上面都有注释写明理由：
  - `color: #000 → inherit`（黑底上看不见）。点是**每条投影各自带色**的，
    所以这句现在只是示例留下的兜底（见下面"九个点各有各的颜色"）。
  - `height: 4px` **必须加**：示例把 box 当行内元素用，而这个 div 是块级 —— 块级的 `width`
    管不住高度，它会先撑满父容器、再由 `aspect-ratio: 1` 把高度也撑起来，
    于是九条 `box-shadow` 是从一个几十 px 的大盒子开始量的，整片点阵直接偏掉。
    写死 height 之后 box 才真是"4px 的一个点"。
  - `translateX(-38px) → translate(-7px, 31px)`：**居中全靠这一行**，且两个轴都要管
    （所以从 `translateX` 变成 `translate`），推导见下一条。
- **九点阵不是九个元素**，是一个 4px 的透明 box + 九条 `box-shadow`：
  x 分量 19 / 38 / 57、y 分量 -19 / 0 / 19，中位那档没写（那正是 box 自己，而它没有背景）。
  点径 = `4px + spread × 2`，所以 `spread 0px → 4px`、`spread 5px → 14px`，
  关键帧就是在 4px 和 14px 之间来回插值 —— **点本身在变大变小**（这正是"呼吸"）。
- **九个点各有各的颜色**，顺序 = 左→右、上→下，用的就是 `logo-dark.svg` 的配色：

  | | 左 | 中 | 右 |
  | --- | --- | --- | --- |
  | 上 | `#e7e7eb` | `#62c976` | `#e7e7eb` |
  | 中 | `#cf8e15` | `#e7e7eb` | `#599bfc` |
  | 下 | `#e7e7eb` | `#e7e7eb` | `#c084fc` |

  颜色写在**每条 box-shadow 自己身上**（`<x> <y> <blur> <spread> <color>`），
  不能靠 `color` 继承 —— 继承了就九点同色。代价是 7 处（基础态 + 6 个关键帧）
  各写一遍，**改颜色要 7 处一起改**。`.loader` 里那句 `color: inherit` 现在只是示例留下的兜底。
- **别把它当成描边**：`box-shadow` 从元素边缘往外长，填的是投影自己的形状；
  之前有一版用"透明方块 + 只加 spread 的投影"做，看着就像一圈白描边在闪，
  跟这里"底下一个实在的点在胀"不是一回事。
- **居中怎么来的**（改动画前先看这段，因为这几个数互相咬合）：
  整个动画里点阵的包围盒是 `x 19..71`、`y -19..33`（按九条的偏移 + 最大 14px 的点算；
  列偏移全是正的、只有顶行那个 `-19` 是负的，所以**包围盒并不以 box 为中心**），
  两个方向都是 52px，中心落在 element 左上角 +(45, 7) 处。
  再配合 `.board-loader-box`（76px 的定位盒，50% + 负 margin 摆到 spinner 正中，
  盒心在 spinner 正中、也就是盒坐标的 (38, 38)），让包围盒中心对上盒心就能解出：
  `element 左上角 = (38 - 45, 38 - 7) = (-7, 31)` —— 这正是写进 CSS 的
  `translate(-7px, 31px)`。7 帧逐帧验过，整片包围盒中心与 spinner 中心偏差为 0。
  一句话：**动点径、任何一档偏移或 spread，都要按这个式子重算 translate，别照抄。**
- 动的只有 `box-shadow`；点小、数量少，主线程正忙时够用。
- `loader.mjs` 与这套标记无关（它只管显隐/文案），换动画不用动脚本。

- 标记**直接写在 HTML 里**（不是脚本建的），所以从首屏第一帧就看得见；同时它挡住画布交互 ——
  状态没到位之前点方块本来也没意义。
- **状态由 `connection.mjs` 上报**（`onLoadStatus`，另一种形状 `{ type: 'receive', done, total }`
  带分块进度，`null` = 棋盘已就绪）：`'connect'` / `'receive'` / `'sync'` / `'failed'`。
  三条首屏路径都要上报，加新路径时别漏。`loader.mjs` 只订阅、只画，不碰 socket。
- **最短展示时间**（`MIN_VISIBLE_MS`，700 ms）：就绪得再快也先停一下，否则一闪而过像故障。
  `shownAt` 在**模块执行时**就记下来（`main.mjs` 一开始就 import 它），别挪到 `initBoardLoader()` 里
  —— 那样前面同步初始化的耗时会算进去。
- 就绪后加 `.hidden` 淡出，再自己从 DOM 里摘掉（`FADE_OUT_MS` 要和 CSS 的 transition 对齐）。
  `.hidden` 里的 `visibility` 也必须一起过渡，理由见上面「显隐动画」。
- 连不上时文案变成"连接不上服务器，仍在重试…"（`loading.failed`），**不会**自己消失；
  重连成功时 `connect` 事件会把它复位成"连接中"。
- 文案用 `t()` 动态渲染（`onLangChange(render)`），**不能**用 `data-i18n` —— 状态行会随事件变，
  `data-i18n` 只在 `applyStaticI18n()` 时刷一次。
- `prefers-reduced-motion: reduce` 下**不停掉**（它本身就在表达"还在动"），只是把点阵放慢到
  1/4 速（2s → 8s）。
- `initBoardLoader()` 必须在 `initConnection()` **之前**调用：首屏的 `init-game` 可能紧接着就来，
  挂晚了会漏掉"棋盘已就绪"那一条，遮罩就一直转下去。

### 渲染调度（`shared.mjs`）

渲染循环是"按需自转"的：`requestRender()` 只申请一帧，`frame()` 末尾只有
`requiresMoreFrames()` 为真（有风车动画、有待确认的回包、或还有悬停缓动没走完）才会继续排下一帧，
完全静止时循环会停下来。所以**任何改变画面状态的入口都必须自己 `requestRender()`**。

两个入口，别用错：

| 函数 | 用途 | 副作用 |
| --- | --- | --- |
| `requestRender()` | 格子颜色 / 相机 / 版面变了 | `markBoardDirty()` 自增 `boardRevision`，棋盘层缓存失效 |
| `requestOverlayRender()` | 只有覆盖层（悬停高亮）变了 | 只排一帧，不动版本号 |

`render.mjs` 的棋盘层缓存（离屏 canvas）就是靠 `boardRevision` + 相机参数做键的：
悬停/风车每帧都在动，但棋盘像素没动，所以那些帧只做一次 `drawImage`。
`frame()` 自己续帧时必须用内部的 `scheduleFrame()`（不自增版本号），
否则每帧都会把缓存打掉；而 `cleanupAnimations()` 删掉一个风车后**必须** `markBoardDirty()`，
因为它改变了"棋盘要跳过哪些格子"这个集合。

### 大棋盘的渲染（`render.mjs`）

逐格 `fillRect` 的成本是 O(可见格数)，一两百万格时单帧就是几百毫秒，所以有两层处理：

- **逐格路径**（格子间距 ≥ `MIN_LINE_PITCH` = 6 物理像素）：只比较格子取值（数字），
  取值变化时才调用 `valueToColor()`（自定义色要拼字符串，是最贵的一笔）；
- **LOD 路径**（间距更小、连网格线都不画了）：把可见范围填进一张"1 像素/格"的 `ImageData`
  （`Uint32` 视图按字节序打包 RGBA，`packCell()`），再用 `imageSmoothingEnabled = false`
  放大贴上来，成本从 O(格数) 次 `fillRect` 变成 1 次 `drawImage`。位图按
  `boardRevision + 可见范围` 缓存，平移时只重填不重新分配。

注意**不能**把相邻同色格并成一个 `fillRect`：格子之间那条缝隙就是网格线的可见部分，
合并会把网格线盖掉（缩到看不见网格线的情况已经由 LOD 接手）。

### 显隐动画（`styles.css`）

弹窗一律用 `.hidden` 类切换显隐，"看得见 → 看不见"要能渐变，必须同时满足两点：

1. `.hidden` 里写 `opacity: 0` **和** `visibility: hidden`；
2. 元素自己的 `transition` 里**包含 `visibility`**（`.glass-panel` 已经带上了）。

`visibility` 是离散属性，单独过渡它时：`visible → hidden` 会在过渡结束那一刻才真正隐藏，
`hidden → visible` 会在过渡一开始就可见 —— 正好实现"先淡出、再隐藏"。
只写 `visibility: hidden` 而不把它放进 `transition`，关闭时元素会瞬间消失，看不到任何动画。

底部菜单按钮的「…」与「X」也不能用 `display` 硬切（会跳一帧）：两个图标都绝对定位叠在按钮里，
按钮上加 `.open` 类，由 CSS 做 `opacity` + `rotate/scale` 的交叉过渡。

## Edge 鼠标手势（`edge-hint.mjs`）

Edge 自带的「鼠标手势」是**浏览器级**功能：长按右键拖动会被 Edge 抢去执行手势，网页既关不掉它、
也拿不到那次拖动，右键拖动因此无法平移棋盘。微软只在 [Microsoft Q&A](https://learn.microsoft.com/zh-cn/answers/questions/2393531/edge-3d-javascript)
里确认"没有让网页接管右键拖动的接口"，只能由用户自己去浏览器设置里关，所以客户端只做提示：

- 只在**桌面版 Edge** 上提示：UA 里含 `Edg/`（移动端是 `EdgA/` / `EdgiOS/`），
  并且要求 `(hover: hover) and (pointer: fine)`。
- 页面加载 `SHOW_DELAY_MS`（1.6s）后在左下角弹出卡片 `#edge-hint`；点「知道了」写
  `blockboard-edge-gesture-hint = 1`，之后不再提示。
- 「打开 Edge 设置」按钮：`window.open(SETTINGS_URL)`，其中 `SETTINGS_URL` 是
  `edge://settings/appearance/browserBehavior/mouseGestures`（设置 → 外观 → 鼠标手势）。
  `edge://` 是浏览器内部页面，网页通常打不开（Chromium 会拦掉），所以**无论成功与否**
  都把地址复制到剪贴板，`initEdgeHint()` 还会把同一个常量写进卡片的 `.edge-hint-path`
  （`index.html` 里那份只是脚本执行前的兜底），状态行提示"若没有打开设置页，请粘贴到地址栏"。
- 卡片不 import 任何功能模块：静态文案走 `data-i18n`，只有点击后的状态行用
  `t('edgeHint.copied' / 'edgeHint.copyFailed')`。

## 国际化（`i18n.mjs`）

- 键名固定为 `blockboard-language`，支持 `zh` / `zh-Hant` / `en` / `ja` / `ko` 五个值。
- 检测规则：先用 `localStorage` 里的值；没有（或值不合法）就看 `navigator.language`：
  中文按繁简分流（`zh-TW` / `zh-HK` / `zh-MO` / `zh-Hant*` 算繁体），日、韩各用各的，
  **其余一律英文**，并把这个结果写回 `localStorage`。
- 静态文字在 `index.html` 上标 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`，
  `applyStaticI18n()` 统一刷成当前语言。
- 动态文字一律用 `t(key, params)`（`{name}` 占位符替换），**必须在渲染时调用**，不能把结果缓存成常量，
  否则切换语言不会更新。
- 语言切换走 `onLangChange(handler)`：`ring` / `picker` / `devtools` 注册回调后重绘自己的文字。
  静态文案（含 `edge-hint` 卡片）由 `applyStaticI18n()` 在切换时统一刷新，不需要自己注册。
- 帮助弹窗（`#hint-popup`）有**两份文案**：`.hint-text-desktop` 与 `.hint-text-touch`，
  由 `showHintPopup()` 按 `shared.mjs` 的 `touchDevice` 给弹窗加 `touch` 类决定显示哪一份。
  两套的键名是分开的（`hint.click` / `hint.zoom` / `hint.brush` / `hint.pan` / … 与
  `hint.tap` / `hint.longPress` / `hint.drag` / `hint.pinch` / `hint.menu`），
  改操作方式时两套都要动，别只改一份。

## 状态格式（`src/state.ts`）

每格一个 24bit 值（存在 `Uint32Array` 里，只用低 24 位）：

| 取值 | 含义 |
| --- | --- |
| `0x000000` | 黑色（默认底色） |
| `0x000001..0x00000F` | 预设颜色编号（调色板在 `public/js/config.mjs` 的 `BRUSH_PRESETS`，目前 8 色） |
| `>= 0x000010` | 自定义颜色，值本身就是 24bit RGB |

预设编号占了 `0x00..0x0F` 这 16 个码位，自定义颜色必须避开：落到 `0x000000..0x00000F`
（肉眼看都是纯黑）的颜色在存储时抬到 `0x000010`，读出来是 `#000010`，肉眼分辨不出。
旧客户端只认 4bit 编号，自定义颜色在它们眼里统一是 `0x0F`（`toLegacyIndex`）。

存档：

- `data/board-state.dat` —— **v3 格式**：`'BBS3'` + 1 字节 flags（位 0 = 载荷是 24bit/格）
  + `uint32LE cols` + `uint32LE rows` + `uint32LE epoch` + `uint32LE rev` + `deflate(裸状态字节)`，共 21 字节头。
  带自定义颜色就写 24bit（3 字节/格），否则写 4bit/格（每字节两格，前一个格子放低 4 位），文件小 6 倍且旧版本程序也能读。
  写盘是「先写 `.tmp` 再 `rename`」（原子替换，崩了不会留半个文件），并且**只有棋盘真的变了才写**
  （`stateRev !== savedRev` 才动手）；写之前会先把排队中的单格广播 flush 掉，保证文件里的 `rev` 与状态配套。
- `epoch` / `rev` 是给增量同步用的（见下文）：服务端重启后**沿用存档里的 epoch / rev**，
  客户端拿着同样的版本号回来时可以直接"什么都不用传"；棋盘尺寸变了则换一个新 epoch（客户端缓存一律作废）。
  v2 存档（13 字节头、没有 epoch / rev）也能读，读出来 epoch = 0 / rev = 0，服务端会换一个新 epoch。
- `data/board-size.json` —— 这份存档对应的 `{ cols, rows }`。启动时先写一次，
  每次自动存档（每 60 秒）时一起更新；它主要是给**旧格式**存档消歧用的（新格式的尺寸在文件头里）。
- 自动存档：`setInterval(saveState, 60s)`，`saveState()` 第一件事就是比较 `stateRev` 与 `savedRev`，
  没改动直接返回 —— 不再每分钟重写一次几 MB 的文件。

旧存档仍然能读（`loadState`）：先试 `parseSaveFile`（v3 / v2）；都不是就把整个文件当成 base64 文本，
交给 `decodeState` 按字节长度依次判定 **24bit（3 字节/格）→ 32bit（4 字节/格，高 8 位是自定义颜色标记）
→ 4bit（每字节两格）→ 1bit（每字节八格）**。
判定顺序很关键：先看字节数是否正好等于某种格式在当前配置下的长度，都不匹配再尝试反推格子数，
否则「比当前棋盘小的 4bit 存档」会被当成 24bit 读出乱码。字节数不足以反推尺寸时用
`board-size.json` 里的上一个配置消歧，仍然没有就按更常见的 4bit 读。
旧存档会在下一次真正发生改动时被自动写成 v3（不需要手动迁移）。

改棋盘尺寸（`game-config.json` 的 `rows` / `cols` 变了）时按**左上角对齐**重排（`regridState`）：
逐行整段搬运，棋盘变大时右下角补黑，变小时丢弃超出部分，重叠区域颜色原样保留。
不能只按一维数组截断 / 补零 —— 列数一变一维下标与二维行列就对不上，整幅画会斜着错位。
v2 存档的尺寸是精确的；旧格式存档尺寸靠字节长度推断：24bit / 4byte 布局精确，只改行数也精确；
唯一无法还原的是「4bit 或 1bit 存档且列数也变了」，那种情况退化成逐格裁剪 / 补黑（改动前的旧行为）。

> 上面这套「尺寸变了就重排」的重排逻辑有**两个**入口：启动时读盘发现尺寸不符，以及
> 数据导入（`board-transfer.ts` 里显式调用 `regridState`，尺寸没变也走一遍把长度裁准）。
> 两条路的行为刻意保持一致，改的时候别只改一条。
> 另外 `gridState` 是 `Uint32Array` 的 `let` 绑定（`getGridState()`）：导入会整块换掉它，
> 任何在模块顶层缓存数组引用的写法都会在导入后失效。

## Socket 事件（`src/board-sync.ts`）

| 事件 | 方向 | 载荷 |
| --- | --- | --- |
| `init-game` | server → client | `{ config, black, maxColorIndex, rgbSupport, epoch, rev, stateMode }` + 状态。`stateMode` 说明状态怎么给：`inline`（`stateRgb` + `stateEncoding` 一条消息装下）、`chunks`（后面跟 `state-chunk` ... `state-done`）、`client`（本机已有状态，后面跟 `sync-delta` / `sync-done`）。`stateRgb` 声明了 `bin` 能力时是**二进制附件**（浏览器里收到 `ArrayBuffer`），否则是 base64 文本；没声明 `rgb24` 的旧页面收到旧字段 `state`（4bit base64） |
| `state-chunk` | server → client | `{ seq, rowStart, rows, encoding, data }` —— 分块下发的一块，`encoding` 为 `rle` / `dense`（带 `-bin` 后缀表示二进制）；跳过计数相对**本块起点**，客户端按行偏移套用 |
| `state-done` | server → client | `{ rev }` —— 分块下发收齐。客户端这时才认版本号，并回放缓冲的实时广播 |
| `sync-delta` | server → client | `{ from, to, patches: [{ event, payload }, ...] }` —— 增量同步：把日志里的状态变更按顺序重放（`event` 就是 `update-square` / `update-squares` / `update-region`），分批发送 |
| `sync-done` | server → client | `{ rev }` —— 增量补完（或本来就不需要补） |
| `sync-request` | client → server | `{ epoch, rev }` —— 客户端主动要一次重新同步：版本号对得上就走增量，对不上就发全量。缓存坏了、尺寸对不上时用 |
| `paint-square` | client → server | `{ index, brush }`（预设编号）或 `{ index, rgb }`（自定义 24bit）；与画笔同色则擦成黑色，否则涂成画笔色 |
| `toggle-square` | client → server | `index` —— 最早的黑白切换协议，仍然接受 |
| `update-square` | server → client | `{ index, value, rgb, isBlack, rev }`；`rgb` 是自定义颜色的 24bit 值（否则 `null`），`value` / `isBlack` 是给未刷新旧页面的兼容字段。单格改动走这条 |
| `update-squares` | server → client | `{ cells: [[index, value], ...], rev }`，一个广播窗口内的多条单格改动合并成一条；`value` 就是格子取值本身，只发给声明了 `batch` 的客户端 |
| `paint-rejected` | server → client | `{ index }` —— 这次点击被令牌桶挡掉了，客户端据此把乐观风车收回去 |
| `online-users` | server → client | 当前在线人数。**别用 `volatile`**：socket.io 在传输层正在写（例如刚发出的 CONNECT 应答）时会把 volatile 包直接丢掉，而这个人数只在连接 / 断开时各发一次，丢了就永远补不上（踩过这个坑） |
| `update-region` | server → client | 开发者工具的批量改色广播，矩形 `{ start, runs, value, rgb, isBlack, rev }`，闭合区域 `{ indices, runs: '', value, rgb, isBlack, rev }` |
| `board-reset` | server → client | 数据导入完成：`{ config, epoch, rev, total }`。客户端据此丢掉本地缓存与棋盘、清空待确认队列，然后主动发 `sync-request` 要全量（epoch 已经换了，服务端一定走全量那条路）。**为什么不让服务端直接推**：全量可能是几 MB 还要分块，由客户端主动要更省事，也复用了「中途断线就重新要一次」的既有逻辑 |

握手：客户端用 `io({ auth: (done) => done({ caps, epoch, rev }) })` 声明能力并报上自己的状态版本。
**必须是回调式（或对象式），不能写成 `auth: () => ({ ... })`**：socket.io-client 4.8 在
`onopen` 里只判断 `typeof this.auth == "function"`，是函数就调用 `this.auth(callback)`、
否则直接发 `this.auth` 本身，**完全不看返回值**。写成"返回对象"的箭头函数不会报错，
但 CONNECT 包永远发不出去 —— 表现是传输层已连上（`connected` 仍为 false）、`init-game` 收不到，
于是棋盘空白、在线人数停在 `...`、导出图片报 `board not ready`（踩过这个坑）。

| 能力 | 含义 |
| --- | --- |
| `rgb24` | 认识 24bit 取值与 3 字节/格 的稠密状态，服务端因此发 `stateRgb` 而不是旧字段 `state` |
| `rle` | 额外认识 RLE 紧凑状态 |
| `bin` | 状态用二进制发（`stateEncoding` / `encoding` 带 `-bin` 后缀），省掉 base64 的 33% 与客户端的 `atob` |
| `batch` | 认识合并广播 `update-squares` |
| `chunk` | 认识分块下发（`state-chunk` / `state-done`），大棋盘不会一次性塞一条几 MB 的消息 |
| `sync` | 认识增量同步（`sync-delta` / `sync-done`） |

`auth` 里的 `epoch` / `rev` 是客户端**已经持有**的状态版本：报不出可信的值时就报 `0` / `-1`
（`syncInfo.claimable` 为假），服务端据此直接发全量 —— 详见下面的"首屏状态下发的三条路"。

RLE 紧凑状态：每个色块三个 varint `[跳过多少个黑格, 连续多少格, 颜色值]`，没被提到的格子保持黑色。
空棋盘零字节，稀疏棋盘几十字节；只有「每个格子颜色都不同」的噪点棋盘会比稠密格式更大，
这时 `encodeCompactState` 退回 3 字节/格的稠密格式，所以载荷永远不会比朴素编码更大。
大消息另外交给 WebSocket 的 `perMessageDeflate`（engine.io `perMessageDeflate`，阈值 1 KiB）再压一遍。

### 状态快照缓存与广播节奏

- **快照缓存**：全盘编码（RLE / 稠密 / 4bit）按 `stateRev` 缓存，并且**按需**计算 ——
  先只算 RLE，稠密格式的字节数是固定的（格子数 × 3），比长度就能决定用哪个，不用先编码出来。
  以前每个新连接都要现算两套全盘编码，百万格的棋盘就是每连接好几 MB 的临时内存与几十万次 varint 写。
- **广播合并**：单格改动先进 `pendingSquares`（`Map<index, value>`，同一格只留最后一次），
  `BROADCAST_WINDOW_MS`（16 ms）后统一发出。窗口里只有一格就沿用 `update-square`（最常见，
  老页面照旧）；多格时给 `batch` 客户端发一条 `update-squares`，给其它客户端逐格补发 `update-square`。
- **令牌桶限流**：每个连接 `PAINT_BURST`（60）容量、`PAINT_PER_SECOND`（30）补充，
  正常点击远远用不满；被挡掉时回 `paint-rejected`，客户端立刻收起乐观动画而不是等 8 秒超时。
  `sync-request` 另有一个更严的限流（连发 5 次、每 3 秒补 1 次），别让它逼服务端反复编码整盘。
- `maxHttpBufferSize: 1e6` 显式写明上行单条消息上限；`stateRev` 同时是自动存档的脏标记。

### 首屏状态下发的三条路（`sendInitialState`）

`stateRev` 与 `syncRev` 是**两个**计数器，别混：

| 计数器 | 何时 +1 | 用途 |
| --- | --- | --- |
| `stateRev` | 每次改色 | 全盘编码快照的缓存键、自动存档的脏标记 |
| `syncRev` | **每次发出**一条状态变更消息 | 增量同步的版本号（客户端缓存拿它对账） |

分开的原因：单格改动会在 `pendingSquares` 里排 16 ms 的队，`stateRev` 已经涨了但消息还没发出去；
客户端能报出来的版本号必须是"消息版本"，否则会出现"我拿到 rev N，但其实缺一条消息"。
因此发快照 / 存档之前都先 `flushSquareUpdates()`，保证 `syncRev` 与快照内容配套。

三条路（按客户端握手里的 epoch / rev 决定）：

1. **`stateMode: 'client'` + `sync-done`** —— epoch 一致且 `clientRev === syncRev`：什么都不用传。
2. **`stateMode: 'client'` + `sync-delta`** —— epoch 一致、`clientRev` 还在 patch 日志覆盖范围内：
   按 `patchLog` 重放版本号更大的消息（每条消息自带 `rev`）。日志是条数 + 字节数双上限的环形缓冲，
   `patchLogCovers()` 的判定是 `log[0].rev <= rev + 1`（最老那条之前的改动已经被挤掉了）。
3. **全量** —— 其余情况：状态小于 `CHUNK_THRESHOLD_BYTES`（96 KB）时一条 `init-game` 装下；
   否则（且客户端声明了 `chunk`）走 `sendChunkedState()`：按 `CHUNK_TARGET_BYTES`（64 KB）折算成
   若干行一块，每块独立编码（RLE / 稠密取小的），块间 `setImmediate` 让出事件循环。

客户端的对应实现（`connection.mjs`）：

- `stateMode: 'client'` 时**优先用内存里那份状态**（断线重连，页面没刷新），只有内存里没有完整状态时
  才从 IndexedDB 缓存恢复 —— 缓存是节流写的（最多落后几秒），拿它盖内存会把新改动冲掉。
  缓存也解不出来（尺寸不符 / 残缺）就发 `sync-request` 要全量。
- `stateMode: 'chunks'` 期间把实时广播**缓冲**起来（`bufferedEvents`），`state-done` 时先回放再认版本号：
  顺序反了的话，中间那一刻会声称"我已经到 rev X"，其实还差几条缓冲消息，重连时服务端就不补了。
- 版本号一律用 `setSyncRev()` 取 `max`：差量是绝对写入，乱序 / 重复应用都安全，但版本号不能倒退。
- `syncInfo.claimable` 表示"我报出去的 epoch / rev 有没有本机完整状态兜底"：分块下发中途为假，
  这时握手只能报 `epoch 0 / rev -1`，否则服务端会把差量套在一份残缺的棋盘上。
- 缓存写盘由 `main.mjs` 注入的 provider 提供内容，`connection.mjs` 只负责在状态变化时
  `markCacheDirty()`；`visibilitychange` / `pagehide` 时立即 flush 一次。

还没做的部分（断点续传、哈希校验、瓦片）在 [FEATURE.md](./FEATURE.md) 里。

## 开发者工具（`src/dev-api.ts`）

密码来源优先级（`resolveDevPassword`）：

1. 环境变量 `DEV_PASSWORD`（`source: 'env'`）；
2. `game-config.json` 的 `devPassword`（`source: 'config'`）；
3. 都没有 —— 开发者工具整个关闭，登录接口返回 503 `disabled`。

数据导出 / 导入**不要求先登录开发者模式**：它们只认当次请求头 `x-dev-password`
（`guardAdminPassword`），而这份密码与登录用的开发者密码**是同一个**（服务端只有这一份），
失败次数也与登录共用同一份按 IP 的记录（5 次锁 5 分钟）。客户端的做法是复用设置里
已保存的开发者密码（`getSavedDevPassword()`）：没保存过就提示先在上面填好并保存，
**不**在数据备份这边另存一份、也不替用户偷偷登录换 token。

- 登录成功下发 `crypto.randomBytes(32).toString('hex')` 的随机 token，只存在内存（`Map<token, expiresAt>`），
  有效期 `devSessionHours`（默认 8 小时，最小 1 小时），后台每 30 分钟清理一次过期项（定时器 `unref()`，不拖住进程退出）。
- 请求带 `x-dev-token` 头（也接受 `Authorization: Bearer`）。
- 密码比对用 `crypto.timingSafeEqual`；长度不同时先比长度（`timingSafeEqual` 长度不等会抛错）。
- 失败锁定按 IP（优先 `x-forwarded-for` 的第一段，否则统一记作 `local`）：连续失败 5 次锁定 5 分钟，
  锁定期过后记录清零。成功登录会清掉该 IP 的失败记录。
- 退出登录立刻作废 token；服务端重启后所有 token 失效。
- `MAX_REGION_CELLS = 200000`：单次批量操作的格子上限，矩形按 `width * height` 算，区域按 `cells.length` 算。

HTTP 端点：

| 端点 | 请求体 | 说明 |
| --- | --- | --- |
| `POST /api/dev/login` | `{ password }` | 返回 `{ ok, token, expiresAt }`；503 = 未启用，401 = 密码错误，429 = 该 IP 已锁定 |
| `POST /api/dev/logout` | –（token 在 `x-dev-token`） | 作废 token |
| `GET /api/dev/session` | – | `{ ok, enabled, active, config: { cols, rows } }`（尺寸取**当前生效**的配置） |
| `POST /api/dev/paint` | `{ x0, y0, x1, y1, color }` 或 `{ cells: [], color }` | 应用改动并返回 `{ ok, changed, range }`；503 = 未启用，401 = token 失效 |
| `POST /api/dev/export` | –（密码在 `x-dev-password`） | 返回打包文件（`application/octet-stream` + `Content-Disposition`）；401 = 密码错误，429 = 已锁定，503 = 未启用 |
| `POST /api/dev/import` | multipart 的 `package` 文件（密码在 `x-dev-password`，也接受表单里的 `password` 字段） | 覆盖 `game-config.json` 与存档，返回 `{ ok, configBytes, saveBytes, cols, rows, sizeChanged }`；400 = 包损坏 / 配置非法 / 存档对不上，413 = 文件太大 |

`range` 是给客户端「本机先套用一遍，不等广播绕一圈」用的，所以矩形分支除了 `{ start, width, height, runs }`
还会带上 `value` / `rgb` / `isBlack`（与广播同一套取值）—— 少了颜色字段，客户端就会用
`applyRegionPayload` 的兜底色（1 号色）涂一遍。闭合区域分支的 `range` 只有 `{ runs: '', spread: true }`，
本机套用是空操作，实际落地靠 `update-region` 广播（它带着 `indices`）。

`color` 与单元格取值同一套约定：`0` 黑、`1..15` 预设编号、`>= 16` 为 24bit RGB。
矩形坐标会被规范化（`min` / `max`），越界返回 400 `out-of-range`。

## 数据导出 / 导入（`src/board-transfer.ts`）

设置弹窗里的「数据备份」：把 `game-config.json` 与 `data/board-state.dat` 打包成一个 `.bbx`
文件，导入时由服务端解析、覆盖两者。**要密码**：就是开发者密码 —— 客户端复用设置里那份
已保存的（`blockboard-dev-password`），不重复让用户输第二遍。

BBEX 容器（小端，零依赖，不用 zip）：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 4 | magic `'BBEX'` |
| 4 | 2 | 格式版本（当前 1） |
| 6 | 4 | config 字节数 |
| 10 | 4 | save 字节数（0 = 包里没有存档） |
| 14 | 32 | SHA-256(config) |
| 46 | 32 | SHA-256(save)（save 为空时是全 0） |
| 78 | config | `game-config.json` 文本（**导出时已剥离 `devPassword`**） |
| … | save | `data/board-state.dat` 原样（v3 自带 deflate，不再二次压缩） |

magic / 版本 / 长度之和 / 两个校验和逐项校验，任一不符都当「包已损坏」拒绝（400 `bad-package`），
不会去猜内容。客户端的界面行为（`settings.mjs`）：

- **导出**：`POST /api/dev/export` 拿到 blob 后走 `<a download>`，文件名取响应头
  `Content-Disposition`（服务端生成 `BlockBoard-<yyyyMMdd-HHmmss>.bbx`），失败时把服务端返回的
  `error` 码经 `TRANSFER_ERROR_KEYS` 映射成 i18n 文案。
- **导入**：**点第一下只是确认**（按钮变成「确认覆盖？」，`armed` 类，3 秒后自动收回），
  第二下才真的上传 —— 它会覆盖服务端数据，值得多问一次。上传用 `FormData` 的 `package` 字段。
- 导入成功后的状态行显示新的棋盘尺寸，并且**不会**说"密码改了"或"端口改了"：
  `devPassword` 被保留、`port` 是监听端口（改不了，要重启）。

几个刻意的取舍：

- **`devPassword` 既不导出也不导入**：导出文件可能被随手转发，带上管理密码等于泄露；
  而导入别人给的包会把自己的密码换掉、被锁在开发者工具外面。`applyImport` 用
  `PRESERVED_FIELDS` 把服务器**当前**的值（`liveConfig.devPassword`）合并进新配置。
- **导入是实时生效的**：`writeGameConfig()` 原子写盘 → `setLiveConfig()` 换掉运行期配置 →
  `replaceGrid()` 按新尺寸重排状态、换新 epoch、`syncRev` 归零并立刻写盘 →
  `resetBoardForClients()` 广播 `board-reset`。所以改了尺寸**不用重启**，在线客户端也会
  自动重同步。注意这要求 `rows` / `cols` 是运行期取值：`TOTAL_SQUARES` 常量已经删掉，
  一律走 `getTotalSquares()`，`gridState` 也从 `const` 变成 `let` + `getGridState()`
  （`board-sync` 的收发、`board-state` 的改色与编码都取当前引用）。
- **失败要回滚**：先写文件再换内存；内存那步抛错就把 `game-config.json` 还原回原始字节、
  运行期配置也退回旧的。这样不会留下「文件是新配置、服务端按旧配置跑」的半成品。
- 尺寸范围 1..100000，总格数上限 1 亿；上传整体上限 256 MB（HTTP 层 `serverOptions.maxRequestBodySize`
  + 应用层按 `Content-Length` 兜底）。`port` 之类改了也要重启才生效 —— 那是监听端口，
  不可能热改，导入响应的 `sizeChanged` 只说棋盘尺寸。
- multipart 是**手写解析**的（`parseMultipart`，按 latin1 切分，别改成 UTF-8 文本，
  二进制会被弄坏），额外接受 `application/octet-stream` 的裸包体，方便脚本直接喂文件。
- 客户端的重同步（`connection.mjs` 的 `board-reset` 分支）：清待确认队列 → `resetBoardGeometry()`
  按新配置重算几何并丢空棋盘 → 清 IndexedDB 缓存 → `syncInfo` 复位 → 50 ms 后 `sync-request`。
  **那 50 ms 不是仪式**：广播有可能比导入接口的响应先到，等一拍再要能避免赶在服务端把状态换好之前去拉。

## 批量改色的差分广播协议

开发者工具一次操作可能覆盖上万个格子，逐格广播不可行，所以只发**确实变了**的部分。

- 矩形：`update-region` 的 `{ start, runs }`，`runs` 与状态 RLE **同一套 varint 三元组**，
  但语义不同：这里不跳过黑色 —— 黑色在批量操作里是「擦除」这个有效结果，只有值真的没变的格子才被跳过。
  服务端是**边改边收集**改动列表（行优先，天然按下标升序），再交给 `encodeChangedRuns(changes, start)` ——
  不再像以前那样 `gridState.slice()` 复制整盘去和改后对拍（百万格棋盘每次操作省下 4 MB 拷贝）。
- 闭合区域：`{ indices }`，每个下标套用同一个取值（`runs` 为空串）。

**关键坑**：`runs` 里的第一个 varint 是「**相对上一段结束位置再跳过多少格**」，不是相对 `start` 的绝对偏移
（绝对偏移只在第一段成立，见 `encodeChangedRuns` 里跟着段尾走的 `cursor`）。
编码端必须维护这个游标，否则从第二段起整片改动都会往后漂；
广播里也**必须带上 `start`**，因为客户端把 `runs` 当成相对起点解析（`board.mjs` 的
`applyRegionPayload` 里 `let index = Number(start) || 0`）—— 缺了 `start` 就会被当成 0，
所有改动都落到棋盘左上角去。

**第二个坑**：`runs` 是 base64 文本，客户端要先 `toBytes()` 转成字节数组再交给 `readVarint()` ——
`readVarint` 是**按字节下标取值**的（二进制状态与它是同一个实现），直接传字符串会把字符当数字
（`'A' & 0x7f` → NaN → 0），于是每个 varint 都读成 0，`run <= 0` 立刻 break，
整片改动静默丢失（表现为"区域填充后画面不刷新"）。

## 画布输入：桌面端与触屏两套逻辑（`interactions.mjs`）

两套操作是分开的，改的时候别互相带坏：

| 操作 | 桌面端 | 触屏 |
| --- | --- | --- |
| 涂色 / 擦除 | 左键点方块 | **轻点**方块 |
| 选画笔颜色 | 右键短按呼出圆环 | **长按**方块呼出圆环 |
| 平移画布 | 右键长按（或按下后拖动） | **单指拖动** |
| 缩放 | 滚轮 | **双指捏合** |
| 收起圆环 | 右键 / Esc / 点外面 | 点圆环外任意处（圆环是**模态**的） |

- 触屏轻点不是靠 `click` 直接判定的：`touchstart` 时先把这次按下记成"可能是轻点"
  （`touchTap`，同时记下当时的操作模式 `pointerPhase`），`touchend` 才定案 ——
  拖动超过 `TOUCH_DRAG_SLOP`、变成双指、或长按生效都会把它作废。
- `pointerPhase` 必须在下按时记下来：取色成功后 `pickCellAt` 会立刻 `stopPicking()`，
  `click` 里再读 `isPickMode()` 就已经是 false，会把取色那一下当成普通涂色。
- 触屏长按阈值 `TOUCH_LONGPRESS_MS = 420`（比右键的 220 长，手指会抖）。
  长按生效后 `suppressTouchContextMenu` 要留到 `onContextMenu` 里再清：
  浏览器补发的 `contextmenu` 在 `touchend` **之后**才到，在抬手时就清会拦不住。
- 圆环模态：点圆环外只收起它、这次点击不涂色（`markRingJustClosed()` →
  `interactions` 里 `consumeRingJustClosed()` 直接 return）；点色块仍然正常选中
  （色块在 `#brush-ring` 内，`onPointerDown` 不会去收它）。
- 开发者模式下触屏不接管手势：长按 / 框选由 `devtools` 负责，这里只记 `pointerPhase`。

## 客户端开发者模式交互（`devtools.mjs`）

- 入口是底部按钮条里的「开发者工具」按钮（`#devtools-button`，绑定在 `bindDevEvents()` 里）。
  按钮条还有「设置」（`#settings-button` → 设置弹窗）和「菜单」（`#menu-button` → 选项面板）：
  样式在 `styles.css` 的 `.bottom-button`，三个按钮都不显示悬浮提示（只有 `data-i18n-aria-label`
  写的无障碍名字）。
- 移动端适配（`@media (hover: none) and (pointer: coarse)`）：`#devtools-button` 直接隐藏
  （开发者模式依赖左键框选 + 右键菜单，触屏用不了），`#settings-button` 也隐藏，但选项面板里
  多出一个 `.option-item.mobile-only` 的「设置」项（`#settings-option`，点击时先
  `closeOptionsPanel()` 再 `openSettingsPanel()`），移动端因此仍然能进设置弹窗。

- 左键框选：`beginSelection` / `extendSelection`。长按阈值 `SELECT_LONGPRESS_MS = 260`；
  按下后移动超过 `RIGHT_DRAG_SLOP = 6` px 立即升级为框选（不必先等满长按）；
  指针离开窗口或窗口失焦时 `interactions` 转发 `leftcancel`，由 `handleLeftCancel` 收尾，
  否则框选会一直粘在光标上。
- 左键短按（`viewState.hasMoved` 为假）把操作目标切成「该方块所在的闭合区域」，并顺手取消已有矩形选区。
- 右键菜单：填成画笔色、重置为黑、从调色盘选自定义颜色、导出选区 / 区域、取消选区。
  **菜单里不再列预设调色板的颜色**，颜色入口只留调色盘（`pushCustomColorAction` → `chooseCustomColor`，
  选色过程中会临时借用调色盘，选完把画笔恢复原样，所以开发者工具取色不会改掉用户的画笔）。
- 闭合区域 flood fill 在客户端算：`computeClosedRegion` 做「颜色相同 + 四连通」扩散，
  只要碰到棋盘边缘就判定未闭合并提示，不算通过；`computeBoundary` 另算一圈轮廓用于高亮。
- 导出：`renderRegionToCanvas` + `saveAsPng` 出 PNG，另外把选区里的取值按二维数组写成 JSON。
- `restoreSession()` 在页面加载时调 `GET /api/dev/session`：服务端没启用就只记下 `devEnabled = false`；
  启用且本地 token 仍然有效则直接进入开发者模式。
- 底部「开发者工具」按钮（`openDevTools`）：本地存过密码就直接 `login(saved, { silent: true })` 换 token，
  不弹窗；没存过就弹密码框，登录成功后把密码写进 `blockboard-dev-password`；服务端返回 401
  （`bad-password`）时清掉本地密码并重新弹窗；`locked` / `disabled` 只弹提示。服务端错误码经
  `DEV_ERROR_KEYS` 映射成 i18n 键，服务端返回的 `message`（中英混排）只当兜底文案。
  `login(password, { silent: true })` 在静默模式下不改动屏幕上的登录框，由调用方决定后续动作。

## 本地存储键

| 键 | 内容 |
| --- | --- |
| `blockboard-dev-token` | 开发者会话 token（服务端内存里的那份的本地副本） |
| `blockboard-dev-password` | 设置弹窗里保存的开发者密码，点开发者工具按钮时用它自动登录 |
| `blockboard-language` | 界面语言（`zh` / `zh-Hant` / `en` / `ja` / `ko`） |
| `blockboard-brush-color` | 当前画笔：预设存编号，自定义颜色存 `#rrggbb` |
| `blockboard-recent-colors` | 最近使用的画笔颜色（`#rrggbb` 的 JSON 数组，最新在前，最多 10 条，跳过纯黑） |
| `blockboard-edge-gesture-hint` | 桌面版 Edge 的鼠标手势提示是否已经点过「知道了」（`1` = 不再提示） |

> 数据导出 / 导入**没有自己的密码字段**：它用的就是上面那栏的开发者密码（服务端校验的也是它），
> 所以既不重复输入、也不多存一份。

浏览器数据库（增量同步用，见 `state-cache.mjs`）：

| 库 / 表 | 键 | 内容 |
| --- | --- | --- |
| `blockboard` / `board-state` | `current` | `{ epoch, rev, cols, rows, bytes }` —— 状态是 3 字节/格 的稠密裸字节，`epoch` / `rev` 与它一起在同一个事务里写，保证对得上。超过 12 MB 的棋盘不缓存 |

浏览器隐私模式下 `localStorage` 可能写不进去，所有读写都包了 try/catch 并静默忽略。
