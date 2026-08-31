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
  clientMsgId: string | null;
  replyToId: number | null;
  recalledAt: string | null;
  createdAt: string;
}

/** Session 表行结构（Prisma 查询返回的字段） */
export interface SessionRow {
  id: number;
  userAId: number;
  userBId: number;
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
    ...(extras?.replyTo ? { replyTo: extras.replyTo } : {}),
    ...(extras?.reactions?.length ? { reactions: extras.reactions } : {}),
    ...(row.recalledAt ? { recalledAt: pgTimestampToMs(row.recalledAt) } : {}),
    createdAt: pgTimestampToMs(row.createdAt),
  };
}

/** 会话行 → 列表项（lastMessage/unreadCount/peer 由服务层查好后传入） */
export function toSessionSummary(
  row: SessionRow,
  meId: number,
  peer: PublicUser,
  peerOnline: boolean,
  unreadCount: number,
  lastMessage: WsChatMessage | null,
): SessionSummary {
  return {
    id: String(row.id),
    peer,
    peerOnline,
    unreadCount,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    ...(lastMessage ? { lastMessage } : {}),
  };
}
