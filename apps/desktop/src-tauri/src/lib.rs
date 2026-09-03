mod chat;
mod commands;
mod db;
mod models;
mod webview;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};

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
        // 点击窗口关闭按钮时不直接退出：CloseRequested 被 on_window_event 拦截后
        // 转发给前端，由前端弹窗让用户选「收起（后台运行）」还是「彻底退出」。
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .setup(|_app| {
            _app.manage(db::Db(
                std::sync::Mutex::new(None),
                std::sync::Mutex::new(String::new()),
            ));

            // 系统托盘：窗口收起后的恢复入口。
            // Windows：任务栏按钮随 hide() 消失，必须靠托盘图标唤回；
            // macOS：hide() 后窗口留在后台，点 Dock 图标即可恢复（托盘为双端一致的补充入口）。
            let show = MenuItem::with_id(_app, "show", "打开 Pigeon", true, None::<&str>)?;
            let quit = MenuItem::with_id(_app, "quit", "退出 Pigeon", true, None::<&str>)?;
            let menu = Menu::with_items(_app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(_app.default_window_icon().expect("missing window icon").clone())
                .tooltip("Pigeon")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    // 左键单击托盘图标 = 唤回主窗口
                    if matches!(event, tauri::tray::TrayIconEvent::Click { .. }) {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(_app)?;
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
            commands::hide_main_window,
            commands::exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
