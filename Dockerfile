# 内部端口固定 3000：PORT 优先级高于 game-config.json 的 port（见 src/board-config.ts）。
# game-config.json 会被 compose 绑定挂载，镜像里那份只是没有 compose 时的兜底。

FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY game-config.json ./

RUN pnpm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apk --no-cache add ca-certificates tzdata \
 && mkdir -p /app/data \
 && chown -R node:node /app

COPY --from=builder --chown=node:node /app/dist ./dist
# public 不在 dist 里（没有打包步骤）
COPY --chown=node:node public ./public
COPY --chown=node:node game-config.json ./game-config.json
COPY --chown=node:node game-config.json.example ./game-config.json.example
COPY --chown=node:node package.json pnpm-lock.yaml ./

RUN corepack enable \
 && pnpm install --prod --frozen-lockfile \
 && pnpm store prune

# 直接以非 root 运行：挂进来的 ./data 要归 uid 1000（compose 里注释、README 有一行修法）
USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]
