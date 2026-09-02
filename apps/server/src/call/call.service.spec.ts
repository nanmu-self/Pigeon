import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CallService, RING_TIMEOUT_MS } from './call.service.js';
import type { FriendsService } from '../friends/friends.service.js';
import type { WsEventsService } from '../ws/ws-events.service.js';

/** WsEventsService 测试替身：记录所有 toUser 推送 */
function fakeEvents(): WsEventsService & { pushed: Array<{ userId: string; event: string; payload: unknown }> } {
  const pushed: Array<{ userId: string; event: string; payload: unknown }> = [];
  return Object.assign(
    {
      toUser: (userId: string, event: never, payload: unknown) => pushed.push({ userId, event, payload }),
      isOnline: () => true,
    },
    { pushed },
  ) as never;
}

const friends = { assertFriends: vi.fn().mockResolvedValue(undefined) } as unknown as FriendsService;

describe('CallService', () => {
  let events: ReturnType<typeof fakeEvents>;
  let svc: CallService;

  beforeEach(() => {
    vi.useFakeTimers();
    events = fakeEvents();
    svc = new CallService(friends, events);
  });

  it('invite：好友校验 + 给被叫推 call:incoming', async () => {
    const res = await svc.invite(1, 'Alice', { targetUserId: '2', media: 'video' });
    expect(res.ringTimeoutMs).toBe(RING_TIMEOUT_MS);
    expect(friends.assertFriends).toHaveBeenCalledWith(1, 2);
    expect(events.pushed).toEqual([
      {
        userId: '2',
        event: 'call:incoming',
        payload: {
          callId: res.callId,
          fromUserId: '1',
          fromName: 'Alice',
          media: 'video',
          createdAt: expect.any(Number),
        },
      },
    ]);
  });

  it('非好友呼叫 → 403；呼叫自己 → 400；忙碌 → 403', async () => {
    (friends.assertFriends as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenException());
    await expect(svc.invite(1, 'A', { targetUserId: '2', media: 'audio' })).rejects.toThrow(ForbiddenException);
    await expect(svc.invite(1, 'A', { targetUserId: '1', media: 'audio' })).rejects.toThrow(BadRequestException);
    await svc.invite(1, 'A', { targetUserId: '2', media: 'audio' });
    await expect(svc.invite(3, 'C', { targetUserId: '2', media: 'audio' })).rejects.toThrow(/对方正在通话中/);
    await expect(svc.invite(1, 'A', { targetUserId: '3', media: 'audio' })).rejects.toThrow(/你正在通话中/);
  });

  it('完整链路：accept → webrtc:signal 互转 → hangup', async () => {
    const { callId } = await svc.invite(1, 'A', { targetUserId: '2', media: 'audio' });
    // 信令在接通前被拒
    expect(() => svc.signal(1, { callId, data: { type: 'offer', sdp: 'x' } })).toThrow(BadRequestException);
    expect(svc.accept(2, { callId })).toEqual({ callId });
    // 只有被叫可接、不能重复接
    expect(() => svc.accept(2, { callId })).toThrow(BadRequestException);
    svc.signal(1, { callId, data: { type: 'offer', sdp: 'v=0' } });
    svc.signal(2, { callId, data: { type: 'ice', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } } });
    svc.hangup(2, { callId });
    const signalFrames = events.pushed.filter((p) => p.event === 'webrtc:signal');
    expect(signalFrames.map((p) => p.userId)).toEqual(['2', '1']);
    expect(events.pushed.at(-1)).toEqual({ userId: '1', event: 'call:ended', payload: { callId, userId: '2' } });
    // 通话已结束：再操作报「不存在」
    expect(() => svc.hangup(1, { callId })).toThrow(BadRequestException);
  });

  it('reject / cancel / ring 超时 各自通知对端', async () => {
    const c1 = (await svc.invite(1, 'A', { targetUserId: '2', media: 'audio' })).callId;
    svc.reject(2, { callId: c1 });
    expect(events.pushed.at(-1)).toEqual({ userId: '1', event: 'call:rejected', payload: { callId: c1, userId: '2' } });

    const c2 = (await svc.invite(1, 'A', { targetUserId: '2', media: 'audio' })).callId;
    svc.cancel(1, { callId: c2 });
    expect(events.pushed.at(-1)!.event).toBe('call:cancelled');

    const c3 = (await svc.invite(1, 'A', { targetUserId: '2', media: 'audio' })).callId;
    vi.advanceTimersByTime(RING_TIMEOUT_MS + 1);
    const cancelled = events.pushed.filter((p) => p.event === 'call:cancelled' && (p.payload as { callId: string }).callId === c3);
    expect(cancelled.map((p) => p.userId).sort()).toEqual(['1', '2']);
    expect(new Set(cancelled.map((p) => (p.payload as { reason?: string }).reason))).toEqual(new Set(['missed']));
  });

  it('断线清理：接通后一方掉线 → 对端 call:ended', async () => {
    const { callId } = await svc.invite(1, 'A', { targetUserId: '2', media: 'audio' });
    svc.accept(2, { callId });
    svc.handleUserOffline(1);
    expect(events.pushed.at(-1)).toEqual({ userId: '2', event: 'call:ended', payload: { callId, userId: '1' } });
  });
});
