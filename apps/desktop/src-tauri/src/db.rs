//! SQLite 连接管理 + 嵌入式迁移。
//!
//! - 数据库文件位于系统应用数据目录（Windows: %APPDATA%/com.zhang.pigeon/pigeon.db）
//! - 通过 `PRAGMA user_version` 做版本化迁移，启动时自动执行未应用的 schema
//! - WAL 模式提升并发读写性能

use std::{fs, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// 全局数据库连接（Tauri managed state）
pub struct Db(pub Mutex<Connection>);

/// 当前 Unix 毫秒时间戳
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_millis() as i64
}

/// 打开连接并执行迁移，在 `setup` 阶段调用
pub fn init(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    let db_path = dir.join("pigeon.db");

    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    migrate(&conn)?;
    Ok(conn)
}

/// 版本化迁移：v1 = 会话 + 消息表（pub(crate) 供单元测试使用）
pub(crate) fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if version < 1 {
        conn.execute_batch(
            r#"
            BEGIN;

            CREATE TABLE IF NOT EXISTS conversations (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                kind                 TEXT    NOT NULL DEFAULT 'direct'
                                     CHECK (kind IN ('direct', 'group')),
                name                 TEXT    NOT NULL,
                peer_id              TEXT,
                last_read_message_id INTEGER,
                created_at           INTEGER NOT NULL,
                updated_at           INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL
                                REFERENCES conversations(id) ON DELETE CASCADE,
                sender          TEXT    NOT NULL
                                CHECK (sender IN ('self', 'other', 'system')),
                sender_name     TEXT    NOT NULL DEFAULT '',
                kind            TEXT    NOT NULL DEFAULT 'text'
                                CHECK (kind IN ('text', 'image', 'file', 'system')),
                content         TEXT    NOT NULL,
                client_msg_id   TEXT,
                server_msg_id   TEXT,
                status          TEXT    NOT NULL DEFAULT 'sent'
                                CHECK (status IN ('sending', 'sent', 'failed', 'read')),
                created_at      INTEGER NOT NULL
            );

            -- 会话内按 id 倒序取消息（分页走此索引）
            CREATE INDEX IF NOT EXISTS idx_messages_conv
                ON messages(conversation_id, id DESC);

            -- client_msg_id 唯一：后续接入服务端同步时做幂等去重
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client
                ON messages(client_msg_id) WHERE client_msg_id IS NOT NULL;

            -- 会话列表按最近活跃排序
            CREATE INDEX IF NOT EXISTS idx_conversations_updated
                ON conversations(updated_at DESC);

            PRAGMA user_version = 1;

            COMMIT;
            "#,
        )?;
    }

    // v2：接入服务端同步 ——
    //  1. conversations 增加服务端会话关联与对端已读/送达水位；
    //  2. messages 重建：status 增加 delivered（SQLite 无法修改 CHECK），
    //     server_msg_id 唯一部分索引（合并去重），
    //     (conversation_id, created_at, id) 索引（异步合并后本地 id 顺序 ≠
    //     时间顺序，查询改按时间走此索引，即「sessionId + timestamp」索引）。
    if version < 2 {
        conn.execute_batch(
            r#"
            BEGIN;

            ALTER TABLE conversations ADD COLUMN server_session_id TEXT;
            ALTER TABLE conversations ADD COLUMN peer_read_msg_id INTEGER;
            ALTER TABLE conversations ADD COLUMN peer_delivered_msg_id INTEGER;
            -- 本端已读时间戳：未读计数按时间比较（合并回填的历史消息不算未读）
            ALTER TABLE conversations ADD COLUMN last_read_at INTEGER;

            -- 同一服务端会话至多映射一个本地会话
            CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_session
                ON conversations(server_session_id) WHERE server_session_id IS NOT NULL;

            -- 重建 messages：扩 CHECK + 唯一索引 + 时间索引一步到位
            CREATE TABLE messages_v2 (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL
                                REFERENCES conversations(id) ON DELETE CASCADE,
                sender          TEXT    NOT NULL
                                CHECK (sender IN ('self', 'other', 'system')),
                sender_name     TEXT    NOT NULL DEFAULT '',
                kind            TEXT    NOT NULL DEFAULT 'text'
                                CHECK (kind IN ('text', 'image', 'file', 'system')),
                content         TEXT    NOT NULL,
                client_msg_id   TEXT,
                server_msg_id   TEXT,
                status          TEXT    NOT NULL DEFAULT 'sent'
                                CHECK (status IN ('sending', 'sent', 'delivered', 'failed', 'read')),
                created_at      INTEGER NOT NULL
            );
            INSERT INTO messages_v2
                (id, conversation_id, sender, sender_name, kind, content,
                 client_msg_id, server_msg_id, status, created_at)
            SELECT id, conversation_id, sender, sender_name, kind, content,
                   client_msg_id, server_msg_id, status, created_at
            FROM messages;
            DROP TABLE messages;
            ALTER TABLE messages_v2 RENAME TO messages;

            -- 服务端消息 id 唯一：WS 推送 / 历史合并 / 多端同步幂等去重
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_server
                ON messages(server_msg_id) WHERE server_msg_id IS NOT NULL;

            -- 会话内按时间排序/分页（异步合并乱序插入后不再依赖自增 id）
            CREATE INDEX IF NOT EXISTS idx_messages_conv_time
                ON messages(conversation_id, created_at, id);

            PRAGMA user_version = 2;

            COMMIT;
            "#,
        )?;
    }

    // v3：图片/文件消息 —— meta 附加信息（JSON 字符串：fname/size/mime 等）
    if version < 3 {
        conn.execute_batch(
            r#"
            BEGIN;

            ALTER TABLE messages ADD COLUMN meta TEXT;

            PRAGMA user_version = 3;

            COMMIT;
            "#,
        )?;
    }

    // v4：引用回复 + 表情回应 —— 本地缓存两列（均为前端序列化的 JSON 字符串）
    if version < 4 {
        conn.execute_batch(
            r#"
            BEGIN;

            -- 被引用消息摘要：{ id, senderName, kind, content }
            ALTER TABLE messages ADD COLUMN reply_summary TEXT;
            -- 表情回应聚合：[ { emoji, userIds: [...] } ]
            ALTER TABLE messages ADD COLUMN reactions TEXT;

            PRAGMA user_version = 4;

            COMMIT;
            "#,
        )?;
    }

    Ok(())
}
