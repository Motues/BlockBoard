// src/state.ts
// 棋盘状态的编码 / 解码，以及每格取值的约定。
// 编码共四种形态，都从同一份 Uint32Array 出发：
//   · 24bit 稠密（3 字节/格）—— encodeStateBuffer / encodeState
//   · 4bit 稠密（每字节两格）—— encodeLegacyStateBuffer / encodeLegacyState
//   · RLE（varint 三元组）—— encodeRleBuffer / encodeRle
//   · 批量差量 runs —— encodeChangedRuns
// Buffer 版给二进制下发和压缩存档用，字符串版是它们的 base64 包装（旧协议仍然在发 base64）。
//
// 存档格式见 buildSaveFile / parseSaveFile：带 magic + 版本 + 尺寸的文件头，
// 载荷是上面某种编码再 deflate 一遍，彻底摆脱"按字节长度猜格式"。
//
// 每格是一个 24bit 值（存在 Uint32Array 里，只用低 24 位）：
//   0x000000           = 黑色（默认底色）
//   0x000001..0x00000F = 预设颜色编号（具体调色板在客户端 public/js/config.mjs 的 BRUSH_PRESETS）
//   >= 0x000010        = 自定义颜色，值本身就是 24bit RGB
//
// 预设编号占了 0x00..0x0F 这 16 个码位，所以自定义颜色必须避开它们。
// 落到这一段的就是 #000000..#00000F，肉眼看都是纯黑：存的时候抬到 0x000010，
// 读出来是 #000010，分辨不出差别。

import zlib from 'zlib';

export const BLACK = 0;
/** 4bit 能表达的最大编号，也是预设色编号的上限 */
export const PRESET_MAX = 15;
/** 自定义颜色的最小码位 */
export const RGB_MIN = PRESET_MAX + 1;
export const RGB_MASK = 0x00ffffff;
/** 自定义颜色存档里每格占的字节数 */
export const CELL_BYTES = 3;

/** 旧页面只认 4bit 编号，自定义颜色在它们眼里统一是 15 号色 */
export const LEGACY_CUSTOM_INDEX = PRESET_MAX;
/** 上一版存档（4 字节/格）用高 8 位当"自定义颜色"标记，读旧文件时才需要 */
const LEGACY32_CUSTOM_FLAG = 0x01000000;
const LEGACY32_CELL_BYTES = 4;

export type StateFormat = 'rgb24' | 'rgb32' | 'preset4' | 'legacy1' | 'unknown';

export function isCustomValue(value: number): boolean {
    return value > PRESET_MAX;
}

/** 24bit RGB → 单元格取值 */
export function customValue(rgb: number): number {
    const value = rgb & RGB_MASK;
    return value > PRESET_MAX ? value : RGB_MIN;
}

/** 单元格取值 → 旧客户端能看懂的 4bit 编号 */
export function toLegacyIndex(value: number): number {
    return isCustomValue(value) ? LEGACY_CUSTOM_INDEX : value;
}

/** 棋盘里是否用到了自定义颜色（决定存档和下发要不要用 24bit 格式） */
export function hasCustomColors(state: Uint32Array): boolean {
    for (let i = 0; i < state.length; i++) {
        if (isCustomValue(state[i])) return true;
    }
    return false;
}

// 打包成 Buffer：每格 3 字节（小端）。
// 二进制下发（caps 里的 bin）和压缩存档都用它，省掉 base64 的 33% 膨胀
export function encodeStateBuffer(state: Uint32Array): Buffer {
    const buffer = Buffer.alloc(state.length * CELL_BYTES);

    for (let i = 0; i < state.length; i++) {
        const value = state[i] & RGB_MASK;
        const offset = i * CELL_BYTES;

        buffer[offset] = value & 0xff;
        buffer[offset + 1] = (value >> 8) & 0xff;
        buffer[offset + 2] = (value >> 16) & 0xff;
    }

    return buffer;
}

