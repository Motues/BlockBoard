# 开发指南

## 修改流程

1. 确定改动主题：架构 / 协议 / 状态 / 前端 / 开发者工具 / 导入导出 / 压缩缓存。
2. 打开对应文档：
   - 服务端模块、依赖、配置、静态资源、minify：`docs/architecture.md`
   - Socket、HTTP、BBEX、增量/分块/广播：`docs/protocol.md`
   - 24bit、存档、RLE、runs、重排：`docs/state-format.md`
   - 客户端模块、渲染、交互、i18n、localStorage：`docs/frontend.md`
3. 按 `AGENTS.md` 的“改这里要检查哪里”列出联动点。
4. 小步修改，先保证依赖方向正确，再处理兼容。
5. 提交前按下面验证矩阵走一遍。

## 硬约束速查

- 服务端依赖单向：`server` → `board-sync` → `board-state` → `board-persist` / `board-config`。
- 配置运行期可变：`liveConfig` / `getTotalSquares()` / `publicConfig()`；不缓存 `rows` / `cols` / `TOTAL_SQUARES` / `gridState` 引用。
- `publicConfig()` 是敏感字段唯一出口；导出不带 `devPassword`。
- `serveStatic` 前的 `no-cache` 中间件不能删。
- `serveMinified()` 必须在模块顶层 `app.use` 注册；esbuild `target: esnext`、`charset: utf8`。
- socket.io `auth` 必须回调式/对象式；`online-users` 不用 `volatile`。
- `stateRev` 与 `syncRev` 不混；发快照/存档前 `flushSquareUpdates()`。
- `update-region` 的 `runs` 相对上一段结束，广播必须带 `start`；客户端先 `toBytes()` 再 `readVarint()`。
- 客户端模块不互相 import；通过 `shared.mjs` 的 hooks / `devEvents` 通信。
- 改画面必须 `requestRender()` 或 `requestOverlayRender()`；`cleanupAnimations()` 后 `markBoardDirty()`。
- 显隐动画 `.hidden` 同时写 `opacity` 与 `visibility`，transition 包含 `visibility`；菜单图标不用 `display` 硬切。
- 触屏 `pointerPhase` 下按时记录；`suppressTouchContextMenu` 到 `onContextMenu` 再清；圆环模态点外只收起。
- i18n 动态文字渲染时 `t()`；帮助弹窗两套文案都要改。
- 导入失败回滚；multipart 按 latin1 解析；尺寸重排两个入口一致。
- 大棋盘不合并相邻同色 `fillRect`。
- `state-cache.mjs` 保持叶子；`interactions` 不 import `devtools`。

## 验证矩阵

### 静态与启动

- 对改动 JS/TS 跑 `node --check` 或项目现有 lint/typecheck。
- 启动服务，确认无启动异常。
- 浏览器 Console 无模块加载失败。
- Network 面板：JS/CSS 是压缩后一行；响应带 `Cache-Control: no-cache`。
- 普通刷新、强刷、改模块后刷新都不出现“新页面 + 旧模块”。
- 生效配置 `data/config/game-config.json` 不存在时首启能自己生成一份并正常起来：有仓库里那份种子（`game-config.example.json`）就照抄，删掉两者才用 `DEFAULT_CONFIG`（删掉生效配置重启即可验证）。种子还在时改种子**不生效**。
- 端口优先级：裸跑用配置里的 `port`；`PORT=xxxx` 时日志与 `listen` 都用环境变量那个（非法 `PORT` 退回配置文件并告警）。

### Docker

- 本机装不了 Docker 时，至少核对 `Dockerfile` 里每个 `COPY` 的源文件都真的在仓库里（`dist` 由 builder 产出，`public`、`game-config.example.json`、`package.json` + `pnpm-lock.yaml` 来自上下文）。少一个文件不是构建失败在那一层，而是**加载构建定义时**就报 `"/xxx": not found`。
- `docker build` 后启动，容器日志里端口是 `3000` 且 `from PORT environment variable`。
- 首启后宿主机出现 `./data/config/game-config.json`；改里面的 `port` 成别的值，重启容器后监听端口仍是 3000。
- 导入一份 `port` 不同的备份：落盘的配置里 `port` 保持 3000，服务不用重启。
- **导入存档必须能写进去**（回归点）：容器里导入 `.bbx`，日志里不能出现 `write-failed ... EBUSY`。配置在 `./data/config/` 里、只挂 `data/` 目录，正常情况不会被挂载点挡住；`writeFileAtomic()` 的原地覆写只是给「把 `game-config.json` 或 `board-state.dat` 当成单个文件挂进来」和只读根文件系统兜底（走到那条路时日志会有一条 “writing it in place instead”）。
- 挂载 `/app/data`，重启容器后棋盘内容与配置都还在；容器以 uid 1000 运行，挂载目录要让它能写。

