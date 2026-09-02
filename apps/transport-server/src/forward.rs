//! C2S 转发：RPC → Nest `POST /internal/rt/:type`（决策 D1：业务逻辑全在 Nest）。

use std::time::Duration;

use base64::Engine as _;
use reqwest::Client;

use crate::config::Config;
use crate::metrics::SharedMetrics;

pub struct Forwarder {
    http: Client,
    nest_url: String,
    internal_token: String,
    timeout: Duration,
    metrics: SharedMetrics,
}

/// 转发结果：Nest 的 `{ok, data|error}` 原样返回
pub type ForwardResult = Result<serde_json::Value, String>;

impl Forwarder {
    pub fn new(cfg: &Config, metrics: SharedMetrics) -> Self {
        let http = Client::builder()
            .timeout(cfg.forward_timeout())
            // 内网调用，连接池收紧即可
            .pool_max_idle_per_host(8)
            .build()
            .expect("build http client");
        Self {
            http,
            nest_url: cfg.nest_url.clone(),
            internal_token: cfg.internal_token.clone(),
            timeout: cfg.forward_timeout(),
            metrics,
        }
    }

    /// 共享 HTTP 客户端（presence delta 等内网调用复用连接池）
    pub fn http(&self) -> &Client {
        &self.http
    }

    /// 转发一个 C2S 事件。
    ///
    /// * `user_id` / `display_name_b64` —— 用户上下文（x-user-id / x-display-name-b64 头）
    /// * `payload` —— 事件载荷原样作为 JSON body
    ///
    /// 返回 Nest 的 `{ok:true,data}` / `{ok:false,error[,code]}`（已经是 JSON 值）。
    pub async fn forward(
        &self,
        event_type: &str,
        user_id: &str,
        display_name: &str,
        payload: serde_json::Value,
    ) -> ForwardResult {
        let url = format!(
            "{}/internal/rt/{}",
            self.nest_url,
            urlencode_path(event_type)
        );
        let display_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(display_name.as_bytes());

        let span = tracing::debug_span!("forward", event = event_type, user = user_id);
        let _enter = span.enter();

        let started = std::time::Instant::now();
        let result = self
            .do_post(&url, user_id, &display_b64, &payload)
            .await;
        tracing::debug!(elapsed = ?started.elapsed(), "forward done");

        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                self.metrics.rpc_forward_failed.inc();
                Err(e)
            }
        }
    }

    async fn do_post(
        &self,
        url: &str,
        user_id: &str,
        display_b64: &str,
        payload: &serde_json::Value,
    ) -> ForwardResult {
        let response = self
            .http
            .post(url)
            .timeout(self.timeout)
            .header("x-internal-token", &self.internal_token)
            .header("x-user-id", user_id)
            .header("x-display-name-b64", display_b64)
            .json(payload)
            .send()
            .await
            .map_err(|e| format!("transport→nest unreachable: {e}"))?;

        let status = response.status();
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("nest response not json: {e}"))?;

        // Nest 的 internal-rt 控制器永远返回 200 + {ok, data|error}；
        // 非 200 = 内部防线（token/IP 校验）拦截，转成统一错误。
        if status.is_success() {
            Ok(body)
        } else {
            Err(format!("nest internal rejected ({}): {}", status, body))
        }
    }
}

/// `message:send` 作为 URL path 段是安全的（字母数字冒号），但保险起见过滤非法字符（含 `.` 防穿越）
fn urlencode_path(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == ':' || *c == '-' || *c == '_')
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn path_filter_keeps_colon() {
        assert_eq!(super::urlencode_path("message:send"), "message:send");
        assert_eq!(super::urlencode_path("../evil"), "evil");
        assert_eq!(super::urlencode_path("a b/c"), "abc");
    }
}
