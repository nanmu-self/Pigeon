# AGENTS.md

给 AI 编码助手的 Pigeon 项目速览。读完本文件即可定位代码，无需全仓库扫描。

## 项目是什么

Pigeon（鸽子）— 端到端加密即时通讯（IM）应用，monorepo：**Tauri 2 桌面客户端 + NestJS 12 服务端 + Rust 核心库**。当前已完成注册/登录（bcrypt + JWT）、WebTransport 实时消息通道（Rust 网关，Socket.IO 已删除）、本地 SQLite 聊天持久化、七牛云文件直传（后端签凭证 + 前端直传）、服务端好友关系 + 会话/消息落库 + 已读回执（含 e2e 覆盖）；端到端加密尚未接入消息链路（加密 crate 已就绪）。

## Monorepo 布局

包管理：PNPM workspace（`apps/*`、`packages/*`）；Rust 用 Cargo workspace（`crates/*` + 桌面端 `src-tauri`）。

| 位置 | 内容 |
|------|------|
| `apps/desktop` | `@pigeon/desktop` — SvelteKit 2 + Svelte 5 + Tailwind 4 + shadcn-svelte 前端，Tauri 2 壳 |
| `apps/desktop/src/lib/api/` | `config.ts`（SERVER_URL，读 `VITE_PIGEON_SERVER_URL`，默认 `localhost:3048`）、`http.ts`（alova 实例 + `tokenStore`）、`auth.ts`、`users.ts`（用户资料 + 搜索）、`sessions.ts`（会话/历史/已读/撤回 REST + `serverTimeToMs`）、`friends.ts`（好友列表/申请/拉黑/已拉黑列表）、`groups.ts`（建群/详情/邀请/踢出/转让/公告/禁言/退群）、`storage.ts`（取七牛上传凭证）、`profile.svelte.ts`（全局用户资料 runes 状态）、`socket.svelte.ts`（实时通道门面单例，WebTransport 唯一实现：连接/推送分发/seq 对账/延迟探测，公共 API 稳定） |
| `apps/desktop/src/lib/` | `chat.ts`（Tauri SQLite commands 封装 + 时间格式化）、`chat-store.svelte.ts`（聊天状态中枢：本地优先 → 服务端合并 → WS 已读/送达/新消息同步 → optimistic 发送）、`transport/`（**WebTransport 客户端**：`frame.ts` 帧编解码【u32 BE + JSON，累积缓冲状态机，有分片投喂单测】、`webtransport.ts` 连接状态机【hello/RPC/推送流 seq 对账/退避重连/连续 auth_failed 停机】⚠️ `serverCertificateHashes` 的 `algorithm` 必须小写 `'sha-256'`（Chromium 大小写敏感，大写 = 证书永远验证失败）、`config.ts` 取 `/transport/config`、`types.ts` 宿主接口） |
| `apps/desktop/src/lib/upload/` | **七牛直传封装**：`qiniu.ts`（`uploadToQiniu()`：取票 → qiniu-js 直传 → 进度/取消）、`qiniu-js.d.ts`（qiniu-js@2.x 最小类型声明，SDK 本体不带 .d.ts） |
| `apps/desktop/src/routes/(app)/` | 登录后的页面：`contacts/`（通讯录：好友列表/申请处理/搜索加好友/拉黑解除/发起群聊，WS 实时刷新）、`messages/`（消息：单聊+群聊，含群设置面板）、`files/`（文件，七牛直传完整演示）、`settings/`（设置：头像直传七牛 + 昵称修改） |
| `apps/desktop/src-tauri/src/` | Rust 侧：`db.rs`（SQLite + `PRAGMA user_version` 嵌入式迁移 v2 + WAL）、`commands.rs`（Tauri 命令薄封装）、`chat.rs`（SQL 逻辑，可单测：本地分页按 (created_at,id) 复合游标、服务端消息幂等合并、ack 回填、对端已读/送达水位物化）、`models.rs` |
| `apps/server` | `@pigeon/server` — NestJS 12，**SWC 编译**，ESM（`"type": "module"`） |
| `apps/server/src/transport/` | **实时传输层（WebTransport 唯一实时通道）**：`config.ts`（传输配置 fail-fast + 内部端点防线 `assertInternalAccess`/CIDR）、`transport-bridge.service.ts`（`WsEventsService` token 的唯一实现，HTTP 桥：`POST {TRANSPORT}/internal/publish`，`isOnline/onlineCount` 读 presence 镜像）、`presence-mirror.service.ts`（**presence 镜像**：Rust 权威 → epoch/seq delta + 30s 快照对账）、`internal-rt.controller.ts`（`POST /internal/rt/:type`：C2S 落地）、`internal-presence.controller.ts`（delta 落地 + 广播 + 断线清理通话）、`transport.controller.ts`（`GET /transport/config` 下发地址/指纹，Rust 不可达返回 503）、`transport-cert.service.ts`（指纹代理 ≤30s 缓存）、`proto-fixtures.spec.ts` |
| `apps/server/src/auth/` | 注册/登录：`auth.controller.ts`（`POST /auth/register`、`POST /auth/login`）、`auth.service.ts`（bcryptjs cost 10 + JWT 签发）、`jwt-auth.guard.ts`（可复用 HTTP JWT 守卫，验证 `Authorization: Bearer` 后把 payload 挂到 `request.user`）、`dto.ts` |
| `apps/server/src/storage/` | **七牛直传取票**：`qiniu.service.ts`（HMAC-SHA1 签上传凭证、`DIR_LIMITS` 目录限制、`makeKey()` 生成 key）、`storage.controller.ts`（`POST /storage/upload-token`，JwtAuthGuard 保护）、`config.ts`（`QINIU_*` 环境变量解析，未配置时接口 503）、`qiniu.service.spec.ts`（签名算法单测） |
| `apps/server/src/users/` | 用户资料与搜索：`users.controller.ts`（`GET/PATCH /users/me`、`GET /users/search?q=`，JwtAuthGuard 保护）、`users.service.ts`（部分更新空入参 400；搜索 = 邮箱精确 + 昵称内存过滤，扫描上限 `SEARCH_SCAN_LIMIT`，量大后换 raw ILIKE）、`user.mapper.ts`（`UserRow` → `PublicUser` 共享映射，auth/friends/sessions 也复用）、`dto.ts`、`users.service.spec.ts` |
| `apps/server/src/groups/` | 群聊：建群/邀请/踢出/转让/退群/公告/禁言/成员列表；角色矩阵见 `groups.service.ts` 顶部注释；成员变动落 system 消息 + `group:updated` 广播；`groups.e2e-spec.ts` 全流程覆盖 |
| `apps/server/src/friends/` | 好友关系（状态机见 `friends.service.ts` 顶部注释）：申请/通过/拒绝/删除/拉黑/解除拉黑；REST `GET /friends`（含在线状态）、`GET /friends/requests`、`POST /friends/requests`、`POST /friends/requests/:id/accept|decline`、`DELETE /friends/:userId`、`POST /friends/:userId/block|unblock`；`assertFriends()` 是发消息/建会话的共享闸门（SessionsService 复用） |
| `apps/server/src/sessions/` | 会话与消息：`sessions.service.ts`（好友间幂等建会话、发消息事务【消息 + 接收者回实行（含送达）+ 会话活跃指针】、keyset 游标历史分页 + 对端已读/送达水位、WS 推回执）、`sessions.controller.ts`（`GET/POST /sessions`、`GET /sessions/:id/messages?cursor&limit`、`POST /sessions/:id/read`）、`sessions.mapper.ts`（`pgTimestampToMs` 等，有单测）、`dto.ts` |
| `apps/server/src/ws/` | `ws-events.service.ts` — `WsEventsService` 抽象注入 token（业务侧唯一推送依赖面：`toUser/toUsers/broadcast/isOnline/onlineCount`）；`ws.module.ts` — @Global，把 token 绑定到 `TransportBridgeService`（e2e 用 `overrideProvider(WsEventsService)` 换 FakeTransportBridge） |
| `apps/server/src/prisma/` | `prisma.service.ts` + `contract.prisma`（模型：`User`、`Session` 会话【kind=direct/group；单聊 userAId<userBId 归一化复合唯一；群聊 name/公告/禁言，成员在 SessionMember】、`Message`【自增游标 + clientMsgId 幂等 + replyToId 引用 + mentions】、`Friendship` 状态机、`MessageStatus` 回实行【复合主键 + 送达/已读】、`MessageReaction` 表情回应【复合主键，幂等】、`SessionMember` 群成员【复合主键 + role/lastReadAt】） |
| `apps/server/src/config.ts` | `allowedOrigins()` — HTTP CORS 白名单，覆盖 Tauri 各平台 origin |
| `apps/server/src/main.ts` | 入口，`dotenv/config`，默认端口 **3048** |
| `packages/shared-types` | `@pigeon/shared-types` — 前后端共享类型：`User`、`Message`、`ApiResponse`、`MessageType`、上传契约（`UploadDir` / `UploadTokenInput` / `UploadTicket`）、**类型化实时事件契约**（`ClientToServerEvents` / `ServerToClientEvents` / `WsAck<T>` / `WsAckCallback`）与**实时传输契约**（`TransportConfig` / `RtRequest` / `RtResponse` / `RtPushFrame` / `RtHello` / `EventPayload<K>`），`fixtures/rt-*.json` 是 Nest↔Rust 协议夹具（两侧单测锁定） |
| `apps/transport-server` | **Rust 实时传输网关**（bin，跑在 VPS 与 Nest 并排；桌面端 Rust 零改动）：`proto.rs`（帧编解码 u32 BE + JSON 1MiB 上限 + 累积缓冲 + shared-types 夹具测）、`conn.rs`（hello 5s 超时 → JWT 验签 → RPC 转发/本地 health:ping + 推送写循环【背压→resync→close，禁静默丢帧】+ token 到期断开）、`registry.rs`（userId→连接，epoch/seq，**单实例约束 D8**）、`cert.rs`（rcgen 自签 ECDSA P-256 14 天 + SHA-256 指纹 + 7 天轮换热替换）、`forward.rs`（C2S → Nest `/internal/rt/:type`）、`presence.rs`（delta 推送）、`internal.rs`（axum：publish/snapshot/cert/healthz/metrics）、`main.rs`（ring provider + BBR + keepalive/idle 滥用防护参数）、`examples/spike.rs`（**手动 spike S1–S4 用**）、`tests/integration.rs`（回环 QUIC 集成测试） |
| `crates/encryption` | AES-256-GCM 加解密 + SHA256（`cipher.rs`、`hash.rs`）— E2EE 基础库 |
| `crates/media-codec` | 编解码骨架（预留 FFmpeg 集成），基本是空壳 |

