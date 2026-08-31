/**
 * 聊天状态中枢（Svelte 5 runes）。
 *
 * 数据流（三层）：
 *   服务端（REST /sessions + WS 推送）
 *     ⇅ 合并/水位/回执
 *   本地 SQLite（Tauri commands，src/lib/chat.ts）—— 会话内消息的权威来源
 *     ⇅ get_messages
 *   本 store（messages）—— UI 直接渲染
 *
 * 打开会话 = 「本地优先」：立即渲染 SQLite 里的消息，再异步拉取服务端
 * 最新一页合并入库（按 serverMsgId 幂等去重），然后重读本地刷新 UI。
 * 上滑加载更早 = 服务端游标分页 + 合并。
 *
 * 已读/送达：对端水位（serverMsgId ≤ 水位的己方消息为已读/已送达）
 * 由 WS message:read / message:delivered 实时推送维护，写入 SQLite 后
 * 重读本地即可，UI 不做任何状态推算。
 */
import type {
  FriendItem,
  SessionSummary,
  WsChatMessage,
  WsDeliveredReceipt,
  WsReadReceipt,
} from '@pigeon/shared-types';
import { chatApi, type ChatMessage, type Conversation } from '$lib/chat';
import { sessionsApi } from '$lib/api/sessions';
import { friendsApi } from '$lib/api/friends';
import { ws } from '$lib/api/socket.svelte';

/** 每次从服务端拉取的历史页大小 */
const HISTORY_PAGE_SIZE = 30;

export class ChatStore {
  /** 会话列表（服务端为源：未读数/在线状态/最后一条预览） */
  sessions = $state<SessionSummary[]>([]);
  sessionsLoading = $state(false);
  /** 好友列表（「新聊天」选择器用） */
  friends = $state<FriendItem[]>([]);

  /** 当前打开的会话 */
  current = $state<SessionSummary | null>(null);
  /** 当前会话的本地行（SQLite） */
  localConversation = $state<Conversation | null>(null);
  /** 当前会话消息（本地 SQLite，时间正序） */
  messages = $state<ChatMessage[]>([]);

  /** 服务端是否还有更早的历史（上滑加载按钮的显隐） */
  hasMoreHistory = $state(false);
  loadingOlder = $state(false);
  syncing = $state(false);
  error = $state<string | null>(null);

  /** 最近一次服务端拉取页的最早一条消息 id（上滑加载的游标） */
  private oldestFetchedServerId: string | null = null;

  // ── WS handler 注册（跨重连存活，见 SocketManager.handlerList） ──

  initWsHandlers(): void {
    ws.on('message:new', (m) => void this.onNewMessage(m));
    ws.on('message:read', (r) => void this.onReadReceipt(r));
    ws.on('message:delivered', (r) => void this.onDeliveredReceipt(r));
    ws.on('presence:update', (p) => this.onPresence(p.userId, p.online));
  }

  // ── 会话列表 ─────────────────────────────────────────────

  async loadSessions(): Promise<void> {
    this.sessionsLoading = true;
    try {
      this.sessions = await sessionsApi.list();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.sessionsLoading = false;
    }
  }

  /** 好友列表（「新聊天」选择器） */
  async loadFriends(): Promise<void> {
    this.friends = await friendsApi.list();
  }

  /** 创建（或打开既有）与好友的会话，并直接打开 */
  async createSession(peerId: number): Promise<void> {
    const session = await sessionsApi.createOrGet(peerId);
    await this.loadSessions();
    await this.openSession(session);
  }

  // ── 打开会话（本地优先 → 异步合并 → 标记已读） ───────────

