# 服务端部署（ubuntu.n-m.ltd · 1Panel + GitHub Actions 构建镜像）

```
git push main
  ├─ CI  (ci.yml)        lint → 单测+e2e（内置 PG）→ 构建验证 → Rust 传输网关测试
  └─ CD  (deploy.yml)
       ├─ build-push job（GitHub 机器上）：docker build 两个镜像 → 推 GHCR
       │    ghcr.io/nanmu-self/pigeon-server:<sha>        运行镜像
       │    ghcr.io/nanmu-self/pigeon-server:build-<sha>  迁移镜像（含 prisma CLI）
       └─ deploy job：SSH 到 VPS → git checkout → docker compose pull
            → 迁移容器跑 db:update → up -d server → /health 健康检查
  └─ CD  (deploy-transport.yml，paths 过滤 transport/**)：
       └─ 构建 pigeon-transport 镜像 → up -d transport → selfcheck 健康检查
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
# ── 实时传输（Rust WebTransport 网关；不启用则无需以下配置）──
# RT_TRANSPORT=wt
# WT_PUBLIC_URL=https://ubuntu.n-m.ltd:4433/wt
# TRANSPORT_INTERNAL_URL=http://pigeon-transport:3901
# WT_INTERNAL_TOKEN=<长随机值，与 Rust 共享；两个服务必须一致>
# 内部端点来源网段白名单（1panel-network 的 subnet，docker network inspect 查）
# INTERNAL_ALLOWED_CIDRS=172.16.0.0/12
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

### 5. GHCR 镜像包设为 Public（VPS 走 NJU 镜像源拉取的前提）

VPS 拉`镜像走 ghcr.nju.edu.cn（匿名公共缓存，国内直连快），只能代理**公开**镜像：

GitHub → 仓库右侧 Packages → pigeon-server → Package settings → Change visibility → Public

> 评估：镜像内只有编译产物与依赖，无任何凭据（配置全部运行时注入）。
> 若不想公开包：改回 ghcr.io 前缀，改用 dockerd 代理拉取（见对话记录），且无需本步骤。
> 设置后无需 docker login / PAT —— 匿名拉取。
> 小坑：镜像源是回源缓存，推送新镜像后立刻拉可能报 manifest unknown，等几分钟重试。

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

## Rust 传输网关（WebTransport，RT_TRANSPORT=wt 时启用）

### 上线 checklist（按顺序）

1. **环境变量**：`/opt/pigeon/shared/env` 增加上述 RT_* / WT_* 变量；
   `JWT_SECRET` 必填（Rust 验签依赖，Nest 与 Rust 共用同一份 env）。
2. **UDP 4433 放行**：云安全组/防火墙放行 `0.0.0.0:4433/udp`（OpenResty 反代不透传 QUIC/UDP，
   必须直连容器）；确认 1Panel 防火墙也放行。
3. **`/internal/` 公网防护（上线前必须验证）**：OpenResty 站点配置显式 deny：

   ```nginx
   location ^~ /internal/ { deny all; return 404; }
   location ^~ /internal/rt/ { deny all; return 404; }
   location ^~ /internal/presence/ { deny all; return 404; }
   ```

   验证（在任意外网机器）：`curl -i https://pigeon-api.n-m.ltd/internal/rt/message:send`
   → 404/403；同时应用层有 x-internal-token + IP 网段校验双层防线。
4. **首次启动**：`docker compose -f deploy/docker-compose.yml up -d transport`；
   `docker logs pigeon-transport` 确认 cert SHA-256 打印、internal HTTP 就绪。
5. **回退开关演练**：`RT_TRANSPORT=socket` 重启 server → 客户端 `/transport/config`
   下发 socket → 全量回到 Socket.IO 路径（无需发版）；再改回 `wt` 恢复。
6. **transport 容器故障演练**：`docker stop pigeon-transport` → `/transport/config`
   代理超时自动降级返回 socket → 老客户端继续走 Socket.IO。

### 运维要点

- **不可 scale**：连接注册表在 Rust 进程内存，多副本 = 一半用户收不到推送（D8）。
- **证书**：自签 14 天有效、7 天轮换热替换，`/internal/cert` 轮换窗口期新旧指纹并存；
  监控 `rt_cert_valid_seconds`（< 3 天告警）。
- **优雅关闭**：SIGTERM → 广播 going_away → ≤3s 退出；compose `stop_grace_period: 10s`。
- **健康检查**：`transport-server --selfcheck`（打自身 /healthz，slim 镜像无 curl/node）。
- **指标**：`GET :3901/metrics`（容器网内）：rt_connections_active / rt_hello_* /
  rt_push_dropped_total（>0 告警）/ rt_publish_* / rt_presence_* 等。

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
