// 开发者工具的服务端部分：密码换 token、token 校验，以及批量改色接口。
//
// 认证设计：
//   · 密码从环境变量 DEV_PASSWORD 读，其次读 game-config.json 的 devPassword；
//     两者都没有时开发者工具整个关闭（登录接口返回「未启用」）
//   · 校验通过后下发一个随机 token，只存在内存里，默认 8 小时过期
//   · 之后每个请求带 x-dev-token 头（也接受 Authorization: Bearer）
//   · 退出登录会立刻作废 token；服务重启后所有 token 失效
//   · 密码比对用 timingSafeEqual，并按 IP 限制失败次数，避免被暴力猜

import crypto from 'crypto';
import type { Context, Hono } from 'hono';
import { PRESET_MAX, RGB_MASK } from './state';

/** 默认的 token 有效期（小时），可以用 game-config.json 的 devSessionHours 覆盖 */
const DEFAULT_SESSION_HOURS = 8;
/** 同一个 IP 连续失败多少次后暂时锁定 */
const MAX_FAILURES = 5;
/** 锁定时长(ms) */
const LOCKOUT_MS = 5 * 60 * 1000;
/** 单次批量操作的格子上限，防止一个请求把整块棋盘刷掉 */
const MAX_REGION_CELLS = 200000;

export interface DevPaintResult {
    changed: number;
    /** 变化格子的 RLE（[跳过多少格, 连续多少格, 颜色值]），空串表示没有变化 */
    runs: string;
}

export interface DevApiOptions {
    password: string;
    sessionHours: number;
    cols: number;
    rows: number;
    /** 把矩形区域涂成某个取值 */
    paintRect: (x: number, y: number, width: number, height: number, color: number) => DevPaintResult;
    /** 把一组散落的格子（闭合区域填充）涂成某个取值 */
    paintCells: (cells: number[], color: number) => DevPaintResult;
}

export interface DevAuthInfo {
    enabled: boolean;
}

export function resolveDevPassword(configPassword: unknown): { password: string; source: 'env' | 'config' | 'none' } {
    const fromEnv = typeof process.env.DEV_PASSWORD === 'string' ? process.env.DEV_PASSWORD.trim() : '';
    if (fromEnv.length > 0) return { password: fromEnv, source: 'env' };

    const fromConfig = typeof configPassword === 'string' ? configPassword.trim() : '';
    if (fromConfig.length > 0) return { password: fromConfig, source: 'config' };

    return { password: '', source: 'none' };
}

