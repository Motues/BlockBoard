# AGENTS.md

## 详细设计去哪里看

| 主题 | 文档 |
| --- | --- |
| 项目结构、服务端模块、依赖方向、配置、静态资源缓存、前端资源压缩 | `doc/architecture.md` |
| Socket 事件、首屏下发三条路、增量同步、广播合并、HTTP 开发者 API、BBEX 导入导出 | `doc/protocol.md` |
| 24bit 状态、存档 v3/v2/旧格式、RLE、批量差量 runs、尺寸重排、IndexedDB 状态缓存 | `doc/state-format.md` |
| 客户端模块、渲染调度、大棋盘 LOD、显隐动画、Edge 手势、i18n、画布输入、客户端开发者模式、localStorage 键 | `doc/frontend.md` |
| 修改流程、检查清单、验证矩阵、常见坑索引 | `doc/development.md` |

改代码前先读对应文档。协议、状态、前端交互三者经常联动，不要只看一个文件。

## 怎么改

1. **先定位主题，再读对应 doc**：改 socket/HTTP 先读 `doc/protocol.md`；改格子值/存档先读 `doc/state-format.md`；改 `public/js/*` 先读 `doc/frontend.md`。
2. **保持依赖方向**：服务端 `server` → `board-sync` → `board-state` → `board-persist` / `board-config`，不要反向 import。`board-state` 需要广播或写盘时，走 `initBoardState()` 注入的回调。
3. **配置一律运行期取值**：不要缓存 `rows` / `cols` / `TOTAL_SQUARES`；用 `liveConfig` / `getTotalSquares()` / `publicConfig()`。`gridState` 是 `let` 绑定，通过 `getGridState()` 取当前引用，导入会整块换掉。
4. **协议改动要兼容旧客户端**：新字段、新能力通过 `caps` 协商；不要删除旧字段除非确认无旧页面。首屏三条路、广播合并、增量日志、分块下发都要一起检查。
5. **前端模块不要互相 import**：功能模块从 `shared.mjs` 取状态，通过 `setRenderHooks` / `onBrushChange` / `onLangChange` / `devEvents` 通信。唯一例外链：`ring → picker → brush → cursor`，`i18n ← settings ← devtools`，`connection → loader`，`keyboard → brush / picker / ring`（开发者工具那层仍走 `devEvents` 的 `dismiss`）。
6. **改状态显示必须自己申请渲染**：改格子/相机/版面用 `requestRender()`；只改覆盖层用 `requestOverlayRender()`。`cleanupAnimations()` 删风车后必须 `markBoardDirty()`。
7. **改文案必须走 i18n**：静态文案用 `data-i18n`，动态文案在渲染时调用 `t(key, params)`，不要缓存结果。帮助弹窗桌面/触屏两套键名都要改。
8. **提交前按 `doc/development.md` 做验证**。不能只跑 `node --check`，模块图、压缩、缓存、触屏、增量同步都要手动看。

## 什么不能改

