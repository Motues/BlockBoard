# BlockBoard 设计与架构（AGENT 参考）

本文写给参与开发的贡献者和 AI agent；面向使用者的说明在 [README.md](./README.md) / [README.zh-CN.md](./README.zh-CN.md)，本文只讲实现细节。

## 项目结构

- `src/server.ts` —— Hono + socket.io 服务端：棋盘状态、单格与批量改色、静态资源托管、自动存档。
- `src/state.ts` —— 棋盘状态的取值约定与编解码（24bit / 4bit / 1bit 存档、RLE 紧凑状态、批量差量 runs、按左上角对齐的重排）。
- `src/dev-api.ts` —— 开发者工具的服务端部分：密码换 token、token 校验、批量改色接口。
- `public/` —— 纯 ES module 客户端，无打包、无构建步骤，由 `public/index.html` 通过 `public/js/main.mjs` 加载。
- `game-config.json` —— 棋盘尺寸、端口、开发者密码、会话时长。
- `data/` —— 运行时生成的存档目录（`board-state.dat`、`board-size.json`），不进版本库。

## 客户端布局

| 模块 | 职责 |
| --- | --- |
| `main.mjs` | 入口：读 `localStorage`、把各部分接起来并启动首帧 |
| `config.mjs` | 全部常量、预设调色板 `BRUSH_PRESETS` 与单元格取值范围 |
| `shared.mjs` | 运行期共享状态：socket、画布、棋盘几何、视图状态、待确认队列、渲染调度、渲染钩子 |
| `color.mjs` | 颜色计算：`#rrggbb` ↔ 24bit ↔ HSV、单元格取值 ↔ 颜色 |
| `brush.mjs` | 当前画笔与最近颜色列表（持久化） |
| `cursor.mjs` | CSS 光标：画笔圆点，取色模式下换成吸管 |
| `board.mjs` | 棋盘状态解码、命中测试、悬停高亮、批量改色广播的落地 |
| `camera.mjs` | 视口、缩放 / 平移边界、棋盘坐标 ↔ 屏幕坐标 |
| `render.mjs` | 网格绘制、风车切换动画、PNG 导出、区域导出 |
| `interactions.mjs` | 画布上的指针 / 触摸 / 滚轮输入，并把事件转发给开发者工具 |
| `devtools.mjs` | 开发者模式：登录、框选、右键菜单、闭合区域填充、导出 |
| `ring.mjs` | 画笔圆环、选项面板、帮助弹窗 |
| `picker.mjs` | 调色盘、最近颜色色块、取色器模式 |
| `connection.mjs` | socket 事件与全局 UI 绑定 |
| `i18n.mjs` | 语言状态、`t()`、`applyStaticI18n()`、`onLangChange()` |
| `settings.mjs` | 居中的设置弹窗 + 浏览器本地的开发者密码存取 |
| `toast.mjs` | 底部居中的浮层提示，开发者工具与设置共用 |

### 依赖方向

- `shared.mjs` 保存状态与渲染钩子，功能模块一律从它取状态，**彼此之间不互相 import**：
  各模块用 `setRenderHooks({ paint, needsMoreFrames, markHoverDirty })` 挂进渲染循环，
  用 `onBrushChange` / `onLangChange` 之类的监听器接收变化。
- 功能模块之间的链只有一条：`ring → picker → brush → cursor`。
- `i18n ← settings ← devtools`：设置弹窗依赖 i18n，开发者工具依赖设置里的密码存取。
- `interactions` 不 import `devtools`：画布上的左键按下 / 移动 / 松手 / 右键通过 `shared.mjs` 的
  `devEvents`（一个 `EventTarget`）转发成 `leftdown` / `leftmove` / `leftup` / `leftcancel` / `contextmenu`
  事件，避免 `interactions ←→ devtools` 成环。

## 国际化（`i18n.mjs`）

- 键名固定为 `blockboard-language`，只支持 `zh` / `en` 两个值。
- 检测规则：先用 `localStorage` 里的值；没有（或值不合法）就看 `navigator.language`，
  **只有 `zh` 开头才是中文，其余一律英文**，并把这个结果写回 `localStorage`。
