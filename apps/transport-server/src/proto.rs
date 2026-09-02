//! 帧编解码与协议类型（与 `packages/shared-types` 对齐）。
//!
//! 帧格式：`u32 BE 长度 + JSON(UTF-8)`，单帧上限 1 MiB（对齐旧网关
//! `maxHttpBufferSize: 1e6`）。
//!
//! ⚠️ QUIC 流是**字节流**：一次 `read()` 可能读到半个帧、也可能读到两个半帧。
//! [`FrameReader`] 必须维护累积缓冲，循环「够 4 字节读长度 → 够长度切帧 →
//! 剩余留在缓冲」。单测含逐字节分片投喂用例（此类实现最常见的 bug）。

use std::io;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// 单帧上限 1 MiB（不含 4 字节长度前缀）
pub const MAX_FRAME_LEN: u32 = 1_000_000;

/// 最低客户端协议版本：低于它的 hello 会被拒（`client_too_old`）
pub const MIN_CLIENT_PROTO: u32 = 1;

#[derive(Debug)]
pub enum FrameError {
    /// 对端关流（EOF，读到 0 字节）
    Closed,
    Io(io::Error),
    /// 帧长度超过上限 —— 恶意/损坏流量，必须立即断开（不尝试恢复）
    TooLarge(u32),
    /// JSON 解析失败 —— 同上，立即断开
    BadJson(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(f, "stream closed"),
            Self::Io(e) => write!(f, "io error: {e}"),
            Self::TooLarge(n) => write!(f, "frame too large: {n} > {MAX_FRAME_LEN}"),
            Self::BadJson(e) => write!(f, "bad json: {e}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// 把任意可序列化值写成「长度前缀 + JSON」帧。
pub async fn write_frame<S, T>(sink: &mut S, value: &T) -> Result<(), FrameError>
where
    S: AsyncWrite + Unpin,
    T: Serialize,
{
    let json =
        serde_json::to_vec(value).map_err(|e| FrameError::Io(io::Error::other(e.to_string())))?;
    let len = u32::try_from(json.len()).map_err(|_| FrameError::TooLarge(u32::MAX))?;
    if len > MAX_FRAME_LEN {
        return Err(FrameError::TooLarge(len));
    }
    sink.write_all(&len.to_be_bytes()).await.map_err(FrameError::Io)?;
    sink.write_all(&json).await.map_err(FrameError::Io)?;
    sink.flush().await.map_err(FrameError::Io)?;
    Ok(())
}

/// 累积缓冲帧读取器（状态机）。
///
/// 用法：每条流一个 [`FrameReader`]，循环调 [`FrameReader::read_frame`]。
pub struct FrameReader<R> {
    inner: R,
    buf: Vec<u8>,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        Self { inner, buf: Vec::with_capacity(4096) }
    }

    /// 读出一帧并反序列化。EOF（干净关流）返回 [`FrameError::Closed`]。
    pub async fn read_frame<T: DeserializeOwned>(&mut self) -> Result<T, FrameError> {
        // 状态机：缺长度前缀就补，缺 body 就补，绝不丢已读字节。
        loop {
            if self.buf.len() >= 4 {
                let len = u32::from_be_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]);
                if len > MAX_FRAME_LEN {
                    return Err(FrameError::TooLarge(len));
                }
                let need = 4 + len as usize;
                if self.buf.len() >= need {
                    let json = self.buf.split_off(need);
                    let frame = &self.buf[4..];
                    let value = serde_json::from_slice(frame)
                        .map_err(|e| FrameError::BadJson(e.to_string()))?;
                    // 剩余字节留给下一帧（split_off 已挪走）
                    self.buf = json;
                    return Ok(value);
                }
            }
            let mut chunk = [0u8; 8192];
            let n = self.inner.read(&mut chunk).await.map_err(FrameError::Io)?;
            if n == 0 {
                // EOF：缓冲里还有半个帧 = 对端写了一半就断，按坏流处理
                if self.buf.is_empty() {
                    return Err(FrameError::Closed);
                }
                return Err(FrameError::Io(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stream ended mid-frame",
                )));
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
    }

    /// 当前缓冲中的字节数（测试用）
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// 交出底层流（读帧间隙切换读取逻辑用）
    pub fn into_inner(self) -> R {
        self.inner
    }
}

// ── 协议类型（字段名与 shared-types 的 JSON 契约逐字对齐） ─────────

/// hello 帧（连接建立后客户端在 bi 流 #0 发出的第一帧，5s 内）
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Hello {
    pub v: u8,
    #[serde(rename = "type")]
    pub kind: String,
    pub token: String,
    #[serde(rename = "clientProto", default)]
    pub client_proto: u32,
    #[serde(rename = "clientVersion", default)]
    pub client_version: String,
}

/// hello 响应：welcome 或 error（随后关连接）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HelloResult {
    Welcome {
        #[serde(rename = "connId")]
        conn_id: String,
        #[serde(rename = "userId")]
        user_id: String,
        #[serde(rename = "serverTime")]
        server_time: i64,
    },
    Error {
        code: HelloErrorCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(rename = "minProto", skip_serializing_if = "Option::is_none")]
        min_proto: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelloErrorCode {
    AuthFailed,
    ClientTooOld,
    TokenExpired,
}

/// C2S RPC 请求帧（每请求一条新 bi 流）
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RpcRequest {
    pub id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// C2S RPC 响应帧
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcResponse {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "code", skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl RpcResponse {
    pub fn ok(id: u64, data: serde_json::Value) -> Self {
        Self { id, ok: true, data: Some(data), error: None, error_code: None }
    }

    pub fn error(id: u64, error: impl Into<String>, code: Option<&str>) -> Self {
        Self {
            id,
            ok: false,
            data: None,
            error: Some(error.into()),
            error_code: code.map(str::to_string),
        }
    }
}

/// S2C 推送帧（服务端开的单向长流，seq 按连接单调递增）
///
/// `kind` 取 `ServerToClientEvents` 的事件名，或控制帧 `resync` / `going_away`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushFrame {
    pub seq: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

impl PushFrame {
    pub fn event(seq: u64, kind: impl Into<String>, payload: serde_json::Value) -> Self {
        Self { seq, kind: kind.into(), payload }
    }

    pub fn control(seq: u64, kind: &str, reason: &str) -> Self {
        Self {
            seq,
            kind: kind.to_string(),
            payload: serde_json::json!({ "reason": reason }),
        }
    }
}

/// 内部投递请求（Nest → Rust `POST /internal/publish`）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishInput {
    /// 目标 userId 列表（定向投递）
    #[serde(default)]
    pub users: Vec<String>,
    /// 全服广播（presence:update / group:updated）
    #[serde(default)]
    pub broadcast: bool,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// presence 快照（Rust 权威 → Nest 镜像整体替换）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceSnapshot {
    pub epoch: String,
    pub seq: u64,
    #[serde(rename = "userIds")]
    pub user_ids: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 逐字节投喂的 mock reader：模拟最恶劣的 TCP/QUIC 分片
    struct ByteByByte<'a>(&'a [u8]);

    impl AsyncRead for ByteByByte<'_> {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            if self.0.is_empty() {
                return std::task::Poll::Ready(Ok(()));
            }
            use bytes::BufMut as _;
            buf.put_u8(self.0[0]);
            self.0 = &self.0[1..];
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn roundtrip() {
        let frame = PushFrame::event(7, "message:new", serde_json::json!({ "id": "1" }));
        let mut buf = Vec::new();
        write_frame(&mut buf, &frame).await.unwrap();

        let mut reader = FrameReader::new(buf.as_slice());
        let got: PushFrame = reader.read_frame().await.unwrap();
        assert_eq!(got.seq, 7);
        assert_eq!(got.kind, "message:new");
        assert_eq!(got.payload["id"], "1");
    }

