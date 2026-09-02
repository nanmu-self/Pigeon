//! 启动配置：从环境变量解析，缺关键项直接 exit(1)（fail-fast）。
//!
//! ⚠️ `JWT_SECRET` 必须与 Nest 完全一致（同一份 env 文件）：
//! Nest 的 `resolveJwtSecret()` 在未配置时会**随机生成**，若两侧密钥不同，
//! 现象是「能连上但 hello 全部 auth_failed」——所以这里缺了直接退出，
//! 不给任何「半可用」的假象。
//!
//! | 变量 | 必填 | 默认 | 说明 |
//! |------|------|------|------|
//! | JWT_SECRET | ✅（≥16 字节） | - | 与 Nest 共享的 JWT 验签密钥 |
//! | NEST_URL | ✅ | - | Nest 基址，C2S 转发用，如 `http://pigeon-server:3048` |
//! | WT_INTERNAL_TOKEN | ✅ | - | 内部 API 共享令牌（与 Nest 一致，与 JWT_SECRET 不同源） |
//! | WT_BIND | | 0.0.0.0:4433 | QUIC/UDP 监听地址 |
//! | WT_INTERNAL_BIND | | 0.0.0.0:3901 | internal HTTP 监听（不映射公网） |
//! | WT_CERT_ROTATE_DAYS | | 7 | 自签证书轮换周期（< 14 天有效期） |
//! | WT_MAX_CONN_PER_IP | | 20 | 单 IP 并发连接上限（滥用防护） |
//! | WT_MAX_CONN_PER_USER | | 8 | 单用户（多设备）连接上限 |
//! | WT_RPC_RATE_LIMIT | | 20 | 每连接 RPC 速率上限（req/s，令牌桶） |

use std::net::SocketAddr;
use std::time::Duration;

/// 读取当前目录（或 crate 根）的 `.env`，键值写入进程环境（已设置的不覆盖）。
/// 本地开发友好：`apps/transport-server/.env`（参考 `.env.example`）；
/// 生产用 compose `env_file` 注入，无需此文件。
fn load_dotenv()
{
    for candidate in [".env", concat!(env!("CARGO_MANIFEST_DIR"), "/.env")] {
        let Ok(content) = std::fs::read_to_string(candidate) else { continue };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') { continue }
            let Some((key, value)) = line.split_once('=') else { continue };
            let key = key.trim();
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !key.is_empty() && std::env::var_os(key).is_none() {
                std::env::set_var(key, value);
            }
        }
        return; // 只加载第一个找到的 .env
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub jwt_secret: String,
    pub nest_url: String,
    pub internal_token: String,
    pub wt_bind: SocketAddr,
    pub internal_bind: SocketAddr,
    pub cert_rotate_days: u64,
    pub max_conn_per_ip: usize,
    pub max_conn_per_user: usize,
    pub rpc_rate_limit: f64,
}

impl Config {
    /// 解析环境变量；缺必填项打印原因并 `exit(1)`。
    pub fn from_env() -> Self {
        load_dotenv();
        let jwt_secret = require("JWT_SECRET", |v| {
            (v.len() >= 16).then(|| v).ok_or_else(|| "长度必须 ≥ 16 字节".to_string())
        });
        let nest_url = require("NEST_URL", Ok);
        let internal_token = require("WT_INTERNAL_TOKEN", |v| {
            (v.len() >= 16)
                .then(|| v)
                .ok_or_else(|| "长度必须 ≥ 16 字节（长随机串，与 JWT_SECRET 不同源）".to_string())
        });

        Self {
            jwt_secret,
            nest_url: nest_url.trim_end_matches('/').to_string(),
            internal_token,
            wt_bind: parse_addr("WT_BIND", "0.0.0.0:4433"),
            internal_bind: parse_addr("WT_INTERNAL_BIND", "0.0.0.0:3901"),
            cert_rotate_days: parse_num("WT_CERT_ROTATE_DAYS", 7),
            max_conn_per_ip: parse_num("WT_MAX_CONN_PER_IP", 20),
            max_conn_per_user: parse_num("WT_MAX_CONN_PER_USER", 8),
            rpc_rate_limit: parse_num("WT_RPC_RATE_LIMIT", 20) as f64,
        }
    }

    /// RPC 令牌桶容量（突发额度 = 2s 的速率）
    pub fn rpc_burst(&self) -> f64 {
        self.rpc_rate_limit * 2.0
    }

    /// C2S 转发超时（客户端 RPC 超时 10s，这里留出余量）
    pub fn forward_timeout(&self) -> Duration {
        Duration::from_secs(8)
    }
}

fn require(name: &str, validate: fn(String) -> Result<String, String>) -> String {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => match validate(v.trim().to_string()) {
            Ok(v) => v,
            Err(reason) => {
                eprintln!("fatal: 环境变量 {name} 不合法：{reason}");
                std::process::exit(1);
            }
        },
        _ => {
            eprintln!("fatal: 缺少必填环境变量 {name}（对照 apps/transport-server 的 .env 清单补全）");
            std::process::exit(1);
        }
    }
}

fn parse_addr(name: &str, default: &str) -> SocketAddr {
    let raw = std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let raw = raw.unwrap_or_else(|| default.to_string());
    match raw.parse() {
        Ok(addr) => addr,
        Err(_) => {
            eprintln!("fatal: 环境变量 {name} 不是合法地址：{raw}");
            std::process::exit(1);
        }
    }
}

fn parse_num<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| {
            v.trim().parse().unwrap_or_else(|_| {
                eprintln!("fatal: 环境变量 {name} 不是合法数字：{v}");
                std::process::exit(1);
            })
        })
        .unwrap_or(default)
}
