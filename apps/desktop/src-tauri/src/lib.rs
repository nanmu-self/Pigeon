mod chat;
mod commands;
mod db;
mod models;
mod webview;

use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 创建任何窗口前先检查 WebView2 运行时（Windows）：缺失或版本过低时弹窗提示并退出，
    // 避免老内核渲染白屏/异常。门槛见 webview::MIN_WEBVIEW2_VERSION。
    if let Err(message) = webview::enforce_minimum_version() {
        webview::show_error_dialog(&message);
        std::process::exit(1);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 启动时打开 SQLite 并执行迁移，挂到全局 state
            let conn = db::init(app.handle())
                .map_err(|e| format!("初始化本地数据库失败: {e}"))?;
            app.manage(db::Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_conversations,
            commands::create_conversation,
            commands::mark_conversation_read,
            commands::delete_conversation,
            commands::clear_history,
            commands::get_messages,
            commands::insert_message,
            commands::send_message,
            commands::delete_message,
            commands::search_messages,
            commands::ensure_conversation,
            commands::ensure_group_conversation,
            commands::upsert_server_message,
            commands::acknowledge_message,
            commands::mark_message_failed,
            commands::retry_message,
            commands::apply_recalled,
            commands::set_peer_watermarks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
