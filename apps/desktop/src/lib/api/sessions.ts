/**
 * 会话与消息 API（/sessions/*）。全部接口需要登录（JWT）。
 *
 * 消息正文服务端按 WsChatMessage 契约返回（id/conversationId string 化）；
 * 本地持久化走 Tauri（src-tauri chat.rs），这里只负责与服务端交换数据。
 */
import type {
  CreateSessionInput,
  MessageHistoryPage,
  MessageReadAck,
  SessionSummary,
  WsChatMessage,
} from '@pigeon/shared-types';
import { http } from './http';

export const sessionsApi = {
  /** 会话列表（对端 + 在线状态 + 最后一条预览 + 未读数，按活跃时间倒序） */
  list: () => http.Get<SessionSummary[]>('/sessions'),

  /** 好友间建会话（幂等：重复调用返回既有会话） */
  createOrGet: (peerId: number) => http.Post<SessionSummary>('/sessions', { peerId } satisfies CreateSessionInput),

  /** 历史消息（keyset 游标分页：cursor = 上一页最早一条消息的 id） */
  history: (sessionId: string, cursor?: string, limit = 30) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return http.Get<MessageHistoryPage>(`/sessions/${sessionId}/messages?${query}`);
  },

  /** 标记会话已读（服务端同时把已读回执推给对端） */
  markRead: (sessionId: string) => http.Post<MessageReadAck>(`/sessions/${sessionId}/read`),
};

export type { SessionSummary, MessageHistoryPage, MessageReadAck, WsChatMessage };

/**
 * 服务端 timestamptz 字符串（如 `2026-08-31 16:13:26.170714+00`）→ Unix 毫秒。
 * PG 输出用空格分隔且时区只有两位小时，Date.parse 前先规范成 ISO。
 */
export function serverTimeToMs(value: string): number {
  const normalized = value.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}
