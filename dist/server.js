"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
const koa_1 = __importDefault(require("koa"));
const koa_static_1 = __importDefault(require("koa-static"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const path_1 = __importDefault(require("path"));
// 1. 引入配置文件
const game_config_json_1 = __importDefault(require("../game-config.json"));
const app = new koa_1.default();
const PORT = game_config_json_1.default.port;
app.use((0, koa_static_1.default)(path_1.default.join(__dirname, '../public')));
const httpServer = (0, http_1.createServer)(app.callback());
const io = new socket_io_1.Server(httpServer);
// 2. 根据配置计算总数
const TOTAL_SQUARES = game_config_json_1.default.rows * game_config_json_1.default.cols;
const gridState = new Array(TOTAL_SQUARES).fill(true);
io.on('connection', (socket) => {
    // 3. 将“配置”和“状态”打包一起发送给新用户
    // 这样前端才知道要画多少行、多少列
    socket.emit('init-game', {
        config: game_config_json_1.default,
        state: gridState
    });
    socket.on('toggle-square', (index) => {
        if (typeof index === 'number' && index >= 0 && index < TOTAL_SQUARES) {
            gridState[index] = !gridState[index];
            io.emit('update-square', {
                index: index,
                isBlack: gridState[index]
            });
        }
    });
});
httpServer.listen(PORT, () => {
    console.log(`BlockGame 运行在 http://localhost:${PORT}`);
    console.log(`当前网格: ${game_config_json_1.default.cols} x ${game_config_json_1.default.rows} (共 ${TOTAL_SQUARES} 个方块)`);
});
