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

/// 消息状态：发送中 / 已发出 / 已送达 / 失败 / 已读
#[allow(dead_code)]
pub const STATUS_SENDING: &str = "sending";
pub const STATUS_SENT: &str = "sent";
pub const STATUS_DELIVERED: &str = "delivered";
#[allow(dead_code)]
pub const STATUS_FAILED: &str = "failed";
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
    /// 服务端会话 id（WS conversationId / REST /sessions 的 id），同步锚点
    pub server_session_id: Option<String>,
    /// 对端已读水位：对端已读的最大服务端消息 id
    pub peer_read_msg_id: Option<i64>,
    /// 对端送达水位：已送达对端的最大服务端消息 id
    pub peer_delivered_msg_id: Option<i64>,
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
    pub server_session_id: Option<String>,
    pub peer_read_msg_id: Option<i64>,
    pub peer_delivered_msg_id: Option<i64>,
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
    /// image/file 附加信息（JSON 字符串）
    pub meta: Option<String>,
    /// 被引用消息摘要（JSON 字符串）
    pub reply_summary: Option<String>,
    /// 表情回应聚合（JSON 字符串）
    pub reactions: Option<String>,
    /// 是否已撤回（撤回占位渲染）
    pub recalled: bool,
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
    /// sending | sent | delivered | failed | read
    pub status: String,
    /// image/file 附加信息（JSON 字符串：fname/size/mime…）；文本消息为空
    pub meta: Option<String>,
    /// 服务端消息 id（同步后回填；引用回复需要它作为 replyToId）
    pub server_msg_id: Option<String>,
    /// 本机发送的占位键（发送/重发/状态回填的关联键；接收消息为空）
    pub client_msg_id: Option<String>,
    /// 被引用消息摘要（JSON 字符串：{ id, senderName, kind, content }）
    pub reply_summary: Option<String>,
    /// 表情回应聚合（JSON 字符串：[ { emoji, userIds } ]）
    pub reactions: Option<String>,
    /// 是否已撤回（撤回消息 content 为空，UI 渲染撤回占位）
    pub recalled: bool,
    /// Unix 毫秒时间戳
    pub created_at: i64,
}

/// 服务端已落库的消息（历史拉取 / WS message:new 合并入参）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerMessage {
    pub conversation_id: i64,
    /// 服务端消息 id（字符串数字）
    pub server_msg_id: String,
    pub sender: String,
    pub sender_name: String,
    pub kind: String,
    pub content: String,
    /// 服务端时间（Unix 毫秒）—— 本地排序的权威时间
    pub created_at: i64,
    /// 本机发出的消息带此字段（与 optimistic 占位行关联）
    pub client_msg_id: Option<String>,
    /// 附加信息（JSON 字符串）
    pub meta: Option<String>,
    /// 被引用消息摘要（JSON 字符串）
    pub reply_summary: Option<String>,
    /// 表情回应聚合（JSON 字符串）
    pub reactions: Option<String>,
    /// 服务端已撤回
    #[serde(default)]
    pub recalled: bool,
}

/// 合并结果：inserted = false 表示本地已有（幂等跳过或占位行补全）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub message: ChatMessage,
    pub inserted: bool,
}
