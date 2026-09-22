FROM node:22-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY game-config.example.json ./

RUN pnpm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apk --no-cache add ca-certificates tzdata \
 && mkdir -p /app/data \
 && chown -R node:node /app

COPY --from=builder /app/dist ./dist
# public 不在 dist 里（没有打包步骤）
COPY public ./public
# 首次启动的配置种子（同时也是 tsc 需要的类型来源）；之后以 data/config/game-config.json 为准
COPY game-config.example.json ./game-config.example.json
COPY package.json pnpm-lock.yaml ./

RUN corepack enable \
 && pnpm install --prod --frozen-lockfile \
 && pnpm store prune

EXPOSE 3000

CMD ["node", "dist/server.js"]
