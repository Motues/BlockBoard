// src/server.ts
import Koa from 'koa';
import serve from 'koa-static';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
// 1. 引入配置文件
import gameConfig from '../game-config.json';

const app = new Koa();
const PORT = gameConfig.port;

app.use(serve(path.join(__dirname, '../public')));

const httpServer = createServer(app.callback());
const io = new Server(httpServer);

// 2. 根据配置计算总数
const TOTAL_SQUARES = gameConfig.rows * gameConfig.cols;
const gridState: boolean[] = new Array(TOTAL_SQUARES).fill(true);

// 在线用户数
let onlineUsers = 0;

io.on('connection', (socket: Socket) => {
    // 增加在线用户数并广播
    onlineUsers++;
    io.emit('online-users', onlineUsers);
    
    // 3. 将"配置"和"状态"打包一起发送给新用户
    // 这样前端才知道要画多少行、多少列
    socket.emit('init-game', {
        config: gameConfig,
        state: gridState
    });

    socket.on('toggle-square', (index: number) => {
        if (typeof index === 'number' && index >= 0 && index < TOTAL_SQUARES) {
            gridState[index] = !gridState[index];
            io.emit('update-square', {
                index: index,
                isBlack: gridState[index]
            });
        }
    });
    
    // 当用户断开连接时减少在线人数
    socket.on('disconnect', () => {
        onlineUsers--;
        io.emit('online-users', onlineUsers);
    });
});

httpServer.listen(PORT, () => {
    console.log(`BlockGame 运行在 http://localhost:${PORT}`);
    console.log(`当前网格: ${gameConfig.cols} x ${gameConfig.rows} (共 ${TOTAL_SQUARES} 个方块)`);
});