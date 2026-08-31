# AGENTS.md

给 AI 编码助手的 Pigeon 项目速览。读完本文件即可定位代码，无需全仓库扫描。

## 项目是什么

Pigeon（鸽子）— 端到端加密即时通讯（IM）应用，monorepo：**Tauri 2 桌面客户端 + NestJS 12 服务端 + Rust 核心库**。当前已完成注册/登录（bcrypt + JWT）、Socket.IO 实时消息通道、本地 SQLite 聊天持久化、七牛云文件直传（后端签凭证 + 前端直传）；端到端加密尚未接入消息链路（加密 crate 已就绪）。

## Monorepo 布局

包管理：PNPM workspace（`apps/*`、`packages/*`）；Rust 用 Cargo workspace（`crates/*` + 桌面端 `src-tauri`）。

| 位置 | 内容 |
|------|------|
| `apps/desktop` | `@pigeon/desktop` — SvelteKit 2 + Svelte 5 + Tailwind 4 + shadcn-svelte 前端，Tauri 2 壳 |
| `apps/desktop/src/lib/api/` | `config.ts`（SERVER_URL，读 `VITE_PIGEON_SERVER_URL`，默认 `localhost:3048`）、`http.ts`（alova 实例 + `tokenStore`）、`auth.ts`、`users.ts`（用户资料 GET/PATCH /users/me）、`storage.ts`（取七牛上传凭证）、`profile.svelte.ts`（全局用户资料 runes 状态，登录页/设置页/侧边栏共用）、`socket.svelte.ts`（Socket.IO 单例管理器，Svelte 5 runes） |
| `apps/desktop/src/lib/upload/` | **七牛直传封装**：`qiniu.ts`（`uploadToQiniu()`：取票 → qiniu-js 直传 → 进度/取消）、`qiniu-js.d.ts`（qiniu-js@2.x 最小类型声明，SDK 本体不带 .d.ts） |
| `apps/desktop/src/routes/(app)/` | 登录后的页面：`contacts/`（通讯录）、`messages/`（消息）、`files/`（文件，七牛直传完整演示）、`settings/`（设置：头像直传七牛 + 昵称修改） |
| `apps/desktop/src-tauri/src/` | Rust 侧：`db.rs`（SQLite 连接 + `PRAGMA user_version` 嵌入式迁移 + WAL）、`commands.rs`（Tauri 命令薄封装）、`chat.rs`（SQL 逻辑，可单测）、`models.rs` |
| `apps/server` | `@pigeon/server` — NestJS 12，**SWC 编译**，ESM（`"type": "module"`） |
| `apps/server/src/auth/` | 注册/登录：`auth.controller.ts`（`POST /auth/register`、`POST /auth/login`）、`auth.service.ts`（bcryptjs cost 10 + JWT 签发）、`jwt-auth.guard.ts`（可复用 HTTP JWT 守卫，验证 `Authorization: Bearer` 后把 payload 挂到 `request.user`）、`dto.ts` |
| `apps/server/src/storage/` | **七牛直传取票**：`qiniu.service.ts`（HMAC-SHA1 签上传凭证、`DIR_LIMITS` 目录限制、`makeKey()` 生成 key）、`storage.controller.ts`（`POST /storage/upload-token`，JwtAuthGuard 保护）、`config.ts`（`QINIU_*` 环境变量解析，未配置时接口 503）、`qiniu.service.spec.ts`（签名算法单测） |
| `apps/server/src/users/` | 用户资料：`users.controller.ts`（`GET/PATCH /users/me`，JwtAuthGuard 保护）、`users.service.ts`（部分更新，空入参 400）、`user.mapper.ts`（`UserRow` → `PublicUser` 共享映射，auth 模块也复用）、`dto.ts`、`users.service.spec.ts` |
| `apps/server/src/ws/` | `events.gateway.ts` — Socket.IO 网关：JWT 握手验签、presence（userId→socketIds）、房间 `user:{userId}` / `conversation:{convId}`、事件 ack |
| `apps/server/src/prisma/` | `prisma.service.ts` + `contract.prisma`（目前只有 `User` 模型：email 唯一、bcrypt 哈希存 `password`、`nickname`） |
| `apps/server/src/config.ts` | `allowedOrigins()` — HTTP CORS 与 Socket.IO CORS 共用白名单，覆盖 Tauri 各平台 origin |
| `apps/server/src/main.ts` | 入口，`dotenv/config`，默认端口 **3048** |
| `packages/shared-types` | `@pigeon/shared-types` — 前后端共享类型：`User`、`Message`、`ApiResponse`、`MessageType`、上传契约（`UploadDir` / `UploadTokenInput` / `UploadTicket`），以及**类型化 Socket.IO 事件契约**（`ClientToServerEvents` / `ServerToClientEvents` / `WsAck<T>` / `SocketData`） |
| `crates/encryption` | AES-256-GCM 加解密 + SHA256（`cipher.rs`、`hash.rs`）— E2EE 基础库 |
| `crates/media-codec` | 编解码骨架（预留 FFmpeg 集成），基本是空壳 |

