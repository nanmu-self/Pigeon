# WebTransport 迁移执行方案（Socket.IO → Rust web-transport-quinn）

> 目标：把实时通道从 NestJS + Socket.IO 换成 Svelte（WebView2 内浏览器 WebTransport API）直连 Rust 服务端（`web-transport-quinn`，当前 0.12.x）。
> 原则：**业务逻辑一行不重写** —— 事务落库、好友/群权限校验全部留在 NestJS；Rust 只做「传输 + 连接注册表（presence）+ 定向投递」。客户端 `ws` 单例的公共 API 保持不变，`chat-store.svelte.ts` 及各页面零改动。
>
> **角色澄清**：本方案的 Rust 是**跑在服务器上的独立服务进程**（`apps/transport-server`，与 NestJS 的 `apps/server` 并排部署在 VPS），**不是桌面端的 Rust** —— 桌面端 `src-tauri` 全程零改动，`crates/encryption` 等现有 crate 也不参与。Svelte 在 WebView2 里用浏览器原生 `new WebTransport()` 直连该 Rust 服务（QUIC/UDP）。REST（登录/历史/好友/群/七牛取票）仍由 NestJS 承担 —— 本次只替换实时通道。
>
> **零数据风险**：本迁移**不涉及任何数据库 schema 改动**（`contract.prisma` 一行不动，无迁移文件），任何阶段回退都不会有数据一致性问题 —— 这是灰度可以放心推进的前提。

---

## 0. 前置 spike（P0 之前，约 1 天，四项全过才继续）

本方案最大的不确定性**不在协议实现，而在运行环境**。以下四条任一不通过，P1~P3 全部白做，因此必须先用最小 demo 验证（可以写在 `apps/transport-server/examples/spike.rs` + 一个临时 Svelte 页面里，验完即删）：

- [ ] **S1 Tauri origin 下 `new WebTransport()` 可用**：WebTransport 要求 secure context。Tauri 生产包的 origin 是 `http://tauri.localhost`（Windows），dev 是 `http://localhost:1420`。二者按规范都属于「潜在可信来源」，但需**实测**构造函数不抛 `SecurityError`（dev 与 `tauri build` 产物**都要测**，两者 origin 不同）。
- [ ] **S2 `serverCertificateHashes` 真的被 WebView2 接受**：用 rcgen 签一张 ECDSA P-256、有效期 14 天的自签叶子证书，把 `SHA-256(DER)` 传给 `serverCertificateHashes`，确认握手通过。这是全流程最容易一次不过的环节（签名算法、有效期、是否叶子证书、SAN 是否必需，任一不满足都是同一句模糊报错）。只看 WebView2 版本号**不算验证过**。
- [ ] **S3 版本门槛确认**：WebTransport 需 Chromium ≥ 97，现有门槛 `MIN_WEBVIEW2_VERSION = "120.0.0.0"`（`apps/desktop/src-tauri/src/webview.rs`）已足够，但要确认 `serverCertificateHashes` 在该版本可用（此参数比 WebTransport 本身晚落地）；若不可用则上调门槛并同步改 `webview.rs` 常量 + 该文件单测。
- [ ] **S4 UDP 可达性**：本机 Windows 防火墙、VPS 云安全组、以及至少一个真实弱网/企业网环境下，UDP 4433 能建连并稳定收发。顺手记录一次「拔网线 30s 再恢复」的行为。

**spike 结论写回本文档**（补一节「spike 记录」，含 WebView2 实测版本、证书参数、失败报错原文），后续排障全靠它。

---

## 1. 目标架构

```
Svelte (WebView2)                        Rust 传输服务                NestJS 业务服务
────────────────                        ────────────────             ────────────────
 new WebTransport(wss://…,               apps/transport-server        apps/server (NestJS)
   {serverCertificateHashes})            ┌──────────────────┐          ┌──────────────────┐
   │  QUIC/UDP:4433（自签证书+指纹固定） │ proto 帧编解码     │ internal │ REST /auth /sessions
   ├─ 双向流：hello(JWT) + RPC ─────────▶│ JWT 验签           │◀─ HTTP ─▶│ /friends /groups /storage
   │   (message:send / read / reaction)  │ 连接注册表+presence │          │ Prisma → PostgreSQL
   └─ 单向推送流（seq 顺序帧）◀──────────│ 定向投递 toUsers   │          │
                                         └──────┬───────────┘          └──────┬───────────┘
                            ① C2S：POST {NEST}/internal/rt/:type ──▶ 业务处理+事务落库
                               ◀────────────── ack payload ─────────┘
                            ② S2C：◀── POST {TRANSPORT}/internal/publish {users[],type,payload}
                            ③ presence：POST {NEST}/internal/presence/delta ──▶ Nest 内存镜像
```

两个方向的内部 HTTP 都是**容器内网调用**，各自监听独立端口（Rust internal :3901 不映射公网；Nest internal 见 §6.5）。

| 职责 | 归属 | 说明 |
|------|------|------|
| JWT 验签、连接生命周期、presence 权威状态 | Rust | 连接/断开天然在 Rust 手里 |
| presence **同步镜像**（供 REST 同步读） | NestJS 内存 | Rust 推 delta + 定期全量对账（见 §3 D6，**关键设计**） |
| message:send/read、reaction 落库，好友/群校验 | NestJS | Rust 转发 + 回传 ack |
| S2C 定向投递（toUsers/broadcast） | Rust 执行，Nest 决定目标 | 内部 HTTP 传「目标 userId 列表 + 事件载荷」 |
| 房间（conversation:{id}） | **删除** | 现有代码全部按 userId 投递，房间只有 typing 在用（见 §3 决策 D2） |

## 2. 现状盘点（改动面）

服务端（推送调用点全部集中在 3 个 service，走 `WsEventsService` 抽象）：
- `apps/server/src/ws/ws-events.service.ts` — `toUser/toConversation/broadcast/isOnline/markOnline/markOffline/onlineCount` 桥 + presence 注册表（**替换为等接口的 Rust 桥**）
- `apps/server/src/ws/events.gateway.ts` — C2S 事件处理（**逻辑迁入 internal 控制器**）
- 推送调用点：`sessions.service.ts`（message:new/delivered/read/recalled/reaction:update）、`groups.service.ts`（message:new fan-out、group:updated）、`friends.service.ts`（friend:request/accepted、isOnline）
- **`isOnline` 是同步方法**，消费点 7 处、其中 3 处在 `map()` 循环里、2 处决定业务行为：
  | 位置 | 用途 | 误判 false 的后果 |
  |------|------|------------------|
  | `friends.service.ts:75`（列表 map 内）、`:160` | 好友列表在线点 | UI 显示离线，下次刷新自愈 |
  | `groups.service.ts:192`（成员 map 内） | 群成员在线点 | 同上 |
  | `sessions.service.ts:132`、`:188` | 会话列表 `peerOnline` | 同上 |
  | `sessions.service.ts:330` | 落库时写 `deliveredAt` | **持久化错误状态** |
  | `sessions.service.ts:364` | 是否推 `message:delivered` | **一次性事件，永久丢失** |
- `onlineCount` 同步消费点：`app.controller.ts:22`（`GET /health`）、`events.gateway.ts` 的 `health:ping`
- **e2e 依赖 Socket.IO**：`test/chat.e2e-spec.ts`、`test/group.e2e-spec.ts` 均 `import { io } from 'socket.io-client'` 连真网关断言推送（覆盖消息三态/撤回/reaction/@提及/群管理广播）→ 见 §3 D7、§9

桌面端（`ws` 单例消费方仅 4 个文件，公共 API 不变则全部零改动）：
- `apps/desktop/src/lib/api/socket.svelte.ts` — 内部实现换成 WebTransport
- `apps/desktop/src/lib/chat-store.svelte.ts` — 用 `on()/sendMessage()/markRead()/rawEmitAck()/onConnected()`
- `apps/desktop/src/routes/(app)/+layout.svelte` — `ws.connect()` + 连接状态 + 全局订阅
- `apps/desktop/src/routes/(app)/contacts/+page.svelte` — friend:request/accepted、presence
- `apps/desktop/src/routes/(app)/settings/+page.svelte:147` — 登出 `ws.disconnect()`

