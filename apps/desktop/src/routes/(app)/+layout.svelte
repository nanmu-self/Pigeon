<script lang="ts">
  import { cn } from "$lib/utils";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  // ── State ────────────────────────────────────────────────
  let commandOpen = $state(false);
  let perfMode = $state(false);

  $effect(() => {
    document.documentElement.classList.toggle("perf-mode", perfMode);
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
    { icon: "msg", label: "消息", href: "/messages", active: false },
    { icon: "ppl", label: "通讯录", href: "/contacts", active: false },
    { icon: "file", label: "文件", href: "/files", active: false },
    { icon: "plg", label: "插件", href: "/plugins", active: false },
    { icon: "set", label: "设置", href: "/settings", active: false },
  ];

  const iconPaths: Record<string, string> = {
    msg:  `<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`,
    ppl:  `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
    file: `<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>`,
    plg:  `<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82.33 1.65 1.65 0 0 0 0 2.33 1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82-.33 1.65 1.65 0 0 0 1-2.33z"/><path d="M12 9a3 3 0 0 0-3 3c0 1.5 1.5 3 3 3s3-1.5 3-3-1.5-3-3-3z"/>`,
    set:  `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82.33 1.65 1.65 0 0 0 0 2.33 1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82-.33 1.65 1.65 0 0 0 1-2.33z"/><path d="M12 9a3 3 0 0 0-3 3c0 1.5 1.5 3 3 3s3-1.5 3-3-1.5-3-3-3z"/>`,
  };

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
        class="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--p-secondary)] text-xs font-bold text-[var(--p-secondary-fg)] hover:bg-[var(--p-primary-muted)] hover:text-[var(--p-primary)] transition-fast"
        aria-label="个人资料"
        title="个人资料"
      >
        ME
      </button>

      <div></div>

      {#each resolvedNavItems as item}
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
          <svg class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            {@html iconPaths[item.icon]}
          </svg>
        </button>
      {/each}
    </nav>

    <!-- ── Page content (messages / contacts / …) ────── -->
    <main class="min-w-0 flex-1 overflow-hidden">
      <slot />
    </main>
  </div>

  <!-- ══ Status Bar ═════════════════════════════════════ -->
  <footer class="flex h-7 shrink-0 items-center border-t border-[var(--p-border)] bg-[var(--p-card)] px-3 font-mono select-none">
    <div class="flex items-center gap-1.5">
      <span></span>
      <span class="text-[11px] text-[var(--p-muted-fg)]">12ms</span>
      <svg class="h-3 w-3 text-[var(--p-muted-fg)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
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
    <div role="presentation" class="fixed inset-0 z-[60] bg-black/50" onclick={() => (commandOpen = false)} />
    <div
      role="dialog"
      aria-modal="true"
      class="fixed left-1/2 top-[16%] z-[61] w-full max-w-lg -translate-x-1/2 anim-scale-in"
    >
      <div class="flex flex-col overflow-hidden rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] shadow-lg">
        <div class="flex items-center gap-2.5 border-b border-[var(--p-border)] px-4">
          <svg class="h-4 w-4 shrink-0 text-[var(--p-muted-fg)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
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
