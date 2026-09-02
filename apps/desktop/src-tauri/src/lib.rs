mod chat;
mod commands;
mod db;
mod models;
mod webview;

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
        // 本地库按登录用户打开/关闭（见 db.rs 顶部注释）：启动时只挂空状态，
        // 登录成功后由 open_user_db 命令打开 pigeon-{userId}.db
        .setup(|_app| {
            _app.manage(db::Db(
                std::sync::Mutex::new(None),
                std::sync::Mutex::new(String::new()),
            ));
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
            commands::open_user_db,
            commands::close_user_db,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