已确认的死代码：`joinConversation/leaveConversation/typingStart/typingStop` 客户端从未调用 → 协议保留位但不实现（typing 属易扩展项）。

## 3. 关键决策

**D1 业务逻辑留在 NestJS（Rust 做纯传输网关）**
- 备选：Rust 直连 PG 重写 sessions/friends/groups —— 双倍实现与双倍测试，且现阶段还要动 Prisma 8 next 语义，收益低。否决；未来若要收敛可再评估。
- 代价：每条 C2S 事件多一跳 localhost/容器网络 HTTP（≈1ms），可接受。

**D2 删除房间模型，改为服务端定向投递**
- 排查结果：业务推送 100% 走 `user:{userId}`；`conversation:{id}` 房间只有 typing 在用。Nest 在内部调用里直接给出接收方 userId 列表，Rust 维护 `userId → 连接集合` 即可路由，还顺带省掉客户端 `conversation:join`。
- 桥上 `toConversation()` 保留为空实现 + 注释（无业务调用方），避免误用；P4 随 Socket.IO 一起删。

**D3 证书：启动时自签 + 指纹固定（`serverCertificateHashes`），并**必须**有轮换机制**
- Rust 启动用 rcgen 生成自签证书（ECDSA P-256，**有效期 ≤ 14 天**，规范硬性要求）。
- ⚠️ **「每次启动重新生成」不足以解决过期问题**：进程连续运行超过 14 天后，证书过期 → **所有新建连接被 Chromium 静默拒绝**，已建立的连接不受影响，故障是渐进式、无声的，最难排查。
- 因此定时轮换是**必须项**：Rust 内部定时器每 **7 天**（或剩余有效期 < 50% 时）重签，通过 `quinn::Endpoint::set_server_config()` **热替换**，无需重启、不影响存量连接。
- `/internal/cert` 返回 **`certSha256[]` 数组**（新旧两张指纹并存一个轮换窗口期）；`serverCertificateHashes` 本身接受数组，客户端把两个都传进去 → 轮换瞬间新建连接也不会失败。
- 指纹经 Nest 新端点 `GET /transport/config` 下发（JwtAuthGuard），Nest 侧缓存 **≤ 30s**；**客户端每次（重）连之前都取一次，禁止长缓存**（否则轮换后拿旧指纹连不上）。客户端 base64 → `Uint8Array`；Chromium 跳过证书链校验、不做域名匹配，所以无需域名。
- 备选：真证书 + ACME（rustls-acme）——需要域名 + 80 端口 + UDP 443 直连，运维成本高；作为后续选项保留在配置里。

**D4 可靠有序推送走单向流，不用 datagram；丢帧必须让客户端可感知**
- message:new/read/reaction/recalled 要求有序可靠；一条连接开一条 server→client 单向流，帧带 per-connection 递增 `seq`，客户端发现 seq 跳号 → 触发现有的 `onConnected` 对账刷新（REST 补偿链路已存在）。datagram 留给未来 typing/presence 优化。
- ⚠️ **不允许「队列满则静默丢帧」**：丢帧但 seq 连续 → 客户端跳号检测完全失效 → 用户看到「消息永久消失」。正确做法见 §5「背压与丢帧」。

**D5 双通道共存靠**服务端下发的开关**灰度，最后删 Socket.IO**
- ⚠️ `VITE_TRANSPORT` 是 **Vite 构建期内联**（同 `SERVER_URL`，见 `lib/api/config.ts` 注释）：装机用户的包里写死了，出问题「一键回退」实际需要重新出包 + 用户重装 —— 与灰度意图矛盾。
- 所以**权威开关放在服务端**：`GET /transport/config` 返回 `{ transport: 'wt' | 'socket', url, certSha256[] }`，客户端启动时按服务端指示选实现。服务端改环境变量 `RT_TRANSPORT` + 重启即完成全量回退，无需发版。
- `VITE_TRANSPORT` 降级为**本地开发覆盖项**（优先级高于服务端下发，仅 dev 用）。
- 服务端 `RT_TRANSPORT=socket|wt` 同时决定：bridge 用旧 io 还是新 HTTP 桥、gateway 是否挂载、`/transport/config` 下发哪个 transport。soak 之后再做删除阶段。

**D6 presence 用「Rust 权威 + Nest 内存镜像」，不用远程查询**（**替代原「HTTP + 5s TTL 缓存」方案**）
- ⚠️ 原方案不成立：`isOnline(userId): boolean` 是**同步**签名，无法改成远程 await（要改就是 7 处调用点 + 3 个 service 全链路 async 化，违背「业务零改动」原则）；而「缓存未命中返回 false」会让 `sessions.service.ts:364` 漏推 `message:delivered`（一次性事件，永久丢失）、`:330` 写错 `deliveredAt`。
- 正确设计 —— **Nest 侧仍是本地内存 Map，只是数据来源从自己的网关变成 Rust 推送**：
  1. Nest 启动时（及每次检测到 epoch 变化时）`GET {TRANSPORT}/internal/presence/snapshot` 拉全量 → 重建镜像；
  2. Rust 每次用户首连/末连断开，`POST {NEST}/internal/presence/delta {epoch, seq, userId, online, at}` → Nest 更新镜像**并**执行原有的 `broadcast('presence:update')`（保持事件语义不变）；
  3. **每 30s 全量对账**（Rust 主动推 snapshot 或 Nest 主动拉），diff 不为空则记录指标 + 修正（防 delta 丢包导致的长期漂移）；
  4. **`epoch`（Rust 进程启动时间戳/UUID）+ `seq`（单调递增）是关键**：Rust 重启后 epoch 变化 → Nest **清空镜像**重建，否则会留下一批永远「在线」的幽灵用户；`seq` 用于乱序/重复 delta 的丢弃。
- `isOnline()` / `onlineCount` 保持同步、零延迟、零改动；`markOnline/markOffline` 从「网关调用」改为「delta 控制器调用」。
- 代价：delta 丢包窗口内（≤30s）可能有误判，与原 5s TTL 同量级但**只影响展示**（因为 delivered 判定读的是本地镜像，且 delta 是「事件驱动写入」而非「懒查询」，命中率远高于 TTL 缓存）。

**D7 e2e 先与传输实现解耦，再切流**
- `test/chat.e2e-spec.ts` / `test/group.e2e-spec.ts` 现在直接用 `socket.io-client` 连真网关断言推送。若不处理，P4 删依赖时这批最有价值的回归测试会全部失效。
- 做法：**P2 阶段先把它们改造成传输无关**——注入 `FakeTransportBridge`（记录 `publish(users, type, payload)` 调用列表）替换桥，断言「谁收到了什么事件」；C2S 从 `socket.emitWithAck` 改为 supertest 打 `/internal/rt/:type`。改完后 Socket.IO 删除时 e2e 零改动。这是整个迁移最重要的安全网，**不要留到 P4**。

**D8 单实例假设（写死，防后人踩坑）**
- `registry`（userId → 连接）在 Rust 进程内存 → **传输服务当前必须单副本**，compose 里注明不可 `scale`。
- 未来要多副本，需要 Redis pub/sub 广播 publish、或按 userId 一致性哈希路由。**在此之前加副本 = 一半用户收不到推送**。


## 4. 协议设计（v1）

帧格式：`u32 BE 长度 + JSON(UTF-8)`，单帧上限 **1 MiB**（对齐现网关 `maxHttpBufferSize: 1e6`）。
契约仍在 `packages/shared-types`：`ClientToServerEvents`/`ServerToClientEvents` 原样保留为协议事实标准，新增 `RtRequest/RtResponse/RtPushFrame/TransportConfig` 类型由它们推导（`type` 字段 = 事件名）。