## 关键约定与陷阱（改代码前必读）

1. **服务端必须用 `.js` 后缀的相对导入**（`import { AuthModule } from './auth/auth.module.js'`）— ESM + Node 解析要求，写 `.ts` 会运行时报错。
2. **SWC/esbuild 不产出装饰器元数据**：服务端依赖注入一律显式 `@Inject(XxxService)`，消息处理器用普通函数参数而非 `@MessageBody` 类参数装饰器。
3. **shared-types 是 type-only 包**：无 `main`/`exports`、无 JS 构建产物，两端只能 `import type`（编译期擦除）。**运行时 import 它的值会直接 `ERR_MODULE_NOT_FOUND`**；需要值形式的常量（如目录白名单）就在使用方模块内定义，并用编译期断言对齐类型（参考 `apps/server/src/storage/dto.ts` 的 `UPLOAD_DIRS` + `_ASSERT_ALL_DIRS_COVERED`）。契约变更仍先改 `packages/shared-types/index.ts`，两端同步。
4. **数据库 schema**：改 `apps/server/src/prisma/contract.prisma` 后运行 `pnpm --filter @pigeon/server contract:emit && pnpm --filter @pigeon/server db:update`。Prisma 8 RC 用的是 `db:sign`/`db:update`/`contract:emit` 等新命令，不是 `prisma migrate`；FK 行为变更等无法自动规划的改动走 `prisma migration new`（参考 `apps/server/migrations/app/`）。
5. **prisma-next ORM 客户端实测语义**（`db.orm.public.X`）：
   - `where` **只支持等值/精确值**（`{ readAt: null }` 判空可用）；`$lt/$in/$ilike` 等操作符对象会被当作字面量（静默错误）→ 范围/模糊查询目前用内存过滤或后续接 raw lane；
   - `orderBy` 用选择器：`.orderBy((m) => m.id.desc())`；keyset 分页用 `.cursor({ id: lastId })`（返回排序方向上位于游标之后的行）；
   - **`.delete()`/`.update()` 只作用于单行，多行用 `.deleteAll()`/`.updateAll()`**；
   - 事务：`this.prisma.client.transaction(async (tx) => { tx.orm... })`；
   - `Timestamptz` 类型对应 **Temporal.Instant**（拒绝字符串），项目统一用 `TimestamptzString`（ISO 字符串直写）；PG 读出的格式是 `2026-08-31 16:13:26.170714+00`，转毫秒用 `sessions.mapper.ts` 的 `pgTimestampToMs`；
   - 表名在 sql 通道是小写（`db.sql.public.user`），orm 通道用模型名（`db.orm.public.User`）。
