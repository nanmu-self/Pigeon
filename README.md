# 🐦 Pigeon

<p align="center">
  <strong>安全、实时的端到端加密即时通讯平台（开发中）</strong>
</p>

<p align="center">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.0-24C8D9?logo=tauri" />
  <img alt="Svelte" src="https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte" />
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs" />
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-8-2D3748?logo=prisma" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.75%2B-000000?logo=rust" />
  <img alt="PNPM" src="https://img.shields.io/badge/PNPM-8%2B-F69220?logo=pnpm" />
</p>

---

## 📖 简介

Pigeon 是一款即时通讯（IM）应用，采用 monorepo 架构：SvelteKit/Tauri 桌面客户端 + NestJS 后端 + Rust 核心库。目前已跑通 **注册/登录（JWT）、Socket.IO 实时消息通道、本地 SQLite 聊天记录持久化** 的基础链路；端到端加密正在接入中（加密核心库已就绪）。

### 核心特性

- 🔒 **端到端加密（规划中）**：`encryption` crate 提供 AES-256-GCM 与 SHA256，逐步接入消息链路
- 🖥️ **桌面优先**：Tauri 2 构建轻量级跨平台桌面应用，Svelte 5 + Tailwind CSS 4 界面
- 🔄 **实时通信**：Socket.IO 双向通道，房间模型（用户级 / 会话级）、在线状态广播、JWT 握手鉴权
- 💾 **本地持久化**：Rust 侧嵌入式 SQLite（WAL 模式 + 版本化迁移），聊天记录离线可用
- 📤 **文件直传**：七牛云 Kodo「后端签凭证、前端直传」，文件流不落业务服务器，> 4 MB 自动分片 + 断点续传
- 🛡️ **服务端**：Prisma 8 + PostgreSQL，bcrypt 密码哈希，Socket.IO 与 HTTP 共用 CORS 白名单

## 🏗️ 项目结构

```
pigeon/
├── apps/
│   ├── desktop/               # Tauri 2 + SvelteKit 桌面客户端
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── api/       # alova HTTP 封装 + Socket.IO 客户端 + storage 取票
│   │   │   │   ├── upload/    # 七牛直传封装（qiniu-js 2.x + 类型声明）
│   │   │   │   ├── components/ui/  # shadcn-svelte 组件
│   │   │   │   ├── chat.ts    # 聊天状态管理
│   │   │   │   └── toast.ts
│   │   │   └── routes/
│   │   │       └── (app)/     # 登录后的主界面
│   │   │           ├── contacts/   # 通讯录
│   │   │           ├── messages/   # 消息
│   │   │           ├── files/      # 文件（七牛直传演示页）
│   │   │           └── settings/   # 设置（头像直传 + 昵称修改）
│   │   └── src-tauri/         # Rust 侧
│   │       └── src/
│   │           ├── main.rs / lib.rs   # Tauri 入口
│   │           ├── commands.rs        # Tauri 命令（前端 invoke 调用）
│   │           ├── db.rs              # SQLite 连接 + 嵌入式迁移（WAL）
│   │           ├── chat.rs / models.rs
│   │       └── tauri.conf.json
│   └── server/                # NestJS 12 后端
│       ├── src/
│       │   ├── auth/          # 注册 / 登录（bcrypt + JWT 签发）+ JWT 守卫
│       │   ├── users/         # 用户资料（GET/PATCH /users/me，含头像外链）
│       │   ├── storage/       # 七牛直传取票（上传凭证 HMAC-SHA1 签名、目录限制）
│       │   ├── ws/            # Socket.IO 网关（JWT 握手鉴权、presence、房间）
│       │   ├── prisma/        # Prisma Service 与 schema（contract.prisma）
│       │   ├── config.ts      # CORS 白名单（HTTP 与 Socket.IO 共用）
│       │   ├── main.ts        # 入口（默认端口 3048，读取 dotenv）
│       │   └── app.module.ts
│       └── .env.example
├── packages/
│   └── shared-types/          # 前后端共享 TypeScript 类型（含 Socket.IO 事件契约）
├── crates/
│   ├── encryption/            # AES-256-GCM 加解密 + SHA256 哈希
│   └── media-codec/           # 音视频编解码（预留，规划集成 FFmpeg）
├── Cargo.toml                 # Rust Workspace
└── pnpm-workspace.yaml        # PNPM Workspace
```

