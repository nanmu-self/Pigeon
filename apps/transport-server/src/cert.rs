//! 自签证书（ECDSA P-256）+ 指纹固定 + 定时轮换热替换。
//!
//! 规范硬性要求：`serverCertificateHashes` 的证书有效期 **≤ 14 天**、
//! 必须是叶子证书（IsCa::NoCa）。⚠️「每次启动重新生成」不足以解决过期：
//! 进程连续运行 > 14 天后所有**新建**连接会被 Chromium 静默拒绝（存量连接
//! 不受影响，故障渐进式、无声）。因此轮换是必须项 —— 默认每 7 天重签，
//! 通过 `quinn::Endpoint::set_server_config()` 热替换，无需重启。
//!
//! 轮换窗口期新旧两张证书并存，`/internal/cert` 返回**全部仍有效的指纹**，
//! 客户端把数组原样传给 `serverCertificateHashes`（它本身接受数组）。

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde::Serialize;
use tokio::sync::RwLock;

/// 证书有效期（规范上限 14 天，留 1 小时余量避免边界竞态）
pub const CERT_TTL_DAYS: i64 = 14;
/// 时钟偏差容忍（算进有效期总长内，见 generate）
const CLOCK_SKEW_BACKDATE: time::Duration = time::Duration::hours(1);

#[derive(Debug, Clone, Serialize)]
pub struct CertInfo {
    /// SHA-256(DER)，base64（客户端 base64 → Uint8Array 喂给 serverCertificateHashes）
    #[serde(rename = "certSha256")]
    pub cert_sha256: String,
    /// 过期时间（Unix 毫秒，观测/告警用）
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: i64,
}

struct Rotation {
    /// 当前证书（DER + 私钥），轮换时整体替换
    current: Arc<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)>,
    /// 当前证书信息
    info: CertInfo,
    /// 轮换窗口期内仍有效的旧指纹（新签发时归档旧证书）
    previous: Vec<CertInfo>,
}

pub struct RotatingCert(RwLock<Rotation>);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

/// 生成一张自签叶子证书：ECDSA P-256、SAN=localhost、serverAuth EKU、
/// digitalSignature keyUsage（Chromium 指纹校验的隐性要求，缺一是同句模糊报错）。
fn generate() -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>, CertInfo), String> {
    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256)
        .map_err(|e| format!("generate key: {e}"))?;

    let mut params = rcgen::CertificateParams::new(vec!["localhost".to_string()])
        .map_err(|e| format!("cert params: {e}"))?;
    // ⚠️ SAN 必须含连接目标的 IP：Chromium 指纹模式实测仍校验 SAN 与主机匹配
    // （规范说不校验、moq 的可用配置也显式带 IP.1=127.0.0.1，见其 dev/setup
    // 「avoid a CA (bugged)」注释）——只写 DNS localhost 时连 127.0.0.1 被拒。
    params
        .subject_alt_names
        .push(rcgen::SanType::IpAddress(std::net::IpAddr::from([127, 0, 0, 1])));
    let now = time::OffsetDateTime::now_utc();
    // ⚠️ 规范要求有效期**总长** ≤ 14 天（not_after - not_before），1h 时钟
    // 回拨必须算进总长。注：此前「14 天整被拒」的实验结论无效——真机根因
    // 是客户端 algorithm 大小写（'SHA-256' → 'sha-256'，见 webtransport.ts），
    // 修正后 14 天整实测通过。
    let not_before = now - CLOCK_SKEW_BACKDATE;
    let not_after = not_before + time::Duration::days(CERT_TTL_DAYS);
    params.not_before = not_before;
    params.not_after = not_after;
    params.is_ca = rcgen::IsCa::NoCa; // 必须是叶子证书
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];

    let cert = params.self_signed(&key_pair).map_err(|e| format!("self sign: {e}"))?;
    let der = cert.der().to_vec();
    let fingerprint = sha256_b64(&der);
    let expires_at_ms = not_after.unix_timestamp() as i64 * 1000;

    let key_der = key_pair.serialize_der();
    Ok((
        vec![CertificateDer::from(der)],
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der)),
        CertInfo { cert_sha256: fingerprint, expires_at_ms },
    ))
}

fn sha256_b64(der: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use sha2::{Digest, Sha256};
    STANDARD.encode(Sha256::digest(der))
}

impl RotatingCert {
    pub fn new() -> Result<Self, String> {
        let (chain, key, info) = generate()?;
        Ok(Self(RwLock::new(Rotation {
            current: Arc::new((chain, key)),
            info,
            previous: Vec::new(),
        })))
    }