- **不能删 `serveStatic` 前的 `no-cache` 中间件**：没有打包步骤，模块裸相对路径 import，URL 挂不了版本号；删了会出现“新页面 + 旧模块”，画布和在线人数都不出来。
- **不能在压缩完成后再注册 minify 中间件**：必须在模块顶层 `app.use`，传 `() => minified`。Hono 中间件栈在首个请求进来时固定。
- **esbuild 压缩不能改 `target: esnext` 和 `charset: utf8`**：客户端有顶层 await；默认 ascii 会把中日韩文案转 `\uXXXX`。
- **`init-game` 的 `config` 不能包含 `devPassword`**：必须走 `publicConfig()`。数据导出也不能带 `devPassword`。
- **socket.io `auth` 必须回调式或对象式**：不能写 `auth: () => ({ ... })`，socket.io-client 4.8 不看返回值。
- **`online-users` 不能用 `volatile`**：连接/断开只发一次，丢了补不上。
- **不能混淆 `stateRev` 与 `syncRev`**：`stateRev` 是改色计数/缓存键/存档脏标记；`syncRev` 是发出状态消息的版本号。发快照/存档前先 `flushSquareUpdates()`。
- **`update-region` 的 `runs` 不能按绝对偏移解析**：第一个 varint 是相对上一段结束再跳过多少格；广播必须带 `start`。
- **客户端解析 `runs` 不能把 base64 字符串直接交给 `readVarint()`**：必须先 `toBytes()`，`readVarint` 按字节下标取值。
- **大棋盘渲染不能合并相邻同色格为一个 `fillRect`**：格子间缝隙就是网格线可见部分；缩到看不见网格线时由 LOD 接手。
- **显隐动画不能只写 `visibility: hidden` 不放进 `transition`**：`.hidden` 要同时有 `opacity: 0` 和 `visibility: hidden`，元素 transition 要包含 `visibility`。
- **底部菜单「…」/「X」不能用 `display` 硬切**：用 `.open` 做 opacity + rotate/scale 交叉过渡。
- **触屏 `pointerPhase` 必须在下按时记录**：取色成功后 `pickCellAt` 会立刻 `stopPicking()`，`click` 里再读会错。
- **`suppressTouchContextMenu` 要留到 `onContextMenu` 再清**：浏览器补发的 contextmenu 在 touchend 之后。
- **圆环模态下点圆环外只收起、不涂色**：靠 `markRingJustClosed()` / `consumeRingJustClosed()`。
- **数据导入失败必须回滚**：先写文件再换内存；内存抛错要还原 `game-config.json` 字节和运行期配置。
- **multipart 解析不能改成 UTF-8 文本**：`parseMultipart` 按 latin1 切分，否则二进制损坏。
- **尺寸重排两个入口行为要一致**：启动读盘发现尺寸不符、数据导入显式 `regridState`，别只改一条。
- **不要导出/导入开发者密码**：`PRESERVED_FIELDS` 保留当前 `liveConfig.devPassword`。
- **`gridState` / `rows` / `cols` 不要模块顶层缓存引用**：导入会换掉。
- **`state-cache.mjs` 保持叶子**：不 import 任何模块，避免和 `shared.mjs` 成环。
- **`interactions` 不 import `devtools`**：通过 `shared.mjs` 的 `devEvents` 转发 `leftdown/leftmove/leftup/leftcancel/contextmenu`。
- **`/api/dev/draw` 的形状不能和选区 JSON 分叉**：两边都是 `{ x, y, width, height, cells }`（`cells` 是逐格取值的二维数组），人导出的文件要能直接喂给 AI、AI 画完也要能用同一条接口写回。
- **一次改动的 runs 只能有一套基准**：编码基准、广播 `start`、响应 `range.start` 必须一致（`paintValues` 用参数收基准并回报 `PaintResult.start`）。客户端拿到响应先本机套用一遍，广播随后还会到，基准不一致就是"导入画了两遍还错位"。
- **导入不是登出入口**：`/api/dev/draw` 401 时静默重登一次重试，失败也只提示，不清 token、不退开发者模式。
- **`public/llms.txt` 不能写开发者密码或密钥**：它只讲接口形状与颜色编码；动态数据（棋盘尺寸）让 AI 自己调 `GET /api/dev/session`，别把尺寸抄进去。

## 改这里要检查哪里

| 你改了什么 | 必须同时检查 |
| --- | --- |
| `src/state.ts`、`src/board-state.ts` | `doc/state-format.md`、`doc/protocol.md`、存档 v3/v2/旧格式、`syncRev`/`stateRev`、`flushSquareUpdates`、自动存档脏标记 |
| `src/board-sync.ts` | `doc/protocol.md`、`doc/state-format.md`、首屏三条路、`caps`、增量日志、分块、广播合并、令牌桶、旧客户端兼容 |
| `src/dev-api.ts` | `doc/protocol.md`、密码来源、token、失败锁定、批量上限、`range` 颜色字段、导入导出密码、`/api/dev/draw` 与选区 JSON 同形状 |
| `src/board-transfer.ts` | `doc/protocol.md`、BBEX 校验、`devPassword` 保留、导入回滚、`replaceGrid`、`resetBoardForClients` |
| `src/server.ts`、`src/minify.ts` | `doc/architecture.md`、no-cache 中间件、minify 顶层注册、esbuild target/charset、静态资源路径 |
| `public/llms.txt` | `doc/protocol.md` 的“给 AI 的绘图说明”；接口漂了必须同步改，别写密码、别写死棋盘尺寸 |
| `public/js/*.mjs` | `doc/frontend.md`、对应协议文档；模块依赖方向、渲染申请、i18n、localStorage 键 |
| `public/js/connection.mjs` | `doc/protocol.md`、首屏三条路、`stateMode`、缓冲回放、`syncInfo.claimable`、`sync-request` |
| `public/js/board.mjs`、`render.mjs` | `doc/state-format.md`、`doc/frontend.md`、`runs` 解析、LOD、`boardRevision`、`requestRender` |
| `public/js/interactions.mjs` | `doc/frontend.md` 画布输入、触屏/桌面两套、`pointerPhase`、`suppressTouchContextMenu`、`devEvents` |
| `public/js/devtools.mjs`、`settings.mjs` | `doc/frontend.md`、`doc/protocol.md`、密码存取、导入导出、i18n、移动端隐藏/入口 |
| `public/js/i18n.mjs`、`index.html` 文案 | `doc/frontend.md` 国际化、所有 `data-i18n`、帮助弹窗两套文案 |
| `public/styles.css` | `doc/frontend.md` 显隐动画、`.hidden`、`.glass-panel`、菜单图标交叉过渡 |
| `game-config.example.json`（首启种子）/ `data/config/game-config.json`（生效）、配置结构 | `doc/architecture.md`、`doc/state-format.md`、`liveConfig`、`publicConfig()`、`getTotalSquares()` |
| 导入/导出/尺寸变更 | `doc/protocol.md`、`doc/state-format.md`、`regridState` 两个入口、`gridState` 引用、客户端重同步 |

