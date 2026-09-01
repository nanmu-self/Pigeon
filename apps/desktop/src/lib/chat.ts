/**
 * 本地聊天记录 API — 封装对 Tauri Rust 侧 SQLite commands 的调用。
 * 类型与 src-tauri/src/models.rs 保持一致（serde camelCase）。
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { MessageReactionSummary } from '@pigeon/shared-types';

/**
 * 本地库调用统一入口：把「旧 Rust 后端 + 新前端」的结构不匹配错误
 * （迁移嵌在二进制里，旧二进制不会执行新迁移）翻译成可操作的提示，
 * 而不是让 `no such column: xxx` 这种 SQLite 原文直接冒到 UI。
 */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    const text = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    if (/no such (column|table)/i.test(text)) {
      throw new Error(
        `本地数据库结构过旧（${text}）。请完全退出并重启应用，启动时会自动完成本地库迁移；若重启后仍复现，请更新/重新安装应用。`,
      );
    }
    throw e;
  }
}

export type ConversationKind = "direct" | "group";
export type MessageSender = "self" | "other" | "system";
export type MessageKind = "text" | "image" | "file" | "system";
export type MessageStatus = "sending" | "sent" | "delivered" | "failed" | "read";

export interface Conversation {
  id: number;
  kind: ConversationKind;
  name: string;
  peerId: string | null;
  /** 服务端会话 id（同步锚点） */
  serverSessionId: string | null;
  /** 对端已读水位（服务端消息 id） */
  peerReadMsgId: number | null;
  /** 对端送达水位（服务端消息 id） */
  peerDeliveredMsgId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LastMessage {
  id: number;
  sender: MessageSender;
  senderName: string;
  kind: MessageKind;
  content: string;
  createdAt: number;
}

export interface ConversationSummary extends Conversation {
  lastMessage: LastMessage | null;
  unreadCount: number;
}

/** 合并结果：inserted = false 表示本地已有（幂等跳过或占位行补全） */
export interface MergeResult {
  message: ChatMessage;
  inserted: boolean;
}

/** 服务端已落库消息的合并入参（对应 Rust ServerMessage） */
export interface ServerMessageInput {
  conversationId: number;
  serverMsgId: string;
  sender: MessageSender;
  senderName: string;
  kind: MessageKind;
  content: string;
  /** 服务端时间（Unix 毫秒）—— 本地排序的权威时间 */
  createdAt: number;
  clientMsgId?: string;
  /** 附加信息（JSON 字符串） */
  meta?: string;
  /** 被引用消息摘要（JSON 字符串） */
  replySummary?: string;
  /** 表情回应聚合（JSON 字符串） */
  reactions?: string;
  /** 服务端已撤回 */
  recalled?: boolean;
}

export interface ChatMessage {
  id: number;
  conversationId: number;
  sender: MessageSender;
  senderName: string;
  kind: MessageKind;
  content: string;
  status: MessageStatus;
  /** image/file 附加信息（JSON 字符串：fname/size/mime…）；文本消息为空 */
  meta: string | null;
  /** 服务端消息 id（同步后回填；引用回复需要它） */
  serverMsgId: string | null;
  /** 本机发送的占位键（重发/状态回填关联键；接收消息为空） */
  clientMsgId: string | null;
  /** 被引用消息摘要（JSON 字符串：{ id, senderName, kind, content }） */
  replySummary: string | null;
  /** 表情回应聚合（JSON 字符串：[ { emoji, userIds } ]） */
  reactions: string | null;
  /** 是否已撤回（content/meta 已清空，UI 渲染撤回占位） */
  recalled: boolean;
  /** Unix 毫秒时间戳 */
  createdAt: number;
}

export const chatApi = {
  listConversations: () =>
    invoke<ConversationSummary[]>("list_conversations"),

  createConversation: (name: string, kind: ConversationKind = "direct") =>
    invoke<Conversation>("create_conversation", { name, kind }),

  /** 确保存在与服务端会话关联的本地会话（无则创建，幂等） */
  ensureConversation: (serverSessionId: string, peerId: string, peerName: string) =>
    invoke<Conversation>("ensure_conversation", { serverSessionId, peerId, peerName }),

  /** 确保存在与服务端群会话关联的本地会话（无则创建，幂等） */
  ensureGroupConversation: (serverSessionId: string, groupName: string) =>
    invoke<Conversation>("ensure_group_conversation", { serverSessionId, groupName }),

  getMessages: (
    conversationId: number,
    limit?: number,
    beforeCreatedAt?: number,
    beforeId?: number,
  ) =>
    invoke<ChatMessage[]>("get_messages", {
      conversationId,
      limit,
      beforeCreatedAt,
      beforeId,
    }),

  /** optimistic 发送：先落 sending 占位行，ack 后 acknowledge 回填 */
  sendMessage: (
    conversationId: number,
    content: string,
    clientMsgId: string,
    kind: MessageKind = "text",
    meta?: string,
    replySummary?: string,
  ) =>
    invoke<ChatMessage>("send_message", {
      conversationId,
      content,
      clientMsgId,
      kind,
      meta,
      replySummary,
    }),

  /** 合并一条服务端消息（幂等：WS 推送 / 历史拉取共用） */
  upsertServerMessage: (message: ServerMessageInput) =>
    invoke<MergeResult>("upsert_server_message", { message }),

  /** ack 回填：占位行 → 服务端 id + 服务端时间 + sent */
  acknowledgeMessage: (clientMsgId: string, serverMsgId: string, createdAt: number) =>
    invoke<ChatMessage>("acknowledge_message", { clientMsgId, serverMsgId, createdAt }),

  markMessageFailed: (clientMsgId: string) =>
    invoke<void>("mark_message_failed", { clientMsgId }),

  /** 重试失败的消息：status 置回 sending（随后走正常 ack 回填） */
  retryMessage: (clientMsgId: string) =>
    invoke<void>("retry_message", { clientMsgId }),

  /** 本地应用撤回（按服务端消息 id，幂等）：清空内容/meta + 打撤回标记 */
  applyRecalled: (serverMsgId: string) =>
    invoke<boolean>("apply_recalled", { serverMsgId }),

  /** 推进对端已读/送达水位（只前进不后退）并物化己方消息状态 */
  setPeerWatermarks: (
    conversationId: number,
    readUpTo?: number,
    deliveredUpTo?: number,
  ) => invoke<void>("set_peer_watermarks", { conversationId, readUpTo, deliveredUpTo }),

  markRead: (conversationId: number) =>
    invoke<void>("mark_conversation_read", { conversationId }),

  deleteMessage: (messageId: number) =>
    invoke<void>("delete_message", { messageId }),

  deleteConversation: (conversationId: number) =>
    invoke<void>("delete_conversation", { conversationId }),

  clearHistory: (conversationId: number) =>
    invoke<void>("clear_history", { conversationId }),

  searchMessages: (conversationId: number, query: string, limit?: number) =>
    invoke<ChatMessage[]>("search_messages", { conversationId, query, limit }),
};

// ── 附件 ─────────────────────────────────────────────────────

/** 消息行 meta（JSON 字符串）安全解析 */
export function parseMessageMeta(meta: string | null): { fname?: string; size?: number; mime?: string } {
  if (!meta) return {};
  try {
    return JSON.parse(meta) as { fname?: string; size?: number; mime?: string };
  } catch {
    return {};
  }
}

/** 被引用消息摘要安全解析 */
export function parseReplySummary(
  replySummary: string | null,
): { id: string; senderName: string; kind: MessageKind; content: string } | null {
  if (!replySummary) return null;
  try {
    return JSON.parse(replySummary) as { id: string; senderName: string; kind: MessageKind; content: string };
  } catch {
    return null;
  }
}

/** 表情回应聚合安全解析 */
export function parseReactions(reactions: string | null): MessageReactionSummary[] {
  if (!reactions) return [];
  try {
    const raw = JSON.parse(reactions) as Array<{ emoji?: unknown; userIds?: unknown }>;
    return raw
      .filter((g) => typeof g.emoji === 'string' && Array.isArray(g.userIds))
      .map((g) => {
        const userIds = (g.userIds as unknown[]).filter((id): id is string => typeof id === 'string');
        return { emoji: g.emoji as string, userIds, count: userIds.length };
      });
  } catch {
    return [];
  }
}

/** 字节数可读化 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── 时间格式化 ───────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** 会话列表时间：今天 → HH:mm；昨天 → 昨天；今年 → M/D；更早 → YYYY/M/D */
export function formatConvTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 消息气泡时间：HH:mm */
export function formatMsgTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 聊天区分组头：今天 / 昨天 / M月D日 / YYYY年M月D日 */
export function formatDayDivider(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
