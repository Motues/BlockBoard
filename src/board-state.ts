// 棋盘状态本体：格子数据、世代 / 版本号、快照缓存、改色与写盘。
// 不碰 socket —— 广播在 board-sync.ts，需要广播时调用注入进来的 onFlush。

import { TOTAL_SQUARES, gameConfig } from './board-config';
import { loadBoardState, saveBoardState } from './board-persist';
import {
  CELL_BYTES,
  CellChange,
  encodeChangedRuns,
  encodeLegacyStateBuffer,
  encodeRleBuffer,
  encodeStateBuffer
} from './state';

export interface PaintResult {
  changed: number;
  /** 变化格子的 RLE（[跳过多少格, 连续多少格, 颜色值]），空串表示没有变化 */
  runs: string;
}

/** 一次广播里"真的变了"的格子 */
export type ChangedCell = [index: number, value: number];

export const gridState = new Uint32Array(TOTAL_SQUARES);

export let stateRev = 0;
export let syncRev = 0;
export let epoch = 0;

let savedRev = 0;

// 由 server.ts 注入：flush 待广播的改动、写盘、广播批量改色
let onFlush: () => void = () => {};
let persist: () => void = () => {};
let onRegionPaint: (color: number, payload: RegionPayload) => void = () => {};

export interface RegionPayload {
  /** 矩形：runs 的基准下标 */
  start?: number;
  /** 闭合区域：一组散落的格子 */
  indices?: number[];
  runs: string;
}

export function newEpoch(): number {
  return (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0;
}

function touchState(): void {
  stateRev++;
}

/** 版本号只增不减：差量是绝对写入，乱序 / 重复应用都不会出错 */
export function bumpSyncRev(): number {
  return ++syncRev;
}

/** 启动时载入存档 */
export function initBoardState(hooks: {
  onFlushPending: () => void;
  onPersist: () => void;
  onRegionPaint: (color: number, payload: RegionPayload) => void;
}): void {
  onFlush = hooks.onFlushPending;
  persist = hooks.onPersist;
  onRegionPaint = hooks.onRegionPaint;

  const loaded = loadBoardState();
  gridState.set(loaded.state);

  // 尺寸变了 / 没有存档时 loadBoardState 返回 0：换新世代作废客户端缓存
  epoch = loaded.epoch || newEpoch();
  syncRev = loaded.rev;
}

// --- 全盘编码的快照缓存 ---
// 按 stateRev 缓存并按需计算：先只算 RLE，稠密格式的字节数是固定的（格子数 × 3），
// 比长度就能决定用哪个，不必先编码出来。
const snapshot: { rev: number; rle: Buffer | null; dense: Buffer | null; legacy: Buffer | null } = {
  rev: -1,
  rle: null,
  dense: null,
  legacy: null
};

function currentSnapshot(): typeof snapshot {
  if (snapshot.rev !== stateRev) {
    snapshot.rev = stateRev;
    snapshot.rle = null;
    snapshot.dense = null;
    snapshot.legacy = null;
  }
  return snapshot;
}

export function getDenseState(): Buffer {
  const snap = currentSnapshot();
  if (!snap.dense) snap.dense = encodeStateBuffer(gridState);
  return snap.dense;
}

/** 老页面认的 4bit/格 状态 */
export function getLegacyState(): Buffer {
  const snap = currentSnapshot();
  if (!snap.legacy) snap.legacy = encodeLegacyStateBuffer(gridState);
  return snap.legacy;
}

/** 优先 RLE，只有"每格颜色都不同"的噪点棋盘才会比稠密格式更大 */
export function encodeCompactState(): { encoding: 'rle' | 'dense'; data: Buffer } {
  const snap = currentSnapshot();
  if (!snap.rle) snap.rle = encodeRleBuffer(gridState);

  return snap.rle.length <= TOTAL_SQUARES * CELL_BYTES
    ? { encoding: 'rle', data: snap.rle }
    : { encoding: 'dense', data: getDenseState() };
}

export function isValidIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TOTAL_SQUARES;
}

// --- 改色 ---

/** 单格改色；值为 0 就是擦成黑色。返回是否真的变了 */
export function paintSquare(index: number, value: number): boolean {
  if (!isValidIndex(index) || gridState[index] === value) return false;

  gridState[index] = value;
  touchState();
  return true;
}

function applyCell(index: number, color: number, changes: CellChange[]): void {
  if (!isValidIndex(index) || gridState[index] === color) return;

  gridState[index] = color;
  changes.push({ index, value: color });
}

/** 矩形区域改色。行优先遍历，changes 天然按下标升序 */
export function paintRect(
  x: number,
  y: number,
  width: number,
  height: number,
  color: number
): PaintResult {
  const changes: CellChange[] = [];

  for (let row = 0; row < height; row++) {
    const rowStart = (y + row) * gameConfig.cols + x;
    for (let col = 0; col < width; col++) {
      applyCell(rowStart + col, color, changes);
    }
  }

  if (changes.length === 0) return { changed: 0, runs: '' };

  touchState();

  // start 必须一起发出去：runs 里的跳过计数是相对上一段结束的，客户端少了基准会从 0 套用
  const start = y * gameConfig.cols + x;
  const runs = encodeChangedRuns(changes, start);
  onRegionPaint(color, { start, runs });

  return { changed: changes.length, runs };
}

/** 一组散落的格子（闭合区域填充）改色 */
export function paintCells(cells: number[], color: number): PaintResult {
  const changes: CellChange[] = [];

  for (const index of cells) applyCell(index, color, changes);

  if (changes.length === 0) return { changed: 0, runs: '' };

  touchState();

  // runs 留空表示"这个颜色对所有下标都成立"
  onRegionPaint(color, { indices: cells, runs: '' });

  return { changed: changes.length, runs: '' };
}

// --- 广播合并：16ms 窗口内的多次单格改动合成一条消息 ---
const BROADCAST_WINDOW_MS = 16;
const pendingSquares = new Map<number, number>();
let flushTimer: NodeJS.Timeout | null = null;

export function queueSquareUpdate(index: number): void {
  pendingSquares.set(index, gridState[index]);

  if (flushTimer) return;

  flushTimer = setTimeout(() => {
    flushTimer = null;
    onFlush();
  }, BROADCAST_WINDOW_MS);
}

export interface PendingBatch {
  entries: ChangedCell[];
  rev: number;
}

/** 取出待广播的改动并分配一个新版本号；没有改动返回 null */
export function takePendingSquares(): PendingBatch | null {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (pendingSquares.size === 0) return null;

  const entries = Array.from(pendingSquares) as ChangedCell[];
  pendingSquares.clear();

  return { entries, rev: bumpSyncRev() };
}

// --- 存档 ---

/** 立刻写盘。写盘前先把待广播的改动发出去，让存档里的 rev 与状态配套 */
export function saveNow(): void {
  onFlush();

  savedRev = saveBoardState({
    state: gridState,
    epoch,
    rev: syncRev,
    stateRev,
    savedRev
  });
}

export function startAutoSave(intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(saveNow, intervalMs);
  console.log(`Auto-save enabled: every ${intervalMs / 1000} seconds`);
  return timer;
}
