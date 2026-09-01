import type {
  MessageReactionSummary,
  MessageReplySummary,
  PublicUser,
  SessionSummary,
  WsChatMessage,
} from '@pigeon/shared-types';

/** Message 表行结构（Prisma 查询返回的字段） */
export interface MessageRow {
  id: number;
  sessionId: number;
  senderId: number | null;
  kind: 'text' | 'image' | 'file' | 'system';
  content: string;
  meta: unknown;
  mentions: unknown;
  clientMsgId: string | null;
  replyToId: number | null;
  recalledAt: string | null;
  createdAt: string;
}

/** Session 表行结构（Prisma 查询返回的字段） */
export interface SessionRow {
  id: number;
  kind: 'direct' | 'group';
  name: string | null;
  avatarUrl: string | null;
  announcement: string | null;
  announcementAt: string | null;
  announcementById: number | null;
  muteAll: boolean;
  userAId: number | null;
  userBId: number | null;
  lastMessageId: number | null;
  lastMessageAt: string;
  createdAt: string;
}

/**
 * PG timestamptz 字符串（如 `2026-08-31 16:13:26.170714+00`）→ Unix 毫秒。
 * PG 输出用空格分隔且时区只有两位小时（+00），Date.parse 前先规范成 ISO。
 */
export function pgTimestampToMs(value: string): number {
  const normalized = value.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}

/** 消息行 → 线上载荷（id 全部 string 化，与 WsChatMessage 契约对齐） */
export function toChatMessage(
  row: MessageRow,
  senderName: string,
  extras?: {
    replyTo?: MessageReplySummary | null;
    reactions?: MessageReactionSummary[];
  },
): WsChatMessage {
  return {
    id: String(row.id),
    conversationId: String(row.sessionId),
    senderId: row.senderId === null ? '' : String(row.senderId),
    senderName,
    kind: row.kind,
    content: row.content,
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    mentions: (row.mentions as string[] | null) ?? undefined,
    ...(extras?.replyTo ? { replyTo: extras.replyTo } : {}),
    ...(extras?.reactions?.length ? { reactions: extras.reactions } : {}),
    ...(row.recalledAt ? { recalledAt: pgTimestampToMs(row.recalledAt) } : {}),
    createdAt: pgTimestampToMs(row.createdAt),
  };
}

/** 会话行 → 列表项（peer/name/memberCount 等按会话类型由服务层传入） */
export function toSessionSummary(
  row: SessionRow,
  opts: {
    peer?: PublicUser;
    peerOnline?: boolean;
    name?: string;
    avatarUrl?: string;
    memberCount?: number;
    myRole?: 'owner' | 'admin' | 'member';
    muteAll?: boolean;
    unreadCount: number;
    lastMessage: WsChatMessage | null;
  },
): SessionSummary {
  return {
    id: String(row.id),
    kind: row.kind,
    ...(opts.peer ? { peer: opts.peer, peerOnline: opts.peerOnline ?? false } : {}),
    ...(opts.name !== undefined ? { name: opts.name, memberCount: opts.memberCount, myRole: opts.myRole, muteAll: opts.muteAll } : {}),
    ...(opts.avatarUrl ? { avatarUrl: opts.avatarUrl } : {}),
    unreadCount: opts.unreadCount,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    ...(opts.lastMessage ? { lastMessage: opts.lastMessage } : {}),
  };
}
