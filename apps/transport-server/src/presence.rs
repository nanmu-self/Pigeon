//! presence delta 推送（Rust 权威 → Nest 镜像，决策 D6）。
//!
//! 用户首连/末路断开时向 Nest `POST /internal/presence/delta`：
//! `{epoch, seq, userId, online, at}`。Nest 据此更新内存镜像并执行
//! `broadcast('presence:update')`（广播语义保留在 Nest，与现状一致）。
//!
//! epoch（Rust 进程启动标识）是关键：Rust 重启后 Nest 清空镜像重建，
//! 否则留下一批永远「在线」的幽灵用户。失败重试有上限 —— presence 只是
//! 展示态 + delivered 判定，Nest 侧 30s 全量对账兜底。

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::config::Config;
use crate::metrics::SharedMetrics;
use crate::registry::Registry;

#[derive(Debug, Serialize)]
pub struct PresenceDelta {
    pub epoch: String,
    pub seq: u64,
    #[serde(rename = "userId")]
    pub user_id: String,
    pub online: bool,
    /// Unix 毫秒
    pub at: i64,
}

/// 推送 delta（带一次重试；失败只记指标，不影响连接生命周期）。
/// 复用 forwarder 的 HTTP 客户端（连接池共享）。
pub async fn push_delta(
    cfg: &Config,
    http: &reqwest::Client,
    registry: &Arc<Registry>,
    user_id: &str,
    online: bool,
    metrics: &SharedMetrics,
) {
    let delta = PresenceDelta {
        epoch: registry.epoch().to_string(),
        seq: registry.next_seq(),
        user_id: user_id.to_string(),
        online,
        at: now_millis(),
    };

    let url = format!("{}/internal/presence/delta", cfg.nest_url);
    for attempt in 0..2u8 {
        match post(http, &url, &cfg.internal_token, &delta).await {
            Ok(()) => {
                metrics.presence_delta_sent_total.inc();
                tracing::info!(user = user_id, online, "presence delta accepted");
                return;
            }
            Err(e) => {
                tracing::warn!(user = user_id, online, attempt, error = %e, "presence delta failed");
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                }
            }
        }
    }
    metrics.presence_delta_failed_total.inc();
}

async fn post(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    delta: &PresenceDelta,
) -> Result<(), String> {
    let resp = http
        .post(url)
        .timeout(Duration::from_secs(3))
        .header("x-internal-token", token)
        .json(delta)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("nest returned {status}"))
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
