// src/server.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Server, Socket } from 'socket.io';
import path from 'path';
import fs from 'fs';
import gameConfig from '../game-config.json';

const app = new Hono();
const PORT = gameConfig.port;

const TOTAL_SQUARES = gameConfig.rows * gameConfig.cols;

// 每格 4 bit：
//   0     = 黑色
//   1..15 = 颜色编号（具体调色板在客户端 public/script.js 的 BRUSH_PRESETS，目前用到 1..8）
const CELL_BITS = 4;
const CELLS_PER_BYTE = 8 / CELL_BITS;
const CELL_MASK = (1 << CELL_BITS) - 1;
const MAX_COLOR_INDEX = CELL_MASK;
const BLACK = 0;
const STATE_BYTES = Math.ceil(TOTAL_SQUARES / CELLS_PER_BYTE);

// 棋盘状态：Uint8Array，每格一个 0..15 的颜色值，默认全黑
const gridState = new Uint8Array(TOTAL_SQUARES);
let onlineUsers = 0;

// Data storage path
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'board-state.dat');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 打包成紧凑的 Base64：每字节装 2 格，低 4 位放前一个格子
function encodeState(state: Uint8Array): string {
    const buffer = Buffer.alloc(STATE_BYTES);

    for (let i = 0; i < state.length; i++) {
        const byteIndex = Math.floor(i / CELLS_PER_BYTE);
        const shift = (i % CELLS_PER_BYTE) * CELL_BITS;
        buffer[byteIndex] |= (state[i] & CELL_MASK) << shift;
    }

    return buffer.toString('base64');
}

// 解码 Base64（4bit/格）。旧存档是 1bit/格，会在这里自动迁移
function decodeState(encoded: string): Uint8Array {
    const buffer = Buffer.from(encoded, 'base64');
    const state = new Uint8Array(TOTAL_SQUARES);

    // 旧的 1bit/格 格式（1 = 黑，0 = 白）：字节数不同，可以据此识别
    if (buffer.length === Math.ceil(TOTAL_SQUARES / 8)) {
        for (let i = 0; i < TOTAL_SQUARES; i++) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            const wasBlack = ((buffer[byteIndex] >> bitIndex) & 1) === 1;
            state[i] = wasBlack ? BLACK : 1;
        }
        console.log('Detected legacy 1-bit save file, migrated to 4-bit color state');
        return state;
    }

    for (let i = 0; i < TOTAL_SQUARES; i++) {
        const byteIndex = Math.floor(i / CELLS_PER_BYTE);
        if (byteIndex >= buffer.length) break;

        const shift = (i % CELLS_PER_BYTE) * CELL_BITS;
        state[i] = (buffer[byteIndex] >> shift) & CELL_MASK;
    }

    return state;
}

// Load saved state from disk
function loadState(): Uint8Array {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const encoded = fs.readFileSync(DATA_FILE, 'utf-8').trim();
            if (encoded.length > 0) {
                console.log('Loaded saved board state from disk');
                return decodeState(encoded);
            }
        }
    } catch (error) {
        console.error('Failed to load saved state:', error);
    }
    console.log('Using default board state');
    return new Uint8Array(TOTAL_SQUARES);
}

// Save state to disk
function saveState(): void {
    try {
        const encoded = encodeState(gridState);
        fs.writeFileSync(DATA_FILE, encoded, 'utf-8');
        const fileSize = Buffer.byteLength(encoded, 'utf-8');
        console.log(`Board state saved (${fileSize} bytes, ${CELL_BITS}bit/cell) at ${new Date().toLocaleString()}`);
    } catch (error) {
        console.error('Failed to save state:', error);
    }
}

// Initialize grid state from saved data or default
gridState.set(loadState());

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
    console.log(`State format: ${CELL_BITS}bit/cell (0 = black, 1..${MAX_COLOR_INDEX} = colors)`);
});

// 将 Socket.io 绑定到 Hono 的服务器实例上
const io = new Server(serverInstance);

function isValidIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < TOTAL_SQUARES;
}

// 广播单格变化：value 是权威颜色值，isBlack 是给还没刷新到新版的旧页面用的
function broadcastSquare(index: number): void {
    const value = gridState[index];
    io.emit('update-square', {
        index: index,
        value: value,
        isBlack: value === BLACK
    });
}

io.on('connection', (socket: Socket) => {
    // Increase the number of online users and broadcast
    onlineUsers++;
    io.emit('online-users', onlineUsers);

    // Bundle the "configuration" and "state" together when sending to new users,
    // so the frontend knows how many rows and columns to render
    socket.emit('init-game', {
        config: gameConfig,
        // 4bit/格 的紧凑状态（Base64），客户端解码后映射成颜色
        state: encodeState(gridState),
        black: BLACK,
        maxColorIndex: MAX_COLOR_INDEX
    });

    // 新协议：用画笔涂格子。
    // brush 是颜色编号（1..MAX_COLOR_INDEX）。规则与客户端一致：
    //   格子和画笔同色 → 擦成黑色；否则涂成画笔颜色
    socket.on('paint-square', (payload: { index?: number; brush?: number }) => {
        const index = Number(payload && payload.index);
        const brush = Number(payload && payload.brush);

        if (!isValidIndex(index)) return;
        if (!Number.isInteger(brush) || brush < BLACK || brush > MAX_COLOR_INDEX) return;

        gridState[index] = gridState[index] === brush ? BLACK : brush;
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
