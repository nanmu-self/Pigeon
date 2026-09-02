# 服务端部署（ubuntu.n-m.ltd · 1Panel + GitHub Actions 构建镜像）

```
git push main
  ├─ CI  (ci.yml)        lint → 单测+e2e（内置 PG）→ 构建验证
  └─ CD  (deploy.yml)
       ├─ build-push job（GitHub 机器上）：docker build 两个镜像 → 推 GHCR
       │    ghcr.io/nanmu-self/pigeon-server:<sha>        运行镜像
       │    ghcr.io/nanmu-self/pigeon-server:build-<sha>  迁移镜像（含 prisma CLI）
       └─ deploy job：SSH 到 VPS → git checkout → docker compose pull
            → 迁移容器跑 db:update → up -d server → /health 健康检查
```

- **VPS 不做任何构建**：pnpm install / nest build 的内存大户在 GitHub 机器上（7GB 内存），2G 服务器只剩「拉镜像 + 跑容器」
- 应用容器加入 1Panel 应用网络，直连 Postgres 容器（不走公网端口，DB 往返 <1ms）
- 桌面端前端本地打包，`VITE_PIGEON_SERVER_URL` 指向线上即可

## 一次性准备（VPS）

### 1. 确认两个名字

```bash
docker network ls     # 1Panel 应用网络，通常叫 1panel-network（compose 里已按此命名）
docker ps             # Postgres 容器名，形如 1Panel-postgresql-xxxx
```

### 2. 数据库里建库建用户

1Panel「数据库」→ PostgreSQL → 创建数据库 `pigeon` + 用户。

### 3. 生产环境变量 `/opt/pigeon/shared/env`（chmod 600）

```ini
NODE_ENV=production
PORT=3048
# 主机名 = Postgres 容器名（同一 docker 网络，不是 localhost！）
DATABASE_URL=postgresql://pigeon:<密码>@1Panel-postgresql-xxxx:5432/pigeon
JWT_SECRET=<强随机值>
CLIENT_ORIGINS=http://localhost:1420,tauri://localhost,http://tauri.localhost,https://tauri.localhost
QINIU_ACCESS_KEY=...
QINIU_SECRET_KEY=...
QINIU_BUCKET=pigeon-chat
QINIU_DOMAIN=http://pigeon.n-m.ltd
QINIU_REGION=z2
QINIU_TOKEN_TTL=3600
DO_NOT_TRACK=1
```

### 4. 拉代码（compose 文件在仓库里）

私有仓库 → GitHub 加 **Deploy Key**（只读），私钥放 VPS：

```bash
sudo useradd -m -s /bin/bash pigeon && sudo usermod -aG docker pigeon
sudo mkdir -p /opt/pigeon && sudo chown -R pigeon:pigeon /opt/pigeon
sudo -u pigeon ssh-keygen -t ed25519 -f /home/pigeon/.ssh/id_ed25519 -N ""
# 公钥加到 GitHub 仓库 Deploy keys 后：
sudo -u pigeon git clone git@github.com:nanmu-self/Pigeon.git /opt/pigeon/repo
```

### 5. GHCR 登录（拉私有镜像用，一次性）

GitHub → Settings → Developer settings → **Personal access tokens**（勾 `read:packages`）→ 在 VPS 上（以部署用户身份）：

```bash
sudo -u pigeon sh -c 'echo <PAT> | docker login ghcr.io -u nanmu-self --password-stdin'
```

> PAT 过期后部署会在 pull 步骤报 `unauthorized`，重新生成并再执行一次即可。

### 6. GitHub Secrets（仓库 Settings → Secrets and variables → Actions）

| Secret | 值 |
|---|---|
| `PIGEON_SSH_HOST` | `ubuntu.n-m.ltd` |
| `PIGEON_SSH_USER` | `pigeon`（deploy key 在这个用户家目录，git 拉取靠它） |
| `PIGEON_SSH_KEY` | 该用户可登录 VPS 的 SSH 私钥（与上面 deploy key 是两把不同的钥匙） |

### 7. 1Panel 建反代站点 + 证书

「网站」→ 创建网站 → **反向代理**：

- 域名：`pigeon-api.n-m.ltd`（⚠️ `pigeon.n-m.ltd` 是七牛 Bucket 域名，别用）
- 代理地址：`http://127.0.0.1:3048`
- HTTPS 页签申请 Let's Encrypt 证书并强制 HTTPS
- 反代配置确认带 WebSocket 头（1Panel 模板默认有）

## 桌面端连线上服务

```bash
VITE_PIGEON_SERVER_URL=https://pigeon-api.n-m.ltd pnpm --filter @pigeon/desktop tauri build
```

`https` 自动走 `wss`；Tauri 生产 origin 已在服务端默认 CORS 白名单。

## 日常操作

```bash
docker compose -f deploy/docker-compose.yml ps      # 状态
docker logs -f pigeon-server                        # 日志

# 回滚（仅应用代码；数据库迁移不支持自动回退）：
IMAGE_TAG=<旧sha> docker compose -f deploy/docker-compose.yml up -d server

# 或在 GitHub Actions 里对旧 commit 手动触发 Deploy（workflow_dispatch）
```

## GHCR 镜像清理

每次部署会推 `build-<sha>` 迁移镜像，旧版本会积累。偶尔去 GitHub → 仓库 → Packages →
pigeon-server → 删掉旧版本，或仓库设置里开启自动清理即可。

## 安全提醒

Postgres 的 5432 目前映射到了公网（开发机直连用的）。后端上线、桌面端不再直连数据库后，
在 1Panel 里取消 5432 的端口映射/防火墙放行。开发机本地调试用 SSH 隧道：

```bash
ssh -L 5432:1Panel-postgresql-xxxx:5432 <user>@ubuntu.n-m.ltd
```
