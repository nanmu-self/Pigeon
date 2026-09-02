import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CallMedia, CallSignal, WsCallIncoming } from '@pigeon/shared-types';
import { FriendsService } from '../friends/friends.service.js';
import { WsEventsService } from '../ws/ws-events.service.js';

/**
 * 音视频通话信令中枢（1:1）。
 *
 * 职责：好友校验 + 忙碌判定 + 通话登记（纯内存，不落库）+ 双向转发。
 * - 信令（SDP/ICE）不解析只转发：媒体走 WebRTC P2P，服务器只牵线；
 * - 通话结束即丢记录，Redis 路由表 / 跨节点投递由传输层后续演进；
 * - 推送一律注入 WsEventsService token（socket/wt 双轨零改动，见 AGENTS.md §12）。
 *
 * 状态机：ringing → active → ended（ended 后从注册表删除）。
 * 振铃超时（RING_TIMEOUT_MS）由服务端定时器兜底：双方各推 cancelled(missed)。
 */

/** 振铃超时（对方无应答自动取消） */
export const RING_TIMEOUT_MS = 45_000;

interface CallEntry {
  callId: string;
  callerId: number;
  callerName: string;
  calleeId: number;
  media: CallMedia;
  state: 'ringing' | 'active';
  createdAt: number;
  ringTimer: NodeJS.Timeout | null;
}

/** webrtc:signal 载荷（结构性校验 + 尺寸上限，防内部通道被塞大 payload） */
const MAX_SIGNAL_BYTES = 64 * 1024;

@Injectable()
export class CallService {
  private readonly logger = new Logger(CallService.name);
  /** callId → 通话（ended 即删；量级 = 并发通话数，内存扫描可接受） */
  private readonly calls = new Map<string, CallEntry>();

  constructor(
    // swc 编译无装饰器元数据，注入一律显式 @Inject（仓库约定）
    @Inject(FriendsService) private readonly friends: FriendsService,
    @Inject(WsEventsService) private readonly events: WsEventsService,
  ) {}

  /** 某用户是否有未结束的通话（忙碌判定：1:1 通话一人一路） */
  private activeCallOf(userId: number): CallEntry | undefined {
    for (const call of this.calls.values()) {
      if (call.callerId === userId || call.calleeId === userId) {
        return call;
      }
    }
    return undefined;
  }

  private endCall(call: CallEntry): void {
    if (call.ringTimer) clearTimeout(call.ringTimer);
    this.calls.delete(call.callId);
  }

  /** call:invite */
  async invite(
    callerId: number,
    callerName: string,
    payload: { targetUserId?: string | number; media?: CallMedia },
  ): Promise<{ callId: string; ringTimeoutMs: number }> {
    const targetUserId = Number(payload.targetUserId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      throw new BadRequestException('targetUserId is required');
    }
    const media: CallMedia = payload.media === 'video' ? 'video' : 'audio';
    if (targetUserId === callerId) {
      throw new BadRequestException('不能呼叫自己');
    }
    // 发消息同款闸门：非好友/拉黑 → 403（文案与 SessionsService 一致）
    await this.friends.assertFriends(callerId, targetUserId);
    if (this.activeCallOf(callerId)) throw new ForbiddenException('你正在通话中');
    if (this.activeCallOf(targetUserId)) throw new ForbiddenException('对方正在通话中');

    const call: CallEntry = {
      callId: randomUUID(),
      callerId,
      callerName,
      calleeId: targetUserId,
      media,
      state: 'ringing',
      createdAt: Date.now(),
      ringTimer: null,
    };
    this.calls.set(call.callId, call);

    // 振铃超时兜底：双方都收 cancelled(missed)，注册表同步清理
    call.ringTimer = setTimeout(() => {
      const still = this.calls.get(call.callId);
      if (!still || still.state !== 'ringing') return;
      this.endCall(still);
      const notice = { callId: still.callId, userId: String(still.callerId), reason: 'missed' as const };
      this.events.toUser(String(still.callerId), 'call:cancelled', notice);
      this.events.toUser(String(still.calleeId), 'call:cancelled', notice);
      this.logger.log(`call ${still.callId} ring timeout`);
    }, RING_TIMEOUT_MS);

    const incoming: WsCallIncoming = {
      callId: call.callId,
      fromUserId: String(callerId),
      fromName: callerName,
      media,
      createdAt: call.createdAt,
    };
    this.events.toUser(String(targetUserId), 'call:incoming', incoming);
    this.logger.log(`call ${call.callId}: ${callerId} → ${targetUserId} (${media})`);
    return { callId: call.callId, ringTimeoutMs: RING_TIMEOUT_MS };
  }

