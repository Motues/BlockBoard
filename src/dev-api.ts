// 开发者工具的服务端部分：密码换 token、token 校验、批量改色接口，
// 以及设置弹窗里的「数据导出 / 导入」（game-config.json + 二进制存档的打包文件）。
//
// 认证：密码优先取环境变量 DEV_PASSWORD，其次 game-config.json 的 devPassword，
// 两者都没有就整个关闭；校验通过下发一个内存里的随机 token（默认 8 小时过期），
// 之后请求带 x-dev-token（或 Authorization: Bearer）。密码比对用 timingSafeEqual，
// 并按 IP 限制失败次数。
//
// 导出 / 导入不要求先登录开发者模式：它们是危险操作，但只认「这一次请求里带的开发者密码」
// （x-dev-password 头，与登录用的是同一份密码），失败同样计入按 IP 的锁定。这样设置弹窗里
// 复用已经保存的开发者密码就能用，不必先去点开发者工具。

import crypto from 'crypto';
import type { Context, Hono } from 'hono';
import { liveConfig } from './board-config';
import { getGridState } from './board-state';
import { ImportError, applyImport, exportFileName, exportPackage, MAX_PACKAGE_BYTES } from './board-transfer';
import { BLACK, PRESET_MAX, RGB_MASK, isCustomValue, toLegacyIndex } from './state';

/** token 有效期（小时），可用 game-config.json 的 devSessionHours 覆盖 */
const DEFAULT_SESSION_HOURS = 8;
/** 同一个 IP 连续失败多少次后暂时锁定 */
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
/** 单次批量操作的格子上限，防止一个请求把整块棋盘刷掉 */
const MAX_REGION_CELLS = 200000;

export interface DevPaintResult {
  changed: number;
  /** 变化格子的 RLE（[跳过多少格, 连续多少格, 颜色值]），空串表示没有变化 */
  runs: string;
  /** runs 的基准下标（逐格写入时由 paintValues 给出，见下面的 start 说明） */
  start?: number;
}

// 注意：棋盘尺寸**不**通过这里传（没有 cols / rows 字段）。数据导入会换掉它
// （board-transfer 的 setLiveConfig + replaceGrid），而本 API 只在启动时注册一次；
// 传进来的尺寸会被闭包缓存成"启动那一刻的值"，于是导入放大棋盘后越界的框选要重启才恢复。
// 一律改成每次请求现场取：矩形用 liveConfig，格子下标用 getGridState().length。
export interface DevApiOptions {
  password: string;
  sessionHours: number;
  /** 把矩形区域涂成某个取值 */
  paintRect: (x: number, y: number, width: number, height: number, color: number) => DevPaintResult;
  /** 把一组散落的格子（闭合区域填充）涂成某个取值 */
  paintCells: (cells: number[], color: number) => DevPaintResult;
  /**
   * 逐格写入：cells 与 values 一一对应，同一批里每格可以不同取值
   * （导入选区 JSON / AI 绘图）。cells 必须按下标升序；base 是这批格子的起点
   * （区域左上角），返回的 start 要原样放进响应里，和广播用同一个基准
   */
  paintValues: (cells: number[], values: number[], base: number) => DevPaintResult;
  /**
   * 数据导入成功后调用：棋盘可能连尺寸一起换了，需要让所有在线客户端
   * 丢掉本地缓存重新拉一份全量（见 board-sync.ts 的 resetBoardForClients）
   */
  onBoardReset?: () => void;
}

export interface DevAuthInfo {
  enabled: boolean;
}

/** 密码来源：环境变量优先，其次 game-config.json */
export function resolveDevPassword(): { password: string; source: 'env' | 'config' | 'none' } {
  const fromEnv = typeof process.env.DEV_PASSWORD === 'string' ? process.env.DEV_PASSWORD.trim() : '';
  if (fromEnv.length > 0) return { password: fromEnv, source: 'env' };

  const fromConfig = typeof liveConfig.devPassword === 'string' ? liveConfig.devPassword.trim() : '';
  if (fromConfig.length > 0) return { password: fromConfig, source: 'config' };

  return { password: '', source: 'none' };
}