**⚠️ 帧读取必须是累积缓冲状态机**：QUIC 流是字节流，一次 `read()` 可能返回半个帧、也可能返回两个半帧。`frame.ts`（TS）与 `proto.rs`（Rust）都要维护缓冲区，循环「够 4 字节读长度 → 够长度切出帧 → 剩余留在缓冲」。**这是此类实现最常见的 bug**，两侧单测都要有「逐字节分片投喂」用例。

**协议一致性夹具（防两端漂移）**：shared-types 是 type-only 包，Rust 无法共享类型。新增 `packages/shared-types/fixtures/rt-*.json`（每个事件一份代表性载荷），Nest 单测断言序列化结果与夹具一致、Rust 单测反序列化同一批夹具 —— 低成本且唯一有效的漂移防线。同时给 shared-types 补工具类型，避免手抄载荷：

```ts
// packages/shared-types 新增（全部 type-only，遵守包约定）
export type EventPayload<K extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[K]>[0];
export type RtPushFrame =
  | { seq: number; type: keyof ServerToClientEvents; payload: unknown }
  | { seq: number; type: 'resync' | 'going_away'; payload: { reason: string } };
export type RtRequest  = { id: number; type: keyof ClientToServerEvents; payload?: unknown };
export type RtResponse =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string; code?: 'unauthorized' };
export type TransportConfig = {
  transport: 'wt' | 'socket';
  url: string;
  certSha256: string[];     // 轮换窗口期可能有两个（新旧并存）
  minClientProto: number;
};
```

### 连接生命周期
```
0. 取配置: GET /transport/config (JWT) → {transport, url, certSha256[], minClientProto}  ← 每次连接前都取，禁长缓存
1. connect: new WebTransport(url, {serverCertificateHashes: certSha256.map(toHash),
                                   congestionControl:'low-latency'})
   → await wt.ready（超时 8s 判失败，进入退避重连）
2. 客户端开 bi 流 #0 发 {v:1, type:'hello', token, clientProto:1, clientVersion:'…'}
3. 服务端 JWT 验签（HS256，读同一个 JWT_SECRET）→ 回 {type:'welcome', connId, userId, serverTime}
   → 失败：{type:'error', code:'auth_failed'|'client_too_old'|'token_expired'} 后 close
4. 服务端开推送流，注册进 registry → 首连则向 Nest 推 presence delta
close: wt.closed promise → 客户端状态机 reconnecting（1s 起指数退避 + 随机抖动，上限 5s）
保活：quinn keep_alive 10s / max_idle_timeout 30s + 客户端每 30s 一次 health:ping RPC（复用现有 latency 展示）
```
- **hello 超时**：连接建立后 **5s** 内未收到合法 hello → Rust 主动 close（防未鉴权连接堆积，见 §5 滥用防护）。
- 游客降级（现网关的 guest 分支）**不迁移**：WT 通道一律强鉴权，未登录连不上（`WS_STRICT_AUTH` 概念随之消失）。
- **token 过期**：连接建立时记录 JWT `exp`，到期由 Rust 主动 close（`token_expired`）→ 客户端 `reconnect()` 重读 tokenStore。项目**没有 refresh token**（`JWT_EXPIRES_IN = '7d'`），实际结果是「7 天后要求重新登录」，这是预期行为；需给出可读提示而非静默重连风暴 —— **连续 `auth_failed`/`token_expired` ≥ 3 次 → 停止重连并跳登录页**。
- RPC 级 token 失效：`{ok:false, error:'unauthorized', code:'unauthorized'}` → 客户端触发 `ws.reconnect()`。

### 协议版本协商（P4 的前提，不可省）
桌面端是安装包，用户不一定升级 → 服务端更新后**必然新旧客户端混跑**。「soak 1~2 周后删 Socket.IO」需要机制保证而不是等时间：
- `hello.clientProto` vs 服务端 `MIN_CLIENT_PROTO`：低于门槛 → 回 `{code:'client_too_old', minProto}`，客户端弹**强制升级**提示（而非无限重连）。
- `/transport/config` 同样返回 `minClientProto`，客户端连接前即可判断并提示。
- **P4 删 Socket.IO 的准入条件**：观测到 `transport=socket` 的活跃连接数连续 7 天为 0（见 §12 指标），而不是「过了两周」。

### 三类流
| 流 | 方向 | 用途 | 语义 |
|----|------|------|------|
| hello | bi（客户端开，#0） | 鉴权 + 版本协商 | 一次；5s 超时 |
| RPC | bi（每请求一条新流） | C2S：message:send / message:read / reaction:add / reaction:remove / health:ping | 客户端生成自增 `id`，写 `{id, type, payload}`；服务端回 `{id, ok, data|error}` 后关流。天然并发、天然映射 `emitWithAck`；客户端侧 10s 超时 reject |
| 推送 | uni（服务端开，一条长流） | 全部 S2C 事件 | `{seq, type, payload}` 顺序帧；seq 跳号或收到 `resync` → 客户端全量对账 |

### 事件映射表
| 现有事件 | 迁移后 | 通道 |
|----------|--------|------|
| connection:welcome | welcome（hello 响应） | hello 流 |
| message:send（C2S, ack） | 同名 RPC | bi 流 → Nest `/internal/rt/message:send` |
| message:read（C2S, ack） | 同名 RPC | 同上 |
| reaction:add/remove（C2S, ack） | 同名 RPC | 同上 |
| typing:start/stop | 协议保留，暂不实现 | — |
| health:ping（ack） | 同名 RPC（Rust 本地应答，含在线数） | bi 流 |
| conversation:join/leave | 删除（无调用方） | — |
| message:new / message:read / message:delivered / reaction:update / message:recalled / group:updated / presence:update / friend:request / friend:accepted | 原事件名不变 | 推送流 |
| （新增）resync / going_away | 推送流控制帧：提示客户端全量对账 / 服务端即将关闭 | 推送流 |

## 5. Rust 服务端（新 crate `apps/transport-server`，二进制，跑在服务器上）

放在 `apps/transport-server`（服务端应用目录，与 `apps/server` 并排；不放 `crates/` —— 那里现有成员都是桌面端在用的库，避免混淆）。根 `Cargo.toml` 的 `members` 需显式加一行 `"apps/transport-server"`（现有 members 只有 `crates/*` 与 `apps/desktop/src-tauri`；`exclude = ["apps/*/node_modules"]` 已覆盖，pnpm workspace 对无 package.json 的目录自动忽略，互不影响）。注意加进 workspace 后 `cargo check`/`cargo test` 会连带编译它（CI 时间增加，见 §12）。

依赖：`web-transport-quinn` 0.12（ALPN 由 crate 内部处理，注意与旧教程的 `web_transport_quinn::ALPN` 手配写法区分，以 docs.rs 当前文档为准）、`tokio`、`serde/serde_json`、`jsonwebtoken`、`rcgen`、`reqwest`、`axum`（internal HTTP）、`tracing`、`dashmap`。

**构建期已知坑（Dockerfile 必踩）**：
- rustls 0.23 默认 `aws-lc-rs` provider 需 cmake/nasm → slim 构建镜像会失败。**显式选 `ring` provider**（关默认特性 + `ring`，并在 `main()` 里 `rustls::crypto::ring::default_provider().install_default()`）。
- `reqwest` 用 `default-features = false, features = ["json", "rustls-tls"]`，避免拉 openssl。
- `rcgen` 版本要与 rustls 的 `pki-types` 对齐（否则 `CertificateDer` 类型不兼容，报错极难读）。
- Dockerfile 用 **cargo-chef** 分层缓存依赖，否则每次 CI 全量编译。

