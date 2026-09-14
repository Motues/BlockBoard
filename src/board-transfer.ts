// 数据导出 / 导入：把 game-config.json 与二进制存档打包成一个文件（BBEX），
// 导入时解析、校验并把两者一起写回（配置重启也生效，状态立刻生效）。
//
// 容器格式（小端）：
//   'BBEX'                 4B   magic
//   uint16                 2B   格式版本（当前 1）
//   uint32                 4B   config 字节数
//   uint32                 4B   save 字节数（0 = 没有存档，棋盘按全黑起）
//   SHA-256(config 字节)   32B  导出文件被改动过 / 下载损坏时能立刻发现
//   SHA-256(save 字节)     32B  save 长度为 0 时是全 0
//   config 字节            JSON 文本，导出时**已剥离 devPassword**
//   save 字节              data/board-state.dat 原样（v3 存档自带 deflate）
//
// 为什么不用 zip：本项目零依赖、没有构建步骤，自己定一个带头和校验的容器
// 比引一个 zip 库更省事，也更容易在出错时说清楚是哪一段坏了。
//
// 导入时的关键约定：
//   · devPassword 一律保留服务器当前的值（不导入），免得一个来源不明的备份
//     把管理密码换掉、把操作者锁在开发者工具外面；
//   · 棋盘尺寸变了就按「左上角对齐」重排存档（与改 game-config.json 后重启一致）；
//   · 状态先落盘再广播，任何一步失败都会把 game-config.json 还原回去。

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { GameConfig, getTotalSquares, liveConfig, setLiveConfig } from './board-config';
import { gameConfigFilePath, writeGameConfig } from './board-persist';
import { replaceGrid } from './board-state';
import { decodeState, regridState } from './state';

const DATA_DIR = path.join(__dirname, '../data');
const SAVE_FILE = path.join(DATA_DIR, 'board-state.dat');

export const PACKAGE_MAGIC = 'BBEX';
export const PACKAGE_VERSION = 1;
/** magic + version + 两个长度 + 两个 SHA-256 */
const HEADER_BYTES = 4 + 2 + 4 + 4 + 32 + 32;
/** 单个打包文件的上限，防止一个超大上传把内存吃光 */
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;/** 棋盘尺寸的合法范围（同时挡住 total 溢出与「一个格子都放不下」的配置） */
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 100000;
const MAX_CELLS = 100_000_000;

/** 导入时保留的字段：包里的值一律被服务器当前值覆盖 */
const PRESERVED_FIELDS = ['devPassword'];

export interface PackageParts {
  /** game-config.json 的原文（UTF-8 JSON 文本） */
  config: Buffer;
  /** data/board-state.dat 的原文；没有存档时是空 Buffer */
  save: Buffer;
}

export interface PackageSummary {
  bytes: number;
  /** 包里的存档字节数（0 = 包里没有存档） */
  saveBytes: number;
  cols: number;
  rows: number;
}

export interface ImportResult extends PackageSummary {
  configBytes: number;
  /** 导入后的棋盘尺寸 */
  newCols: number;
  newRows: number;
  /** 棋盘尺寸是否发生了变化（变了就必须全员重同步） */
  sizeChanged: boolean;
}

/** 状态里出现的自定义颜色数量只在日志里用得上，这里不做统计 */
function sha256(data: Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

/** 定长比较，避免按字节短路比较带来的时间差 */
function sameDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 读当前磁盘上的 game-config.json，剥掉 devPassword 后作为导出内容 */
function exportConfigText(): Buffer {
  const configFile = gameConfigFilePath();

  if (!fs.existsSync(configFile)) {
    return Buffer.from(JSON.stringify(withoutSecrets(liveConfig), null, 2), 'utf-8');
  }

  const text = fs.readFileSync(configFile, 'utf-8').trim();
  if (text.length === 0) {
    return Buffer.from(JSON.stringify(withoutSecrets(liveConfig), null, 2), 'utf-8');
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Buffer.from(JSON.stringify(withoutSecrets(parsed as GameConfig), null, 2), 'utf-8');
    }
  } catch {
    // 磁盘上的 JSON 坏了：退回内存里的生效配置，别让导出整个失败
  }

  return Buffer.from(JSON.stringify(withoutSecrets(liveConfig), null, 2), 'utf-8');
}

