//! 聊天记录相关 Tauri commands — 薄封装：参数校验 + 错误转换，
//! SQL 逻辑在 `chat.rs`（可单测）。

use tauri::State;

use crate::chat;
use crate::db::Db;
use crate::models::*;

fn lock<'a>(state: &'a State<Db>) -> Result<std::sync::MutexGuard<'a, rusqlite::Connection>, String> {
    state.0.lock().map_err(|e| format!("数据库锁获取失败: {e}"))
}

// ── 会话 ─────────────────────────────────────────────────────

/// 会话列表（含最新消息预览与未读数）
#[tauri::command]
pub fn list_conversations(state: State<Db>) -> Result<Vec<ConversationSummary>, String> {
    let conn = lock(&state)?;
    chat::list_conversations(&conn).map_err(|e| e.to_string())
}

/// 新建会话（direct / group）
#[tauri::command]
pub fn create_conversation(
    state: State<Db>,
    name: String,
    kind: Option<String>,
) -> Result<Conversation, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("会话名称不能为空".into());
    }
    let kind = kind.as_deref().unwrap_or(KIND_DIRECT);
    if kind != KIND_DIRECT && kind != KIND_GROUP {
        return Err(format!("非法会话类型: {kind}"));
    }
    let conn = lock(&state)?;
    chat::create_conversation(&conn, name, kind).map_err(|e| e.to_string())
}

/// 标记会话已读
#[tauri::command]
pub fn mark_conversation_read(state: State<Db>, conversation_id: i64) -> Result<(), String> {
    let conn = lock(&state)?;
    chat::mark_conversation_read(&conn, conversation_id).map_err(|e| e.to_string())
}

/// 删除会话（聊天记录随 CASCADE 一并删除）
#[tauri::command]
pub fn delete_conversation(state: State<Db>, conversation_id: i64) -> Result<(), String> {
    let conn = lock(&state)?;
    chat::delete_conversation(&conn, conversation_id).map_err(|e| e.to_string())
}

/// 清空会话聊天记录（保留会话本身）
#[tauri::command]
pub fn clear_history(state: State<Db>, conversation_id: i64) -> Result<(), String> {
    let conn = lock(&state)?;
    chat::clear_history(&conn, conversation_id).map_err(|e| e.to_string())
}

// ── 消息 ─────────────────────────────────────────────────────

/// 拉取消息（keyset 分页，时间正序；传 beforeCreatedAt+beforeId 上滑加载更早历史）
#[tauri::command]
pub fn get_messages(
    state: State<Db>,
    conversation_id: i64,
    limit: Option<i64>,
    before_created_at: Option<i64>,
    before_id: Option<i64>,
) -> Result<Vec<ChatMessage>, String> {
    let conn = lock(&state)?;
    chat::get_messages(&conn, conversation_id, limit, before_created_at, before_id)
        .map_err(|e| e.to_string())
}

/// 确保存在与服务端会话关联的本地会话（无则创建，幂等）
#[tauri::command]
pub fn ensure_conversation(
    state: State<Db>,
    server_session_id: String,
    peer_id: String,
    peer_name: String,
) -> Result<Conversation, String> {
    let conn = lock(&state)?;
    chat::ensure_conversation(&conn, &server_session_id, &peer_id, &peer_name)
        .map_err(|e| e.to_string())
}

/// 通用写入消息（接收方 / 同步路径复用；前端发送走 send_message）
#[tauri::command]
pub fn insert_message(
    state: State<Db>,
    conversation_id: i64,
    content: String,
    sender: Option<String>,
    sender_name: Option<String>,
    kind: Option<String>,
    client_msg_id: Option<String>,
    meta: Option<String>,
    status: Option<String>,
) -> Result<ChatMessage, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("消息内容不能为空".into());
    }

    let msg = NewMessage {
        conversation_id,
        sender: sender.unwrap_or_else(|| SENDER_SELF.to_string()),
        sender_name: sender_name.unwrap_or_default(),
        kind: kind.unwrap_or_else(|| MSG_TEXT.to_string()),
        content: content.to_string(),
        client_msg_id,
        meta,
        reply_summary: None,
        reactions: None,
        recalled: false,
        status: status.unwrap_or_else(|| STATUS_SENT.to_string()),
    };

    let conn = lock(&state)?;
    chat::insert_message(&conn, msg).map_err(|e| e.to_string())
}

