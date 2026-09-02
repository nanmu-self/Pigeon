# Pigeon 实时传输网关（Rust WebTransport/QUIC）—— 多阶段构建（cargo-chef 依赖缓存）
#
# 关键点（docs/webtransport-migration-plan.md §5 构建期已知坑）：
#  - rustls 显式 ring provider（web-transport-quinn 以 default-features=false, ring 启用），
#    避免 aws-lc-rs 的 cmake/nasm 构建依赖 → 无需安装它们；
#  - reqwest 走 rustls-tls（无 openssl）→ 无 pkg-config/libssl-dev 需求；
#  - ring 的 C 代码编译需要 cc（gcc）与 libc 头 → 构建阶段安装 gcc libc6-dev；
#  - cargo-chef 分层缓存：依赖不变时 CI 增量构建只需几十秒。
#
# 构建产物为 debian-slim 上的 glibc 二进制；运行阶段自带 --selfcheck（healthcheck 用，
# slim 镜像无 curl/node）。

FROM rust:1-slim AS chef
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev git \
    && rm -rf /var/lib/apt/lists/* \
    && cargo install cargo-chef --locked
WORKDIR /app

FROM chef AS planner
# 工作区成员清单一个都不能少（crates/* 与 src-tauri 是根 workspace 成员，
# 缺了任何一个 cargo 都会因 manifest 解析失败而报错）——.dockerignore 已排除的目录
# 用「精确 COPY」绕开（dockerignore 对显式路径的 COPY 不生效）
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY apps/desktop/src-tauri apps/desktop/src-tauri
COPY apps/transport-server apps/transport-server
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# 依赖层：Cargo.toml/lock 未变时命中缓存
RUN cargo chef cook --recipe-path recipe.json --bin transport-server --release
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY apps/desktop/src-tauri apps/desktop/src-tauri
COPY apps/transport-server apps/transport-server
RUN cargo build --release --bin transport-server

FROM debian:bookworm-slim AS runtime
# CA 证书：reqwest(rustls) 拉取 HTTPS 时不校验系统信任链缺失影响内网 http 调用，但保留以防内部 TLS
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 pigeon
COPY --from=builder /app/target/release/transport-server /usr/local/bin/transport-server
USER pigeon
# WT_BIND(UDP 4433) 与 WT_INTERNAL_BIND(HTTP 3901) 由 compose 决定映射；容器内不 EXPOSE UDP 亦可运行
EXPOSE 3901/tcp
ENV RUST_LOG=info
# Docker healthcheck：slim 无 curl/node，用二进制自带的 --selfcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["transport-server", "--selfcheck"]
ENTRYPOINT ["/usr/local/bin/transport-server"]
