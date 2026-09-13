// BlockBoard 服务端入口：Hono 应用、静态资源、socket.io 连线与启动。
// 具体逻辑按功能拆分：
//   board-config.ts   配置 + 可下发给客户端的配置（剥离 devPassword）
//   board-persist.ts  存档读写与尺寸重排
//   board-state.ts    棋盘状态、世代 / 版本号、快照缓存、改色
//   board-sync.ts     socket.io 协议（首屏下发、实时广播、增量日志）
//   dev-api.ts        开发者工具接口

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Server } from 'socket.io';
import path from 'path';
import { gameConfig, TOTAL_SQUARES } from './board-config';
import { initBoardState, paintCells, paintRect, saveNow, startAutoSave } from './board-state';
import { broadcastRegion, flushPending, initStateSync } from './board-sync';
import { registerDevApi, resolveDevPassword } from './dev-api';

const app = new Hono();

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

// 放在接口之后注册，静态文件不会盖掉 /api/*
app.use('/*', serveStatic({ root: path.join(__dirname, '../public') }));

// --- HTTP 服务 ---
const serverInstance = serve({ fetch: app.fetch, port: gameConfig.port }, (info) => {
  console.log(`BlockBoard run on http://localhost:${info.port}`);
  console.log(`Current grid: ${gameConfig.cols} x ${gameConfig.rows} (Total ${TOTAL_SQUARES} squares)`);
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
  sessionHours: Number(gameConfig.devSessionHours) || 8,
  cols: gameConfig.cols,
  rows: gameConfig.rows,
  paintRect,
  paintCells
});

console.log(
  devApi.enabled
    ? `Developer tools: enabled (password from ${devPassword.source === 'env' ? 'DEV_PASSWORD' : 'game-config.json devPassword'})`
    : 'Developer tools: disabled (set DEV_PASSWORD or gameConfig.devPassword to enable them)'
);

// --- socket.io ---
initStateSync(io);

// --- 退出前保存 ---
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\nShutting down...');
    saveNow();
    process.exit(0);
  });
}
