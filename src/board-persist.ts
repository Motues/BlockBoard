// 棋盘存档：读盘、定时写盘、棋盘尺寸变更时的重排。

import fs from 'fs';
import path from 'path';
import { CONFIG_FILE_PATH, GameConfig, getTotalSquares, liveConfig } from './board-config';
import {
  SourceDims,
  buildSaveFile,
  decodeState,
  parseSaveFile,
  regridState
} from './state';

const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'board-state.dat');
// 存档对应的棋盘尺寸：改了 game-config.json 后靠它还原旧存档的行列数
const META_FILE = path.join(DATA_DIR, 'board-size.json');
/** 生效配置文件：`data/config/game-config.json`。路径由 board-config 给出，别在这里另写一份。 */
const CONFIG_FILE = CONFIG_FILE_PATH;

export interface LoadedBoard {
  state: Uint32Array;
  epoch: number;
  /** 存档对应的同步版本号；没有存档时为 0 */
  rev: number;
}

function readSavedDims(): SourceDims | null {
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
    const cols = Number(meta && meta.cols);
    const rows = Number(meta && meta.rows);
    if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) {
      return { cols, rows };
    }
  } catch {
    // 没有 / 读不动，按当前配置读
  }
  return null;
}

export function writeSavedDims(): void {
  try {
    const meta = { cols: liveConfig.cols, rows: liveConfig.rows };
    writeFileAtomic(META_FILE, JSON.stringify(meta, null, 2));
  } catch (error) {
    console.error('Failed to write the board size file:', error);
  }
}

/**
 * rename 覆盖不了的错误码：这类错误说明「这个目标不能靠 rename 换掉」，不是磁盘满了之类的硬故障，
 * 原地覆写通常能成功，所以值得退回。
 *
 * 主要是 **挂载点**：Linux 对 mount point 的 rename 一律返回 EBUSY（Node 报
 * "EBUSY: resource busy or locked"）。Docker 把**单个文件**挂进容器就是这样 —— 不管
 * `./game-config.json:/app/game-config.json` 还是命名卷挂在文件上，目标都是挂载点，
 * `.tmp` 写得进去、`rename` 换不过去。现在配置在 `data/config/` 里、整个 `data/` 是目录挂载，
 * 正常情况走不到这条路；留着重退是为了「有人又把单个文件挂进来」和只读根文件系统。
 * 另外跨文件系统的绑定挂载会返回 EXDEV，Docker Desktop（Windows / macOS）的挂载常见 EPERM；
 * 目录不可写但文件可写时 rename 报 EACCES，而原地覆写只需要文件本身的写权限。
 *
 * 不在这里的错误码（ENOSPC / EROFS / ENOENT 等）直接抛出去：原地覆写救不了，
 * 反而可能把文件截断成半份。
 */
const RENAME_FALLBACK_CODES = new Set(['EBUSY', 'EXDEV', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'ENOSYS']);

/** 已经为哪些文件打过「退回原地覆写」的警告：自动存档每 60 秒一次，别刷屏 */
const warnedInPlacePaths = new Set<string>();

/**
 * 已经被判定为「只能原地覆写」的文件：第一次失败之后记住，之后不再白写一遍 `.tmp`。
 * 这样退回路径的 I/O 与正常路径一样（一次 write），只是少了原子性 —— 挂载点上本来就没有原子性。
 * 进程内不会变：挂载结构要变必然伴随容器重建。
 */
const inPlacePaths = new Set<string>();

function warnInPlace(targetPath: string, reason: string): void {
  if (warnedInPlacePaths.has(targetPath)) return;
  warnedInPlacePaths.add(targetPath);

  console.warn(
    `Cannot replace ${targetPath} atomically (${reason}); writing it in place instead. ` +
    'This is normal when the file itself is a Docker bind mount or named volume. ' +
    `/ 无法原子替换 ${targetPath}（${reason}），改为原地覆写：单个文件被挂载进容器时就是这样`
  );
}

/**
 * 写文件：先写 `.tmp` 再 rename（原子替换）；目标换不掉时退回原地覆写。
 *
 * 退回的两种情况：
 *   · 目标是被挂载进来的文件（rename 报 EBUSY 等）：见 RENAME_FALLBACK_CODES；
 *   · 所在目录不可写但文件本身可写（连 `.tmp` 都建不出来）：例如只读根文件系统 + 挂载配置文件。
 * 原地覆写没有原子性（写一半崩了会留半份文件），但比整个导入失败强；只在上面两种情况发生，
 * 每个文件只警告一次，并且之后直接走原地覆写（不再多写一遍 `.tmp`）。
 */