  /** call:accept */
  accept(userId: number, payload: { callId?: string }): { callId: string } {
    const call = this.requireCall(payload.callId);
    if (call.calleeId !== userId) throw new ForbiddenException('只有被叫可以接听');
    if (call.state !== 'ringing') throw new BadRequestException('通话不在振铃中');
    if (call.ringTimer) {
      clearTimeout(call.ringTimer);
      call.ringTimer = null;
    }
    call.state = 'active';
    this.events.toUser(String(call.callerId), 'call:accepted', {
      callId: call.callId,
      userId: String(userId),
    });
    this.logger.log(`call ${call.callId} accepted`);
    return { callId: call.callId };
  }

  /** call:reject */
  reject(userId: number, payload: { callId?: string }): null {
    const call = this.requireCall(payload.callId);
    if (call.calleeId !== userId) throw new ForbiddenException('只有被叫可以拒接');
    if (call.state !== 'ringing') throw new BadRequestException('通话不在振铃中');
    this.endCall(call);
    this.events.toUser(String(call.callerId), 'call:rejected', {
      callId: call.callId,
      userId: String(userId),
    });
    return null;
  }

  /** call:cancel（主叫在对方接听前取消） */
  cancel(userId: number, payload: { callId?: string }): null {
    const call = this.requireCall(payload.callId);
    if (call.callerId !== userId) throw new ForbiddenException('只有主叫可以取消');
    if (call.state !== 'ringing') throw new BadRequestException('通话已接通，请挂断');
    this.endCall(call);
    this.events.toUser(String(call.calleeId), 'call:cancelled', {
      callId: call.callId,
      userId: String(userId),
      reason: 'cancelled',
    });
    return null;
  }

  /** call:hangup（接通后任一方挂断；振铃中主叫侧也允许 —— 等价取消） */
  hangup(userId: number, payload: { callId?: string }): null {
    const call = this.requireCall(payload.callId);
    if (call.callerId !== userId && call.calleeId !== userId) {
      throw new ForbiddenException('不是该通话的参与者');
    }
    const wasRinging = call.state === 'ringing';
    this.endCall(call);
    const peerId = call.callerId === userId ? call.calleeId : call.callerId;
    if (wasRinging && call.callerId === userId) {
      // 主叫振铃中「挂断」= 取消，被叫收到 cancelled（与 call:cancel 同文案语义）
      this.events.toUser(String(peerId), 'call:cancelled', {
        callId: call.callId,
        userId: String(userId),
        reason: 'cancelled',
      });
    } else {
      this.events.toUser(String(peerId), 'call:ended', {
        callId: call.callId,
        userId: String(userId),
      });
    }
    this.logger.log(`call ${call.callId} hung up by ${userId}`);
    return null;
  }

  /** webrtc:signal：结构性校验后原样转发给另一方（不落库、不解析 SDP） */
  signal(userId: number, payload: { callId?: string; data?: CallSignal }): null {
    const call = this.requireCall(payload.callId);
    if (call.callerId !== userId && call.calleeId !== userId) {
      throw new ForbiddenException('不是该通话的参与者');
    }
    if (call.state !== 'active') throw new BadRequestException('通话未接通');
    const data = payload.data;
    if (!data || typeof data !== 'object') throw new BadRequestException('data is required');
    if (data.type !== 'offer' && data.type !== 'answer' && data.type !== 'ice') {
      throw new BadRequestException('未知信令类型');
    }
    if (JSON.stringify(data).length > MAX_SIGNAL_BYTES) {
      throw new BadRequestException('信令载荷过大');
    }
    const peerId = call.callerId === userId ? call.calleeId : call.callerId;
    this.events.toUser(String(peerId), 'webrtc:signal', {
      callId: call.callId,
      userId: String(userId),
      data,
    });
    return null;
  }

  /** 用户断线时清理其进行中的通话（对端收到 ended/cancelled） */
  handleUserOffline(userId: number): void {
    const call = this.activeCallOf(userId);
    if (!call) return;
    const peerId = call.callerId === userId ? call.calleeId : call.callerId;
    const wasRinging = call.state === 'ringing';
    this.endCall(call);
    if (wasRinging) {
      this.events.toUser(String(peerId), 'call:cancelled', {
        callId: call.callId,
        userId: String(userId),
        reason: 'missed',
      });
    } else {
      this.events.toUser(String(peerId), 'call:ended', {
        callId: call.callId,
        userId: String(userId),
      });
    }
  }

  private requireCall(callId?: string): CallEntry {
    if (!callId) throw new BadRequestException('callId is required');
    const call = this.calls.get(callId);
    if (!call) throw new BadRequestException('通话不存在或已结束');
    return call;
  }
}
