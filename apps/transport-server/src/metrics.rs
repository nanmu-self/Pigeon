//! 轻量指标（Prometheus 文本格式，`GET /metrics`）。
//!
//! 不引 exporter 框架 —— 拒绝路径、推送失败、证书剩余有效期等
//! 是「被刷了也不知道」的止损线，必须有计数。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Default)]
pub struct Metrics {
    /// 在线用户数（去重，gauge 由 /metrics 现算，不存这里）
    pub hello_total: Counter,
    pub hello_auth_failed: Counter,
    pub hello_timeout: Counter,
    pub hello_too_old: Counter,
    pub rpc_total: Counter,
    pub rpc_forward_failed: Counter,
    pub rpc_rate_limited: Counter,
    pub push_sent_total: Counter,
    pub push_dropped_total: Counter,
    pub resync_sent_total: Counter,
    pub publish_received_total: Counter,
    pub publish_parse_failed: Counter,
    pub conn_rejected_ip_limit: Counter,
    pub conn_rejected_bad_frame: Counter,
    pub conn_rejected_user_limit: Counter,
    pub presence_delta_sent_total: Counter,
    pub presence_delta_failed_total: Counter,
    pub connections_closed_token_expired: Counter,
    pub connections_closed_backpressure: Counter,
}

/// 证书剩余有效期（秒）—— 对应 D3 的静默故障，必须告警
pub static CERT_VALID_SECONDS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default)]
pub struct Counter(AtomicU64);

impl Counter {
    pub fn inc(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    pub fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

fn line(out: &mut String, name: &str, help: &str, value: u64) {
    out.push_str(&format!("# HELP {name} {help}\n# TYPE {name} counter\n{name} {value}\n"));
}

impl Metrics {
    /// Prometheus 文本格式（0.0.4）
    pub fn render(&self, online_users: usize, connections: usize) -> String {
        let mut out = String::with_capacity(2048);
        out.push_str(&format!(
            "# HELP rt_connections_active 在线用户数（按 userId 去重）\n# TYPE rt_connections_active gauge\nrt_connections_active {online_users}\n"
        ));
        out.push_str(&format!(
            "# HELP rt_connections_total WT 连接数（多设备口径）\n# TYPE rt_connections_total gauge\nrt_connections_total {connections}\n"
        ));
        let cert_secs = CERT_VALID_SECONDS.load(Ordering::Relaxed);
        out.push_str(&format!(
            "# HELP rt_cert_valid_seconds 证书剩余有效期（秒；< 259200 即 3 天应告警）\n# TYPE rt_cert_valid_seconds gauge\nrt_cert_valid_seconds {cert_secs}\n"
        ));

        line(&mut out, "rt_hello_total", "hello 处理总数", self.hello_total.get());
        line(&mut out, "rt_hello_auth_failed_total", "hello 鉴权失败数", self.hello_auth_failed.get());
        line(&mut out, "rt_hello_timeout_total", "hello 5s 超时数", self.hello_timeout.get());
        line(&mut out, "rt_hello_too_old_total", "客户端协议过旧数", self.hello_too_old.get());
        line(&mut out, "rt_rpc_total", "RPC 处理总数", self.rpc_total.get());
        line(&mut out, "rt_rpc_forward_failed_total", "转发 Nest 失败数", self.rpc_forward_failed.get());
        line(&mut out, "rt_rpc_rate_limited_total", "RPC 限流次数", self.rpc_rate_limited.get());
        line(&mut out, "rt_push_sent_total", "推送帧发送数", self.push_sent_total.get());
        line(&mut out, "rt_push_dropped_total", "背压丢弃数（>0 需告警）", self.push_dropped_total.get());
        line(&mut out, "rt_resync_sent_total", "resync 控制帧发送数", self.resync_sent_total.get());
        line(&mut out, "rt_publish_received_total", "Nest publish 请求数", self.publish_received_total.get());
        line(&mut out, "rt_publish_parse_failed_total", "publish 载荷解析失败数", self.publish_parse_failed.get());
        line(&mut out, "rt_conn_rejected_ip_limit_total", "单 IP 连接上限拒绝数", self.conn_rejected_ip_limit.get());
        line(&mut out, "rt_conn_rejected_user_limit_total", "单用户连接上限拒绝数", self.conn_rejected_user_limit.get());
        line(&mut out, "rt_conn_rejected_bad_frame_total", "坏帧拒绝数", self.conn_rejected_bad_frame.get());
        line(&mut out, "rt_presence_delta_sent_total", "presence delta 发送数", self.presence_delta_sent_total.get());
        line(&mut out, "rt_presence_delta_failed_total", "presence delta 发送失败数", self.presence_delta_failed_total.get());
        line(&mut out, "rt_connections_closed_token_expired_total", "token 过期关闭连接数", self.connections_closed_token_expired.get());
        line(&mut out, "rt_connections_closed_backpressure_total", "背压关闭连接数", self.connections_closed_backpressure.get());
        out
    }
}

pub type SharedMetrics = Arc<Metrics>;
