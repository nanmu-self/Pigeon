mod chat;
mod commands;
mod db;
mod models;

use std::sync::Mutex;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
