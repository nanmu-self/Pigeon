//! 聊天记录仓储层 — 所有 SQL 集中在这里，接受 `&Connection`，
//! 与 Tauri 解耦，可直接用内存 SQLite 做单元测试。

use rusqlite::{params, Connection};

use crate::db::now_ms;
use crate::models::*;

const DEFAULT_PAGE_LIMIT: i64 = 50;

// ── 会话 ─────────────────────────────────────────────────────

/// 会话列表：按最近活跃倒序，附带最新一条消息与未读数
pub fn list_conversations(conn: &Connection) -> Result<Vec<ConversationSummary>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        r#"
        SELECT c.id, c.kind, c.name, c.peer_id, c.server_session_id,
               c.peer_read_msg_id, c.peer_delivered_msg_id, c.created_at, c.updated_at,
               m.id, m.sender, m.sender_name, m.kind, m.content, m.created_at,
               (SELECT COUNT(*) FROM messages u
                 WHERE u.conversation_id = c.id
                   AND u.sender <> 'self'
                   AND u.created_at > COALESCE(c.last_read_at, 0)) AS unread_count
        FROM conversations c
        LEFT JOIN messages m
          ON m.id = (SELECT id FROM messages
                      WHERE conversation_id = c.id
                      ORDER BY created_at DESC, id DESC LIMIT 1)
        ORDER BY c.updated_at DESC, c.id DESC
        "#,
    )?;

    let rows = stmt.query_map([], |row| {
        let m_id: Option<i64> = row.get(9)?;
        let last_message = if m_id.is_some() {
            Some(LastMessage {
                id: m_id.unwrap(),
                sender: row.get(10)?,
                sender_name: row.get(11)?,
                kind: row.get(12)?,
                content: row.get(13)?,
                created_at: row.get(14)?,
            })
        } else {
            None
        };

        Ok(ConversationSummary {
            id: row.get(0)?,
            kind: row.get(1)?,
            name: row.get(2)?,
            peer_id: row.get(3)?,
            server_session_id: row.get(4)?,
            peer_read_msg_id: row.get(5)?,
            peer_delivered_msg_id: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            last_message,
            unread_count: row.get(15)?,
        })
    })?;

    rows.collect()
}

/// 新建会话。调用方负责校验 name / kind。
pub fn create_conversation(
    conn: &Connection,
    name: &str,
    kind: &str,
) -> Result<Conversation, rusqlite::Error> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO conversations (kind, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)",
        params![kind, name, now],
    )?;

    Ok(Conversation {
        id: conn.last_insert_rowid(),
        kind: kind.to_string(),
        name: name.to_string(),
        peer_id: None,
        server_session_id: None,
        peer_read_msg_id: None,
        peer_delivered_msg_id: None,
        created_at: now,
        updated_at: now,
    })
}

/// 按服务端会话 id 查本地会话
pub fn find_conversation_by_session(
    conn: &Connection,
    server_session_id: &str,
) -> Result<Option<Conversation>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, name, peer_id, server_session_id, peer_read_msg_id,
                peer_delivered_msg_id, created_at, updated_at
         FROM conversations WHERE server_session_id = ?1",
    )?;
    let mut rows = stmt.query_map(params![server_session_id], map_conversation)?;
    rows.next().transpose()
}

