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
  MessageReactionSummary,
  SessionSummary,
  WsChatMessage,
  WsDeliveredReceipt,
  WsReactionUpdate,
  WsReadReceipt,
} from '@pigeon/shared-types';
import {
  chatApi,
  parseReactions,
  parseReplySummary,
  type ChatMessage,
  type Conversation,
  type MessageKind,
} from '$lib/chat';
import { sessionsApi } from '$lib/api/sessions';
import { friendsApi } from '$lib/api/friends';
import { ws } from '$lib/api/socket.svelte';
import { uploadToQiniu, isUploadCanceled } from '$lib/upload/qiniu';

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
  /** 进行中的七牛上传（输入区进度条；null = 无进行中上传） */
  uploadProgress = $state<{ fname: string; percent: number } | null>(null);
  /** 正在回复的消息（输入区上方预览条；null = 非回复） */
  replyTo = $state<ChatMessage | null>(null);

  /** 我在服务端的用户 id（WS 握手分配；表情回应高亮判断用） */
  get myUserId(): string {
    return ws.userId;
  }

  /** 最近一次服务端拉取页的最早一条消息 id（上滑加载的游标） */
  private oldestFetchedServerId: string | null = null;

  // ── WS handler 注册（跨重连存活，见 SocketManager.handlerList） ──

  initWsHandlers(): void {
    ws.on('message:new', (m) => void this.onNewMessage(m));
    ws.on('message:read', (r) => void this.onReadReceipt(r));
    ws.on('message:delivered', (r) => void this.onDeliveredReceipt(r));
    ws.on('reaction:update', (r) => this.onReactionUpdate(r));
    ws.on('presence:update', (p) => this.onPresence(p.userId, p.online));
  }

  /** 表情回应增量更新：直接改本地行的 reactions JSON */
  private onReactionUpdate(r: WsReactionUpdate): void {
    if (this.current?.id !== r.conversationId) return;
    const target = this.messages.find((m) => m.serverMsgId === r.messageId);
    if (!target) return;
    const groups = parseReactions(target.reactions);
    const g = groups.find((x) => x.emoji === r.emoji);
    if (r.action === 'add') {
      if (g) {
        if (!g.userIds.includes(r.userId)) g.userIds.push(r.userId);
      } else {
        groups.push({ emoji: r.emoji, userIds: [r.userId], count: 1 });
      }
    } else if (g) {
      g.userIds = g.userIds.filter((id) => id !== r.userId);
    }
    const next = groups.filter((x) => x.userIds.length > 0);
    this.patchReactions(target.id, next);
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
        meta: m.meta ? JSON.stringify(m.meta) : undefined,
        replySummary: m.replyTo ? JSON.stringify(m.replyTo) : undefined,
        reactions: m.reactions?.length ? JSON.stringify(m.reactions) : undefined,
      });
    }
  }

  // ── 发送（optimistic → WS ack → 回填 / 失败标记） ────────

  async send(content: string): Promise<void> {
    const text = content.trim();
    if (!text || !this.current || !this.localConversation) return;

    // 引用回复：带上被引用消息的服务端 id + 本地摘要
    const replyMsg = this.replyTo;
    let replySummary: string | undefined;
    let replyToId: string | undefined;
    if (replyMsg?.serverMsgId) {
      replyToId = replyMsg.serverMsgId;
      replySummary = JSON.stringify({
        id: replyMsg.serverMsgId,
        senderName: replyMsg.senderName || (replyMsg.sender === 'self' ? '我' : this.current.peer.nickname),
        kind: replyMsg.kind,
        content: replyMsg.content,
      });
    }
    this.replyTo = null;
    await this.stageAndSend('text', text, undefined, undefined, replySummary, replyToId);
  }

  cancelReply(): void {
    this.replyTo = null;
  }

  /** 表情回应 toggle：已点 → remove；未点 → add（本地乐观更新，失败重读本地） */
  async toggleReaction(msg: ChatMessage, emoji: string): Promise<void> {
    if (!this.current) return;
    const myId = ws.userId;
    const groups = parseReactions(msg.reactions);
    const g = groups.find((x) => x.emoji === emoji);
    const mine = g !== undefined && g.userIds.includes(myId);

    // 本地乐观更新
    if (g && mine) {
      const next: MessageReactionSummary = {
        ...g,
        userIds: g.userIds.filter((id) => id !== myId),
        count: g.count - 1,
      };
      this.patchReactions(
        msg.id,
        next.userIds.length > 0
          ? groups.map((x) => (x === g ? next : x))
          : groups.filter((x) => x !== g),
      );
    } else if (g) {
      this.patchReactions(
        msg.id,
        groups.map((x) => (x === g ? { ...x, userIds: [...x.userIds, myId], count: x.count + 1 } : x)),
      );
    } else {
      this.patchReactions(msg.id, [...groups, { emoji, userIds: [myId], count: 1 }]);
    }

    try {
      const payload = { conversationId: this.current.id, messageId: msg.serverMsgId ?? '', emoji };
      const res = mine
        ? await ws.rawEmitAck('reaction:remove', payload)
        : await ws.rawEmitAck('reaction:add', payload);
      if (!res.ok) throw new Error(res.error);
    } catch {
      await this.reloadLocal(); // 失败回读本地（乐观更新回滚）
    }
  }

  private patchReactions(messageId: number, groups: MessageReactionSummary[]): void {
    this.messages = this.messages.map((m) =>
      m.id === messageId ? { ...m, reactions: groups.length ? JSON.stringify(groups) : null } : m,
    );
  }

  /**
   * 发送图片/文件消息：先直传七牛（dir=chat），完成后按
   * content=url、meta={fname,size,mime} 走正常发送链路。
   * 进度实时写入 uploadProgress；可取消（取消不产生任何消息）。
   */
  async sendAttachment(file: File): Promise<void> {
    if (!this.current || !this.localConversation) return;
    const kind: MessageKind = file.type.startsWith('image/') ? 'image' : 'file';
    const meta = {
      fname: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
    };
    const clientMsgId = crypto.randomUUID();

    this.uploadProgress = { fname: file.name, percent: 0 };
    const handle = uploadToQiniu(file, {
      dir: 'chat',
      fileName: file.name,
      onProgress: (p) => {
        this.uploadProgress = { fname: file.name, percent: p.percent };
      },
    });
    this.activeUpload = { clientMsgId, cancel: () => handle.cancel() };

    try {
      const up = await handle.done;
      this.uploadProgress = null;
      await this.stageAndSend(kind, up.url, meta, clientMsgId);
      this.error = null;
    } catch (e) {
      this.uploadProgress = null;
      // 用户主动取消：静默（不产生消息）；真错误才提示
      if (!isUploadCanceled(e)) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      this.activeUpload = null;
    }
  }

  cancelUpload(): void {
    this.activeUpload?.cancel();
  }

  private activeUpload: { clientMsgId: string; cancel: () => void } | null = null;

  /** 落 sending 占位行并走 WS 发送链路 */
  private async stageAndSend(
    kind: MessageKind,
    content: string,
    meta?: Record<string, unknown>,
    clientMsgId: string = crypto.randomUUID(),
    replySummary?: string,
    replyToId?: string,
  ): Promise<void> {
    if (!this.current || !this.localConversation) return;
    const staged = await chatApi.sendMessage(
      this.localConversation.id,
      content,
      clientMsgId,
      kind,
      meta ? JSON.stringify(meta) : undefined,
      replySummary,
    );
    this.messages = [...this.messages, staged];
    await this.dispatch(clientMsgId, content, kind, meta, replyToId);
  }

  /** WS 发送；ack 后回填服务端 id/时间 → sent；失败置 failed */
  private async dispatch(
    clientMsgId: string,
    content: string,
    kind: MessageKind,
    meta?: Record<string, unknown>,
    replyToId?: string,
  ): Promise<void> {
    const current = this.current;
    if (!current) return;
    try {
      const ack = await ws.sendMessage(current.id, content, kind, clientMsgId, replyToId);
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
    let meta: Record<string, unknown> | undefined;
    if (msg.meta) {
      try {
        meta = JSON.parse(msg.meta) as Record<string, unknown>;
      } catch {
        meta = undefined;
      }
    }
    await this.dispatch(msg.clientMsgId, msg.content, msg.kind, meta);
  }

  // ── 已读 ─────────────────────────────────────────────────

  /** 打开会话 / 收到新消息时调用：本地未读清零 + 服务端推回执给对端。
   *  WS 不可用时降级走 REST（否则红点清不掉）。 */
  async markCurrentRead(): Promise<void> {
    const current = this.current;
    if (!current || !this.localConversation) return;
    await chatApi.markRead(this.localConversation.id);
    // 服务端未读数清零（本地乐观更新，失败下次拉取会纠正）
    this.sessions = this.sessions.map((s) =>
      s.id === current.id ? { ...s, unreadCount: 0 } : s,
    );
    try {
      await ws.markRead(current.id);
    } catch {
      await sessionsApi.markRead(current.id).catch(() => {});
    }
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
      meta: m.meta ? JSON.stringify(m.meta) : undefined,
      replySummary: m.replyTo ? JSON.stringify(m.replyTo) : undefined,
      reactions: m.reactions?.length ? JSON.stringify(m.reactions) : undefined,
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