```
apps/transport-server/src/
├── main.rs        # env 解析（fail-fast）+ 启动 WT/internal HTTP + 证书轮换定时器 + 优雅关闭
├── config.rs      # WT_BIND=0.0.0.0:4433 / WT_INTERNAL_BIND=:3901 / JWT_SECRET /
│                  #   NEST_URL / WT_INTERNAL_TOKEN / WT_PUBLIC_URL / 限流参数
├── cert.rs        # rcgen 自签（ECDSA P-256, not_after=now+14d）+ SHA-256(DER) + 7 天轮换热替换
├── proto.rs       # 帧编解码（u32 BE + JSON, 1MiB 上限, 累积缓冲状态机）+ 类型（单测 + 夹具测）
├── auth.rs        # jsonwebtoken HS256 解码 → {userId, nickname, exp}
├── registry.rs    # userId → Vec<ConnHandle>；isOnline；broadcast；epoch/seq；snapshot（DashMap）
├── conn.rs        # 单连接任务：hello 鉴权(5s 超时) → RPC 流 accept 循环 → 推送流写循环(mpsc+seq)
├── forward.rs     # C2S 转发：reqwest POST {NEST_URL}/internal/rt/:type（带内部令牌与用户上下文头）
├── presence.rs    # 向 Nest 推 delta（带 epoch/seq，失败重试）+ 30s 全量对账
├── internal.rs    # axum: POST /internal/publish、GET /internal/presence/snapshot、
│                  #   GET /internal/cert、GET /healthz、GET /metrics
└── selfcheck.rs   # `--selfcheck` 子命令：打自身 /healthz，供 Docker healthcheck（slim 镜像无 curl/node）
```

**启动即 fail-fast**（避免「能连上但 hello 全失败」这种最难查的现象）：
- `JWT_SECRET` 缺失或长度 < 16 → 直接 `exit(1)` 并打印原因。⚠️ Nest 侧 `resolveJwtSecret()`（`auth.module.ts`）在未配置时**每次启动随机生成** → 两进程密钥必然不同 → Rust 验签 100% 失败、现象是「连上就被拒」。所以 Nest 在 `RT_TRANSPORT=wt` 时也必须强制要求显式 `JWT_SECRET`，两侧同时收紧。
- `NEST_URL` / `WT_INTERNAL_TOKEN` 缺失 → exit(1)。

**JWT 校验参数显式化**：`Validation::new(Algorithm::HS256)` + `validate_exp = true` + 不校验 aud/iss（Nest 没签）。`JwtPayload.userId` 在 Nest 是 **number**（`auth.service.ts:111`），而网关用 `String(payload.userId)` —— Rust 侧用 `serde_json::Value` 或 `deserialize_with` 兼容 number/string，内部统一转 `String`。

骨架（API 以 web-transport-quinn 0.12 文档为准）：

```rust
// main.rs（示意）
rustls::crypto::ring::default_provider().install_default().ok();
let cfg = config::from_env()?;                                  // 缺 JWT_SECRET 等 → exit(1)
let certs = cert::Rotating::new()?;                             // 首签 + 后台 7 天轮换任务（热替换）
let server = web_transport_quinn::Server::builder()
    .with_cert(certs.chain(), certs.key())?                     // rustls 证书链 + 私钥
    .listen(cfg.bind)?;                                         // UDP 4433
tokio::spawn(presence::reconcile_loop(registry.clone(), cfg.clone()));   // 30s 全量对账
tokio::spawn(internal::serve(cfg.clone(), registry.clone(), certs.clone()));
loop {
    tokio::select! {
        Some(session) = server.accept() => {
            let conn = Conn::new(session, registry.clone(), cfg.clone());
            tokio::spawn(async move { conn.run().await });       // hello → 注册 → 双循环
        }
        _ = shutdown_signal() => { registry.going_away().await; break; }  // 优雅关闭
    }
}

// conn.rs 核心循环（示意）
let (mut tx, mut rx) = timeout(5s, session.accept_bi()).await??;  // hello 流，5s 超时
let hello: Hello = proto::read_frame(&mut rx).await?;
if hello.client_proto < MIN_CLIENT_PROTO { /* client_too_old + close */ }
let claims = auth::verify(&cfg.jwt_secret, &hello.token)?;        // 失败 → error 帧 + close
proto::write_frame(&mut tx, &welcome(&claims)).await?;
let (push_rx, first_conn) = registry.insert(claims.user_id.clone(), handle);
if first_conn { presence::push_delta(&cfg, &claims.user_id, true).await; }  // Nest 更新镜像并广播
tokio::select! {
    r = rpc_loop(session.clone(), &claims) => …,                  // accept_bi 每流一任务，转发后回帧
    r = push_loop(push_rx, seq)            => …,                  // mpsc 收 publish → {seq,type,payload}
    _ = sleep_until(claims.exp)            => close(TOKEN_EXPIRED),
}
```

### 投递语义（与现网关逐条对齐）
- `publish(users, type, payload)`：对每个目标的每路在线连接投递到该连接的 mpsc。
- **背压与丢帧（关键）**：mpsc 满时**不允许静默丢弃** —— 丢帧但 seq 连续 = 客户端跳号检测完全失效 = 用户看到「消息永久消失」。处理顺序：
  1. `send().await` 带**短超时**（如 200ms；QUIC 缓冲正常时不会触发）；
  2. 超时/满 → 写一帧 `{seq, type:'resync', payload:{reason:'backpressure'}}`（连 resync 都写不进 → 直接 **close 该连接**，让客户端重连兜底）；
  3. 客户端收到 `resync` 或探测到 seq 跳号 → 走 `onConnected` 同一套全量对账（chat-store 的 REST 合并逻辑已存在）；
  4. 计数进 `rt_push_dropped_total`，超阈值告警。
- **Nest→Rust 的 `/internal/publish` 失败同样是不可感知的丢失点**：fire-and-forget + 重试 1 次后仍失败 → 记 `rt_publish_failed_total` + 错误日志 + 告警，并在文档中明确「最终一致依赖客户端 `onConnected` 对账」。
- **fan-out 批量化**：`groups.service.ts:124` 现为 `for (uid of members) ws.toUser(uid,'message:new',…)`。桥换 HTTP 后 200 人群 = 200 个 POST。→ 桥新增 `toUsers(userIds[], event, payload)`（`/internal/publish` 的 `users: []` 天然批量），把该处循环改为一次调用；`sessions.service.ts:356-360`、`:536-537`、`:578-579` 成对的 `toUser` 亦可合并。
- presence：首路连接 → 向 Nest 推 `delta{online:true}`，**由 Nest 执行 `broadcast('presence:update')`**（广播语义保留在 Nest，与现状一致，也让「镜像更新」与「广播」原子发生）；末路断开同理。
- health:ping：Rust 直接应答 `{pong, online}`。⚠️ **口径变化**：现在 `onlineCount` 是 `io.engine.clientsCount`（Socket.IO 连接数），迁移后是 WT 连接数；混跑期两者不一致 → `GET /health` 与 ping 的在线数统一取 **Nest presence 镜像的用户数**，字段语义在响应里注明（在线用户数 ≠ 连接数），避免线上看板对不上。

### 滥用防护（4433 是裸暴露的公网 UDP 端点；Socket.IO 时代躲在 OpenResty 后面，现在没有了）
- hello 5s 超时（上文）；hello 失败立即 close 并计数。
- QUIC 传输参数：`max_concurrent_uni_streams = 0`（客户端不需要开 uni 流）、`max_concurrent_bidi_streams` 限制（如 32，防单连接开无限 RPC 流）、收紧 `receive_window` / `stream_receive_window`。
- 每 IP 并发连接上限（如 20）、每连接 RPC 速率限制（令牌桶，如 20 req/s）、每 userId 连接上限（如 8 台设备）。
- 帧长度 > 1 MiB 或 JSON 解析失败 → 立即 close（不尝试恢复）。
- 所有拒绝路径都要有指标计数（§12），否则被刷了也不知道。