6. **桌面端 SQLite schema 变更**：改 `src-tauri/src/db.rs` 中的迁移并在 `user_version` 上加新版本号（嵌入式迁移，启动时自动执行）。
7. **token 存储**：登录 token 走 `tokenStore`（sessionStorage 优先于 localStorage，"记住我"语义）；WT hello 握手每次重连都重新读 tokenStore，登录后需调 `ws.reconnect()`。
8. **环境变量**：服务端读 `apps/server/.env`（`DATABASE_URL` 必填、`PORT`、`CLIENT_ORIGINS`；实时传输 `JWT_SECRET`/`TRANSPORT_INTERNAL_URL`/`WT_PUBLIC_URL`/`WT_INTERNAL_TOKEN` 缺一启动失败）；桌面端构建时读 `VITE_PIGEON_SERVER_URL`（Tauri 生产包内联，改地址需重新构建）。
9. **测试**：服务端用 Vitest（`*.spec.ts` 与 e2e 分离配置）；Rust 侧逻辑放 `chat.rs` 便于单测，`commands.rs` 只做参数校验和错误转换。
10. **文件直传**：`key`/`token`/`publicUrl` 一律以服务端返回的 `UploadTicket` 为准，前端不自造 key、不自行拼 URL；`dir` 必须取 `@pigeon/shared-types` 的 `UploadDir` 白名单。详细用法见下节。
11. **七牛未配置时降级**：服务端缺 `QINIU_*` 环境变量时 `/storage/*` 统一返回 503（不崩溃），桌面端需按 `ApiError.message` 提示用户；不要在启动时强制校验七牛配置。
12. **实时传输（WebTransport 唯一通道，Socket.IO 已于 P4 删除）**：改事件/载荷先改 `packages/shared-types/index.ts` + `fixtures/rt-*.json`（Nest 与 Rust 两侧单测锁定，改一边必改另一边）。推 services 一律注入 `WsEventsService` token（= `TransportBridgeService`），**禁止绕过桥直接 fetch Rust**。群 fan-out 用 `toUsers()`（单次内部调用），别在业务层 for 循环调 `toUser`。
13. **presence 镜像**：权威状态在 Rust，Nest 只是镜像（epoch 变化 = Rust 重启 → 镜像重建；seq 单调去重；30s 快照对账）。`isOnline()` 是同步读镜像，`message:delivered` 判定依赖它 —— 不要把它改成远程查询，也不要在 Transport 不可达时清空镜像。
14. **`/internal/*` 暴露面**：`x-internal-token` fail-closed（未配置 = 全拒）+ `INTERNAL_ALLOWED_CIDRS` 网段校验；OpenResty 必须显式 deny `/internal/`（deploy/README checklist），上线前用外网 curl 验证。Rust 的 `:3901` **永不映射公网**。
15. **transport-server 单副本约束**：连接注册表在 Rust 进程内存，compose 不可 scale/replicas>1 —— 加副本 = 一半用户收不到推送（D8）。多副本前需 Redis pub/sub 或一致性哈希路由。
16. **双进程共享 JWT_SECRET**：Nest 强制要求显式 `JWT_SECRET`（否则随机生成 → 与 Rust 验签必不一致 → 全部 auth_failed），两侧同时 fail-fast。

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
pnpm dev                                        # concurrently 同时启动桌面端 + 服务端 + Rust 传输网关
pnpm dev:desktop / dev:server / dev:transport   # 分开启动（Vite @1420 / Nest @3048 / WebTransport @4433/udp + 3901）
pnpm --filter @pigeon/desktop check             # svelte-check 类型检查
pnpm --filter @pigeon/desktop test              # 桌面单测（帧编解码分片投喂等）
pnpm --filter @pigeon/server lint               # oxlint
pnpm --filter @pigeon/server test               # Vitest 单测
pnpm --filter @pigeon/server test:e2e           # e2e（传输无关：FakeTransportBridge + /internal/rt）
pnpm --filter @pigeon/server db:update          # 应用 Prisma schema
pnpm --filter @pigeon/server db:smoke           # 数据库连接冒烟
cargo test -p transport-server                  # Rust 传输网关：单测 + 回环 QUIC 集成测试
cargo check                                     # Rust workspace 全量检查
cargo check -p encryption / -p media-codec      # 单个 crate
cargo build --release -p pigeon-desktop-tauri   # 桌面 Rust 后端
cargo run -p transport-server --example spike   # 手动 spike（S1–S4，见迁移方案 §0）
pnpm --filter @pigeon/desktop tauri build       # 打包桌面安装包
pnpm check:types                                # 桌面类型检查 + 服务端构建
```

环境要求：Node ≥ 18、PNPM ≥ 8、Rust stable ≥ 1.75、PostgreSQL ≥ 15。

## 数据流一览

```
桌面 UI (Svelte 5)
 ├─ HTTP：alova → Nest REST（/auth/register、/auth/login、/storage/upload-token、/transport/config）
 ├─ 实时（WebTransport，唯一通道）：QUIC → Rust 网关（hello JWT 验签，配置/指纹取自 /transport/config）
 │      │    C2S：RPC 帧 → Rust 转发 Nest /internal/rt/:type → 业务事务落库 → ack 回帧
 │      │    S2C：Nest 业务事件 → POST /internal/publish → Rust 定向投递（seq 顺序帧）
 │      └─ 事件类型来自 @pigeon/shared-types（编译期约束两端）；presence 由 Rust 权威、Nest 镜像
 └─ 文件：取票（alova，JWT）→ qiniu-js 直传七牛 → publicUrl（不经过 NestJS）