## 🔧 技术栈

### 前端（桌面端）
- **Tauri 2**：跨平台桌面应用框架，Rust 后端 + Web 前端
- **SvelteKit 2 + Svelte 5**：路由与响应式界面
- **Tailwind CSS 4 + shadcn-svelte**：样式与组件库（lucide 图标）
- **alova**：HTTP 请求库（登录 / 注册 / 取上传凭证等 REST 调用）
- **qiniu-js（2.x）**：七牛云直传 SDK（> 4 MB 自动分片、断点续传）
- **socket.io-client**：实时消息通道
- **SQLite**（via `rusqlite`，Rust 侧）：本地聊天记录，WAL 模式 + 版本化迁移

### 后端
- **NestJS 12**（SWC 编译）：企业级 Node.js 框架
- **Prisma 8 + PostgreSQL**（>= 15）：数据持久化
- **Socket.IO**（`@nestjs/websockets` + `@nestjs/platform-socket.io`）：实时双向通信，事件契约由 `@pigeon/shared-types` 约束
- **JWT**（`@nestjs/jwt`）：HTTP 签发 + WS 握手验签（`WS_STRICT_AUTH=true` 可强制拒绝无 token 连接）
- **七牛云签名**：Node 内置 crypto 按官方「上传凭证」规范 HMAC-SHA1 签发，零新增依赖
- **bcryptjs**：密码哈希（成本因子 10）
- **Vitest**：单元 / e2e 测试；**oxlint**：代码检查

### 核心层（Rust）
- **encryption**：AES-256-GCM 加解密、SHA256 哈希（E2EE 基础库）
- **media-codec**：编解码骨架（预留 FFmpeg 集成）

## 📦 架构与数据流

```
┌──────────────────────┐   Socket.IO + HTTP    ┌──────────────────┐
│   Desktop (Tauri 2)  │◄─────────────────────►│  Server (NestJS) │
│  Svelte 5 前端        │   alova REST (3048)   │  Prisma 8        │
└──────────┬───────────┘                       └────────┬─────────┘
           │ invoke (Tauri Commands)                    │
           ▼                                            ▼
┌──────────────────────┐                       ┌──────────────────┐
│  Rust (encryption /  │                       │   PostgreSQL     │
│  本地 SQLite pigeon.db)│                       │   User 表        │
└──────────────────────┘                       └──────────────────┘

实时通道（Socket.IO）：
- 房间：user:{userId}（一个用户的所有在线设备）、conversation:{convId}（会话广播）
- 客户端握手携带 auth.token，服务端验签 JWT；join/leave/消息均走类型化事件 + ack

文件直传（七牛云 Kodo）：
- 桌面端先 POST /storage/upload-token（JWT 鉴权）换受限上传凭证
- 再用 qiniu-js 凭 token 直传七牛上传域名，文件流不经过 NestJS
- 最终 URL = QINIU_DOMAIN + key（avatar / chat / file 按目录限制大小与类型）
```

## 📁 包职责

| 包 | 职责 |
|----|------|
| `@pigeon/desktop` | 桌面应用 UI（登录 / 通讯录 / 消息 / 文件）、alova HTTP、Socket.IO 客户端、本地消息管理、七牛直传封装 |
| `@pigeon/server` | 注册/登录（bcrypt + JWT）、Socket.IO 网关、七牛上传凭证签发、Prisma/PostgreSQL |
| `@pigeon/shared-types` | 共享类型：`User`、`Message`、`ApiResponse`、`MessageType`、上传契约（`UploadDir` / `UploadTicket`），以及类型化 Socket.IO 事件契约（含 ack） |
| `encryption` (crate) | AES-256-GCM 加解密、SHA256 哈希、密钥派生 |
| `media-codec` (crate) | 图片/视频压缩、格式转换、缩略图生成（骨架） |

## 🚀 快速开始

### 环境要求