### 优雅关闭（滚动更新体验）
收到 SIGTERM：① 停 `accept`；② 给所有连接推 `going_away` 控制帧并 `close(0)`；③ 等 ≤3s 后退出。客户端立即进入重连，而不是等 30s idle timeout 才发现掉线。compose 侧配 `stop_grace_period: 10s`。

## 6. NestJS 改造（`apps/server/src/transport/` 新模块）

### 6.1 `transport-bridge.service.ts` —— 与 `WsEventsService` 同签名的桥
保持全部现有签名（含**同步**的 `isOnline`/`onlineCount`），内部换实现：

| 方法 | 新实现 |
|------|--------|
| `toUser(userId, event, payload)` | `POST {TRANSPORT}/internal/publish {users:[userId], type, payload}`（fire-and-forget，失败重试 1 次 + 计数 + 告警日志） |
| `toUsers(userIds, event, payload)`（**新增**） | 同上但 `users: userIds` —— 群 fan-out 用，避免 N 次 HTTP（见 §5） |
| `toConversation(...)` | 空实现 + 注释「D2 已删除房间模型，无业务调用方」，P4 删除 |
| `broadcast(event, payload)` | `POST /internal/publish {broadcast:true, type, payload}`（presence:update、group:updated 两处） |
| `isOnline(userId): boolean` | **读本地 presence 镜像 Map**（同步、零延迟，见下） |
| `onlineCount: number` | 镜像里的在线**用户**数 |
| `markOnline/markOffline` | 保留，但改由 presence delta 控制器调用（不再由网关调用） |

**presence 镜像（D6 的落地，本次改造的核心）** —— `presence-mirror.service.ts`：
```
状态：Map<userId, true> + epoch: string | null + lastSeq: number
入口 1（启动/epoch 变化/对账）：GET {TRANSPORT}/internal/presence/snapshot
                              → {epoch, seq, userIds[]} → 整体替换 Map
入口 2（实时）：POST /internal/presence/delta {epoch, seq, userId, online, at}
   ├─ epoch !== 当前 epoch → 丢弃该 delta 并立即拉 snapshot（Rust 重启了）
   ├─ seq <= lastSeq       → 丢弃（重复/乱序）
   └─ 正常 → 更新 Map + `broadcast('presence:update', {userId, online, at})`
入口 3（兜底）：每 30s 主动拉一次 snapshot 对账，diff 计数进指标（防 delta 丢包漂移）
Transport 不可达时：镜像保持上次状态 + 打 WARN；不清空（清空会造成大面积「假离线」）
```
⚠️ **`epoch` 不可省**：Rust 重启后若不换 epoch/不重建镜像，Nest 会留下一批永远「在线」的幽灵用户，`message:delivered` 判定跟着一起错。

切换方式：`WsModule` 里把 bridge 的 provider 换成新实现（`{ provide: WsEventsService, useClass: TransportBridgeService }`），**7 处 `isOnline` 调用点、全部 `toUser` 调用点零改动**；保留旧实现 provider 以便按 `RT_TRANSPORT` 回退。

### 6.2 `internal-rt.controller.ts` —— C2S 落地
`POST /internal/rt/:type`，校验 `x-internal-token`，取 `x-user-id` / `x-display-name` 头，把 `events.gateway.ts` 里 `message:send` / `message:read` / `reaction:add` / `reaction:remove` 的处理体**原样搬进来**（参数校验、`SessionsService` 调用、`errorText()` 文案组装），返回 `{ok, data|error}`。
- `errorText()` 一并搬过来（`HttpException` → 可读文案），**保证错误文案与现网关逐字一致**（客户端 toast 依赖它）。
- guest 分支的 `Number.isInteger(userId)` 校验保留（防内部头被伪造成非法值），但错误文案可改成「登录状态异常」。
- typing 若将来实现：解析会话成员后走桥 `toUsers` publish。
- 该控制器必须**排除全局 CORS 与 JwtAuthGuard**（它不是浏览器可达的端点）。

### 6.3 `transport.controller.ts` —— 配置下发
`GET /transport/config`（JwtAuthGuard）：代理 Rust 的 `GET /internal/cert`（Nest 侧缓存 ≤30s），返回
`{ transport: RT_TRANSPORT, url: WT_PUBLIC_URL, certSha256: string[], minClientProto }`。
- `RT_TRANSPORT=socket` 时也要正常返回（`transport:'socket'`，`certSha256: []`），客户端据此走旧实现 —— **这就是 D5 的服务端开关**。
- Rust 不可达时：返回 `{transport:'socket', …}` 而非 500 —— **传输服务挂了自动降级到 Socket.IO**（混跑期最有价值的兜底；P4 删除 Socket.IO 后改为返回 503 + 客户端提示）。

### 6.4 开关与模块装配
`RT_TRANSPORT=socket|wt` 决定：bridge 用旧 io 实现还是新 HTTP 桥、`EventsGateway` 是否挂载、`/transport/config` 下发哪个 transport。`RT_TRANSPORT=wt` 时额外校验 `JWT_SECRET` / `TRANSPORT_INTERNAL_URL` / `WT_PUBLIC_URL` 已配置，否则启动失败（fail-fast，与 Rust 侧对称）。

### 6.5 ⚠️ `/internal/*` 的暴露面（安全，必须处理）
OpenResty 反代的是整个 3048 端口。`/internal/rt/:type` 若可从公网访问，等于把「以任意 userId 发任意消息」的能力挂到互联网上 —— `x-internal-token` 是唯一防线，一旦泄露或反代规则宽松（`location /`）即被打穿。三层防护，**至少落实前两层**：
1. **网络层**：1Panel/OpenResty 站点配置显式 `location ^~ /internal/ { deny all; return 404; }`（部署文档写成 checklist 项，`deploy/README.md` 补充）。
2. **应用层**：`internal-rt.controller.ts` + presence delta 控制器校验 `x-internal-token`（长随机、与 JWT_SECRET 不同源），**并**校验来源 IP 属于容器网段（`1panel-network` 的 subnet）。
3. **（推荐）独立监听**：Nest 起第二个 HTTP server（如 :3902，只监听容器内网口、compose 不映射）专门承载 `/internal/*`，与公网 3048 物理隔离。改造量小（`app.listen` 旁边多一个 `NestFactory.create` 或用 `app.getHttpAdapter()` 挂第二 server），收益最大。
4. 上线前用 `curl https://<公网域名>/internal/rt/message:send` 验证返回 404/403（写进 §9 验收清单）。

### 6.6 shared-types
新增 `TransportConfig`、`RtRequest/RtResponse/RtPushFrame`、`EventPayload<K>`（全部 type-only，遵守包约定：**不可运行时 import**，需要值形式的常量在使用方模块内定义 + 编译期断言对齐，参考 `storage/dto.ts` 的 `UPLOAD_DIRS`）。

## 7. 桌面端改造（`apps/desktop/src/lib/`）

```
lib/api/socket.svelte.ts      # 公共 API 原样保留（state/socketId/userId/lastError/latency/on/off/
                              #   onConnected/sendMessage/markRead/rawEmitAck/reconnect/disconnect/connect）
                              # 内部：按 /transport/config 的 transport 字段选择 socket 或 wt 实现
lib/transport/
├── config.ts                 # 取 /transport/config（alova，JWT）；每次连接前调用，不做长缓存；401→不连接
├── frame.ts                  # u32 BE + JSON 帧读写 + 累积缓冲状态机（含分片投喂单测）
├── webtransport.ts           # 连接状态机：ready 超时 8s、指数退避+抖动重连、RPC id→Promise 映射（10s 超时）、
│                             #   推送流读取（seq 跳号/resync → 触发 onConnected 对账）、closed→reconnecting
└── index.ts                  # 实现选择：dev 的 VITE_TRANSPORT 覆盖 > 服务端下发 transport
```