Rust 侧（Tauri invoke）:
 ├─ SQLite（%APPDATA%/com.zhang.pigeon/pigeon.db）本地聊天记录
 └─ encryption crate（AES-256-GCM）— 待接入消息链路
服务端存储：Prisma 8 → PostgreSQL（User / Session / Message / Friendship / MessageStatus）；对象存储：七牛云 Kodo
```

## 当前进度

- ✅ 注册/登录（bcrypt + JWT）、桌面端登录页
- ✅ 桌面端本地 SQLite 持久化（WAL + 版本化迁移）
- ✅ 七牛云文件直传（后端签凭证 + qiniu-js 直传，「文件」页 /files 落地）
- ✅ 设置页：头像直传七牛（dir avatar）+ 昵称修改（PATCH /users/me），User 表新增 avatarUrl
- ✅ 通讯录、消息界面（shadcn-svelte 组件）
- ✅ 服务端好友关系（搜索/申请/通过/拉黑/删除 + 在线状态）、会话与消息落库（历史分页/未读数/已读回执）、WS 消息事务落库 —— e2e 覆盖（`test/chat.e2e-spec.ts`）
- ✅ 桌面端消息页接通服务端：会话列表（新聊天选好友建会话）、本地优先 + 异步合并缓存（v5 迁移：server_session_id/水位列/时间索引/server_msg_id 唯一/meta/reply_summary/reactions/recalled）、optimistic 发送（sending→sent→delivered→read + 失败重发）、WS 已读/送达/新消息/表情回应/撤回实时同步
- ✅ 图片/文件消息（七牛 dir=chat 直传 + meta 透传）、引用回复（replyToId + 内嵌摘要）、表情回应（reaction:add/remove + reaction:update 增量广播）
- 🚧 E2EE 接入消息链路（密钥交换协议）；通讯录页已接通好友/搜索/建群接口
- ✅ 消息撤回（2 分钟窗口、仅发送者，REST + message:recalled 广播，撤回即清空 content/meta）
- ✅ 群聊：建群/群消息（createAll 批量 fan-out，离线成员未读落库）/群历史/@提及（mentions + @我通知）/公告/全员禁言/邀请/踢出/转让群主/退群/成员列表（含在线状态）—— 角色权限矩阵 + system 消息 —— e2e 覆盖（`test/group.e2e-spec.ts`）
- ✅ **WebTransport 实时通道（P0–P4 完成，Socket.IO 已删除）**：Rust 传输网关 `apps/transport-server`（帧协议/hello 鉴权/RPC 转发/推送流 seq/presence epoch+seq/证书轮换/滥用防护/优雅关闭，25 单测 + 8 回环集成测试）；Nest `transport/` 模块（HTTP 桥 + presence 镜像 + `/internal/rt/*` + `/transport/config`【Rust 不可达 503】+ 内部令牌/CIDR 防线）；`ws/` 只剩 `WsEventsService` 抽象 token → TransportBridgeService 绑定；桌面端 `lib/transport/` + 门面 WT 单实现；e2e 与传输实现解耦（FakeTransportBridge + supertest，D7）；部署 Dockerfile/compose/CI/双 CD 就绪。**待手动验证**：spike S1–S4（WebView2 构造/证书指纹握手/版本门槛/UDP 可达）、真机端到端联调（⚠️ 未验证前真机可能有兼容风险：老 macOS WKWebView / 封 UDP 网络 —— 已决策放弃）
- ⬜ 离线同步、群聊、消息搜索、多设备漫游