## 关键约定与陷阱（改代码前必读）

1. **服务端必须用 `.js` 后缀的相对导入**（`import { AuthModule } from './auth/auth.module.js'`）— ESM + Node 解析要求，写 `.ts` 会运行时报错。
2. **SWC/esbuild 不产出装饰器元数据**：服务端依赖注入一律显式 `@Inject(XxxService)`，WS 消息处理器用普通函数参数而非 `@MessageBody`（见 `events.gateway.ts` 顶部注释）。
3. **shared-types 是 type-only 包**：无 `main`/`exports`、无 JS 构建产物，两端只能 `import type`（编译期擦除）。**运行时 import 它的值会直接 `ERR_MODULE_NOT_FOUND`**；需要值形式的常量（如目录白名单）就在使用方模块内定义，并用编译期断言对齐类型（参考 `apps/server/src/storage/dto.ts` 的 `UPLOAD_DIRS` + `_ASSERT_ALL_DIRS_COVERED`）。契约变更仍先改 `packages/shared-types/index.ts`，两端同步。
4. **数据库 schema**：改 `apps/server/src/prisma/contract.prisma` 后运行 `pnpm --filter @pigeon/server db:update`。Prisma 8 RC 用的是 `db:sign`/`db:update`/`contract:emit` 等新命令，不是 `prisma migrate`。
5. **桌面端 SQLite schema 变更**：改 `src-tauri/src/db.rs` 中的迁移并在 `user_version` 上加新版本号（嵌入式迁移，启动时自动执行）。
6. **token 存储**：登录 token 走 `tokenStore`（sessionStorage 优先于 localStorage，"记住我"语义）；Socket.IO 握手每次重连都重新读 tokenStore，登录后需调 `ws.reconnect()`。
7. **环境变量**：服务端读 `apps/server/.env`（`DATABASE_URL` 必填、`PORT`、`CLIENT_ORIGINS`、`WS_STRICT_AUTH`）；桌面端构建时读 `VITE_PIGEON_SERVER_URL`（Tauri 生产包内联，改地址需重新构建）。
8. **测试**：服务端用 Vitest（`*.spec.ts` 与 e2e 分离配置）；Rust 侧逻辑放 `chat.rs` 便于单测，`commands.rs` 只做参数校验和错误转换。
9. **文件直传**：`key`/`token`/`publicUrl` 一律以服务端返回的 `UploadTicket` 为准，前端不自造 key、不自行拼 URL；`dir` 必须取 `@pigeon/shared-types` 的 `UploadDir` 白名单。详细用法见下节。
10. **七牛未配置时降级**：服务端缺 `QINIU_*` 环境变量时 `/storage/*` 统一返回 503（不崩溃），桌面端需按 `ApiError.message` 提示用户；不要在启动时强制校验七牛配置。

## 七牛云文件直传（前端上传文件标准用法）

架构：**后端签凭证、前端直传**，文件流不经过 NestJS。

```
前端                                服务端                            七牛云
 │ POST /storage/upload-token (JWT)   │                                │
 │ ─────────────────────────────────▶│ 按 dir 签受限凭证（scope 定向    │
 │ ◀──────────── UploadTicket ───────│ key + insertOnly + 限型限量）    │
 │                                                                    │
 │ qiniu.upload(file, key, token) ─────────────直传──────────────────▶│
 │ ◀──── returnBody(key/hash/fsize/mime/fname) ───────────────────────│
 │ 访问：ticket.publicUrl = QINIU_DOMAIN + key                          │
```