## 怎么验证

1. **静态检查**：对改动的 JS/TS 跑 `node --check` 或项目现有 lint/typecheck。注意：`node --check` 发现不了模块图/缓存/压缩问题。
2. **启动服务后看浏览器**：
   - Console 无模块加载失败；
   - 画布出现，在线人数不是 `—`；
   - Network 面板里 JS/CSS 是压缩后的一行，且响应带 `Cache-Control: no-cache`；
   - 普通刷新、强刷、改模块后刷新都不出现“新页面 + 旧模块”。
3. **协议/同步**：
   - 新客户端首屏 `inline` / `chunks` / `client` 三条路都试；
   - 断线重连走 `sync-delta` 或 `sync-done`；
   - 缓存损坏时发 `sync-request` 能全量恢复；
   - 大棋盘走分块，不一次性塞几 MB；
   - 多格广播合并为 `update-squares`，旧客户端仍收到逐格。
4. **状态/存档**：
   - 改色后 60 秒自动存档只在 `stateRev !== savedRev` 时写；
   - v3 能读，v2 能读，旧 base64 能按 24bit→32bit→4bit→1bit 判定；
   - 改 `rows/cols` 后左上角对齐重排；
   - 导入后尺寸热更新、epoch 更换、客户端自动 `sync-request`。
5. **前端交互**：
   - 桌面左键涂色、右键短按圆环、右键长按平移、滚轮缩放；
   - 触屏轻点涂色、长按圆环、单指拖动、双指捏合；
   - 取色器不误涂色；
   - 快捷键：Esc 一层层收（选区 → 面板 → 弹窗）、C 居中弹调色盘、I 进出吸管、1–8 切预设色；在色号框 / 密码框里打字不触发；
   - 设置弹窗语言预览/关闭回退、密码保存、数据备份；
   - 帮助弹窗桌面/触屏两套文案；
   - Edge 手势提示只桌面版 Edge 出现，点击“知道了”后不再提示。
6. **开发者工具/导入导出**：
   - 登录、退出、失败 5 次锁定、token 过期；
   - 矩形/闭合区域批量改色，`range` 本机套用颜色正确；
   - 导出选区分成 PNG / JSON 两个菜单项，各自只下一个文件；
   - 导入 JSON：三种起点（文件自带 / 当前位置 / 点棋盘选）都对，越界只报错不写入，Esc 能取消点选；
   - 导入结果只画一遍、不偏移（本机套用与广播同基准），导入后仍停在开发者模式（token 失效会静默重登重试）；
   - 点选起点时能看到半透明画面预览（`IMPORT_PREVIEW_ALPHA`）+ 绿色虚线框；
   - 导出 `.bbx` 不含 `devPassword`；
   - 导入二次确认，覆盖后 `devPassword` 保留，失败回滚。
7. **大棋盘**：百万格下平移/缩放不卡死；LOD 路径生效；不要合并相邻同色 `fillRect`。
8. **AI 接口**：`GET /llms.txt` 能直接打开、内容与 `paint` / `draw` / `session` 实际行为一致（尤其颜色编码与 20 万格上限），`POST /api/dev/draw` 能按导出的选区 JSON 原样写回。

详细验证矩阵见 `doc/development.md`。