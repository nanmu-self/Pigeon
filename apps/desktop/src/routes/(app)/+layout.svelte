<script lang="ts">
  import { cn } from "$lib/utils";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { ws } from "$lib/api/socket.svelte";
  import { serverApi } from "$lib/api/http";
  import { profile } from "$lib/api/profile.svelte";
  import CallOverlay from "$lib/components/CallOverlay.svelte";

  // ── Lucide 图标（官方推荐：子路径单独导入，tree-shakable） ──
  import MessageCircle from "@lucide/svelte/icons/message-circle";
  import Users from "@lucide/svelte/icons/users";
  import Folder from "@lucide/svelte/icons/folder";
  import Puzzle from "@lucide/svelte/icons/puzzle";
  import Settings from "@lucide/svelte/icons/settings";
  import Lock from "@lucide/svelte/icons/lock";
  import Search from "@lucide/svelte/icons/search";

  let { children } = $props();

  // ── State ────────────────────────────────────────────────
  let commandOpen = $state(false);
  let perfMode = $state(false);
  /** alova 探活的 HTTP 往返延迟（ms） */
  let apiLatency = $state<number | null>(null);

  // ── 服务端连接（Socket.IO + HTTP 探活） ────────
  async function probeApi() {
    const t0 = performance.now();
    try {
      await serverApi.health();
      apiLatency = Math.round(performance.now() - t0);
    } catch {
      apiLatency = null;
    }
  }

  const wsLabel = $derived(
    {
      idle: "WS 未连接",
      connecting: "WS 连接中…",
      connected: "WS 已连接",
      reconnecting: "WS 重连中…",
      disconnected: "WS 已断开",
    }[ws.state]
  );
  const wsDotClass = $derived(
    {
      idle: "bg-[var(--p-muted-fg)]",
      connecting: "bg-amber-400 animate-pulse",
      connected: "bg-green-500",
      reconnecting: "bg-amber-400 animate-pulse",
      disconnected: "bg-red-400",
    }[ws.state]
  );

  $effect(() => {
    document.documentElement.classList.toggle("perf-mode", perfMode);
  });

  // ── 服务端连接（Socket.IO 自动重连；登录落地后改在登录成功处 connect） ──
  onMount(() => {
    ws.connect();
    void probeApi();
    void profile.load();
    const timer = setInterval(probeApi, 30_000);
    return () => clearInterval(timer);
  });

  // ── Tauri window controls ────────────────────────────────
  onMount(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { appWindow }: any = await import("@tauri-apps/api/window");
      document.getElementById("titlebar-min")?.addEventListener("click", () => appWindow.minimize());
      document.getElementById("titlebar-max")?.addEventListener("click", () => appWindow.toggleMaximize());
      document.getElementById("titlebar-close")?.addEventListener("click", () => appWindow.close());
    } catch {}
  });

  // ── Keyboard shortcuts ───────────────────────────────────
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        commandOpen = !commandOpen;
      }
    };
    const openHandler = () => (commandOpen = true);
    document.addEventListener("keydown", handler);
    window.addEventListener("pigeon:open-command-palette", openHandler);
    return () => {
      document.removeEventListener("keydown", handler);
      window.removeEventListener("pigeon:open-command-palette", openHandler);
    };
  });

  // ── Navigation rail ──────────────────────────────────────
  const navItems = [
    { icon: MessageCircle, label: "消息", href: "/messages", active: false },
    { icon: Users, label: "通讯录", href: "/contacts", active: false },
    { icon: Folder, label: "文件", href: "/files", active: false },
    { icon: Puzzle, label: "插件", href: "/plugins", active: false },
    { icon: Settings, label: "设置", href: "/settings", active: false },
  ];

  let activeNav = $state("/messages");

  $effect(() => {
    activeNav = $page.url.pathname;
  });

  const resolvedNavItems = $derived(
    navItems.map(item => ({
      ...item,
      active: activeNav === item.href || (item.href !== "/messages" && activeNav.startsWith(item.href))
    }))
  );

  function navigateTo(href: string) {
    goto(href);
  }

  // ── Command palette ──────────────────────────────────────
  const commandItems: { label: string; href?: string; shortcut?: string[] }[] = [
    { label: "搜索消息…", shortcut: ["Ctrl", "F"] },
    { label: "新建对话", shortcut: ["Ctrl", "N"] },
    { label: "打开消息", href: "/messages" },
    { label: "打开通讯录", href: "/contacts" },
    { label: "切换主题" },
    { label: "性能模式" },
    { label: "快捷键列表", shortcut: ["Ctrl", "/"] },
    { label: "关于 Pigeon" },
  ];
</script>

<div
  class:perf-mode={perfMode} class="flex h-screen flex-col overflow-hidden bg-[var(--p-bg)] text-[var(--p-fg)]"