function withoutSecrets(config: GameConfig): GameConfig {
  const { devPassword: _devPassword, ...safe } = config;
  return safe as GameConfig;
}

/**
 * 打包：game-config.json（已剥离 devPassword）+ data/board-state.dat。
 * 存档不存在（服务器还没写过盘）时 save 段长度写 0，导入方按全黑棋盘处理。
 */
export function exportPackage(): { file: Buffer; summary: PackageSummary } {
  const config = exportConfigText();
  let save = Buffer.alloc(0);

  try {
    if (fs.existsSync(SAVE_FILE)) save = fs.readFileSync(SAVE_FILE);
  } catch (error) {
    // 读不动存档不是致命的：导出配置也还是有意义的，但要在日志里留痕
    console.error('Failed to read the save file while exporting:', error);
    save = Buffer.alloc(0);
  }

  const configDigest = sha256(config);
  const saveDigest = save.length > 0 ? sha256(save) : Buffer.alloc(32);

  const header = Buffer.alloc(HEADER_BYTES);
  header.write(PACKAGE_MAGIC, 0, 'ascii');
  header.writeUInt16LE(PACKAGE_VERSION, 4);
  header.writeUInt32LE(config.length, 6);
  header.writeUInt32LE(save.length, 10);
  configDigest.copy(header, 14);
  saveDigest.copy(header, 46);

  const file = Buffer.concat([header, config, save]);

  return {
    file,
    summary: {
      bytes: file.length,
      saveBytes: save.length,
      cols: liveConfig.cols,
      rows: liveConfig.rows
    }
  };
}

/** 解析打包文件：magic / 版本 / 长度 / 校验和不符都返回 null */
export function parsePackage(file: Buffer): PackageParts | null {
  if (!Buffer.isBuffer(file) || file.length < HEADER_BYTES) return null;
  if (file.subarray(0, 4).toString('ascii') !== PACKAGE_MAGIC) return null;
  if (file.readUInt16LE(4) !== PACKAGE_VERSION) return null;

  const configLength = file.readUInt32LE(6);
  const saveLength = file.readUInt32LE(10);

  if (configLength === 0) return null;
  if (HEADER_BYTES + configLength + saveLength !== file.length) return null;

  const configDigest = file.subarray(14, 46);
  const saveDigest = file.subarray(46, 78);

  const config = file.subarray(HEADER_BYTES, HEADER_BYTES + configLength);
  const save = file.subarray(HEADER_BYTES + configLength);

  if (!sameDigest(sha256(config), configDigest)) return null;
  if (!sameDigest(save.length > 0 ? sha256(save) : Buffer.alloc(32), saveDigest)) return null;

  return { config, save };
}

/** 配置里的未知字段原样保留，但 null / undefined 要剔掉（它们会覆盖掉有效值） */
function normalizeConfig(raw: Record<string, unknown>): GameConfig {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && value !== undefined) out[key] = value;
  }

  return out as GameConfig;
}

/** 导入包本身合法、但内容不能接受时抛这个（HTTP 层据此回 400） */
export class ImportError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

function assertDimension(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ImportError('bad-config', `game-config.json 的 ${name} 必须是整数 / ${name} must be an integer`);
  }

  if (value < MIN_DIMENSION || value > MAX_DIMENSION) {
    throw new ImportError(
      'bad-config',
      `${name} 必须在 ${MIN_DIMENSION}..${MAX_DIMENSION} 之间 / ${name} must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}`
    );
  }

  return value;
}

/**
 * 校验 + 应用一个导入包。返回 null 表示文件不是合法的 BBEX 包（可能损坏）；
 * 抛 ImportError 表示包本身合法、但内容不能接受（配置非法 / 存档解不开 / 写盘失败）。
 *
 * 只有全部校验都通过才会动磁盘，所以不会出现「配置写了一半、存档没进去」的半成品。
 */