### 标准用法（`$lib/upload/qiniu.ts`，所有上传场景都走它）

```ts
import { uploadToQiniu, isUploadCanceled } from "$lib/upload/qiniu";

// 1. 开始上传（调用方无感知地自动取票：avatar 走 per-file 票，
//    chat/file 复用目录会话票；> 4MB 自动分片+断点续传）
const handle = uploadToQiniu(file, {
  dir: "chat",             // 'avatar' | 'chat' | 'file'
  fileName: file.name,     // 服务端/客户端用来推断扩展名
  onProgress: (p) => (percent = p.percent),   // 0 ~ 100
});

// 2. 完成后拿外链（存库 / 发消息用 url，不要自己拼域名）
const { url, key, hash, size, mime, fname } = await handle.done;

// 3. 取消（随时）；done 会 reject UploadCanceledError
handle.cancel();
```

`handle.done` 的三类 reject，处理方式不同：

| 错误类型 | 阶段 | 处理 |
|---------|------|------|
| `ApiError` | 取票 | 401 未登录 / 503 服务端未配置 `QINIU_*` → 正常弹 toast，`message` 已可读 |
| `QiniuUploadError` | 直传 | 携带七牛错误码 `code`（如 614 文件已存在、413 大小超限）；会话票 401 已内置「刷新 token + 同 key 重试」，重试仍 401 才会抛出 → 弹 toast |
| `UploadCanceledError` | 取消 | 用户主动取消 → **静默**，用 `isUploadCanceled(err)` 判断 |

完整 UI 参考（队列/进度条/取消/重试/复制外链）：`apps/desktop/src/routes/(app)/files/+page.svelte`。

### 硬性规则（违反必错）

1. **两种取票路径，key 来源不同**：
   - `avatar`：per-file 票（`POST /storage/upload-token`，scope 定向到服务端生成的 key）——key/token/publicUrl 一律以服务端返回为准，前端不可自改，否则报 `key doesn't match with scope`（403）；
   - `chat` / `file`：目录会话票（`GET /storage/session-token?dir=…`，scope=bucket + insertOnly，有效期内可复用）——key 由客户端按 `{dir}/{年月}/{uuid}.{净化ext}` 生成，**前缀必须用目录名**（chat 前缀配合七牛生命周期规则自动清理）。
2. **URL 用返回的 `url`**（= `QINIU_DOMAIN + key`），不要在前端拼域名，域名只在服务端配置。
3. **`dir` 只能取白名单**（`UploadDir`，服务端 `DIR_LIMITS` 对应限制）：
   - `avatar` — 头像：仅 `image/jpeg;image/png;image/webp;image/gif`，≤ 5 MB（per-file 票在七牛侧强校验）
   - `chat` — 聊天媒体：不限类型，≤ 100 MB（会话票 fsizeLimit 七牛侧强校验）
   - `file` — 普通文件：不限类型，≤ 200 MB
4. **会话票刷新时机**：剩余 < 10 分钟时在**开始上传前**懒刷新（`$lib/upload/session.ts`）；上传中不换 token（七牛逐分片验签，中途过期会断流），万一 401 由封装内部刷新重试，调用方无感知。
5. **重试 = 重新调 `uploadToQiniu`**：会生成新 key（insertOnly 下不会撞 614）；凭证过期同理（会话票自动续，per-file 票重取）。
6. **改接口先改契约**：入参/响应变更先改 `packages/shared-types` 的 `UploadTokenInput` / `UploadTicket` / `UploadSessionTicket`，两端同步（与 WS 事件同规则）。

### 服务端侧（改限制/路径/接入新目录时看这里）

