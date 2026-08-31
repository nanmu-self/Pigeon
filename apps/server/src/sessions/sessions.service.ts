import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  MessageHistoryPage,
  MessageReadAck,
  MessageReactionSummary,
  MessageReplySummary,
  PublicUser,
  SessionSummary,
  WsChatMessage,
} from '@pigeon/shared-types';
import { PrismaService } from '../prisma.service.js';
import { WsEventsService } from '../ws/ws-events.service.js';
import { toPublicUser } from '../users/user.mapper.js';
import { FriendsService } from '../friends/friends.service.js';
import {
  pgTimestampToMs,
  toChatMessage,
  toSessionSummary,
  type MessageRow,
  type SessionRow,
} from './sessions.mapper.js';

/** 发消息入参（WS message:send 事件的载荷，网关负责基础校验） */
export interface SendMessageParams {
  sessionId: number;
  senderId: number;
  senderName: string;
  content: string;
  kind: WsChatMessage['kind'];
  clientMsgId?: string;
  /** image/file 的附加信息（fname/size/mime…），服务端不解析透传存储 */
  meta?: Record<string, unknown>;
  /** 引用回复：被引用消息 id（必须同会话） */
  replyToId?: number;
}

/** meta 序列化后的字节上限 */
const MAX_META_LENGTH = 4096;

/** 文本消息长度上限（与网关 maxHttpBufferSize 1MB 拉开距离，防刷屏） */
const MAX_CONTENT_LENGTH = 4000;
/** 历史消息单页上限 */
const MAX_HISTORY_LIMIT = 100;
/** 撤回窗口：发送后 2 分钟内可撤回 */
const RECALL_WINDOW_MS = 2 * 60 * 1000;

/** PostgreSQL 唯一约束冲突（23505）：幂等写入路径用于吞掉重复插入 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { sqlState?: string }).sqlState === '23505'
  );
}

/**
 * 会话与消息服务。
 *
 * 职责：
 *  - 会话：好友间幂等建会话（get-or-create）、会话列表（对端 + 在线 + 最后一条 + 未读数）
 *  - 消息：事务落库（消息 + 接收者回实行 + 会话活跃指针）、游标分页历史
 *  - 已读：批量标记 + 已读水位，WS 推已读回执给对端
 *
 * 所有写路径的成员/好友校验都走 assertMember + FriendsService.assertFriends。
 */