要点：
- **实现选择顺序**：`import.meta.env.VITE_TRANSPORT`（仅本地开发覆盖）> `/transport/config` 的 `transport` 字段（生产权威，见 D5）。
- `serverCertificateHashes: certSha256.map((v) => ({ algorithm: 'SHA-256', value: base64ToBytes(v) }))` —— **数组多指纹**以兼容证书轮换窗口。
- **不支持 WebTransport**（WebView2 过旧 / 非 secure context）→ `typeof WebTransport === 'undefined'` 检测 → 自动回退 socket 实现 + 提示；同时复用 `src-tauri/src/webview.rs` 的版本门槛做兜底（若 spike S3 发现门槛不够则上调 `MIN_WEBVIEW2_VERSION` 并更新其单测）。
- `connection:welcome` 语义由 hello 响应承担，填充现有 `socketId`（用 `connId`）/`userId` 状态，**并对注册表里的 `connection:welcome` handler 照常触发**（`socket.svelte.ts` 内部有订阅）。
- `onConnected` 语义保留：每次（重）连成功后触发订阅方对账（chat-store 现有 REST 合并逻辑直接复用）；**seq 跳号 / resync 帧也复用同一回调**。
- `handlerList` 跨重连存活的机制照搬（WT 实现里同样要在重连后重新分发到注册的 handler）。
- `latency` 探测沿用「30s 定时 + 立即先测一次」，改为 RPC `health:ping`。
- 登录/登出仍调 `ws.reconnect()`；握手 token 每次连接从 `tokenStore` 现读。
- **重连风暴防护**：连续 `auth_failed`/`token_expired` ≥ 3 次 → 停止重连、`state='disconnected'`、`lastError` 给出可读文案（现有连接指示器直接展示）。

## 8. 部署（deploy/）

- 新增 `apps/transport-server/Dockerfile`（`rust:1-slim` + cargo-chef 多阶段 → `debian:*-slim`，glibc 二进制）。
- `deploy/docker-compose.yml` 新增服务：
  ```yaml
  transport:
    image: ghcr.io/nanmu-self/pigeon-transport:${IMAGE_TAG:-latest}
    container_name: pigeon-transport      # ← 用它做容器间 host 名（1panel-network 是 external 共享网络，
                                          #    靠 compose 服务名解析不稳，务必用固定 container_name）
    env_file: /opt/pigeon/shared/env      # JWT_SECRET 天然与 server 共享
    environment:
      NEST_URL: http://pigeon-server:3048        # 或 :3902（若采用 §6.5 独立 internal 监听）
      WT_BIND: 0.0.0.0:4433
      WT_INTERNAL_BIND: 0.0.0.0:3901
    ports:
      - "0.0.0.0:4433:4433/udp"           # 只映射 UDP；3901 不映射（仅容器网内可达）
    stop_grace_period: 10s                # 配合优雅关闭（§5）
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "/usr/local/bin/transport-server", "--selfcheck"]   # slim 无 curl/node
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    networks: [pigeon]
  # ⚠️ 不可 scale/replicas > 1（registry 在进程内存，见 D8）
  ```
  Nest 侧 env 增 `TRANSPORT_INTERNAL_URL=http://pigeon-transport:3901`、`WT_PUBLIC_URL`、`RT_TRANSPORT`。
- **OpenResty 不能反代 WT**（TCP 反代不透传 QUIC/UDP 扩展 CONNECT）→ 4433/UDP 必须直连容器 + 云安全组/防火墙放行 UDP。现有 HTTPS 反代只服务 REST，不受影响。**同时按 §6.5 加 `/internal/` deny 规则**。
- `WT_PUBLIC_URL` 形如 `https://<公网域名或IP>:4433/wt`；因为走指纹固定、Chromium 不做域名匹配，**用 IP 也可以**（域名只是便于运维）。
- CI/CD：`.github/workflows/deploy.yml` 增加独立 job 构建 `pigeon-transport` 镜像，**paths 过滤 `apps/transport-server/**` + `Cargo.*`**（否则每次改 Nest 都白编 Rust 几分钟）；`ci.yml` 增加 `cargo test -p transport-server`（含 §9 的 Rust 集成测试）。
- 客户端 `VITE_PIGEON_SERVER_URL` 照旧；`VITE_TRANSPORT` 仅 dev 用。
- **本地开发**：`pnpm dev` 变为 3 进程 —— 根 `package.json` 增 `"dev:transport": "cargo run -p transport-server"`，`dev` 脚本的 concurrently 加一路（`-n DESKTOP,SERVER,TRANSPORT -c blue,green,magenta`）。AGENTS.md「常用命令」同步。

## 9. 测试与验收

| 层 | 手段 | 覆盖 |
|----|------|------|
| proto/帧 | Rust 单测（`cargo test -p transport-server`） | 编解码往返、**逐字节分片投喂**、超限（>1MiB）拒绝、坏 JSON 拒绝、shared-types 夹具反序列化 |
| cert | Rust 单测 | 有效期 ≤14 天、ECDSA P-256、SHA-256(DER) 指纹计算、轮换后新旧指纹并存 |
| presence | Rust + Nest 单测 | epoch 变化 → 镜像重建；seq 乱序/重复丢弃；delta 丢包后 30s 对账修正；Transport 不可达时镜像不清空 |
| Rust 集成 | `web_transport_quinn::connect` 客户端模式起真实回环会话 | hello 成功/失败/超时/client_too_old、RPC 往返与并发、推送顺序与 seq、背压→resync、presence 首/末连接 delta、publish 目标路由与 broadcast、优雅关闭推 going_away |
| Nest internal | Vitest + supertest 直接打 `/internal/rt/*` | 消息落库、clientMsgId 幂等、权限错误**文案与现网关逐字一致**、内部 token 缺失/错误 → 401 |
| **e2e 改造（D7，P2 必做）** | `test/chat.e2e-spec.ts` / `test/group.e2e-spec.ts` 去掉 `socket.io-client`，注入 `FakeTransportBridge` 断言 publish 调用；C2S 改 supertest | 现有全部覆盖（消息三态、撤回、reaction、@提及、群管理广播、好友申请）**与传输实现解耦** |
| 端到端 | 两个桌面 dev 实例对打 | 发送/送达/已读三态、撤回、表情回应、@提及、群管理广播、好友申请实时通知、presence 上下线、断网 30s 重连后对账刷新、7 天 token 过期后的提示、Rust 重启后（epoch 变化）在线状态正确 |
| 安全 | 手工 + 脚本 | `curl https://<公网域名>/internal/rt/message:send` → 404/403；无 hello 的裸连接 5s 被断；单连接开 100 条 RPC 流被限 |
| 灰度回退 | 服务端 `RT_TRANSPORT=socket` + 重启（**不发版**） | 全功能回到 Socket.IO 旧路径；再演练一次「Transport 容器停掉 → 自动降级」 |

## 10. 分阶段执行清单

**P0-pre spike（§0，四项全过才继续）**
- [ ] S1 Tauri dev + build 产物下 `new WebTransport()` 可构造
- [ ] S2 rcgen 自签 + `serverCertificateHashes` 握手成功（记录证书参数与失败报错原文）
- [ ] S3 WebView2 版本门槛确认（必要时上调 `MIN_WEBVIEW2_VERSION` + 改单测）
- [ ] S4 本机/VPS/一个真实弱网环境 UDP 4433 可达
- [ ] spike 结论回写本文档

**P0 协议与连接骨架（Rust 起服务 + 客户端连上）**
- [ ] `apps/transport-server`：config(fail-fast)/cert(含轮换)/proto(累积缓冲+夹具)/auth/registry/conn(hello+welcome+health:ping) + 单测
- [ ] 根 `Cargo.toml` 加 members；根 `package.json` 加 `dev:transport`；`ci.yml` 加 `cargo test`
- [ ] shared-types：`TransportConfig`/`RtRequest`/`RtResponse`/`RtPushFrame`/`EventPayload` + `fixtures/rt-*.json`
- [ ] Nest：`GET /transport/config`（可先返回 mock 指纹联调）
- [ ] 桌面：`transport/frame` + `webtransport` 状态机，`ws` 状态灯变绿
- [ ] **AGENTS.md 同步**（新目录/新命令一出现就写，不拖到 P4）
- 验收：dev 两实例连接、welcome、latency 正常；杀掉 Rust 服务能自动重连；hello 超时/坏 token 行为正确

