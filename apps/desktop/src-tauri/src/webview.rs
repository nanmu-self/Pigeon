//! WebView2 运行时版本门槛（仅 Windows 生效）。
//!
//! Tauri 安装器里的 `webviewInstallMode` 只保证「装了 WebView2」，不保证版本够新；
//! Evergreen 运行时正常会自动更新，但被策略禁更/装了固定版本的机器上可能是老版本，
//! 老内核缺少现代 CSS/JS 特性会导致界面渲染异常。因此在创建任何窗口前先检查版本，
//! 不达标弹原生错误框并退出。
//!
//! - 调整门槛：改 [`MIN_WEBVIEW2_VERSION`]
//! - 临时验证失败路径：环境变量 `PIGEON_MIN_WEBVIEW2` 覆盖门槛（如设为 `999.0.0.0` 必弹窗）

/// 最低要求的 WebView2 运行时版本（4 段式版本号，逐段数值比较）。
///
/// 桌面前端依赖 Tailwind 4（需要 Chromium ≥ 111）、SvelteKit 等现代特性，
/// 120（2023-12 的 Chromium）为稳妥下限，可按需上调。
pub const MIN_WEBVIEW2_VERSION: &str = "120.0.0.0";

/// WebView2 官方下载页（弹窗中可一键打开）
const WEBVIEW2_DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// 解析 `131.0.2903.99` 形式的版本号为数值段；非数字段（如 `1-dev` 后缀）按 0。
fn parse_version(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// 逐段数值比较：`actual >= min` 才算达标；任一方缺失的段按 0，相等视为达标。
fn is_at_least(actual: &str, min: &str) -> bool {
    let (a, m) = (parse_version(actual), parse_version(min));
    for i in 0..m.len().max(a.len()) {
        let (av, mv) = (
            a.get(i).copied().unwrap_or(0),
            m.get(i).copied().unwrap_or(0),
        );
        if av != mv {
            return av > mv;
        }
    }
    true
}

/// 创建窗口前调用：WebView2 缺失或版本过低时返回 `Err`（消息可直接展示给用户）。
#[cfg(target_os = "windows")]
pub fn enforce_minimum_version() -> Result<(), String> {
    let min = std::env::var("PIGEON_MIN_WEBVIEW2")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| MIN_WEBVIEW2_VERSION.to_string());

    // 未安装 WebView2 时这里直接报错（正常情况下 Tauri 创建窗口阶段会闪退，提前给出可读提示）
    let actual = tauri::webview_version().map_err(|_| {
        format!("未检测到 WebView2 运行时，无法启动。\n\n请安装后重试：\n{WEBVIEW2_DOWNLOAD_URL}")
    })?;

    if !is_at_least(&actual, &min) {
        return Err(format!(
            "WebView2 运行时版本过低：当前 {actual}，要求 ≥ {min}。\n\n请升级后重试：\n{WEBVIEW2_DOWNLOAD_URL}"
        ));
    }
    Ok(())
}

/// 原生错误弹窗（不依赖 WebView2，老环境也能弹出）；
/// 用户点「是」会用默认浏览器打开 WebView2 下载页。
#[cfg(target_os = "windows")]
pub fn show_error_dialog(message: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONERROR, MB_YESNO,
    };

    // MessageBoxW 要求 UTF-16 且 NUL 结尾
    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let text = to_wide(&format!("{message}\n\n是否打开下载页面？"));
    let title = to_wide("Pigeon 无法启动");

    unsafe {
        let clicked = MessageBoxW(
            std::ptr::null_mut(), // 无属主窗口
            text.as_ptr(),
            title.as_ptr(),
            MB_ICONERROR | MB_YESNO,
        );
        if clicked == IDYES {
            // explorer 打开 URL 会走默认浏览器
            let _ = std::process::Command::new("explorer")
                .arg(WEBVIEW2_DOWNLOAD_URL)
                .spawn();
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn enforce_minimum_version() -> Result<(), String> {
    Ok(()) // WebView2 是 Windows 概念，其它平台无门槛
}

#[cfg(not(target_os = "windows"))]
pub fn show_error_dialog(_message: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_four_part_versions() {
        assert_eq!(parse_version("131.0.2903.99"), vec![131, 0, 2903, 99]);
        assert_eq!(parse_version("120"), vec![120]);
        // 非数字段按 0
        assert_eq!(parse_version("131.0.0.1-dev"), vec![131, 0, 0, 0]);
        // 空串/杂字符不 panic
        assert_eq!(parse_version(""), vec![0]);
        assert_eq!(parse_version("abc.3"), vec![0, 3]);
    }

    #[test]
    fn compares_segment_wise() {
        // 达标
        assert!(is_at_least("131.0.2903.99", "120.0.0.0"));
        assert!(is_at_least("120.0.0.0", "120.0.0.0"));
        assert!(is_at_least("121.0", "120.0.0.0")); // 缺段按 0
        // 不达标
        assert!(!is_at_least("119.9.9.9", "120.0.0.0"));
        assert!(!is_at_least("120.0.2903.99", "120.1.0.0"));
        assert!(!is_at_least("120.0.0", "120.0.0.1")); // 缺段按 0
    }
}
