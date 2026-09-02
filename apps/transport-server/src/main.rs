//! Pigeon 实时传输网关 —— 启动器（逻辑在 lib.rs / 各模块）。
//!
//! - QUIC/UDP 监听（WT_BIND）+ internal HTTP（WT_INTERNAL_BIND）
//! - 自签证书 7 天轮换热替换 + 剩余有效期指标
//! - SIGTERM/SIGINT 优雅关闭（广播 going_away 后退出）

use std::sync::Arc;

use metrics::Metrics;
use transport_server::{cert, config, conn, forward, internal, metrics, registry};

fn main() {
    // rustls 显式选 ring provider：避开 aws-lc-rs 的 cmake/nasm 构建依赖，
    // 同时 web-transport-quinn 也以 ring feature 启用（两边一致）。
    rustls::crypto::ring::default_provider().install_default().ok();

    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--selfcheck") {
        let bind = std::env::var("WT_INTERNAL_BIND").unwrap_or_else(|_| "0.0.0.0:3901".into());
        let host = bind
            .split(':')
            .next()
            .map(|h| if h == "0.0.0.0" { "127.0.0.1" } else { h })
            .unwrap_or("127.0.0.1")
            .to_string();
        let port = bind.rsplit(':').next().unwrap_or("3901").to_string();
        let code = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(transport_server::selfcheck::run(&format!("{host}:{port}")));
        std::process::exit(code);
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(async_main());
}

async fn async_main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,web_transport_quinn=warn,quinn=warn".into()),
        )
        .init();

    let cfg = Arc::new(config::Config::from_env()); // 缺 JWT_SECRET 等 → exit(1)
    let metrics = Arc::new(Metrics::default());

    // ── 自签证书（首签 + 7 天轮换热替换） ───────────────────────
    let certs = Arc::new(match cert::RotatingCert::new() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("fatal: 自签证书生成失败：{e}");
            std::process::exit(1);
        }
    });

    // ── QUIC/UDP 监听 ──────────────────────────────────────────
    let current = certs.current().await;
    let endpoint = match transport_server::bind_endpoint(&cfg, &current).await {
        Ok(endpoint) => endpoint,
        Err(e) => {
            eprintln!("fatal: 监听 {} 失败：{e}", cfg.wt_bind);
            std::process::exit(1);
        }
    };
    let mut server = web_transport_quinn::Server::new(endpoint.clone());
    tracing::info!(
        "webtransport listening on {} (public url 由 Nest 的 WT_PUBLIC_URL 下发)",
        cfg.wt_bind
    );

    // ── 注册表 / 转发器 / 内部 HTTP ────────────────────────────
    let registry = Arc::new(registry::Registry::new(cfg.max_conn_per_ip, cfg.max_conn_per_user));
    let forwarder = Arc::new(forward::Forwarder::new(&cfg, metrics.clone()));
    let http = Arc::new(forwarder.http().clone());

    {
        let cfg = cfg.clone();
        let registry = registry.clone();
        let certs = certs.clone();
        let metrics = metrics.clone();
        let forwarder = forwarder.clone();
        tokio::spawn(async move {
            internal::serve(cfg, registry, certs, metrics, forwarder)
                .await
                .expect("internal http server");
        });
    }

    // ── 证书轮换定时器（7 天；热替换不影响存量连接） ─────────────
    {
        let cfg = cfg.clone();
        let certs = certs.clone();
        let endpoint = endpoint.clone();
        tokio::spawn(async move {
            let interval = cert::RotatingCert::interval(&cfg);
            loop {
                tokio::time::sleep(interval).await;
                match certs.rotate().await {
                    Ok(new) => match transport_server::build_server_config(&cfg, &new) {
                        Ok(quinn_cfg) => {
                            endpoint.set_server_config(Some(quinn_cfg));
                            tracing::info!("证书已轮换并热替换");
                        }
                        Err(e) => tracing::error!("证书轮换后构建 config 失败：{e}"),
                    },
                    Err(e) => tracing::error!("证书轮换失败：{e}"),
                }
            }
        });
    }

    // ── 证书剩余有效期指标（每分钟刷新，配合告警：剩余 < 3 天告警） ──
    {
        let certs = certs.clone();
        tokio::spawn(async move {
            loop {
                if let Some(min_expires) = certs
                    .valid_fingerprints()
                    .await
                    .iter()
                    .map(|f| f.expires_at_ms)
                    .min()
                {
                    let remaining = (min_expires - now_millis()) / 1000;
                    metrics::CERT_VALID_SECONDS
                        .store(remaining.max(0) as u64, std::sync::atomic::Ordering::Relaxed);
                }
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            }
        });
    }

    // ── accept 循环 + 优雅关闭 ─────────────────────────────────
    loop {
        tokio::select! {
            request = server.accept() => {
                let Some(request) = request else { break };
                let registry = registry.clone();
                let cfg = cfg.clone();
                let forwarder = forwarder.clone();
                let metrics = metrics.clone();
                let http = http.clone();
                tokio::spawn(async move {
                    // IP 名额在 hello 前抢占：拒绝发生在最便宜的时刻
                    let remote_ip = request.conn().remote_address().ip();
                    if !registry.try_acquire_ip(remote_ip) {
                        metrics.conn_rejected_ip_limit.inc();
                        tracing::warn!(remote = %remote_ip, "per-ip connection limit, rejecting");
                        let _ = request.reject(axum::http::StatusCode::TOO_MANY_REQUESTS).await;
                        return;
                    }
                    match request.ok().await {
                        Ok(session) => {
                            let conn = conn::Conn { session, registry: registry.clone(), cfg, forwarder, metrics, http };
                            conn.run().await;
                        }
                        Err(e) => {
                            tracing::debug!(remote = %remote_ip, "wt handshake failed: {e}");
                        }
                    }
                    registry.release_ip(remote_ip);
                });
            }
            _ = transport_server::shutdown_signal() => {
                tracing::info!("收到关闭信号：广播 going_away 后退出");
                registry.going_away(registry.seq()).await;
                tokio::time::sleep(std::time::Duration::from_secs(3)).await; // 等 ≤3s
                break;
            }
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