- 静态文字在 `index.html` 上标 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder`，
  `applyStaticI18n()` 统一刷成当前语言。
- 动态文字一律用 `t(key, params)`（`{name}` 占位符替换），**必须在渲染时调用**，不能把结果缓存成常量，
  否则切换语言不会更新。
- 语言切换走 `onLangChange(handler)`：`ring` / `picker` / `devtools` 注册回调后重绘自己的文字。

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

- `data/board-state.dat` —— Base64 文本。有自定义颜色时按 24bit（每格 3 字节）写；
  棋盘上没有任何自定义颜色时仍然写旧的 4bit/格 布局（每字节两格，前一个格子放低 4 位），
  文件小 6 倍且旧版本程序也能读。
- `data/board-size.json` —— 这份存档对应的 `{ cols, rows }`。启动时先写一次，
  每次自动存档（每 60 秒）时一起更新；它是尺寸变化后精确重排、以及给 4bit / 1bit 旧格式消歧的依据。

旧存档识别与迁移（`decodeState`）：按字节长度依次判定 **24bit（3 字节/格）→ 32bit（4 字节/格，
高 8 位是自定义颜色标记）→ 4bit（每字节两格）→ 1bit（每字节八格）**。
判定顺序很关键：先看字节数是否正好等于某种格式在当前配置下的长度，都不匹配再尝试反推格子数，
否则「比当前棋盘小的 4bit 存档」会被当成 24bit 读出乱码。字节数不足以反推尺寸时用
`board-size.json` 里的上一个配置消歧，仍然没有就按更常见的 4bit 读。

改棋盘尺寸（`game-config.json` 的 `rows` / `cols` 变了）时按**左上角对齐**重排（`regridState`）：
逐行整段搬运，棋盘变大时右下角补黑，变小时丢弃超出部分，重叠区域颜色原样保留。
不能只按一维数组截断 / 补零 —— 列数一变一维下标与二维行列就对不上，整幅画会斜着错位。
`data/board-size.json` 缺失时尺寸靠字节长度推断：24bit / 4byte 布局精确，只改行数也精确；
唯一无法还原的是「4bit 或 1bit 存档且列数也变了」，那种情况退化成逐格裁剪 / 补黑（改动前的旧行为）。

## Socket 事件（`src/server.ts`）

| 事件 | 方向 | 载荷 |
| --- | --- | --- |
| `init-game` | server → client | `{ config, stateRgb, stateEncoding, black, maxColorIndex, rgbSupport }`；`stateRgb` 是 24bit 状态（RLE 或稠密），没声明 `rgb24` 能力的旧页面收到旧字段 `state`（4bit） |
| `paint-square` | client → server | `{ index, brush }`（预设编号）或 `{ index, rgb }`（自定义 24bit）；与画笔同色则擦成黑色，否则涂成画笔色 |
| `toggle-square` | client → server | `index` —— 最早的黑白切换协议，仍然接受 |
| `update-square` | server → client | `{ index, value, rgb, isBlack }`；`rgb` 是自定义颜色的 24bit 值（否则 `null`），`value` / `isBlack` 是给未刷新旧页面的兼容字段 |
| `online-users` | server → client | 当前在线人数 |
| `update-region` | server → client | 开发者工具的批量改色广播，矩形 `{ start, runs, value, rgb, isBlack }`，闭合区域 `{ indices, runs: '', value, rgb, isBlack }` |

握手能力：客户端用 `io({ auth: { caps: ['rgb24', 'rle'] } })` 声明自己认识哪些格式。

| 能力 | 含义 |
| --- | --- |
| `rgb24` | 认识 24bit 取值与 3 字节/格 的稠密状态，服务端因此发 `stateRgb` 而不是旧字段 `state` |
| `rle` | 额外认识 RLE 紧凑状态 |

RLE 紧凑状态：每个色块三个 varint `[跳过多少个黑格, 连续多少格, 颜色值]`，没被提到的格子保持黑色。
空棋盘零字节，稀疏棋盘几十字节；只有「每个格子颜色都不同」的噪点棋盘会比稠密格式更大，
这时 `encodeCompactState` 退回 3 字节/格的稠密格式，所以载荷永远不会比朴素编码更大。
大消息另外交给 WebSocket 的 `perMessageDeflate`（engine.io `perMessageDeflate`，阈值 1 KiB）再压一遍。

## 开发者工具（`src/dev-api.ts`）

密码来源优先级（`resolveDevPassword`）：

1. 环境变量 `DEV_PASSWORD`（`source: 'env'`）；
2. `game-config.json` 的 `devPassword`（`source: 'config'`）；
3. 都没有 —— 开发者工具整个关闭，登录接口返回 503 `disabled`。

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
| `GET /api/dev/session` | – | `{ ok, enabled, active, config: { cols, rows } }` |
| `POST /api/dev/paint` | `{ x0, y0, x1, y1, color }` 或 `{ cells: [], color }` | 应用改动并返回 `{ ok, changed, range }`；503 = 未启用，401 = token 失效 |

`color` 与单元格取值同一套约定：`0` 黑、`1..15` 预设编号、`>= 16` 为 24bit RGB。
矩形坐标会被规范化（`min` / `max`），越界返回 400 `out-of-range`。

## 批量改色的差分广播协议

开发者工具一次操作可能覆盖上万个格子，逐格广播不可行，所以只发**确实变了**的部分。

- 矩形：`update-region` 的 `{ start, runs }`，`runs` 与状态 RLE **同一套 varint 三元组**，
  但语义不同：这里不跳过黑色 —— 黑色在批量操作里是「擦除」这个有效结果，只有值真的没变的格子才被跳过。
- 闭合区域：`{ indices }`，每个下标套用同一个取值（`runs` 为空串）。

**关键坑**：`runs` 里的第一个 varint 是「**相对上一段结束位置再跳过多少格**」，不是相对 `start` 的绝对偏移
（绝对偏移只在第一段成立，见 `encodeDiffRuns` 里的 `cursor`）。
编码端必须维护这个游标，否则从第二段起整片改动都会往后漂；
广播里也**必须带上 `start`**，因为客户端把 `runs` 当成相对起点解析（`board.mjs` 的
`applyRegionPayload` 里 `let index = Number(start) || 0`）—— 缺了 `start` 就会被当成 0，
所有改动都落到棋盘左上角去。

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
| `blockboard-language` | 界面语言（`zh` / `en`） |
| `blockboard-brush-color` | 当前画笔：预设存编号，自定义颜色存 `#rrggbb` |
| `blockboard-recent-colors` | 最近使用的画笔颜色（`#rrggbb` 的 JSON 数组，最新在前，最多 10 条，跳过纯黑） |

浏览器隐私模式下 `localStorage` 可能写不进去，所有读写都包了 try/catch 并静默忽略。
