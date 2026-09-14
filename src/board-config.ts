// 棋盘配置与「能发给客户端的配置」。
// 单独一个模块是为了让 devPassword 只有一个出口，不会跟着 config 漏给客户端。
//
// 注意这里是**运行期可变**的：设置弹窗里的「数据导入」会把存档包里的
// game-config.json 写回磁盘并立刻生效（见 board-transfer.ts 的 applyImport）。
// 所以别把 rows / cols 缓存成常量 —— 用 getTotalSquares() / publicConfig() 取当前值。

import rawConfig from '../game-config.json';

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

/** 当前生效的配置（含 devPassword，**不要**整个下发） */
export let liveConfig = rawConfig as GameConfig;

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
