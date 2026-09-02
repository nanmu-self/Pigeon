<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { chat } from "$lib/chat-store.svelte";
  import { friendsApi } from "$lib/api/friends";
  import { usersApi } from "$lib/api/users";
  import { ws } from "$lib/api/socket.svelte";
  import { showToast } from "$lib/toast";

  // ── Lucide 图标（官方推荐：子路径单独导入，tree-shakable） ──
  import UserPlus from "@lucide/svelte/icons/user-plus";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import Ban from "@lucide/svelte/icons/ban";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Search from "@lucide/svelte/icons/search";
  import type {
    FriendItem,
    FriendRequestItem,
    PublicUser,
    WsPresenceState,
  } from "@pigeon/shared-types";

  // ── 数据 ─────────────────────────────────────────────────
  let friends = $state<FriendItem[]>([]);
  let requests = $state<FriendRequestItem[]>([]);
  let blocked = $state<PublicUser[]>([]);
  let loading = $state(true);

  /** 添加好友：搜索结果 */
  let searchQuery = $state("");
  let searchResults = $state<PublicUser[]>([]);
  let searching = $state(false);
  /** 已发起申请的用户（本地标记，避免重复点击） */
  const requestedIds = $state(new Set<number>());
  /** 进行中的好友操作（userId/requestId → add/accept/decline），请求期间禁用按钮防连点 */
  const pendingOps = $state(new Set<string>());
  function isPending(op: string, id: number) {
    return pendingOps.has(`${op}:${id}`);
  }
  function setPending(op: string, id: number, on: boolean) {
    const key = `${op}:${id}`;
    if (on) pendingOps.add(key);
    else pendingOps.delete(key);
  }

  /** 选中的好友（右栏资料卡） */
  let selected = $state<FriendItem | null>(null);

  /** 发起群聊面板 */
  let groupPanelOpen = $state(false);
  let newGroupName = $state("");
  let pickedIds = $state<number[]>([]);
  let creatingGroup = $state(false);

  const incomingRequests = $derived(requests.filter((r) => r.direction === "incoming"));
  const outgoingRequests = $derived(requests.filter((r) => r.direction === "outgoing"));
  const filteredFriends = $derived(
    friends.filter((f) =>
      f.user.nickname.toLowerCase().includes(searchQuery.trim().toLowerCase()),
    ),
  );

  async function refresh() {
    try {
      [friends, requests, blocked] = await Promise.all([
        friendsApi.list(),
        friendsApi.requests(),
        friendsApi.listBlocked(),
      ]);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh();
    // WS 实时：收到申请 / 申请被通过 —— 保持列表鲜活
    const onFriendRequest = () => {
      showToast("收到新的好友申请", { type: "info" });
      void refresh();
    };
    const onFriendAccepted = () => void refresh();
    // presence 事件只 patch 命中的好友（含右栏资料卡的 selected 快照），
    // 非好友（如游客噪音、陌生人）直接忽略，避免全量刷新风暴
    const onPresence = (p: WsPresenceState) => {
      const userId = Number(p.userId);
      if (!Number.isInteger(userId)) return;
      let hit = false;
      friends = friends.map((f) => {
        if (f.user.id !== userId) return f;
        hit = true;
        return { ...f, online: p.online };
      });
      if (hit && selected?.user.id === userId) {
        selected = { ...selected, online: p.online };
      }
    };
    // 断线重连（含服务端重启）期间错过的上下线推送无法回放，重连即对账刷新
    const offConnected = ws.onConnected(() => void refresh());
    ws.on("friend:request", onFriendRequest);
    ws.on("friend:accepted", onFriendAccepted);
    ws.on("presence:update", onPresence);
    return () => {
      offConnected();
      ws.off("friend:request", onFriendRequest);
      ws.off("friend:accepted", onFriendAccepted);
      ws.off("presence:update", onPresence);
    };
  });

  // ── 搜索添加 ─────────────────────────────────────────────

  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    const q = searchQuery.trim();
    if (!q) {
      searchResults = [];
      return;
    }
    searchTimer = setTimeout(async () => {
      searching = true;
      try {
        searchResults = await usersApi.search(q);
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e));
      } finally {
        searching = false;
      }
    }, 300);
  }

  async function sendRequest(userId: number) {
    if (requestedIds.has(userId) || isPending("add", userId)) return;
    setPending("add", userId, true);
    try {
      await friendsApi.sendRequest(userId);
      requestedIds.add(userId);
      showToast("好友申请已发送", { type: "success" });
      void refresh(); // 若对方此前申请过我 → 服务端 409 时本地状态为准
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
      void refresh();
    } finally {
      setPending("add", userId, false);
    }
  }

  /** 搜索结果行的状态提示（已是好友 / 已申请 / 可申请） */
  function resultState(userId: number): { label: string; action: "add" | "chat" | "none" } {
    if (friends.some((f) => f.user.id === userId)) return { label: "发消息", action: "chat" };
    if (requestedIds.has(userId)) return { label: "已申请", action: "none" };
    if (requests.some((r) => r.direction === "outgoing" && r.user.id === userId)) {
      return { label: "已申请", action: "none" };
    }
    if (requests.some((r) => r.direction === "incoming" && r.user.id === userId)) {
      return { label: "对方已申请", action: "none" };
    }
    return { label: "加好友", action: "add" };
  }

  // ── 申请处理 ─────────────────────────────────────────────

  async function accept(requestId: number) {
    if (isPending("accept", requestId)) return;
    setPending("accept", requestId, true);
    try {
      await friendsApi.accept(requestId);
      showToast("已添加好友", { type: "success" });
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setPending("accept", requestId, false);
    }
  }

  async function decline(requestId: number) {
    if (isPending("decline", requestId)) return;
    setPending("decline", requestId, true);
    try {
      await friendsApi.decline(requestId);
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setPending("decline", requestId, false);
    }
  }

  // ── 好友操作 ─────────────────────────────────────────────

  async function startChat(userId: number) {
    try {
      await chat.createSession(userId);
      await goto("/messages");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeFriend(userId: number, nickname: string) {
    if (!confirm(`确定删除好友「${nickname}」吗？聊天记录将保留。`)) return;
    try {
      await friendsApi.remove(userId);
      showToast("已删除好友", { type: "success" });
      if (selected?.user.id === userId) selected = null;
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleBlock(userId: number, unblock: boolean) {
    try {
      if (unblock) await friendsApi.unblock(userId);
      else await friendsApi.block(userId);
      showToast(unblock ? "已解除拉黑" : "已拉黑", { type: "success" });
      selected = null; // 拉黑后好友从列表消失（解除入口在「已拉黑」区）
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  }

  // ── 建群 ─────────────────────────────────────────────────

  async function submitCreateGroup() {
    const name = newGroupName.trim();
    if (!name || pickedIds.length === 0) return;
    creatingGroup = true;
    try {
      await chat.createGroup(name, pickedIds);
      showToast("群聊已创建", { type: "success" });
      groupPanelOpen = false;
      newGroupName = "";
      pickedIds = [];
      await goto("/messages");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      creatingGroup = false;
    }
  }
</script>

<div class="flex h-full bg-[var(--p-bg)]">
  <!-- ══ 左栏：列表 ══════════════════════════════════════ -->
  <div class="flex w-96 shrink-0 flex-col border-r border-[var(--p-border)] bg-[var(--p-card)]">
    <div class="flex items-center justify-between border-b border-[var(--p-border)] px-4 py-3">
      <h1 class="text-xl font-semibold text-[var(--p-fg)]">通讯录</h1>
      <button
        class="rounded-full p-2 transition-colors hover:bg-[var(--p-muted)]"
        title="发起群聊"
        onclick={async () => {
          groupPanelOpen = !groupPanelOpen;
          if (groupPanelOpen) void chat.loadFriends();
        }}
      >
        <UserPlus size={18} class="text-[var(--p-muted-fg)]" />
      </button>
    </div>

    <!-- 发起群聊面板 -->
    {#if groupPanelOpen}
      <div class="border-b border-[var(--p-border)] bg-[var(--p-muted)]/40">
        <div class="px-3 pt-2">
          <input
            type="text"
            bind:value={newGroupName}
            placeholder="群名称"
            class="h-8 w-full rounded-md border border-[var(--p-border)] bg-[var(--p-bg)] px-2.5 text-xs text-[var(--p-fg)] placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-primary)] focus:outline-none"
          />
        </div>
        <div class="scroll-area-thin max-h-52 overflow-y-auto py-1">
          {#each friends as friend (friend.user.id)}
            <button
              class="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[var(--p-muted)]/60"
              onclick={() => {
                pickedIds = pickedIds.includes(friend.user.id)
                  ? pickedIds.filter((id) => id !== friend.user.id)
                  : [...pickedIds, friend.user.id];
              }}
            >
              <input type="checkbox" checked={pickedIds.includes(friend.user.id)} class="pointer-events-none" />
              <span class="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--p-secondary)] text-xs font-medium text-[var(--p-secondary-fg)]">{friend.user.nickname.slice(0, 1)}</span>
              <span class="flex-1 truncate text-sm text-[var(--p-fg)]">{friend.user.nickname}</span>
              {#if friend.online}<span class="h-2 w-2 rounded-full bg-green-500"></span>{/if}
            </button>
          {/each}
        </div>
        <div class="border-t border-[var(--p-border)] px-3 py-2">
          <button
            class="w-full rounded-md bg-[var(--p-primary)] py-1.5 text-xs font-medium text-[var(--p-primary-fg)] transition-opacity disabled:opacity-50"
            disabled={creatingGroup || !newGroupName.trim() || pickedIds.length === 0}
            onclick={() => void submitCreateGroup()}
          >
            {creatingGroup ? "创建中…" : `创建群聊（${pickedIds.length + 1} 人）`}
          </button>
        </div>
      </div>
    {/if}

    <div class="flex-1 overflow-y-auto">
      {#if loading}
        <p class="px-4 py-6 text-center text-sm text-[var(--p-muted-fg)]">加载中…</p>
      {:else}
        <!-- 好友申请 -->
        {#if incomingRequests.length > 0}
          <p class="px-4 pb-1 pt-4 text-xs font-medium text-[var(--p-muted-fg)]">
            好友申请（{incomingRequests.length}）
          </p>
          {#each incomingRequests as r (r.id)}
            <div class="flex items-center gap-3 px-4 py-2.5">
              <span class="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--p-secondary)] text-sm font-medium text-[var(--p-secondary-fg)]">{r.user.nickname.slice(0, 1)}</span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-[var(--p-fg)]">{r.user.nickname}</p>
                <p class="truncate text-xs text-[var(--p-muted-fg)]">{r.user.email}</p>
              </div>
              <button
                class="rounded-md bg-[var(--p-primary)] px-2.5 py-1 text-xs font-medium text-[var(--p-primary-fg)] transition-opacity disabled:opacity-50"
                disabled={isPending("accept", r.id)}
                onclick={() => void accept(r.id)}
              >通过</button>
              <button
                class="rounded-md border border-[var(--p-border)] px-2.5 py-1 text-xs text-[var(--p-muted-fg)] hover:text-[var(--p-fg)] transition-opacity disabled:opacity-50"
                disabled={isPending("decline", r.id)}
                onclick={() => void decline(r.id)}
              >拒绝</button>
            </div>
          {/each}
        {/if}

        <!-- 我的好友 -->
        <p class="px-4 pb-1 pt-4 text-xs font-medium text-[var(--p-muted-fg)]">
          我的好友（{friends.length}）
        </p>
        {#if friends.length === 0}
          <p class="px-4 py-6 text-center text-sm text-[var(--p-muted-fg)]">
            还没有好友，在右侧搜索添加
          </p>
        {:else}
          {#each filteredFriends as friend (friend.user.id)}
            <button
              class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--p-muted)]/50 {selected?.user.id === friend.user.id ? 'bg-[var(--p-muted)]/70' : ''}"
              onclick={() => (selected = selected?.user.id === friend.user.id ? null : friend)}
            >
              <div class="relative shrink-0">
                <span class="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--p-primary)] text-sm font-medium text-[var(--p-primary-fg)]">{friend.user.nickname.slice(0, 1)}</span>
                {#if friend.online}
                  <span class="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[var(--p-card)] bg-green-500"></span>
                {/if}
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-[var(--p-fg)]">{friend.user.nickname}</p>
                <p class="truncate text-xs text-[var(--p-muted-fg)]">{friend.online ? "在线" : "离线"}</p>
              </div>
            </button>
          {/each}
        {/if}

        <!-- 已拉黑（解除入口） -->
        {#if blocked.length > 0}
          <p class="px-4 pb-1 pt-4 text-xs font-medium text-[var(--p-muted-fg)]">
            已拉黑（{blocked.length}）
          </p>
          {#each blocked as user (user.id)}
            <div class="flex items-center gap-3 px-4 py-2 opacity-60">
              <span class="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--p-secondary)] text-sm font-medium text-[var(--p-secondary-fg)]">{user.nickname.slice(0, 1)}</span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-[var(--p-fg)]">{user.nickname}</p>
                <p class="text-xs text-[var(--p-muted-fg)]">对方无法向你发起会话与申请</p>
              </div>
              <button
                class="rounded-md border border-[var(--p-border)] px-2.5 py-1 text-xs text-[var(--p-muted-fg)] hover:text-[var(--p-fg)]"
                onclick={() => void toggleBlock(user.id, true)}
              >解除拉黑</button>
            </div>
          {/each}
        {/if}

        <!-- 发出的申请 -->
        {#if outgoingRequests.length > 0}
          <p class="px-4 pb-1 pt-4 text-xs font-medium text-[var(--p-muted-fg)]">
            已发出（等待对方处理）
          </p>
          {#each outgoingRequests as r (r.id)}
            <div class="flex items-center gap-3 px-4 py-2 opacity-60">
              <span class="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--p-secondary)] text-sm font-medium text-[var(--p-secondary-fg)]">{r.user.nickname.slice(0, 1)}</span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-[var(--p-fg)]">{r.user.nickname}</p>
                <p class="text-xs text-[var(--p-muted-fg)]">等待对方处理…</p>
              </div>
            </div>
          {/each}
        {/if}
      {/if}
    </div>
  </div>

  <!-- ══ 右栏：添加好友 / 好友资料 ══════════════════════ -->
  <div class="flex min-w-0 flex-1 flex-col overflow-y-auto bg-[var(--p-muted)]/30">
    {#if selected}
      <!-- 好友资料卡 -->
      <div class="mx-auto w-full max-w-md px-6 py-10">
        <div class="flex flex-col items-center">
          <div class="relative">
            <span class="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--p-primary)] text-2xl font-medium text-[var(--p-primary-fg)]">{selected.user.nickname.slice(0, 1)}</span>
            {#if selected.online}
              <span class="absolute bottom-1 right-1 h-4 w-4 rounded-full border-2 border-[var(--p-bg)] bg-green-500"></span>
            {/if}
          </div>
          <p class="mt-3 text-lg font-semibold text-[var(--p-fg)]">{selected.user.nickname}</p>
          <p class="text-sm text-[var(--p-muted-fg)]">{selected.user.email}</p>
          <p class="mt-1 text-xs text-[var(--p-muted-fg)]">{selected.online ? "在线" : "离线"} · 成为好友于 {selected.since.slice(0, 10)}</p>
        </div>

        <div class="mt-8 space-y-2">
          <button
            class="flex w-full items-center gap-3 rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] px-4 py-3 text-sm text-[var(--p-fg)] transition-colors hover:bg-[var(--p-muted)]"
            onclick={() => void startChat(selected!.user.id)}
          >
            <MessageSquare size={18} class="text-[var(--p-muted-fg)]" />
            发消息
          </button>
          <button
            class="flex w-full items-center gap-3 rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] px-4 py-3 text-sm text-[var(--p-fg)] transition-colors hover:bg-[var(--p-muted)]"
            onclick={() => {
              if (confirm(`确定拉黑「${selected!.user.nickname}」吗？解除入口在左侧「已拉黑」区。`)) {
                void toggleBlock(selected!.user.id, false);
              }
            }}
            title="拉黑后对方无法向你发起会话与申请"
          >
            <Ban size={18} class="text-[var(--p-muted-fg)]" />
            拉黑
          </button>
          <button
            class="flex w-full items-center gap-3 rounded-lg border border-red-200 bg-[var(--p-card)] px-4 py-3 text-sm text-red-500 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:hover:bg-red-900/20"
            onclick={() => void removeFriend(selected!.user.id, selected!.user.nickname)}
          >
            <Trash2 size={18} />
            删除好友
          </button>
        </div>
      </div>
    {:else}
      <!-- 添加好友面板 -->
      <div class="mx-auto w-full max-w-md px-6 py-10">
        <h2 class="mb-1 text-lg font-semibold text-[var(--p-fg)]">添加好友</h2>
        <p class="mb-4 text-sm text-[var(--p-muted-fg)]">按邮箱精确搜索，或按昵称模糊搜索</p>

        <div class="relative">
          <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--p-muted-fg)]" />
          <input
            type="text"
            bind:value={searchQuery}
            oninput={onSearchInput}
            placeholder="输入邮箱或昵称"
            class="h-10 w-full rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] pl-9 pr-3 text-sm text-[var(--p-fg)] placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-primary)] focus:outline-none"
          />
        </div>

        <div class="mt-4 space-y-2">
          {#if searching}
            <p class="py-4 text-center text-sm text-[var(--p-muted-fg)]">搜索中…</p>
          {:else if searchQuery.trim() && searchResults.length === 0}
            <p class="py-4 text-center text-sm text-[var(--p-muted-fg)]">没有找到匹配的用户</p>
          {:else}
            {#each searchResults as user (user.id)}
              {@const st = resultState(user.id)}
              <div class="flex items-center gap-3 rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] px-4 py-2.5">
                <span class="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--p-secondary)] text-sm font-medium text-[var(--p-secondary-fg)]">{user.nickname.slice(0, 1)}</span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-[var(--p-fg)]">{user.nickname}</p>
                  <p class="truncate text-xs text-[var(--p-muted-fg)]">{user.email}</p>
                </div>
                {#if st.action === "add"}
                  <button
                    class="rounded-md bg-[var(--p-primary)] px-3 py-1.5 text-xs font-medium text-[var(--p-primary-fg)] transition-opacity disabled:opacity-50"
                    disabled={isPending("add", user.id)}
                    onclick={() => void sendRequest(user.id)}
                  >{st.label}</button>
                {:else if st.action === "chat"}
                  <button
                    class="rounded-md border border-[var(--p-border)] px-3 py-1.5 text-xs text-[var(--p-fg)] hover:bg-[var(--p-muted)]"
                    onclick={() => void startChat(user.id)}
                  >{st.label}</button>
                {:else}
                  <span class="text-xs text-[var(--p-muted-fg)]">{st.label}</span>
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        {#if !searchQuery.trim()}
          <div class="mt-10 rounded-lg border border-dashed border-[var(--p-border)] p-4 text-sm text-[var(--p-muted-fg)]">
            <p class="font-medium">提示</p>
            <p class="mt-1 leading-relaxed">• 拉黑在好友资料卡中操作（拉黑后对方无法向你发起会话与申请）<br />• 收到好友申请时会实时出现在左侧「好友申请」区</p>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