export function writeFileAtomic(
  targetPath: string,
  data: string | Buffer,
  encoding: BufferEncoding = 'utf-8'
): void {
  // 目标目录不在就建出来：首启的 data/config/ 由 board-config 的 ensureConfigFile 建，
  // 这里再兜一次（运行期被删掉、或者换了个新的空 data 挂载）。
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // 已经知道 rename 换不掉（挂载点 / 目录只读）：直接写，省掉一次与目标等大的写入
  if (inPlacePaths.has(targetPath)) {
    fs.writeFileSync(targetPath, data, encoding);
    return;
  }

  const tempFile = targetPath + '.tmp';

  try {
    fs.writeFileSync(tempFile, data, encoding);
  } catch (tempError) {
    // 临时文件建不出来（目录只读 / 没有写权限）：直接写目标文件
    try {
      fs.writeFileSync(targetPath, data, encoding);
    } catch {
      throw tempError;
    }

    inPlacePaths.add(targetPath);
    warnInPlace(targetPath, `cannot write ${tempFile}: ${(tempError as Error).message}`);
    return;
  }

  try {
    fs.renameSync(tempFile, targetPath);
    return;
  } catch (renameError) {
    const code = (renameError as NodeJS.ErrnoException).code;

    if (!code || !RENAME_FALLBACK_CODES.has(code)) {
      fs.rmSync(tempFile, { force: true });
      throw renameError;
    }

    try {
      fs.writeFileSync(targetPath, data, encoding);
    } catch {
      fs.rmSync(tempFile, { force: true });
      throw renameError;
    }

    fs.rmSync(tempFile, { force: true });
    inPlacePaths.add(targetPath);
    warnInPlace(targetPath, code);
  }
}

// 把一份配置写回 data/config/game-config.json（先写 .tmp 再 rename，原子替换；目标被挂载时
// 原地覆写，见 writeFileAtomic）。数据导入用它落盘；其它字段原样保留，缺字段就用当前生效值补上。
export function writeGameConfig(config: GameConfig): void {
  writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** 生效配置文件（data/config/game-config.json）的绝对路径（导出时读原始文件用） */
export function gameConfigFilePath(): string {
  return CONFIG_FILE;
}

// 读盘：优先 v3 / v2 存档（头里有行列数与版本号，精确），
// 都没有再按老逻辑「按字节长度猜格式」，尺寸对不上时按左上角对齐重排。
export function loadBoardState(filePath: string = DATA_FILE): LoadedBoard {
  const total = getTotalSquares();
  const fallback = { state: new Uint32Array(total), epoch: 0, rev: 0 };

  try {
    if (!fs.existsSync(filePath)) {
      console.log('Using default board state');
      return fallback;
    }

    const file = fs.readFileSync(filePath);
    if (file.length === 0) {
      console.log('Using default board state');
      return fallback;
    }

    const parsed = parseSaveFile(file);
    if (parsed) {
      const { state } = decodeState(parsed.payload, parsed.cols * parsed.rows, parsed.cols, {
        cols: parsed.cols,
        rows: parsed.rows
      });

      console.log(
        `Loaded saved board state from disk (v${parsed.epoch ? 3 : 2}, ` +
        `${parsed.flags & 1 ? '24bit' : '4bit'}/cell, ${parsed.cols} x ${parsed.rows}, rev ${parsed.rev})`
      );

      const sameSize = parsed.cols === liveConfig.cols && parsed.rows === liveConfig.rows;
      if (sameSize) {
        return { state, epoch: parsed.epoch, rev: parsed.rev };
      }

      // 尺寸变了：坐标空间整个换了，调用方会换新 epoch 并清零 rev
      console.warn(
        `Save file was made for ${parsed.cols} x ${parsed.rows}, ` +
        `current board is ${liveConfig.cols} x ${liveConfig.rows}: ` +
        'keeping the top-left part and extending / cropping the bottom-right'
      );

      return {
        state: regridState(state, parsed.cols, parsed.rows, liveConfig.cols, liveConfig.rows),
        epoch: 0,
        rev: 0
      };
    }

    // --- 老存档：整个文件是 base64 文本 ---
    const encoded = file.toString('utf-8').trim();
    if (encoded.length === 0) return fallback;

    const buffer = Buffer.from(encoded, 'base64');
    const { state, source, mismatched } = decodeState(
      buffer,
      total,
      liveConfig.cols,
      readSavedDims() || undefined
    );

    if (!mismatched) return { state, epoch: 0, rev: 0 };

    const fromCols = source.cols;
    const fromRows = source.rows || (fromCols > 0 ? Math.round(state.length / fromCols) : 0);

    console.warn(
      `Save file was made for ${fromCols} x ${fromRows}, ` +
      `current board is ${liveConfig.cols} x ${liveConfig.rows}: ` +
      'keeping the top-left part and extending / cropping the bottom-right'
    );

    return {
      state: regridState(state, fromCols, fromRows, liveConfig.cols, liveConfig.rows),
      epoch: 0,
      rev: 0
    };
  } catch (error) {
    console.error('Failed to load saved state:', error);
    return fallback;
  }
}

export interface SaveOptions {
  state: Uint32Array;
  epoch: number;
  rev: number;
  /** 状态改动次数，与上次写盘相同就跳过 */
  stateRev: number;
  savedRev: number;
}

/** 写盘（先写临时文件再 rename，原子替换）。返回新的 savedRev */
export function saveBoardState(options: SaveOptions): number {
  if (options.savedRev === options.stateRev) return options.savedRev;

  try {
    const file = buildSaveFile(
      options.state,
      liveConfig.cols,
      liveConfig.rows,
      options.epoch,
      options.rev
    );
    writeFileAtomic(DATA_FILE, file);
    writeSavedDims();

    console.log(
      `Board state saved (${file.length} bytes for ${getTotalSquares()} cells, rev ${options.rev}) ` +
      `at ${new Date().toLocaleString()}`
    );

    return options.stateRev;
  } catch (error) {
    console.error('Failed to save state:', error);
    return options.savedRev;
  }
}
