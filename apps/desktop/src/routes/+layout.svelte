<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import Button from "$lib/components/ui/button.svelte";

  let { children } = $props();

  // ── 关闭确认弹窗：点右上角 ✕ 时不直接退出（Rust 侧拦截 CloseRequested 并 emit） ──
  let closeAskOpen = $state(false);
  /** 收起 = 隐藏窗口后台运行：Windows 从托盘图标恢复，macOS 点 Dock 图标恢复 */
  let closing = $state(false);

  async function hideToTray() {
    closing = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("hide_main_window");
    } catch {}
    closeAskOpen = false;
    closing = false;
  }

  async function quitApp() {
    closing = true;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("exit_app");
    } catch {}
  }

  onMount(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen("close-requested", () => {
          closeAskOpen = true;
        });
      } catch {}
    })();
    return () => unlisten?.();
  });

  function onKeydown(e: KeyboardEvent) {
    if (!closeAskOpen) return;
    if (e.key === "Escape") closeAskOpen = false;
  }
</script>

<slot />

<svelte:window onkeydown={onKeydown} />

{#if closeAskOpen}
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) closeAskOpen = false;
    }}
  >
    <div
      class="w-[360px] rounded-xl border border-[var(--p-border)] bg-[var(--p-bg)] p-5 shadow-2xl"
      role="dialog"
      aria-modal="true"
      aria-label="关闭 Pigeon"
    >
      <h2 class="text-base font-semibold text-[var(--p-fg)]">要退出 Pigeon 吗？</h2>
      <p class="mt-1.5 text-sm leading-relaxed text-[var(--p-muted-fg)]">
        选择「收起」将最小化到托盘（后台运行），仍会接收新消息通知；选择「退出」将完全关闭应用。
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <Button variant="outline" size="sm" disabled={closing} onclick={hideToTray}>
          收起（后台运行）
        </Button>
        <Button variant="destructive" size="sm" disabled={closing} onclick={quitApp}>
          彻底退出
        </Button>
      </div>
    </div>
  </div>
{/if}