  async openSession(session: SessionSummary): Promise<void> {
    this.current = session;
    this.messages = [];
    this.hasMoreHistory = false;
    this.oldestFetchedServerId = null;

    // 1. 本地会话（幂等创建）+ 立即渲染本地已有消息
    this.localConversation = await chatApi.ensureConversation(
      session.id,
      String(session.peer.id),
      session.peer.nickname,
    );
    this.messages = await chatApi.getMessages(this.localConversation.id, HISTORY_PAGE_SIZE);

    // 2. 异步拉服务端最新一页合并
    await this.syncLatest();

    // 3. 标记已读（本地未读清零 + 服务端推回执给对端）
    await this.markCurrentRead();
  }

  /** 拉取服务端最新一页并合并入库，然后重读本地 */
  private async syncLatest(): Promise<void> {
    if (!this.current) return;
    this.syncing = true;
    try {
      const page = await sessionsApi.history(this.current.id, undefined, HISTORY_PAGE_SIZE);

      // 对端水位先落库，合并的己方消息才能推导出正确的初始状态
      await this.applyWatermarks(page.peerReadUpTo, page.peerDeliveredUpTo);
      await this.mergePage(page.messages);

      await this.reloadLocal();
      this.hasMoreHistory = page.hasMore;
      this.oldestFetchedServerId = page.messages[0]?.id ?? this.oldestFetchedServerId;
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.syncing = false;
    }
  }

  /** 上滑加载更早的历史（服务端游标分页 + 合并） */
  async loadOlder(): Promise<void> {
    if (!this.current || !this.hasMoreHistory || this.loadingOlder) return;
    if (!this.oldestFetchedServerId) return; // 还没从服务端同步过
    this.loadingOlder = true;
    try {
      const page = await sessionsApi.history(
        this.current.id,
        this.oldestFetchedServerId,
        HISTORY_PAGE_SIZE,
      );
      await this.mergePage(page.messages);
      await this.reloadLocal();
      this.hasMoreHistory = page.hasMore;
      this.oldestFetchedServerId = page.messages[0]?.id ?? this.oldestFetchedServerId;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loadingOlder = false;
    }
  }

  /** 批量合并一页消息（幂等，去重由 SQLite server_msg_id 唯一索引兜底） */
  private async mergePage(messages: WsChatMessage[]): Promise<void> {
    const conv = this.localConversation;
    if (!conv) return;
    for (const m of messages) {
      await chatApi.upsertServerMessage({
        conversationId: conv.id,
        serverMsgId: m.id,
        sender: m.senderId === String(this.current?.peer.id) ? 'other' : 'self',
        senderName: m.senderName,
        kind: m.kind,
        content: m.content,
        createdAt: m.createdAt,
      });
    }
  }

  // ── 发送（optimistic → WS ack → 回填 / 失败标记） ────────

  async send(content: string): Promise<void> {
    const text = content.trim();
    if (!text || !this.current || !this.localConversation) return;

    const clientMsgId = crypto.randomUUID();
    // 1. optimistic：立即落 sending 占位行并上屏
    const staged = await chatApi.sendMessage(this.localConversation.id, text, clientMsgId);
    this.messages = [...this.messages, staged];

    await this.dispatch(clientMsgId, text);
  }