- **Node.js**: >= 18.0.0
- **PNPM**: >= 8.0.0
- **Rust**: >= 1.75.0 (stable)
- **PostgreSQL**: >= 15
- **系统依赖**:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `pkg-config`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
  - **Windows**: Visual Studio C++ Build Tools, WebView2 Runtime（SQLite 由 rusqlite bundled 自带编译，无额外依赖）

### 安装步骤

```bash
# 1. 克隆仓库
git clone <repo-url> pigeon && cd pigeon

# 2. 安装 Node.js 依赖
pnpm install

# 3. 校验 Rust workspace
cargo check

# 4. 配置服务端环境变量
cp apps/server/.env.example apps/server/.env
# 编辑 .env 中的 DATABASE_URL，指向你的 PostgreSQL 实例

# 5. 同步数据库 schema（Prisma 8）
pnpm --filter @pigeon/server db:update
```

### 开发模式

```bash
pnpm dev           # 一个终端同时启动桌面端 + 服务端（concurrently）

# 或分开启动
pnpm dev:desktop   # Tauri 桌面应用（Vite dev server @ http://localhost:1420）
pnpm dev:server    # NestJS 后端（watch 模式 @ http://localhost:3048）
```

### 构建生产版本

```bash
pnpm build                                   # 构建桌面前端 + 服务端 TS
pnpm --filter @pigeon/desktop tauri build    # 打包桌面应用安装包
```

## 🛠️ 开发命令速查

```bash
# 桌面端
pnpm --filter @pigeon/desktop dev          # 仅 Vite 前端（浏览器调试）
pnpm --filter @pigeon/desktop check        # svelte-check 类型检查
pnpm --filter @pigeon/desktop tauri dev    # 完整桌面应用

# 后端
pnpm --filter @pigeon/server start:dev     # watch 模式
pnpm --filter @pigeon/server build         # nest build
pnpm --filter @pigeon/server lint          # oxlint
pnpm --filter @pigeon/server test          # Vitest 单测
pnpm --filter @pigeon/server test:e2e      # e2e 测试

# 数据库（Prisma 8）
pnpm --filter @pigeon/server db:update     # 应用 schema 变更
pnpm --filter @pigeon/server db:smoke      # 连接冒烟测试
pnpm --filter @pigeon/server contract:emit # 输出 contract.prisma

# Rust
cargo check -p encryption                  # 检查加密库
cargo check -p media-codec                 # 检查媒体库
cargo build --release -p pigeon-desktop-tauri

# 根级
pnpm check:types                           # 桌面 svelte-check + 服务端构建
pnpm test                                  # 服务端测试
```

