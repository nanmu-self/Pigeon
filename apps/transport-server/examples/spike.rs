//! ⚠️ 手动验证用 spike（P0-pre S1–S4）——**不参与 CI**，验完可删。
//!
//! ```bash
//! cd apps/transport-server
//! NEST_URL=http://localhost:3048 \
//! JWT_SECRET=dev-secret-0123456789abcdef \
//! WT_INTERNAL_TOKEN=dev-internal-0123456789abcdef \
//! WT_BIND=127.0.0.1:4433 \
//! WT_INTERNAL_BIND=127.0.0.1:3901 \
//! cargo run --example spike
//! ```
//!
//! 启动后先取指纹（另开终端）：
//!
//! ```bash
//! curl -H "x-internal-token: dev-internal-0123456789abcdef" \
//!   http://127.0.0.1:3901/internal/cert
//! # → {"certSha256":["<base64>"],...}
//! ```
//!
//! 然后在桌面端 dev 页（WebView2 console）验证 —— 逐步对应 §0 的四项：
//!
//! ```js
//! // S1+S2：构造 + 握手（指纹来自上面 /internal/cert）
//! const fp = await (await fetch('http://127.0.0.1:3901/internal/cert', {
//!   headers: { 'x-internal-token': 'dev-internal-0123456789abcdef' },
//! })).json();
//! const raw = Uint8Array.from(atob(fp.certSha256[0]), c => c.charCodeAt(0));
//! const wt = new WebTransport('https://127.0.0.1:4433/wt', {
//!   serverCertificateHashes: [{ algorithm: 'sha-256', value: raw }], // ⚠️ 必须小写，Chromium 大小写敏感
//!   congestionControl: 'low-latency',
//! });
//! await wt.ready;                       // ← 不抛 SecurityError / 握手失败 = S1+S2 通过
//! console.log('S1/S2 OK');
//!
//! // hello（JWT 从桌面端登录后的 tokenStore 里取，或手贴）
//! const token = 'PASTE_JWT_HERE';
//! const bi = await wt.createBidirectionalStream();
//! const w = bi.writable.getWriter();
//! const send = (obj) => {
//!   const json = new TextEncoder().encode(JSON.stringify(obj));
//!   const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, json.length);
//!   w.write(len); w.write(json);
//! };
//! send({ v: 1, type: 'hello', token, clientProto: 1, clientVersion: 'spike' });
//! // 读 welcome：用 lib/transport/frame.ts 的累积缓冲读法（略，见该文件测试）
//! // 期望 {"type":"welcome","connId":...,"userId":"1",...}
//!
//! // health:ping RPC（同帧格式，新开 bi 流，{id:1,type:'health:ping'}）
//! // S3：WebView2 版本门槛 —— 记录 navigator.userAgentData / webview2 版本
//! // S4：换弱网/热点环境重试握手；「拔网线 30s」观察 closed promise 行为
//! ```

fn main() {
    rustls::crypto::ring::default_provider().install_default().ok();

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

    let cfg = std::sync::Arc::new(transport_server::config::Config::from_env());
    let metrics = std::sync::Arc::new(transport_server::metrics::Metrics::default());
    let certs = std::sync::Arc::new(transport_server::cert::RotatingCert::new().expect("cert"));
    let registry = std::sync::Arc::new(transport_server::registry::Registry::new(20, 8));
    let forwarder =
        std::sync::Arc::new(transport_server::forward::Forwarder::new(&cfg, metrics.clone()));
    let http = std::sync::Arc::new(forwarder.http().clone());

    {
        let cfg = cfg.clone();
        let registry = registry.clone();
        let certs = certs.clone();
        let metrics = metrics.clone();
        let forwarder = forwarder.clone();
        tokio::spawn(async move {
            transport_server::internal::serve(cfg, registry, certs, metrics, forwarder)
                .await
                .expect("internal http");
        });
    }

    let current = certs.current().await;
    let endpoint =
        transport_server::bind_endpoint(&cfg, &current).await.expect("bind");
    let info = certs.info().await;
    println!("──────────────────────────────────────────────");
    println!("WT_BIND      = {}", cfg.wt_bind);
    println!("INTERNAL     = {}  (GET /internal/cert 取指纹)", cfg.internal_bind);
    println!("cert SHA-256 = {}", info.cert_sha256);
    println!("expiresAt    = {} ms", info.expires_at_ms);
    println!("──────────────────────────────────────────────");

    let mut server = web_transport_quinn::Server::new(endpoint);
    loop {
        let Some(request) = server.accept().await else { break };
        let registry = registry.clone();
        let cfg = cfg.clone();
        let forwarder = forwarder.clone();
        let metrics = metrics.clone();
        let http = http.clone();
        tokio::spawn(async move {
            let remote_ip = request.conn().remote_address().ip();
            if !registry.try_acquire_ip(remote_ip) {
                let _ = request.reject(axum::http::StatusCode::TOO_MANY_REQUESTS).await;
                return;
            }
            match request.ok().await {
                Ok(session) => {
                    let conn = transport_server::conn::Conn {
                        session,
                        registry: registry.clone(),
                        cfg,
                        forwarder,
                        metrics,
                        http,
                    };
                    conn.run().await;
                }
                Err(e) => println!("handshake failed: {e}"),
            }
            registry.release_ip(remote_ip);
        });
    }
}