    /// 当前证书链 + 私钥（启动时构建 quinn config 用）
    pub async fn current(&self) -> Arc<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
        self.0.read().await.current.clone()
    }

    /// 当前证书信息
    pub async fn info(&self) -> CertInfo {
        self.0.read().await.info.clone()
    }

    /// 全部仍有效的指纹（当前 + 轮换窗口内的旧证书），供 `/internal/cert` 下发
    pub async fn valid_fingerprints(&self) -> Vec<CertInfo> {
        let rot = self.0.read().await;
        let now = now_ms();
        let mut all = rot.previous.clone();
        all.push(rot.info.clone());
        all.retain(|c| c.expires_at_ms > now);
        all
    }

    /// 轮换：重签 → 归档旧指纹 → 返回新证书（由调用方热替换进 quinn）。
    pub async fn rotate(
        &self,
    ) -> Result<Arc<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)>, String> {
        let (chain, key, info) = generate()?;
        let arc = Arc::new((chain, key));
        let mut rot = self.0.write().await;
        let old_info = rot.info.clone();
        rot.previous.push(old_info);
        // 只保留可能仍有效的旧指纹（14 天内）
        let cutoff = now_ms() - CERT_TTL_DAYS as i64 * 24 * 3600 * 1000;
        rot.previous.retain(|c| c.expires_at_ms > cutoff);
        rot.current = arc.clone();
        rot.info = info;
        Ok(arc)
    }

    /// 轮换周期（配置），供定时器
    pub fn interval(cfg: &crate::config::Config) -> Duration {
        // 证书 14 天有效、轮换 7 天一次 → 任一时刻剩余有效期 ≥ 7 天
        Duration::from_secs(cfg.cert_rotate_days.max(1) * 24 * 3600)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn generates_valid_leaf_cert() {
        let cert = RotatingCert::new().unwrap();
        let info = cert.info().await;
        // 指纹是合法 base64（32 字节 → 44 字符）
        assert_eq!(info.cert_sha256.len(), 44);
        // 有效期 ≤ 14 天
        assert!(info.expires_at_ms - now_ms() <= CERT_TTL_DAYS * 24 * 3600 * 1000);
        // DER 可被 rustls 接受
        let (chain, _key) = &*cert.current().await;
        assert_eq!(chain.len(), 1);
    }

    #[tokio::test]
    async fn rotation_keeps_both_fingerprints() {
        let cert = RotatingCert::new().unwrap();
        assert_eq!(cert.valid_fingerprints().await.len(), 1);

        let old = cert.info().await;
        cert.rotate().await.unwrap();

        let fps = cert.valid_fingerprints().await;
        assert_eq!(fps.len(), 2, "轮换窗口期新旧指纹并存");
        assert!(fps.iter().any(|f| f.cert_sha256 == old.cert_sha256), "旧指纹仍在");
        let new_info = cert.info().await;
        assert_ne!(new_info.cert_sha256, old.cert_sha256);
    }

    #[test]
    fn sha256_matches_known_vector() {
        // SHA-256("abc") 的前 8 字节 = ba7816bf 8f01cfea
        let hex = hex_of(b"abc");
        assert!(hex.starts_with("ba7816bf8f01cfea"));
    }

    /// 锁死 Chromium `serverCertificateHashes` 的硬性要求（真机 S2 实测：
    /// 有效期总长 14d+1h 被拒，报 CERTIFICATE_VERIFY_FAILED，指纹全对也没用）。
    /// 独立解析 DER，不复用 generate 的构造逻辑，防止「同错互证」。
    #[test]
    fn der_meets_chromium_hash_pinning_requirements() {
        use x509_parser::prelude::*;

        let (chain, _key, info) = generate().unwrap();
        let (_, cert) = parse_x509_certificate(chain[0].as_ref()).unwrap();

        // 有效期总长 ≤ 14 天（Chromium 检查的是 not_after - not_before）
        let validity = cert.validity();
        let period_secs = validity.not_after.timestamp() - validity.not_before.timestamp();
        assert!(
            period_secs <= CERT_TTL_DAYS * 24 * 3600,
            "有效期总长 {period_secs}s 超过 {} 天",
            CERT_TTL_DAYS
        );
        // not_before 已回拨（时钟偏差容忍）、not_after 仍在未来
        assert!(validity.not_before.timestamp() * 1000 <= now_ms());
        assert_eq!(info.expires_at_ms, validity.not_after.timestamp() * 1000);

        // 必须是叶子证书（非 CA）
        assert!(!cert.is_ca(), "必须是叶子证书（IsCa::NoCa）");

        // KU 必须含 digitalSignature；EKU 必须含 serverAuth
        assert!(cert.key_usage().unwrap().unwrap().value.digital_signature());
        assert!(cert.extended_key_usage().unwrap().unwrap().value.server_auth);

        // SAN 必须同时覆盖 localhost 与 127.0.0.1（WT_PUBLIC_URL 两者都可能下发）
        let san = cert.subject_alternative_name().unwrap().unwrap().value;
        let has_dns_localhost = san.general_names.iter().any(|g| matches!(g, GeneralName::DNSName("localhost")));
        let has_ip_loopback = san.general_names.iter().any(|g| {
            matches!(g, GeneralName::IPAddress(ip) if ip.to_vec() == [127u8, 0, 0, 1])
        });
        assert!(has_dns_localhost, "缺少 DNS SAN localhost");
        assert!(has_ip_loopback, "缺少 IP SAN 127.0.0.1");
    }

    fn hex_of(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
    }
}