export function registerDevApi(app: Hono, options: DevApiOptions): DevAuthInfo {
    // 注意：**不要**在这里把 options.cols / options.rows 取出来缓存。
    // 数据导入会换掉棋盘尺寸（board-transfer 的 setLiveConfig + replaceGrid），
    // 而这个 API 只在启动时注册一次；把尺寸缓存在闭包里就会出现
    // “导入放大棋盘后，越过旧边界的框选被判 out-of-range、必须重启才生效”。
    // 每次请求都按当前状态取：格子边界用 gridState 的实际长度，矩形用 liveConfig。
    const { password } = options;
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

    function tooLarge(c: Context) {
        return c.json({
            ok: false,
            error: 'too-large',
            message: `文件太大（上限 ${Math.floor(MAX_PACKAGE_BYTES / 1024 / 1024)} MB） / File too large`
        }, 413);
    }

    // --- 危险操作（数据导出 / 导入）的密码校验 ---
    // 其实就是开发者密码：设置弹窗复用同一栏（先换一次 /api/dev/login 拿 token 提交），
    // 所以这里不要求 x-dev-token，失败次数与登录共用同一份记录，锁定期也一样。
    function guardAdminPassword(c: Context, given: string): Response | null {
        if (!enabled) {
            return c.json({
                ok: false,
                error: 'disabled',
                message: '未启用管理功能：请设置环境变量 DEV_PASSWORD 或 game-config.json 的 devPassword'
            }, 503);
        }

        const ip = clientIp(c);

        if (isBlocked(ip)) {
            return c.json({ ok: false, error: 'locked', message: '尝试次数过多，请稍后再试 / Too many attempts' }, 429);
        }

        if (!given || !sameSecret(given, password)) {
            recordFailure(ip);
            return c.json({ ok: false, error: 'bad-password', message: '开发者密码不正确 / Wrong developer password' }, 401);
        }

        failures.delete(ip);
        return null;
    }

    // --- multipart/form-data 解析（只处理导入需要的「一个字段 + 一个文件」）---
    interface MultipartParts {
        fields: Record<string, string>;
        file: Buffer | null;
    }

    // 按 latin1（binary）切分：文件是二进制，用 UTF-8 解码会把非 ASCII 字节弄坏
    function parseMultipart(text: string, boundary: string): MultipartParts | null {
        const result: MultipartParts = { fields: {}, file: null };
        const marker = '--' + boundary;

        if (!text.includes(marker)) return null;

        for (const piece of text.split(marker)) {
            const part = piece.replace(/^\r?\n/, '');
            const headerEnd = part.indexOf('\r\n\r\n');
            if (headerEnd < 0 || part.indexOf('Content-Disposition') < 0) continue;

            const headers = part.slice(0, headerEnd);
            let body = part.slice(headerEnd + 4);
            if (body.endsWith('\r\n')) body = body.slice(0, -2);

            const name = /name="([^"]*)"/.exec(headers);
            if (!name) continue;

            if (/filename="/.test(headers)) result.file = Buffer.from(body, 'binary');
            else result.fields[name[1]] = body;
        }

        return result;
    }

    // 从上传请求里取出打包文件；multipart 之外的形式（application/octet-stream）
    // 就把整个请求体当包。密码只认 x-dev-password 头（multipart 的 password 字段也接受），
    // 不接受放在文件内容里。
    function extractUpload(contentType: string, buf: Buffer): { pkg: Buffer | null } {
        if (!contentType.includes('multipart/form-data')) {
            return { pkg: buf.length > 0 ? buf : null };
        }

        const boundary = /boundary="?([^";]+)"?/.exec(contentType);
        if (!boundary) return { pkg: null };

        const parsed = parseMultipart(buf.toString('binary'), boundary[1]);
        if (!parsed) return { pkg: null };

        if (parsed.file) return { pkg: parsed.file };

        const inline = parsed.fields.package;
        if (!inline) return { pkg: null };

        const comma = inline.indexOf(',');
        const head = comma >= 0 ? inline.slice(0, comma) : '';
        const data = comma >= 0 && head.includes('base64') ? inline.slice(comma + 1) : inline;

        return { pkg: Buffer.from(data, head.includes('base64') ? 'base64' : 'binary') };
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
        // 棋盘尺寸以**当前生效**的配置为准：数据导入可能刚把它换掉
        const current = { cols: liveConfig.cols, rows: liveConfig.rows };

        if (!enabled) {
            return c.json({ ok: true, enabled: false, active: false, config: current });
        }

        const active = authenticate(c);
        return c.json({
            ok: true,
            enabled: true,
            active,
            config: current
        });
    });

    // --- 数据导出：game-config.json（已剥离 devPassword）+ 二进制存档 ---
    app.post('/api/dev/export', (c) => {
        const denied = guardAdminPassword(c, (c.req.header('x-dev-password') || '').trim());
        if (denied) return denied;

        try {
            const { file, summary } = exportPackage();

            c.header('Content-Type', 'application/octet-stream');
            c.header('Content-Disposition', `attachment; filename="${exportFileName()}"`);
            c.header('Cache-Control', 'no-store');
            c.header('X-BlockBoard-Bytes', String(summary.bytes));
            c.header('X-BlockBoard-Cells', `${summary.cols}x${summary.rows}`);

            console.log(`[dev] data package exported (${summary.bytes} bytes, save ${summary.saveBytes} bytes)`);
            return c.body(new Uint8Array(file));
        } catch (error) {
            console.error('[dev] data export failed:', error);
            return c.json({ ok: false, error: 'export-failed', message: '导出失败 / Export failed' }, 500);
        }
    });

    // --- 数据导入：解析打包文件，覆盖 game-config.json 与存档 ---
    app.post('/api/dev/import', async (c) => {
        const contentType = c.req.header('content-type') || '';
        const headerPassword = (c.req.header('x-dev-password') || '').trim();

        // 先按 Content-Length 拒掉过大的上传：**不要**先 await 整个请求体，
        // 否则一个 10 GB 的请求会先在内存里炸掉（HTTP 层另有 maxRequestBodySize 兜底）
        const declared = Number(c.req.header('content-length'));

        if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES) {
            return tooLarge(c);
        }

        const body = await c.req.arrayBuffer();

        // 没带 Content-Length（分块上传）时按实际长度兜底
        if (body.byteLength > MAX_PACKAGE_BYTES) {
            return tooLarge(c);
        }

        const raw = Buffer.from(body);

        if (raw.length === 0) {
            return c.json({ ok: false, error: 'empty', message: '没有收到文件 / No file uploaded' }, 400);
        }

        // 密码可以放在请求头，也可以放在 multipart 字段里（客户端用请求头）
        let password = headerPassword;

        if (!password && contentType.includes('multipart/form-data')) {
            const boundary = /boundary="?([^";]+)"?/.exec(contentType);
            const parts = boundary ? parseMultipart(raw.toString('binary'), boundary[1]) : null;
            if (parts && parts.fields.password) password = parts.fields.password.trim();
        }

        const denied = guardAdminPassword(c, password);
        if (denied) return denied;

        const { pkg } = extractUpload(contentType, raw);

        if (!pkg || pkg.length === 0) {
            return c.json({ ok: false, error: 'empty', message: '没有收到文件 / No file uploaded' }, 400);
        }

        try {
            const result = applyImport(pkg, options.onBoardReset);

            if (!result) {
                return c.json({
                    ok: false,
                    error: 'bad-package',
                    message: '不是有效的 BlockBoard 备份包（文件可能损坏） / Not a valid BlockBoard package'
                }, 400);
            }

            console.log(
                `[dev] data package imported (config ${result.configBytes} bytes, save ${result.saveBytes} bytes, ` +
                `${result.newCols} x ${result.newRows}${result.sizeChanged ? ', size changed' : ''})`
            );

            return c.json({
                ok: true,
                configBytes: result.configBytes,
                saveBytes: result.saveBytes,
                cols: result.newCols,
                rows: result.newRows,
                sizeChanged: result.sizeChanged
            });
        } catch (error) {
            if (error instanceof ImportError) {
                console.warn(`[dev] data import rejected (${error.code}): ${error.message}`);
                return c.json({ ok: false, error: error.code, message: error.message }, 400);
            }

            console.error('[dev] data import failed:', error);
            return c.json({ ok: false, error: 'import-failed', message: '导入失败 / Import failed' }, 500);
        }
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

            // 下标边界按**当前**状态长度校验（导入可能刚把棋盘换大 / 换小）
            const total = getGridState().length;
            const cells: number[] = [];
            for (const raw of body.cells) {
                const index = Number(raw);
                if (!Number.isInteger(index) || index < 0 || index >= total) {
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

        // 尺寸取当前生效的配置：导入放大棋盘后，新范围必须立刻可用（不用重启）
        const cols = liveConfig.cols;
        const rows = liveConfig.rows;

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
                runs: result.runs,
                // 客户端拿到响应后会用 range 在本机直接套用一遍（不等广播绕一圈），
                // 所以颜色字段必须带上，否则本机会被涂成 applyRegionPayload 的兜底色（1 号色）
                value: toLegacyIndex(color),
                rgb: isCustomValue(color) ? color : null,
                isBlack: color === BLACK
            }
        });
    });

    // --- 逐格写入：导入选区 JSON / AI 绘图 ---
    // 形状与客户端导出的选区 JSON 一致：
    //   { x, y, width?, height?, cells: [[值, ...], ...] }   行优先，起点 (x, y) 是左上角
    // width / height 可以省略（按 cells 推导），给了就必须和 cells 对得上。
    // 取值与单元格协议同一套：0 黑、1..PRESET_MAX 预设编号、> PRESET_MAX 为 24bit RGB。
    // 客户端导入大选区时会按行切成多次请求（单次上限 MAX_REGION_CELLS），
    // 每次请求是一段连续的整行，所以这里的下标天然按下标升序。
    app.post('/api/dev/draw', async (c) => {
        if (!enabled) return c.json({ ok: false, error: 'disabled', message: '开发者工具未启用' }, 503);
        if (!authenticate(c)) return unauthorized(c);

        let body: {
            x?: unknown; y?: unknown; width?: unknown; height?: unknown; cells?: unknown;
        } = {};
        try {
            body = await c.req.json();
        } catch {
            body = {};
        }

        const x = Number(body.x);
        const y = Number(body.y);

        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
            return c.json({ ok: false, error: 'bad-range', message: '起点坐标不合法' }, 400);
        }

        const rows = body.cells;
        if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(rows[0])) {
            return c.json({ ok: false, error: 'bad-shape', message: 'cells 必须是二维数组' }, 400);
        }

        const height = rows.length;
        const width = rows[0].length;

        if (width === 0) {
            return c.json({ ok: false, error: 'bad-shape', message: 'cells 里的行是空的' }, 400);
        }
        if (body.width !== undefined && Number(body.width) !== width) {
            return c.json({ ok: false, error: 'bad-shape', message: 'width 与 cells 不一致' }, 400);
        }
        if (body.height !== undefined && Number(body.height) !== height) {
            return c.json({ ok: false, error: 'bad-shape', message: 'height 与 cells 不一致' }, 400);
        }

        // 先把上限和边界挡在前面：后面才按 width * height 分配下标数组，
        // 否则一个声明成 10 万 x 10 万的 body 会先在这里把内存吃掉
        if (width * height > MAX_REGION_CELLS) {
            return c.json({ ok: false, error: 'too-large', message: `一次最多修改 ${MAX_REGION_CELLS} 个方块` }, 400);
        }

        // 边界一律现场取：数据导入会换掉棋盘尺寸，缓存启动尺寸会让放大后的棋盘写不进去
        const cols = liveConfig.cols;
        const rowsCount = liveConfig.rows;

        if (x + width > cols || y + height > rowsCount) {
            return c.json({ ok: false, error: 'out-of-range', message: '区域超出棋盘范围' }, 400);
        }

        const cells: number[] = new Array(width * height);
        const values: number[] = new Array(width * height);
        let cursor = 0;

        for (let row = 0; row < height; row++) {
            const line = rows[row];
            if (!Array.isArray(line) || line.length !== width) {
                return c.json({ ok: false, error: 'bad-shape', message: 'cells 每行的长度必须一致' }, 400);
            }

            const rowStart = (y + row) * cols + x;

            for (let col = 0; col < width; col++) {
                const value = Number(line[col]);

                if (!Number.isInteger(value) || value < 0 || value > RGB_MASK) {
                    return c.json({ ok: false, error: 'bad-value', message: '包含非法的颜色取值' }, 400);
                }

                cells[cursor] = rowStart + col;
                values[cursor] = value;
                cursor++;
            }
        }

        const result = options.paintValues(cells, values, y * cols + x);

        return c.json({
            ok: true,
            changed: result.changed,
            // 本机套用用：颜色在 runs 的每一段里，所以不带 value / rgb / isBlack。
            // start 必须用 paintValues 回报的那个（广播用的是同一个）—— 直接写区域起点
            // 会在"左上角那几格本来就是目标色"时和广播错开，客户端看起来就是导入画了两遍
            range: { start: result.start ?? (y * cols + x), width, height, runs: result.runs }
        });
    });

    return { enabled };
}
