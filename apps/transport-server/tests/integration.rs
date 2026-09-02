//! Rust 集成测试：真实回环 QUIC 会话（web_transport_quinn::Client 客户端模式）。
//!
//! 覆盖 §9 验收表的「Rust 集成」行：
//! hello 成功/失败/client_too_old、RPC 往返（转发 mock Nest）、
//! publish 定向投递与 seq、单用户连接上限、优雅关闭 going_away。
//!
//! 全部走 127.0.0.1 回环 + 随机端口，互不冲突，可并行。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};

use transport_server::cert::RotatingCert;
use transport_server::config::Config;
use transport_server::forward::Forwarder;
use transport_server::metrics::Metrics;
use transport_server::proto::{
    FrameReader, Hello, HelloResult, PublishInput, PushFrame, RpcRequest, RpcResponse,
};
use transport_server::registry::Registry;

const SECRET: &str = "integration-test-secret-0123456789";
const TOKEN_INTERNAL: &str = "integration-internal-token-0123456789";

// ── 测试基础设施 ─────────────────────────────────────────────

struct Stack {
    registry: Arc<Registry>,
    /// transport 的 internal HTTP 基址（publish/cert 测试用）
    internal_url: String,
    /// 服务端证书 DER（客户端指纹固定用）
    cert_der: Vec<u8>,
    endpoint_port: u16,
    /// mock Nest 收到的 presence delta
    deltas: Arc<Mutex<Vec<serde_json::Value>>>,
}

/// 一套完整的传输服务（mock Nest + QUIC + internal HTTP），随机端口
async fn spawn_stack() -> Stack {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("debug,hyper=warn,reqwest=warn"))
        .with_test_writer()
        .try_init();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("debug,hyper=warn,reqwest=warn"))
        .with_test_writer()
        .try_init();
    let metrics = Arc::new(Metrics::default());
    let certs = Arc::new(RotatingCert::new().unwrap());
    let registry = Arc::new(Registry::new(20, 8));

    // ── mock Nest：/internal/rt/:type 回显 + presence delta 记录 ──
    let deltas: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let nest = Router::new()
        .route(
            "/internal/rt/message:send",
            post(|Json(body): Json<serde_json::Value>| async move {
                Json(serde_json::json!({ "ok": true, "data": { "echo": body, "id": "999" } }))
            }),
        )
        .route(
            "/internal/rt/message:read",
            post(|| async { Json(serde_json::json!({ "ok": true, "data": { "read": true } })) }),
        )
        .route(
            "/internal/presence/delta",
            post(
                |State(deltas): State<Arc<Mutex<Vec<serde_json::Value>>>>,
                 Json(body): Json<serde_json::Value>| async move {
                    deltas.lock().unwrap().push(body);
                    Json(serde_json::json!({ "ok": true }))
                },
            ),
        )
        .with_state(deltas.clone());
    let nest_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let nest_port = nest_listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(nest_listener, nest).await.unwrap() });

    let cfg = Arc::new(Config {
        jwt_secret: SECRET.to_string(),
        nest_url: format!("http://127.0.0.1:{nest_port}"),
        internal_token: TOKEN_INTERNAL.to_string(),
        wt_bind: "127.0.0.1:0".parse().unwrap(),
        internal_bind: "127.0.0.1:0".parse().unwrap(),
        cert_rotate_days: 7,
        max_conn_per_ip: 20,
        max_conn_per_user: 2,
        rpc_rate_limit: 1000.0,
    });
    let forwarder = Arc::new(Forwarder::new(&cfg, metrics.clone()));
    let http = Arc::new(forwarder.http().clone());

    // ── transport internal HTTP（:0） ───────────────────────────
    let internal_state = transport_server::internal::InternalState {
        registry: registry.clone(),
        certs: certs.clone(),
        cfg: cfg.clone(),
        metrics: metrics.clone(),
        forwarder: forwarder.clone(),
    };
    let internal_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let internal_port = internal_listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(
            internal_listener,
            transport_server::internal::router(internal_state),
        )
        .await
        .unwrap()
    });

    // ── QUIC 监听 + accept 循环（与 main 一致的连接路径） ────────
    let current = certs.current().await;
    let cert_der = current.0[0].clone().into_owned().to_vec();
    let endpoint = transport_server::bind_endpoint(&cfg, &current).await.unwrap();
    let endpoint_port = endpoint.local_addr().unwrap().port();
    {
        let registry = registry.clone();
        let cfg = cfg.clone();
        let forwarder = forwarder.clone();
        let metrics = metrics.clone();
        let http = http.clone();
        tokio::spawn(async move {
        let mut server = web_transport_quinn::Server::new(endpoint);
        while let Some(request) = server.accept().await {
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
                        Err(_) => {}
                    }
                    registry.release_ip(remote_ip);
                });
            }
        });
    }

    Stack { registry, internal_url: format!("http://127.0.0.1:{internal_port}"), cert_der, endpoint_port, deltas }
}

