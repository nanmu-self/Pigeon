<script lang="ts">
  import { onMount } from "svelte";
  import { chat } from "$lib/chat-store.svelte";
  import {
    formatConvTime,
    formatMsgTime,
    formatBytes,
    parseMessageMeta,
    type ChatMessage,
  } from "$lib/chat";
  import { serverTimeToMs as pgTimeToMs } from "$lib/api/sessions";

  let draft = $state("");
  let chatEl: HTMLDivElement | undefined = $state();
  let searchQuery = $state("");
  let pickerOpen = $state(false);
  let creating = $state(false);
  let imageInput: HTMLInputElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();

  async function pickFriend(peerId: number) {
    creating = true;
    try {
      await chat.createSession(peerId);
      pickerOpen = false;
    } finally {
      creating = false;
    }
  }

  function onPickImage(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void chat.sendAttachment(file);
    input.value = ""; // 允许重复选择同一文件
  }

  function onPickFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void chat.sendAttachment(file);
    input.value = "";
  }

  async function copyUrl(msg: ChatMessage) {
    try {
      await navigator.clipboard.writeText(msg.content);
    } catch {
      /* 剪贴板权限失败时静默 */
    }
  }

  const filteredSessions = $derived(
    chat.sessions.filter((s) =>
      s.peer.nickname.toLowerCase().includes(searchQuery.trim().toLowerCase()),
    ),
  );

  onMount(() => {
    chat.initWsHandlers();
    void chat.loadSessions();
  });

  // 新消息 / 切换会话 → 滚到底部
  $effect(() => {
    void chat.messages.length;
    void chat.current?.id;
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  });

  async function select(sessionId: string) {
    const session = chat.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    await chat.openSession(session);
  }

  /** 上滑加载更早历史（保持滚动位置：预置高度差补偿） */
  async function loadOlder() {
    if (!chatEl) return;
    const prevHeight = chatEl.scrollHeight;
    const prevTop = chatEl.scrollTop;
    await chat.loadOlder();
    requestAnimationFrame(() => {
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight - prevHeight + prevTop;
    });
  }

  async function submit() {
    const text = draft;
    if (!text.trim()) return;
    draft = "";
    await chat.send(text);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }
</script>

