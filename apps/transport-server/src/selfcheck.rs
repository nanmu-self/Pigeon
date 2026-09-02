//! `--selfcheck` 子命令：打自身 `/healthz`，供 Docker healthcheck。
//!
//! slim 镜像没有 curl/node —— healthcheck 直接跑本二进制，返回码即探针结果。

use std::time::Duration;

pub async fn run(internal_bind: &str) -> i32 {
    let url = format!("http://{internal_bind}/healthz");
    match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                println!("selfcheck ok: {url}");
                0
            }
            Ok(resp) => {
                eprintln!("selfcheck failed: {url} → {}", resp.status());
                1
            }
            Err(e) => {
                eprintln!("selfcheck failed: {url} → {e}");
                1
            }
        },
        Err(e) => {
            eprintln!("selfcheck failed (http client): {e}");
            1
        }
    }
}
