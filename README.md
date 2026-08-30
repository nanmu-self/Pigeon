# 🐦 Pigeon

<p align="center">
  <strong>安全、实时的端到端加密即时通讯平台</strong>
</p>

<p align="center">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.0-24C8D9?logo=tauri" />
  <img alt="Svelte" src="https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte" />
  <img alt="NestJS" src="https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.75%2B-000000?logo=rust" />
  <img alt="PNPM" src="https://img.shields.io/badge/PNPM-8%2B-F69220?logo=pnpm" />
</p>

---

## 📖 简介

Pigeon 是一款**端到端加密（E2EE）的即时通讯（IM）应用**，采用 monorepo 架构，结合了 Tauri 桌面客户端、NestJS 后端服务以及 Rust 高性能核心库，致力于提供安全、快速、跨平台的消息传递体验。

### 核心特性

- 🔒 **端到端加密**：AES-256-GCM 加密所有消息，服务端无法解密
- ⚡ **高性能**：Rust 处理加密与媒体编解码，避免 JS 性能瓶颈
- 🖥️ **桌面优先**：Tauri 2 构建轻量级跨平台桌面应用
- 🔄 **实时通信**：WebSocket 长连接，消息秒级送达
- 📦 **离线支持**：本地消息数据库，支持离线消息同步
- 🎨 **现代化 UI**：Svelte 5 响应式界面，流畅交互

## 🏗️ 项目结构

```
pigeon/
├── apps/
│   ├── desktop/           # Tauri 2 + Svelte 5 桌面客户端
│   │   ├── src/           # Svelte 前端代码
│   │   │   ├── lib/       # Svelte 组件与 stores
│   │   │   ├── routes/    # 页面路由
│   │   │   └── app.html   # HTML 入口
│   │   ├── static/        # 静态资源
│   │   ├── package.json
│   │   └── src-tauri/     # Rust 后端
│   │       ├── src/
│   │       │   ├── main.rs       # Tauri 入口
│   │       │   ├── commands.rs   # Tauri 命令（前端调用）
│   │       │   └── db/           # 本地 SQLite 数据库
│   │       ├── Cargo.toml
│   │       └── tauri.conf.json
│   └── server/            # NestJS 后端服务
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/         # 认证模块
│       │   │   ├── users/        # 用户管理
│       │   │   ├── messages/     # 消息路由
│       │   │   ├── websocket/    # WebSocket 网关
│       │   │   └── media/        # 媒体处理
│       │   ├── common/
│       │   │   └── decorators/
│       │   ├── config/
│       │   ├── main.ts
│       │   └── app.module.ts
│       └── package.json
├── packages/
│   └── shared-types/      # 前后端共享 TypeScript 类型
│       ├── index.ts
│       └── package.json
├── crates/
│   ├── encryption/        # AES-256-GCM 端到端加密 + SHA256 哈希
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── cipher.rs
│   │   │   └── hash.rs
│   │   └── Cargo.toml
│   └── media-codec/       # 音视频编解码（集成 FFmpeg）
│       ├── src/
│       │   ├── lib.rs
│       │   ├── decoder.rs
│       │   └── encoder.rs
│       └── Cargo.toml
├── .cargo/
│   └── config.toml        # Rust 构建配置
├── Cargo.toml             # Rust Workspace 根配置
├── package.json           # PNPM Workspace 根配置
└── pnpm-workspace.yaml    # PNPM 工作空间定义
```

## 🔧 技术栈

### 前端（桌面端）
- **Tauri 2**：跨平台桌面应用框架，Rust 后端 + Web 前端
- **Svelte 5**：现代化响应式前端框架
- **Vite 6**：极速开发服务器与构建工具
- **TypeScript 5**：类型安全
- **SQLite**（via Tauri）：本地消息存储

### 后端
- **NestJS**：企业级 Node.js 框架
- **TypeORM**：数据库 ORM
- **WebSocket**：实时双向通信
- **Passport/JWT**：认证与授权

### 核心层（Rust）
- **AES-256-GCM**：消息端到端加密
- **SHA2**：密码哈希
- **FFmpeg**（预留）：图片/视频压缩与转码
- **SQLite**（预留）：本地消息缓存