## ⚙️ 服务端配置（apps/server/.env）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | PostgreSQL 连接串（必填） | 无 |
| `PORT` | HTTP / Socket.IO 监听端口 | `3048` |
| `CLIENT_ORIGINS` | CORS 白名单（逗号分隔，`*` 仅限内网调试） | Tauri dev（`http://localhost:1420`）与各平台生产 webview origin |
| `WS_STRICT_AUTH` | `true` 时拒绝未携带 token 的 WS 握手 | `false` |
| `QINIU_ACCESS_KEY` / `QINIU_SECRET_KEY` | 七牛云密钥对（[控制台](https://portal.qiniu.com/user/key)），用于签发前端直传凭证 | 未配置时 `/storage/*` 返回 503 |
| `QINIU_BUCKET` | 七牛存储空间名 | 无 |
| `QINIU_DOMAIN` | 空间外链域名（含协议，如 `https://cdn.example.com`） | 无 |
| `QINIU_REGION` | 存储区域：`z0` 华东 / `z1` 华北 / `z2` 华南 / `na0` 北美 / `as0` 东南亚 | `z0` |
| `QINIU_TOKEN_TTL` | 上传凭证有效期（秒） | `3600` |

## 📦 文件上传（七牛云直传）

采用「后端签凭证、前端直传」架构，文件流不经过业务服务器：

```
桌面端                        NestJS 服务端                     七牛云
  │ POST /storage/upload-token    │                              │
  │ (Bearer JWT) ───────────────▶│ 按 dir 签受限凭证             │
  │ ◀──── UploadTicket ──────────│ (scope 定向 key + insertOnly) │
  │                                                             │
  │ qiniu.upload(file, key, token) ───────────直传──────────────▶│
  │ ◀── returnBody(key/hash/fsize) ─────────────────────────────│
```

1. **取票**：前端携带 JWT 调 `POST /storage/upload-token`，后端按目录（`avatar` / `chat` / `file`）
   生成受限上传凭证：scope 定向到服务端生成的 key、`insertOnly` 禁止覆盖、
   `mimeLimit` / `fsizeLimit` 按目录收口；SecretKey 永不出服务端。
2. **直传**：前端用 `qiniu-js`（2.x）+ 凭证直传七牛上传域名，> 4 MB 自动分片、支持断点续传；
   最终 URL = `QINIU_DOMAIN + key`。
3. **会话凭证**（chat/file 目录）：`GET /storage/session-token?dir=chat|file` 颁发
   `scope=bucket + insertOnly` 的可复用凭证，前端在内存缓存、剩余 < 10 分钟时
   懒刷新、上传中 401 自动换票重试；key 由客户端按 `{dir}/{年月}/{uuid}.{ext}`
   生成（`chat/` 前缀配合七牛生命周期规则自动清理聊天媒体）。头像不走会话票，
   保持 per-file 票以在七牛侧强校验图片类型与大小。

前端标准用法（`apps/desktop/src/lib/upload/qiniu.ts`）：

```ts
import { uploadToQiniu, isUploadCanceled } from "$lib/upload/qiniu";

const handle = uploadToQiniu(file, {
  dir: "chat",                              // 'avatar' | 'chat' | 'file'
  fileName: file.name,
  onProgress: (p) => (percent = p.percent), // 0 ~ 100
});

const { url, key, hash } = await handle.done; // 外链：存库 / 发消息用 url
handle.cancel();                              // 随时取消（reject UploadCanceledError）
```

完整交互（队列 / 进度条 / 取消 / 重试 / 复制外链）见桌面端「文件」页 `/files`。
集成 AI 编码助手视角的详细规则见 `AGENTS.md` 的「七牛云文件直传」一节。

## 🔐 安全设计

| 安全层面 | 实现方案 | 状态 |
|----------|----------|------|
| **密码存储** | bcrypt（cost 10），服务端不存明文 | ✅ 已实现 |
| **认证** | JWT（HTTP 登录签发 + Socket.IO 握手验签） | ✅ 已实现 |
| **CORS** | HTTP 与 Socket.IO 共用来源白名单，覆盖 Tauri 各平台 origin | ✅ 已实现 |
| **本地存储** | SQLite 位于系统应用数据目录，WAL 模式 | ✅ 已实现 |
| **传输加密** | TLS 1.3（WSS / HTTPS，部署层） | 📋 部署时启用 |
| **端到端加密** | AES-256-GCM（`encryption` crate），每消息独立 Nonce | 🚧 接入中 |

## 📊 功能路线图

- [x] monorepo 项目骨架（PNPM + Cargo workspace）
- [x] Rust 加密库（AES-GCM + SHA256）
- [x] 桌面端 SQLite 本地持久化（嵌入式迁移 + WAL）
- [x] 用户注册 / 登录（bcrypt + JWT）
- [x] Socket.IO 实时通道（房间、presence、JWT 握手鉴权、ack 契约）
- [x] 七牛云文件直传（后端签凭证 + qiniu-js 前端直传，「文件」页落地）
- [x] 设置页：头像直传 + 昵称修改（`PATCH /users/me`，User 表新增 avatarUrl）
- [x] 登录页、通讯录、消息界面（SvelteKit + shadcn-svelte）
- [ ] 端到端加密接入消息链路（密钥交换协议）
- [ ] 好友关系与消息历史持久化（服务端）
- [ ] 单聊/群聊消息（图片、语音等多媒体）
- [ ] 离线消息同步与已读回执
- [ ] 消息搜索
- [ ] 媒体文件传输与压缩（`media-codec` + FFmpeg）
- [ ] 消息撤回与删除
- [ ] 多设备登录与消息漫游

## 🤝 贡献

欢迎提交 Issue 和 PR！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 开启 Pull Request

## 📄 License

MIT

---

<p align="center">
  Made with ❤️ by the Pigeon Team
</p>
