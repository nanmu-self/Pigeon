import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  EventPayload,
  RtRequest,
  RtResponse,
  RtPushFrame,
  ServerToClientEvents,
  WsChatMessage,
} from '@pigeon/shared-types';

/**
 * 协议一致性夹具（防两端漂移，见 docs/webtransport-migration-plan.md §4）：
 *
 * shared-types 是 type-only 包，Rust 无法共享类型。这里把 Nest/TS 侧
 * 序列化的载荷与 packages/shared-types/fixtures/rt-*.json 逐字段锁定；
 * Rust 侧单测（apps/transport-server/src/proto.rs）反序列化同一批夹具，
 * 两端夹具一致 = 协议一致。
 */

const fixtureDir = fileURLToPath(new URL('../../../../packages/shared-types/fixtures', import.meta.url));

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${fixtureDir}/${name}`, 'utf8')) as Record<string, unknown>;
}

/** 构造一个与夹具同构的类型化载荷（编译期约束到 ServerToClientEvents） */
function sampleChatMessage(): WsChatMessage {
  const payload: EventPayload<'message:new'> = {
    id: '1024',
    conversationId: '7',
    senderId: '1',
    senderName: 'Alice',
    kind: 'text',
    content: '你好，鸽子！',
    meta: null,
    replyTo: null,
    createdAt: 1735689600000,
  };
  return payload;
}

describe('协议夹具（TS → fixtures 对齐）', () => {
  it('message:new 载荷与夹具一致', () => {
    expect(JSON.parse(JSON.stringify(sampleChatMessage()))).toEqual(fixture('rt-message-new.json'));
  });

  it('message:read / message:delivered 载荷与夹具一致', () => {
    const read: EventPayload<'message:read'> = {
      conversationId: '7',
      userId: '2',
      lastReadMessageId: '1024',
      readAt: 1735689660000,
    };
    expect(JSON.parse(JSON.stringify(read))).toEqual(fixture('rt-message-read.json'));

    const delivered: EventPayload<'message:delivered'> = {
      conversationId: '7',
      userId: '2',
      lastDeliveredMessageId: '1024',
      deliveredAt: 1735689605000,
    };
    expect(JSON.parse(JSON.stringify(delivered))).toEqual(fixture('rt-message-delivered.json'));
  });

  it('reaction:update / message:recalled / group:updated 载荷与夹具一致', () => {
    const reaction: EventPayload<'reaction:update'> = {
      conversationId: '7',
      messageId: '1024',
      emoji: '👍',
      userId: '2',
      action: 'add',
    };
    expect(JSON.parse(JSON.stringify(reaction))).toEqual(fixture('rt-reaction-update.json'));

    const recalled: EventPayload<'message:recalled'> = {
      conversationId: '7',
      messageId: '1024',
      userId: '1',
      recalledAt: 1735689700000,
    };
    expect(JSON.parse(JSON.stringify(recalled))).toEqual(fixture('rt-message-recalled.json'));

    const group: EventPayload<'group:updated'> = { conversationId: '7' };
    expect(JSON.parse(JSON.stringify(group))).toEqual(fixture('rt-group-updated.json'));
  });

  it('presence:update / friend:request / friend:accepted 载荷与夹具一致', () => {
    const presence: EventPayload<'presence:update'> = {
      userId: '2',
      online: true,
      at: 1735689600000,
    };
    expect(JSON.parse(JSON.stringify(presence))).toEqual(fixture('rt-presence-update.json'));

    const friendRequest: EventPayload<'friend:request'> = {
      from: {
        id: 2,
        email: 'bob@pigeon.local',
        nickname: 'Bob',
        avatarUrl: 'https://cdn.example.com/avatar/2.png',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      createdAt: '2026-01-01T08:00:00.000Z',
    };
    expect(JSON.parse(JSON.stringify(friendRequest))).toEqual(fixture('rt-friend-request.json'));

    const friendAccepted: EventPayload<'friend:accepted'> = {
      user: {
        id: 2,
        email: 'bob@pigeon.local',
        nickname: 'Bob',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      since: '2026-01-01T08:05:00.000Z',
    };
    expect(JSON.parse(JSON.stringify(friendAccepted))).toEqual(fixture('rt-friend-accepted.json'));
  });

  it('RtRequest / RtResponse / RtPushFrame / hello / welcome 与夹具一致', () => {
    const request: RtRequest = {
      id: 42,
      type: 'message:send',
      payload: {
        conversationId: '7',
        content: '你好，鸽子！',
        kind: 'text',
        clientMsgId: '0b8f6c1e-6f5a-4a7d-9d3a-2f6f7a1c9b01',
      },
    };
    expect(JSON.parse(JSON.stringify(request))).toEqual(fixture('rt-request-message-send.json'));

    const ok: RtResponse = {
      id: 42,
      ok: true,
      data: sampleChatMessage(),
    };
    expect(JSON.parse(JSON.stringify(ok))).toEqual(fixture('rt-response-ok.json'));

    const err: RtResponse = { id: 42, ok: false, error: '你不是该会话的成员' };
    expect(JSON.parse(JSON.stringify(err))).toEqual(fixture('rt-response-error.json'));

    const push: RtPushFrame = {
      seq: 7,
      type: 'message:new' as keyof ServerToClientEvents,
      payload: sampleChatMessage(),
    };
    expect(JSON.parse(JSON.stringify(push))).toEqual(fixture('rt-push-frame.json'));

    expect(fixture('rt-hello.json')).toMatchObject({ v: 1, type: 'hello', clientProto: 1 });
    expect(fixture('rt-welcome.json')).toMatchObject({
      type: 'welcome',
      userId: '1',
      serverTime: 1735689600000,
    });
  });
});