@Injectable()
export class SessionsService {
  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（与全仓库约定一致）
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FriendsService) private readonly friends: FriendsService,
    @Inject(WsEventsService) private readonly ws: WsEventsService,
  ) {}

  private async sessionRow(id: number): Promise<SessionRow | null> {
    const row = await this.prisma.orm.public.Session.first({ id });
    return (row as SessionRow | null) ?? null;
  }

  private async publicUser(id: number): Promise<PublicUser> {
    const row = await this.prisma.orm.public.User.first({ id });
    if (!row) throw new NotFoundException('用户不存在');
    return toPublicUser(row);
  }

  /** 会话存在性 + 成员校验（任一不满足直接 404/403） */
  private async assertMember(sessionId: number, userId: number): Promise<SessionRow> {
    const row = await this.sessionRow(sessionId);
    if (!row) throw new NotFoundException('会话不存在');
    if (row.userAId !== userId && row.userBId !== userId) {
      throw new ForbiddenException('你不是该会话的成员');
    }
    return row;
  }

  // ── 会话 ─────────────────────────────────────────────────

  /** 好友间建会话（幂等：重复调用返回既有会话） */
  async createOrGet(meId: number, peerId: number): Promise<SessionSummary> {
    if (meId === peerId) throw new BadRequestException('不能和自己建会话');
    const peer = await this.publicUser(peerId); // 不存在 → 404
    await this.friends.assertFriends(meId, peerId); // 非好友/拉黑 → 403

    const [userAId, userBId] = [Math.min(meId, peerId), Math.max(meId, peerId)];
    let row = (await this.prisma.orm.public.Session.first({ userAId, userBId })) as SessionRow | null;
    row ??= (await this.prisma.orm.public.Session.create({ userAId, userBId })) as SessionRow;

    return toSessionSummary(row, meId, peer, this.ws.isOnline(String(peerId)), 0, null);
  }

  /** 我的会话列表：对端资料 + 在线状态 + 最后一条消息 + 未读数，按活跃时间倒序 */
  async list(meId: number): Promise<SessionSummary[]> {
    const [asA, asB, unread] = await Promise.all([
      this.prisma.orm.public.Session.where({ userAId: meId }).all(),
      this.prisma.orm.public.Session.where({ userBId: meId }).all(),
      // 一次查全所有未读回实行，内存按会话聚合（未读行数 = 未读消息数，规模可控）
      this.prisma.orm.public.MessageStatus.where({ userId: meId, readAt: null })
        .select('sessionId')
        .all() as unknown as Promise<Array<{ sessionId: number }>>,
    ]);
    const rows = [...asA, ...asB] as SessionRow[];
    if (rows.length === 0) return [];

    const unreadBySession = new Map<number, number>();
    for (const r of unread) {
      unreadBySession.set(r.sessionId, (unreadBySession.get(r.sessionId) ?? 0) + 1);
    }

    // 对端资料 + 最后一条消息（每会话一次点查；会话数少，N+1 可接受）
    const summaries = await Promise.all(
      rows.map(async (row) => {
        const peerId = row.userAId === meId ? row.userBId : row.userAId;
        const peer = await this.publicUser(peerId);
        const lastMessage = row.lastMessageId ? await this.messageById(row.lastMessageId) : null;
        return toSessionSummary(
          row,
          meId,
          peer,
          this.ws.isOnline(String(peerId)),
          unreadBySession.get(row.id) ?? 0,
          lastMessage,
        );
      }),
    );
    return summaries.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  /** 按 id 查消息行并带上发送者昵称 */
  private async messageById(id: number): Promise<WsChatMessage | null> {
    const row = (await this.prisma.orm.public.Message.first({ id })) as MessageRow | null;
    if (!row) return null;
    const senderName = row.senderId === null
      ? ''
      : (await this.prisma.orm.public.User.first({ id: row.senderId }))?.nickname ?? '';
    return toChatMessage(row, senderName);
  }

  // ── 消息 ─────────────────────────────────────────────────

  /**
   * 发消息（幂等）：事务内落消息 + fan-out 接收者回实行 + 更新会话活跃指针，
   * 然后向双方 user 房间推送 message:new（发送方的其他设备也会收到，
   * 客户端按消息 id 去重）。
   */
  async sendMessage(params: SendMessageParams): Promise<WsChatMessage> {
    const { sessionId, senderId, senderName, clientMsgId } = params;
    const content = params.content.trim();
    if (!content) throw new BadRequestException('消息内容不能为空');
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new BadRequestException(`消息长度不能超过 ${MAX_CONTENT_LENGTH} 字`);
    }
    if (params.kind === 'system') throw new BadRequestException('system 消息由服务端产生');

    // 引用回复校验：被引用消息必须存在且同会话；预取摘要内嵌进载荷（客户端免二次查询）
    let replyToId: number | undefined;
    let replySummary: MessageReplySummary | undefined;
    if (params.replyToId !== undefined) {
      if (!Number.isInteger(params.replyToId) || params.replyToId <= 0) {
        throw new BadRequestException('replyToId 非法');
      }
      const replyRow = (await this.prisma.orm.public.Message.first({ id: params.replyToId })) as MessageRow | null;
      if (!replyRow || replyRow.sessionId !== sessionId) {
        throw new BadRequestException('被引用的消息不存在');
      }
      replyToId = params.replyToId;
      replySummary = {
        id: String(replyRow.id),
        senderName: replyRow.senderId === null
          ? ''
          : (await this.prisma.orm.public.User.first({ id: replyRow.senderId }))?.nickname ?? '',
        kind: replyRow.kind,
        content: replyRow.content,
      };
    }

    // meta 校验：仅接受普通对象，序列化体积受限（服务端不解析字段语义）
    let meta: Record<string, unknown> | undefined;
    if (params.meta !== undefined) {
      if (typeof params.meta !== 'object' || params.meta === null || Array.isArray(params.meta)) {
        throw new BadRequestException('meta 必须是对象');
      }
      if (JSON.stringify(params.meta).length > MAX_META_LENGTH) {
        throw new BadRequestException('meta 过大');
      }
      meta = params.meta;
    }

    const session = await this.assertMember(sessionId, senderId);
    const peerId = session.userAId === senderId ? session.userBId : session.userAId;
    await this.friends.assertFriends(senderId, peerId);

    // 幂等：同 (senderId, clientMsgId) 已落库 → 原样返回（重试不重复落库/推送）
    if (clientMsgId) {
      const existing = (await this.prisma.orm.public.Message.first({
        senderId,
        clientMsgId,
      })) as MessageRow | null;
      if (existing) return toChatMessage(existing, senderName);
    }

    const message = await this.prisma.client.transaction(async (tx) => {
      const row = (await tx.orm.public.Message.create({
        sessionId,
        senderId,
        kind: params.kind,
        content,
        ...(clientMsgId ? { clientMsgId } : {}),
        // pg/json 编解码器要求 JsonValue：普通对象按结构兼容透传（字段值已是 JSON 安全类型）
        ...(meta ? { meta: meta as never } : {}),
        ...(replyToId !== undefined ? { replyToId } : {}),
      })) as MessageRow;

      // fan-out 已读回实行：直接单聊只有对端一个接收者（发送者不建行）；
      // 对端在线 → 推送随即到达其设备，直接记送达
      const delivered = this.ws.isOnline(String(peerId))
        ? new Date().toISOString()
        : null;
      await tx.orm.public.MessageStatus.create({
        messageId: row.id,
        userId: peerId,
        sessionId,
        ...(delivered ? { deliveredAt: delivered } : {}),
      });

      // 会话活跃指针 → 会话列表排序/预览
      await tx.orm.public.Session.where({ id: sessionId }).update({
        lastMessageId: row.id,
        lastMessageAt: row.createdAt,
      });
      return { row, delivered, peerId };
    });

    const chatMessage = toChatMessage(message.row, senderName, { replyTo: replySummary });
    this.ws.toUser(String(message.peerId), 'message:new', chatMessage);
    this.ws.toUser(String(senderId), 'message:new', chatMessage);

    // 已送达 → 给发送方推送达回执（客户端展示 已发送/已送达/已读）
    if (message.delivered) {
      this.ws.toUser(String(senderId), 'message:delivered', {
        conversationId: String(sessionId),
        userId: String(message.peerId),
        lastDeliveredMessageId: String(message.row.id),
        deliveredAt: pgTimestampToMs(message.delivered),
      });
    }
    return chatMessage;
  }

  /** 历史消息（游标分页）：按 id 倒序取 limit+1 条，正序返回 */
  async getHistory(
    meId: number,
    sessionId: number,
    cursor: number | null,
    limit: number,
  ): Promise<MessageHistoryPage> {
    const session = await this.assertMember(sessionId, meId);
    const take = Math.min(Math.max(limit, 1), MAX_HISTORY_LIMIT);

    const query = this.prisma.orm.public.Message
      .where({ sessionId })
      .orderBy((m) => m.id.desc());
    const bounded = cursor !== null
      ? (query as unknown as { cursor: (c: object) => typeof query }).cursor({ id: cursor })
      : query;
    const rows = (await bounded.limit(take + 1).all()) as MessageRow[];

    const hasMore = rows.length > take;
    const page = rows.slice(0, take).reverse(); // 线上按时间正序

    // 单聊固定两个成员，昵称查两次后走内存映射
    const [userA, userB] = await Promise.all([
      this.publicUser(session.userAId),
      this.publicUser(session.userBId),
    ]);
    const nameById = new Map<number, string>([
      [userA.id, userA.nickname],
      [userB.id, userB.nickname],
    ]);

    // 表情回应按页聚合（每消息一次索引点查，页 ≤100 条，可接受）
    const reactionMap = await this.reactionSummariesFor(page.map((r) => r.id));

    // 引用摘要：仅回复消息需要（有 replyToId 的行逐条取；被引用者必是会话成员，昵称走 nameById）
    const replyMap = new Map<number, MessageReplySummary>();
    for (const row of page) {
      if (row.replyToId == null) continue;
      const replyRow = (await this.prisma.orm.public.Message.first({ id: row.replyToId })) as MessageRow | null;
      if (!replyRow) continue;
      replyMap.set(row.id, {
        id: String(row.replyToId),
        senderName: nameById.get(replyRow.senderId ?? -1) ?? '',
        kind: replyRow.kind,
        content: replyRow.content,
      });
    }

    return {
      messages: page.map((row) =>
        toChatMessage(row, nameById.get(row.senderId ?? -1) ?? '', {
          reactions: reactionMap.get(row.id),
          replyTo: replyMap.get(row.id),
        }),
      ),
      hasMore,
      ...await this.peerWatermarks(session, meId),
    };
  }

  /** 聚合一页消息的表情回应（按 emoji 分组；复合主键保证每人每 emoji 至多一行） */
  private async reactionSummariesFor(
    messageIds: number[],
  ): Promise<Map<number, MessageReactionSummary[]>> {
    const lists = await Promise.all(
      messageIds.map((id) =>
        this.prisma.orm.public.MessageReaction
          .where({ messageId: id })
          .select('userId', 'emoji')
          .all() as unknown as Promise<Array<{ userId: number; emoji: string }>>,
      ),
    );
    const result = new Map<number, MessageReactionSummary[]>();
    messageIds.forEach((id, i) => {
      const grouped = new Map<string, string[]>();
      for (const r of lists[i]) {
        const userIds = grouped.get(r.emoji) ?? [];
        userIds.push(String(r.userId));
        grouped.set(r.emoji, userIds);
      }
      if (grouped.size > 0) {
        result.set(
          id,
          [...grouped.entries()].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds })),
        );
      }
    });
    return result;
  }

  // ── 表情回应 ──────────────────────────────────────────────

  /**
   * 添加表情回应（幂等：重复 add 静默成功），并向双方 user 房间广播增量更新。
   * 校验：操作者是会话成员 + 目标消息属于该会话。
   */
  async addReaction(userId: number, conversationId: number, messageId: number, emoji: string): Promise<void> {
    const emojiTrimmed = emoji.trim();
    if (!emojiTrimmed || emojiTrimmed.length > 32) throw new BadRequestException('emoji 非法');
    await this.assertMember(conversationId, userId);
    const message = (await this.prisma.orm.public.Message.first({ id: messageId })) as MessageRow | null;
    if (!message || message.sessionId !== conversationId) {
      throw new NotFoundException('消息不存在');
    }

    try {
      await this.prisma.orm.public.MessageReaction.create({
        messageId,
        userId,
        emoji: emojiTrimmed,
      });
    } catch (error) {
      // 复合主键冲突 = 已点过 → 幂等成功
      if (!isUniqueViolation(error)) throw error;
      return;
    }
    this.broadcastReaction(conversationId, messageId, emojiTrimmed, userId, 'add');
  }

  /** 移除表情回应（不存在则静默），并向双方广播增量更新 */
  async removeReaction(userId: number, conversationId: number, messageId: number, emoji: string): Promise<void> {
    const emojiTrimmed = emoji.trim();
    if (!emojiTrimmed) throw new BadRequestException('emoji 非法');
    await this.assertMember(conversationId, userId);

    const removed = await this.prisma.orm.public.MessageReaction
      .where({ messageId, userId, emoji: emojiTrimmed })
      .delete();
    if (!removed) return; // 本来就没有 → 静默
    this.broadcastReaction(conversationId, messageId, emojiTrimmed, userId, 'remove');
  }

  private broadcastReaction(
    conversationId: number,
    messageId: number,
    emoji: string,
    userId: number,
    action: 'add' | 'remove',
  ): void {
    // 需要通知双方（发送方 + 操作者的其他设备）：userA/userB 两个个人房间
    void this.sessionRow(conversationId).then((session) => {
      if (!session) return;
      const payload = {
        conversationId: String(conversationId),
        messageId: String(messageId),
        emoji,
        userId: String(userId),
        action,
      };
      this.ws.toUser(String(session.userAId), 'reaction:update', payload);
      this.ws.toUser(String(session.userBId), 'reaction:update', payload);
    });
  }

  // ── 撤回 ─────────────────────────────────────────────────

  /**
   * 撤回消息（2 分钟窗口内，仅发送者本人）：
   * 事务内清空 content/meta 并打 recalledAt 标记（行保留，排序/同步锚点不破坏），
   * 然后向双方 user 房间广播 message:recalled。
   */
  async recallMessage(userId: number, messageId: number): Promise<void> {
    const message = (await this.prisma.orm.public.Message.first({ id: messageId })) as (MessageRow & { recalledAt: string | null }) | null;
    if (!message) throw new NotFoundException('消息不存在');
    await this.assertMember(message.sessionId, userId);
    if (message.senderId !== userId) {
      throw new ForbiddenException('只能撤回自己发送的消息');
    }
    if (message.recalledAt) return; // 已撤回 → 幂等成功
    if (Date.now() - pgTimestampToMs(message.createdAt) > RECALL_WINDOW_MS) {
      throw new BadRequestException('超过 2 分钟的消息不能撤回');
    }

    const recalledAt = new Date().toISOString();
    await this.prisma.client.transaction(async (tx) => {
      await tx.orm.public.Message.where({ id: messageId }).update({
        recalledAt,
        content: '',
        meta: null,
      });
    });

    // 双方广播撤回通知
    const session = await this.sessionRow(message.sessionId);
    if (session) {
      const payload = {
        conversationId: String(message.sessionId),
        messageId: String(messageId),
        userId: String(userId),
        recalledAt: pgTimestampToMs(recalledAt),
      };
      this.ws.toUser(String(session.userAId), 'message:recalled', payload);
      this.ws.toUser(String(session.userBId), 'message:recalled', payload);
    }
  }

  /**
   * 对端已读/送达水位（单聊）：供打开会话时初始化本地渲染，
   * 之后由 message:read / message:delivered 实时推送维护。
   * 拉全量回实行在内存取最大值 —— 当前规模可接受；量大后换 SQL 聚合。
   */
  private async peerWatermarks(
    session: SessionRow,
    meId: number,
  ): Promise<{ peerReadUpTo?: string; peerDeliveredUpTo?: string }> {
    const peerId = session.userAId === meId ? session.userBId : session.userAId;
    const rows = (await this.prisma.orm.public.MessageStatus
      .where({ sessionId: session.id, userId: peerId })
      .select('messageId', 'readAt', 'deliveredAt')
      .all()) as Array<{ messageId: number; readAt: string | null; deliveredAt: string | null }>;

    let readUpTo: number | null = null;
    let deliveredUpTo: number | null = null;
    for (const r of rows) {
      if (r.readAt !== null && (readUpTo === null || r.messageId > readUpTo)) readUpTo = r.messageId;
      if (r.deliveredAt !== null && (deliveredUpTo === null || r.messageId > deliveredUpTo)) {
        deliveredUpTo = r.messageId;
      }
    }
    return {
      ...(readUpTo !== null ? { peerReadUpTo: String(readUpTo) } : {}),
      ...(deliveredUpTo !== null ? { peerDeliveredUpTo: String(deliveredUpTo) } : {}),
    };
  }

  // ── 已读回执 ─────────────────────────────────────────────

  /**
   * 标记会话已读（当前用户视角）：批量写 readAt + 计算已读水位，
   * 并向对端推送 message:read。
   *
   * 回实行只在接收者一侧存在（发送者不建行），因此这里天然只覆盖
   * 「我收到的消息」，不会污染我发出的消息的状态。
   */
  async markRead(meId: number, sessionId: number): Promise<MessageReadAck> {
    const session = await this.assertMember(sessionId, meId);
    const peerId = session.userAId === meId ? session.userBId : session.userAId;

    const readAt = new Date().toISOString();
    // 已读意味着必已送达 → 同步回填送达时间
    await this.prisma.orm.public.MessageStatus
      .where({ sessionId, userId: meId, readAt: null })
      .updateAll({ readAt, deliveredAt: readAt });

    // 本端已读锚点只推进所属一侧（配合 lastMessageAt 可判「有无新消息」）
    await this.prisma.orm.public.Session.where({ id: sessionId }).update(
      session.userAId === meId ? { lastReadAtA: readAt } : { lastReadAtB: readAt },
    );

    // 已读水位 = 会话最新一条消息（fan-out 保证每条消息我都有回实行）
    const latest = (await this.prisma.orm.public.Message
      .where({ sessionId })
      .orderBy((m) => m.id.desc())
      .first()) as MessageRow | null;

    const ack: MessageReadAck = {
      conversationId: String(sessionId),
      lastReadMessageId: latest ? String(latest.id) : '',
      readAt: pgTimestampToMs(readAt),
    };

    this.ws.toUser(String(peerId), 'message:read', {
      conversationId: ack.conversationId,
      userId: String(meId),
      lastReadMessageId: ack.lastReadMessageId,
      readAt: ack.readAt,
    });
    return ack;
  }
}
