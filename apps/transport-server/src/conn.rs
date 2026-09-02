//! 单连接任务：hello 鉴权（5s 超时）→ 注册 → RPC 流循环 + 推送流写循环。
//!
//! 流布局（协议 v1，见 docs/webtransport-migration-plan.md §4）：
//! - hello：客户端开的第 1 条 bi 流，5s 内必须收到合法 hello
//! - RPC：  每请求一条新 bi 流，转发 Nest 后回帧即关（天然映射 emitWithAck）
//! - 推送： 服务端开的 1 条 uni 长流，`{seq, type, payload}` 顺序帧
//!
//! 投递语义（与旧 Socket.IO 网关逐条对齐）：
//! - 推送队列满**不允许静默丢帧**（丢帧但 seq 连续 = 客户端跳号检测失效 =
//!   用户看到「消息永久消失」）：先短超时写 resync，连 resync 都写不进 → close，
//!   客户端重连后走 onConnected 全量对账。
//! - health:ping 由 Rust 本地应答（含在线用户数），不打 Nest。
//!
//! 滥用防护（4433 是裸暴露的公网 UDP 端点）：
//! - hello 5s 超时；坏帧立即 close（不尝试恢复）
//! - 单 IP / 单用户连接上限（registry）
//! - 每连接 RPC 令牌桶限速 + 并发 RPC 流上限

use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use crate::auth::{self, Claims};
use crate::config::Config;
use crate::forward::Forwarder;
use crate::metrics::SharedMetrics;
use crate::presence;
use crate::proto::{
    self, FrameError, FrameReader, Hello, HelloErrorCode, HelloResult, PushFrame, RpcRequest,
    RpcResponse,
};
use crate::registry::{ConnHandle, Registry};

/// hello 超时：连接建立后 5s 内未收到合法 hello → 主动 close（防未鉴权连接堆积）
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// 推送帧写超时：QUIC 缓冲正常时远小于此；触发即认为连接劣化
const PUSH_WRITE_TIMEOUT: Duration = Duration::from_millis(200);
/// 单连接并发 RPC 流上限（滥用防护）
pub const MAX_CONCURRENT_RPC: usize = 32;
/// health:ping 在本地应答的事件名
const HEALTH_PING: &str = "health:ping";

/// 鉴权前的连接参数（accept 时已知的部分）
pub struct Conn {
    pub session: web_transport_quinn::Session,
    pub registry: Arc<Registry>,
    pub cfg: Arc<Config>,
    pub forwarder: Arc<Forwarder>,
    pub metrics: SharedMetrics,
    pub http: Arc<reqwest::Client>,
}

/// 鉴权后的完整连接状态（rpc/push 循环共享）
struct ConnState {
    session: web_transport_quinn::Session,
    registry: Arc<Registry>,
    forwarder: Arc<Forwarder>,
    metrics: SharedMetrics,
    conn_id: String,
    user_id: String,
    display_name: String,
    /// 保留：日志与未来按 IP 维度的运维操作
    #[allow(dead_code)]
    remote_ip: IpAddr,
    bucket: Mutex<TokenBucket>,
}

/// 令牌桶（每连接）：拒绝速率 = cfg.rpc_rate_limit req/s，突发 = 2s 额度
struct TokenBucket {
    tokens: f64,
    last: Instant,
    rate: f64,
    burst: f64,
}

impl TokenBucket {
    fn new(rate: f64) -> Self {
        let burst = rate * 2.0;
        Self { tokens: burst, last: Instant::now(), rate, burst }
    }

