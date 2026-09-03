<script lang="ts">
  import { onMount, tick } from "svelte";
  import { chat } from "$lib/chat-store.svelte";
  import {
    formatConvTime,
    formatMsgTime,
    formatBytes,
    parseMessageMeta,
    parseReactions,
    parseReplySummary,
    type ChatMessage,
  } from "$lib/chat";
  import { serverTimeToMs as pgTimeToMs } from "$lib/api/sessions";
  import { groupsApi } from "$lib/api/groups";
  import { uploadToQiniu, isUploadCanceled } from "$lib/upload/qiniu";
  import { call } from "$lib/webrtc/call-store.svelte";
  import { profile } from "$lib/api/profile.svelte";

  // ── Lucide 图标（官方推荐：子路径单独导入，tree-shakable） ──
  import Clock from "@lucide/svelte/icons/clock";
  import Check from "@lucide/svelte/icons/check";
  import CheckCheck from "@lucide/svelte/icons/check-check";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Settings from "@lucide/svelte/icons/settings";
  import Megaphone from "@lucide/svelte/icons/megaphone";
  import FileIcon from "@lucide/svelte/icons/file";
  import Copy from "@lucide/svelte/icons/copy";
  import Reply from "@lucide/svelte/icons/reply";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import X from "@lucide/svelte/icons/x";
  import ImageIcon from "@lucide/svelte/icons/image";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import Send from "@lucide/svelte/icons/send";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import PhoneIcon from "@lucide/svelte/icons/phone";
  import VideoIcon from "@lucide/svelte/icons/video";

  let draft = $state("");
  let chatEl: HTMLDivElement | undefined = $state();
  let searchQuery = $state("");
  let pickerOpen = $state(false);
  let creating = $state(false);
  let imageInput: HTMLInputElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let groupAvatarInput: HTMLInputElement | undefined = $state();

  /** 「新聊天 / 建群」面板 */
  let createGroupOpen = $state(false);
  let newGroupName = $state("");
  let pickedFriendIds = $state<number[]>([]);
  let creatingGroup = $state(false);

  /** 群设置面板 */
  let groupSettingsOpen = $state(false);
  let editName = $state("");
  let editAnnouncement = $state("");
  let inviteOpen = $state(false);

  /** 消息悬停/操作 */
  let hoverMsgId = $state<number | null>(null);
  const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀"] as const;

  /** 会话列表宽度（可拖拽调节） */
  const SIDEBAR_MIN = 220;
  const SIDEBAR_MAX = 480;
  let sidebarWidth = $state(320);
  let dragging = $state(false);
  let resizeHandleEl = $state<HTMLDivElement>();

  function startResize(e: MouseEvent) {
    e.preventDefault();
    dragging = true;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX));
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const isGroup = $derived(chat.current?.kind === "group");
  const groupTitle = $derived(
    chat.current?.kind === "group"
      ? `${chat.current.name ?? "群聊"}（${chat.current.memberCount ?? 0}）`
      : (chat.current?.peer?.nickname ?? ""),
  );

  const filteredSessions = $derived(
    chat.sessions.filter((s) => {
      const title = s.kind === "group" ? (s.name ?? "") : (s.peer?.nickname ?? "");
      return title.toLowerCase().includes(searchQuery.trim().toLowerCase());
    }),
  );

  /** 消息头像：自己用 profile，对端/群用会话资料 */
  const currentSession = $derived(chat.sessions.find((s) => s.id === chat.current?.id));
  function msgAvatar(sender: "self" | "other"): { url: string; text: string } {
    if (sender === "self")
      return { url: profile.avatarUrl, text: (profile.displayName || "我").slice(0, 1) };
    const s = currentSession;
    if (!s) return { url: "", text: "?" };
    if (s.kind === "group") return { url: s.avatarUrl ?? "", text: (s.name ?? "群").slice(0, 1) };
    return { url: s.peer?.avatarUrl ?? "", text: (s.peer?.nickname ?? "?").slice(0, 1) };
  }

  function sessionAvatarText(s: (typeof chat.sessions)[number]): string {
    return s.kind === "group" ? (s.name ?? "群").slice(0, 1) : (s.peer?.nickname ?? "?").slice(0, 1);
  }
  function sessionTitle(s: (typeof chat.sessions)[number]): string {
    return s.kind === "group" ? (s.name ?? "群聊") : (s.peer?.nickname ?? "");
  }

  onMount(() => {
    chat.initWsHandlers();
    void chat.loadSessions();

    // 窗口从托盘/后台唤回 → 补发当前会话的已读回执
    // （后台时收到的消息有意保留未读，见 chat-store.onWindowForeground）
    const onForeground = () => void chat.onWindowForeground();
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
    };
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
    groupSettingsOpen = false;
    await chat.openSession(session);
  }

  async function submit() {
    const text = draft;
    if (!text.trim()) return;
    draft = "";
    const mentions = chat.pendingMentions;
    chat.pendingMentions = [];
    await chat.send(text, mentions);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  /** 上滑加载更早历史（保持滚动位置） */
  async function loadOlder() {
    if (!chatEl) return;
    const prevHeight = chatEl.scrollHeight;
    const prevTop = chatEl.scrollTop;
    await chat.loadOlder();
    requestAnimationFrame(() => {
      if (chatEl) chatEl.scrollTop = chatEl.scrollHeight - prevHeight + prevTop;
    });
  }

  function startReply(msg: ChatMessage) {
    chat.replyTo = msg;
  }

  function previewText(msg: ChatMessage): string {
    if (msg.kind === "image") return "[图片]";
    if (msg.kind === "file") return `[文件] ${parseMessageMeta(msg.meta).fname ?? ""}`;
    return msg.content;
  }

  function isMineReaction(msg: ChatMessage, emoji: string): boolean {
    return parseReactions(msg.reactions).some(
      (g) => g.emoji === emoji && g.userIds.includes(chat.myUserId),
    );
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

  /** @ 某条消息的发送者：从群详情成员按昵称反查 id（重名取第一个），记入 mentions */
  function mentionSender(msg: ChatMessage) {
    const member = chat.groupDetail?.members.find((m) => m.user.nickname === msg.senderName);
    if (!member) return; // 群详情未加载或找不到 → 忽略
    if (!chat.pendingMentions.includes(String(member.user.id))) {
      chat.pendingMentions = [...chat.pendingMentions, String(member.user.id)];
    }
    draft = `${draft}@${msg.senderName} `;
  }

  function canRecall(msg: ChatMessage): boolean {
    return (
      msg.sender === "self" &&
      msg.serverMsgId !== null &&
      !msg.recalled &&
      Date.now() - msg.createdAt <= 2 * 60 * 1000
    );
  }

  async function copyUrl(msg: ChatMessage) {
    try {
      await navigator.clipboard.writeText(msg.content);
    } catch {
      /* 剪贴板权限失败时静默 */
    }
  }

  // ── 建群 ──
  async function submitCreateGroup() {
    const name = newGroupName.trim();
    if (!name || pickedFriendIds.length === 0) return;
    creatingGroup = true;
    try {
      await chat.createGroup(name, pickedFriendIds);
      createGroupOpen = false;
      newGroupName = "";
      pickedFriendIds = [];
    } finally {
      creatingGroup = false;
    }
  }

  // ── 群设置：改名/公告/禁言/头像 ──
  async function saveGroupName() {
    if (!chat.groupDetail) return;
    await chat.renameGroup(chat.groupDetail.id, editName);
  }
  async function saveAnnouncement() {
    if (!chat.groupDetail) return;
    await chat.setAnnouncement(chat.groupDetail.id, editAnnouncement);
  }
  async function uploadGroupAvatar(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !chat.groupDetail) return;
    try {
      const handle = uploadToQiniu(file, { dir: "avatar", fileName: file.name });
      const up = await handle.done;
      await chat.setGroupAvatar(chat.groupDetail.id, up.url);
    } catch (e) {
      if (!isUploadCanceled(e)) chat.error = e instanceof Error ? e.message : String(e);
    }
  }
  async function doLeave() {
    if (!chat.groupDetail) return;
    await chat.leaveGroup(chat.groupDetail.id);
    groupSettingsOpen = false;
  }
</script>

{#snippet statusTicks(msg: ChatMessage)}
  {#if msg.sender === "self"}
    {#if msg.status === "sending"}
      <Clock size={14} class="opacity-70" />
    {:else if msg.status === "sent"}
      <Check size={14} class="opacity-70" />
    {:else if msg.status === "delivered"}
      <CheckCheck size={14} class="opacity-70" />
    {:else if msg.status === "read"}
      <CheckCheck size={14} class="text-sky-300" />
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
  <div class="flex shrink-0 flex-col border-r border-[var(--p-border)] bg-[var(--p-card)]" style="width: {sidebarWidth}px">
    <div class="flex items-center justify-between border-b border-[var(--p-border)] px-4 py-3">
      <h1 class="text-xl font-semibold text-[var(--p-fg)]">消息</h1>
      <div class="flex items-center gap-1">
        <button
          class="rounded-full p-2 transition-colors hover:bg-[var(--p-muted)]"
          title="新聊天 / 建群"
          onclick={async () => {
            pickerOpen = !pickerOpen;
            if (pickerOpen) void chat.loadFriends();
          }}
        >
          <Plus size={16} class="text-[var(--p-muted-fg)]" />
        </button>
        <button
          class="rounded-full p-2 transition-colors hover:bg-[var(--p-muted)]"
          title="刷新"
          onclick={() => void chat.loadSessions()}
        >
          <RefreshCw size={16} class="text-[var(--p-muted-fg)]" />
        </button>
      </div>
    </div>

    {#if pickerOpen}
      <div class="border-b border-[var(--p-border)] bg-[var(--p-muted)]/40">
        <!-- 建群表单 -->
        <div class="px-3 pt-2">
          <input
            type="text"
            bind:value={newGroupName}
            placeholder="群名称（勾选好友后建群）"
            class="h-8 w-full rounded-md border border-[var(--p-border)] bg-[var(--p-bg)] px-2.5 text-xs text-[var(--p-fg)] placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-primary)] focus:outline-none"
          />
        </div>
        <p class="px-4 pt-2 text-xs font-medium text-[var(--p-muted-fg)]">选择好友（单聊：只选一个；建群：勾选多个）</p>
        <div class="scroll-area-thin max-h-60 overflow-y-auto py-1">
          {#if chat.friends.length === 0}
            <p class="px-4 py-3 text-sm text-[var(--p-muted-fg)]">还没有好友，先去「通讯录」添加</p>
          {:else}
            {#each chat.friends as friend (friend.user.id)}
              <button
                class="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[var(--p-muted)]/60 disabled:opacity-50"
                onclick={async () => {
                  // 单聊：直接打开会话；建群模式：勾选
                  if (newGroupName.trim() === "") {
                    creating = true;
                    try {
                      await chat.createSession(friend.user.id);
                      pickerOpen = false;
                    } finally {
                      creating = false;
                    }
                  } else {
                    pickedFriendIds = pickedFriendIds.includes(friend.user.id)
                      ? pickedFriendIds.filter((id) => id !== friend.user.id)
                      : [...pickedFriendIds, friend.user.id];
                  }
                }}
              >
                <div class="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--p-secondary)] text-xs font-medium text-[var(--p-secondary-fg)]">
                  {friend.user.nickname.slice(0, 1)}
                </div>
                <span class="flex-1 truncate text-sm text-[var(--p-fg)]">{friend.user.nickname}</span>
                {#if friend.online}
                  <span class="h-2 w-2 rounded-full bg-green-500"></span>
                {/if}
                {#if newGroupName.trim() !== ""}
                  <input type="checkbox" checked={pickedFriendIds.includes(friend.user.id)} class="pointer-events-none" />
                {/if}
              </button>
            {/each}
          {/if}
        </div>
        {#if newGroupName.trim() !== ""}
          <div class="border-t border-[var(--p-border)] px-3 py-2">
            <button
              class="w-full rounded-md bg-[var(--p-primary)] py-1.5 text-xs font-medium text-[var(--p-primary-fg)] transition-opacity disabled:opacity-50"
              disabled={creatingGroup || pickedFriendIds.length === 0}
              onclick={() => void submitCreateGroup()}
            >
              {creatingGroup ? "创建中…" : `创建「${newGroupName.trim()}」(${pickedFriendIds.length + 1} 人)`}
            </button>
          </div>
        {/if}
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
          暂无会话，点右上角「+」发起聊天或建群
        </p>
      {:else}
        {#each filteredSessions as session (session.id)}
          <button
            onclick={() => void select(session.id)}
            class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--p-muted)]/50 {chat.current?.id === session.id ? 'bg-[var(--p-muted)]/70' : ''}"
          >
            <div class="relative shrink-0">
              {#if session.avatarUrl}
                <img src={session.avatarUrl} alt={sessionTitle(session)} class="h-12 w-12 rounded-xl object-cover" />
              {:else}
                <div class="flex h-12 w-12 items-center justify-center rounded-full {session.kind === 'group' ? 'rounded-xl bg-[var(--p-secondary)]' : 'bg-[var(--p-primary)]'} font-medium text-[var(--p-primary-fg)]">
                  {sessionAvatarText(session)}
                </div>
              {/if}
              {#if session.kind === 'direct' && session.peerOnline}
                <div class="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[var(--p-card)] bg-green-500"></div>
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center justify-between">
                <span class="truncate font-medium text-[var(--p-fg)]">{sessionTitle(session)}</span>
                {#if session.lastMessage}
                  <span class="shrink-0 text-xs text-[var(--p-muted-fg)]">{formatConvTime(pgTimeToMs(session.lastMessageAt))}</span>
                {/if}
              </div>
              <div class="mt-0.5 flex items-center justify-between">
                <p class="truncate text-sm text-[var(--p-muted-fg)]">
                  {session.lastMessage ? `${session.lastMessage.senderName ? session.lastMessage.senderName + '：' : ''}${session.lastMessage.content}` : (session.kind === 'group' ? '群聊已创建' : '开始聊天吧')}
                </p>
                {#if session.unreadCount > 0}
                  <span class="ml-2 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-semibold text-white">
                    {session.unreadCount > 99 ? "99+" : session.unreadCount}
                  </span>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <!-- 拖拽分隔条：会话列表 ↔ 聊天区 -->
  <div
    bind:this={resizeHandleEl}
    class="h-full w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-[var(--p-primary)]/40 {
      dragging ? 'bg-[var(--p-primary)]/60' : ''
    }"
    onmousedown={startResize}
    role="separator"
    aria-orientation="vertical"
  ></div>

  <!-- ══ 聊天区 ════════════════════════════════════════ -->
  {#if chat.current && chat.localConversation}
    <div class="flex min-w-0 flex-1 flex-col bg-[var(--p-muted)]/30">
      <!-- 头部 -->
      <div class="flex items-center gap-3 border-b border-[var(--p-border)] bg-[var(--p-card)] px-4 py-3">
        <div class="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--p-primary)] text-sm font-medium text-[var(--p-primary-fg)]">
          {sessionAvatarText(chat.current)}
        </div>
        <div>
          <p class="font-medium leading-tight text-[var(--p-fg)]">{groupTitle}</p>
          <p class="text-xs leading-tight text-[var(--p-muted-fg)]">
            {#if isGroup}
              {chat.current.muteAll ? "全员禁言中" : "群聊"}
            {:else}
              {chat.current.peerOnline ? "在线" : "离线"}
            {/if}
          </p>
        </div>
        {#if chat.error}
          <span class="ml-auto text-xs text-red-500">{chat.error}</span>
        {/if}
        {#if !isGroup && chat.current.peer}
          <!-- 音视频通话（1:1，WebRTC P2P） -->
          <div class="ml-auto flex items-center gap-1">
            <button
              class="rounded-full p-2 text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)] disabled:opacity-40"
              title="语音通话"
              disabled={call.active}
              onclick={() => void call.start(chat.current!.peer!, "audio")}
            >
              <PhoneIcon size={18} />
            </button>
            <button
              class="rounded-full p-2 text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)] disabled:opacity-40"
              title="视频通话"
              disabled={call.active}
              onclick={() => void call.start(chat.current!.peer!, "video")}
            >
              <VideoIcon size={18} />
            </button>
          </div>
        {/if}
        {#if isGroup}
          <button
            class="ml-auto rounded-full p-2 text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
            title="群设置"
            onclick={async () => {
              groupSettingsOpen = !groupSettingsOpen;
              if (groupSettingsOpen && chat.current) {
                editName = chat.current.name ?? "";
                editAnnouncement = chat.groupDetail?.announcement ?? "";
                await chat.loadGroupDetail(chat.current.id);
                editName = chat.groupDetail?.name ?? "";
                editAnnouncement = chat.groupDetail?.announcement ?? "";
              }
            }}
          >
            <Settings size={18} />
          </button>
        {/if}
      </div>

      <!-- 群公告横幅 -->
      {#if isGroup && chat.groupDetail?.announcement}
        <div class="flex items-center gap-2 border-b border-[var(--p-border)] bg-amber-50/80 px-4 py-1.5 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <Megaphone size={14} class="shrink-0" />
          <span class="truncate">{chat.groupDetail.announcement}</span>
        </div>
      {/if}

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
          <div
            class="mb-3 flex {msg.sender === 'self' ? 'justify-end' : 'justify-start'}"
            onmouseenter={() => (hoverMsgId = msg.id)}
            onmouseleave={() => {
              if (hoverMsgId === msg.id) hoverMsgId = null;
            }}
          >
            {#if msg.sender === 'system' || msg.recalled}
              <span class="rounded-full bg-[var(--p-muted)] px-3 py-1 text-xs text-[var(--p-muted-fg)]">
                {msg.recalled
                  ? (msg.sender === 'self' ? '你撤回了一条消息' : `${msg.senderName} 撤回了一条消息`)
                  : msg.content}
              </span>
            {:else}
              {@const replyInfo = parseReplySummary(msg.replySummary)}
              {@const av = msgAvatar(msg.sender === 'self' ? 'self' : 'other')}
              {#if msg.sender === 'other'}
                {#if av.url}
                  <img
                    src={av.url}
                    alt={msg.senderName}
                    class="mr-2 h-8 w-8 shrink-0 self-start rounded-full object-cover"
                  />
                {:else}
                  <div class="mr-2 flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-full bg-[var(--p-secondary)] text-xs font-medium text-[var(--p-secondary-fg)]">{av.text}</div>
                {/if}
              {/if}
              <div class="relative flex max-w-[70%] flex-col {msg.sender === 'self' ? 'items-end' : 'items-start'}">
                {#if replyInfo}
                  <!-- 引用预览块 -->
                  <div
                    class="mb-1 max-w-full truncate rounded-lg border-l-2 border-[var(--p-primary)] bg-[var(--p-muted)]/60 px-2.5 py-1 text-xs text-[var(--p-muted-fg)]"
                    title={replyInfo.content}
                  >
                    <span class="font-medium">{replyInfo.senderName}</span>
                    ：{replyInfo.kind === 'image' ? '[图片]' : replyInfo.kind === 'file' ? `[文件] ${replyInfo.content}` : replyInfo.content}
                  </div>
                {/if}

                {#if msg.kind === 'image'}
                  <!-- 图片消息：七牛外链直接预览 -->
                  <img
                    src={msg.content}
                    alt={parseMessageMeta(msg.meta).fname ?? '图片'}
                    class="max-h-[240px] max-w-full cursor-pointer rounded-xl border border-[var(--p-border)] object-contain"
                    title="点击复制链接"
                    onclick={() => void copyUrl(msg)}
                  />
                {:else if msg.kind === 'file'}
                  {@const meta = parseMessageMeta(msg.meta)}
                  <!-- 文件消息：文件卡片 -->
                  <div
                    class="flex items-center gap-3 rounded-xl border border-[var(--p-border)] bg-[var(--p-card)] px-3.5 py-2.5 {msg.sender === 'self' ? 'rounded-br-sm' : 'rounded-bl-sm'}"
                    title={msg.content}
                  >
                    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--p-primary-muted)]">
                      <FileIcon size={18} class="text-[var(--p-primary)]" />
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
                      <Copy size={16} />
                    </button>
                  </div>
                {:else}
                  <div
                    class="group rounded-2xl px-3.5 py-2 {msg.sender === 'self'
                      ? 'rounded-br-sm bg-[var(--p-primary)] text-[var(--p-primary-fg)]'
                      : 'rounded-bl-sm border border-[var(--p-border)] bg-[var(--p-card)] text-[var(--p-fg)]'}"
                  >
                    <p class="whitespace-pre-wrap break-words text-sm">{msg.content}</p>
                  </div>
                {/if}

                <!-- 时间 / 状态勾 / 表情回应 chips / @我 徽章 -->
                <div class="mt-0.5 flex items-center gap-1 {msg.sender === 'self' ? 'flex-row-reverse' : ''}">
                  {#if msg.sender === 'self'}{@render statusTicks(msg)}{/if}
                  <span class="text-[10px] text-[var(--p-muted-fg)]">{formatMsgTime(msg.createdAt)}</span>
                  {#if msg.serverMsgId && chat.liveMentionedIds.includes(msg.serverMsgId)}
                    <span class="rounded bg-red-100 px-1 text-[10px] font-medium text-red-600 dark:bg-red-900/40 dark:text-red-300">@我</span>
                  {/if}
                  {#each parseReactions(msg.reactions) as group (group.emoji)}
                    <button
                      class="flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[11px] transition-colors {isMineReaction(msg, group.emoji)
                        ? 'border-[var(--p-primary)] bg-[var(--p-primary-muted)]'
                        : 'border-[var(--p-border)] bg-[var(--p-card)]'}"
                      title={group.userIds.join(', ')}
                      onclick={() => void chat.toggleReaction(msg, group.emoji)}
                    >
                      <span>{group.emoji}</span>
                      <span class="text-[var(--p-muted-fg)]">{group.count}</span>
                    </button>
                  {/each}
                </div>

                <!-- 悬停操作条：回复 / @发送者 / 快捷 emoji / 撤回 -->
                {#if hoverMsgId === msg.id && msg.status !== 'sending' && !msg.recalled}
                  <div class="absolute top-0 z-10 flex items-center gap-0.5 rounded-full border border-[var(--p-border)] bg-[var(--p-card)] px-1 py-0.5 shadow-md {msg.sender === 'self' ? '-left-2 -translate-x-full' : '-right-2 translate-x-full'}">
                    <button
                      class="rounded-full p-1.5 text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
                      title="引用回复"
                      onclick={() => startReply(msg)}
                    >
                      <Reply size={14} />
                    </button>
                    {#if isGroup}
                      <button
                        class="rounded-full px-1.5 py-1 text-xs font-medium text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
                        title="@{msg.senderName}"
                        onclick={() => mentionSender(msg)}
                      >@</button>
                    {/if}
                    {#each QUICK_EMOJIS as emoji (emoji)}
                      <button
                        class="rounded-full p-1 text-sm transition-transform hover:scale-125"
                        title="回应 {emoji}"
                        onclick={() => void chat.toggleReaction(msg, emoji)}
                      >{emoji}</button>
                    {/each}
                    {#if canRecall(msg)}
                      <button
                        class="rounded-full p-1.5 text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-red-500"
                        title="撤回（2 分钟内）"
                        onclick={() => void chat.recall(msg)}
                      >
                        <Trash2 size={14} />
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <!-- 输入区 -->
      <div class="border-t border-[var(--p-border)] bg-[var(--p-card)] px-4 py-3">
        {#if chat.replyTo}
          <div class="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-[var(--p-primary)] bg-[var(--p-muted)]/40 px-3 py-1.5">
            <Reply size={14} class="shrink-0 text-[var(--p-primary)]" />
            <span class="min-w-0 flex-1 truncate text-xs text-[var(--p-muted-fg)]">
              回复 <span class="font-medium">{chat.replyTo.senderName || '我'}</span>：{previewText(chat.replyTo)}
            </span>
            <button class="text-[var(--p-muted-fg)] hover:text-[var(--p-fg)]" aria-label="取消回复" onclick={() => chat.cancelReply()}><X size={14} /></button>
          </div>
        {/if}
        {#if chat.pendingMentions.length > 0}
          <div class="mb-2 text-xs text-[var(--p-muted-fg)]">
            将 @ {chat.pendingMentions.length} 位成员
          </div>
        {/if}
        <div class="flex items-end gap-2">
          <input type="file" accept="image/*" class="hidden" bind:this={imageInput} onchange={onPickImage} />
          <input type="file" class="hidden" bind:this={fileInput} onchange={onPickFile} />
          <button
            class="flex h-[38px] w-[38px] items-center justify-center rounded-lg text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
            title="发送图片"
            disabled={!!chat.uploadProgress}
            onclick={() => imageInput?.click()}
          >
            <ImageIcon size={18} />
          </button>
          <button
            class="flex h-[38px] w-[38px] items-center justify-center rounded-lg text-[var(--p-muted-fg)] transition-colors hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
            title="发送文件"
            disabled={!!chat.uploadProgress}
            onclick={() => fileInput?.click()}
          >
            <Paperclip size={18} />
          </button>
          <textarea
            bind:value={draft}
            onkeydown={onKeydown}
            rows="1"
            placeholder={chat.current.muteAll && chat.current.myRole === 'member' ? "群已全员禁言" : "输入消息，Enter 发送（Shift+Enter 换行）"}
            disabled={!!(chat.current.muteAll && chat.current.myRole === 'member')}
            class="max-h-32 min-h-[38px] flex-1 resize-none rounded-lg border border-[var(--p-border)] bg-[var(--p-bg)] px-3 py-2 text-sm placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-primary)] focus:outline-none disabled:opacity-60"
          ></textarea>
          <button
            onclick={() => void submit()}
            disabled={!draft.trim() || !!chat.uploadProgress}
            class="flex h-[38px] items-center gap-1.5 rounded-lg bg-[var(--p-primary)] px-4 text-sm font-medium text-[var(--p-primary-fg)] transition-opacity disabled:opacity-50"
          >
            <Send size={16} />
            发送
          </button>
        </div>
      </div>
    </div>

    <!-- ══ 群设置面板 ════════════════════════════════ -->
    {#if groupSettingsOpen && chat.groupDetail}
      {@const gd = chat.groupDetail}
      {@const canManage = gd.myRole === 'owner' || gd.myRole === 'admin'}
      <div class="fixed inset-0 z-50 flex justify-end bg-black/40" role="presentation" onclick={() => (groupSettingsOpen = false)}>
        <div
          class="flex h-full w-[380px] flex-col overflow-y-auto border-l border-[var(--p-border)] bg-[var(--p-card)] p-4"
          onclick={(e) => e.stopPropagation()}
        >
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-[var(--p-fg)]">群设置</h2>
            <button class="text-[var(--p-muted-fg)] hover:text-[var(--p-fg)]" aria-label="关闭" onclick={() => (groupSettingsOpen = false)}><X size={16} /></button>
          </div>

          <!-- 群名 + 头像 -->
          <div class="mb-4 flex items-center gap-3">
            <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[var(--p-secondary)] text-lg font-medium text-[var(--p-secondary-fg)]">
              {gd.name.slice(0, 1)}
            </div>
            <div class="flex-1">
              <input
                value={editName}
                disabled={!canManage}
                class="h-8 w-full rounded-md border border-[var(--p-border)] bg-[var(--p-bg)] px-2 text-sm text-[var(--p-fg)] disabled:opacity-60"
              />
            </div>
            {#if canManage}
              <button
                class="rounded-md border border-[var(--p-border)] px-2 py-1 text-xs text-[var(--p-muted-fg)] hover:text-[var(--p-fg)]"
                onclick={() => void saveGroupName()}
              >保存</button>
              <button
                class="rounded-md border border-[var(--p-border)] px-2 py-1 text-xs text-[var(--p-muted-fg)] hover:text-[var(--p-fg)]"
                title="上传群头像"
                onclick={() => groupAvatarInput?.click()}
              >头像</button>
              <input type="file" accept="image/*" class="hidden" bind:this={groupAvatarInput} onchange={uploadGroupAvatar} />
            {/if}
          </div>

          <!-- 群公告 -->
          <div class="mb-4">
            <p class="mb-1 text-xs font-medium text-[var(--p-muted-fg)]">群公告</p>
            <textarea
              bind:value={editAnnouncement}
              rows="3"
              disabled={!canManage}
              class="w-full resize-none rounded-md border border-[var(--p-border)] bg-[var(--p-bg)] px-2 py-1.5 text-sm text-[var(--p-fg)] disabled:opacity-60"
            ></textarea>
            {#if canManage}
              <button
                class="mt-1 rounded-md border border-[var(--p-border)] px-2 py-1 text-xs text-[var(--p-muted-fg)] hover:text-[var(--p-fg)]"
                onclick={() => void saveAnnouncement()}
              >发布公告</button>
            {/if}
          </div>

          <!-- 全员禁言 -->
          <div class="mb-4 flex items-center justify-between rounded-lg border border-[var(--p-border)] px-3 py-2">
            <span class="text-sm text-[var(--p-fg)]">全员禁言（仅管理员可发言）</span>
            {#if canManage}
              <input
                type="checkbox"
                checked={gd.muteAll}
                onchange={(e) => void chat.setMuteAll(gd.id, (e.currentTarget as HTMLInputElement).checked)}
              />
            {:else}
              <span class="text-xs text-[var(--p-muted-fg)]">{gd.muteAll ? "已开启" : "未开启"}</span>
            {/if}
          </div>

          <!-- 成员列表 -->
          <div class="mb-2 flex items-center justify-between">
            <p class="text-xs font-medium text-[var(--p-muted-fg)]">成员（{gd.members.length}）</p>
            {#if canManage}
              <button
                class="text-xs text-[var(--p-primary)] hover:underline"
                onclick={async () => {
                  inviteOpen = !inviteOpen;
                  if (inviteOpen) void chat.loadFriends();
                }}
              >+ 邀请</button>
            {/if}
          </div>
          {#if inviteOpen}
            <div class="mb-2 max-h-40 overflow-y-auto rounded-lg border border-[var(--p-border)] p-1">
              {#if chat.friends.length === 0}
                <p class="px-2 py-1 text-xs text-[var(--p-muted-fg)]">没有可邀请的好友</p>
              {:else}
                {#each chat.friends as friend (friend.user.id)}
                  {#if !gd.members.some((m) => m.user.id === friend.user.id)}
                    <button
                      class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--p-muted)]"
                      onclick={() => {
                        void chat.inviteMembers(gd.id, [friend.user.id]);
                        inviteOpen = false;
                      }}
                    >
                      <span class="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--p-secondary)] text-xs">{friend.user.nickname.slice(0, 1)}</span>
                      {friend.user.nickname}
                    </button>
                  {/if}
                {/each}
              {/if}
            </div>
          {/if}
          <div class="mb-4 space-y-1">
            {#each gd.members as member (member.user.id)}
              <div class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--p-muted)]/50">
                <span class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--p-secondary)] text-xs font-medium text-[var(--p-secondary-fg)]">{member.user.nickname.slice(0, 1)}</span>
                <span class="flex-1 truncate text-sm text-[var(--p-fg)]">{member.user.nickname}</span>
                {#if member.role !== 'member'}
                  <span class="rounded bg-[var(--p-primary-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--p-primary)]">{member.role === 'owner' ? '群主' : '管理员'}</span>
                {/if}
                <span class="h-2 w-2 rounded-full {member.online ? 'bg-green-500' : 'bg-[var(--p-border)]'}" title={member.online ? '在线' : '离线'}></span>
                {#if gd.myRole === 'owner' && member.role !== 'owner'}
                  <button class="text-xs text-[var(--p-primary)] hover:underline" title="转让群主"
                    onclick={() => void chat.transferOwner(gd.id, member.user.id)}>转让</button>
                {/if}
                {#if canManage && String(member.user.id) !== chat.myUserId && !(member.role === 'admin' && gd.myRole === 'admin')}
                  <button class="text-xs text-red-500 hover:underline" title="移出群聊"
                    onclick={() => void chat.kickMember(gd.id, member.user.id)}>移除</button>
                {/if}
              </div>
            {/each}
          </div>

          <!-- 退出 -->
          {#if gd.myRole !== 'owner'}
            <button
              class="mt-auto rounded-lg border border-red-300 py-2 text-sm font-medium text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
              onclick={() => void doLeave()}
            >退出群聊</button>
          {:else}
            <p class="mt-auto text-center text-xs text-[var(--p-muted-fg)]">群主需先转让群主后才能退出</p>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <div class="flex flex-1 items-center justify-center bg-[var(--p-muted)]/30">
      <div class="text-center">
        <div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--p-muted)]">
          <MessageSquare size={32} strokeWidth={1.5} class="text-[var(--p-muted-fg)]" />
        </div>
        <p class="text-[var(--p-muted-fg)]">
          {chat.sessions.length === 0 ? "左侧会话为空：点右上角「+」单聊或建群" : "选择一个对话开始聊天"}
        </p>
      </div>
    </div>
  {/if}
</div>