/// 当前用户发送文本消息（optimistic：先落 sending 占位行，客户端拿
/// clientMsgId 在 WS ack 后调 acknowledge_message 回填；失败调 mark_message_failed）
#[tauri::command]
pub fn send_message(
    state: State<Db>,
    conversation_id: i64,
    content: String,
    client_msg_id: String,
    kind: Option<String>,
    meta: Option<String>,
    reply_summary: Option<String>,
) -> Result<ChatMessage, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("消息内容不能为空".into());
    }
    if client_msg_id.trim().is_empty() {
        return Err("client_msg_id 不能为空".into());
    }
    let kind = kind.unwrap_or_else(|| MSG_TEXT.to_string());
    if kind != MSG_TEXT && kind != MSG_IMAGE && kind != MSG_FILE {
        return Err(format!("非法消息类型: {kind}"));
    }

    let msg = NewMessage {
        conversation_id,
        sender: SENDER_SELF.to_string(),
        sender_name: String::new(),
        kind,
        content: content.to_string(),
        client_msg_id: Some(client_msg_id),
        meta,
        reply_summary,
        reactions: None,
        recalled: false,
        status: STATUS_SENDING.to_string(),
    };

    let conn = lock(&state)?;
    chat::insert_message(&conn, msg).map_err(|e| e.to_string())
}

/// 确保存在与服务端群会话关联的本地会话（无则创建，幂等）
#[tauri::command]
pub fn ensure_group_conversation(
    state: State<Db>,
    server_session_id: String,
    group_name: String,
) -> Result<Conversation, String> {
    let conn = lock(&state)?;
    chat::ensure_group_conversation(&conn, &server_session_id, &group_name).map_err(|e| e.to_string())
}

/// 合并一条服务端已落库的消息（历史拉取 / WS message:new 共用，幂等）
#[tauri::command]
pub fn upsert_server_message(
    state: State<Db>,
    message: ServerMessage,
) -> Result<MergeResult, String> {
    let conn = lock(&state)?;
    chat::upsert_server_message(&conn, &message).map_err(|e| e.to_string())
}

/// 发送方 ack：占位行回填服务端 id/时间（幂等）
#[tauri::command]
pub fn acknowledge_message(
    state: State<Db>,
    client_msg_id: String,
    server_msg_id: String,
    created_at: i64,
) -> Result<ChatMessage, String> {
    let conn = lock(&state)?;
    chat::acknowledge_message(&conn, &client_msg_id, &server_msg_id, created_at)
        .map_err(|e| e.to_string())
}

/// 标记发送失败
#[tauri::command]
pub fn mark_message_failed(state: State<Db>, client_msg_id: String) -> Result<(), String> {
    let conn = lock(&state)?;
    chat::mark_message_failed(&conn, &client_msg_id).map_err(|e| e.to_string())
}

/// 重试失败的消息：status 置回 sending（随后走正常 ack 回填流程）
#[tauri::command]
pub fn retry_message(state: State<Db>, client_msg_id: String) -> Result<(), String> {
    let conn = lock(&state)?;
    chat::retry_message(&conn, &client_msg_id).map_err(|e| e.to_string())
}

/// 本地应用撤回（按服务端消息 id，幂等）：清空内容/meta + 打撤回标记
#[tauri::command]
pub fn apply_recalled(state: State<Db>, server_msg_id: String) -> Result<bool, String> {
    let conn = lock(&state)?;
    chat::apply_recalled(&conn, &server_msg_id).map_err(|e| e.to_string())
}

/// 推进对端已读/送达水位（只前进不后退）并物化己方消息状态
#[tauri::command]
pub fn set_peer_watermarks(
    state: State<Db>,
    conversation_id: i64,
    read_up_to: Option<i64>,
    delivered_up_to: Option<i64>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    chat::set_peer_watermarks(&conn, conversation_id, read_up_to, delivered_up_to)
        .map_err(|e| e.to_string())
}

/// 删除单条消息
#[tauri::command]
pub fn delete_message(state: State<Db>, message_id: i64) -> Result<(), String> {
    let conn = lock(&state)?;
    chat::delete_message(&conn, message_id).map_err(|e| e.to_string())
}

/// 会话内关键词搜索
#[tauri::command]
pub fn search_messages(
    state: State<Db>,
    conversation_id: i64,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<ChatMessage>, String> {
    let conn = lock(&state)?;
    chat::search_messages(&conn, conversation_id, &query, limit).map_err(|e| e.to_string())
}