/// 确保存在与服务端会话关联的本地会话（无则创建，幂等）
pub fn ensure_conversation(
    conn: &Connection,
    server_session_id: &str,
    peer_id: &str,
    peer_name: &str,
) -> Result<Conversation, rusqlite::Error> {
    if let Some(existing) = find_conversation_by_session(conn, server_session_id)? {
        return Ok(existing);
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO conversations (kind, name, peer_id, server_session_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![KIND_DIRECT, peer_name, peer_id, server_session_id, now],
    )?;
    Ok(Conversation {
        id: conn.last_insert_rowid(),
        kind: KIND_DIRECT.to_string(),
        name: peer_name.to_string(),
        peer_id: Some(peer_id.to_string()),
        server_session_id: Some(server_session_id.to_string()),
        peer_read_msg_id: None,
        peer_delivered_msg_id: None,
        created_at: now,
        updated_at: now,
    })
}

/// 确保存在与服务端群会话关联的本地会话（无则创建，幂等）
pub fn ensure_group_conversation(
    conn: &Connection,
    server_session_id: &str,
    group_name: &str,
) -> Result<Conversation, rusqlite::Error> {
    if let Some(existing) = find_conversation_by_session(conn, server_session_id)? {
        return Ok(existing);
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO conversations (kind, name, peer_id, server_session_id, created_at, updated_at)
         VALUES (?1, ?2, NULL, ?3, ?4, ?4)",
        params![KIND_GROUP, group_name, server_session_id, now],
    )?;
    Ok(Conversation {
        id: conn.last_insert_rowid(),
        kind: KIND_GROUP.to_string(),
        name: group_name.to_string(),
        peer_id: None,
        server_session_id: Some(server_session_id.to_string()),
        peer_read_msg_id: None,
        peer_delivered_msg_id: None,
        created_at: now,
        updated_at: now,
    })
}

fn map_conversation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        peer_id: row.get(3)?,
        server_session_id: row.get(4)?,
        peer_read_msg_id: row.get(5)?,
        peer_delivered_msg_id: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

/// 标记会话已读（记录本端已读时间戳；合并回填的历史不算未读）
pub fn mark_conversation_read(conn: &Connection, conversation_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations
         SET last_read_at = (SELECT COALESCE(MAX(created_at), 0) FROM messages
                              WHERE conversation_id = ?1),
             last_read_message_id = (SELECT COALESCE(MAX(id), 0) FROM messages
                                      WHERE conversation_id = ?1)
         WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

/// 删除会话（消息随 CASCADE 一并删除）
pub fn delete_conversation(conn: &Connection, conversation_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM conversations WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

/// 清空会话聊天记录（保留会话本身）
pub fn clear_history(conn: &Connection, conversation_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![conversation_id],
    )?;
    conn.execute(
        "UPDATE conversations SET last_read_at = NULL WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

// ── 消息 ─────────────────────────────────────────────────────

/// 拉取消息（keyset 分页）：按时间正序的最多 `limit` 条；
/// 传 `before_created_at + before_id`（某条消息的时间与本地 id）则取更早的一页。
///
/// 注意：历史合并是乱序插入（回填更早的消息），本地自增 id 顺序 ≠ 时间顺序，
/// 因此排序与游标都用 (created_at, id) 复合键，索引 idx_messages_conv_time 兜底。
pub fn get_messages(
    conn: &Connection,
    conversation_id: i64,
    limit: Option<i64>,
    before_created_at: Option<i64>,
    before_id: Option<i64>,
) -> Result<Vec<ChatMessage>, rusqlite::Error> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT).clamp(1, 500);

    let mut stmt = conn.prepare(
        r#"
        SELECT id, conversation_id, sender, sender_name, kind, content, status, meta, server_msg_id, reply_summary, reactions, recalled, client_msg_id, created_at
        FROM messages
        WHERE conversation_id = ?1
          AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
        ORDER BY created_at DESC, id DESC
        LIMIT ?4
        "#,
    )?;

    let mut rows = stmt
        .query_map(
            params![conversation_id, before_created_at, before_id, limit],
            map_message,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    rows.reverse(); // 查询按时间倒序，翻转为时间正序
    Ok(rows)
}

/// 写入一条消息（事务内完成：插入 + 触碰会话 updated_at）。
/// 非法字段值由数据库 CHECK 约束兜底。
pub fn insert_message(
    conn: &Connection,
    msg: NewMessage,
) -> Result<ChatMessage, rusqlite::Error> {
    let now = now_ms();

    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO messages
             (conversation_id, sender, sender_name, kind, content,
              client_msg_id, meta, reply_summary, reactions, recalled, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            msg.conversation_id,
            msg.sender,
            msg.sender_name,
            msg.kind,
            msg.content,
            msg.client_msg_id,
            msg.meta,
            msg.reply_summary,
            msg.reactions,
            msg.recalled,
            msg.status,
            now
        ],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
        params![now, msg.conversation_id],
    )?;
    tx.commit()?;

    Ok(ChatMessage {
        id,
        conversation_id: msg.conversation_id,
        sender: msg.sender,
        sender_name: msg.sender_name,
        kind: msg.kind,
        content: msg.content,
        status: msg.status,
        meta: msg.meta,
        server_msg_id: None,
        reply_summary: msg.reply_summary,
        reactions: msg.reactions,
        recalled: msg.recalled,
        client_msg_id: msg.client_msg_id,
        created_at: now,
    })
}

/// 删除单条消息
pub fn delete_message(conn: &Connection, message_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
    Ok(())
}

// ── 服务端消息合并 / 状态同步 ───────────────────────────

/// 合并一条服务端已落库的消息（历史拉取与 WS message:new 共用）。
///
/// 幂等性三重保障：
///  1. 同 client_msg_id 的本机 optimistic 占位行 → 补上服务端 id/时间（ack 与
///     WS 推送的竞态，先到者胜，后到者命中同一条）；
///  2. server_msg_id 唯一索引 → 重复推送/重复拉取直接返回已有行；
///  3. inserted 标记调用方是否需要刷新 UI。
pub fn upsert_server_message(
    conn: &Connection,
    m: &ServerMessage,
) -> Result<MergeResult, rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;

    // ① 占位行补全：本机发送的消息在 WS 推送先于 ack 到达时走这里
    if let Some(client_msg_id) = m.client_msg_id.as_deref() {
        let updated = tx.execute(
            "UPDATE messages
             SET server_msg_id = ?2, created_at = ?3, status = 'sent'
             WHERE client_msg_id = ?1 AND server_msg_id IS NULL AND status = 'sending'",
            params![client_msg_id, m.server_msg_id, m.created_at],
        )?;
        if updated > 0 {
            // 按对端水位重算状态（推送先于 ack 到达时，可能已被读过）
            let status = status_for_server_message(&tx, m)?;
            tx.execute(
                "UPDATE messages SET status = ?2 WHERE server_msg_id = ?1",
                params![m.server_msg_id, status],
            )?;
            let message = fetch_by_server_msg_id(&tx, &m.server_msg_id)?
                .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
            tx.commit()?;
            return Ok(MergeResult { message, inserted: false });
        }
    }

    // ② 已存在（WS 重推 / 历史重复拉取）→ 幂等返回
    if let Some(message) = fetch_by_server_msg_id(&tx, &m.server_msg_id)? {
        return Ok(MergeResult { message, inserted: false });
    }

    // ③ 新消息入库；status 按对端水位推导（合并的可能是早已被读掉的旧消息）
    let status = status_for_server_message(&tx, m)?;
    tx.execute(
        "INSERT INTO messages
             (conversation_id, sender, sender_name, kind, content,
              client_msg_id, server_msg_id, meta, reply_summary, reactions, recalled, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            m.conversation_id,
            m.sender,
            m.sender_name,
            m.kind,
            m.content,
            m.client_msg_id,
            m.server_msg_id,
            m.meta,
            m.reply_summary,
            m.reactions,
            m.recalled,
            status,
            m.created_at
        ],
    )?;
    let id = tx.last_insert_rowid();
    // 会话活跃时间只前进不后退（回填更早的历史不能压低排序列表顺序）
    tx.execute(
        "UPDATE conversations SET updated_at = MAX(updated_at, ?1) WHERE id = ?2",
        params![m.created_at, m.conversation_id],
    )?;
    tx.commit()?;

    Ok(MergeResult {
        message: ChatMessage {
            id,
            conversation_id: m.conversation_id,
            sender: m.sender.clone(),
            sender_name: m.sender_name.clone(),
            kind: m.kind.clone(),
            content: m.content.clone(),
            status: status.to_string(),
            meta: m.meta.clone(),
            server_msg_id: Some(m.server_msg_id.clone()),
            reply_summary: m.reply_summary.clone(),
            reactions: m.reactions.clone(),
            recalled: m.recalled,
            client_msg_id: m.client_msg_id.clone(),
            created_at: m.created_at,
        },
        inserted: true,
    })
}

/// 发送方 ack：optimistic 占位行回填服务端 id / 服务端时间，置为已发出。
/// 若 WS 推送已先到（upsert 路径 ① 已补全），直接返回已有行。
pub fn acknowledge_message(
    conn: &Connection,
    client_msg_id: &str,
    server_msg_id: &str,
    created_at: i64,
) -> Result<ChatMessage, rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE messages
         SET server_msg_id = ?2, created_at = ?3, status = 'sent'
         WHERE client_msg_id = ?1 AND server_msg_id IS NULL AND status = 'sending'",
        params![client_msg_id, server_msg_id, created_at],
    )?;
    let message = fetch_by_server_msg_id(&tx, server_msg_id)?
        .ok_or_else(|| {
            rusqlite::Error::InvalidParameterName("ack 未命中任何消息".into())
        })?;
    tx.commit()?;
    Ok(message)
}