**P1 S2C 推送链路（下行先通）**
- [ ] Rust：推送流 + 背压 resync + `/internal/publish`（含 `users[]` 批量与 broadcast）+ `/internal/presence/snapshot` + `/internal/cert` + `/healthz` + `/metrics`
- [ ] Rust：presence delta 推送（epoch/seq）+ 30s 对账
- [ ] Nest：`PresenceMirrorService`（epoch/seq/对账）+ `POST /internal/presence/delta` + `TransportBridgeService`（含 `toUsers`）+ `RT_TRANSPORT` 开关 + `/transport/config` 接真指纹
- [ ] Nest：`/internal/*` 隔离（§6.5 至少前两层）
- [ ] `groups.service.ts:124` fan-out 改 `toUsers` 单次调用
- [ ] 桌面：推送流消费 + seq/resync 对账
- 验收：Rust 集成测试覆盖 publish→帧到达、背压→resync；手动 curl 发消息对端实时收到 `message:new`；Rust 重启后 Nest 在线状态自愈；公网访问 `/internal/` 被拒

**P2 C2S 链路 + e2e 解耦（全量切流）**
- [ ] **先做**：e2e 改造为传输无关（`FakeTransportBridge` + supertest，D7）—— 后续所有改动都有回归网
- [ ] Nest：`internal-rt.controller.ts`（gateway 处理体 + `errorText` 迁入，文案逐字对齐）
- [ ] Rust：RPC 流 → forward 转发 → ack 回帧；unauthorized/token_expired 处理；滥用防护参数
- [ ] 桌面：sendMessage/markRead/rawEmitAck 切 WT 实现；重连风暴防护；`transport` 由服务端下发决定
- [ ] 协议版本协商（`minClientProto` 两端）
- 验收：§9 端到端清单全绿；原有 Nest 单测/e2e 不回归；`RT_TRANSPORT=socket` 一键回到旧路径

**P3 部署上线**
- [ ] Dockerfile（cargo-chef + ring provider）+ compose `transport` 服务 + UDP 防火墙/安全组 + OpenResty `/internal/` deny + GitHub Actions 独立 job（paths 过滤）
- [ ] `.env.example` 补全新变量（见 §13）；`deploy/README.md` 补 checklist
- [ ] VPS 联调：`/transport/config` 指纹下发、真机连接、慢网/丢 UDP 场景观察、滚动更新时 going_away 生效
- [ ] 观测面板（§12 指标）就绪，含**证书剩余有效期告警**
- 验收：线上两台真实设备全功能；回退开关演练一次；停掉 transport 容器验证自动降级 socket

**P4 清理（soak ≥ 1~2 周，且 `transport=socket` 活跃连接连续 7 天为 0）**
- [ ] 删 socket.io / socket.io-client 依赖、`events.gateway.ts`、`WsEventsService` 旧实现、guest 分支、`WS_STRICT_AUTH`、`toConversation`
- [ ] `/transport/config` 在 Rust 不可达时改为 503（不再降级）
- [ ] shared-types 删 socket.io 专属类型（`InterServerEvents`/`SocketData`/`WsAckCallback` 视情况）与注释
- [ ] AGENTS.md 更新数据流图、命令、进度与「关键约定」（新增：presence 镜像、internal 隔离、单副本约束）
- [ ] （可选）typing 事件补全；datagram 承载 typing/presence 实验；多副本方案（Redis pub/sub）评估

## 11. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| UDP 被墙/限速（跨境、企业网、部分运营商） | 连不上或高频抖动 | 服务端 `RT_TRANSPORT=socket` 一键回退（无需发版，D5）；后续可在 Rust 加 WS 旁路同协议 |
| WebView2 过旧或 `serverCertificateHashes` 不支持 | WebTransport 构造/握手失败 | spike S2/S3 前置验证；运行时 `typeof WebTransport` 检测 → 自动降级 socket；版本门槛兜底 |
| **自签证书 14 天到期未轮换** | 新连接被静默拒绝，渐进式故障 | 7 天定时重签 + 热替换 + 新旧双指纹（D3）；**指标监控证书剩余有效期并告警** |
| **presence 镜像与真实状态漂移** | `message:delivered` 漏推、在线点错误 | epoch 重建 + seq 去重 + 30s 全量对账 + diff 指标（D6） |
| **推送队列满导致静默丢消息** | 用户「消息消失」 | 禁止静默丢弃；resync 帧 / close 连接 → 客户端全量对账（D4/§5） |
| **`/internal/*` 公网可达** | 可伪造任意用户发消息 | OpenResty deny + 内部 token + IP 段校验 +（推荐）独立内网监听（§6.5），上线前 curl 验证 |
| 新旧客户端混跑 | 老客户端在 P4 后彻底失联 | `minClientProto` 版本协商 + 强制升级提示；P4 准入靠指标而非时间（§4） |
| 群 fan-out 放大为 N 次内部 HTTP | 大群发消息延迟/CPU 抖动 | `toUsers` 批量 publish（§5） |
| 双进程共享 JWT_SECRET，且未配置时 Nest 随机生成 | 鉴权全失败（现象隐蔽） | 两侧启动 fail-fast 强制显式配置；共用同一 env 文件（现状即是）；internal API 独立 token；3901 不映射 |
| 跨流乱序（RPC ack 与推送流之间） | 发送方可能先收到自己的 message:new 再收到 ack | chat-store 已按消息 id + clientMsgId 幂等合并，无感知；记录在案 |
| 单副本约束被忽视 | 加副本后一半用户收不到推送 | compose 注释 + AGENTS.md 写死（D8） |
| Rust 构建坑（aws-lc-rs/openssl/rcgen 版本） | CI 或镜像构建失败 | 显式 ring provider + rustls-tls + 版本对齐 + cargo-chef（§5） |
| OpenResty/CDN 不透传 QUIC | 部署踩坑 | UDP 直连方案已定；不上 CDN |

## 12. 观测与运维（灰度期的判据）

没有指标就无法判断「该不该回退」和「P4 能不能做」。Rust `GET /metrics`（Prometheus 文本格式即可，无需引 exporter 框架）+ Nest 侧计数：

**Rust 侧**
- `rt_connections_active`（按 userId 去重的在线用户数 / 连接数两个口径）
- `rt_hello_total{result=ok|auth_failed|timeout|too_old}`
- `rt_rpc_total{type,result}` + 转发 Nest 的 p50/p95 耗时
- `rt_push_sent_total{type}`、`rt_push_dropped_total`、`rt_resync_sent_total`
- `rt_publish_received_total` / 解析失败数
- **`rt_cert_valid_seconds`（证书剩余有效期）← 直接对应 D3 的静默故障，必须告警**
- `rt_conn_rejected_total{reason=ip_limit|rate_limit|bad_frame|user_conn_limit}`
- `rt_presence_delta_sent_total` / 推送失败数

**Nest 侧**
- `rt_publish_failed_total`（桥 → Rust 失败，含重试后失败）
- `rt_presence_reconcile_diff_total`（对账发现的差异条数；持续 > 0 说明 delta 链路有问题）
- `rt_presence_epoch_rebuild_total`（Rust 重启次数的间接指标）
- **活跃连接的 transport 分布**（`wt` vs `socket`）← P4 准入判据
- `/health` 在线数口径改为「在线用户数」并注明（§5）

**告警建议**：证书剩余 < 3 天；`rt_push_dropped_total` 5 分钟内 > 0；`rt_publish_failed_total` 5 分钟内 > 10；`rt_presence_reconcile_diff_total` 持续非零；`rt_connections_active` 骤降 > 50%。