export function registerDevApi(app: Hono, options: DevApiOptions): DevAuthInfo {
    const { password, cols, rows } = options;
    const sessionMs = Math.max(1, options.sessionHours || DEFAULT_SESSION_HOURS) * 60 * 60 * 1000;

    // token -> 过期时间
    const sessions = new Map<string, number>();
    // ip -> { count, blockedUntil }
    const failures = new Map<string, { count: number; blockedUntil: number }>();

    const enabled = password.length > 0;

    function clientIp(c: Context): string {
        const forwarded = c.req.header('x-forwarded-for');
        if (forwarded) return forwarded.split(',')[0].trim();
        return 'local';
    }

    function isBlocked(ip: string): boolean {
        const record = failures.get(ip);
        if (!record) return false;

        if (record.blockedUntil > Date.now()) return true;

        // 锁定期已过，清掉记录重新计数
        if (record.blockedUntil !== 0) failures.delete(ip);
        return false;
    }

    function recordFailure(ip: string): void {
        const record = failures.get(ip) || { count: 0, blockedUntil: 0 };
        record.count++;

        if (record.count >= MAX_FAILURES) {
            record.count = 0;
            record.blockedUntil = Date.now() + LOCKOUT_MS;
            console.warn(`[dev] too many failed logins from ${ip}, locked for ${LOCKOUT_MS / 60000} minutes`);
        }

        failures.set(ip, record);
    }

    function sameSecret(a: string, b: string): boolean {
        const left = Buffer.from(a);
        const right = Buffer.from(b);
        // 长度不同时 timingSafeEqual 会抛错，先比长度（长度本身不算敏感信息）
        if (left.length !== right.length) return false;
        return crypto.timingSafeEqual(left, right);
    }

    function readToken(c: Context): string {
        const header = c.req.header('x-dev-token');
        if (header) return header.trim();

        const bearer = c.req.header('authorization') || '';
        return bearer.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : '';
    }

    /** 校验请求里的 token，返回是否有效 */
    function authenticate(c: Context): boolean {
        const token = readToken(c);
        if (!token) return false;

        const expiresAt = sessions.get(token);
        if (expiresAt === undefined) return false;

        if (expiresAt <= Date.now()) {
            sessions.delete(token);
            return false;
        }

        return true;
    }

    function unauthorized(c: Context) {
        return c.json({ ok: false, error: 'unauthorized', message: '登录已失效，请重新登录 / Session expired' }, 401);
    }

    // 定期清理过期会话，避免内存慢慢涨
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [token, expiresAt] of sessions) {
            if (expiresAt <= now) sessions.delete(token);
        }
    }, 30 * 60 * 1000);
    // 别让这个定时器拖住进程退出
    if (typeof sweep.unref === 'function') sweep.unref();

    // --- 登录 ---
    app.post('/api/dev/login', async (c) => {
        if (!enabled) {
            return c.json({
                ok: false,
                error: 'disabled',
                message: '开发者工具未启用：请设置环境变量 DEV_PASSWORD 或 game-config.json 的 devPassword'
            }, 503);
        }

        const ip = clientIp(c);
        if (isBlocked(ip)) {
            return c.json({ ok: false, error: 'locked', message: '尝试次数过多，请稍后再试 / Too many attempts' }, 429);
        }

        let body: { password?: unknown } = {};
        try {
            body = await c.req.json();
        } catch {
            body = {};
        }

        const given = typeof body.password === 'string' ? body.password : '';
        if (!given || !sameSecret(given, password)) {
            recordFailure(ip);
            return c.json({ ok: false, error: 'bad-password', message: '密码不正确 / Wrong password' }, 401);
        }

        failures.delete(ip);

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + sessionMs;
        sessions.set(token, expiresAt);

        console.log(`[dev] developer session opened from ${ip} (${sessions.size} active)`);
        return c.json({ ok: true, token, expiresAt });
    });

    // --- 退出（作废 token）---
    app.post('/api/dev/logout', (c) => {
        const token = readToken(c);
        if (token) sessions.delete(token);
        return c.json({ ok: true });
    });

    // --- 会话状态 ---
    app.get('/api/dev/session', (c) => {
        if (!enabled) {
            return c.json({ ok: true, enabled: false, active: false, config: { cols, rows } });
        }

        const active = authenticate(c);
        return c.json({
            ok: true,
            enabled: true,
            active,
            config: { cols, rows }
        });
    });

    // --- 批量改色 ---
    // 两种形状：
    //   { x0, y0, x1, y1, color }  矩形区域（框选）
    //   { cells: number[], color } 一组散落的格子（客户端算好的闭合区域）
    app.post('/api/dev/paint', async (c) => {
        if (!enabled) return c.json({ ok: false, error: 'disabled', message: '开发者工具未启用' }, 503);
        if (!authenticate(c)) return unauthorized(c);

        let body: {
            x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown;
            cells?: unknown; color?: unknown;
        } = {};
        try {
            body = await c.req.json();
        } catch {
            body = {};
        }

        const color = Number(body.color);

        // 颜色取值与单元格协议一致：0 = 黑，1..PRESET_MAX = 预设编号，> PRESET_MAX = 24bit 自定义色
        const isBlack = color === 0;
        const isPreset = Number.isInteger(color) && color >= 1 && color <= PRESET_MAX;
        const isRgb = Number.isInteger(color) && color > PRESET_MAX && color <= RGB_MASK;

        if (!isBlack && !isPreset && !isRgb) {
            return c.json({ ok: false, error: 'bad-color', message: '颜色值不合法' }, 400);
        }

        // --- 闭合区域：一组格子 ---
        if (Array.isArray(body.cells)) {
            if (body.cells.length === 0) {
                return c.json({ ok: false, error: 'empty', message: '区域是空的' }, 400);
            }
            if (body.cells.length > MAX_REGION_CELLS) {
                return c.json({ ok: false, error: 'too-large', message: `一次最多修改 ${MAX_REGION_CELLS} 个方块` }, 400);
            }

            const cells: number[] = [];
            for (const raw of body.cells) {
                const index = Number(raw);
                if (!Number.isInteger(index) || index < 0 || index >= cols * rows) {
                    return c.json({ ok: false, error: 'bad-cell', message: '区域里包含非法下标' }, 400);
                }
                cells.push(index);
            }

            const result = options.paintCells(cells, color);
            return c.json({ ok: true, changed: result.changed, range: { runs: result.runs, spread: true } });
        }

        // --- 矩形区域 ---
        const x0 = Number(body.x0);
        const y0 = Number(body.y0);
        const x1 = Number(body.x1);
        const y1 = Number(body.y1);

        if (!Number.isInteger(x0) || !Number.isInteger(y0) || !Number.isInteger(x1) || !Number.isInteger(y1)) {
            return c.json({ ok: false, error: 'bad-range', message: '区域坐标不合法' }, 400);
        }

        const startX = Math.min(x0, x1);
        const endX = Math.max(x0, x1);
        const startY = Math.min(y0, y1);
        const endY = Math.max(y0, y1);

        if (startX < 0 || startY < 0 || endX >= cols || endY >= rows) {
            return c.json({ ok: false, error: 'out-of-range', message: '区域超出棋盘范围' }, 400);
        }

        const width = endX - startX + 1;
        const height = endY - startY + 1;
        if (width * height > MAX_REGION_CELLS) {
            return c.json({ ok: false, error: 'too-large', message: `一次最多修改 ${MAX_REGION_CELLS} 个方块` }, 400);
        }

        const result = options.paintRect(startX, startY, width, height, color);

        return c.json({
            ok: true,
            changed: result.changed,
            range: {
                start: startY * cols + startX,
                width,
                height,
                runs: result.runs
            }
        });
    });

    return { enabled };
}
