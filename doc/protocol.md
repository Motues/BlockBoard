# 协议

## Socket 事件

| 事件 | 方向 | 载荷 |
| --- | --- | --- |
| `init-game` | server → client | `{ config, black, maxColorIndex, rgbSupport, epoch, rev, stateMode }` + 状态。`stateMode`：`inline`（`stateRgb` + `stateEncoding` 一条消息装下）、`chunks`（后面跟 `state-chunk` ... `state-done`）、`client`（本机已有状态，后面跟 `sync-delta` / `sync-done`）。声明 `bin` 时 `stateRgb` 是二进制附件，否则 base64；未声明 `rgb24` 的旧页面收到旧字段 `state`（4bit base64） |
| `state-chunk` | server → client | `{ seq, rowStart, rows, encoding, data }`。`encoding` 为 `rle` / `dense`（`-bin` 后缀表示二进制）；跳过计数相对本块起点，客户端按行偏移套用 |
| `state-done` | server → client | `{ rev }`。分块下发收齐。客户端这时才认版本号，并回放缓冲的实时广播 |
| `sync-delta` | server → client | `{ from, to, patches: [{ event, payload }, ...] }`。把日志里的状态变更按顺序重放，分批发送 |
| `sync-done` | server → client | `{ rev }`。增量补完或本来不需要补 |
| `sync-request` | client → server | `{ epoch, rev }`。客户端主动要重新同步：版本号对得上走增量，对不上发全量 |
| `paint-square` | client → server | `{ index, brush }`（预设编号）或 `{ index, rgb }`（自定义 24bit）；与画笔同色则擦成黑色，否则涂成画笔色 |
| `toggle-square` | client → server | `index`。最早的黑白切换协议，仍接受 |
| `update-square` | server → client | `{ index, value, rgb, isBlack, rev }`。单格改动；`rgb` 是自定义颜色 24bit，否则 `null`；`value` / `isBlack` 兼容旧页面 |
| `update-squares` | server → client | `{ cells: [[index, value], ...], rev }`。一个广播窗口内多条单格改动合并；只发给声明 `batch` 的客户端 |
| `paint-rejected` | server → client | `{ index }`。点击被令牌桶挡掉，客户端收回乐观风车 |
| `online-users` | server → client | 当前在线人数。**别用 `volatile`**：socket.io 在传输层正在写时会把 volatile 包丢掉，人数只在连接/断开各发一次，丢了永远补不上 |
| `update-region` | server → client | 开发者工具批量改色广播。矩形 `{ start, runs, value, rgb, isBlack, rev }`，闭合区域 `{ indices, runs: '', value, rgb, isBlack, rev }` |
| `board-reset` | server → client | 数据导入完成：`{ config, epoch, rev, total }`。客户端丢掉本地缓存与棋盘、清空待确认队列，然后主动发 `sync-request` 要全量。为什么不让服务端直接推：全量可能几 MB 还要分块，客户端主动要更省事，也复用“中途断线重新要一次”的逻辑 |

## 握手与能力

客户端用：

```js
io({ auth: (done) => done({ caps, epoch, rev }) })
```

**必须是回调式（或对象式），不能写成 `auth: () => ({ ... })`**。socket.io-client 4.8 在 `onopen` 里只判断 `typeof this.auth == "function"`，是函数就调用 `this.auth(callback)`，否则直接发 `this.auth` 本身，完全不看返回值。写成“返回对象”的箭头函数不会报错，但 CONNECT 包永远发不出去 —— 传输层已连上（`connected` 仍为 false）、`init-game` 收不到，棋盘空白、在线人数停在 `...`、导出图片报 `board not ready`。

| 能力 | 含义 |
| --- | --- |
| `rgb24` | 认识 24bit 取值与 3 字节/格稠密状态，服务端发 `stateRgb` 而不是旧字段 `state` |
| `rle` | 额外认识 RLE 紧凑状态 |
| `bin` | 状态用二进制发（`stateEncoding` / `encoding` 带 `-bin` 后缀），省 base64 33% 与客户端 `atob` |
| `batch` | 认识合并广播 `update-squares` |
| `chunk` | 认识分块下发（`state-chunk` / `state-done`） |
| `sync` | 认识增量同步（`sync-delta` / `sync-done`） |

`auth` 里的 `epoch` / `rev` 是客户端已经持有的状态版本；报不出可信值时报 `0` / `-1`（`syncInfo.claimable` 为假），服务端发全量。

