// 与客户端同步的 socket.io 层：握手（首屏状态怎么发）、实时广播、增量日志。
// 状态本身在 board-state.ts，这里只负责"怎么发"。

import type { Server, Socket } from 'socket.io';
import { liveConfig, publicConfig, getTotalSquares } from './board-config';
import {
  bumpSyncRev,
  encodeCompactState,
  epoch,
  getDenseState,
  getGridState,
  getLegacyState,
  isValidIndex,
  paintSquare,
  queueSquareUpdate,
  syncRev,
  takePendingSquares
} from './board-state';
import { BLACK, CELL_BYTES, customValue, encodeRleBuffer, encodeStateBuffer, isCustomValue, toLegacyIndex } from './state';

/** 超过这个体积的棋盘状态就走分块下发 */
const CHUNK_THRESHOLD_BYTES = 96 * 1024;
/** 每块的目标大小 */
const CHUNK_TARGET_BYTES = 64 * 1024;

/** 增量日志的双上限（条数与总字节数，超了从最老的丢起） */
const PATCH_LOG_MAX_ENTRIES = 4000;
const PATCH_LOG_MAX_BYTES = 4 * 1024 * 1024;
const SYNC_DELTA_BATCH = 200;

/** 重新同步的令牌桶：可以主动要一次全量，但不能刷这个事件逼服务端反复编码整盘 */
const RESYNC_BURST = 5;
const RESYNC_PER_SECOND = 1 / 3;

/** 每个连接的改色令牌桶：正常点击远用不到，脚本刷屏会被挡住 */
const PAINT_BURST = 60;
const PAINT_PER_SECOND = 30;

interface PatchEntry {
  rev: number;
  event: string;
  payload: Record<string, unknown>;
  bytes: number;
}

const patchLog: PatchEntry[] = [];
let patchLogBytes = 0;
let onlineUsers = 0;

function estimatePayloadBytes(payload: Record<string, unknown>): number {
  let bytes = 64;
  if (typeof payload.runs === 'string') bytes += payload.runs.length;
  if (Array.isArray(payload.indices)) bytes += payload.indices.length * 4;
  if (Array.isArray(payload.cells)) bytes += payload.cells.length * 8;
  return bytes;
}

function logPatch(event: string, payload: Record<string, unknown>): void {
  const bytes = estimatePayloadBytes(payload);
  patchLog.push({ rev: syncRev, event, payload, bytes });
  patchLogBytes += bytes;

  while (patchLog.length > PATCH_LOG_MAX_ENTRIES || patchLogBytes > PATCH_LOG_MAX_BYTES) {
    const dropped = patchLog.shift();
    if (!dropped) break;
    patchLogBytes -= dropped.bytes;
  }
}

// 日志里最老的一条是 r1：只有客户端已持有 r1 - 1 及以后的状态，剩下的改动才全在日志里。
// 注意 rev 是"消息版本号"不是格子数 —— 客户端报 0 不代表棋盘是空的（可能刚从存档载入）。
function patchLogCovers(rev: number): boolean {
  return patchLog.length > 0 && patchLog[0].rev <= rev + 1;
}

function createLimiter(burst: number, perSecond: number): () => boolean {
  let tokens = burst;
  let last = Date.now();

  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSecond);
    last = now;

    if (tokens < 1) return false;

    tokens -= 1;
    return true;
  };
}

function socketCaps(socket: Socket): Set<string> {
  const stored = socket.data && socket.data.caps;
  return stored instanceof Set ? stored : new Set<string>();
}

function legacySquarePayload(index: number, value: number, rev: number) {
  return {
    index,
    value: toLegacyIndex(value),
    rgb: isCustomValue(value) ? value : null,
    isBlack: value === BLACK,
    rev
  };
}

/** 把这一窗口内的单格改动发出去（定时器到点、或发快照 / 存档之前） */
export function flushPending(io: Server): void {
  const batch = takePendingSquares();
  if (!batch) return;

  // 单格（最常见）：沿用原来的事件与载荷，老页面照旧
  if (batch.entries.length === 1) {
    const [index, value] = batch.entries[0];
    const payload = legacySquarePayload(index, value, batch.rev);
    io.emit('update-square', payload);
    logPatch('update-square', payload);
    return;
  }

  // 多格：声明了 batch 的客户端收一条数组，其余仍逐格发
  const message = { cells: batch.entries, rev: batch.rev };

  for (const socket of io.sockets.sockets.values()) {
    if (socketCaps(socket).has('batch')) {
      socket.emit('update-squares', message);
      continue;
    }

    for (const [index, value] of batch.entries) {
      socket.emit('update-square', legacySquarePayload(index, value, batch.rev));
    }
  }

  // 日志统一记成合并形状：会重放它的客户端都认识 batch
  logPatch('update-squares', message);
}