/** 打包成 Base64（旧协议 / 老页面用） */
export function encodeState(state: Uint32Array): string {
    return encodeStateBuffer(state).toString('base64');
}

// 打包成旧版 4bit/格：每字节两格，低 4 位放前一个格子。
// 自定义颜色旧格式装不下，退化成 15 号色（老页面会把它显示成 15 号预设色）
export function encodeLegacyStateBuffer(state: Uint32Array): Buffer {
    const buffer = Buffer.alloc(Math.ceil(state.length / 2));

    for (let i = 0; i < state.length; i++) {
        const value = toLegacyIndex(state[i]) & 0x0f;
        const byteIndex = i >> 1;

        buffer[byteIndex] |= (i & 1) ? (value << 4) : value;
    }

    return buffer;
}

/** 打包成旧版 4bit/格 的 Base64 */
export function encodeLegacyState(state: Uint32Array): string {
    return encodeLegacyStateBuffer(state).toString('base64');
}

// --- 紧凑状态（RLE，下发给新客户端用）---
//
// 每个色块三个 varint：[跳过多少个黑格, 连续同色多少格, 颜色值]，
// 没被覆盖的格子就是黑色（默认底色）。
//   · 稀疏棋盘：只有几个色块，几十字节
//   · 大色块：一个色块就顶掉一大片，也很小
//   · 整块黑板：一个字节都不用发
//   · "每个格子颜色都不同"的噪点棋盘：比稠密格式还大，
//     这种情况由 server.ts 的 encodeCompactState 退回 3 字节/格

interface VarintWriter {
    buffer: Buffer;
    pos: number;
}

function createVarintWriter(size: number): VarintWriter {
    return { buffer: Buffer.alloc(size), pos: 0 };
}

function writeVarint(writer: VarintWriter, value: number): void {
    let rest = value;

    while (rest >= 0x80) {
        writer.buffer[writer.pos++] = (rest & 0x7f) | 0x80;
        rest = Math.floor(rest / 128);
    }
    writer.buffer[writer.pos++] = rest;
}

export function readVarint(buffer: Buffer, cursor: { pos: number }): number {
    let value = 0;
    let scale = 1;

    while (cursor.pos < buffer.length) {
        const byte = buffer[cursor.pos++];
        value += (byte & 0x7f) * scale;

        if ((byte & 0x80) === 0) break;
        scale *= 128;
    }

    return value;
}

export function encodeRleBuffer(state: Uint32Array): Buffer {
    // 最坏情况是每个格子一个色块、每个 varint 最多 4 字节，这里按格子数上界分配一次就够
    const writer = createVarintWriter(state.length * 12 + 12);
    let cursor = 0; // 上一个色块的结束位置：它之前（和之后）的黑格都不用写出来
    let index = 0;

    while (index < state.length) {
        const value = state[index];

        if (value === BLACK) {
            index++;
            continue;
        }

        let end = index + 1;
        while (end < state.length && state[end] === value) end++;

        writeVarint(writer, index - cursor);
        writeVarint(writer, end - index);
        writeVarint(writer, value);

        cursor = end;
        index = end;
    }

    // 注意返回的是 subarray：二进制下发时 socket.io 会按 byteOffset/length 正确处理
    return writer.buffer.subarray(0, writer.pos);
}

export function encodeRle(state: Uint32Array): string {
    return encodeRleBuffer(state).toString('base64');
}

/** 一次批量改色里"真的变了"的一格 */
export interface CellChange {
    index: number;
    value: number;
}

/**
 * 批量改色用：把 changes 里"值确实变了"的格子按 [跳过多少格, 连续多少格, 颜色值] 打包成 RLE。
 * 与 encodeRle 的区别：这里不跳过黑色 —— 黑色在批量操作里是"擦除"这个有效结果。
 * 返回空字符串表示这一片没有任何改动。
 *
 * changes 必须是**按下标升序**的（paintRect 按行优先遍历，天然满足），
 * 这样不用再整盘复制一份 before 去和 after 对拍（1M 格的棋盘省下 4MB 拷贝）。
 * 游标语义与原实现一致：第一个 varint 相对基准点 start，之后相对上一段改动的结束位置。
 */
