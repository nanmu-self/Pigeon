import type { AuthResult } from '@pigeon/shared-types';
import type request from 'supertest';
import type { Test } from 'supertest';
import { WsEventsService } from '../../src/ws/ws-events.service.js';
import type { EventPayload, ServerToClientEvents } from '@pigeon/shared-types';

/**
 * 传输无关的 e2e 设施（决策 D7）—— 整个迁移最重要的安全网。
 *
 * e2e 不再连接真实 Socket.IO 网关，而是：
 *  - 注入 FakeTransportBridge 替换 WsEventsService，断言「谁收到了什么事件」
 *    （publish 调用记录），C2S 一律走 supertest 打 /internal/rt/:type；
 *  - Socket.IO 删除（P4）时本文件与两个 e2e spec 零改动。
 */

/** 一次推送的记录（对应 /internal/publish 的语义） */
export interface PublishCall {
  /** 定向目标（broadcast 时为空数组） */
  userIds: string[];
  broadcast: boolean;
  type: string;
  payload: unknown;
  at: number;
}

/**
 * FakeTransportBridge：与 WsEventsService / TransportBridgeService 同签名，
 * 记录全部推送 + 维护可手动操控的 presence 注册表。
 */
export class FakeTransportBridge {
  readonly calls: PublishCall[] = [];
  private readonly online = new Map<string, Set<string>>();

  // ── 与生产桥一致的接口（服务注入面） ──────────────────────

  bind(_io: unknown): void {}

  get onlineCount(): number {
    return this.online.size;
  }

  markOnline(userId: string, socketId: string): boolean {
    const first = !this.online.has(userId);
    const set = this.online.get(userId) ?? new Set<string>();
    set.add(socketId);
    this.online.set(userId, set);
    return first;
  }

  markOffline(userId: string, socketId: string): boolean {
    const set = this.online.get(userId);
    set?.delete(socketId);
    if (set && set.size === 0) {
      this.online.delete(userId);
      return true;
    }
    return false;
  }

  isOnline(userId: string): boolean {
    return (this.online.get(userId)?.size ?? 0) > 0;
  }

  toUser<K extends keyof ServerToClientEvents>(
    userId: string,
    event: K,
    payload: EventPayload<K>,
  ): void {
    this.calls.push({ userIds: [userId], broadcast: false, type: event, payload, at: Date.now() });
  }

  toUsers<K extends keyof ServerToClientEvents>(
    userIds: string[],
    event: K,
    payload: EventPayload<K>,
  ): void {
    this.calls.push({ userIds: [...userIds], broadcast: false, type: event, payload, at: Date.now() });
  }

  toConversation<K extends keyof ServerToClientEvents>(
    _conversationId: string,
    _event: K,
    _payload: EventPayload<K>,
  ): void {}

  broadcast<K extends keyof ServerToClientEvents>(
    event: K,
    payload: EventPayload<K>,
  ): void {
    this.calls.push({ userIds: [], broadcast: true, type: event, payload, at: Date.now() });
  }

  // ── 测试助手 ──────────────────────────────────────────────

  /** 模拟用户上线/下线（等价旧测试里 connectWs/disconnect 的 presence 副作用） */
  setOnline(userId: number | string, online: boolean): void {
    const id = String(userId);
    if (online) this.markOnline(id, `conn-${id}`);
    else this.markOffline(id, `conn-${id}`);
  }

  callsOf(type: string): PublishCall[] {
    return this.calls.filter((c) => c.type === type);
  }

  /** 清空调用记录（presence 保留）；beforeEach 用 reset 全清 */
  clearCalls(): void {
    this.calls.length = 0;
  }

  reset(): void {
    this.calls.length = 0;
    this.online.clear();
  }

  /**
   * 等待一次符合条件的推送（等价旧 waitFor(socket, event)）。
   * filter 语义：userIds 包含目标用户（或 broadcast）且 type 匹配、
   * 可选 payload 谓词。
   */
  async waitFor<T>(filter: {
    userId?: string | number;
    broadcast?: boolean;
    type: string;
    match?: (payload: unknown) => boolean;
    timeoutMs?: number;
  }): Promise<T> {
    const started = Date.now();
    for (;;) {
      const found = this.calls.find(
        (c) =>
          c.type === filter.type &&
          (filter.broadcast === undefined || c.broadcast === filter.broadcast) &&
          (filter.userId === undefined || c.broadcast || c.userIds.includes(String(filter.userId))) &&
          (filter.match === undefined || filter.match(c.payload)),
      );
      if (found) return found.payload as T;
      if (Date.now() - started > (filter.timeoutMs ?? 5000)) {
        throw new Error(`timeout waiting publish ${filter.type} → ${filter.userId ?? 'broadcast'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** e2e 的内部 API 令牌（applyTransportEnv 写入 process.env，guard 动态读取） */
export const INTERNAL_TOKEN = 'e2e-internal-token-0123456789abcdef';

/**
 * e2e 启动 AppModule 前补齐传输配置：resolveTransportSettings 无条件 fail-fast
 * （WebTransport 是唯一实时通道），FakeTransportBridge 只替换推送桥，
 * 配置校验与 presence 镜像仍会读这些值。
 */
export function applyTransportEnv(): void {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'e2e-jwt-secret-0123456789abcdef';
  process.env.TRANSPORT_INTERNAL_URL = process.env.TRANSPORT_INTERNAL_URL ?? 'http://127.0.0.1:3901';
  process.env.WT_PUBLIC_URL = process.env.WT_PUBLIC_URL ?? 'https://127.0.0.1:4433/wt';
  process.env.WT_INTERNAL_TOKEN = process.env.WT_INTERNAL_TOKEN ?? INTERNAL_TOKEN;
}

/** C2S：supertest 打 /internal/rt/:type（Rust 转发的等价物） */
export function rtPost(
  api: ReturnType<typeof request>,
  user: AuthResult,
  type: string,
  payload: unknown,
): Test {
  return api
    .post(`/internal/rt/${type}`)
    .set('x-internal-token', INTERNAL_TOKEN)
    .set('x-user-id', String(user.user.id))
    .set('x-display-name-b64', Buffer.from(user.user.nickname).toString('base64url'))
    .send(payload as object);
}

/** C2S ack：返回 {ok, data?, error?} 形状（与 RPC RtResponse 语义一致） */
export async function rtAck<T>(
  api: ReturnType<typeof request>,
  user: AuthResult,
  type: string,
  payload: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const res = await rtPost(api, user, type, payload);
  if (res.status !== 200) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return res.body as { ok: boolean; data?: T; error?: string };
}

/** WsEventsService 的 override 值类型标注（仅文档用途） */
export type FakeBridgeOverride = FakeTransportBridge & Partial<typeof WsEventsService.prototype>;
