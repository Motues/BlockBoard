// src/server.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Server, Socket } from 'socket.io';
import path from 'path';
import fs from 'fs';
import gameConfig from '../game-config.json';
import { DevPaintResult, registerDevApi, resolveDevPassword } from './dev-api';
import {
    BLACK,
    CellChange,
    CELL_BYTES,
    PRESET_MAX,
    RGB_MASK,
    SourceDims,
    buildSaveFile,
    customValue,
    decodeState,
    encodeChangedRuns,
    encodeLegacyStateBuffer,
    encodeRleBuffer,
    encodeStateBuffer,
    isCustomValue,
    parseSaveFile,
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

// 棋盘状态的版本号：任何一次改色都 +1。
//   · 全盘编码的快照缓存靠它判断能不能复用
//   · 自动存档靠它判断"这一分钟到底有没有改动"，没改就不写盘
let stateRev = 0;
let savedRev = 0;

function touchState(): void {
    stateRev++;
}

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

// Load saved state from disk。
// 新格式（buildSaveFile 写的、带 'BBS2' 头 + deflate）走精确路径：头里就写着行列数和格式，
// 不需要按字节长度猜；不匹配当前配置时按「左上角对齐」重排。
// 老格式（整个文件是 base64 文本）继续走 decodeState 的启发式，并在这里自动迁移。
function loadState(): Uint32Array {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            console.log('Using default board state');
            return new Uint32Array(TOTAL_SQUARES);
        }

        const file = fs.readFileSync(DATA_FILE);
        if (file.length === 0) {
            console.log('Using default board state');
            return new Uint32Array(TOTAL_SQUARES);
        }

        // --- 新格式 ---
        const parsed = parseSaveFile(file);
        if (parsed) {
            const savedTotal = parsed.cols * parsed.rows;
            const { state } = decodeState(parsed.payload, savedTotal, parsed.cols, {
                cols: parsed.cols,
                rows: parsed.rows
            });

            console.log(
                `Loaded saved board state from disk (v2, ${parsed.flags & 1 ? '24bit' : '4bit'}/cell, ` +
                `${parsed.cols} x ${parsed.rows})`
            );

            if (parsed.cols === gameConfig.cols && parsed.rows === gameConfig.rows) return state;

            console.warn(
                `Save file was made for ${parsed.cols} x ${parsed.rows}, ` +
                `current board is ${gameConfig.cols} x ${gameConfig.rows}: ` +
                'keeping the top-left part and extending / cropping the bottom-right'
            );

            return regridState(state, parsed.cols, parsed.rows, gameConfig.cols, gameConfig.rows);
        }

        // --- 老格式：整个文件是 base64 文本 ---
        const encoded = file.toString('utf-8').trim();
        if (encoded.length > 0) {
            const buffer = Buffer.from(encoded, 'base64');
            const saved = readSavedDims();
            const { state, format, source, mismatched } =
                decodeState(buffer, TOTAL_SQUARES, gameConfig.cols, saved || undefined);

            if (format === 'rgb24') {
                console.log('Loaded legacy saved board state from disk (24bit/cell, 3 bytes)');
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
    } catch (error) {
        console.error('Failed to load saved state:', error);
    }
    console.log('Using default board state');
    return new Uint32Array(TOTAL_SQUARES);
}

// Save state to disk。
// 新格式：'BBS2' 头（带行列数与格式）+ deflate 载荷 + 先写临时文件再 rename（原子替换，
// 中途崩溃不会留下半个文件）；只有棋盘真的变了才写盘。
// 只有棋盘上真的出现自定义颜色时才写 24bit/格，否则写 4bit/格：小 6 倍，旧版本程序也能读
function saveState(): void {
    if (savedRev === stateRev) return; // 没有改动，不重复写盘

    try {
        const file = buildSaveFile(gridState, gameConfig.cols, gameConfig.rows);
        const tempFile = DATA_FILE + '.tmp';

        fs.writeFileSync(tempFile, file);
        fs.renameSync(tempFile, DATA_FILE);
        writeSavedDims();

        savedRev = stateRev;

        console.log(
            `Board state saved (${file.length} bytes on disk for ${TOTAL_SQUARES} cells) at ${new Date().toLocaleString()}`
        );
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

// --- 开发者工具（密码 + token 认证，见 src/dev-api.ts）---
// 密码优先取环境变量 DEV_PASSWORD，其次 game-config.json 的 devPassword
const devPassword = resolveDevPassword((gameConfig as { devPassword?: string }).devPassword);

const devApi = registerDevApi(app, {
    password: devPassword.password,
    sessionHours: Number((gameConfig as { devSessionHours?: number }).devSessionHours) || 8,
    cols: gameConfig.cols,
    rows: gameConfig.rows,
    paintRect: (x, y, width, height, color) => paintRect(x, y, width, height, color),
    paintCells: (cells, color) => paintCells(cells, color)
});

// 托管静态资源（放在接口之后注册，静态文件不会盖掉 /api/*）
app.use('/*', serveStatic({ root: path.join(__dirname, '../public') }));

// 使用 Hono 官方的 serve 启动服务，并获取底层的 httpServer 实例
const serverInstance = serve({
    fetch: app.fetch,
    port: PORT
}, (info) => {
    console.log(`BlockBoard run on http://localhost:${info.port}`);
    console.log(`Current grid: ${gameConfig.cols} x ${gameConfig.rows} (Total ${TOTAL_SQUARES} squares)`);
    console.log(`State format: 24bit/cell (0 = black, 1..${PRESET_MAX} = presets, >= ${PRESET_MAX + 1} = custom RGB)`);

    if (devApi.enabled) {
        console.log(`Developer tools: enabled (password from ${devPassword.source === 'env' ? 'DEV_PASSWORD' : 'game-config.json devPassword'})`);
    } else {
        console.warn('Developer tools: disabled (set DEV_PASSWORD or gameConfig.devPassword to enable them)');
    }
});

// 将 Socket.io 绑定到 Hono 的服务器实例上。
// perMessageDeflate：超过 1KB 的消息（棋盘状态）交给浏览器用 deflate 压一遍再传，
// 几百字节的格子广播不受影响。稠密状态（每个格子颜色都不同的画）靠它能再小一个数量级；
// 不需要的话把这个参数删掉即可
const io = new Server(serverInstance, {
    perMessageDeflate: {
        threshold: 1024
    },
    // 上行单条消息的上限（默认也是 1MB，这里写明是防止以后被无意改动）：
    // 涂格子只有几十字节，批量改色走 HTTP，不需要更大的帧
    maxHttpBufferSize: 1e6
});

function isValidIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < TOTAL_SQUARES;
}

// 广播单格变化（实际是排队，等这一个 16ms 窗口结束再合并发出）：
//   value / isBlack 是给还没刷新到新版的旧页面用的（自定义颜色在它们眼里就是 15 号色）
//   rgb 是自定义颜色的 24bit 值，新页面用它还原出真正的颜色
function broadcastSquare(index: number): void {
    queueSquareUpdate(index);
}

// 批量改色的广播：把变化部分（runs / indices）发出去。
// 给还没刷新到新版的旧页面兜底：它们不认识 runs，用同一个 color 也能勉强画出矩形
function broadcastRegion(color: number, payload: Record<string, unknown>): void {
    io.emit('update-region', {
        ...payload,
        value: toLegacyIndex(color),
        rgb: isCustomValue(color) ? color : null,
        isBlack: color === BLACK
    });
}

// 批量改色（矩形）：把矩形区域涂成 color，并把"确实变了"的格子用一条 RLE 广播出去。
// 开发者工具的一次操作可能覆盖上万个格子，逐格广播显然不可行，
// 这里只发变化部分（[跳过多少格, 连续多少格, 颜色值]），客户端按同样的顺序套用。
// 改动列表按行优先遍历生成，天然按下标升序 —— 不用再整盘复制一份 before 去对拍
function paintRect(x: number, y: number, width: number, height: number, color: number): DevPaintResult {
    const changes: CellChange[] = [];

    for (let row = 0; row < height; row++) {
        const rowStart = (y + row) * gameConfig.cols + x;

        for (let col = 0; col < width; col++) {
            const index = rowStart + col;
            if (gridState[index] === color) continue;

            gridState[index] = color;
            changes.push({ index, value: color });
        }
    }

    if (changes.length === 0) return { changed: 0, runs: '' };

    touchState();
    const start = y * gameConfig.cols + x;
    const runs = encodeChangedRuns(changes, start);

    // start 是 runs 的基准下标（棋盘一维下标），必须一起发出去：
    // runs 里的"跳过多少格"是相对上一段结束的，客户端少了基准就会从 0 开始套用，
    // 整片改动会落到棋盘左上角去
    broadcastRegion(color, { start, runs });

    return { changed: changes.length, runs };
}

// 批量改色（一组散落的格子）：闭包区域填充用。
// 区域由客户端算出来（可能是任意形状），所以这里按"下标 + 同一个颜色"广播，
// 客户端按同样的下标逐个套用；runs 留空表示"这个颜色对所有下标都成立"
function paintCells(cells: number[], color: number): DevPaintResult {
    let changed = 0;

    for (const index of cells) {
        if (!isValidIndex(index) || gridState[index] === color) continue;

        gridState[index] = color;
        changed++;
    }

    if (changed === 0) return { changed: 0, runs: '' };

    touchState();
    broadcastRegion(color, { indices: cells, runs: '' });

    return { changed, runs: '' };
}

// --- 全盘状态编码：带版本号的快照缓存 ---
// 以前每个新连接都要现算一遍 RLE + 稠密（各带一次 base64 分配），1000x1000 的棋盘就是
// 每连接好几 MB 的临时内存和几十万次 varint 写。现在按 stateRev 缓存，并且按需计算：
// 先只算 RLE，稠密格式的字节数是固定的（格子数 * 3），比长度就能决定用哪个，不用先编码出来。
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

/** RLE 紧凑状态；RLE 比稠密还大（噪点棋盘）时由调用方改用 getDenseState */
function getRleState(): Buffer {
    const snap = currentSnapshot();
    if (!snap.rle) snap.rle = encodeRleBuffer(gridState);
    return snap.rle;
}

function getDenseState(): Buffer {
    const snap = currentSnapshot();
    if (!snap.dense) snap.dense = encodeStateBuffer(gridState);
    return snap.dense;
}

/** 老页面认的 4bit/格 状态 */
function getLegacyState(): Buffer {
    const snap = currentSnapshot();
    if (!snap.legacy) snap.legacy = encodeLegacyStateBuffer(gridState);
    return snap.legacy;
}

// 下发给新客户端的棋盘状态：优先 RLE（稀疏棋盘常常只有几十字节），
// 只有 RLE 反而更大时（每个格子颜色都不同的噪点棋盘）才退回 3 字节/格 的稠密格式
function encodeCompactState(): { encoding: 'rle' | 'dense'; data: Buffer } {
    const rle = getRleState();

    return rle.length <= TOTAL_SQUARES * CELL_BYTES
        ? { encoding: 'rle', data: rle }
        : { encoding: 'dense', data: getDenseState() };
}

// --- 单格改色的广播合并 ---
// 16ms 窗口内的多次改动合成一条消息：多人同时点、或一个人连点时，
// 消息数从 N 条降到 1 条，也更容易过 perMessageDeflate 的阈值。
// 认识 batch 能力的客户端收一条数组（index + 24bit 取值），
// 没声明的（没刷新的旧页面）仍然逐格收原来的 update-square。
const BROADCAST_WINDOW_MS = 16;
const pendingSquares = new Map<number, number>(); // index -> 最新取值
let broadcastTimer: NodeJS.Timeout | null = null;

function socketCaps(socket: Socket): Set<string> {
    const stored = socket.data && socket.data.caps;
    return stored instanceof Set ? stored : new Set<string>();
}

function queueSquareUpdate(index: number): void {
    pendingSquares.set(index, gridState[index]);

    if (broadcastTimer) return;
    broadcastTimer = setTimeout(flushSquareUpdates, BROADCAST_WINDOW_MS);
}

function legacySquarePayload(index: number, value: number) {
    return {
        index,
        value: toLegacyIndex(value),
        rgb: isCustomValue(value) ? value : null,
        isBlack: value === BLACK
    };
}

function flushSquareUpdates(): void {
    broadcastTimer = null;
    if (pendingSquares.size === 0) return;

    const entries = Array.from(pendingSquares);
    pendingSquares.clear();

    // 单格（最常见的情况）：沿用原来的事件与载荷，老页面照旧
    if (entries.length === 1) {
        io.emit('update-square', legacySquarePayload(entries[0][0], entries[0][1]));
        return;
    }

    const batch = { cells: entries };

    for (const socket of io.sockets.sockets.values()) {
        if (socketCaps(socket).has('batch')) {
            socket.emit('update-squares', batch);
            continue;
        }

        for (const [index, value] of entries) {
            socket.emit('update-square', legacySquarePayload(index, value));
        }
    }
}

// --- 每个连接的改色令牌桶 ---
// 正常点击 / 拖动连 1/10 都用不到，脚本刷屏会被挡住；被挡掉时回一条 paint-rejected，
// 客户端据此把乐观动画收回去（否则要等 8 秒的超时保护）
const PAINT_BURST = 60;
const PAINT_PER_SECOND = 30;

function createPaintLimiter(): () => boolean {
    let tokens = PAINT_BURST;
    let last = Date.now();

    return () => {
        const now = Date.now();
        tokens = Math.min(PAINT_BURST, tokens + ((now - last) / 1000) * PAINT_PER_SECOND);
        last = now;

        if (tokens < 1) return false;

        tokens -= 1;
        return true;
    };
}

io.on('connection', (socket: Socket) => {
    // Increase the number of online users and broadcast。
    // 这里**不能**用 volatile：socket.io 在传输层正在写（例如刚发出的 CONNECT 应答）时会把
    // volatile 包直接丢掉，而在线人数只在连接 / 断开时发一次，丢掉就意味着这次的人数永远补不上。
    // 一条几十字节的消息，不值得为它冒这个风险
    onlineUsers++;
    io.emit('online-users', onlineUsers);

    // 客户端在握手里声明自己认识哪些状态格式：
    //   rgb24 = 认识 24bit 取值（>= 16 是自定义颜色）和 3 字节/格 的稠密状态
    //   rle   = 额外认识 RLE 紧凑状态
    //   bin   = 状态用二进制发（省掉 base64 的 33%，也不用在客户端 atob）
    //   batch = 认识合并广播 update-squares（一次多条单格改动）
    // 什么都没声明的（没刷新的旧页面）只发 4bit 状态：棋盘照样能看，
    // 只是自定义颜色在它们眼里是 15 号色
    const authCaps = socket.handshake.auth ? socket.handshake.auth.caps : undefined;
    const caps: string[] = Array.isArray(authCaps) ? authCaps : [];
    const capSet = new Set(caps);
    const supportsRgb = capSet.has('rgb24');
    const supportsRle = capSet.has('rle');
    const supportsBinary = capSet.has('bin');
    socket.data.caps = capSet;

    const allowPaint = createPaintLimiter();

    const payload: Record<string, unknown> = {
        config: gameConfig,
        black: BLACK,
        maxColorIndex: PRESET_MAX,
        rgbSupport: true
    };

    if (supportsRgb) {
        const compact = encodeCompactState();

        // 客户端没有 rle 能力时，就算 RLE 更小也只能发它认识的稠密格式
        const encoding = compact.encoding === 'rle' && !supportsRle ? 'dense' : compact.encoding;
        const data = encoding === 'dense' ? getDenseState() : compact.data;

        // 二进制能力：直接发 Buffer（socket.io 会当二进制附件传，客户端收到 ArrayBuffer）
        payload.stateRgb = supportsBinary ? data : data.toString('base64');
        payload.stateEncoding = supportsBinary ? `${encoding}-bin` : encoding;
    } else {
        // 4bit/格（Base64）：旧页面解码后映射成预设色，自定义颜色退化成 15 号色
        payload.state = getLegacyState().toString('base64');
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

        // 超频（脚本刷屏）时挡掉，并告诉客户端把乐观动画收回去
        if (!allowPaint()) {
            socket.emit('paint-rejected', { index });
            return;
        }

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
        touchState();
        broadcastSquare(index);
    });

    // 兼容旧版页面：只有黑 / 白两色（等价于用 1 号颜色涂）
    socket.on('toggle-square', (index: number) => {
        if (!isValidIndex(index)) return;

        if (!allowPaint()) {
            socket.emit('paint-rejected', { index });
            return;
        }

        gridState[index] = gridState[index] === BLACK ? 1 : BLACK;
        touchState();
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