export function encodeChangedRuns(changes: CellChange[], start: number): string {
    if (changes.length === 0) return '';

    const writer = createVarintWriter(changes.length * 12 + 12);
    let cursor = start;
    let i = 0;

    while (i < changes.length) {
        const value = changes[i].value;
        let j = i + 1;
        // 下标连续且颜色相同的改动可以并成一段
        while (j < changes.length &&
            changes[j].index === changes[j - 1].index + 1 &&
            changes[j].value === value) {
            j++;
        }

        writeVarint(writer, changes[i].index - cursor);
        writeVarint(writer, j - i);
        writeVarint(writer, value);

        cursor = changes[j - 1].index + 1;
        i = j;
    }

    return writer.buffer.subarray(0, writer.pos).toString('base64');
}

export function decodeRle(encoded: string, total: number): Uint32Array {
    const state = new Uint32Array(total);
    const buffer = Buffer.from(encoded, 'base64');
    const cursor = { pos: 0 };
    let index = 0;

    while (cursor.pos < buffer.length) {
        index += readVarint(buffer, cursor);

        const run = readVarint(buffer, cursor);
        const value = readVarint(buffer, cursor);

        if (run <= 0 || index >= total) break;

        const end = Math.min(total, index + run);
        for (let i = index; i < end; i++) state[i] = value;

        index = end;
    }

    return state;
}

/** 棋盘尺寸（存档的行列数 / 当前配置的行列数） */
export interface SourceDims {
    cols: number;
    rows: number;
}

// --- 存档文件（带版本号 + deflate）---
// 布局：'BBS2' + 1 字节 flags + uint32LE cols + uint32LE rows + deflate(载荷)
//   载荷是 24bit 稠密（flags 位 0 置位）或 4bit 稠密（不置位）的**裸字节**，不含 base64。
// 老存档（整个文件是 base64 文本）没有这个头，读取时按字节长度猜格式的老逻辑继续兜底 ——
// 新格式带 magic 和尺寸，再也不用猜，也不会因为改了棋盘尺寸就读出斜掉的图案。

export const SAVE_MAGIC = 'BBS2';
/** 'BBS2' + flags + cols + rows */
export const SAVE_HEADER_BYTES = 13;
/** flags 位 0：载荷是 24bit/格（否则 4bit/格） */
export const SAVE_FLAG_RGB24 = 1;

export interface SaveFile {
    /** 24bit/格 时含 SAVE_FLAG_RGB24 */
    flags: number;
    cols: number;
    rows: number;
    /** 解压后的裸状态字节 */
    payload: Buffer;
}

/** 把当前棋盘打包成存档文件（头部 + deflate 载荷） */
export function buildSaveFile(state: Uint32Array, cols: number, rows: number): Buffer {
    const customColors = hasCustomColors(state);
    const raw = customColors ? encodeStateBuffer(state) : encodeLegacyStateBuffer(state);

    const header = Buffer.alloc(SAVE_HEADER_BYTES);
    header.write(SAVE_MAGIC, 0, 'ascii');
    header[4] = customColors ? SAVE_FLAG_RGB24 : 0;
    header.writeUInt32LE(cols, 5);
    header.writeUInt32LE(rows, 9);

    return Buffer.concat([header, zlib.deflateSync(raw, { level: 6 })]);
}

/**
 * 解析新格式存档。不是新格式（老存档 / 文件损坏）返回 null，
 * 由调用方回落到"按字节长度猜格式"的旧路径。
 */
