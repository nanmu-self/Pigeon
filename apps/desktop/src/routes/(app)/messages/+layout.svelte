<script lang="ts">
  import { cn } from "$lib/utils";
  import Avatar from "$lib/components/ui/avatar.svelte";
  import Badge from "$lib/components/ui/badge.svelte";

  // ── Mock data ────────────────────────────────────────────
  const conversations = [
    { id: 1, name: "张三",   initials: "张", lastMessage: "好的，明天见！",               time: "10:30", unread: 2,  online: "online" as const },
    { id: 2, name: "李四",   initials: "李", lastMessage: "文件已经发送了",             time: "昨天",  unread: 0,  online: "offline" as const },
    { id: 3, name: "王五",   initials: "王", lastMessage: "周末有空吗？",               time: "昨天",  unread: 1,  online: "online" as const },
    { id: 4, name: "赵六",   initials: "赵", lastMessage: "收到，谢谢",                 time: "周一",  unread: 0,  online: "offline" as const },
    { id: 5, name: "产品讨论组", initials: "产", lastMessage: "Alice: 下个版本什么时候发布？", time: "周一", unread: 5, online: "offline" as const },
    { id: 6, name: "陈七",   initials: "陈", lastMessage: "哈哈",                      time: "8/28",  unread: 0,  online: "away" as const },
    { id: 7, name: "刘八",   initials: "刘", lastMessage: "[图片]",                    time: "8/27",  unread: 0,  online: "offline" as const },
    { id: 8, name: "周九",   initials: "周", lastMessage: "明天开会记得带资料",         time: "8/26",  unread: 0,  online: "online" as const },
  ];

  const chatMessages = [
    { id: 1, sender: "other" as const, text: "在吗？有个事情想跟你确认一下。",             time: "10:15", initials: "张" },
    { id: 2, sender: "self"  as const, text: "在的，说吧。",                              time: "10:17", initials: "ME" },
    { id: 3, sender: "other" as const, text: "明天下午的会议改到三点了，你能过来吗？",     time: "10:18", initials: "张" },
    { id: 4, sender: "self"  as const, text: "可以的，三点没问题。",                      time: "10:20", initials: "ME" },
    { id: 5, sender: "other" as const, text: "太好了，那明天见！",                        time: "10:30", initials: "张" },
    { id: 6, sender: "self"  as const, text: "到时候见。",                                time: "10:31", initials: "ME" },
  ];

  let selectedId = $state<number | null>(1);
  let messageInput = $state("");

  const selected = $derived(conversations.find((c) => c.id === selectedId));

  function sendMessage() {
    if (!messageInput.trim()) return;
    messageInput = "";
  }

  function showTimeDivider(idx: number): boolean {
    if (idx === 0) return true;
    return idx % 4 === 0;
  }
</script>

<!-- Shell (rail / status bar / palette) lives in routes/(app)/+layout.svelte.
     This layout only provides the messages-specific 2-column content. -->