RLE 紧凑状态：每个色块三个 varint `[跳过多少个黑格, 连续多少格, 颜色值]`，没被提到的格子保持黑色。空棋盘零字节，稀疏棋盘几十字节；只有“每格颜色都不同”的噪点棋盘会比稠密格式大，这时 `encodeCompactState` 退回 3 字节/格稠密格式，载荷永远不会比朴素编码更大。大消息另交给 WebSocket `perMessageDeflate`（阈值 1 KiB）再压。

## 状态快照缓存与广播节奏

- **快照缓存**：全盘编码（RLE / 稠密 / 4bit）按 `stateRev` 缓存，按需计算。先只算 RLE，稠密格式字节数固定（格子数 × 3），比长度就能决定用哪个。以前每个新连接现算两套全盘编码，百万格棋盘就是每连接几 MB 临时内存与几十万次 varint 写。
- **广播合并**：单格改动先进 `pendingSquares`（`Map<index, value>`，同一格只留最后一次），`BROADCAST_WINDOW_MS`（16 ms）后统一发出。窗口里只有一格就沿用 `update-square`；多格时给 `batch` 客户端发 `update-squares`，给其它客户端逐格补发 `update-square`。
- **令牌桶限流**：每连接 `PAINT_BURST`（60）容量、`PAINT_PER_SECOND`（30）补充。被挡掉回 `paint-rejected`。`sync-request` 另有更严限流（连发 5 次、每 3 秒补 1 次），别让它逼服务端反复编码整盘。
- `maxHttpBufferSize: 1e6` 显式写明上行单条消息上限；`stateRev` 同时是自动存档脏标记。

## 首屏状态下发三条路

`stateRev` 与 `syncRev` 是两个计数器，别混：

| 计数器 | 何时 +1 | 用途 |
| --- | --- | --- |
| `stateRev` | 每次改色 | 全盘编码快照缓存键、自动存档脏标记 |
| `syncRev` | 每次发出状态变更消息 | 增量同步版本号（客户端缓存对账） |

分开原因：单格改动会在 `pendingSquares` 排 16 ms 队，`stateRev` 已涨但消息还没发出；客户端能报的版本号必须是“消息版本”。因此发快照 / 存档之前都先 `flushSquareUpdates()`，保证 `syncRev` 与快照内容配套。

三条路（按握手里的 epoch / rev）：

1. `stateMode: 'client'` + `sync-done` —— epoch 一致且 `clientRev === syncRev`：什么都不传。
2. `stateMode: 'client'` + `sync-delta` —— epoch 一致、`clientRev` 还在 patch 日志覆盖范围内：按 `patchLog` 重放版本号更大的消息。日志是条数 + 字节数双上限环形缓冲，`patchLogCovers()` 判定 `log[0].rev <= rev + 1`。
3. 全量 —— 其余情况：状态小于 `CHUNK_THRESHOLD_BYTES`（96 KB）时一条 `init-game` 装下；否则且客户端声明 `chunk` 时 `sendChunkedState()`：按 `CHUNK_TARGET_BYTES`（64 KB）折算成若干行一块，每块独立编码（RLE / 稠密取小），块间 `setImmediate` 让出事件循环。

客户端对应实现（`connection.mjs`）：

- `stateMode: 'client'` 时优先用内存状态（断线重连，页面没刷新），只有内存没有完整状态才从 IndexedDB 恢复。缓存节流写，最多落后几秒，拿它盖内存会冲掉新改动。缓存也解不出来就发 `sync-request` 要全量。
- `stateMode: 'chunks'` 期间把实时广播缓冲（`bufferedEvents`），`state-done` 时先回放再认版本号。顺序反了会声称“已到 rev X”但还差缓冲消息，重连时服务端不补。
- 版本号一律用 `setSyncRev()` 取 `max`：差量是绝对写入，乱序/重复应用安全，但版本号不能倒退。
- `syncInfo.claimable` 表示“报出去的 epoch / rev 有没有本机完整状态兜底”：分块下发中途为假，这时握手只能报 `epoch 0 / rev -1`。
- 缓存写盘由 `main.mjs` 注入 provider，`connection.mjs` 只 `markCacheDirty()`；`visibilitychange` / `pagehide` 时立即 flush。

断点续传、哈希校验、瓦片还没做，见 `FEATURE.md`。

## 批量改色差分广播协议

开发者工具一次操作可能覆盖上万格，逐格广播不可行，只发确实变了的部分。

