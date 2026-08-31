<script lang="ts">
  import { cn } from "$lib/utils";
  import { onMount, tick } from "svelte";
  import Avatar from "$lib/components/ui/avatar.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import { showToast } from "$lib/toast";
  import {
    chatApi,
    formatConvTime,
    formatDayDivider,
    formatMsgTime,
    type ChatMessage,
    type ConversationSummary,
  } from "$lib/chat";

  const PAGE_SIZE = 50;

  // ── State（来自本地 SQLite）──────────────────────────────
  let conversations = $state<ConversationSummary[]>([]);
  let messages = $state<ChatMessage[]>([]);
  let selectedId = $state<number | null>(null);
  let loading = $state(true);
  let messageInput = $state("");
  let sending = $state(false);

  // 新建会话
  let creating = $state(false);
  let newConvName = $state("");

  // 滚动容器引用（自动滚底 / 上滑加载历史）
  let msgsEl: HTMLDivElement | undefined = $state();
  let hasMore = $state(false);
  let loadingOlder = $state(false);

  const selected = $derived(
    conversations.find((c) => c.id === selectedId) ?? null
  );

  // ── 数据加载 ─────────────────────────────────────────────
  async function refreshConversations() {
    conversations = await chatApi.listConversations();
  }

  async function select(id: number) {
    if (selectedId === id) return;
    selectedId = id;
    messages = [];
    try {
      const page = await chatApi.getMessages(id, PAGE_SIZE);
      messages = page;
      hasMore = page.length >= PAGE_SIZE;
      await chatApi.markRead(id);
      const conv = conversations.find((c) => c.id === id);
      if (conv) conv.unreadCount = 0;
      await scrollToBottom();
    } catch (e) {
      showToast(`加载消息失败: ${e}`);
    }
  }

  /** 上滑加载更早的历史消息（keyset 分页，保持滚动位置） */
  async function loadOlder() {
    if (
      !msgsEl ||
      loadingOlder ||
      !hasMore ||
      selectedId == null ||
      messages.length === 0
    ) {
      return;
    }
    loadingOlder = true;
    const prevHeight = msgsEl.scrollHeight;
    const prevTop = msgsEl.scrollTop;
    try {
      const older = await chatApi.getMessages(
        selectedId,
        PAGE_SIZE,
        messages[0].id
      );
      if (older.length < PAGE_SIZE) hasMore = false;
      messages = [...older, ...messages];
      await tick();
      if (msgsEl) {
        msgsEl.scrollTop = msgsEl.scrollHeight - prevHeight + prevTop;
      }
    } catch (e) {
      showToast(`加载历史消息失败: ${e}`);
    } finally {
      loadingOlder = false;
    }
  }

  function onMsgsScroll() {
    if (msgsEl && msgsEl.scrollTop < 60) loadOlder();
  }

  async function scrollToBottom() {
    await tick();
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  onMount(async () => {
    try {
      await refreshConversations();
      if (conversations.length > 0) {
        await select(conversations[0].id);
      }
    } catch (e) {
      showToast(`初始化本地数据库失败: ${e}`);
    } finally {
      loading = false;
    }
  });

  // ── 发送 / 新建 ──────────────────────────────────────────
  async function sendMessage() {
    const text = messageInput.trim();
    if (!text || selectedId == null || sending) return;
    messageInput = "";
    sending = true;
    try {
      const msg = await chatApi.sendMessage(selectedId, text);
      messages = [...messages, msg];
      await Promise.all([refreshConversations(), scrollToBottom()]);
    } catch (e) {
      showToast(`发送失败: ${e}`);
      messageInput = text; // 发送失败恢复输入
    } finally {
      sending = false;
    }
  }

  async function createConversation() {
    const name = newConvName.trim();
    if (!name) return;
    try {
      const conv = await chatApi.createConversation(name);
      newConvName = "";
      creating = false;
      await refreshConversations();
      await select(conv.id);
    } catch (e) {
      showToast(`创建会话失败: ${e}`);
    }
  }

  function avatarFallback(name: string) {
    return name.trim().slice(0, 2) || "?";
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
          onclick={() => {
            creating = !creating;
            newConvName = "";
          }}
          class={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)] transition-fast",
            creating && "bg-[var(--p-muted)] text-[var(--p-fg)]"
          )}
          aria-label="新建对话"
          title="新建对话"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>
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

    <!-- Inline: new conversation -->
    {#if creating}
      <div class="shrink-0 px-2.5 pb-2">
        <input
          bind:value={newConvName}
          placeholder="输入对方名称，回车创建"
          class="h-8 w-full rounded-md border border-[var(--p-input)] bg-[var(--p-bg)] px-2.5 text-xs text-[var(--p-fg)] placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-ring)] focus:outline-none focus:ring-1 focus:ring-[var(--p-ring)]/30 transition-fast"
          onkeydown={(e) => {
            if (e.key === "Enter") createConversation();
            if (e.key === "Escape") creating = false;
          }}
        />
      </div>
    {/if}

    <!-- Conversation list -->
    <div class="scroll-area-thin flex-1 overflow-y-auto px-1.5">
      {#if loading}
        <div class="px-3 py-6 text-center text-xs text-[var(--p-muted-fg)]">
          正在加载本地聊天记录…
        </div>
      {:else if conversations.length === 0}
        <div class="px-3 py-6 text-center text-xs text-[var(--p-muted-fg)]">
          暂无会话<br />点击右上角 + 新建一个对话
        </div>
      {:else}
        {#each conversations as conv (conv.id)}
          {@const isSelected = conv.id === selectedId}
          <button
            onclick={() => select(conv.id)}
            class={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2.5 transition-fast",
              isSelected ? "bg-[var(--p-primary-muted)]" : "hover:bg-[var(--p-muted)]"
            )}
            style="height: var(--p-list-item-h);"
          >
            <div class="relative shrink-0">
              <Avatar fallback={avatarFallback(conv.name)} size="md" />
            </div>

            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <div class="flex items-center justify-between gap-2">
                <span class={cn(
                  "truncate text-sm",
                  isSelected ? "font-semibold text-[var(--p-fg)]" : "font-medium text-[var(--p-fg)]"
                )}>
                  {conv.name}
                </span>
                <span class="shrink-0 text-[10px] text-[var(--p-muted-fg)] tabular-nums">
                  {conv.lastMessage ? formatConvTime(conv.lastMessage.createdAt) : ""}
                </span>
              </div>
              <div class="flex items-center justify-between gap-2">
                <p class="truncate text-xs text-[var(--p-muted-fg)]">
                  {conv.lastMessage?.content ?? "暂无消息"}
                </p>
                {#if conv.unreadCount > 0}
                  <Badge size="sm" variant="default">
                    {conv.unreadCount > 99 ? "99+" : conv.unreadCount}
                  </Badge>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      {/if}
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
          <Avatar fallback={avatarFallback(selected.name)} size="md" />
          <div>
            <h3 class="text-sm font-semibold text-[var(--p-fg)] leading-tight">{selected.name}</h3>
            <p class="text-[11px] text-[var(--p-muted-fg)] leading-tight">
              {selected.kind === "group" ? "群聊" : "单聊"} · 本地记录 {messages.length} 条{hasMore ? "+" : ""}
            </p>
          </div>
        </div>

        <div class="flex items-center gap-0.5">
          <button
            onclick={async () => {
              try {
                await chatApi.clearHistory(selected.id);
                messages = [];
                hasMore = false;
                await refreshConversations();
              } catch (e) {
                showToast(`清空失败: ${e}`);
              }
            }}
            class="flex h-8 w-8 items-center justify-center rounded-md text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-error)] transition-fast"
            aria-label="清空聊天记录"
            title="清空聊天记录"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
          <button
            onclick={async () => {
              if (!window.confirm(`删除会话「${selected.name}」及其全部聊天记录？`)) return;
              try {
                await chatApi.deleteConversation(selected.id);
                selectedId = null;
                messages = [];
                await refreshConversations();
              } catch (e) {
                showToast(`删除会话失败: ${e}`);
              }
            }}
            class="flex h-8 w-8 items-center justify-center rounded-md text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-error)] transition-fast"
            aria-label="删除会话"
            title="删除会话"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Messages -->
      <div
        bind:this={msgsEl}
        onscroll={onMsgsScroll}
        class="scroll-area-thin flex-1 overflow-y-auto px-4 py-3"
      >
        {#if loadingOlder}
          <div class="flex items-center justify-center py-2">
            <span class="text-[10px] text-[var(--p-muted-fg)]">加载历史消息…</span>
          </div>
        {/if}

        {#if messages.length === 0}
          <div class="flex h-full items-center justify-center">
            <p class="text-xs text-[var(--p-muted-fg)]">暂无消息，发送第一条吧</p>
          </div>
        {/if}

        {#each messages as msg, i (msg.id)}
          {@const isSelf = msg.sender === "self"}
          {@const next = messages[i + 1]}
          {@const lastInGroup = !next || next.sender !== msg.sender}
          {@const prev = i > 0 ? messages[i - 1] : null}
          {@const newDay =
            !prev ||
            new Date(prev.createdAt).toDateString() !==
              new Date(msg.createdAt).toDateString()}

          {#if newDay}
            <div class="flex items-center justify-center py-2">
              <span class="rounded-full bg-[var(--p-muted)] px-3 py-0.5 text-[11px] font-medium text-[var(--p-muted-fg)]">
                {formatDayDivider(msg.createdAt)}
              </span>
            </div>
          {:else if !isSelf && prev && prev.sender !== msg.sender && prev.sender === "other"}
            <!-- 换人发送时留出间隔（按需可展示 sender_name） -->
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
                fallback={isSelf ? "我" : avatarFallback(msg.senderName || selected.name)}
                size="sm"
              />
            </div>

            <!-- Bubble — no tail, rounded-lg -->
            <div
              class={cn(
                "max-w-[65%] px-3 py-2 text-sm leading-relaxed",
                isSelf ? "msg-bubble-self" : "msg-bubble-other"
              )}
            >
              {msg.content}
              {#if lastInGroup}
                <span class={cn(
                  "mt-1 block text-[10px] text-[var(--p-muted-fg)] tabular-nums",
                  isSelf ? "text-right" : "text-left"
                )}>
                  {formatMsgTime(msg.createdAt)}
                  {#if isSelf && msg.status === "sending"}· 发送中{/if}
                  {#if isSelf && msg.status === "failed"}· 失败{/if}
                </span>
              {/if}
            </div>
          </div>
        {/each}
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
            disabled={!messageInput.trim() || sending}
            class={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-fast",
              messageInput.trim() && !sending
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
