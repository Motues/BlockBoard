
# 架构总览

## 项目结构

服务端按功能拆分，依赖方向单向：

`server` → `board-sync` → `board-state` → `board-persist` / `board-config`

- `src/server.ts` —— 入口：Hono 应用、静态资源、socket.io 连线、启动与退出。只做装配。
- `src/board-config.ts` —— 棋盘配置，以及可下发给客户端的配置（`publicConfig()` 剥离 `devPassword`）。敏感字段只有这一个出口。配置运行期可变，别把 `rows` / `cols` 缓存成常量，用 `liveConfig` / `getTotalSquares()` / `publicConfig()`。它还是**第一个碰配置**的模块，所以两件事放在这里：生效配置 `data/config/game-config.json` 不存在时先生成一份（优先从仓库 / 镜像里那份 `game-config.example.json` 种子拷过来，种子也不在才写代码里的 `DEFAULT_CONFIG`；删掉生效配置重启就能恢复出厂设置），以及 `PORT` 环境变量压过配置里的 `port`（Docker 靠它把内部端口钉在 3000）。配置**在运行期用 `fs.readFileSync` 读**，不用 `import rawConfig from '../game-config.example.json'` —— 静态 require 跑在首启生成配置之前，文件不存在时直接 `MODULE_NOT_FOUND`，写配置那一步就没机会执行；类型仍由 `import type` 提供，编译后不留 require（**但 tsc 仍要求文件在编译期存在**，所以 Docker builder 里必须 COPY 它）。
- `src/board-persist.ts` —— 存档读写（v3 / v2 / 老格式）与尺寸变更重排，以及把配置写回 `data/config/game-config.json`（`writeGameConfig`）。所有落盘都走 `writeFileAtomic()`：先 `.tmp` 再 `rename`；目标是**被挂载进来的单个文件**时 `rename` 会报 `EBUSY`（比如有人把 `game-config.json` 单独挂进容器），退回原地覆写 —— 细节见 `doc/state-format.md`。
- `src/board-state.ts` —— 棋盘状态：格子数据、epoch / `syncRev`、全盘编码快照缓存、改色、广播合并、自动存档、导入整盘替换（`replaceGrid`）。不 import socket。
- `src/board-sync.ts` —— socket.io 协议：首屏状态下发（单帧 / 分块 / 增量）、实时广播、增量日志、令牌桶、导入后的全员重同步（`resetBoardForClients`）。
- `src/board-transfer.ts` —— 数据导出 / 导入的 BBEX 打包格式与导入应用 + 回滚。
- `src/state.ts` —— 取值约定与编解码（24bit / 4bit / 1bit、RLE、批量差量 runs、重排）。编码先出 `Buffer`，字符串版只是 base64 包装；存档是带 magic、尺寸、epoch、rev 与 deflate 的 v3 格式（`buildSaveFile` / `parseSaveFile`，v2 也能读）。
- `src/dev-api.ts` —— 开发者工具服务端：密码解析、密码换 token、token 校验、批量改色、数据导出 / 导入。
- `src/minify.ts` —— 前端资源压缩：启动时用 esbuild 把 `public/` 下 js / css 去注释、压行、改局部变量名，结果常驻内存后由中间件发出。
- `public/` —— 纯 ES module 客户端，无打包、无构建步骤，由 `public/index.html` 通过 `public/js/main.mjs` 加载。源码就是发给浏览器的那套的可读版本，压缩只发生在发送时。
- `game-config.example.json` —— 棋盘尺寸、端口、开发者密码、会话时长。**进版本库**，但只是**首次启动的种子**（也是 tsc 取类型的来源）：生效的是 `data/config/game-config.json`，首启时由它拷过来，之后改仓库里这份不生效。`.gitignore` 掉了 `data/`，所以生效配置不进版本库（里面可能有 `devPassword`）。端口可被环境变量 `PORT` 覆盖（优先级更高），Docker 部署就是这么固定内部 3000 的。
- `Dockerfile` / `docker-compose.yml` / `.dockerignore` —— 容器部署。内部端口固定 `3000`（`ENV PORT=3000`），只挂 `data/` 一个目录（配置与存档都在里面）：配置不是挂载点，导入存档可以照常原子写盘。没有 entrypoint，直接 `USER node`（uid 1000）跑 `node dist/server.js`，所以挂载出来的 `data/` 要归 uid 1000。
- `data/` —— 运行时生成的存档目录（`board-state.dat`、`board-size.json`），不进版本库。
- `FEATURE.md` —— 还没做的同步优化（分块下发 / 增量同步 / 瓦片）。

`board-state` 需要广播或写盘时，通过 `initBoardState()` 注入的回调（`onFlushPending` / `onPersist` / `onRegionPaint`）回调到 `server.ts`，不反向 import `board-sync`。

> `init-game` 下发的 `config` 走 `publicConfig()`，不再包含 `devPassword`。以前直接 spread `game-config.json` 会把开发者密码明文发给每个客户端。加字段时注意别再把敏感项塞进 `gameConfig` 直接下发。

## 静态资源与缓存

`public/**` 由 `serveStatic` 托管；前面挂了一层中间件，给 `.html / .js / .mjs / .css / .json / .txt` 加 `Cache-Control: no-cache`。Hono 的 serveStatic 不发 ETag、也不处理条件请求，实际效果接近“每次都重新下载”，本地/局域网可忽略。`.txt` 只有 `public/llms.txt`（给 AI 的接口说明，见 `doc/protocol.md`），改了要立刻能拿到。

为什么必须有：项目没有打包步骤，模块之间是裸相对路径 `import`（`./shared.mjs`），URL 上挂不了版本号。只靠 `Last-Modified` 的话，浏览器会启发式缓存旧模块，出现“新页面 + 旧模块”，整个模块图加载失败，表现是画布和在线人数都不出来。普通刷新未必恢复。踩过一次，别删这层中间件。

前端还会显式报连接状态（`connection.mjs`）：`disconnect` / `connect_error` 时把在线人数显示成 `—` 并弹一次 toast（10 秒节流），这样“服务端没在运行”和“页面坏了”能一眼分开。

## 前端资源压缩

发给浏览器的 js / css 是运行时压过一遍的：启动时 `minifyPublicAssets()` 用 esbuild 的 `transform`（不打包）把 `public/js/*.mjs` 与 `public/styles.css` 逐个压成一行、去注释、局部变量改名，结果放进 `minified`，由挂在 `serveStatic` 之前的 `serveMinified()` 直接发出。实测 21 个文件 262 KB → 119 KB（-55%），启动几十毫秒，之后每个文件只压一次，全在内存。

必须记住：

- **中间件要在模块顶层 `app.use` 注册**，不能在压缩完成后再注册。Hono 中间件栈在第一个请求进来时就定下来，之后 `app.use` 不再生效。传进 `serveMinified()` 的是 `() => minified`，压完之前返回 `null`、请求回落源码。
- `target` 必须 `esnext`：客户端有顶层 await，写 `es2020` 会报 “Top-level await is not available” 并跳过整个文件。
- `charset` 必须 `utf8`：esbuild 默认 `ascii`，会把中日韩文案转 `\uXXXX`，`i18n.mjs` 压完反而更大。
- 压缩只压不改结构：不打包，每个 `.mjs` 仍是独立 ES module，相对路径 import 照旧。跨模块导入/导出名保留原名，真正混淆需要打包成单文件，会改部署形态，没做。
- 某个文件压失败只记日志并跳过，`minifyPublicAssets()` 不抛错；esbuild 是运行时依赖，放在 `dependencies`，生产装包只装 dependencies 时压缩才有效。