//! 聊天数据模型 — 通过 Tauri command 序列化给前端（camelCase）。

use serde::{Deserialize, Serialize};

/// 会话类型：单聊 / 群聊
pub const KIND_DIRECT: &str = "direct";
pub const KIND_GROUP: &str = "group";

// 消息发送方：自己 / 对方 / 系统提示
#[allow(dead_code)]
pub const SENDER_SELF: &str = "self";
#[allow(dead_code)]
pub const SENDER_OTHER: &str = "other";
#[allow(dead_code)]
pub const SENDER_SYSTEM: &str = "system";

/// 消息类型
pub const MSG_TEXT: &str = "text";
#[allow(dead_code)]
pub const MSG_IMAGE: &str = "image";
#[allow(dead_code)]
pub const MSG_FILE: &str = "file";
#[allow(dead_code)]
pub const MSG_SYSTEM: &str = "system";

/// 消息状态：发送中 / 已发出 / 失败 / 已读
#[allow(dead_code)]
pub const STATUS_SENDING: &str = "sending";
pub const STATUS_SENT: &str = "sent";
#[allow(dead_code)]
pub const STATUS_FAILED: &str = "failed";
#[allow(dead_code)]
pub const STATUS_READ: &str = "read";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: i64,
    /// direct | group
    pub kind: String,
    pub name: String,
    /// 对端用户 ID（接入服务端后用于关联账号）
    pub peer_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 会话里最新一条消息（列表预览用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastMessage {
    pub id: i64,
    /// self | other | system
    pub sender: String,
    pub sender_name: String,
    /// text | image | file | system
    pub kind: String,
    pub content: String,
    pub created_at: i64,
}

/// 会话 + 最新消息 + 未读数（列表行）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub peer_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_message: Option<LastMessage>,
    pub unread_count: i64,
}

/// 待写入的新消息（insert 入参）
#[derive(Debug, Clone)]
pub struct NewMessage {
    pub conversation_id: i64,
    pub sender: String,
    pub sender_name: String,
    pub kind: String,
    pub content: String,
    /// 接入服务端同步后用于幂等去重（唯一索引已建）
    pub client_msg_id: Option<String>,
    pub status: String,
}

/// 聊天消息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub conversation_id: i64,
    /// self | other | system
    pub sender: String,
    pub sender_name: String,
    /// text | image | file | system
    pub kind: String,
    pub content: String,
    /// sending | sent | failed | read
    pub status: String,
    /// Unix 毫秒时间戳
    pub created_at: i64,
}
