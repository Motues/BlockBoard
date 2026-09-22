// 应用版本号：从 package.json 读一次，下发给客户端（init-game 的 version，见 board-sync.ts），
// 设置弹窗左下角显示成 “BlockBoard | v1.7.0”。
//
// 单独一个模块是因为它既不是运行期可变的棋盘配置（board-config.ts），也不该让 board-sync
// 自己去碰文件；这里只依赖 fs / path，谁都能 import。
//
// 用 fs 读而不是 `import pkg from '../package.json'`：静态 require 会把整份 package.json
// 编进产物，文件缺失时还会让整个模块图崩掉；这里读不到只退化成 '0.0.0'。

import fs from 'fs';
import path from 'path';

/** 仓库根 / 镜像 /app 下的 package.json（= dist/server.js 的上一级） */
const PACKAGE_FILE = path.join(__dirname, '../package.json');

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf-8')) as { version?: unknown };
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    return version.length > 0 ? version : '0.0.0';
  } catch (error) {
    // 不影响服务：只会在设置弹窗里显示成 0.0.0
    console.error(`Cannot read the version from ${PACKAGE_FILE}:`, error);
    return '0.0.0';
  }
}

/** 下发给客户端的版本号 */
export const APP_VERSION = readVersion();
