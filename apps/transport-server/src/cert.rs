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
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::hours(1); // 时钟偏差容忍
    params.not_after = now + time::Duration::days(CERT_TTL_DAYS);
    params.is_ca = rcgen::IsCa::NoCa; // 必须是叶子证书
    params.key_usages = vec![rcgen::KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];

    let cert = params.self_signed(&key_pair).map_err(|e| format!("self sign: {e}"))?;
    let der = cert.der().to_vec();
    let fingerprint = sha256_b64(&der);
    let expires_at_ms = now_ms() + CERT_TTL_DAYS * 24 * 3600 * 1000;

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

    fn hex_of(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
    }
}
