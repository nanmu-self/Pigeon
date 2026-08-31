import { describe, expect, it } from 'vitest';
import { pgTimestampToMs, toChatMessage } from './sessions.mapper.js';

describe('pgTimestampToMs', () => {
  it('解析 PG timestamptz 字符串（空格分隔 + 两位时区）', () => {
    // 2026-08-31 16:13:26.170714+00 UTC
    expect(pgTimestampToMs('2026-08-31 16:13:26.170714+00')).toBe(
      Date.parse('2026-08-31T16:13:26.170714Z'),
    );
  });

  it('解析带非零时区偏移的字符串', () => {
    expect(pgTimestampToMs('2026-08-31 16:13:26.170714+08')).toBe(
      Date.parse('2026-08-31T16:13:26.170714+08:00'),
    );
  });

  it('已经是 ISO 格式的字符串直接可解析', () => {
    expect(pgTimestampToMs('2026-08-31T16:13:26.170Z')).toBe(
      Date.parse('2026-08-31T16:13:26.170Z'),
    );
  });

  it('非法输入返回 0 而不是 NaN', () => {
    expect(pgTimestampToMs('not-a-date')).toBe(0);
    expect(pgTimestampToMs('')).toBe(0);
  });
});

describe('toChatMessage', () => {
  it('id 全部 string 化，createdAt 转 Unix 毫秒（与 WsChatMessage 契约对齐）', () => {
    const row = {
      id: 42,
      sessionId: 7,
      senderId: 3,
      kind: 'text' as const,
      content: 'hello',
      meta: null,
      mentions: null,
      clientMsgId: null,
      replyToId: null,
      recalledAt: null,
      createdAt: '2026-08-31 16:13:26.170714+00',
    };
    const msg = toChatMessage(row, 'Alice');
    expect(msg).toEqual({
      id: '42',
      conversationId: '7',
      senderId: '3',
      senderName: 'Alice',
      kind: 'text',
      content: 'hello',
      meta: null,
      createdAt: Date.parse('2026-08-31T16:13:26.170714Z'),
    });
  });

  it('system 消息（无发送者）senderId 为空串、发送者昵称为空', () => {
    const row = {
      id: 1,
      sessionId: 2,
      senderId: null,
      kind: 'system' as const,
      content: '欢迎',
      meta: null,
      mentions: null,
      clientMsgId: null,
      replyToId: null,
      recalledAt: null,
      createdAt: '2026-08-31 16:13:26+00',
    };
    const msg = toChatMessage(row, '');
    expect(msg.senderId).toBe('');
    expect(msg.senderName).toBe('');
  });
});
