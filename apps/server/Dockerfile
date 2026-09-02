# 构建上下文 = 仓库根目录（见 deploy/docker-compose.yml）
# 多阶段：build（全量依赖+源码，作为迁移镜像发布）/ runtime（仅生产依赖+dist，运行镜像）
#
# 镜像由 GitHub Actions 构建并推送到 GHCR（见 .github/workflows/deploy.yml），
# VPS 不再本地构建 —— pnpm install / nest build 的内存大户不在服务器上。

# ── 构建阶段 ─────────────────────────────────────────────
FROM node:24-slim AS build
# npm 源可覆盖：默认官方源（构建在 GitHub Actions 上最快）；
# 若在 VPS 上手动构建，传 --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
RUN npm i -g pnpm@11

# pnpm 调优：store 固定目录（配合下方 cache mount）；低并发+多重试抗 registry 抖动
ENV npm_config_store_dir=/pnpm/store \
    npm_config_registry=${NPM_REGISTRY} \
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
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
ENV NODE_ENV=production \
    npm_config_store_dir=/pnpm/store \
    npm_config_registry=${NPM_REGISTRY} \
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