## 13. 环境变量清单（`.env.example` 需补全）

**Nest（`apps/server/.env`）**
```bash
# 实时通道实现：socket（Socket.IO，默认）| wt（Rust WebTransport）
# 这是灰度/回退的权威开关，同时通过 GET /transport/config 下发给客户端
RT_TRANSPORT=socket
# Rust 传输服务的内网地址（RT_TRANSPORT=wt 时必填）
TRANSPORT_INTERNAL_URL=http://pigeon-transport:3901
# 下发给客户端的 WT 公网地址（RT_TRANSPORT=wt 时必填）
WT_PUBLIC_URL=https://example.com:4433/wt
# 内部 API 共享令牌（长随机，与 JWT_SECRET 不同源；两个服务必须一致）
WT_INTERNAL_TOKEN=
# ⚠️ RT_TRANSPORT=wt 时 JWT_SECRET 变为必填（否则 Nest 随机生成 → Rust 验签 100% 失败）
JWT_SECRET=
```
**Rust（`apps/transport-server`，与 Nest 共用 `/opt/pigeon/shared/env`）**
```bash
JWT_SECRET=                      # 必填，≥16 字节，与 Nest 完全一致
WT_BIND=0.0.0.0:4433             # QUIC/UDP 监听
WT_INTERNAL_BIND=0.0.0.0:3901    # internal HTTP（不映射公网）
NEST_URL=http://pigeon-server:3048   # 或 :3902（独立 internal 监听，见 §6.5）
WT_INTERNAL_TOKEN=               # 必填，与 Nest 一致
WT_CERT_ROTATE_DAYS=7            # 证书轮换周期（< 14 天有效期）
WT_MAX_CONN_PER_IP=20
WT_MAX_CONN_PER_USER=8
WT_RPC_RATE_LIMIT=20             # req/s per connection
RUST_LOG=info
```
**桌面（构建期，仅 dev 覆盖用）**
```bash
VITE_TRANSPORT=                  # 空=听服务端下发；wt|socket=本地强制（生产包内联，不要依赖它做灰度）
```

---

## spike 记录（S1–S4，待手动验证）

> **状态：代码已全部落地，运行时验证待人工执行**（LLM 无法真机验证 WebView2/UDP 环境）。
> spike 代码已按「验完即删」预留为 `apps/transport-server/examples/spike.rs`，不参与 CI。

### 验证步骤（按 §0 顺序）

**准备**（本机即可，无需 VPS）：

```bash
cd apps/transport-server
NEST_URL=http://localhost:3048 \
JWT_SECRET=dev-secret-0123456789abcdef \
WT_INTERNAL_TOKEN=dev-internal-0123456789abcdef \
WT_BIND=127.0.0.1:4433 \
WT_INTERNAL_BIND=127.0.0.1:3901 \
cargo run --example spike
# 启动打印：cert SHA-256 指纹 + 过期时间

# 另开终端取指纹（或直接看 spike 启动输出）:
curl -H "x-internal-token: dev-internal-0123456789abcdef" \
  http://127.0.0.1:3901/internal/cert
```

**S1 + S2（桌面端 dev 页 console / tauri dev）**：按 spike.rs 顶部注释的 JS 片段，
在 WebView2 里 `new WebTransport('https://127.0.0.1:4433/wt', {serverCertificateHashes, congestionControl:'low-latency'})`
→ `await wt.ready`。判定：不抛 `SecurityError`（S1）且握手成功（S2）。

| 项 | 预期 | 实测 | 结论 |
|----|------|------|------|
| S1 dev（http://localhost:1420）构造不抛 | `ready` resolve | ☐ | ☐ |
| S1 build 产物（http://tauri.localhost）构造不抛 | 同上 | ☐ | ☐ |
| S2 `serverCertificateHashes` 握手通过 | `ready` resolve；若失败记录报错原文（签名算法/有效期/SAN 任一不满足都是同句模糊报错） | ☐ | ☐ |
| S3 `serverCertificateHashes` 在 `MIN_WEBVIEW2_VERSION=120` 可用 | 握手成功即证明；失败则上调 `webview.rs` 门槛 + 同步单测 | ☐ | ☐ |
| S4 UDP 4433 本机可达 | hello 返回 welcome；health:ping RPC 有 ack | ☐ | ☐ |
| S4 VPS/弱网环境 | 同上；顺手记录「拔网线 30s 恢复」行为（wt.closed 触发退避重连） | ☐ | ☐ |

### 代码侧已替 S1–S4 铺好的兜底（无论 spike 结果都不阻塞灰度）

- 运行时 `typeof WebTransport === 'undefined'` 检测 → 自动回退 socket 实现；
- 服务端 `RT_TRANSPORT=socket`（默认）一键回退，无需发版；
- 证书参数已按规范实现：ECDSA P-256 叶子证书（IsCa::NoCa + digitalSignature + serverAuth）、
  SAN=localhost、14 天有效期（cert.rs 单测锁定）；客户端 `serverCertificateHashes` 传**指纹数组**兼容轮换窗口。

---

## 执行记录（LLM 已完成 vs 待人工验证）

| 阶段 | 内容 | 状态 |
|------|------|------|
| P0-pre | spike 代码（examples/spike.rs + 文档） | ✅ 代码 / ⬜ S1–S4 真机验证 |
| P0 | Rust：config(fail-fast)/cert(轮换+双指纹)/proto(累积缓冲+夹具)/auth/registry/conn(hello+welcome+health:ping)；根 Cargo.toml members；shared-types 传输契约 + fixtures；Nest `/transport/config`；桌面 frame/webtransport 状态机 | ✅（25 Rust 单测 + 8 回环集成测试 + 7 桌面帧测 + 15 transport 测试通过） |
| P1 | Rust：推送流+背压 resync+`/internal/publish`(users[]/broadcast)+snapshot+cert+healthz+metrics；presence delta(epoch/seq)+对账；Nest：PresenceMirror+TransportBridge+开关装配+真指纹下发+`/internal/*` 两层防线；`groups/sessions` fan-out 改 `toUsers`；桌面推送消费+seq/resync 对账 | ✅（回环集成测试覆盖 publish→帧/路由/going_away） |
| P2 | e2e 传输无关（FakeTransportBridge + supertest `/internal/rt/*`，12 个用例全过）；`internal-rt.controller`（文案逐字对齐）；Rust RPC 转发+token_expired+滥用防护；桌面 sendMessage/markRead 切 WT+重连风暴防护；minClientProto 协商两端 | ✅（`cargo test -p transport-server` 8 集成用例；e2e 12/12） |
| P3 | Dockerfile（cargo-chef+ring）+ compose transport 服务（UDP 4433、单副本注释）+ deploy-transport.yml（独立 paths 过滤）+ ci.yml cargo test + .env.example + deploy/README checklist | ✅ 代码 / ⬜ VPS 联调、真机端到端 |
| P4 | 清理 Socket.IO | ⬜ 按方案 soak 1–2 周后执行 |

**人工验证清单**（代码之外）：① spike S1–S4（上表）；② VPS 部署三步（deploy/README「Rust 传输网关」节）；
③ 双桌面实例端到端对打（§9 端到端行）；④ 回退演练（`RT_TRANSPORT=socket` 重启即回退）；
⑤ 公网 curl `/internal/*` 应 404/403。

---

参考资料：[web-transport-quinn crate（docs.rs）](https://docs.rs/web-transport-quinn/latest/web_transport_quinn/)、[Session API](https://docs.rs/web-transport-quinn/latest/web_transport_quinn/struct.Session.html)、[crates.io 版本页](https://crates.io/crates/web-transport-quinn)、[moq-dev/web-transport 示例仓库](https://github.com/moq-dev/web-transport)、[W3C WebTransport 规范（serverCertificateHashes）](https://www.w3.org/TR/webtransport/#dom-webtransportoptions-servercertificatehashes)
