//! internal HTTP 服务（axum，默认 :3901，**不映射公网**）。
//!
//! Nest → Rust 方向的内部 API：
//! - `POST /internal/publish`          —— S2C 定向投递/广播
//! - `GET  /internal/presence/snapshot` —— presence 全量快照（Nest 镜像对账）
//! - `GET  /internal/cert`             —— 自签证书指纹（Nest 代理给客户端，≤30s 缓存）
//! - `GET  /healthz`                   —— 存活探针（Docker healthcheck 用 --selfcheck 打它）
//! - `GET  /metrics`                   —— Prometheus 文本指标
//!
//! 所有业务端点校验 `x-internal-token`（与 Nest 共享的长随机串）。

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::cert::RotatingCert;
use crate::config::Config;
use crate::forward::Forwarder;
use crate::metrics::SharedMetrics;
use crate::proto::{PublishInput, PushFrame};
use crate::registry::Registry;

#[derive(Clone)]
pub struct InternalState {
    pub registry: Arc<Registry>,
    pub certs: Arc<RotatingCert>,
    pub cfg: Arc<Config>,
    pub metrics: SharedMetrics,
    #[allow(dead_code)] // 转发器持有连接池；在此仅为延长生命周期
    pub forwarder: Arc<Forwarder>,
}

pub async fn serve(
    cfg: Arc<Config>,
    registry: Arc<Registry>,
    certs: Arc<RotatingCert>,
    metrics: SharedMetrics,
    forwarder: Arc<Forwarder>,
) -> std::io::Result<()> {
    let state = InternalState { registry, certs, cfg, metrics, forwarder };
    let listener = tokio::net::TcpListener::bind(state.cfg.internal_bind).await?;
    let bind = listener.local_addr()?;
    tracing::info!("internal HTTP listening on {bind}");
    axum::serve(listener, router(state)).await
}

/// internal 路由（独立抽出让集成测试复用：可绑 :0 随机端口）
pub fn router(state: InternalState) -> Router {
    Router::new()
        .route("/internal/publish", post(publish))
        .route("/internal/presence/snapshot", get(presence_snapshot))
        .route("/internal/cert", get(cert_info))
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics_route))
        .with_state(state)
}

/// 校验内部令牌（所有业务端点的第一道防线；IP 段校验由部署层完成 ——
/// 3901 不映射公网，容器网内才可达）
fn check_token(headers: &HeaderMap, expected: &str) -> Result<(), StatusCode> {
    match headers.get("x-internal-token").and_then(|v| v.to_str().ok()) {
        Some(v) if v == expected => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// Nest → Rust：S2C 投递。`users[]` 批量（群 fan-out 一次调用）或 `broadcast: true`。
async fn publish(
    State(state): State<InternalState>,
    headers: HeaderMap,
    Json(input): Json<PublishInput>,
) -> impl IntoResponse {
    if check_token(&headers, &state.cfg.internal_token).is_err() {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "unauthorized" })));
    }
    state.metrics.publish_received_total.inc();

    let seq = state.registry.next_seq();
    let frame = PushFrame::event(seq, &input.kind, input.payload);
    let delivered = if input.broadcast {
        state.registry.broadcast(frame).await
    } else {
        state.registry.publish_to_users(&input.users, frame).await
    };
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "delivered": delivered, "seq": seq })),
    )
}

/// presence 全量快照（Nest 启动时 + 每 30s 对账拉取）
async fn presence_snapshot(
    State(state): State<InternalState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    check_token(&headers, &state.cfg.internal_token)?;
    let snapshot = state.registry.snapshot();
    state.registry.next_seq(); // 快照本身也推进 seq，保证单调
    Ok(Json(snapshot))
}

/// 证书信息：全部仍有效指纹（轮换窗口期新旧并存）
async fn cert_info(
    State(state): State<InternalState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    check_token(&headers, &state.cfg.internal_token)?;
    let fps = state.certs.valid_fingerprints().await;
    Ok(Json(serde_json::json!({
        "certSha256": fps.iter().map(|f| f.cert_sha256.clone()).collect::<Vec<_>>(),
        "notAfterMs": fps.iter().map(|f| f.expires_at_ms).min().unwrap_or(0),
    })))
}

async fn healthz(State(state): State<InternalState>) -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "epoch": state.registry.epoch(),
        "onlineUsers": state.registry.online_user_count(),
        "connections": state.registry.connection_count(),
    }))
}

async fn metrics_route(State(state): State<InternalState>) -> impl IntoResponse {
    let users = state.registry.online_user_count();
    let conns = state.registry.connection_count();
    ([(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")], state.metrics.render(users, conns))
}
