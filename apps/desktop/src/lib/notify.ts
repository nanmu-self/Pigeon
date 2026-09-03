/**
 * 系统通知封装（tauri-plugin-notification）。
 *
 * 触发时机由调用方决定（chat-store 在窗口不可见/会话未打开时调用），
 * 这里只负责：权限申请、内容兜底。
 *
 * ⚠️ macOS dev 模式限制（插件上游行为，非本项目代码可控）：
 * `tauri-plugin-notification` 的 desktop 实现在 `tauri::is_dev()` 时会把发送方
 * 伪装成 `com.apple.Terminal`（见 desktop.rs 的 `notify_rust::set_application`），
 * 因为 macOS 要求通知必须挂在已注册的 .app bundle 上，而 `tauri dev` 跑的是
 * `target/debug/desktop` 裸二进制。后果：
 *   - 通知以「终端」名义弹出，不是 Pigeon；
 *   - 若「系统设置 → 通知」里终端未允许（或你从 VSCode/iTerm/Warp 启动），
 *     通知会被**静默丢弃**，JS 侧不会报错（Rust 侧错误被 `let _ =` 吞掉）。
 * → macOS 上验证通知必须用打包产物：`pnpm --filter @pigeon/desktop tauri build`
 *   后从 `src-tauri/target/release/bundle/macos/desktop.app` 启动（首次需系统授权）。
 * Windows 走 `app_id` 分支，dev 下也能正常弹，不受此限制。
 *
 * ⚠️ 点击通知唤回窗口在桌面端不可用：插件的 `onAction()` 监听的是
 * `actionPerformed` 事件，只有 mobile.rs 会发送，desktop.rs 完全不发。
 * 桌面端唤回入口是系统托盘菜单与 macOS Dock 图标（见 src-tauri/src/lib.rs）。
 */
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let granted: boolean | null = null;

/**
 * 惰性申请通知权限。
 * 桌面端插件恒返回 granted（desktop.rs 的 permission_state 是硬编码 Granted），
 * 真正的系统级开关在 macOS 系统设置里，代码侧无法探知 —— 这里主要是为
 * 非 Tauri 环境（纯浏览器 dev）和将来的 mobile 目标兜底。
 */
async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted;
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch {
    granted = false;
  }
  return granted;
}

/** 窗口是否在前台可见（收起到托盘 / 最小化 / 切到别的应用时为 false） */
export function windowVisible(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * 弹一条系统通知。
 * 非 Tauri 环境（纯浏览器 dev）静默跳过；失败不影响消息收发。
 */
export async function notifyMessage(title: string, body: string): Promise<void> {
  if (!(await ensurePermission())) return;
  try {
    sendNotification({ title: title || "Pigeon", body });
  } catch {
    // 通知失败不影响消息收发
  }
}

/** 按消息类型生成正文摘要 */
export function messageBodyPreview(kind: string, content: string, meta?: unknown): string {
  if (kind === "image") return "[图片]";
  if (kind === "file") {
    const name = (meta as { fname?: string } | null)?.fname;
    return name ? `[文件] ${name}` : "[文件]";
  }
  const text = content.trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text || "[消息]";
}