<div class="flex h-full overflow-hidden">
  <!-- ── Col 1: Sidebar ─────────────────────────────────── -->
  <aside
    class="flex shrink-0 flex-col border-r border-[var(--p-border)] bg-[var(--p-card)]"
    style="width: 280px;"
  >
    <!-- Header -->
    <div class="flex shrink-0 items-center justify-between px-3.5 py-2.5">
      <h2 class="text-sm font-semibold text-[var(--p-fg)] tracking-tight">消息</h2>
      <div class="flex items-center gap-0.5">
        <button
          onclick={() => window.dispatchEvent(new Event("pigeon:open-command-palette"))}
          class="flex h-7 w-7 items-center justify-center rounded-md text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)] transition-fast"
          aria-label="全局搜索"
          title="全局搜索 Ctrl+K"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Search -->
    <div class="shrink-0 px-2.5 pb-2">
      <div class="relative">
        <svg class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--p-muted-fg)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          type="text"
          placeholder="搜索对话…"
          class="h-8 w-full rounded-md border border-[var(--p-input)] bg-[var(--p-bg)] pl-8 pr-2.5 text-xs placeholder:text-[var(--p-muted-fg)] text-[var(--p-fg)] focus:border-[var(--p-ring)] focus:outline-none focus:ring-1 focus:ring-[var(--p-ring)]/30 transition-fast"
        />
      </div>
    </div>

    <!-- Conversation list -->
    <div class="scroll-area-thin flex-1 overflow-y-auto px-1.5">
      {#each conversations as conv (conv.id)}
        {@const isSelected = conv.id === selectedId}
        <button
          onclick={() => (selectedId = conv.id)}
          class={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2.5 transition-fast",
            isSelected ? "bg-[var(--p-primary-muted)]" : "hover:bg-[var(--p-muted)]"
          )}
          style="height: var(--p-list-item-h);"
        >
          <div class="relative shrink-0">
            <Avatar
              fallback={conv.initials}
              size="md"
              status={conv.online === "online" ? "online" : conv.online === "away" ? "away" : "offline"}
            />
          </div>

          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <div class="flex items-center justify-between gap-2">
              <span class={cn(
                "truncate text-sm",
                isSelected ? "font-semibold text-[var(--p-fg)]" : "font-medium text-[var(--p-fg)]"
              )}>
                {conv.name}
              </span>
              <span class="shrink-0 text-[10px] text-[var(--p-muted-fg)] tabular-nums">{conv.time}</span>
            </div>
            <div class="flex items-center justify-between gap-2">
              <p class="truncate text-xs text-[var(--p-muted-fg)]">{conv.lastMessage}</p>
              {#if conv.unread > 0}
                <Badge size="sm" variant="default">
                  {conv.unread > 99 ? "99+" : conv.unread}
                </Badge>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    </div>
  </aside>

  <!-- ── Col 2: Chat Area ───────────────────────────────── -->
  <main class="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--p-bg)]">
    {#if selected}
      <!-- Chat header -->
      <div
        class="flex shrink-0 items-center justify-between border-b border-[var(--p-border)] bg-[var(--p-card)] px-4"
        style="height: 3.25rem;"
      >
        <div class="flex items-center gap-3">
          <Avatar
            fallback={selected.initials}
            size="md"
            status={selected.online === "online" ? "online" : selected.online === "away" ? "away" : "offline"}
          />
          <div>
            <h3 class="text-sm font-semibold text-[var(--p-fg)] leading-tight">{selected.name}</h3>
            <p class="text-[11px] text-[var(--p-muted-fg)] leading-tight">
              {selected.online === "online" ? "在线" : selected.online === "away" ? "离开" : "离线"}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-0.5">
          <button class="flex h-8 w-8 items-center justify-center rounded-md text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)] transition-fast" aria-label="语音通话">
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.8.36 1.58.7 2.81"/>
            </svg>
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-md text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)] transition-fast"
            aria-label="对话详情"
            title="对话详情"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div class="scroll-area-thin flex-1 overflow-y-auto px-4 py-3">
        <!-- Date divider -->
        <div class="flex items-center justify-center py-2">
          <span class="rounded-full bg-[var(--p-muted)] px-3 py-0.5 text-[11px] font-medium text-[var(--p-muted-fg)]">今天</span>
        </div>

        {#each chatMessages as msg, i (msg.id)}
          {@const isSelf = msg.sender === "self"}
          {@const next = chatMessages[i + 1]}
          {@const lastInGroup = !next || next.sender !== msg.sender}

          {#if showTimeDivider(i)}
            <div class="flex items-center justify-center py-1.5">
              <span class="text-[10px] text-[var(--p-muted-fg)] tabular-nums">{msg.time}</span>
            </div>
          {/if}

          <div
            class={cn(
              "flex gap-2 mb-[var(--p-msg-gap)]",
              isSelf ? "flex-row-reverse" : "flex-row"
            )}
          >
            <!-- Avatar (invisible when not last in group) -->
            <div class={cn("mt-auto shrink-0", !lastInGroup && "invisible")}>
              <Avatar
                fallback={msg.initials}
                size="sm"
                status={isSelf ? "online" : "offline"}
              />
            </div>

            <!-- Bubble — no tail, rounded-lg -->
            <div
              class={cn(
                "max-w-[65%] px-3 py-2 text-sm leading-relaxed",
                isSelf ? "msg-bubble-self" : "msg-bubble-other"
              )}
            >
              {msg.text}
              {#if lastInGroup}
                <span class={cn(
                  "mt-1 block text-[10px] text-[var(--p-muted-fg)] tabular-nums",
                  isSelf ? "text-right" : "text-left"
                )}>
                  {msg.time}
                </span>
              {/if}
            </div>
          </div>
        {/each}

        <!-- Typing indicator -->
        <div class="flex items-center gap-2 pt-2">
          <Avatar fallback={selected.initials} size="sm" />
          <div class="flex items-center gap-1 rounded-lg bg-[var(--bubble-other)] px-3 py-2">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      </div>

      <!-- Input area -->
      <div class="shrink-0 border-t border-[var(--p-border)] bg-[var(--p-card)] px-4 py-3">
        <div class="flex items-end gap-2">
          <!-- Attachment -->
          <button
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)] transition-fast"
            aria-label="添加附件"
            title="添加附件"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
            </svg>
          </button>

          <!-- Textarea -->
          <div class="flex-1">
            <textarea
              bind:value={messageInput}
              placeholder="输入消息…  Enter 发送  Shift+Enter 换行"
              rows={1}
              class="scroll-area-thin max-h-[33vh] min-h-[2.25rem] w-full resize-none rounded-lg border border-[var(--p-input)] bg-[var(--p-bg)] px-3 py-2 text-sm text-[var(--p-fg)] placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-ring)] focus:outline-none focus:ring-1 focus:ring-[var(--p-ring)]/30 transition-fast"
              onkeydown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
            />
          </div>

          <!-- Emoji -->
          <button
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)] transition-fast"
            aria-label="表情"
            title="表情"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
            </svg>
          </button>

          <!-- Send -->
          <button
            onclick={sendMessage}
            disabled={!messageInput.trim()}
            class={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-fast",
              messageInput.trim()
                ? "bg-[var(--p-primary)] text-[var(--p-primary-fg)] hover:bg-[var(--p-primary-hover)]"
                : "bg-[var(--p-muted)] text-[var(--p-muted-fg)] cursor-not-allowed"
            )}
            aria-label="发送"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>
    {:else}
      <!-- Empty state -->
      <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div class="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--p-muted)]">
          <svg class="h-8 w-8 text-[var(--p-muted-fg)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div>
          <p class="text-sm font-medium text-[var(--p-fg)]">选择一个对话</p>
          <p class="text-xs text-[var(--p-muted-fg)] mt-0.5">开始聊天</p>
        </div>
      </div>
    {/if}
  </main>
</div>
