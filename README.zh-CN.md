# BlockBoard

一个实时在线的方块画板

[English](./README.md) | **中文**

[演示站点](https://blockboard.motues.top)

![Index](./doc/images/index.png)

## 部署

```bash
git clone https://github.com/Motues/BlockBoard.git
cd BlockBoard
cp game-config.json.example game-config.json # 根据需求修改
pnpm install
pnpm build
pnpm start
```

然后打开 http://localhost:3000

（`game-config.json` 不存在时会自动照 `game-config.json.example` 生成一份，所以第一次也可以直接跳过 `cp` 那步。）

### Docker

```bash
git clone https://github.com/Motues/BlockBoard.git
cd BlockBoard
docker compose up -d
```

- 镜像地址：`ghcr.io/motues/blockboard:latest`。容器**内部端口固定 3000**，改不了（`PORT` 环境变量优先级高于配置文件）。
  换对外端口改 `docker-compose.yml` 里映射的左边，例如 `8080:3000`，然后访问 http://localhost:8080
- 配置就挂在当前目录：直接改 `./game-config.json`（棋盘尺寸 / `cellSize` / `devPassword`），
  改完 `docker compose restart` 生效。容器以非 root 的 uid 1000 运行，文件要让它读得到。
- 棋盘存档在容器的 `/app/data`，compose 已经映射到宿主机的 `./data`。别的都不用持久化。
  Linux 上容器以 uid 1000 运行，如果存档写不进去（日志里出现保存失败），执行一次：
  `sudo chown -R 1000:1000 ./data`。
- 开发者密码也可以用环境变量 `DEV_PASSWORD` 给（优先级高于配置里的 `devPassword`），见 compose 里的注释。

> `game-config.json` 是进版本库的（`docker compose` 依赖它存在）。改过的本地配置会一直显示为 modified，
> 别把自己的 `devPassword` 提交上去；想留一份自己的配置又不被跟踪，就放到 `game-config.local.json`（已在 `.gitignore` 里）。

## 配置

服务端配置写在 `game-config.json`（可参考 `game-config.json.example`）：

| 字段 | 说明 |
| --- | --- |
| `rows` / `cols` | 棋盘行数 / 列数 |
| `cellSize` | 每个方块的像素尺寸 |
| `port` | 服务端监听的端口。环境变量 `PORT` 优先级更高（Docker 部署就是用它把内部端口钉在 3000） |
| `devPassword` | 开发者工具的密码。留空则关闭；环境变量 `DEV_PASSWORD` 优先级更高 |
| `devSessionHours` | 开发者会话时长（小时，默认 8） |

## 界面

支持简体中文、繁體中文、English、日本語、한국어，首次按浏览器语言自动选择，
之后可以在设置弹窗里改（设置里还有开发者密码和数据备份）。

屏幕右下角有三个按钮：

| 按钮 | 作用 |
| --- | --- |
| **开发者工具** | 登录 / 打开开发者工具（见下文），移动端隐藏 |
| **设置** | 打开设置弹窗：语言 / 开发者密码 / 数据备份 |
| **菜单** | 画笔颜色 / 重置视图 / 保存为图片 / 显示帮助，移动端也能进设置 |

## 上色

- **左键**点方块上色，再点一次擦除。触屏是**轻点**。
- **右键短按**（触屏**长按**）呼出画笔圆环选颜色，圆心可以选任意 RGB 颜色，
  调色盘里还有**取色器**（吸取画布上已有的颜色）和**最近使用**。
- **右键拖动**平移棋盘，滚轮缩放；触屏是单指拖动、双指捏合。

> **Edge 用户注意**：Edge 自带的鼠标手势会抢走右键拖动，网页关不掉。首次在桌面版 Edge
> 打开时会弹出提示卡片，按上面的按钮去设置里关掉「启用鼠标手势」即可。

## 开发者工具

点底部**开发者工具**按钮，用开发者密码登录（浏览器里存过密码就自动登录，不用再输）。
开启后屏幕顶部会有一条提示条，上面有**退出**：

- **左键拖拽**框选一块矩形，**左键单击**则是选中该方块所在的闭合区域（此模式下不能正常上色）。
- **右键**打开菜单：填成画笔色、重置为黑、选自定义颜色、导出选区（PNG + JSON）、取消选区。
- **闭合区域填充**在浏览器里计算：碰到棋盘边缘就不算闭合，会拒绝操作而不是刷掉整块棋盘。

## 数据备份

设置弹窗里的**数据备份**可以把 `game-config.json` 与棋盘存档打包成**一个 `.bbx` 文件**下载，
导入时再传回去覆盖服务端的配置与存档（用的就是开发者密码，不用重复输入，但要先在设置里保存它）。

- **导出数据**：配置里不含开发者密码，文件可以放心转发。
- **导入存档**：先选文件，再点「导入存档」，第一下只是确认（会覆盖服务端数据）。
- 导入**立即生效**，备份里的棋盘尺寸和当前不同也能导入（按左上角对齐重排、在线客户端自动重同步），
  不用重启服务；文件损坏或内容对不上会被拒绝，服务端保持原样。

---

架构设计、状态格式、Socket 协议与 HTTP 接口等实现细节见 [AGENTS.md](./AGENTS.md)。