- 环境变量（`apps/server/.env`，`.env.example` 有注释）：`QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET / QINIU_DOMAIN / QINIU_REGION / QINIU_TOKEN_TTL`。
- `QINIU_REGION` 必须与空间实际区域一致（z0 华东 / z1 华北 / z2 华南 / na0 北美 / as0 东南亚），否则上传慢或失败；前端会把它映射到 `qiniu.region.*`。
- 存储路径 `pigeon/{dir}/{年月}/{uuid}.{净化后的ext}`（防覆盖、防路径穿越），目录限制在 `qiniu.service.ts` 的 `DIR_LIMITS`。
- 取票接口被 `JwtAuthGuard` 保护；其它需要登录的接口可直接复用 `@UseGuards(JwtAuthGuard)`。
- 签名算法（官方「上传凭证」规范）：`urlsafe_b64(json(putPolicy))` → `HMAC-SHA1(., SecretKey)` → `AK:sign:policy`；实现/单测在 `qiniu.service.ts` / `qiniu.service.spec.ts`。
- **urlsafe base64 保留 `=` padding**（仅替换 `+`→`-`、`/`→`_`，与官方 Go/Python/Java SDK 一致）；剥掉 padding 会让七牛侧解码失败，直传报 401 `{"error":"bad token","error_code":"BadToken"}`。
- **insertOnly 实测语义**（2026-08 用真实空间验证）：同 key 上传**不同内容** → 614 `file exists`；同内容幂等返回 200。会话票靠它防覆盖。
- **前缀 scope（`bucket:prefix`）在表单直传 API 上不可用**（实测一律 403 `key doesn't match with scope`），所以会话票用 scope=bucket + 客户端 key 目录前缀约定，路径收敛靠约定 + insertOnly 防覆盖，token 只存前端内存且 ≤ 1h。
- **生命周期规则**（七牛控制台已配置）：规则 `chat`、前缀 `chat` —— chat 目录 key 必须以 `chat/` 开头才会被自动清理；消息里的外链会随生命周期失效（聊天媒体的预期行为）。

## 常用命令

```bash
pnpm dev                                        # concurrently 同时启动桌面端 + 服务端
pnpm dev:desktop / pnpm dev:server              # 分开启动（Vite @1420 / Nest @3048）
pnpm --filter @pigeon/desktop check             # svelte-check 类型检查
pnpm --filter @pigeon/server lint               # oxlint
pnpm --filter @pigeon/server test               # Vitest 单测
pnpm --filter @pigeon/server test:e2e           # e2e
pnpm --filter @pigeon/server db:update          # 应用 Prisma schema
pnpm --filter @pigeon/server db:smoke           # 数据库连接冒烟
cargo check                                     # Rust workspace 全量检查
cargo check -p encryption / -p media-codec      # 单个 crate
cargo build --release -p pigeon-desktop-tauri   # 桌面 Rust 后端
pnpm --filter @pigeon/desktop tauri build       # 打包桌面安装包
pnpm check:types                                # 桌面类型检查 + 服务端构建
```

环境要求：Node ≥ 18、PNPM ≥ 8、Rust stable ≥ 1.75、PostgreSQL ≥ 15。

## 数据流一览

```
桌面 UI (Svelte 5)
 ├─ HTTP：alova → Nest REST（/auth/register、/auth/login、/storage/upload-token）
 ├─ 实时：socket.io-client → Socket.IO 网关（JWT 握手验签，房间广播 + ack）
 │      └─ 事件类型来自 @pigeon/shared-types（编译期约束两端）
 └─ 文件：取票（alova，JWT）→ qiniu-js 直传七牛 → publicUrl（不经过 NestJS）
Rust 侧（Tauri invoke）：
 ├─ SQLite（%APPDATA%/com.zhang.pigeon/pigeon.db）本地聊天记录
 └─ encryption crate（AES-256-GCM）— 待接入消息链路
服务端存储：Prisma 8 → PostgreSQL（目前 User 表）；对象存储：七牛云 Kodo
```

## 当前进度

- ✅ 注册/登录（bcrypt + JWT）、桌面端登录页
- ✅ Socket.IO 通道：房间、presence、JWT 握手鉴权、类型化事件 + ack
- ✅ 桌面端本地 SQLite 持久化（WAL + 版本化迁移）
- ✅ 七牛云文件直传（后端签凭证 + qiniu-js 直传，「文件」页 /files 落地）
- ✅ 设置页：头像直传七牛（dir avatar）+ 昵称修改（PATCH /users/me），User 表新增 avatarUrl
- ✅ 通讯录、消息界面（shadcn-svelte 组件）
- 🚧 E2EE 接入消息链路（密钥交换协议）
- ⬜ 好友关系、服务端消息历史、离线同步、已读回执、多媒体消息、群聊、消息撤回/搜索、多设备漫游