export function parseSaveFile(file: Buffer): SaveFile | null {
    if (file.length <= SAVE_HEADER_BYTES) return null;
    if (file.subarray(0, SAVE_MAGIC.length).toString('ascii') !== SAVE_MAGIC) return null;

    const flags = file[4];
    const cols = file.readUInt32LE(5);
    const rows = file.readUInt32LE(9);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;

    return { flags, cols, rows, payload: zlib.inflateSync(file.subarray(SAVE_HEADER_BYTES)) };
}

export interface DecodeResult {
    state: Uint32Array;
    format: StateFormat;
    /** 还原出这份存档的棋盘尺寸（旧格式推断不出行列时按当前配置算） */
    source: SourceDims;
    /** 存档的格子数与当前配置是否一致 */
    mismatched: boolean;
}

/**
 * 按「左上角对齐」把一份棋盘状态搬到新尺寸上，多出来的部分补黑（右下角扩展），
 * 超出的部分丢掉（右下角裁剪）。
 *
 * 之所以不能只按一维数组截断 / 补零：列数变化时一维下标和二维行列就对不上了，
 * 整幅画会斜着错位。这里逐行搬运，重叠区域的颜色原样保留。
 */
export function regridState(
    source: Uint32Array,
    sourceCols: number,
    sourceRows: number,
    targetCols: number,
    targetRows: number
): Uint32Array {
    const out = new Uint32Array(targetCols * targetRows);
    if (sourceCols <= 0 || sourceRows <= 0) return out;

    const copyCols = Math.min(sourceCols, targetCols);
    const copyRows = Math.min(sourceRows, targetRows);

    for (let row = 0; row < copyRows; row++) {
        const from = row * sourceCols;
        const to = row * targetCols;
        // 逐行整段搬运；这里的行可能超出了源数组（旧格式保存的格子数比声明的少）
        if (from >= source.length) break;

        const length = Math.min(copyCols, source.length - from);
        if (length <= 0) break;

        out.set(source.subarray(from, from + length), to);
    }

    return out;
}

/**
 * 存档的格子数固定时，反推出原来的棋盘尺寸：优先沿用当前的列数，
 * 这样"只改行数"（最常见的情况）能精确还原。
 *
 * 列数也跟着变了就还原不出来（100x50 和 250x20 的格子数可能一样）。
 * 这时按当前的列数算行数：重排会退化成"一格一格地裁剪 / 补黑"，
 * 也就是改动前的旧行为 —— 至少每个格子的颜色都还在，不会把图案转斜。
 */
function inferSourceDims(cells: number, total: number, cols: number): SourceDims {
    if (cells % cols === 0) return { cols, rows: cells / cols };

    return { cols, rows: Math.max(1, Math.round(total / cols)) };
}

/**
 * 解码 Base64 存档，并把旧格式迁移到当前的 24bit 取值。
 * 存档的尺寸一般是按字节数反推出来的，与当前配置不一致时会做「左上角对齐」的重排。
 *
 * `source` 用来兜底：4bit / 1bit 存档的字节数不足以反推尺寸
 * （格子数被向上取整到字节），这时用调用方记住的上一个配置；
 * 仍然没有就只能按当前配置读，可能读出斜掉的图案。
 */
