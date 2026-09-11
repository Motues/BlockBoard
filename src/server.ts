// src/server.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Server, Socket } from 'socket.io';
import path from 'path';
import fs from 'fs';
import gameConfig from '../game-config.json';
import {
    BLACK,
    CELL_BYTES,
    PRESET_MAX,
    RGB_MASK,
    SourceDims,
    customValue,
    decodeState,
    encodeLegacyState,
    encodeRle,
    encodeState,
    hasCustomColors,
    isCustomValue,
    regridState,
    toLegacyIndex
} from './state';

const app = new Hono();
const PORT = gameConfig.port;

const TOTAL_SQUARES = gameConfig.rows * gameConfig.cols;

// 棋盘状态：Uint32Array，每格一个 24bit 颜色值（只用低 24 位），默认全黑。
//   0x000000           = 黑色
//   0x000001..0x00000F = 预设颜色编号（调色板在客户端 public/js/config.mjs 的 BRUSH_PRESETS，目前用到 1..8）
//   >= 0x000010        = 自定义颜色，值本身就是 24bit RGB
// 取值约定与编解码都在 src/state.ts
const gridState = new Uint32Array(TOTAL_SQUARES);
let onlineUsers = 0;

// Data storage path
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'board-state.dat');
// 存档对应的棋盘尺寸。改 game-config.json 后，旧存档靠它还原出原来的行列数，
// 才能按「左上角对齐」正确地扩展 / 裁剪；顺便也给 4bit / 1bit 旧格式消歧
const META_FILE = path.join(DATA_DIR, 'board-size.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readSavedDims(): SourceDims | null {
    try {
        if (!fs.existsSync(META_FILE)) return null;

        const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
        const cols = Number(meta && meta.cols);
        const rows = Number(meta && meta.rows);

        if (Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0) {
            return { cols, rows };
        }
    } catch (error) {
        console.warn('Failed to read the saved board size, treating the save as the current size');
    }

    return null;
}

function writeSavedDims(): void {
    try {
        fs.writeFileSync(META_FILE, JSON.stringify({ cols: gameConfig.cols, rows: gameConfig.rows }, null, 2), 'utf-8');
    } catch (error) {
        console.error('Failed to write the board size file:', error);
    }
}

// Load saved state from disk（旧格式的存档会在这里自动迁移，
// 存档尺寸与当前配置不一致时按左上角对齐重新排布）
function loadState(): Uint32Array {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const encoded = fs.readFileSync(DATA_FILE, 'utf-8').trim();
            if (encoded.length > 0) {
                const buffer = Buffer.from(encoded, 'base64');
                const saved = readSavedDims();
                const { state, format, source, mismatched } =
                    decodeState(buffer, TOTAL_SQUARES, gameConfig.cols, saved || undefined);

                if (format === 'rgb24') {
                    console.log('Loaded saved board state from disk (24bit/cell, 3 bytes)');
                } else if (format === 'rgb32') {
                    console.log('Detected 32bit/cell save file, migrated to the 24bit/cell layout');
                } else if (format === 'preset4') {
                    console.log('Detected legacy 4-bit save file, migrated to 24bit color state');
                } else if (format === 'legacy1') {
                    console.log('Detected legacy 1-bit save file, migrated to 24bit color state');
                } else {
                    console.warn('Save file size does not match the board size, read as 4-bit best effort');
                }

                // 尺寸一致：直接用
                if (!mismatched) return state;

                // 尺寸不一致：从右下角扩展或裁剪，重叠区域的颜色原样保留
                const fromCols = source.cols;
                const fromRows = source.rows || (fromCols > 0 ? Math.round(state.length / fromCols) : 0);

                console.warn(
                    `Save file was made for ${fromCols} x ${fromRows}, ` +
                    `current board is ${gameConfig.cols} x ${gameConfig.rows}: ` +
                    'keeping the top-left part and extending / cropping the bottom-right'
                );

                return regridState(state, fromCols, fromRows, gameConfig.cols, gameConfig.rows);
            }
        }
    } catch (error) {
        console.error('Failed to load saved state:', error);
    }
    console.log('Using default board state');
    return new Uint32Array(TOTAL_SQUARES);
}

// Save state to disk。
// 只有棋盘上真的出现自定义颜色时才写 24bit/格 的新格式（每格 3 字节），
// 否则仍然写 4bit/格 的旧格式：文件小 6 倍，而且旧版本的程序也能读
function saveState(): void {
    try {
        const customColors = hasCustomColors(gridState);
        const encoded = customColors ? encodeState(gridState) : encodeLegacyState(gridState);

        fs.writeFileSync(DATA_FILE, encoded, 'utf-8');
        // 状态与尺寸一起落盘，重启时才能判断存档是不是旧尺寸
        writeSavedDims();

        const fileSize = Buffer.byteLength(encoded, 'utf-8');
        const layout = customColors ? `${CELL_BYTES}byte/cell` : '4bit/cell';
        console.log(`Board state saved (${fileSize} bytes, ${layout}) at ${new Date().toLocaleString()}`);
    } catch (error) {
        console.error('Failed to save state:', error);
    }
}

// Initialize grid state from saved data or default
gridState.set(loadState());

// 记下这份状态对应的尺寸：下次改配置时靠它还原旧存档的行列数。
// 启动时先写一次，避免"改了配置但一直没触发自动保存"的窗口期
writeSavedDims();

// Auto-save every minute (60000 milliseconds)
const SAVE_INTERVAL = 60 * 1000; // 1 minute
setInterval(saveState, SAVE_INTERVAL);
console.log(`Auto-save enabled: every ${SAVE_INTERVAL / 1000} seconds`);