    #[tokio::test]
    async fn survives_byte_by_byte_fragmentation() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &RpcRequest { id: 1, kind: "message:send".into(), payload: serde_json::json!({"a": 1}) }).await.unwrap();
        write_frame(&mut buf, &RpcRequest { id: 2, kind: "message:read".into(), payload: serde_json::json!({"b": [1, 2, 3]}) }).await.unwrap();

        let mut reader = FrameReader::new(ByteByByte(&buf));
        let first: RpcRequest = reader.read_frame().await.unwrap();
        assert_eq!(first.id, 1);
        let second: RpcRequest = reader.read_frame().await.unwrap();
        assert_eq!(second.id, 2);
        assert!(matches!(reader.read_frame::<RpcRequest>().await, Err(FrameError::Closed)));
    }

    #[tokio::test]
    async fn survives_mid_frame_reads_and_keeps_remainder() {
        // 手工构造「1.5 帧」的字节流：第二个帧只有一半
        let full = serde_json::json!({ "x": "y" }).to_string();
        let mut stream = Vec::new();
        stream.extend_from_slice(&(full.len() as u32).to_be_bytes());
        stream.extend_from_slice(full.as_bytes());
        stream.extend_from_slice(&(full.len() as u32).to_be_bytes());
        stream.extend_from_slice(&full.as_bytes()[..3]); // 半帧

        let mut reader = FrameReader::new(stream.as_slice());
        let got: serde_json::Value = reader.read_frame().await.unwrap();
        assert_eq!(got["x"], "y");
        assert_eq!(reader.buffered(), 4 + 3); // 半帧完整保留在缓冲

        let mut stream2 = stream.clone();
        stream2.extend_from_slice(&full.as_bytes()[3..]);
        let mut reader = FrameReader::new(stream2.as_slice());
        let got: serde_json::Value = reader.read_frame().await.unwrap();
        assert_eq!(got["x"], "y");
    }

    #[tokio::test]
    async fn rejects_oversized_frame() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(MAX_FRAME_LEN + 1).to_be_bytes());
        let mut reader = FrameReader::new(buf.as_slice());
        let err = reader.read_frame::<serde_json::Value>().await.unwrap_err();
        assert!(matches!(err, FrameError::TooLarge(_)), "{err}");
    }

    #[tokio::test]
    async fn rejects_bad_json() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&3u32.to_be_bytes());
        buf.extend_from_slice(b"xyz");
        let mut reader = FrameReader::new(buf.as_slice());
        let err = reader.read_frame::<serde_json::Value>().await.unwrap_err();
        assert!(matches!(err, FrameError::BadJson(_)), "{err}");
    }

    #[tokio::test]
    async fn rejects_write_oversize() {
        // > 1MiB 的载荷在写入侧就该拒绝
        let big = vec![b'x'; (MAX_FRAME_LEN as usize) + 1];
        let mut sink = Vec::new();
        assert!(matches!(
            write_frame(&mut sink, &big).await,
            Err(FrameError::TooLarge(_))
        ));
    }

    // ── shared-types 夹具：Rust 必须能反序列化 Nest 侧序列化的载荷 ──
    // 路径相对 CARGO_MANIFEST_DIR（apps/transport-server）：上两级 = 仓库根。
    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../packages/shared-types/fixtures/",
                $name
            ))
        };
    }

    #[test]
    fn parses_shared_types_push_frame_fixture() {
        let frame: PushFrame = serde_json::from_str(fixture!("rt-push-frame.json")).unwrap();
        assert_eq!(frame.seq, 7);
        assert_eq!(frame.kind, "message:new");
        assert_eq!(frame.payload["senderName"], "Alice");
        assert_eq!(frame.payload["createdAt"], 1735689600000i64);
    }

    #[test]
    fn parses_shared_types_request_fixture() {
        let req: RpcRequest = serde_json::from_str(fixture!("rt-request-message-send.json")).unwrap();
        assert_eq!(req.id, 42);
        assert_eq!(req.kind, "message:send");
        assert_eq!(req.payload["clientMsgId"], "0b8f6c1e-6f5a-4a7d-9d3a-2f6f7a1c9b01");
    }

    #[test]
    fn parses_shared_types_hello_and_welcome_fixtures() {
        let hello: Hello = serde_json::from_str(fixture!("rt-hello.json")).unwrap();
        assert_eq!(hello.v, 1);
        assert_eq!(hello.client_proto, 1);

        let welcome: HelloResult = serde_json::from_str(fixture!("rt-welcome.json")).unwrap();
        match welcome {
            HelloResult::Welcome { conn_id, user_id, .. } => {
                assert_eq!(user_id, "1");
                assert!(!conn_id.is_empty());
            }
            _ => panic!("expected welcome"),
        }
    }

    #[test]
    fn serializes_hello_with_camel_case_fields() {
        let welcome = HelloResult::Welcome {
            conn_id: "c1".into(),
            user_id: "42".into(),
            server_time: 1735689600000,
        };
        let json = serde_json::to_value(&welcome).unwrap();
        assert_eq!(json["type"], "welcome");
        assert_eq!(json["connId"], "c1");
        assert_eq!(json["userId"], "42");

        let err = HelloResult::Error {
            code: HelloErrorCode::ClientTooOld,
            message: Some("请升级客户端".into()),
            min_proto: Some(MIN_CLIENT_PROTO),
        };
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "client_too_old");
        assert_eq!(json["minProto"], 1);
    }
}
