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
const gridState: boolean[] = new Array(TOTAL_SQUARES).fill(true);
let onlineUsers = 0;

// Data storage path
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'board-state.dat');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Encode boolean array to compact Base64 string
function encodeState(state: boolean[]): string {
    const byteLength = Math.ceil(state.length / 8);
    const buffer = Buffer.alloc(byteLength);
    
    for (let i = 0; i < state.length; i++) {
        if (state[i]) {
            const byteIndex = Math.floor(i / 8);
            const bitIndex = i % 8;
            buffer[byteIndex] |= (1 << bitIndex);
        }
    }
    
    return buffer.toString('base64');
}

// Decode Base64 string back to boolean array
function decodeState(encoded: string): boolean[] {
    const buffer = Buffer.from(encoded, 'base64');
    const state: boolean[] = new Array(TOTAL_SQUARES).fill(false);
    
    for (let i = 0; i < TOTAL_SQUARES; i++) {
        const byteIndex = Math.floor(i / 8);
        const bitIndex = i % 8;
        if (byteIndex < buffer.length) {
            state[i] = ((buffer[byteIndex] >> bitIndex) & 1) === 1;
        }
    }
    
    return state;
}

// Load saved state from disk
function loadState(): boolean[] {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const encoded = fs.readFileSync(DATA_FILE, 'utf-8').trim();
            const savedState = decodeState(encoded);
            if (savedState.length === TOTAL_SQUARES) {
                console.log('Loaded saved board state from disk');
                return savedState;
            }
        }
    } catch (error) {
        console.error('Failed to load saved state:', error);
    }
    console.log('Using default board state');
    return new Array(TOTAL_SQUARES).fill(true);
}

// Save state to disk
function saveState(): void {
    try {
        const encoded = encodeState(gridState);
        fs.writeFileSync(DATA_FILE, encoded, 'utf-8');
        const fileSize = Buffer.byteLength(encoded, 'utf-8');
        console.log(`Board state saved (${fileSize} bytes) at ${new Date().toLocaleString()}`);
    } catch (error) {
        console.error('Failed to save state:', error);
    }
}

// Initialize grid state from saved data or default
Object.assign(gridState, loadState());

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
});

// 将 Socket.io 绑定到 Hono 的服务器实例上
const io = new Server(serverInstance);


io.on('connection', (socket: Socket) => {
    // Increase the number of online users and broadcast
    onlineUsers++;
    io.emit('online-users', onlineUsers);
    
    // Bundle the "configuration" and "state" together when sending to new users,
    // so the frontend knows how many rows and columns to render
    socket.emit('init-game', {
        config: gameConfig,
        state: gridState
    });

    socket.on('toggle-square', (index: number) => {
        if (typeof index === 'number' && index >= 0 && index < TOTAL_SQUARES) {
            gridState[index] = !gridState[index];
            io.emit('update-square', {
                index: index,
                isBlack: gridState[index]
            });
        }
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