/** 批量改色的广播：矩形发 runs，闭合区域发 indices */
export function broadcastRegion(
  io: Server,
  color: number,
  payload: { start?: number; indices?: number[]; runs: string }
): void {
  const message = {
    ...payload,
    value: toLegacyIndex(color),
    rgb: isCustomValue(color) ? color : null,
    isBlack: color === BLACK,
    rev: bumpSyncRev()
  };

  io.emit('update-region', message);
  logPatch('update-region', message);
}

// --- 首屏状态下发 ---
// 三条路：
//   1. 客户端的 epoch / rev 与服务端一致 —— 什么都不用传（sync-done）
//   2. 版本号在增量日志覆盖范围内 —— 只补发差量（sync-delta）
//   3. 其余 —— 全量：小棋盘一条 init-game 装下，大棋盘分块（state-chunk ... state-done）

function basePayload() {
  return {
    config: publicConfig(),
    black: BLACK,
    maxColorIndex: 15,
    rgbSupport: true,
    epoch,
    rev: syncRev
  };
}

function sendChunkedState(socket: Socket, capSet: Set<string>): void {
  const { cols, rows } = liveConfig;
  const binary = capSet.has('bin');
  const rowsPerChunk = Math.max(1, Math.min(rows, Math.floor(CHUNK_TARGET_BYTES / (cols * CELL_BYTES))));
  const chunks = Math.max(1, Math.ceil(rows / rowsPerChunk));

  socket.emit('init-game', { ...basePayload(), stateMode: 'chunks', chunks, chunkRows: rowsPerChunk });

  let seq = 0;

  const step = (): void => {
    if (!socket.connected) return;

    if (seq >= chunks) {
      socket.emit('state-done', { rev: syncRev });
      return;
    }

    // 每块独立编码，跳过计数相对本块起点；客户端按行偏移套用
    const rowStart = seq * rowsPerChunk;
    const count = Math.min(rowsPerChunk, rows - rowStart);
    const cells = count * cols;
    const chunk = getGridState().subarray(rowStart * cols, rowStart * cols + cells);
    const rle = encodeRleBuffer(chunk);
    const useRle = rle.length <= cells * CELL_BYTES;
    const data = useRle ? rle : encodeStateBuffer(chunk);
    const encoding = useRle ? 'rle' : 'dense';

    socket.emit('state-chunk', {
      seq,
      rowStart,
      rows: count,
      encoding: binary ? `${encoding}-bin` : encoding,
      data: binary ? data : data.toString('base64')
    });

    seq++;
    // 让出事件循环，别把这次下发一口气做完而饿死其它连接
    setImmediate(step);
  };

  step();
}

function sendInitialState(
  socket: Socket,
  io: Server,
  capSet: Set<string>,
  auth: Record<string, unknown>
): void {
  // 先把排队中的单格改动 flush 出去：否则快照里已经包含它们、而版本号还没涨，
  // 客户端拿着这个版本号重连时会以为"什么都没漏"
  flushPending(io);

  const clientEpoch = Number(auth && auth.epoch);
  const clientRev = Number(auth && auth.rev);
  const canSync = capSet.has('sync') &&
    Number.isInteger(clientEpoch) && clientEpoch === epoch &&
    Number.isInteger(clientRev) && clientRev >= 0 && clientRev <= syncRev;

  if (canSync && clientRev === syncRev) {
    socket.emit('init-game', { ...basePayload(), stateMode: 'client' });
    socket.emit('sync-done', { rev: syncRev });
    return;
  }

  if (canSync && patchLogCovers(clientRev)) {
    socket.emit('init-game', { ...basePayload(), stateMode: 'client' });

    const patches = patchLog
      .filter((entry) => entry.rev > clientRev)
      .map((entry) => ({ event: entry.event, payload: entry.payload }));

    for (let i = 0; i < patches.length; i += SYNC_DELTA_BATCH) {
      socket.emit('sync-delta', {
        from: clientRev,
        to: syncRev,
        patches: patches.slice(i, i + SYNC_DELTA_BATCH)
      });
    }

    socket.emit('sync-done', { rev: syncRev });
    return;
  }

  // --- 全量 ---
  // 没声明 rgb24 的旧页面只认 4bit/格
  if (!capSet.has('rgb24')) {
    socket.emit('init-game', { ...basePayload(), state: getLegacyState().toString('base64') });
    return;
  }

  const compact = encodeCompactState();
  // 没有 rle 能力时，就算 RLE 更小也只能发它认识的稠密格式
  const encoding = compact.encoding === 'rle' && !capSet.has('rle') ? 'dense' : compact.encoding;
  const data = encoding === 'dense' ? getDenseState() : compact.data;

  if (capSet.has('chunk') && data.length > CHUNK_THRESHOLD_BYTES) {
    sendChunkedState(socket, capSet);
    return;
  }

  // 二进制能力：直接发 Buffer（socket.io 当二进制附件传，客户端收到 ArrayBuffer）
  socket.emit('init-game', {
    ...basePayload(),
    stateMode: 'inline',
    stateRgb: capSet.has('bin') ? data : data.toString('base64'),
    stateEncoding: capSet.has('bin') ? `${encoding}-bin` : encoding
  });
}

