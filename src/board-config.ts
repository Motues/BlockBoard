// 棋盘配置与「能发给客户端的配置」。
// 单独一个模块是为了让 devPassword 只有一个出口，不会跟着 config 漏给客户端。
//
// 注意这里是**运行期可变**的：设置弹窗里的「数据导入」会把存档包里的
// game-config.json 写回磁盘并立刻生效（见 board-transfer.ts 的 applyImport）。
// 所以别把 rows / cols 缓存成常量 —— 用 getTotalSquares() / publicConfig() 取当前值。
//
// 本模块是全项目**第一个碰配置**的地方（server.ts 经由 board-state 间接导入它），
// 所以「文件不在就写一份默认的」和「PORT 环境变量压过配置里的 port」都放在这里，
// 这样其它模块 import 到的 liveConfig 一开始就已经是生效值。
//
// 配置文件在 **data/config/game-config.json**（不是仓库根目录那份）：整个 data/ 是
// 目录挂载，配置文件本身不是挂载点，写盘可以直接 .tmp + rename 原子替换。
// 以前把单个 game-config.json 挂进容器时，Linux 不允许 rename 覆盖挂载点（EBUSY），
// 导入存档会直接失败（见 board-persist.ts 的 writeFileAtomic）。
// 仓库根目录那份改名为 game-config.example.json，只当**首次启动的种子**，见 ensureConfigFile()。

import fs from 'fs';
import path from 'path';
// type-only import：只借它的类型，编译后不留 require（见下面的 loadConfig）
import type configShape from '../game-config.example.json';

/** 仓库根目录（ts-node 跑 src/ 与编译后跑 dist/ 都是一级） */
const ROOT_DIR = path.join(__dirname, '..');
/** 运行时数据目录：存档、存档尺寸、配置都在里面，Docker 只挂这一个目录 */
const DATA_DIR = path.join(ROOT_DIR, 'data');
/** 配置文件目录 */
const CONFIG_DIR = path.join(DATA_DIR, 'config');
/** 真正生效的配置文件 */
const CONFIG_FILE = path.join(CONFIG_DIR, 'game-config.json');
/** 仓库 / 镜像里那份示例配置：只当首次启动的种子（进版本库，也是 tsc 要的类型来源） */
const SEED_CONFIG_FILE = path.join(ROOT_DIR, 'game-config.example.json');

/** 生效配置文件（`data/config/game-config.json`）的绝对路径。写盘 / 导出都以它为准。 */
export const CONFIG_FILE_PATH = CONFIG_FILE;

/** game-config.json 的形状：服务端专用字段（devPassword）也在里面 */
export interface GameConfig {
  rows: number;
  cols: number;
  cellSize: number;
  port: number;
  devPassword?: string;
  devSessionHours?: number;
  [key: string]: unknown;
}

/**
 * 这个字段被环境变量钉住了，导入存档包时不能改（见 board-transfer.ts）。
 * 目前只有 PORT：容器里端口由部署方给定，不能让一个来源不明的备份把服务改到别的端口上。
 */
export interface LockedConfigFields {
  /** PORT 环境变量给了合法端口，配置里的 port 一律忽略 */
  port: boolean;
}

/** 缺配置文件时写出来的那份默认配置。别在这里放 devPassword */
const DEFAULT_CONFIG: GameConfig = {
  rows: 100,
  cols: 200,
  cellSize: 25,
  port: 3000,
  devPassword: '',
  devSessionHours: 8
};

/**
 * 没有 `data/config/game-config.json` 就生成一份：优先从仓库 / 镜像里那份示例种子
 * （`game-config.example.json`）拷过来 —— 老部署升级上来不会丢 `rows` / `cols` / `devPassword`；
 * 种子也不在了才写 `DEFAULT_CONFIG`。种子本身留在原地（进版本库，也是 tsc 需要的类型来源），
 * 之后不再参与运行：**改了它不会生效，要改就改 `data/config/game-config.json`**。
 * 写不进去不是致命的：随后的 loadConfig 会给出自己的报错。已经存在就一个字节都不动。
 */