export function decodeState(buffer: Buffer, total: number, cols: number, source?: SourceDims): DecodeResult {
    const known = source && source.cols > 0 && source.rows > 0 ? source : undefined;
    const length = buffer.length;

    const matchesRgb24 = length === total * CELL_BYTES;
    const matchesRgb32 = length === total * LEGACY32_CELL_BYTES;
    const matchesPreset4 = length === Math.ceil(total / 2);
    const matchesLegacy1 = length === Math.ceil(total / 8);

    // 判定顺序很关键：
    //   1. 先看字节数是否正好等于某种格式在当前配置下的长度 —— 这种匹配是明确的
    //   2. 都不匹配再看能否反推出格子数（24bit / 32bit 的格子数是精确的）
    // 否则"比当前棋盘小的 4bit 存档"（字节数约等于 棋盘格子数的一半，正好是 3 的倍数）
    // 会被当成 24bit 存档读出乱码
    const isRgb24 = matchesRgb24 || (!matchesPreset4 && !matchesLegacy1 && !matchesRgb32 && length % CELL_BYTES === 0);
    const isRgb32 = matchesRgb32 ||
        (!isRgb24 && !matchesPreset4 && !matchesLegacy1 && length % LEGACY32_CELL_BYTES === 0);

    if (isRgb24) {
        const cells = length / CELL_BYTES;
        const state = new Uint32Array(cells);

        for (let i = 0; i < cells; i++) {
            const offset = i * CELL_BYTES;
            state[i] = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
        }

        const matched = cells === total;
        return {
            state,
            format: 'rgb24',
            source: matched ? { cols, rows: total / cols } : (known || inferSourceDims(cells, total, cols)),
            mismatched: !matched
        };
    }

    if (isRgb32) {
        const cells = length / LEGACY32_CELL_BYTES;
        const state = new Uint32Array(cells);

        for (let i = 0; i < cells; i++) {
            const raw = buffer.readUInt32LE(i * LEGACY32_CELL_BYTES) >>> 0;
            state[i] = (raw & LEGACY32_CUSTOM_FLAG)
                ? customValue(raw & RGB_MASK)
                : (raw & PRESET_MAX);
        }

        const matched = cells === total;
        return {
            state,
            format: 'rgb32',
            source: matched ? { cols, rows: total / cols } : (known || inferSourceDims(cells, total, cols)),
            mismatched: !matched
        };
    }

    // 4bit/格（预设色版本）：每字节两格，低 4 位放前一个格子
    if (matchesPreset4) {
        const state = new Uint32Array(total);
        for (let i = 0; i < total; i++) {
            const byte = buffer[i >> 1];
            state[i] = (i & 1) ? ((byte >> 4) & 0x0f) : (byte & 0x0f);
        }
        return { state, format: 'preset4', source: { cols, rows: total / cols }, mismatched: false };
    }

    // 1bit/格（最早的黑白版本）：每字节八格
    if (buffer.length === Math.ceil(total / 8)) {
        const state = new Uint32Array(total);
        for (let i = 0; i < total; i++) {
            const wasBlack = ((buffer[i >> 3] >> (i & 7)) & 1) === 1;
            state[i] = wasBlack ? BLACK : 1;
        }
        return { state, format: 'legacy1', source: { cols, rows: total / cols }, mismatched: false };
    }

    // 尺寸对不上：这些旧格式的字节数不足以唯一确定格式与格子数
    // （10000 格的 4bit 存档和 40000 格的 1bit 存档都是 5000 字节），
    // 能记住上一个配置就用来消歧，否则按更常见的 4bit 读
    const direct4 = known && length === Math.ceil((known.cols * known.rows) / 2);
    const direct1 = known && length === Math.ceil((known.cols * known.rows) / 8);

    let cells: number;
    let decode: (i: number) => number;

    if (direct1 && !direct4) {
        cells = length * 8;
        decode = (i) => (((buffer[i >> 3] >> (i & 7)) & 1) === 1 ? BLACK : 1);
    } else {
        cells = length * 2;
        decode = (i) => {
            const byte = buffer[i >> 1];
            return (i & 1) ? ((byte >> 4) & 0x0f) : (byte & 0x0f);
        };
    }

    const state = new Uint32Array(cells);
    for (let i = 0; i < cells; i++) state[i] = decode(i);

    return {
        state,
        format: 'unknown',
        // 这两个旧格式的尺寸还原不出来，只能按当前配置读，
        // 重排退化成逐格裁剪 / 补黑（改动前的行为）
        source: known || { cols, rows: Math.max(1, Math.round(total / cols)) },
        mismatched: true
    };
}
