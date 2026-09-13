// 棋盘状态的本地缓存（IndexedDB）：增量同步用。
//
// 为什么要它：断线重连 / 刷新页面时，如果本机已经有一份状态 + 版本号，
// 就能只让服务端补发差量（甚至什么都不用传），而不是把整盘重传一遍（见 FEATURE.md 的 B2）。
//
// 这里刻意**不 import 任何模块**：shared.mjs 在模块初始化阶段（顶层 await）就会读它，
// 反过来 import shared 会形成循环。所有需要的输入都由调用方通过回调/参数给进来。

const DB_NAME = 'blockboard';
const DB_VERSION = 1;
const STORE_NAME = 'board-state';
const RECORD_KEY = 'current';

// 落盘节流：棋盘一直在改的时候不要每帧都写 IndexedDB
const SAVE_DELAY_MS = 3000;

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve) => {
        try {
            if (typeof indexedDB === 'undefined') {
                resolve(null);
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => resolve(null);
            request.onblocked = () => resolve(null);
        } catch {
            // 隐私模式 / 被策略禁用：当作没有缓存
            resolve(null);
        }
    });

    return dbPromise;
}

// 单元格取值（24bit）→ 3 字节/格 的稠密字节
export function encodeDenseState(state) {
    const bytes = new Uint8Array(state.length * 3);

    for (let i = 0; i < state.length; i++) {
        const value = state[i] & 0x00ffffff;
        const offset = i * 3;

        bytes[offset] = value & 0xff;
        bytes[offset + 1] = (value >> 8) & 0xff;
        bytes[offset + 2] = (value >> 16) & 0xff;
    }

    return bytes;
}

/** 读回上次缓存的棋盘；没有（或读不了）返回 null */
export async function loadCachedState() {
    // 读缓存是在模块初始化（shared.mjs 的顶层 await）里做的：万一 IndexedDB 卡住
    // （例如被另一个标签页的升级阻塞），也不能让整个页面起不来，给它一个上限
    return Promise.race([readCachedState(), delayNull(1500)]);
}

function delayNull(ms) {
    return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

async function readCachedState() {
    try {
        const db = await openDb();
        if (!db) return null;

        return await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);

            request.onsuccess = () => {
                const value = request.result;
                if (!value || !value.bytes || !value.cols || !value.rows) resolve(null);
                else resolve(value);
            };
            request.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        });
    } catch {
        return null;
    }
}

/** 清掉缓存（棋盘尺寸变了、缓存解不出来时用） */
export async function clearCachedState() {
    try {
        const db = await openDb();
        if (!db) return;

        await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(RECORD_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch {
        // 忽略
    }
}

// --- 节流写盘 ---

// 由调用方注入："现在这份状态 + 它的 epoch / rev"（返回 null 表示现在不该写）
let cacheProvider = null;
let saveTimer = 0;
let dirty = false;

export function setCacheProvider(provider) {
    cacheProvider = typeof provider === 'function' ? provider : null;
}

async function writeCache() {
    saveTimer = 0;
    if (!dirty || !cacheProvider) return;

    dirty = false;

    let entry = null;
    try {
        entry = cacheProvider();
    } catch {
        entry = null;
    }

    if (!entry || !entry.bytes || !entry.cols || !entry.rows) return;

    try {
        const db = await openDb();
        if (!db) return;

        await new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(entry, RECORD_KEY);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        });
    } catch {
        // 配额不足 / 隐私模式：放弃缓存，不影响使用
    }

    // 写盘期间棋盘又变了：重新排一次
    if (dirty) markCacheDirty();
}

/** 棋盘状态变了：安排一次延迟写盘 */
export function markCacheDirty() {
    dirty = true;
    if (saveTimer) return;

    saveTimer = setTimeout(writeCache, SAVE_DELAY_MS);
}

/** 立刻写盘（页面被隐藏 / 关闭前用；尽力而为，不保证写完） */
export function flushCacheNow() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = 0;
    }

    void writeCache();
}