## 📦 架构与数据流

```
┌─────────────┐      WebSocket       ┌─────────────┐
│   Desktop   │◄────────────────────►│   Server    │
│  (Svelte)   │                      │  (NestJS)   │
└──────┬──────┘                      └──────┬──────┘
       │ Tauri Commands                      │
       ▼                                     ▼
┌─────────────┐                      ┌─────────────┐
│  Rust       │                      │  Database   │
│  (加密/编解码│                      │  (PostgreSQL)│
└─────────────┘                      └─────────────┘

消息流程：
1. 发送方：PlainText → Rust 加密 → CipherText → Server
2. 服务端：转发 CipherText（不解密）
3. 接收方：CipherText → Rust 解密 → PlainText → 界面展示
```

## 📁 包职责

| 包 | 职责 |
|----|------|
| `@pigeon/desktop` | 桌面应用 UI、Tauri 前端交互、本地消息管理 |
| `@pigeon/server` | 用户认证、消息路由、WebSocket 连接管理、离线存储 |
| `@pigeon/shared-types` | 前后端共享类型：`User`、`Message`、`Conversation`、`ApiResponse` |
| `encryption` | AES-256-GCM 加解密、SHA256 哈希、密钥派生 |
| `media-codec` | 图片/视频压缩、格式转换、缩略图生成 |

## 🚀 快速开始

### 环境要求

- **Node.js**: >= 18.0.0
- **PNPM**: >= 8.0.0
- **Rust**: >= 1.75.0 (stable)
- **系统依赖**:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `libwebkit2gtk-4.1-dev`, `build-essential`, `curl`, `wget`, `file`, `pkg-config`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`
  - **Windows**: Visual Studio C++ Build Tools, WebView2 Runtime

### 安装步骤

```bash
# 1. 克隆仓库
git clone <repo-url> pigeon && cd pigeon

# 2. 安装 Node.js 依赖
pnpm install

# 3. 校验 Rust workspace
cargo check

# 4. （可选）配置环境变量
cp apps/server/.env.example apps/server/.env
```

### 开发模式

```bash
# 同时启动前后端（需两个终端）
pnpm dev:desktop   # 终端 1：Tauri 桌面应用
pnpm dev:server    # 终端 2：NestJS 后端
```

### 构建生产版本

```bash
# 构建所有 TypeScript 包
pnpm build

# 构建 Rust 后端
cargo build --release

# 构建 Tauri 桌面应用
pnpm --filter @pigeon/desktop tauri build
```

## 🛠️ 开发命令速查

```bash
# 桌面端
pnpm --filter @pigeon/desktop dev        # 开发模式
pnpm --filter @pigeon/desktop build      # 构建前端
pnpm --filter @pigeon/desktop tauri build  # 构建桌面应用

# 后端
pnpm --filter @pigeon/server dev         # 开发模式（watch）
pnpm --filter @pigeon/server build       # 构建 TS
pnpm --filter @pigeon/server start       # 生产启动

# Rust
cargo check -p encryption                 # 检查加密库
cargo check -p media-codec                # 检查媒体库
cargo build --release -p pigeon-desktop-tauri  # 构建 Tauri 后端

# 类型检查
pnpm check:types
```

## 🔐 安全设计

| 安全层面 | 实现方案 |
|----------|----------|
| **传输加密** | TLS 1.3（WSS / HTTPS） |
| **端到端加密** | AES-256-GCM，每消息独立随机 Nonce |
| **密钥管理** | 本地密钥库（Tauri Keychain） + 密钥交换协议（预留） |
| **密码存储** | SHA256 + 随机 Salt，服务端不解密 |
| **内存安全** | 敏感操作用 Rust 实现，减少 JS 层内存暴露 |

## 📊 IM 核心功能路线图

- [x] 项目骨架与 monorepo 初始化
- [x] Rust 加密库（AES-GCM + SHA256）
- [ ] WebSocket 网关与消息路由
- [ ] 用户注册/登录与好友关系
- [ ] 单聊/群聊消息（文本、图片、语音）
- [ ] 离线消息同步与已读回执
- [ ] 本地 SQLite 消息存储
- [ ] 消息搜索
- [ ] 媒体文件传输与压缩
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