    fn allow(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

impl Conn {
    pub async fn run(self) {
        let conn_id = format!("{:016x}", rand::random::<u64>());
        let remote_ip = self.session.remote_address().ip();

        // ── 1. hello：第一条 bi 流，5s 超时 ──────────────────────
        let (mut hello_tx, mut hello_rx) =
            match tokio::time::timeout(HELLO_TIMEOUT, self.session.accept_bi()).await {
                Ok(Ok(pair)) => pair,
                _ => {
                    self.metrics.hello_timeout.inc();
                    tracing::warn!(conn_id, remote = %remote_ip, "hello timeout, closing");
                    self.session.close(1, b"hello_timeout");
                    return;
                }
            };

        let mut hello_reader = FrameReader::new(&mut hello_rx);
        let hello: Hello = match tokio::time::timeout(HELLO_TIMEOUT, hello_reader.read_frame()).await
        {
            Ok(Ok(hello)) => hello,
            Ok(Err(err @ (FrameError::TooLarge(_) | FrameError::BadJson(_)))) => {
                // 坏帧：立即 close，不尝试恢复（滥用防护）
                self.metrics.conn_rejected_bad_frame.inc();
                tracing::warn!(conn_id, remote = %remote_ip, "bad hello frame: {err}");
                self.session.close(2, b"bad_frame");
                return;
            }
            Ok(Err(FrameError::Closed)) | Ok(Err(FrameError::Io(_))) | Err(_) => {
                self.metrics.hello_timeout.inc();
                self.session.close(1, b"hello_timeout");
                return;
            }
        };

        // ── 2. 版本协商 ─────────────────────────────────────────
        if hello.v != 1 || hello.kind != "hello" {
            self.metrics.hello_total.inc();
            let _ = proto::write_frame(
                &mut hello_tx,
                &HelloResult::Error {
                    code: HelloErrorCode::AuthFailed,
                    message: Some("bad hello frame".into()),
                    min_proto: None,
                },
            )
            .await;
            self.session.close(2, b"bad_frame");
            return;
        }
        if hello.client_proto < proto::MIN_CLIENT_PROTO {
            self.metrics.hello_total.inc();
            self.metrics.hello_too_old.inc();
            let _ = proto::write_frame(
                &mut hello_tx,
                &HelloResult::Error {
                    code: HelloErrorCode::ClientTooOld,
                    message: Some("客户端版本过旧，请升级".into()),
                    min_proto: Some(proto::MIN_CLIENT_PROTO),
                },
            )
            .await;
            self.session.close(3, b"client_too_old");
            return;
        }

        // ── 3. JWT 验签 ────────────────────────────────────────
        self.metrics.hello_total.inc();
        let claims: Claims = match auth::verify(&self.cfg.jwt_secret, &hello.token) {
            Ok(claims) => claims,
            Err(_) => {
                self.metrics.hello_auth_failed.inc();
                let _ = proto::write_frame(
                    &mut hello_tx,
                    &HelloResult::Error {
                        code: HelloErrorCode::AuthFailed,
                        message: Some("登录状态已失效，请重新登录".into()),
                        min_proto: None,
                    },
                )
                .await;
                self.session.close(4, b"auth_failed");
                return;
            }
        };

        // ── 4. welcome（等价旧 connection:welcome） ─────────────
        let user_id = claims.user_id.clone();
        let display_name = claims.nickname.clone();
        if proto::write_frame(
            &mut hello_tx,
            &HelloResult::Welcome {
                conn_id: conn_id.clone(),
                user_id: user_id.clone(),
                server_time: now_millis(),
            },
        )
        .await
        .is_err()
        {
            return; // 客户端已消失
        }

        // ── 5. 开推送流 + 注册 ─────────────────────────────────
        let push_stream = match self.session.open_uni().await {
            Ok(stream) => stream,
            Err(e) => {
                tracing::warn!(conn_id, user = %user_id, "open push stream failed: {e}");
                return;
            }
        };

        let (push_tx, push_rx) = mpsc::channel::<PushFrame>(crate::registry::PUSH_QUEUE_CAPACITY);
        let handle = ConnHandle { conn_id: conn_id.clone(), remote_ip, tx: push_tx };
        let (first_conn, over_limit) = self.registry.insert(&user_id, handle);
        if over_limit {
            self.metrics.conn_rejected_user_limit.inc();
            tracing::warn!(conn_id, user = %user_id, "per-user connection limit exceeded");
            self.session.close(5, b"too_many_connections");
            return;
        }

        tracing::info!(conn_id, user = %user_id, remote = %remote_ip, first_conn, "wt connected");
        if first_conn {
            presence::push_delta(&self.cfg, &self.http, &self.registry, &user_id, true, &self.metrics).await;
        }

        // ── 6. 主循环：RPC / 推送 / token 过期 三方竞争 ─────────
        let exp_at = auth_exp_instant(&claims);
        let state = Arc::new(ConnState {
            session: self.session.clone(),
            registry: self.registry.clone(),
            forwarder: self.forwarder.clone(),
            metrics: self.metrics.clone(),
            conn_id,
            user_id,
            display_name,
            remote_ip,
            bucket: Mutex::new(TokenBucket::new(self.cfg.rpc_rate_limit)),
        });

        tokio::select! {
            r = rpc_accept_loop(state.clone()) => {
                if let Err(e) = r { tracing::debug!(conn_id = %state.conn_id, "rpc loop ended: {e}"); }
            }
            r = push_write_loop(state.clone(), push_stream, push_rx) => {
                if let Err(e) = r { tracing::debug!(conn_id = %state.conn_id, "push loop ended: {e}"); }
            }
            _ = tokio::time::sleep_until(exp_at) => {
                // 7 天 token 到期 → 主动断开；客户端重读 tokenStore，
                // 过期则提示重新登录（项目无 refresh token，预期行为）
                state.metrics.connections_closed_token_expired.inc();
                tracing::info!(conn_id = %state.conn_id, user = %state.user_id, "token expired, closing");
                state.session.close(6, b"token_expired");
            }
        }

        // ── 7. 清理：注销 + 末路 presence 离线 delta ────────────
        let last = self.registry.remove(&state.user_id, &state.conn_id);
        if last {
            presence::push_delta(&self.cfg, &self.http, &self.registry, &state.user_id, false, &self.metrics).await;
        }
        tracing::info!(conn_id = %state.conn_id, user = %state.user_id, last, "wt disconnected");
    }
}

/// 推送写循环：mpsc → `{seq, type, payload}` 顺序帧。
///
/// 背压处理（D4，关键）：写超时 → 发 resync（客户端收到即全量对账），
/// 连 resync 都写不进 → close，客户端重连兜底。
async fn push_write_loop(
    state: Arc<ConnState>,
    mut stream: web_transport_quinn::SendStream,
    mut rx: mpsc::Receiver<PushFrame>,
) -> Result<(), String> {
    let mut seq: u64 = 0;
    while let Some(mut frame) = rx.recv().await {
        seq += 1;
        frame.seq = seq;
        match tokio::time::timeout(PUSH_WRITE_TIMEOUT, proto::write_frame(&mut stream, &frame)).await
        {
            Ok(Ok(())) => {
                state.metrics.push_sent_total.inc();
                tracing::debug!(seq, kind = %frame.kind, user = %state.user_id, "push frame written");
            }
            _ => {
                // 写不进去：尝试 resync（消费一个 seq）
                state.metrics.push_dropped_total.inc();
                seq += 1;
                let resync = PushFrame::control(seq, "resync", "backpressure");
                state.metrics.resync_sent_total.inc();
                match tokio::time::timeout(
                    PUSH_WRITE_TIMEOUT,
                    proto::write_frame(&mut stream, &resync),
                )
                .await
                {
                    Ok(Ok(())) => {
                        tracing::warn!(user = %state.user_id, conn = %state.conn_id, "push backpressure → resync");
                    }
                    _ => {
                        state.metrics.connections_closed_backpressure.inc();
                        state.session.close(7, b"backpressure");
                        return Err("push stream stalled, closing".into());
                    }
                }
            }
        }
    }
    Ok(())
}

/// RPC accept 循环：每条新 bi 流一个任务；并发上限 32（限速另有令牌桶）
async fn rpc_accept_loop(state: Arc<ConnState>) -> Result<(), String> {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_RPC));
    loop {
        let (tx, rx) = state
            .session
            .accept_bi()
            .await
            .map_err(|e| format!("accept_bi: {e}"))?;
        let permit = semaphore
            .clone()
            .try_acquire_owned()
            .map_err(|_| "too many concurrent rpc streams".to_string())?;
        let state = state.clone();
        tokio::spawn(async move {
            handle_rpc_stream(state, tx, rx).await;
            drop(permit);
        });
    }
}