/// 标记发送失败（WS 发送被拒/断线）
pub fn mark_message_failed(
    conn: &Connection,
    client_msg_id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET status = 'failed'
         WHERE client_msg_id = ?1 AND status = 'sending'",
        params![client_msg_id],
    )?;
    Ok(())
}

/// 重试失败的消息：status 置回 sending（随后走正常 ack 回填流程）
pub fn retry_message(conn: &Connection, client_msg_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET status = 'sending'
         WHERE client_msg_id = ?1 AND status = 'failed'",
        params![client_msg_id],
    )?;
    Ok(())
}

/// 本地应用撤回：清空内容/meta、打撤回标记（按服务端消息 id 幂等）。
/// 返回是否实际更新了行（用于 UI 判断是否需要刷新）。
pub fn apply_recalled(conn: &Connection, server_msg_id: &str) -> Result<bool, rusqlite::Error> {
    let updated = conn.execute(
        "UPDATE messages
         SET recalled = 1, content = '', meta = NULL, reactions = NULL
         WHERE server_msg_id = ?1 AND recalled = 0",
        params![server_msg_id],
    )?;
    Ok(updated > 0)
}

/// 推进对端已读/送达水位（只前进不后退），并把本地己方消息的
/// status 物化到对应状态（渲染时直接读 status，无需再算比较）。
pub fn set_peer_watermarks(
    conn: &Connection,
    conversation_id: i64,
    read_up_to: Option<i64>,
    delivered_up_to: Option<i64>,
) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE conversations
         SET peer_read_msg_id = MAX(COALESCE(peer_read_msg_id, 0), COALESCE(?2, 0)),
             peer_delivered_msg_id = MAX(COALESCE(peer_delivered_msg_id, 0), COALESCE(?3, 0))
         WHERE id = ?1",
        params![conversation_id, read_up_to, delivered_up_to],
    )?;

    // 先送达后已读（已读优先级更高，且覆盖送达）
    if let Some(delivered) = delivered_up_to {
        tx.execute(
            "UPDATE messages SET status = 'delivered'
             WHERE conversation_id = ?1 AND sender = 'self' AND status = 'sent'
               AND server_msg_id IS NOT NULL
               AND CAST(server_msg_id AS INTEGER) <= ?2",
            params![conversation_id, delivered],
        )?;
    }
    if let Some(read) = read_up_to {
        tx.execute(
            "UPDATE messages SET status = 'read'
             WHERE conversation_id = ?1 AND sender = 'self'
               AND status IN ('sent', 'delivered')
               AND server_msg_id IS NOT NULL
               AND CAST(server_msg_id AS INTEGER) <= ?2",
            params![conversation_id, read],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 按 sender 推导合并入库时的初始 status：
/// 己方消息对照对端水位（可能早已被读掉）；对方消息无状态语义，置 sent。
fn status_for_server_message(
    conn: &Connection,
    m: &ServerMessage,
) -> Result<&'static str, rusqlite::Error> {
    if m.sender != SENDER_SELF {
        return Ok(STATUS_SENT);
    }
    let Ok(server_id) = m.server_msg_id.parse::<i64>() else {
        return Ok(STATUS_SENT);
    };
    let (read, delivered): (Option<i64>, Option<i64>) = conn.query_row(
        "SELECT peer_read_msg_id, peer_delivered_msg_id FROM conversations WHERE id = ?1",
        params![m.conversation_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if read.is_some_and(|w| server_id <= w) {
        return Ok(STATUS_READ);
    }
    if delivered.is_some_and(|w| server_id <= w) {
        return Ok(STATUS_DELIVERED);
    }
    Ok(STATUS_SENT)
}

fn fetch_by_server_msg_id(
    conn: &Connection,
    server_msg_id: &str,
) -> Result<Option<ChatMessage>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, sender, sender_name, kind, content, status, meta, server_msg_id, reply_summary, reactions, recalled, client_msg_id, created_at
         FROM messages WHERE server_msg_id = ?1",
    )?;
    let mut rows = stmt.query_map(params![server_msg_id], map_message)?;
    rows.next().transpose()
}

/// 按关键词搜索某个会话的消息（LIKE 包含匹配，最新在前）
pub fn search_messages(
    conn: &Connection,
    conversation_id: i64,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<ChatMessage>, rusqlite::Error> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(50).clamp(1, 200);

    let mut stmt = conn.prepare(
        r#"
        SELECT id, conversation_id, sender, sender_name, kind, content, status, meta, server_msg_id, reply_summary, reactions, recalled, client_msg_id, created_at
        FROM messages
        WHERE conversation_id = ?1 AND content LIKE '%' || ?2 || '%'
        ORDER BY created_at DESC, id DESC
        LIMIT ?3
        "#,
    )?;

    let rows = stmt
        .query_map(params![conversation_id, query, limit], map_message)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        sender: row.get(2)?,
        sender_name: row.get(3)?,
        kind: row.get(4)?,
        content: row.get(5)?,
        status: row.get(6)?,
        meta: row.get(7)?,
        server_msg_id: row.get(8)?,
        reply_summary: row.get(9)?,
        reactions: row.get(10)?,
        recalled: row.get::<_, i64>(11)? != 0,
        client_msg_id: row.get(12)?,
        created_at: row.get(13)?,
    })
}

