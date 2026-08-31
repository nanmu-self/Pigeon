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
        SELECT c.id, c.kind, c.name, c.peer_id, c.created_at, c.updated_at,
               m.id, m.sender, m.sender_name, m.kind, m.content, m.created_at,
               (SELECT COUNT(*) FROM messages u
                 WHERE u.conversation_id = c.id
                   AND u.sender <> 'self'
                   AND u.id > COALESCE(c.last_read_message_id, 0)) AS unread_count
        FROM conversations c
        LEFT JOIN messages m
          ON m.id = (SELECT id FROM messages
                      WHERE conversation_id = c.id
                      ORDER BY id DESC LIMIT 1)
        ORDER BY c.updated_at DESC, c.id DESC
        "#,
    )?;

    let rows = stmt.query_map([], |row| {
        let m_id: Option<i64> = row.get(6)?;
        let last_message = if m_id.is_some() {
            Some(LastMessage {
                id: m_id.unwrap(),
                sender: row.get(7)?,
                sender_name: row.get(8)?,
                kind: row.get(9)?,
                content: row.get(10)?,
                created_at: row.get(11)?,
            })
        } else {
            None
        };

        Ok(ConversationSummary {
            id: row.get(0)?,
            kind: row.get(1)?,
            name: row.get(2)?,
            peer_id: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            last_message,
            unread_count: row.get(12)?,
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
        created_at: now,
        updated_at: now,
    })
}

/// 标记会话已读（把 last_read_message_id 推进到最新一条）
pub fn mark_conversation_read(conn: &Connection, conversation_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations
         SET last_read_message_id = (SELECT COALESCE(MAX(id), 0) FROM messages
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
        "UPDATE conversations SET last_read_message_id = NULL WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

// ── 消息 ─────────────────────────────────────────────────────

/// 拉取消息（keyset 分页）：返回按时间正序的最多 `limit` 条，
/// 传 `before_id` 则取该条之前的更早消息（上滑加载历史）
pub fn get_messages(
    conn: &Connection,
    conversation_id: i64,
    limit: Option<i64>,
    before_id: Option<i64>,
) -> Result<Vec<ChatMessage>, rusqlite::Error> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT).clamp(1, 500);

    let mut stmt = conn.prepare(
        r#"
        SELECT id, conversation_id, sender, sender_name, kind, content, status, created_at
        FROM messages
        WHERE conversation_id = ?1
          AND (?2 IS NULL OR id < ?2)
        ORDER BY id DESC
        LIMIT ?3
        "#,
    )?;

    let mut rows = stmt
        .query_map(params![conversation_id, before_id, limit], map_message)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.reverse(); // 查询按 id 倒序，翻转为时间正序
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
              client_msg_id, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            msg.conversation_id,
            msg.sender,
            msg.sender_name,
            msg.kind,
            msg.content,
            msg.client_msg_id,
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
        created_at: now,
    })
}

/// 删除单条消息
pub fn delete_message(conn: &Connection, message_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM messages WHERE id = ?1", params![message_id])?;
    Ok(())
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
        SELECT id, conversation_id, sender, sender_name, kind, content, status, created_at
        FROM messages
        WHERE conversation_id = ?1 AND content LIKE '%' || ?2 || '%'
        ORDER BY id DESC
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
        created_at: row.get(7)?,
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
        let page = get_messages(&conn, conv.id, Some(50), None).unwrap();
        assert_eq!(page.len(), 50);
        assert!(page.windows(2).all(|w| w[0].id < w[1].id));
        assert_eq!(page.last().unwrap().content, "msg59");

        // 上滑加载更早的一页
        let older = get_messages(&conn, conv.id, Some(50), Some(page[0].id)).unwrap();
        assert_eq!(older.len(), 10);
        assert_eq!(older.last().unwrap().content, "msg9");
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
        assert!(get_messages(&conn, conv.id, None, None).unwrap().is_empty());
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