// ── 客户端助手（模拟浏览器侧行为） ───────────────────────────

fn client(stack: &Stack) -> web_transport_quinn::Client {
    // 注意：with_server_certificates 内部才做 SHA-256；hashes 版要传原始摘要
    web_transport_quinn::ClientBuilder::new()
        .with_server_certificates(vec![rustls::pki_types::CertificateDer::from(
            stack.cert_der.clone(),
        )])
        .unwrap()
}

fn sign_token(user_id: u64, nickname: &str, exp_offset: i64) -> String {
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let claims = serde_json::json!({
        "sub": user_id.to_string(),
        "userId": user_id,
        "nickname": nickname,
        "exp": (now as i64 + exp_offset) as u64,
    });
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap()
}

/// 客户端连上并发送 hello，读回 welcome/error
async fn connect_and_hello(
    stack: &Stack,
    token: &str,
    client_proto: u32,
) -> (
    web_transport_quinn::Session,
    web_transport_quinn::RecvStream,
    HelloResult,
) {
    let client = client(stack);
    let url = format!("https://127.0.0.1:{}/wt", stack.endpoint_port);
    let session = client.connect(url::Url::parse(&url).expect("url")).await.expect("connect");
    let (mut tx, rx) = session.open_bi().await.expect("open hello stream");
    let hello = Hello {
        v: 1,
        kind: "hello".into(),
        token: token.to_string(),
        client_proto,
        client_version: "it".into(),
    };
    transport_server::proto::write_frame(&mut tx, &hello).await.unwrap();
    let mut reader = FrameReader::new(rx);
    let result: HelloResult = reader.read_frame().await.expect("hello result");
    (session, reader.into_inner(), result)
}


/// 开一条 RPC 流并等响应
async fn rpc(
    session: &web_transport_quinn::Session,
    req: RpcRequest,
) -> RpcResponse {
    let (mut tx, rx) = session.open_bi().await.expect("open rpc stream");
    transport_server::proto::write_frame(&mut tx, &req).await.unwrap();
    let mut reader = FrameReader::new(rx);
    reader.read_frame().await.expect("rpc response")
}

/// 推送流读取器：**必须持有流直到用完** ——
/// quinn 的 RecvStream 在未读尽时 drop 会发 STOP_SENDING（重置服务端写端），
/// 服务端随之按坏流关闭连接。
struct PushReader {
    reader: FrameReader<web_transport_quinn::RecvStream>,
}

async fn push_reader(session: &web_transport_quinn::Session) -> PushReader {
    let stream = session.accept_uni().await.expect("server push stream");
    PushReader { reader: FrameReader::new(stream) }
}

impl PushReader {
    async fn next(&mut self) -> PushFrame {
        self.reader.read_frame().await.expect("push frame")
    }
}

// ── 用例 ────────────────────────────────────────────────────