// ── 测试：内存 SQLite 全流程验证 ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrate;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn msg(conversation_id: i64, sender: &str, content: &str) -> NewMessage {
        NewMessage {
            conversation_id,
            sender: sender.to_string(),
            sender_name: String::new(),
            kind: MSG_TEXT.to_string(),
            content: content.to_string(),
            client_msg_id: None,
            meta: None,
            reply_summary: None,
            reactions: None,
            recalled: false,
            status: STATUS_SENT.to_string(),
        }
    }

    #[test]
    fn full_conversation_flow() {
        let conn = mem_db();
        let conv = create_conversation(&conn, "张三", KIND_DIRECT).unwrap();

        // 会话存在但还没有消息
        let list = list_conversations(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].last_message.is_none());
        assert_eq!(list[0].unread_count, 0);

        // 收发消息
        let m1 = insert_message(&conn, msg(conv.id, SENDER_SELF, "你好")).unwrap();
        let m2 = insert_message(&conn, msg(conv.id, SENDER_OTHER, "在吗")).unwrap();
        assert!(m1.id < m2.id);

        // 未读数只统计对方消息；最新一条为预览
        let list = list_conversations(&conn).unwrap();
        assert_eq!(list[0].unread_count, 1);
        assert_eq!(list[0].last_message.as_ref().unwrap().id, m2.id);
        assert_eq!(list[0].last_message.as_ref().unwrap().content, "在吗");

        // 已读后未读清零
        mark_conversation_read(&conn, conv.id).unwrap();
        let list = list_conversations(&conn).unwrap();
        assert_eq!(list[0].unread_count, 0);
    }

    #[test]
    fn pagination_and_ordering() {
        let conn = mem_db();
        let conv = create_conversation(&conn, "群聊", KIND_GROUP).unwrap();

        for i in 0..60 {
            insert_message(&conn, msg(conv.id, SENDER_OTHER, &format!("msg{i}"))).unwrap();
        }

        // 首页 50 条、时间正序、末尾是最新一条
        let page = get_messages(&conn, conv.id, Some(50), None, None).unwrap();
        assert_eq!(page.len(), 50);
        assert!(page.windows(2).all(|w| w[0].id < w[1].id));
        assert_eq!(page.last().unwrap().content, "msg59");

        // 上滑加载更早的一页（复合游标：created_at + id）
        let older = get_messages(
            &conn,
            conv.id,
            Some(50),
            Some(page[0].created_at),
            Some(page[0].id),
        )
        .unwrap();
        assert_eq!(older.len(), 10);
        assert_eq!(older.last().unwrap().content, "msg9");
    }

    #[test]
    fn server_message_merge_is_idempotent_and_ordered() {
        let conn = mem_db();
        let conv = ensure_conversation(&conn, "sess-1", "2", "Bob").unwrap();
        assert_eq!(conv.server_session_id.as_deref(), Some("sess-1"));
        // 幂等：重复 ensure 返回同一会话
        let again = ensure_conversation(&conn, "sess-1", "2", "Bob").unwrap();
        assert_eq!(again.id, conv.id);

        let srv = |id: u64, content: &str, created_at: i64| ServerMessage {
            conversation_id: conv.id,
            server_msg_id: id.to_string(),
            sender: SENDER_OTHER.to_string(),
            sender_name: "Bob".to_string(),
            kind: MSG_TEXT.to_string(),
            content: content.to_string(),
            created_at,
            client_msg_id: None,
            meta: None,
            reply_summary: None,
            reactions: None,
            recalled: false,
        };

        // 先拉到新页（id 101/102，时间较晚），再回填更早的一页（id 99/100）
        let mut r1 = upsert_server_message(&conn, &srv(101, "m101", 2000)).unwrap();
        assert!(r1.inserted);
        // 图片消息：meta（JSON 字符串）入库后原样读回
        let mut srv101 = srv(101, "m101", 2000);
        srv101.kind = MSG_IMAGE.to_string();
        srv101.meta = Some(r#"{"fname":"a.png","size":2048}"#.to_string());
        r1 = upsert_server_message(&conn, &srv101).unwrap();
        assert!(!r1.inserted); // id 重复 → 幂等跳过，不入库
        let with_meta = ServerMessage {
            conversation_id: conv.id,
            server_msg_id: "103".to_string(),
            sender: SENDER_OTHER.to_string(),
            sender_name: "Bob".to_string(),
            kind: MSG_IMAGE.to_string(),
            content: "http://oss/a.png".to_string(),
            created_at: 4000,
            client_msg_id: None,
            meta: Some(r#"{"fname":"a.png","size":2048}"#.to_string()),
            reply_summary: None,
            reactions: None,
            recalled: false,
        };
        let r3 = upsert_server_message(&conn, &with_meta).unwrap();
        assert!(r3.inserted);
        assert_eq!(r3.message.meta.as_deref(), Some(r#"{"fname":"a.png","size":2048}"#));
        let r2 = upsert_server_message(&conn, &srv(102, "m102", 3000)).unwrap();
        assert!(r2.inserted);
        let r99 = upsert_server_message(&conn, &srv(99, "m99", 1000)).unwrap();
        assert!(r99.inserted);

        // 重复拉取 → 幂等，不产生重复行
        let dup = upsert_server_message(&conn, &srv(101, "m101", 2000)).unwrap();
        assert!(!dup.inserted);
        assert_eq!(dup.message.id, r1.message.id);

        // 乱序插入后仍按时间正序返回（本地 id 顺序 ≠ 时间顺序）
        let page = get_messages(&conn, conv.id, None, None, None).unwrap();
        let contents: Vec<&str> = page.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(contents, vec!["m99", "m101", "m102", "http://oss/a.png"]);
    }

    #[test]
    fn watermarks_drive_status_and_stay_monotonic() {
        let conn = mem_db();
        let conv = ensure_conversation(&conn, "sess-2", "3", "Bob").unwrap();

        let self_srv = |id: u64, created_at: i64| ServerMessage {
            conversation_id: conv.id,
            server_msg_id: id.to_string(),
            sender: SENDER_SELF.to_string(),
            sender_name: String::new(),
            kind: MSG_TEXT.to_string(),
            content: format!("msg{id}"),
            created_at,
            client_msg_id: None,
            meta: None,
            reply_summary: None,
            reactions: None,
            recalled: false,
        };

        // 合并三条自己发的消息：尚未任何回执 → 全部 sent
        for (id, at) in [(1u64, 1000i64), (2, 2000), (3, 3000)] {
            let r = upsert_server_message(&conn, &self_srv(id, at)).unwrap();
            assert_eq!(r.message.status, STATUS_SENT);
        }

        // 对端读到 id 2 → id<=2 置 read，id 3 仍是 sent；水位只前进
        set_peer_watermarks(&conn, conv.id, Some(2), Some(2)).unwrap();
        set_peer_watermarks(&conn, conv.id, Some(1), None).unwrap(); // 旧回执不回退
        let by_id = |id: i64| {
            conn.query_row(
                "SELECT status FROM messages WHERE conversation_id = ?1 AND server_msg_id = ?2",
                params![conv.id, id.to_string()],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
        };
        assert_eq!(by_id(1), STATUS_READ);
        assert_eq!(by_id(2), STATUS_READ);
        assert_eq!(by_id(3), STATUS_SENT);

        // 送达水位先到（3 送达）→ 再读 → read 覆盖 delivered
        set_peer_watermarks(&conn, conv.id, None, Some(3)).unwrap();
        assert_eq!(by_id(3), STATUS_DELIVERED);
        set_peer_watermarks(&conn, conv.id, Some(3), None).unwrap();
        assert_eq!(by_id(3), STATUS_READ);

        // 之后回填的水位内的历史消息直接合并为已读状态
        let r4 = upsert_server_message(&conn, &self_srv(4, 4000)).unwrap(); // 水位外 → sent
        assert_eq!(r4.message.status, STATUS_SENT);
        set_peer_watermarks(&conn, conv.id, Some(4), None).unwrap();
        let late = upsert_server_message(&conn, &self_srv(5, 5000)).unwrap();
        assert_eq!(late.message.status, STATUS_SENT);
    }

    #[test]
    fn optimistic_send_and_ack_race() {
        let conn = mem_db();
        let conv = ensure_conversation(&conn, "sess-3", "4", "Bob").unwrap();

        // 本机 optimistic 占位行
        let staged = insert_message(
            &conn,
            NewMessage {
                conversation_id: conv.id,
                sender: SENDER_SELF.to_string(),
                sender_name: String::new(),
                kind: MSG_TEXT.to_string(),
                content: "你好".to_string(),
                client_msg_id: Some("cm-1".to_string()),
                meta: None,
                reply_summary: None,
                reactions: None,
                recalled: false,
                status: STATUS_SENDING.to_string(),
            },
        )
        .unwrap();

        // 竞态：WS 推送先于 ack 到达（同 client_msg_id 的 upsert 补全占位行）
        let pushed = upsert_server_message(
            &conn,
            &ServerMessage {
                conversation_id: conv.id,
                server_msg_id: "100".to_string(),
                sender: SENDER_SELF.to_string(),
                sender_name: String::new(),
                kind: MSG_TEXT.to_string(),
                content: "你好".to_string(),
                created_at: 1234,
                client_msg_id: Some("cm-1".to_string()),
                meta: None,
                reply_summary: None,
                reactions: None,
                recalled: false,
            },
        )
        .unwrap();
        assert!(!pushed.inserted);
        assert_eq!(pushed.message.id, staged.id); // 补全而不是新建
        assert_eq!(pushed.message.status, STATUS_SENT);

        // ack 后到：不再有 sending 占位行 → 幂等返回已存在行
        let acked = acknowledge_message(&conn, "cm-1", "100", 1234).unwrap();
        assert_eq!(acked.id, staged.id);

        // 全库只有一条，不产生重复
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn apply_recalled_clears_content_and_is_idempotent() {
        let conn = mem_db();
        let conv = ensure_conversation(&conn, "sess-5", "6", "Bob").unwrap();

        // 合并一条已同步的消息
        upsert_server_message(
            &conn,
            &ServerMessage {
                conversation_id: conv.id,
                server_msg_id: "9".to_string(),
                sender: SENDER_OTHER.to_string(),
                sender_name: "Bob".to_string(),
                kind: MSG_TEXT.to_string(),
                content: "将被撤回".to_string(),
                created_at: 1000,
                client_msg_id: None,
                meta: None,
                reply_summary: None,
                reactions: None,
                recalled: false,
            },
        )
        .unwrap();

        // 本地应用撤回：内容/meta/reactions 清空 + 标记
        let changed = apply_recalled(&conn, "9").unwrap();
        assert!(changed);
        let row = get_messages(&conn, conv.id, None, None, None).unwrap().remove(0);
        assert!(row.recalled);
        assert_eq!(row.content, "");
        assert!(row.meta.is_none());

        // 幂等：再次应用不再变更
        assert!(!apply_recalled(&conn, "9").unwrap());
    }

    #[test]
    fn backfilled_history_does_not_count_as_unread() {
        let conn = mem_db();
        let conv = ensure_conversation(&conn, "sess-4", "5", "Bob").unwrap();

        // 回填一批“早已读过”的旧消息
        for id in [1u64, 2, 3] {
            upsert_server_message(
                &conn,
                &ServerMessage {
                    conversation_id: conv.id,
                    server_msg_id: id.to_string(),
                    sender: SENDER_OTHER.to_string(),
                    sender_name: "Bob".to_string(),
                    kind: MSG_TEXT.to_string(),
                    content: format!("old{id}"),
                    created_at: id as i64 * 1000,
                    client_msg_id: None,
                    meta: None,
                    reply_summary: None,
                    reactions: None,
                    recalled: false,
                },
            )
            .unwrap();
        }
        // 全部视为已读（本端已读时间戳推进）
        mark_conversation_read(&conn, conv.id).unwrap();

        // 新消息到达 → 才计入未读
        upsert_server_message(
            &conn,
            &ServerMessage {
                conversation_id: conv.id,
                server_msg_id: "4".to_string(),
                sender: SENDER_OTHER.to_string(),
                sender_name: "Bob".to_string(),
                kind: MSG_TEXT.to_string(),
                content: "new".to_string(),
                created_at: 10_000,
                client_msg_id: None,
                meta: None,
                reply_summary: None,
                reactions: None,
                recalled: false,
            },
        )
        .unwrap();

        let list = list_conversations(&conn).unwrap();
        assert_eq!(list[0].unread_count, 1);
    }

    #[test]
    fn search_and_clear() {
        let conn = mem_db();
        let conv = create_conversation(&conn, "陈七", KIND_DIRECT).unwrap();
        insert_message(&conn, msg(conv.id, SENDER_SELF, "明天开会")).unwrap();
        insert_message(&conn, msg(conv.id, SENDER_OTHER, "会议改到三点")).unwrap();
        insert_message(&conn, msg(conv.id, SENDER_OTHER, "收到")).unwrap();

        let hits = search_messages(&conn, conv.id, "会议", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "会议改到三点");

        clear_history(&conn, conv.id).unwrap();
        assert!(get_messages(&conn, conv.id, None, None, None).unwrap().is_empty());
        let list = list_conversations(&conn).unwrap();
        assert_eq!(list.len(), 1); // 会话保留
        assert!(list[0].last_message.is_none());
    }

    #[test]
    fn delete_conversation_cascades_messages() {
        let conn = mem_db();
        let conv = create_conversation(&conn, "李四", KIND_DIRECT).unwrap();
        insert_message(&conn, msg(conv.id, SENDER_SELF, "将被级联删除")).unwrap();

        delete_conversation(&conn, conv.id).unwrap();
        assert!(list_conversations(&conn).unwrap().is_empty());

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn message_to_missing_conversation_fails() {
        let conn = mem_db();
        assert!(insert_message(&conn, msg(999, SENDER_SELF, "孤儿消息")).is_err());
    }

    #[test]
    fn invalid_enum_values_rejected_by_check_constraints() {
        let conn = mem_db();
        let conv = create_conversation(&conn, "王五", KIND_DIRECT).unwrap();
        let mut bad = msg(conv.id, SENDER_SELF, "非法 sender");
        bad.sender = "hacker".into();
        assert!(insert_message(&conn, bad).is_err());
    }
}