function ensureConfigFile(): void {
  if (fs.existsSync(CONFIG_FILE)) return;

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });

    if (fs.existsSync(SEED_CONFIG_FILE)) {
      fs.copyFileSync(SEED_CONFIG_FILE, CONFIG_FILE);
      console.log(`First run: copied ${SEED_CONFIG_FILE} to ${CONFIG_FILE}`);
      return;
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
    console.log(`${CONFIG_FILE} was missing — wrote the default config`);
  } catch (error) {
    console.error(
      `Cannot create ${CONFIG_FILE}: ${(error as Error).message}` +
      ' / 无法生成配置文件'
    );
  }
}

ensureConfigFile();

/**
 * 读配置文件。
 * 这里**刻意不用** `import rawConfig from '../game-config.example.json'`：那是静态 require，
 * 会在本模块（以及 ensureConfigFile）跑起来之前就执行，文件不存在时直接
 * `MODULE_NOT_FOUND` 崩掉 —— 写默认配置那一步就没机会跑了。
 * 类型仍然取自那份 JSON（`import type` 编译后不留东西）。
 */
function loadConfig(): typeof configShape {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as typeof configShape;
  } catch (error) {
    throw new Error(
      `Cannot read ${CONFIG_FILE} (${(error as Error).message}) / 读不到配置文件：` +
      '确认它存在且是合法 JSON（删掉它重启，服务会从 game-config.example.json 种子重新生成一份）'
    );
  }
}

/** 当前生效的配置（含 devPassword，**不要**整个下发） */
export let liveConfig = loadConfig() as GameConfig;

/** 配置里写的端口（PORT 环境变量没给或给得不合法时用）*/
function configPort(): number {
  const value = Number(liveConfig.port);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : 3000;
}

/**
 * 实际监听的端口：PORT 环境变量优先，其次 game-config.json 的 port。
 * 给得不合法（不是 1..65535 的整数）就退回配置文件的值并打一条警告 ——
 * 错的是配置，不该让服务起不来。
 */
function resolvePort(): { port: number; source: 'env' | 'config'; invalidEnv?: string } {
  const fromEnv = typeof process.env.PORT === 'string' ? process.env.PORT.trim() : '';

  if (fromEnv.length > 0) {
    const value = Number(fromEnv);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      return { port: value, source: 'env' };
    }

    return { port: configPort(), source: 'config', invalidEnv: fromEnv };
  }

  return { port: configPort(), source: 'config' };
}

const resolvedPort = resolvePort();

if (resolvedPort.invalidEnv !== undefined) {
  console.warn(
    `PORT="${resolvedPort.invalidEnv}" is not a valid port (1..65535): ` +
    `falling back to game-config.json (${resolvedPort.port})`
  );
}

/** 启动日志用：端口是从哪儿来的（env = PORT 环境变量，config = game-config.json） */
export const portSource: 'env' | 'config' = resolvedPort.source;

/** 环境变量钉住的字段：导入存档包时由 board-transfer.ts 保留服务器当前值 */
export const lockedConfigFields: LockedConfigFields = { port: resolvedPort.source === 'env' };

/** 当前棋盘总格数 */
export function getTotalSquares(): number {
  return liveConfig.rows * liveConfig.cols;
}

/** 剥掉敏感字段后的配置：**不含 devPassword**，可以安全下发 */
function withoutSecrets(config: GameConfig): Omit<GameConfig, 'devPassword'> {
  const { devPassword: _devPassword, ...safe } = config;
  return safe;
}

// 每次导入新配置都会重新算一次；init-game 在热路径上，所以这里缓存住
let clientConfig = withoutSecrets(liveConfig);

/** 可以下发给客户端的配置：**不含 devPassword 等敏感字段** */
export function publicConfig(): Omit<GameConfig, 'devPassword'> {
  return clientConfig;
}

/**
 * 换一份生效的配置（数据导入用）。
 * 除了列出来的 preserve 字段，整份配置都会被替换 —— 这样导入包里的
 * cellSize / port / devSessionHours 等改动都会在磁盘与内存里同时生效。
 */
export function setLiveConfig(next: GameConfig, preserve: string[] = []): void {
  const merged = { ...next };

  for (const key of preserve) {
    const current = (liveConfig as Record<string, unknown>)[key];
    if (current === undefined) delete merged[key];
    else merged[key] = current;
  }

  liveConfig = merged;
  clientConfig = withoutSecrets(liveConfig);
}

// PORT 环境变量优先：读进来的那份可能写着别的端口（种子 + 首次启动生成的就是 3000），
// 这里覆盖掉，之后所有读 liveConfig.port 的地方都是对的值。
liveConfig.port = resolvedPort.port;