// 托管静态资源
app.use('/*', serveStatic({ root: path.join(__dirname, '../public') }));

// 使用 Hono 官方的 serve 启动服务，并获取底层的 httpServer 实例
const serverInstance = serve({
    fetch: app.fetch,
    port: PORT
}, (info) => {
    console.log(`BlockBoard run on http://localhost:${info.port}`);
    console.log(`Current grid: ${gameConfig.cols} x ${gameConfig.rows} (Total ${TOTAL_SQUARES} squares)`);
    console.log(`State format: 24bit/cell (0 = black, 1..${PRESET_MAX} = presets, >= ${PRESET_MAX + 1} = custom RGB)`);
});

// 将 Socket.io 绑定到 Hono 的服务器实例上。
// perMessageDeflate：超过 1KB 的消息（棋盘状态）交给浏览器用 deflate 压一遍再传，
// 几百字节的格子广播不受影响。稠密状态（每个格子颜色都不同的画）靠它能再小一个数量级；
// 不需要的话把这个参数删掉即可
const io = new Server(serverInstance, {
    perMessageDeflate: {
        threshold: 1024
    }
});

function isValidIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < TOTAL_SQUARES;
}

// 广播单格变化。
//   value / isBlack 是给还没刷新到新版的旧页面用的（自定义颜色在它们眼里就是 15 号色）
//   rgb 是自定义颜色的 24bit 值，新页面用它还原出真正的颜色
function broadcastSquare(index: number): void {
    const value = gridState[index];
    const custom = isCustomValue(value);

    io.emit('update-square', {
        index: index,
        value: toLegacyIndex(value),
        rgb: custom ? value : null,
        isBlack: value === BLACK
    });
}

// 下发给新客户端的棋盘状态：优先 RLE（稀疏棋盘常常只有几十字节），
// 只有 RLE 反而更大时（每个格子颜色都不同的噪点棋盘）才退回 3 字节/格 的稠密格式
function encodeCompactState(): { encoding: 'rle' | 'dense'; data: string } {
    const rle = encodeRle(gridState);
    const dense = encodeState(gridState);

    return rle.length <= dense.length
        ? { encoding: 'rle', data: rle }
        : { encoding: 'dense', data: dense };
}

io.on('connection', (socket: Socket) => {
    // Increase the number of online users and broadcast
    onlineUsers++;
    io.emit('online-users', onlineUsers);

    // 客户端在握手里声明自己认识哪些状态格式：
    //   rgb24 = 认识 24bit 取值（>= 16 是自定义颜色）和 3 字节/格 的稠密状态
    //   rle   = 额外认识 RLE 紧凑状态
    // 什么都没声明的（没刷新的旧页面）只发 4bit 状态：棋盘照样能看，
    // 只是自定义颜色在它们眼里是 15 号色
    const authCaps = socket.handshake.auth ? socket.handshake.auth.caps : undefined;
    const caps: string[] = Array.isArray(authCaps) ? authCaps : [];
    const supportsRgb = caps.indexOf('rgb24') >= 0;

    const payload: Record<string, unknown> = {
        config: gameConfig,
        black: BLACK,
        maxColorIndex: PRESET_MAX,
        rgbSupport: true
    };

    if (supportsRgb) {
        const compact = encodeCompactState();

        // 客户端没有 rle 能力时，就算 RLE 更小也只能发它认识的稠密格式
        if (compact.encoding === 'rle' && caps.indexOf('rle') < 0) {
            payload.stateRgb = encodeState(gridState);
            payload.stateEncoding = 'dense';
        } else {
            payload.stateRgb = compact.data;
            payload.stateEncoding = compact.encoding;
        }
    } else {
        // 4bit/格（Base64）：旧页面解码后映射成预设色，自定义颜色退化成 15 号色
        payload.state = encodeLegacyState(gridState);
    }

    socket.emit('init-game', payload);

    // 涂格子的协议。
    //   { index, brush }  brush 是预设编号（1..PRESET_MAX）
    //   { index, rgb }    rgb 是自定义 24bit 颜色（0x000000..0xffffff）
    // 规则与客户端一致：格子和画笔同色 → 擦成黑色；否则涂成画笔颜色。
    // 自定义颜色只和"完全相同的自定义颜色"比较 —— 客户端预设调色板的真实色值服务端并不认识
    socket.on('paint-square', (payload: { index?: number; brush?: number; rgb?: number }) => {
        const index = Number(payload && payload.index);
        if (!isValidIndex(index)) return;

        const rgb = Number(payload && payload.rgb);
        let next: number;

        if (Number.isInteger(rgb) && rgb >= 0 && rgb <= RGB_MASK) {
            const value = customValue(rgb);
            next = gridState[index] === value ? BLACK : value;
        } else {
            const brush = Number(payload && payload.brush);
            if (!Number.isInteger(brush) || brush < 1 || brush > PRESET_MAX) return;

            next = gridState[index] === brush ? BLACK : brush;
        }

        gridState[index] = next;
        broadcastSquare(index);
    });

    // 兼容旧版页面：只有黑 / 白两色（等价于用 1 号颜色涂）
    socket.on('toggle-square', (index: number) => {
        if (!isValidIndex(index)) return;

        gridState[index] = gridState[index] === BLACK ? 1 : BLACK;
        broadcastSquare(index);
    });

    // Reduce the number of online users when users disconnect
    socket.on('disconnect', () => {
        onlineUsers--;
        io.emit('online-users', onlineUsers);
    });
});

// Graceful shutdown - save state before exiting
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    saveState();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\nShutting down...');
    saveState();
    process.exit(0);
});