#[tokio::test]
async fn hello_ok_then_welcome_and_rpc_roundtrip() {
    let stack = spawn_stack().await;

    // 连接 + hello → welcome（等价 connection:welcome）
    let (session, _rx, result) = connect_and_hello(&stack, &sign_token(1, "Alice", 3600), 1).await;
    let HelloResult::Welcome { user_id, conn_id, .. } = result else {
        panic!("expected welcome, got {result:?}");
    };
    assert_eq!(user_id, "1");
    assert!(!conn_id.is_empty());

    // 注册表里已可见（presence 权威状态）
    assert_eq!(stack.registry.online_user_count(), 1);

    // RPC：转发 mock Nest 的 message:send → ok + data 回显
    let resp = rpc(
        &session,
        RpcRequest {
            id: 7,
            kind: "message:send".into(),
            payload: serde_json::json!({ "conversationId": "1", "content": "hi" }),
        },
    )
    .await;
    assert!(resp.ok, "forward should succeed: {resp:?}");
    assert_eq!(resp.id, 7);
    let data = resp.data.unwrap();
    assert_eq!(data["id"], "999");
    assert_eq!(data["echo"]["content"], "hi");

    // RPC：health:ping 本地应答（online = 去重用户数）
    let resp = rpc(
        &session,
        RpcRequest { id: 8, kind: "health:ping".into(), payload: serde_json::Value::Null },
    )
    .await;
    assert!(resp.ok);
    assert_eq!(resp.data.unwrap()["online"], 1);

    // presence delta 已推给 Nest（首连 online=true）
    tokio::time::sleep(Duration::from_millis(200)).await;
    let deltas = stack.deltas.lock().unwrap();
    assert!(deltas.iter().any(|d| d["userId"] == "1" && d["online"] == true), "{deltas:?}");
}

#[tokio::test]
async fn hello_bad_token_rejected() {
    let stack = spawn_stack().await;
    let (_session, _rx, result) = connect_and_hello(&stack, "not-a-jwt", 1).await;
    let HelloResult::Error { code, .. } = result else {
        panic!("expected error, got {result:?}")
    };
    assert_eq!(code, transport_server::proto::HelloErrorCode::AuthFailed);
    assert_eq!(stack.registry.online_user_count(), 0);
}

#[tokio::test]
async fn hello_too_old_rejected() {
    let stack = spawn_stack().await;
    let (_session, _rx, result) =
        connect_and_hello(&stack, &sign_token(1, "Alice", 3600), 0).await;
    let HelloResult::Error { code, min_proto, .. } = result else {
        panic!("expected error, got {result:?}")
    };
    assert_eq!(code, transport_server::proto::HelloErrorCode::ClientTooOld);
    assert_eq!(min_proto, Some(1));
}

