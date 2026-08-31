/**
 * Toast 服务 — 用 Svelte 5 `mount()` 把 Toast 组件动态挂载到
 * document.body 下,完全脱离调用方组件的 DOM 层级。
 *
 * 好处:
 *  1. 不受任何祖先元素影响(transform/filter 会把 position:fixed 的
 *     包含块从视口变成该祖先,导致定位错乱);
 *  2. 无需在每个页面里维护 toastMessage/onClose 状态;
 *  3. 卸载由服务自己管理,组件销毁后也不会泄漏 DOM。
 */
import { mount, unmount } from "svelte";
import Toast from "$lib/components/ui/toast.svelte";

type ToastType = "error" | "success" | "info";

interface ToastOptions {
  type?: ToastType;
  /** 自动关闭毫秒数,0 表示手动关闭,默认 3000 */
  duration?: number;
}

export function showToast(message: string, options: ToastOptions = {}) {
  if (typeof document === "undefined") return; // SSR 安全保护

  const { type = "error", duration = 3000 } = options;

  const host = document.createElement("div");
  document.body.appendChild(host);

  let app: Record<string, any> | null = null;
  const close = () => {
    if (app) unmount(app); // Svelte 5: unmount 是独立函数,不是 app.unmount()
    app = null;
    host.remove();
  };

  app = mount(Toast, {
    target: host,
    props: { message, type, duration, onClose: close },
  });

  return close;
}