  /** WS 发送；ack 后回填服务端 id/时间 → sent；失败置 failed */
  private async dispatch(clientMsgId: string, text: string): Promise<void> {
    if (!this.current) return;
    try {
      const ack = await ws.sendMessage(this.current.id, text, 'text', clientMsgId);
      const confirmed = await chatApi.acknowledgeMessage(clientMsgId, ack.id, ack.createdAt);
      this.replaceLocal(confirmed);
      this.error = null;
    } catch (e) {
      // 失败：标记 failed（保留 clientMsgId，可原样重发，服务端幂等）
      await chatApi.markMessageFailed(clientMsgId);
      this.patchStatus(clientMsgId, 'failed');
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** 重发失败的消息：沿用原 clientMsgId，服务端幂等不会产生重复 */
  async resend(msg: ChatMessage): Promise<void> {
    if (!msg.clientMsgId) return;
    await chatApi.retryMessage(msg.clientMsgId);
    this.patchStatus(msg.clientMsgId, 'sending');
    await this.dispatch(msg.clientMsgId, msg.content);
  }

  // ── 已读 ─────────────────────────────────────────────────

  /** 打开会话 / 收到新消息时调用：本地未读清零 + 服务端推回执给对端 */
  async markCurrentRead(): Promise<void> {
    if (!this.current || !this.localConversation) return;
    await chatApi.markRead(this.localConversation.id);
    // 服务端未读数清零（本地乐观更新，失败下次拉取会纠正）
    this.sessions = this.sessions.map((s) =>
      s.id === this.current?.id ? { ...s, unreadCount: 0 } : s,
    );
    await ws.markRead(this.current.id).catch(() => {});
  }

  // ── WS 事件处理 ──────────────────────────────────────────

  private async onNewMessage(m: WsChatMessage): Promise<void> {
    // 会话列表未加载时无法定位对端 → 先拉一次（首次推送/冷启动场景）
    let session = this.sessions.find((s) => s.id === m.conversationId);
    if (!session) {
      await this.loadSessions();
      session = this.sessions.find((s) => s.id === m.conversationId);
    }
    if (!session) return; // 列表里也没有（非本账号会话）→ 不落本地

    // 合并入本地 SQLite（当前会话之外的推送也落库，打开时即可本地优先渲染）
    const isFromPeer = String(session.peer.id) === m.senderId;
    const conv = await chatApi.ensureConversation(
      m.conversationId,
      String(session.peer.id),
      session.peer.nickname,
    );
    const { message, inserted } = await chatApi.upsertServerMessage({
      conversationId: conv.id,
      serverMsgId: m.id,
      sender: isFromPeer ? 'other' : 'self',
      senderName: m.senderName,
      kind: m.kind,
      content: m.content,
      createdAt: m.createdAt,
    });

    if (this.current?.id === m.conversationId) {
      if (inserted && !this.messages.some((x) => x.id === message.id)) {
        this.messages = [...this.messages, message];
      }
      // 会话正开着 → 立即回执已读
      await this.markCurrentRead();
    }
    // 刷新列表（未读数/预览/排序）
    void this.loadSessions();
  }

  private async onReadReceipt(r: WsReadReceipt): Promise<void> {
    if (this.current?.id !== r.conversationId || !this.localConversation) return;
    await chatApi.setPeerWatermarks(this.localConversation.id, Number(r.lastReadMessageId), undefined);
    await this.reloadLocal();
  }

  private async onDeliveredReceipt(r: WsDeliveredReceipt): Promise<void> {
    if (this.current?.id !== r.conversationId || !this.localConversation) return;
    await chatApi.setPeerWatermarks(this.localConversation.id, undefined, Number(r.lastDeliveredMessageId));
    await this.reloadLocal();
  }

  private onPresence(userId: string, online: boolean): void {
    this.sessions = this.sessions.map((s) =>
      s.peer.id === Number(userId) ? { ...s, peerOnline: online } : s,
    );
  }

  // ── 内部 ─────────────────────────────────────────────────

  private async applyWatermarks(read?: string, delivered?: string): Promise<void> {
    if (!this.localConversation) return;
    if (read === undefined && delivered === undefined) return;
    await chatApi.setPeerWatermarks(
      this.localConversation.id,
      read !== undefined ? Number(read) : undefined,
      delivered !== undefined ? Number(delivered) : undefined,
    );
  }

  private async reloadLocal(): Promise<void> {
    if (!this.localConversation) return;
    this.messages = await chatApi.getMessages(this.localConversation.id, HISTORY_PAGE_SIZE);
  }

  private replaceLocal(updated: ChatMessage): void {
    this.messages = this.messages.map((m) => (m.id === updated.id ? updated : m));
  }

  private patchStatus(clientMsgId: string, status: ChatMessage['status']): void {
    this.messages = this.messages.map((m) =>
      m.clientMsgId === clientMsgId ? { ...m, status } : m,
    );
  }
}

export const chat = new ChatStore();