/// 单条 RPC 流：读请求 → 转发/本地应答 → 回帧 → 关流
async fn handle_rpc_stream(
    state: Arc<ConnState>,
    mut tx: web_transport_quinn::SendStream,
    mut rx: web_transport_quinn::RecvStream,
) {
    let mut reader = FrameReader::new(&mut rx);
    let request: RpcRequest = match reader.read_frame().await {
        Ok(req) => req,
        Err(err @ (FrameError::TooLarge(_) | FrameError::BadJson(_))) => {
            state.metrics.conn_rejected_bad_frame.inc();
            tracing::warn!(conn = %state.conn_id, "bad rpc frame: {err}");
            state.session.close(2, b"bad_frame");
            return;
        }
        Err(_) => return, // 客户端开了流又立刻关掉等噪音，忽略
    };
    state.metrics.rpc_total.inc();

    let allowed = state.bucket.lock().expect("token bucket").allow();
    if !allowed {
        state.metrics.rpc_rate_limited.inc();
        let resp = RpcResponse::error(request.id, "请求太频繁，请稍后再试", None);
        let _ = proto::write_frame(&mut tx, &resp).await;
        return;
    }

    let response = if request.kind == HEALTH_PING {
        // health:ping：Rust 本地应答（在线口径 = 注册表去重用户数）
        RpcResponse::ok(
            request.id,
            serde_json::json!({ "pong": now_millis(), "online": state.registry.online_user_count() }),
        )
    } else {
        match state
            .forwarder
            .forward(&request.kind, &state.user_id, &state.display_name, request.payload.clone())
            .await
        {
            // Nest 的 internal-rt 恒返回 {ok, data|error}（HTTP 200）；
            // 这里解包信封，业务错误原样透传（errorText 文案逐字一致）
            Ok(envelope) => match envelope.get("ok").and_then(serde_json::Value::as_bool) {
                Some(true) => RpcResponse::ok(
                    request.id,
                    envelope.get("data").cloned().unwrap_or(serde_json::Value::Null),
                ),
                _ => {
                    let error = envelope
                        .get("error")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("服务器开小差了，请稍后再试");
                    let code = envelope.get("code").and_then(serde_json::Value::as_str);
                    RpcResponse::error(request.id, error, code)
                }
            },
            Err(error) => {
                tracing::warn!(kind = %request.kind, user = %state.user_id, "forward failed: {error}");
                // 与旧网关 errorText() 的兜底文案逐字一致（客户端 toast 依赖）
                RpcResponse::error(request.id, "服务器开小差了，请稍后再试", None)
            }
        }
    };
    let _ = proto::write_frame(&mut tx, &response).await;
    // 流随 tx drop 自动 finish
}

fn auth_exp_instant(claims: &Claims) -> tokio::time::Instant {
    let exp = UNIX_EPOCH + Duration::from_secs(claims.exp);
    let now = SystemTime::now();
    // exp 已在验签时校验（带 30s leeway），这里 exp 恒在未来；
    // 若系统时钟回拨导致 exp < now，用极短超时保底
    match exp.duration_since(now) {
        Ok(d) => tokio::time::Instant::now() + d,
        Err(_) => tokio::time::Instant::now() + Duration::from_secs(1),
    }
}

fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bucket_allows_burst_then_limits() {
        let mut bucket = TokenBucket::new(20.0);
        // 突发额度 = 40
        for _ in 0..40 {
            assert!(bucket.allow());
        }
        assert!(!bucket.allow(), "突发耗尽后拒绝");
        // 时间推进 → 补充令牌
        bucket.last -= Duration::from_millis(100); // 模拟 0.1s
        assert!(bucket.allow(), "0.1s 补充 2 个令牌");
    }
}
