/**
 * 本地聊天记录 API — 封装对 Tauri Rust 侧 SQLite commands 的调用。
 * 类型与 src-tauri/src/models.rs 保持一致（serde camelCase）。
 */
import { invoke } from "@tauri-apps/api/core";

export type ConversationKind = "direct" | "group";
export type MessageSender = "self" | "other" | "system";
export type MessageKind = "text" | "image" | "file" | "system";
export type MessageStatus = "sending" | "sent" | "failed" | "read";

export interface Conversation {
  id: number;
  kind: ConversationKind;
  name: string;
  peerId: string | null;
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

export interface ChatMessage {
  id: number;
  conversationId: number;
  sender: MessageSender;
  senderName: string;
  kind: MessageKind;
  content: string;
  status: MessageStatus;
  /** Unix 毫秒时间戳 */
  createdAt: number;
}

export const chatApi = {
  listConversations: () =>
    invoke<ConversationSummary[]>("list_conversations"),

  createConversation: (name: string, kind: ConversationKind = "direct") =>
    invoke<Conversation>("create_conversation", { name, kind }),

  getMessages: (conversationId: number, limit?: number, beforeId?: number) =>
    invoke<ChatMessage[]>("get_messages", { conversationId, limit, beforeId }),

  sendMessage: (conversationId: number, content: string) =>
    invoke<ChatMessage>("send_message", { conversationId, content }),

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
