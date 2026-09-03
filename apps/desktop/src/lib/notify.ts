/**
 * 系统通知封装（tauri-plugin-notification）。
 *
 * 触发时机由调用方决定（chat-store 在窗口不可见/会话未打开时调用），
 * 这里只负责：权限申请、内容兜底、点击通知唤回主窗口。
 */
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

let granted: boolean | null = null;

/** 惰性申请通知权限（macOS 首次会弹系统授权框；Windows 一般默认可发） */
async function ensurePermission(): Promise<boolean> {
  if (granted !== null) return granted;
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch {
    granted = false;
  }
  return granted;
}

/** 窗口是否在前台可见（收起到托盘 / 最小化 / 遮挡时为 false） */
export function windowVisible(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * 弹一条系统通知；点击通知唤回主窗口。
 * 非 Tauri 环境（纯浏览器 dev）静默跳过。
 */
export async function notifyMessage(title: string, body: string): Promise<void> {
  if (!(await ensurePermission())) return;
  try {
    // 桌面端点击行为：先注册全局点击监听（对后续所有通知生效）
    if (!clickBound) {
      clickBound = true;
      // onAction = 用户点击了通知（桌面端）→ 唤回主窗口；onNotificationReceived 仅用于保活监听
      const { onAction } = await import("@tauri-apps/plugin-notification");
      void onAction(() => {
        void focusMainWindow();
      }).then((unlisten) => {
        clickUnlisten = unlisten;
      });
    }
    sendNotification({ title: title || "Pigeon", body });
  } catch {
    // 通知失败不影响消息收发
  }
}

let clickBound = false;
let clickUnlisten: { unregister: () => Promise<void> } | null = null;

/** 显示并聚焦主窗口（从托盘/后台唤回） */
export async function focusMainWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.show();
    await win.unminimize();
    await win.setFocus();
  } catch {}
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
