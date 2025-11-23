// src/server.ts
import Koa from 'koa';
import serve from 'koa-static';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import gameConfig from '../game-config.json';

const app = new Koa();
const PORT = gameConfig.port;

app.use(serve(path.join(__dirname, '../public')));

const httpServer = createServer(app.callback());
const io = new Server(httpServer);

// Load game config
const TOTAL_SQUARES = gameConfig.rows * gameConfig.cols;
const gridState: boolean[] = new Array(TOTAL_SQUARES).fill(true);
let onlineUsers = 0;

io.on('connection', (socket: Socket) => {
    // Increase the number of online users and broadcast
    onlineUsers++;
    io.emit('online-users', onlineUsers);
    
    // Bundle the “configuration” and “state” together when sending to new users,
    // so the frontend knows how many rows and columns to render
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
    
    // Reduce the number of online users when users disconnect
    socket.on('disconnect', () => {
        onlineUsers--;
        io.emit('online-users', onlineUsers);
    });
});

httpServer.listen(PORT, () => {
    console.log(`BlockBoard run on http://localhost:${PORT}`);
    console.log(`Current grid: ${gameConfig.cols} x ${gameConfig.rows} (Total ${TOTAL_SQUARES} squares)`);
});