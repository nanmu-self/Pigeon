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

    Ok(())
}
