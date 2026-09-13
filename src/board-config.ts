// 棋盘配置与「能发给客户端的配置」。
// 单独一个模块是为了让 devPassword 只有一个出口，不会跟着 config 漏给客户端。

import rawConfig from '../game-config.json';

/** game-config.json 的完整内容（含服务端专用字段） */
export const gameConfig = rawConfig;

export const TOTAL_SQUARES = gameConfig.rows * gameConfig.cols;

function withoutSecrets(config: typeof gameConfig) {
  const { devPassword: _devPassword, ...safe } = config;
  return safe;
}

// 只算一次：init-game 每次连接都要用，别在热路径上做解构
const clientConfig = withoutSecrets(gameConfig);

/** 可以下发给客户端的配置：**不含 devPassword 等敏感字段** */
export function publicConfig(): typeof clientConfig {
  return clientConfig;
}
