# 构建上下文 = 仓库根目录（见 deploy/docker-compose.yml 的 build.context）
# 多阶段：build（全量依赖+源码，同时作为迁移任务容器）/ runtime（仅生产依赖+dist）

# ── 构建阶段 ─────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app
RUN npm i -g pnpm@11

# pnpm 调优：store 固定目录（配合下方 cache mount 持久化，lockfile 变了也不重下）；
# 低并发 + 多重试，对不稳定的 npm registry 更稳
ENV npm_config_store_dir=/pnpm/store \
    npm_config_registry=https://registry.npmmirror.com \
    npm_config_network_concurrency=4 \
    npm_config_fetch_retries=6 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=60000

# 先只拷清单文件 → 依赖层可缓存（源码变更不用重装依赖）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/server/package.json apps/server/
COPY packages/shared-types/package.json packages/shared-types/
# 只装后端（含其 workspace 依赖）的依赖：桌面端几百个包与本镜像无关
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @pigeon/server...

COPY apps/server apps/server
COPY packages packages
RUN pnpm --filter @pigeon/server build

# ── 运行阶段 ─────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    npm_config_store_dir=/pnpm/store \
    npm_config_registry=https://registry.npmmirror.com \
    npm_config_network_concurrency=4 \
    npm_config_fetch_retries=6 \
    npm_config_fetch_retry_mintimeout=10000 \
    npm_config_fetch_retry_maxtimeout=60000
RUN npm i -g pnpm@11

# pnpm workspace 装生产依赖需要全部成员的 package.json 在场
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/server/package.json apps/server/
COPY packages/shared-types/package.json packages/shared-types/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @pigeon/server...

COPY --from=build /app/apps/server/dist apps/server/dist

EXPOSE 3048
WORKDIR /app/apps/server
CMD ["node", "dist/main.js"]
