// 棋盘存档：读盘、定时写盘、棋盘尺寸变更时的重排。

import fs from 'fs';
import path from 'path';
import { gameConfig, TOTAL_SQUARES } from './board-config';
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
    const meta = { cols: gameConfig.cols, rows: gameConfig.rows };
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to write the board size file:', error);
  }
}

// 读盘：优先 v3 / v2 存档（头里有行列数与版本号，精确），
// 都没有再按老逻辑「按字节长度猜格式」，尺寸对不上时按左上角对齐重排。
export function loadBoardState(): LoadedBoard {
  const fallback = { state: new Uint32Array(TOTAL_SQUARES), epoch: 0, rev: 0 };

  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('Using default board state');
      return fallback;
    }

    const file = fs.readFileSync(DATA_FILE);
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

      const sameSize = parsed.cols === gameConfig.cols && parsed.rows === gameConfig.rows;
      if (sameSize) {
        return { state, epoch: parsed.epoch, rev: parsed.rev };
      }

      // 尺寸变了：坐标空间整个换了，调用方会换新 epoch 并清零 rev
      console.warn(
        `Save file was made for ${parsed.cols} x ${parsed.rows}, ` +
        `current board is ${gameConfig.cols} x ${gameConfig.rows}: ` +
        'keeping the top-left part and extending / cropping the bottom-right'
      );

      return {
        state: regridState(state, parsed.cols, parsed.rows, gameConfig.cols, gameConfig.rows),
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
      TOTAL_SQUARES,
      gameConfig.cols,
      readSavedDims() || undefined
    );

    if (!mismatched) return { state, epoch: 0, rev: 0 };

    const fromCols = source.cols;
    const fromRows = source.rows || (fromCols > 0 ? Math.round(state.length / fromCols) : 0);

    console.warn(
      `Save file was made for ${fromCols} x ${fromRows}, ` +
      `current board is ${gameConfig.cols} x ${gameConfig.rows}: ` +
      'keeping the top-left part and extending / cropping the bottom-right'
    );

    return {
      state: regridState(state, fromCols, fromRows, gameConfig.cols, gameConfig.rows),
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
      gameConfig.cols,
      gameConfig.rows,
      options.epoch,
      options.rev
    );
    const tempFile = DATA_FILE + '.tmp';

    fs.writeFileSync(tempFile, file);
    fs.renameSync(tempFile, DATA_FILE);
    writeSavedDims();

    console.log(
      `Board state saved (${file.length} bytes for ${TOTAL_SQUARES} cells, rev ${options.rev}) ` +
      `at ${new Date().toLocaleString()}`
    );

    return options.stateRev;
  } catch (error) {
    console.error('Failed to save state:', error);
    return options.savedRev;
  }
}
