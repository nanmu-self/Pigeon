//! JWT 验签（HS256，与 Nest `JwtService` 同一密钥/同一载荷结构）。
//!
//! Nest 的 `JwtPayload.userId` 是 **number**（`auth.service.ts`），旧网关用
//! `String(payload.userId)` 归一 —— 这里用 `string_or_number` 做同样的兼容，
//! 内部统一为 String。

use serde::Deserialize;

#[derive(Debug)]
pub enum AuthError {
    /// 验签失败 / 过期 / 格式坏 —— 对外一律 `auth_failed`
    Invalid,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Claims {
    #[serde(default)]
    pub sub: String,
    #[serde(rename = "userId", deserialize_with = "string_or_number")]
    pub user_id: String,
    #[serde(default)]
    pub nickname: String,
    /// Unix 秒
    pub exp: u64,
}

/// 兼容 number / string 两种 userId（旧网关 String() 归一的等价物）
fn string_or_number<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(n) => Ok(n.to_string()),
        serde_json::Value::String(s) => Ok(s),
        _ => Err(serde::de::Error::custom("userId must be number or string")),
    }
}

/// 验签 + 过期校验。参数显式化：HS256、校验 exp、不校验 aud/iss（Nest 没签）。
pub fn verify(secret: &str, token: &str) -> Result<Claims, AuthError> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = true;
    validation.validate_aud = false;
    validation.leeway = 30; // 双进程时钟偏差容忍

    jsonwebtoken::decode::<Claims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|_| AuthError::Invalid)
}

/// 到期时间（Unix 秒）—— 连接任务据此在 token 过期时主动断开
pub fn exp_seconds(claims: &Claims) -> u64 {
    claims.exp
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "test-secret-at-least-16-bytes";

    fn sign(payload: serde_json::Value, exp_offset_secs: i64) -> String {
        use jsonwebtoken::{encode, EncodingKey, Header, Algorithm};
        let mut claims = payload;
        claims["exp"] = serde_json::json!((chrono_now() as i64 + exp_offset_secs) as u64);
        encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(SECRET.as_bytes()))
            .unwrap()
    }

    fn chrono_now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[test]
    fn accepts_numeric_user_id() {
        let token = sign(json!({ "sub": "1", "userId": 42, "nickname": "小明" }), 3600);
        let claims = verify(SECRET, &token).unwrap();
        assert_eq!(claims.user_id, "42");
        assert_eq!(claims.nickname, "小明");
        assert_eq!(exp_seconds(&claims), chrono_now() + 3600);
    }

    #[test]
    fn accepts_string_user_id() {
        let token = sign(json!({ "sub": "1", "userId": "42" }), 3600);
        assert_eq!(verify(SECRET, &token).unwrap().user_id, "42");
    }

    #[test]
    fn rejects_expired_token() {
        let token = sign(json!({ "sub": "1", "userId": 1 }), -3600);
        assert!(matches!(verify(SECRET, &token), Err(AuthError::Invalid)));
    }

    #[test]
    fn rejects_wrong_secret() {
        let token = sign(json!({ "sub": "1", "userId": 1 }), 3600);
        assert!(matches!(verify("another-secret-16-bytes!!", &token), Err(AuthError::Invalid)));
    }

    #[test]
    fn rejects_garbage() {
        assert!(matches!(verify(SECRET, "not-a-jwt"), Err(AuthError::Invalid)));
    }
}