export function applyImport(raw: Buffer, onBoardReset?: () => void): ImportResult | null {
  const parsed = parsePackage(raw);
  if (!parsed) return null;

  // --- 1. 解析与校验配置 ---
  let rawConfig: unknown;

  try {
    rawConfig = JSON.parse(parsed.config.toString('utf-8'));
  } catch {
    throw new ImportError('bad-config', 'game-config.json 不是合法的 JSON / game-config.json is not valid JSON');
  }

  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new ImportError('bad-config', 'game-config.json 必须是一个对象 / game-config.json must be an object');
  }

  const next = normalizeConfig(rawConfig as Record<string, unknown>);

  if (next.rows === undefined) {
    throw new ImportError('bad-config', 'game-config.json 缺少 rows / game-config.json is missing rows');
  }
  if (next.cols === undefined) {
    throw new ImportError('bad-config', 'game-config.json is missing cols / game-config.json 缺少 cols');
  }

  const nextRows = assertDimension('rows', next.rows);
  const nextCols = assertDimension('cols', next.cols);

  if (nextRows * nextCols > MAX_CELLS) {
    throw new ImportError(
      'bad-config',
      `棋盘太大了（${nextCols} x ${nextRows}） / Board is too large (${nextCols} x ${nextRows})`
    );
  }

  // --- 2. 解码存档（按新配置的尺寸重排）---
  const saveBytes = parsed.save.length;
  const previousCols = liveConfig.cols;
  const previousRows = liveConfig.rows;
  let state: Uint32Array | null = null;

  if (saveBytes > 0) {
    let payload: Buffer;

    try {
      payload = zlib.inflateSync(parsed.save.subarray(21));
    } catch {
      throw new ImportError('bad-save', '存档解压失败，文件可能损坏 / Failed to inflate the save data');
    }

    let saveCols = nextCols;
    let saveRows = nextRows;

    try {
      const decode = decodeState(payload, nextCols * nextRows, nextCols, {
        cols: nextCols,
        rows: nextRows
      });
      saveCols = decode.source.cols;
      saveRows = decode.source.rows;
      state = decode.state;
    } catch {
      throw new ImportError('bad-save', '存档长度与配置对不上 / The save does not match the config');
    }

    // 存档尺寸和新配置不一样时按左上角对齐重排（与改完 game-config.json 重启一致）；
    // 一样时也走一遍，顺手把长度裁到 / 补到精确的格数
    state = regridState(
      state,
      Math.max(1, saveCols),
      Math.max(1, saveRows),
      nextCols,
      nextRows
    );
  }

  // --- 3. 落盘：配置与状态 ---
  // devPassword 沿用服务器当前的值；其它字段以包里的为准
  const merged: GameConfig = { ...next };

  for (const field of PRESERVED_FIELDS) {
    const current = (liveConfig as Record<string, unknown>)[field];
    if (current === undefined) delete merged[field];
    else merged[field] = current;
  }

  const previousConfig = liveConfig;
  const originalConfig = fs.existsSync(gameConfigFilePath())
    ? fs.readFileSync(gameConfigFilePath())
    : null;

  try {
    writeGameConfig(merged);
  } catch (error) {
    throw new ImportError(
      'write-failed',
      `game-config.json 写入失败：${(error as Error).message} / Failed to write game-config.json`
    );
  }

  try {
    setLiveConfig(merged, PRESERVED_FIELDS);
    replaceGrid(state || new Uint32Array(getTotalSquares()));
  } catch (error) {
    // 内存状态没能换过来：磁盘文件与运行期配置都还原回去，
    // 别留下「文件是新配置、服务端按旧配置跑」这种对不上的状态
    try {
      if (originalConfig) fs.writeFileSync(gameConfigFilePath(), originalConfig);
      else fs.rmSync(gameConfigFilePath(), { force: true });
    } catch {
      console.error('Failed to restore game-config.json after a failed import');
    }

    setLiveConfig(previousConfig, []);

    throw new ImportError('apply-failed', (error as Error).message || '导入失败 / Import failed');
  }

  const sizeChanged = previousCols !== nextCols || previousRows !== nextRows;

  console.log(
    `Data package imported: ${nextCols} x ${nextRows} (config ${parsed.config.length} bytes, ` +
    `save ${saveBytes} bytes${sizeChanged ? `, size changed from ${previousCols} x ${previousRows}` : ''})`
  );

  // 状态已经换好了才通知客户端重同步
  if (onBoardReset) onBoardReset();

  return {
    bytes: raw.length,
    saveBytes,
    configBytes: parsed.config.length,
    cols: previousCols,
    rows: previousRows,
    newCols: nextCols,
    newRows: nextRows,
    sizeChanged
  };
}

/** 导出文件名：BlockBoard-备份-<本地日期时间>.bbx */
export function exportFileName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');

  return 'BlockBoard-' +
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    '.bbx';
}
