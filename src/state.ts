// src/state.ts
// 棋盘状态的编码 / 解码，以及每格取值的约定。
//
// 每格是一个 24bit 值（存在 Uint32Array 里，只用低 24 位）：
//   0x000000           = 黑色（默认底色）
//   0x000001..0x00000F = 预设颜色编号（具体调色板在客户端 public/script.js 的 BRUSH_PRESETS）
//   >= 0x000010        = 自定义颜色，值本身就是 24bit RGB
//
// 预设编号占了 0x00..0x0F 这 16 个码位，所以自定义颜色必须避开它们。
// 落到这一段的就是 #000000..#00000F，肉眼看都是纯黑：存的时候抬到 0x000010，
// 读出来是 #000010，分辨不出差别。

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

// 打包成 Base64：每格 3 字节（小端）
export function encodeState(state: Uint32Array): string {
    const buffer = Buffer.alloc(state.length * CELL_BYTES);

    for (let i = 0; i < state.length; i++) {
        const value = state[i] & RGB_MASK;
        const offset = i * CELL_BYTES;

        buffer[offset] = value & 0xff;
        buffer[offset + 1] = (value >> 8) & 0xff;
        buffer[offset + 2] = (value >> 16) & 0xff;
    }

    return buffer.toString('base64');
}

// 打包成旧版 4bit/格 的 Base64：每字节两格，低 4 位放前一个格子。
// 自定义颜色旧格式装不下，退化成 15 号色（老页面会把它显示成 15 号预设色）
export function encodeLegacyState(state: Uint32Array): string {
    const buffer = Buffer.alloc(Math.ceil(state.length / 2));

    for (let i = 0; i < state.length; i++) {
        const value = toLegacyIndex(state[i]) & 0x0f;
        const byteIndex = i >> 1;

        buffer[byteIndex] |= (i & 1) ? (value << 4) : value;
    }

    return buffer.toString('base64');
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

function writeVarint(value: number, out: number[]): void {
    let rest = value;

    while (rest >= 0x80) {
        out.push((rest & 0x7f) | 0x80);
        rest = Math.floor(rest / 128);
    }
    out.push(rest);
}

function readVarint(buffer: Buffer, cursor: { pos: number }): number {
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

export function encodeRle(state: Uint32Array): string {
    const bytes: number[] = [];
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

        writeVarint(index - cursor, bytes);
        writeVarint(end - index, bytes);
        writeVarint(value, bytes);

        cursor = end;
        index = end;
    }

    return Buffer.from(bytes).toString('base64');
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

// 解码 Base64。存档格式按字节数区分，并把旧格式迁移到当前的 24bit：
//   total * 3 字节   → 24bit/格（当前格式）
//   total * 4 字节   → 32bit/格，高 8 位是标记位（短暂存在过的上一版）
//   ceil(total / 2)  → 4bit/格（预设色版本）
//   ceil(total / 8)  → 1bit/格（最早的黑白版本）
export function decodeState(buffer: Buffer, total: number): { state: Uint32Array; format: StateFormat } {
    const state = new Uint32Array(total);

    if (buffer.length === total * CELL_BYTES) {
        for (let i = 0; i < total; i++) {
            const offset = i * CELL_BYTES;
            state[i] = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
        }
        return { state, format: 'rgb24' };
    }

    if (buffer.length === total * LEGACY32_CELL_BYTES) {
        for (let i = 0; i < total; i++) {
            const raw = buffer.readUInt32LE(i * LEGACY32_CELL_BYTES) >>> 0;
            state[i] = (raw & LEGACY32_CUSTOM_FLAG)
                ? customValue(raw & RGB_MASK)
                : (raw & PRESET_MAX);
        }
        return { state, format: 'rgb32' };
    }

    if (buffer.length === Math.ceil(total / 2)) {
        for (let i = 0; i < total; i++) {
            const byte = buffer[i >> 1];
            state[i] = (i & 1) ? ((byte >> 4) & 0x0f) : (byte & 0x0f);
        }
        return { state, format: 'preset4' };
    }

    if (buffer.length === Math.ceil(total / 8)) {
        for (let i = 0; i < total; i++) {
            const wasBlack = ((buffer[i >> 3] >> (i & 7)) & 1) === 1;
            state[i] = wasBlack ? BLACK : 1;
        }
        return { state, format: 'legacy1' };
    }

    // 尺寸对不上（例如 rows / cols 改过）：按 4bit 尽力而为地读，剩下的保持黑色
    const readable = Math.min(total, buffer.length * 2);
    for (let i = 0; i < readable; i++) {
        const byte = buffer[i >> 1];
        state[i] = (i & 1) ? ((byte >> 4) & 0x0f) : (byte & 0x0f);
    }
    return { state, format: 'unknown' };
}