// --- 改色协议 ---

/** 把 { index, brush } / { index, rgb } 归一成单元格取值 */
function brushValue(payload: { brush?: number; rgb?: number }): number | null {
  const rgb = Number(payload && payload.rgb);
  if (Number.isInteger(rgb) && rgb >= 0 && rgb <= 0xffffff) return customValue(rgb);

  const brush = Number(payload && payload.brush);
  if (!Number.isInteger(brush) || brush < 1 || brush > 15) return null;

  return brush;
}

/** 与客户端一致：格子和画笔同色 → 擦成黑色，否则涂成画笔颜色 */
function toggleTo(index: number, value: number): void {
  paintSquare(index, getGridState()[index] === value ? BLACK : value);
  queueSquareUpdate(index);
}

/**
 * 数据导入之后调用：棋盘状态（可能连尺寸）整个换过了，所有在线客户端手里的
 * 都成了旧世界的坐标。发一条 board-reset，客户端据此丢掉本地缓存、清空棋盘，
 * 主动 sync-request 要一份全量（epoch 已经换了，服务端一定走全量那条路）。
 *
 * 为什么不让服务端直接推全量：全量可能是几 MB（还要分块），由客户端主动要
 * 更符合现有的协议 —— 顺便也复用了「中途断线就重新要一次」的那套逻辑。
 */
export function resetBoardForClients(io: Server): void {
  // 旧棋盘排队中的单格广播已经没有意义了（下标在新棋盘上可能越界）
  takePendingSquares();
  patchLog.length = 0;
  patchLogBytes = 0;

  io.emit('board-reset', { config: publicConfig(), epoch, rev: syncRev, total: getTotalSquares() });
  console.log(`[sync] board reset broadcast to ${io.sockets.sockets.size} client(s)`);
}

export function initStateSync(io: Server): void {
  io.on('connection', (socket: Socket) => {
    // 在线人数只在连接 / 断开时各发一次，丢了补不回来，所以**不能**用 volatile
    onlineUsers++;
    io.emit('online-users', onlineUsers);

    const authCaps = socket.handshake.auth ? socket.handshake.auth.caps : undefined;
    const capSet = new Set<string>(Array.isArray(authCaps) ? (authCaps as string[]) : []);
    socket.data.caps = capSet;

    const allowPaint = createLimiter(PAINT_BURST, PAINT_PER_SECOND);
    const allowResync = createLimiter(RESYNC_BURST, RESYNC_PER_SECOND);

    sendInitialState(socket, io, capSet, (socket.handshake.auth || {}) as Record<string, unknown>);

    socket.on('paint-square', (payload: { index?: number; brush?: number; rgb?: number }) => {
      const index = Number(payload && payload.index);
      if (!isValidIndex(index)) return;

      // 超频（脚本刷屏）时挡掉，并让客户端把乐观动画收回去
      if (!allowPaint()) {
        socket.emit('paint-rejected', { index });
        return;
      }

      const value = brushValue(payload);
      if (value === null) return;

      toggleTo(index, value);
    });

    // 兼容旧版页面：只有黑 / 白两色（等价于用 1 号颜色涂）
    socket.on('toggle-square', (index: number) => {
      if (!isValidIndex(index)) return;

      if (!allowPaint()) {
        socket.emit('paint-rejected', { index });
        return;
      }

      toggleTo(index, 1);
    });

    // 客户端主动要求重新同步：带上 epoch / rev 就能走增量，否则拿一次全量
    socket.on('sync-request', (payload: Record<string, unknown>) => {
      if (!allowResync()) return;

      sendInitialState(socket, io, capSet, payload && typeof payload === 'object' ? payload : {});
    });

    socket.on('disconnect', () => {
      onlineUsers--;
      io.emit('online-users', onlineUsers);
    });
  });
}