- 矩形：`update-region` 的 `{ start, runs }`，`runs` 与状态 RLE 同一套 varint 三元组，但语义不同：这里不跳过黑色 —— 黑色在批量操作里是“擦除”有效结果，只有值真的没变的格子才被跳过。服务端边改边收集改动列表（行优先，天然按下标升序），再交给 `encodeChangedRuns(changes, start)`；不再 `gridState.slice()` 复制整盘对拍。
- 闭合区域：`{ indices }`，每个下标套用同一个取值（`runs` 为空串）。

关键坑：

- `runs` 第一个 varint 是“相对上一段结束位置再跳过多少格”，不是相对 `start` 的绝对偏移。绝对偏移只在第一段成立。编码端必须维护 `cursor`，否则从第二段起整片改动往后漂。
- 广播必须带 `start`，客户端把 `runs` 当相对起点解析（`applyRegionPayload` 里 `let index = Number(start) || 0`）。缺 `start` 会被当成 0，所有改动落到左上角。
- `runs` 是 base64 文本，客户端先 `toBytes()` 再交给 `readVarint()`。`readVarint` 按字节下标取值，直接传字符串会把字符当数字（`'A' & 0x7f` → NaN → 0），每个 varint 读成 0，`run <= 0` 立刻 break，整片改动静默丢失。

## 开发者工具 HTTP API

密码来源优先级（`resolveDevPassword`）：

1. 环境变量 `DEV_PASSWORD`（`source: 'env'`）；
2. `game-config.json` 的 `devPassword`（`source: 'config'`）；
3. 都没有 —— 开发者工具整个关闭，登录接口返回 503 `disabled`。

数据导出 / 导入不要求先登录开发者模式：它们只认当次请求头 `x-dev-password`（`guardAdminPassword`），这份密码与登录用开发者密码是同一个。失败次数与登录共用同一份按 IP 记录（5 次锁 5 分钟）。客户端复用设置里已保存的开发者密码（`getSavedDevPassword()`）：没保存就提示先保存，不另存、不偷偷登录换 token。

- 登录成功下发 `crypto.randomBytes(32).toString('hex')` 随机 token，只存内存（`Map<token, expiresAt>`），有效期 `devSessionHours`（默认 8 小时，最小 1 小时），后台每 30 分钟清理过期项（定时器 `unref()`）。
- 请求带 `x-dev-token` 头（也接受 `Authorization: Bearer`）。
- 密码比对用 `crypto.timingSafeEqual`；长度不同先比长度（长度不等会抛错）。
- 失败锁定按 IP（优先 `x-forwarded-for` 第一段，否则 `local`）：连续失败 5 次锁 5 分钟，锁定期过后清零。成功登录清掉该 IP 失败记录。
- 退出登录立刻作废 token；服务端重启后所有 token 失效。
- `MAX_REGION_CELLS = 200000`：单次批量操作格子上限，矩形按 `width * height`，区域按 `cells.length`。

| 端点 | 请求体 | 说明 |
| --- | --- | --- |
| `POST /api/dev/login` | `{ password }` | 返回 `{ ok, token, expiresAt }`；503 未启用，401 密码错误，429 已锁定 |
| `POST /api/dev/logout` | –（token 在 `x-dev-token`） | 作废 token |
| `GET /api/dev/session` | – | `{ ok, enabled, active, config: { cols, rows } }`（尺寸取当前生效配置） |
| `POST /api/dev/paint` | `{ x0, y0, x1, y1, color }` 或 `{ cells: [], color }` | 应用改动并返回 `{ ok, changed, range }`；503 未启用，401 token 失效 |
| `POST /api/dev/export` | –（密码在 `x-dev-password`） | 返回打包文件（`application/octet-stream` + `Content-Disposition`）；401 密码错误，429 锁定，503 未启用 |
| `POST /api/dev/import` | multipart 的 `package` 文件（密码在 `x-dev-password`，也接受表单 `password`） | 覆盖 `game-config.json` 与存档，返回 `{ ok, configBytes, saveBytes, cols, rows, sizeChanged }`；400 包损坏/配置非法/存档对不上，413 太大 |

`range` 是给客户端“本机先套用一遍，不等广播绕一圈”用的。矩形分支除了 `{ start, width, height, runs }` 还带 `value` / `rgb` / `isBlack`（与广播同一套取值）—— 少了颜色字段，客户端会用 `applyRegionPayload` 的兜底色（1 号色）涂一遍。闭合区域分支的 `range` 只有 `{ runs: '', spread: true }`，本机套用是空操作，实际落地靠 `update-region` 广播（带 `indices`）。

