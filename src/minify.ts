// 前端资源压缩：public/ 里是给浏览器跑的裸 ES module（没有打包步骤），发出去之前
// 用 esbuild 压一遍 —— 去掉注释、压成一行、局部变量改名，顺便把体积压小一半左右。
//
// 为什么在服务端做、还是常驻内存：
//   · 这些文件加起来不到 300 KB，esbuild 压完只要几十毫秒，启动时做一次就够了；
//   · 压缩结果缓存在内存里（serveMinified），每个文件只压一次，之后直接吐字符串，
//     没有额外的磁盘 IO，也不需要往 public/ 里写中间产物；
//   · **只压不改结构**：不打包（bundling 关掉），每个 .mjs 还是独立的 ES module，
//     模块之间照旧按相对路径 import —— 一旦打包成单文件，AGENT.md 里那套
//     "模块图靠裸相对路径 import" 的部署方式就没了，而且导入的具名绑定
//     （比如 onLoadStatus）在压缩后仍然保持原名，跨模块调用不会断。
//
// 注意 esbuild 的默认 charset 是 ascii，会把中日韩文案转成 \uXXXX（i18n.mjs 首当其冲），
// 所以必须显式 charset: 'utf8' —— 否则压缩后反而比源码更大。

import fs from 'fs';
import path from 'path';
import type { MiddlewareHandler } from 'hono';
import { transform } from 'esbuild';

/** 压缩哪些后缀：只处理浏览器真正会跑的脚本与样式，html / svg / 字体原样发 */
const SCRIPT_DIR = 'js';
const STYLE_FILES = ['styles.css'];

/** 需要压的资源的访问路径 → 磁盘上的源文件路径 */
function collectEntries(publicDir: string): Map<string, string> {
  const entries = new Map<string, string>();

  const jsDir = path.join(publicDir, SCRIPT_DIR);
  if (fs.existsSync(jsDir)) {
    for (const file of fs.readdirSync(jsDir)) {
      if (file.endsWith('.mjs') || file.endsWith('.js')) {
        entries.set(`/${SCRIPT_DIR}/${file}`, path.join(jsDir, file));
      }
    }
  }

  for (const file of STYLE_FILES) {
    const full = path.join(publicDir, file);
    if (fs.existsSync(full)) entries.set(`/${file}`, full);
  }

  return entries;
}

/** 按后缀挑 esbuild 的 loader；不认识的后缀直接跳过（不压） */
function loaderFor(file: string): 'js' | 'css' | null {
  if (file.endsWith('.mjs') || file.endsWith('.js')) return 'js';
  if (file.endsWith('.css')) return 'css';
  return null;
}

export interface MinifiedAsset {
  body: string;
  contentType: string;
  /** 压缩前的字节数，只用来打一行日志 */
  sourceBytes: number;
}

export interface MinifyResult {
  /** 访问路径（/js/main.mjs）→ 压缩后的内容 */
  assets: Map<string, MinifiedAsset>;
  sourceBytes: number;
  minifiedBytes: number;
  /** 失败的文件数（失败的那些照旧发源码，不影响页面） */
  failed: number;
}

/**
 * 把 public/ 下的脚本与样式全压一遍。**失败不会抛**：某个文件压不动就跳过它，
 * 由 serveStatic 发原始文件 —— 宁可多传几 KB，也不能让页面整个起不来。
 */
export async function minifyPublicAssets(publicDir: string): Promise<MinifyResult> {
  const entries = collectEntries(publicDir);
  const assets = new Map<string, MinifiedAsset>();
  let sourceBytes = 0;
  let minifiedBytes = 0;
  let failed = 0;

  // 一次性并发交出去：esbuild 自己会调度，文件数也不多（20 个上下）
  const jobs = [...entries].map(async ([urlPath, file]) => {
    const loader = loaderFor(file);
    if (!loader) return;

    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      failed++;
      console.error(`[minify] cannot read ${file}:`, error);
      return;
    }

    try {
      const result = await transform(source, {
        loader,
        minify: true,
        // 中日韩文案必须保持原样（见文件头注释）
        charset: 'utf8',
        // 注释是这次压缩的主要目标，法律声明也一并去掉（本项目的 LICENSE 在仓库根目录）
        legalComments: 'none',
        // 保留 ESM 语义：不转 CJS、不改动 import / export
        format: 'esm',
        // target 必须给 esnext：客户端有顶层 await（shared.mjs 顶层读 IndexedDB），
        // es2020 会直接报 "Top-level await is not available" 把整个文件跳过；
        // 这里也不做降级转换（客户端本来就要求现代浏览器），只是让语法检查放行
        target: 'esnext'
      });

      const body = result.code;
      assets.set(urlPath, {
        body,
        contentType: loader === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        sourceBytes: Buffer.byteLength(source)
      });
      sourceBytes += Buffer.byteLength(source);
      minifiedBytes += Buffer.byteLength(body);
    } catch (error) {
      failed++;
      console.error(`[minify] cannot minify ${file}:`, error);
    }
  });

  await Promise.all(jobs);

  return { assets, sourceBytes, minifiedBytes, failed };
}

/** 一行启动日志：省了多少、还有几个没压成 */
export function describeMinifyResult(result: MinifyResult): string {
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
  const saved = result.sourceBytes > 0
    ? `${(100 - (result.minifiedBytes / result.sourceBytes) * 100).toFixed(0)}%`
    : '0%';

  return `Frontend minified: ${result.assets.size} files, ${kb(result.sourceBytes)} -> ${kb(result.minifiedBytes)} (-${saved})`
    + (result.failed > 0 ? `, ${result.failed} failed (served as source)` : '');
}

/**
 * 把压缩结果接成 Hono 中间件，**必须挂在 serveStatic 之前**：命中就直接把内存里那份发出去，
 * 没命中就 next() 交给 serveStatic 发源码（.svg / 字体 / 压缩失败的文件都走这条路）。
 *
 * 传进来的是**取结果的函数**而不是结果本身：压缩是启动时异步跑的（不能让 await 挡住
 * 模块顶层的 socket.io / 状态初始化），所以这里每来一个请求才去取一次。
 * 也**不能**等压完了再 app.use —— Hono 的中间件栈在第一个请求进来时就定下来了，
 * 之后再 app.use 不会生效（踩过这个坑：压好了但页面拿到的还是源码）。
 *
 * Cache-Control 在这里就地写上，不用再依赖文件后缀判断的那层中间件。
 */
export function serveMinified(getResult: () => MinifyResult | null): MiddlewareHandler {
  return async (c, next) => {
    const result = getResult();

    // 去掉查询串：styles.css?v=1.6.1 与 styles.css 是同一份
    const asset = result?.assets.get(c.req.path);

    if (!asset) {
      await next();
      return;
    }

    c.header('Content-Type', asset.contentType);
    // 长度按字节算，中文文案是多字节的，用 body.length 会偏小
    c.header('Content-Length', String(Buffer.byteLength(asset.body)));
    // 与静态资源那层一致：允许缓存，但每次回源校验
    c.header('Cache-Control', 'no-cache');
    return c.body(asset.body);
  };
}