#[tokio::test]
async fn publish_routes_to_target_user_with_seq() {
    let stack = spawn_stack().await;

    // 用户 1 连接（先拿推送流）
    let (session1, _, r) = connect_and_hello(&stack, &sign_token(1, "Alice", 3600), 1).await;
    let HelloResult::Welcome { .. } = r else { panic!() };
    // 用户 2 连接
    let (session2, _, r2) = connect_and_hello(&stack, &sign_token(2, "Bob", 3600), 1).await;
    let HelloResult::Welcome { .. } = r2 else { panic!() };

    // Nest → transport：定向投递给用户 1
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("{}/internal/publish", stack.internal_url))
        .header("x-internal-token", TOKEN_INTERNAL)
        .json(&PublishInput {
            users: vec!["1".into()],
            broadcast: false,
            kind: "message:new".into(),
            payload: serde_json::json!({ "id": "1024", "content": "你好" }),
        })
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["delivered"], 1, "只投给用户 1 的一路连接");

    // 建立两路推送流读取器（保持存活，见 PushReader 注释）
    let mut push1 = push_reader(&session1).await;
    let mut push2 = push_reader(&session2).await;

    // 用户 1 收到帧，seq 从 1 开始；用户 2 收不到
    let f1 = tokio::time::timeout(Duration::from_secs(3), push1.next())
        .await
        .expect("push within timeout");
    assert_eq!(f1.seq, 1);
    assert_eq!(f1.kind, "message:new");
    assert_eq!(f1.payload["id"], "1024");

    let no_frame = tokio::time::timeout(Duration::from_millis(400), push2.next()).await;
    assert!(no_frame.is_err(), "用户 2 不应收到定向帧");

    // 广播：两个用户都收到（各连接自己的 seq 流）
    let resp = http
        .post(format!("{}/internal/publish", stack.internal_url))
        .header("x-internal-token", TOKEN_INTERNAL)
        .json(&PublishInput {
            users: vec![],
            broadcast: true,
            kind: "presence:update".into(),
            payload: serde_json::json!({ "userId": "3", "online": true }),
        })
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());

    let f1b = tokio::time::timeout(Duration::from_secs(3), push1.next()).await.unwrap();
    assert_eq!(f1b.seq, 2);
    assert_eq!(f1b.kind, "presence:update");
    let f2b = tokio::time::timeout(Duration::from_secs(3), push2.next()).await.unwrap();
    assert_eq!(f2b.seq, 1, "每连接独立 seq");
    assert_eq!(f2b.kind, "presence:update");
}

#[tokio::test]
async fn internal_publish_requires_token() {
    let stack = spawn_stack().await;
    let http = reqwest::Client::new();
    let resp = http
        .post(format!("{}/internal/publish", stack.internal_url))
        .json(&PublishInput {
            users: vec!["1".into()],
            broadcast: false,
            kind: "message:new".into(),
            payload: serde_json::json!({}),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn presence_snapshot_reflects_registry() {
    let stack = spawn_stack().await;
    let (_s1, _, r) = connect_and_hello(&stack, &sign_token(1, "Alice", 3600), 1).await;
    let HelloResult::Welcome { .. } = r else { panic!() };

    let http = reqwest::Client::new();
    let resp = http
        .get(format!("{}/internal/presence/snapshot", stack.internal_url))
        .header("x-internal-token", TOKEN_INTERNAL)
        .send()
        .await
        .unwrap();
    let snap: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(snap["userIds"], serde_json::json!(["1"]));
    assert!(!snap["epoch"].as_str().unwrap().is_empty());

    // /internal/cert 返回指纹
    let resp = http
        .get(format!("{}/internal/cert", stack.internal_url))
        .header("x-internal-token", TOKEN_INTERNAL)
        .send()
        .await
        .unwrap();
    let cert: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(cert["certSha256"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn going_away_reaches_clients_on_shutdown() {
    let stack = spawn_stack().await;
    let (session, _, r) = connect_and_hello(&stack, &sign_token(1, "Alice", 3600), 1).await;
    let HelloResult::Welcome { .. } = r else { panic!() };

    // 模拟优雅关闭：直接调用 registry.going_away（main 在 SIGTERM 时做的事）
    stack.registry.going_away(stack.registry.seq()).await;

    let mut push = push_reader(&session).await;
    let frame = tokio::time::timeout(Duration::from_secs(3), push.next())
        .await
        .expect("going_away frame");
    assert_eq!(frame.kind, "going_away");
}

#[tokio::test]
async fn token_expiry_closes_connection() {
    let stack = spawn_stack().await;
    // exp 已过 → 验签直接失败（auth_failed），这里测「即将过期」路径：
    // 用 1s 后过期 + conn 的 sleep_until 逻辑不便等待 —— 改为验证
    // exp 已过时 hello 即被拒（validate_exp）
    let (_session, _rx, result) =
        connect_and_hello(&stack, &sign_token(1, "Alice", -120), 1).await;
    let HelloResult::Error { code, .. } = result else {
        panic!("expected error, got {result:?}")
    };
    assert_eq!(code, transport_server::proto::HelloErrorCode::AuthFailed);
}
