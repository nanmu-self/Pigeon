//! Pigeon 实时传输网关 —— WebTransport(QUIC) 终结 + 连接注册表 + 定向投递。
//!
//! 职责边界（决策 D1/D8）：
//! - 本服务**只做传输**：JWT 验签、连接生命周期、presence 权威状态、S2C 投递
//! - 业务逻辑（消息落库、好友/群校验）全在 NestJS：C2S 经 internal HTTP 转发
//! - **单实例**：registry 在进程内存，不可多副本（D8）
//!
//! 布局：`src/main.rs` 是薄启动器；本 lib 承载全部逻辑，
//! 供集成测试（`tests/`）与 spike（`examples/spike.rs`）复用。

pub mod auth;
pub mod cert;
pub mod config;
pub mod conn;
pub mod forward;
pub mod internal;
pub mod metrics;
pub mod presence;
pub mod proto;
pub mod registry;
pub mod selfcheck;

use std::sync::Arc;

use quinn::crypto::rustls::QuicServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};

/// 构建带滥用防护传输参数的 quinn server config。
///
/// ⚠️ `max_concurrent_uni_streams` **不能设 0**：Chromium 的 HTTP/3 会话层
/// 需要 3 条 uni 控制流（control/QPACK encoder/decoder），设 0 会直接握手
/// 失败。给 8 条预算足够控制流使用，应用层客户端本就不开 uni 流。
pub fn quinn_transport_config(cfg: &config::Config) -> Arc<quinn::TransportConfig> {
    let mut transport = quinn::TransportConfig::default();
    // keepalive 10s / idle 30s：断网 30s 内快速感知（配客户端退避重连）
    transport.keep_alive_interval(Some(std::time::Duration::from_secs(10)));
    transport.max_idle_timeout(Some(
        quinn::IdleTimeout::try_from(quinn::VarInt::from_u32(30_000)).unwrap(),
    ));
    // 应用层客户端只开 bi 流（RPC）；uni 预算留给 H3 控制流
    transport.max_concurrent_uni_streams(quinn::VarInt::from_u32(8));
    transport.max_concurrent_bidi_streams(quinn::VarInt::from_u32(32));
    // 收紧接收窗口：单流 256KiB、连接 1MiB（聊天负载足够，防单连接吃带宽）
    transport.stream_receive_window(quinn::VarInt::from_u32(256 * 1024));
    transport.receive_window(quinn::VarInt::from_u32(1024 * 1024));
    // 低延迟优先（BBR，与浏览器端 congestionControl:'low-latency' 呼应）
    transport.congestion_controller_factory(Arc::new(quinn::congestion::BbrConfig::default()));
    let _ = cfg; // RPC 限速等参数在 conn 层生效
    Arc::new(transport)
}

/// rustls(TLS13, ring, ALPN=h3) + 传输参数 → quinn::ServerConfig
pub fn build_server_config(
    cfg: &config::Config,
    certs: &(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>),
) -> Result<quinn::ServerConfig, String> {
    let mut rustls_cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|e| format!("tls versions: {e}"))?
    .with_no_client_auth()
    .with_single_cert(certs.0.clone(), certs.1.clone_key())
    .map_err(|e| format!("cert/key mismatch: {e}"))?;
    // ALPN 必须是 h3（web_transport_quinn::ALPN）
    rustls_cfg.alpn_protocols = vec![b"h3".to_vec()];

    let quic_cfg =
        QuicServerConfig::try_from(rustls_cfg).map_err(|e| format!("quic config: {e}"))?;
    let mut server_cfg = quinn::ServerConfig::with_crypto(Arc::new(quic_cfg));
    server_cfg.transport_config(quinn_transport_config(cfg));
    Ok(server_cfg)
}

/// 创建 QUIC/UDP 监听（返回 endpoint 供证书轮换热替换）
pub async fn bind_endpoint(
    cfg: &config::Config,
    certs: &(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>),
) -> Result<quinn::Endpoint, String> {
    let server_cfg = build_server_config(cfg, certs)?;
    quinn::Endpoint::server(server_cfg, cfg.wt_bind).map_err(|e| format!("bind: {e}"))
}

/// SIGTERM/SIGINT（优雅关闭触发器）
pub async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("sigterm");
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
}
