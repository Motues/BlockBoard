// 棋盘状态本体：格子数据、世代 / 版本号、快照缓存、改色与写盘。
// 不碰 socket —— 广播在 board-sync.ts，需要广播时调用注入进来的 onFlush。

import { getTotalSquares, liveConfig } from './board-config';
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
  /**
   * 这份 runs 的基准下标。**广播和 HTTP 响应必须用它**：
   * 客户端本机套用（用响应里的 start）+ 广播落地是同一条 runs，
   * 两边基准不一致就会画成错开的两份（见 paintValues 的注释）
   */
  start?: number;
}

/** 一次广播里"真的变了"的格子 */
export type ChangedCell = [index: number, value: number];

// 注意是 let：数据导入会整块换掉这个数组（棋盘尺寸可能变了）。
// 一律用 getGridState() 取当前引用，别在模块顶层缓存它。
// 类型显式写成 Uint32Array<ArrayBufferLike>：state.ts 里的 decoders 返回的就是它，
// 而裸写 Uint32Array 会被推断成 Uint32Array<ArrayBuffer>（两者不能互相赋值）
let gridState: Uint32Array<ArrayBufferLike> = new Uint32Array(getTotalSquares());

export function getGridState(): Uint32Array<ArrayBufferLike> {
  return gridState;
}

export let stateRev = 0;
export let syncRev = 0;
export let epoch = 0;

let savedRev = 0;

// 由 server.ts 注入：flush 待广播的改动、写盘、广播批量改色。
// color 传 null 表示"颜色写在 runs 的每一段里"（逐格取值写入），见 board-sync 的 broadcastRegion
let onFlush: () => void = () => {};
let persist: () => void = () => {};
let onRegionPaint: (color: number | null, payload: RegionPayload) => void = () => {};

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
  onRegionPaint: (color: number | null, payload: RegionPayload) => void;
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

  return snap.rle.length <= getTotalSquares() * CELL_BYTES
    ? { encoding: 'rle', data: snap.rle }
    : { encoding: 'dense', data: getDenseState() };
}

export function isValidIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < getTotalSquares();
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
  const cols = liveConfig.cols;

  for (let row = 0; row < height; row++) {
    const rowStart = (y + row) * cols + x;
    for (let col = 0; col < width; col++) {
      applyCell(rowStart + col, color, changes);
    }
  }

  if (changes.length === 0) return { changed: 0, runs: '' };

  touchState();

  // start 必须一起发出去：runs 里的跳过计数是相对上一段结束的，客户端少了基准会从 0 套用
  const start = y * cols + x;
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

/**
 * 逐格写入：cells 与 values 一一对应，同一批里每格可以是不同取值
 * （导入选区 JSON / AI 绘图走这条）。
 *
 * `cells` 必须按下标升序（`encodeChangedRuns` 的跳过量是相对上一段结束位置的，
 * 顺序乱了游标会漂；调用方按行优先拼下标即可自然满足）。
 * 广播时消息级的 `value` / `rgb` / `isBlack` 表达不了多种颜色，所以给 onRegionPaint
 * 传 null —— 颜色由 runs 的每一段自己带，客户端也是按段读的。
 *
 * `base` 是这批格子在棋盘上的起点（区域左上角）。runs 的跳过计数相对它算，
 * **返回的 start 也必须被 HTTP 响应原样带回去**：客户端拿到响应会先在本机套用一遍，
 * 广播随后也会到，两边用的是同一串 runs，基准不一致就会变成"导入画了两遍还错位"。
 * （早先这里用 `changes[0].index` 当基准，区域左上角本来就是目标色时第一格不变，
 * 于是 changes[0] 往后挪，而响应里的 start 还是区域起点，两份画面整体错开。）
 */
export function paintValues(cells: number[], values: number[], base: number): PaintResult {
  const changes: CellChange[] = [];

  for (let i = 0; i < cells.length; i++) applyCell(cells[i], values[i], changes);

  if (changes.length === 0) return { changed: 0, runs: '' };

  touchState();

  // base 比第一个改动还靠后时取小的那个，保证跳过计数不会是负数（正常调用不会发生）
  const start = Math.min(base, changes[0].index);
  const runs = encodeChangedRuns(changes, start);
  onRegionPaint(null, { start, runs });

  return { changed: changes.length, runs, start };
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

/**
 * 数据导入：把整块棋盘换成新的状态。
 *
 * `state` 必须已经按**当前配置**的尺寸重排好（重排由调用方用 regridState 做，
 * 因为导入的存档尺寸可能是另一个）。这里会换一个新的 epoch 作废所有客户端的本地缓存，
 * 并把 rev 归零（旧版本号的差量在新棋盘上毫无意义），然后立刻写盘。
 */
export function replaceGrid(state: Uint32Array<ArrayBufferLike>): void {
  const total = getTotalSquares();

  if (state.length !== total) {
    throw new Error(`imported state has ${state.length} cells, expected ${total}`);
  }

  // 排队中的单格广播属于**旧**棋盘：先发出去再换状态（写盘前也需要它，
  // 存档里的 rev 必须与状态配套）
  onFlush();

  gridState = state;
  epoch = newEpoch();
  syncRev = 0;

  // 旧快照由 stateRev 作废；旧待广播队列里的下标在新棋盘上可能已经越界
  pendingSquares.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  touchState();

  saveNow();

  console.log(
    `Imported board state applied: ${liveConfig.cols} x ${liveConfig.rows}, ` +
    `epoch ${epoch}, rev ${syncRev}, stateRev ${stateRev}`
  );
}

export function startAutoSave(intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(saveNow, intervalMs);
  console.log(`Auto-save enabled: every ${intervalMs / 1000} seconds`);
  return timer;
}
