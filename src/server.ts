// BlockBoard 服务端入口：Hono 应用、静态资源、socket.io 连线与启动。
// 具体逻辑按功能拆分：
//   board-config.ts    配置 + 可下发给客户端的配置（剥离 devPassword）
//   board-persist.ts   存档读写与尺寸重排
//   board-state.ts     棋盘状态、世代 / 版本号、快照缓存、改色
//   board-sync.ts      socket.io 协议（首屏下发、实时广播、增量日志）
//   dev-api.ts         开发者工具与数据导入 / 导出接口
//   board-transfer.ts  打包文件的格式与应用（BBEX）
//   minify.ts          前端资源压缩（去注释 / 压行 / 局部变量改名，启动时压一次放内存）

import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Server } from 'socket.io';
import http from 'http';
import path from 'path';
import { liveConfig, getTotalSquares } from './board-config';
import { initBoardState, paintCells, paintRect, saveNow, startAutoSave } from './board-state';
import { broadcastRegion, flushPending, initStateSync, resetBoardForClients } from './board-sync';
import { registerDevApi, resolveDevPassword } from './dev-api';
import { minifyPublicAssets, serveMinified, describeMinifyResult, type MinifyResult } from './minify';

const app = new Hono();

// 客户端源码的目录：只在启动时读一遍，压缩结果常驻内存
const publicDir = path.join(__dirname, '../public');

// --- 静态资源 ---
// 要求浏览器每次回源校验（no-cache 仍允许 304）。本项目没有打包步骤，模块之间是裸的相对
// 路径 import，URL 上没有版本号；只靠 Last-Modified 的话浏览器会把旧模块缓存住，出现
// "新页面 + 旧模块"的混合，整个模块图加载失败（画布、在线人数都不出来）。
app.use('/*', async (c, next) => {
  await next();

  if (/\.(?:html|js|mjs|css|json)$/.test(c.req.path)) {
    c.header('Cache-Control', 'no-cache');
  }
});

// 压缩后的 js / css（见 minify.ts）。**必须排在 serveStatic 前面**：命中就发内存里那份，
// 没命中（.svg / 字体 / 压缩失败的文件）由它 next() 交给 serveStatic。
// 这里传的是"取结果"的函数，压完之前它返回 null，请求照旧走源码 —— 页面永远不会因为
// 压缩还没做完就打不开。注意不能在压完之后再 app.use：Hono 的中间件栈在第一个请求
// 进来时就定下来了，后加的不会再生效
let minified: MinifyResult | null = null;
app.use('/*', serveMinified(() => minified));

// 放在接口之后注册，静态文件不会盖掉 /api/*
app.use('/*', serveStatic({ root: publicDir }));

// --- HTTP 服务 ---
// 数据导入要把整个存档包（可能几十 MB）传上来，所以给上传留够空间：
// node:http 的 maxRequestBodySize 还没进 @types/node，这里用 createAdaptorServer 显式声明
// （HTTP 层真的拒绝时是 413；dev-api.ts 里另有一层应用层兜底）。
const MAX_BODY_BYTES = 256 * 1024 * 1024;
const serverOptions: Record<string, unknown> = { maxRequestBodySize: MAX_BODY_BYTES };
const serverInstance = createAdaptorServer({
  fetch: app.fetch,
  // 用 node:http 的 createServer（socket.io 要挂到这个 server 上）
  createServer: http.createServer,
  serverOptions: serverOptions as http.ServerOptions
});

// perMessageDeflate：超过 1KB 的消息（棋盘状态）压一遍再传，几百字节的格子广播不受影响
const io = new Server(serverInstance, {
  perMessageDeflate: { threshold: 1024 },
  // 上行单条消息上限：涂格子只有几十字节，批量改色走 HTTP
  maxHttpBufferSize: 1e6
});

// --- 状态与存档 ---
// flushPending 要在发快照 / 写盘之前把待广播的改动发出去，
// 这样存档与快照里的 rev 才和状态配套
initBoardState({
  onFlushPending: () => flushPending(io),
  onPersist: () => flushPending(io),
  onRegionPaint: (color, payload) => broadcastRegion(io, color, payload)
});

startAutoSave(60 * 1000);

// --- 开发者工具 ---
const devPassword = resolveDevPassword();

const devApi = registerDevApi(app, {
  password: devPassword.password,
  sessionHours: Number(liveConfig.devSessionHours) || 8,
  cols: liveConfig.cols,
  rows: liveConfig.rows,
  paintRect,
  paintCells,
  // 数据导入成功（棋盘可能连尺寸一起换了）：让所有在线客户端丢掉缓存重新拉全量
  onBoardReset: () => resetBoardForClients(io)
});

console.log(
  devApi.enabled
    ? `Developer tools: enabled (password from ${devPassword.source === 'env' ? 'DEV_PASSWORD' : 'game-config.json devPassword'})`
    : 'Developer tools: disabled (set DEV_PASSWORD or gameConfig.devPassword to enable them)'
);

// --- socket.io ---
initStateSync(io);

// --- 前端资源压缩 ---
// 启动时把 public/ 下的 js / css 压一遍（去注释、压行、局部变量改名）存进 minified，
// 上面的中间件会取它。压不动也不会挡启动：失败的照旧发源码。
// 和监听并行跑：压缩没做完就来的那几个请求由 serveStatic 发源码，做完之后全走内存里那份。
(async () => {
  try {
    minified = await minifyPublicAssets(publicDir);
    console.log(describeMinifyResult(minified));
  } catch (error) {
    console.error('Frontend minify skipped (serving source files):', error);
  }
})();

// --- 开始监听 ---
// 放在状态、接口、socket 都准备好之后：早开一秒就可能有人带着
// /api/dev/import 或一条 socket 消息打进来，而那时棋盘还没载入
serverInstance.listen(liveConfig.port, () => {
  console.log(`BlockBoard run on http://localhost:${liveConfig.port}`);
  console.log(`Current grid: ${liveConfig.cols} x ${liveConfig.rows} (Total ${getTotalSquares()} squares)`);
});

serverInstance.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${liveConfig.port} is already in use — is another BlockBoard already running?`);
    process.exit(1);
  }

  console.error('HTTP server error:', error);
});

// --- 退出前保存 ---
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\nShutting down...');
    saveNow();
    process.exit(0);
  });
}