### 协议与同步

- 新客户端首屏 `inline` / `chunks` / `client` 三条路都能出棋盘。
- 断线重连走 `sync-delta` 或 `sync-done`，不重复全量。
- 缓存损坏/尺寸不符时 `sync-request` 能全量恢复。
- 大棋盘走 `state-chunk` / `state-done`，不一次性塞几 MB。
- 多格广播合并为 `update-squares`，旧客户端仍收逐格 `update-square`。
- 令牌桶触发时客户端收到 `paint-rejected` 并收回乐观风车。
- `online-users` 在连接/断开时都可靠更新，不因 volatile 丢失。
- `auth` 确认是回调式；`connected` 变为 true 且收到 `init-game`。

### 状态与存档

- 改色后 60 秒自动存档只在 `stateRev !== savedRev` 时写。
- v3 能读；v2 能读；旧 base64 按 24bit → 32bit → 4bit → 1bit 判定。
- 改 `rows/cols` 后左上角对齐重排，不斜位。
- 导入后尺寸热更新、epoch 更换、`syncRev` 归零、客户端自动 `sync-request`。
- 导入失败时 `game-config.json` 与运行期配置都回滚。
- `gridState` 导入后所有使用方取到新引用。

### 前端交互

- 桌面：左键涂色、右键短按圆环、右键长按平移、滚轮缩放。
- 触屏：轻点涂色、长按圆环、单指拖动、双指捏合。
- 取色器：吸管光标、格子放大、浮窗颜色、点选后不误涂色。
- 设置弹窗：语言预览/关闭回退、密码保存、数据备份。
- 帮助弹窗：桌面/触屏两套文案正确。
- Edge 手势提示：只桌面版 Edge 出现，点「知道了」后不再提示。
- 显隐动画：弹窗淡出淡入，菜单图标交叉过渡。
- 大棋盘：百万格平移/缩放不卡死，LOD 生效。

### 开发者工具与导入导出

- 登录、退出、失败 5 次锁定、token 过期、服务端重启 token 失效。
- 矩形/闭合区域批量改色，`range` 本机套用颜色正确。
- 导出 `.bbx` 不含 `devPassword`。
- 导入二次确认，覆盖后 `devPassword` 保留，`port` 不热改。
- BBEX magic/版本/长度/校验和任一不符返回 400 `bad-package`。
- 上传大小限制、multipart 二进制不损坏。

## 常见坑索引

| 坑 | 去看 |
| --- | --- |
| 删 no-cache 导致新页面+旧模块 | `docs/architecture.md` 静态资源与缓存 |
| minify 中间件注册太晚 | `docs/architecture.md` 前端资源压缩 |
| esbuild target/charset 配错 | `docs/architecture.md` 前端资源压缩 |
| `auth` 返回对象导致 CONNECT 不发 | `docs/protocol.md` 握手与能力 |
| `online-users` 用 volatile 丢失 | `docs/protocol.md` Socket 事件 |
| `stateRev` / `syncRev` 混用 | `docs/protocol.md` 首屏三条路 |
| `runs` 游标/`start`/`readVarint` 错 | `docs/protocol.md` 批量改色差分广播 |
| 存档格式判定顺序错 | `docs/state-format.md` 存档 |
| 尺寸重排只改一个入口 | `docs/state-format.md` 尺寸变更重排 |
| `gridState` 缓存引用失效 | `docs/state-format.md` 尺寸变更重排 |
| 渲染不申请帧 / 缓存被打掉 | `docs/frontend.md` 渲染调度 |
| 合并同色 `fillRect` 盖网格线 | `docs/frontend.md` 大棋盘渲染 |
| 显隐动画瞬间消失 | `docs/frontend.md` 显隐动画 |
| 触屏取色误涂色 | `docs/frontend.md` 画布输入 |
| `suppressTouchContextMenu` 清太早 | `docs/frontend.md` 画布输入 |
| i18n 缓存了 `t()` 结果 | `docs/frontend.md` 国际化 |
| 导入不回滚 | `docs/protocol.md` 数据导出/导入 |
| multipart 改 UTF-8 损坏二进制 | `docs/protocol.md` 数据导出/导入 |