>
  <!-- ══ 2-Column Shell: Rail + Page Content ═══════════ -->
  <div class="flex flex-1 overflow-hidden">
    <!-- ── Nav Rail (60px) ───────────────────────────── -->
    <nav
      class="flex shrink-0 flex-col items-center border-r border-[var(--p-border)] bg-[var(--p-card)] py-2 gap-0.5"
      style="width: 60px;"
    >
      <button
        onclick={() => navigateTo("/settings")}
        class="mb-3 flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-[var(--p-secondary)] text-xs font-bold text-[var(--p-secondary-fg)] transition-fast hover:opacity-80"
        aria-label="个人资料"
        title="个人资料"
      >
        {#if profile.avatarUrl}
          <img
            src={profile.avatarUrl}
            alt={profile.displayName}
            class="h-full w-full object-cover"
          />
        {:else}
          {profile.displayName.slice(0, 2).toUpperCase()}
        {/if}
      </button>

      <div></div>

      {#each resolvedNavItems as item}
        {@const Icon = item.icon}
        <button
          onclick={() => navigateTo(item.href)}
          class={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg transition-fast",
            item.active
              ? "bg-[var(--p-primary-muted)] text-[var(--p-primary)]"
              : "text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
          )}
          aria-label={item.label}
          title={item.label}
        >
          <Icon size={18} strokeWidth={2} />
        </button>
      {/each}
    </nav>

    <!-- ── Page content (messages / contacts / …) ────── -->
    <main class="min-w-0 flex-1 overflow-hidden">
      {@render children()}
    </main>
  </div>

  <!-- 全局通话浮层（音视频，WebRTC P2P） -->
  <CallOverlay />

  <!-- ══ Status Bar ═════════════════════════════════════ -->
  <footer class="flex h-7 shrink-0 items-center border-t border-[var(--p-border)] bg-[var(--p-card)] px-3 font-mono select-none">
    <div class="flex items-center gap-1.5">
      <span class={cn("h-2 w-2 rounded-full", wsDotClass)} title={wsLabel}></span>
      <span class="text-[11px] text-[var(--p-muted-fg)]">{wsLabel}</span>
      <span class="text-[var(--p-border)]">·</span>
      <span class="text-[11px] text-[var(--p-muted-fg)] tabular-nums">
        API {apiLatency == null ? "—" : `${apiLatency}ms`}
      </span>
      <Lock size={12} class="text-[var(--p-muted-fg)]" />
    </div>
    <div></div>
    <div class="flex items-center gap-2 text-[11px] text-[var(--p-muted-fg)]">
      <span>缓存 24.1 MB</span>
      <span class="text-[var(--p-border)]">·</span>
      <span>内存 86 MB</span>
    </div>
    <button
      onclick={() => (perfMode = !perfMode)}
      class="ml-3 rounded px-1 py-px text-[10px] font-mono uppercase tracking-wider transition-fast"
      class:text-[var(--p-primary)]={perfMode}
      class:bg-[var(--p-primary-muted)]={perfMode}
      class:text-[var(--p-muted-fg)]={!perfMode}
      title="性能模式"
    >
      PERF
    </button>
  </footer>

  <!-- ══ Command Palette ════════════════════════════════ -->
  {#if commandOpen}
    <div role="presentation" class="fixed inset-0 z-[60] bg-black/50" onclick={() => (commandOpen = false)}></div>
    <div
      role="dialog"
      aria-modal="true"
      class="fixed left-1/2 top-[16%] z-[61] w-full max-w-lg -translate-x-1/2 anim-scale-in"
    >
      <div class="flex flex-col overflow-hidden rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] shadow-lg">
        <div class="flex items-center gap-2.5 border-b border-[var(--p-border)] px-4">
          <Search size={16} class="shrink-0 text-[var(--p-muted-fg)]" />
          <input
            type="text"
            placeholder="搜索命令、对话、联系人…"
            class="h-11 w-full bg-transparent text-sm text-[var(--p-fg)] placeholder:text-[var(--p-muted-fg)] focus:outline-none"
          />
          <kbd class="hidden sm:inline-flex shrink-0 rounded border border-[var(--p-border)] bg-[var(--p-muted)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--p-muted-fg)]">ESC</kbd>
        </div>
        <div class="scroll-area-thin max-h-64 overflow-y-auto py-1">
          {#each commandItems as item}
            <button onclick={() => item.href && navigateTo(item.href)} class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-[var(--p-fg)] hover:bg-[var(--p-muted)] transition-fast">
              <span class="text-base leading-none opacity-60">✦</span>
              <span class="flex-1">{item.label}</span>
              {#if item.shortcut}
                <div class="flex items-center gap-1">
                  {#each item.shortcut as key}
                    <kbd class="rounded border border-[var(--p-border)] bg-[var(--p-muted)] px-1.5 py-px text-[10px] font-mono text-[var(--p-muted-fg)]">{key}</kbd>
                  {/each}
                </div>
              {/if}
            </button>
          {/each}
        </div>
        <div class="flex items-center gap-3 border-t border-[var(--p-border)] px-4 py-2 text-[11px] text-[var(--p-muted-fg)]">
          <span>↑↓ 导航 · ↵ 选择 · Esc 关闭</span>
        </div>
      </div>
    </div>
  {/if}
</div>