`color` 与单元格取值同一套约定：`0` 黑、`1..15` 预设编号、`>= 16` 为 24bit RGB。矩形坐标会被规范化（`min` / `max`），越界返回 400 `out-of-range`。

## 数据导出 / 导入：BBEX

设置弹窗「数据备份」把 `game-config.json` 与 `data/board-state.dat` 打包成 `.bbx`，导入时服务端解析、覆盖两者。要密码：就是开发者密码。客户端复用 `blockboard-dev-password`，不重复输入。

BBEX 容器（小端，零依赖，不用 zip）：

| 偏移 | 长度 | 内容 |
| --- | --- | --- |
| 0 | 4 | magic `'BBEX'` |
| 4 | 2 | 格式版本（当前 1） |
| 6 | 4 | config 字节数 |
| 10 | 4 | save 字节数（0 = 没有存档） |
| 14 | 32 | SHA-256(config) |
| 46 | 32 | SHA-256(save)（save 为空时全 0） |
| 78 | config | `game-config.json` 文本（导出时已剥离 `devPassword`） |
| … | save | `data/board-state.dat` 原样（v3 自带 deflate，不再二次压缩） |

magic / 版本 / 长度之和 / 两个校验和逐项校验，任一不符都当“包已损坏”拒绝（400 `bad-package`），不猜内容。

客户端界面行为（`settings.mjs`）：

- 导出：`POST /api/dev/export` 拿到 blob 后 `<a download>`，文件名取 `Content-Disposition`（服务端生成 `BlockBoard-<yyyyMMdd-HHmmss>.bbx`），失败把服务端 `error` 经 `TRANSFER_ERROR_KEYS` 映射成 i18n。
- 导入：点第一下只是确认（按钮变「确认覆盖？」，`armed` 类，3 秒收回），第二下才上传。上传用 `FormData` 的 `package` 字段。
- 导入成功后状态行显示新棋盘尺寸，不说“密码改了”或“端口改了”：`devPassword` 被保留；`port` 在设置了 `PORT` 环境变量时（Docker 就是这么部署的）同样被保留，其它情况下改了也要重启才生效。

刻意取舍：

- `devPassword` 既不导出也不导入：导出文件可能被转发，带管理密码等于泄露；导入别人包会换掉自己密码、被锁在开发者工具外。`applyImport` 把服务器当前 `liveConfig.devPassword` 合并进新配置（保留字段由 `preservedFields()` 给出）。
- 监听端口优先级：`PORT` 环境变量 > `game-config.json` 的 `port`（解析在 `board-config.ts`，启动时一次性定下）。设了 `PORT` 时 `preservedFields()` 会把 `port` 一起保留 —— 免得一个来源不明的备份把容器里的服务改到别的端口上，那时改端口只能改部署。
- 导入实时生效：`writeGameConfig()` 原子写盘 → `setLiveConfig()` 换运行期配置 → `replaceGrid()` 按新尺寸重排、换新 epoch、`syncRev` 归零并立刻写盘 → `resetBoardForClients()` 广播 `board-reset`。改尺寸不用重启，在线客户端自动重同步。这要求 `rows` / `cols` 运行期取值：`TOTAL_SQUARES` 已删，走 `getTotalSquares()`；`gridState` 从 `const` 变 `let` + `getGridState()`。
- 失败回滚：先写文件再换内存；内存抛错就把 `game-config.json` 还原回原始字节、运行期配置退回旧的。不留“文件新配置、服务端旧配置”半成品。
- 尺寸范围 1..100000，总格数上限 1 亿；上传整体上限 256 MB（HTTP 层 `serverOptions.maxRequestBodySize` + 应用层按 `Content-Length` 兜底）。`port` 没被 `PORT` 钉住时改了也要重启才生效，导入响应 `sizeChanged` 只说棋盘尺寸。
- multipart 手写解析（`parseMultipart`，按 latin1 切分，别改成 UTF-8 文本，二进制会坏），额外接受 `application/octet-stream` 裸包体。
- 客户端重同步（`connection.mjs` 的 `board-reset` 分支）：清待确认队列 → `resetBoardGeometry()` 按新配置重算几何并丢空棋盘 → 清 IndexedDB 缓存 → `syncInfo` 复位 → 50 ms 后 `sync-request`。那 50 ms 不是仪式：广播可能比导入响应先到，等一拍避免赶在服务端换好状态前去拉。