{#snippet statusTicks(msg: ChatMessage)}
  {#if msg.sender === "self"}
    {#if msg.status === "sending"}
      <svg class="h-3.5 w-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
    {:else if msg.status === "sent"}
      <svg class="h-3.5 w-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
    {:else if msg.status === "delivered"}
      <svg class="h-3.5 w-3.5 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12l5 5L17 7"/><path d="m13 17 1.5 1.5L23 10"/></svg>
    {:else if msg.status === "read"}
      <svg class="h-3.5 w-3.5 text-sky-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12l5 5L17 7"/><path d="m13 17 1.5 1.5L23 10"/></svg>
    {:else if msg.status === "failed"}
      <button
        class="text-red-300 hover:text-red-200"
        title="发送失败，点击重发"
        onclick={() => void chat.resend(msg)}
      >!</button>
    {/if}
  {/if}
{/snippet}

<div class="flex h-full bg-[var(--p-bg)]">
  <!-- ══ 会话列表 ══════════════════════════════════════ -->
  <div class="flex w-80 shrink-0 flex-col border-r border-[var(--p-border)] bg-[var(--p-card)]">
    <div class="flex items-center justify-between border-b border-[var(--p-border)] px-4 py-3">
      <h1 class="text-xl font-semibold text-[var(--p-fg)]">消息</h1>
      <div class="flex items-center gap-1">
        <button
          class="rounded-full p-2 transition-colors hover:bg-[var(--p-muted)]"
          title="新聊天"
          onclick={async () => {
            pickerOpen = !pickerOpen;
            if (pickerOpen) void chat.loadFriends();
          }}
        >
          <svg class="h-4 w-4 text-[var(--p-muted-fg)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
        <button
          class="rounded-full p-2 transition-colors hover:bg-[var(--p-muted)]"
          title="刷新"
          onclick={() => void chat.loadSessions()}
        >
          <svg class="h-4 w-4 text-[var(--p-muted-fg)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>
        </button>
      </div>
    </div>

    {#if pickerOpen}
      <div class="border-b border-[var(--p-border)] bg-[var(--p-muted)]/40">
        <p class="px-4 pt-2 text-xs font-medium text-[var(--p-muted-fg)]">选择好友开始聊天</p>
        <div class="max-h-60 overflow-y-auto py-1">
          {#if chat.friends.length === 0}
            <p class="px-4 py-3 text-sm text-[var(--p-muted-fg)]">还没有好友，先去「通讯录」添加</p>
          {:else}
            {#each chat.friends as friend (friend.user.id)}
              <button
                class="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[var(--p-muted)]/60 disabled:opacity-50"
                disabled={creating}
                onclick={() => void pickFriend(friend.user.id)}
              >
                <div class="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--p-secondary)] text-xs font-medium text-[var(--p-secondary-fg)]">
                  {friend.user.nickname.slice(0, 1)}
                </div>
                <span class="flex-1 truncate text-sm text-[var(--p-fg)]">{friend.user.nickname}</span>
                {#if friend.online}
                  <span class="h-2 w-2 rounded-full bg-green-500"></span>
                {/if}
              </button>
            {/each}
          {/if}
        </div>
      </div>
    {/if}

    <div class="px-3 py-2">
      <input
        type="text"
        bind:value={searchQuery}
        placeholder="搜索"
        class="h-9 w-full rounded-md border border-[var(--p-border)] bg-[var(--p-bg)] px-3 text-sm placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-primary)] focus:outline-none"
      />
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if chat.sessionsLoading && chat.sessions.length === 0}
        <p class="px-4 py-6 text-center text-sm text-[var(--p-muted-fg)]">加载中…</p>
      {:else if filteredSessions.length === 0}
        <p class="px-4 py-6 text-center text-sm text-[var(--p-muted-fg)]">
          暂无会话，去「通讯录」发起聊天
        </p>
      {:else}
        {#each filteredSessions as session (session.id)}
          <button
            onclick={() => void select(session.id)}
            class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--p-muted)]/50 {chat.current?.id === session.id ? 'bg-[var(--p-muted)]/70' : ''}"
          >
            <div class="relative shrink-0">
              <div class="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--p-primary)] font-medium text-[var(--p-primary-fg)]">
                {session.peer.nickname.slice(0, 1)}
              </div>
              {#if session.peerOnline}
                <div class="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--p-card)] bg-green-500"></div>
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between">
                <span class="truncate font-medium text-[var(--p-fg)]">{session.peer.nickname}</span>
                {#if session.lastMessage}
                  <span class="shrink-0 text-xs text-[var(--p-muted-fg)]">{formatConvTime(pgTimeToMs(session.lastMessageAt))}</span>
                {/if}
              </div>
              <div class="mt-0.5 flex items-center justify-between">
                <p class="truncate text-sm text-[var(--p-muted-fg)]">
                  {session.lastMessage?.content ?? "开始聊天吧"}
                </p>
                {#if session.unreadCount > 0}
                  <span class="ml-2 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">
                    {session.unreadCount > 99 ? '99+' : session.unreadCount}
                  </span>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <!-- ══ 聊天区 ════════════════════════════════════════ -->
  {#if chat.current && chat.localConversation}
    <div class="flex min-w-0 flex-1 flex-col bg-[var(--p-muted)]/30">
      <!-- 头部：对端 + 在线状态 -->
      <div class="flex items-center gap-3 border-b border-[var(--p-border)] bg-[var(--p-card)] px-4 py-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--p-primary)] text-sm font-medium text-[var(--p-primary-fg)]">
          {chat.current.peer.nickname.slice(0, 1)}
        </div>
        <div>
          <p class="font-medium leading-tight text-[var(--p-fg)]">{chat.current.peer.nickname}</p>
          <p class="text-xs leading-tight text-[var(--p-muted-fg)]">
            {chat.current.peerOnline ? "在线" : "离线"}
          </p>
        </div>
        {#if chat.error}
          <span class="ml-auto text-xs text-red-500">{chat.error}</span>
        {/if}
      </div>

      <!-- 消息流（本地优先渲染） -->
      <div bind:this={chatEl} class="flex-1 overflow-y-auto px-4 py-4">
        {#if chat.hasMoreHistory}
          <div class="mb-3 text-center">
            <button
              class="rounded-full border border-[var(--p-border)] bg-[var(--p-card)] px-3 py-1 text-xs text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] disabled:opacity-50"
              disabled={chat.loadingOlder}
              onclick={() => void loadOlder()}
            >
              {chat.loadingOlder ? "加载中…" : "加载更早的消息"}
            </button>
          </div>
        {/if}
        {#if chat.syncing && chat.messages.length === 0}
          <p class="py-6 text-center text-sm text-[var(--p-muted-fg)]">正在从服务端同步…</p>
        {:else if chat.messages.length === 0}
          <p class="py-6 text-center text-sm text-[var(--p-muted-fg)]">还没有消息，打个招呼吧</p>
        {/if}
        {#each chat.messages as msg (msg.id)}
          <div class="mb-3 flex {msg.sender === 'self' ? 'justify-end' : 'justify-start'}">
            {#if msg.sender === 'system'}
              <span class="rounded-full bg-[var(--p-muted)] px-3 py-1 text-xs text-[var(--p-muted-fg)]">{msg.content}</span>
            {:else if msg.kind === 'image'}
              <!-- 图片消息：七牛外链直接预览 -->
              <div class="max-w-[70%]">
                <img
                  src={msg.content}
                  alt={parseMessageMeta(msg.meta).fname ?? '图片'}
                  class="max-h-[240px] max-w-full cursor-pointer rounded-xl border border-[var(--p-border)] object-contain"
                  title="点击复制链接"
                  onclick={() => void copyUrl(msg)}
                />
                <div class="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-[var(--p-muted-fg)] {msg.sender === 'self' ? 'justify-end' : ''}">
                  {#if msg.sender === 'self'}{@render statusTicks(msg)}{/if}
                  <span>{formatMsgTime(msg.createdAt)}</span>
                </div>
              </div>
            {:else if msg.kind === 'file'}
              <!-- 文件消息：文件卡片 -->
              {@const meta = parseMessageMeta(msg.meta)}
              <div
                class="flex max-w-[70%] items-center gap-3 rounded-xl border border-[var(--p-border)] bg-[var(--p-card)] px-3.5 py-2.5 {msg.sender === 'self' ? 'rounded-br-sm' : 'rounded-bl-sm'}"
                title={msg.content}
              >
                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--p-primary-muted)]">
                  <svg class="h-4.5 w-4.5 text-[var(--p-primary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
                </div>
                <div class="min-w-0">
                  <p class="max-w-[220px] truncate text-sm font-medium text-[var(--p-fg)]">{meta.fname ?? '文件'}</p>
                  <p class="text-xs text-[var(--p-muted-fg)]">{formatBytes(meta.size ?? 0)} · 点击复制链接</p>
                </div>
                <button
                  class="shrink-0 rounded p-1.5 text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
                  title="复制链接"
                  onclick={() => void copyUrl(msg)}
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </button>
              </div>
              <div class="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-[var(--p-muted-fg)]">
                {#if msg.sender === 'self'}{@render statusTicks(msg)}{/if}
                <span>{formatMsgTime(msg.createdAt)}</span>
              </div>
            {:else}
              <div
                class="group max-w-[70%] rounded-2xl px-3.5 py-2 {msg.sender === 'self'
                  ? 'rounded-br-sm bg-[var(--p-primary)] text-[var(--p-primary-fg)]'
                  : 'rounded-bl-sm border border-[var(--p-border)] bg-[var(--p-card)] text-[var(--p-fg)]'}"
              >
                <p class="whitespace-pre-wrap break-words text-sm">{msg.content}</p>
                <div class="mt-0.5 flex items-center justify-end gap-1 text-[10px] {msg.sender === 'self' ? 'text-[var(--p-primary-fg)]/70' : 'text-[var(--p-muted-fg)]'}">
                  <span>{formatMsgTime(msg.createdAt)}</span>
                  {@render statusTicks(msg)}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <!-- 输入区 -->
      <div class="border-t border-[var(--p-border)] bg-[var(--p-card)] px-4 py-3">
        <!-- 七牛上传进度（进行中显示，可取消） -->
        {#if chat.uploadProgress}
          <div class="mb-2 flex items-center gap-2 rounded-lg border border-[var(--p-border)] bg-[var(--p-muted)]/40 px-3 py-1.5">
            <svg class="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--p-muted-fg)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <span class="min-w-0 flex-1 truncate text-xs text-[var(--p-fg)]">上传 {chat.uploadProgress.fname}</span>
            <div class="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--p-muted)]">
              <div class="h-full rounded-full bg-[var(--p-primary)] transition-all" style="width: {chat.uploadProgress.percent}%"></div>
            </div>
            <span class="w-9 text-right text-xs tabular-nums text-[var(--p-muted-fg)]">{chat.uploadProgress.percent}%</span>
            <button
              class="text-xs text-[var(--p-muted-fg)] hover:text-[var(--p-fg)]"
              onclick={() => chat.cancelUpload()}
            >取消</button>
          </div>
        {/if}
        <div class="flex items-end gap-2">
          <!-- 图片 / 文件附件（七牛直传，dir=chat） -->
          <input type="file" accept="image/*" class="hidden" bind:this={imageInput} onchange={onPickImage} />
          <input type="file" class="hidden" bind:this={fileInput} onchange={onPickFile} />
          <button
            class="flex h-[38px] w-[38px] items-center justify-center rounded-lg text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
            title="发送图片"
            disabled={!!chat.uploadProgress}
            onclick={() => imageInput?.click()}
          >
            <svg class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
          </button>
          <button
            class="flex h-[38px] w-[38px] items-center justify-center rounded-lg text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
            title="发送文件"
            disabled={!!chat.uploadProgress}
            onclick={() => fileInput?.click()}
          >
            <svg class="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <textarea
            bind:value={draft}
            onkeydown={onKeydown}
            rows="1"
            placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
            class="max-h-32 min-h-[38px] flex-1 resize-none rounded-lg border border-[var(--p-border)] bg-[var(--p-bg)] px-3 py-2 text-sm placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-primary)] focus:outline-none"
          ></textarea>
          <button
            onclick={() => void submit()}
            disabled={!draft.trim() || !!chat.uploadProgress}
            class="flex h-[38px] items-center gap-1.5 rounded-lg bg-[var(--p-primary)] px-4 text-sm font-medium text-[var(--p-primary-fg)] transition-opacity disabled:opacity-50"
          >
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            发送
          </button>
        </div>
      </div>
    </div>
  {:else}
    <div class="flex flex-1 items-center justify-center bg-[var(--p-muted)]/30">
      <div class="text-center">
        <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--p-muted)]">
          <svg class="h-8 w-8 text-[var(--p-muted-fg)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <p class="text-[var(--p-muted-fg)]">
          {chat.sessions.length === 0 ? "左侧会话为空：先在「通讯录」添加好友并发起聊天" : "选择一个对话开始聊天"}
        </p>
      </div>
    </div>
  {/if}
</div>
