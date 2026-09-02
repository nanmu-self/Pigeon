//! SQLite 连接管理 + 嵌入式迁移。
//!
//! - 数据库文件按登录用户拆分：%APPDATA%/com.zhang.pigeon/pigeon-{userId}.db
//!   （多账号数据隔离：切换账户互不可见对方聊天记录）
//! - 通过 `PRAGMA user_version` 做版本化迁移，打开时自动执行未应用的 schema
//! - WAL 模式提升并发读写性能
//! - 兼容升级：首次以某用户身份打开时，若存在旧版全局单库 pigeon.db，
//!   将其改名继承为该用户的库（仅首个登录用户拿到旧数据）

use std::{fs, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// 全局数据库连接（Tauri managed state）：登录后按用户打开，登出关闭。
/// `.1` 记录当前打开库所属的 userId（重入/换号判断用）。
pub struct Db(pub Mutex<Option<Connection>>, pub Mutex<String>);

/// `lock()` 的返回值：借用时已确认连接存在，Deref 到 Connection，
/// 让既有命令代码保持 `let conn = lock(&state)?; chat::x(&conn)` 不变。
pub struct ConnGuard<'a>(std::sync::MutexGuard<'a, Option<Connection>>);

impl std::ops::Deref for ConnGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().expect("ConnGuard: connection checked at construction")
    }
}

/// 当前 Unix 毫秒时间戳
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before Unix epoch")
        .as_millis() as i64
}

/// 打开指定用户的库并执行迁移（由 `open_user_db` 命令在登录后调用）。
/// 若该用户已持有连接则直接复用（幂等）。
pub fn open_for_user(
    db: &Db,
    app: &AppHandle,
    user_id: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    {
        let current = db.1.lock().map_err(|e| e.to_string())?;
        if current.as_str() == user_id && db.0.lock().map_err(|e| e.to_string())?.is_some() {
            return Ok(());
        }
    }

    let dir = app.path().app_data_dir()?;
    fs::create_dir_all(&dir)?;
    let name = db_file_name(user_id);
    let db_path = dir.join(&name);

    // 兼容升级：旧版全局单库 pigeon.db → 首个登录用户继承
    if !db_path.exists() {
        let legacy = dir.join("pigeon.db");
        if legacy.exists() {
            fs::rename(&legacy, &db_path)?;
            for ext in ["-wal", "-shm"] {
                let _ = fs::rename(
                    dir.join(format!("pigeon.db{ext}")),
                    dir.join(format!("{name}{ext}")),
                );
            }
        }
    }

    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    migrate(&conn)?;

    let mut guard = db.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(conn);
    *db.1.lock().map_err(|e| e.to_string())? = user_id.to_string();
    Ok(())
}

/// 关闭当前用户的连接（登出时调用；未打开时为幂等空操作）
pub fn close(db: &Db) -> Result<(), String> {
    let mut guard = db.0.lock().map_err(|e| format!("数据库锁获取失败: {e}"))?;
    if let Some(conn) = guard.take() {
        // 显式 checkpoint + close，避免残留 -wal 文件被误挂到别的用户库
        let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
        let _ = conn.close();
    }
    *db.1.lock().map_err(|e| format!("数据库锁获取失败: {e}"))? = String::new();
    Ok(())
}

/// userId → 库文件名。仅保留字母/数字/`-`/`_`，其余字符替换为 `_`，
/// 防止异常 id 造成路径穿越或非法文件名。
fn db_file_name(user_id: &str) -> String {
    let safe: String = user_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        return "pigeon-user.db".into();
    }
    format!("pigeon-{safe}.db")
}

/// 借用当前连接；未登录（库未打开）时返回可读错误。
/// 所有 chat 命令共用此入口，保证未初始化时 fail-fast 而非 panic。
pub fn lock<'a>(state: &'a tauri::State<'a, Db>) -> Result<ConnGuard<'a>, String> {
    let guard = state
        .0
        .lock()
        .map_err(|e| format!("数据库锁获取失败: {e}"))?;
    if guard.is_none() {
        return Err("本地数据库未初始化：请重新登录".into());
    }
    Ok(ConnGuard(guard))
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

    // v5：消息撤回标记（撤回时 content/meta 已清空，此列驱动 UI 渲染撤回占位）
    if version < 5 {
        conn.execute_batch(
            r#"
            BEGIN;

            ALTER TABLE messages ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0;

            PRAGMA user_version = 5;

            COMMIT;
            "#,
        )?;
    }

    // 自愈：修复「user_version 已达标但列缺失」的历史库。
    // 背景：早期开发时迁移脚本被就地改过，某些库的 user_version 已推进，
    // 但后补的 ADD COLUMN 未执行 → 查询报 no such column。
    // （迁移只前进不重跑，这里按列存在性幂等补齐。）
    repair_missing_columns(conn)?;

    Ok(())
}

/// 按列存在性补齐缺失列（幂等，每项 = (表, 列, DDL)）
fn repair_missing_columns(conn: &Connection) -> Result<(), rusqlite::Error> {
    const EXPECTED: &[(&str, &str, &str)] = &[
        (
            "conversations",
            "server_session_id",
            "ALTER TABLE conversations ADD COLUMN server_session_id TEXT",
        ),
        (
            "conversations",
            "peer_read_msg_id",
            "ALTER TABLE conversations ADD COLUMN peer_read_msg_id INTEGER",
        ),
        (
            "conversations",
            "peer_delivered_msg_id",
            "ALTER TABLE conversations ADD COLUMN peer_delivered_msg_id INTEGER",
        ),
        (
            "conversations",
            "last_read_at",
            "ALTER TABLE conversations ADD COLUMN last_read_at INTEGER",
        ),
        ("messages", "meta", "ALTER TABLE messages ADD COLUMN meta TEXT"),
        (
            "messages",
            "reply_summary",
            "ALTER TABLE messages ADD COLUMN reply_summary TEXT",
        ),
        (
            "messages",
            "reactions",
            "ALTER TABLE messages ADD COLUMN reactions TEXT",
        ),
        (
            "messages",
            "recalled",
            "ALTER TABLE messages ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0",
        ),
    ];
    for (table, column, ddl) in EXPECTED {
        let exists = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = ?2",
                [table, column],
                |row| row.get::<_, i64>(0),
            )?;
        if exists == 0 {
            conn.execute_batch(ddl)?;
        }
    }
    Ok(())
}
