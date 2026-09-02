import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@pigeon/shared-types';

/** 带 E/S 事件类型的 Socket.IO server 句柄 */
export type IoServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** 泛型事件名 → 其首个（载荷）参数类型 */
export type ServerEventPayload<K extends keyof ServerToClientEvents> = Parameters<
  ServerToClientEvents[K]
>[0];

/**
 * HTTP 侧向 WS 客户端推送事件的桥。
 *
 * Gateway 在 afterInit() 里把 io 实例绑定进来；之后任何
 * Controller / Service 都可以注入本服务做实时推送（如 REST
 * 收到新消息后广播给房间内成员），而不必直接依赖 socket.io。
 */
@Injectable()
export class WsEventsService {
  private readonly logger = new Logger(WsEventsService.name);
  private io: IoServer | null = null;

  /** userId → 在线 socketId 集合（presence 注册表，供 REST 侧查询在线状态） */
  private readonly online = new Map<string, Set<string>>();

  /** socket.io 对 E/S 泛型的包装与 TS 高阶推断不兼容，内部 emit 统一窄化 */
  private emitRaw(
    target: { emit(event: string, ...args: unknown[]): unknown } | undefined,
    event: keyof ServerToClientEvents,
    payload: unknown,
  ): void {
    target?.emit(event, payload);
  }

  /** 由 EventsGateway.afterInit() 调用 */
  bind(io: IoServer): void {
    this.io = io;
    this.logger.log('Socket.IO server bound to WsEventsService');
  }

  /** 当前在线连接数（所有 namespace） */
  get onlineCount(): number {
    return this.io?.engine.clientsCount ?? 0;
  }

  // ── presence 注册表（网关在连接/断开时维护，REST 侧只读） ──

  /**
   * 连接上线。返回是否该用户的第一路连接（用于广播上线事件）。
   */
  markOnline(userId: string, socketId: string): boolean {
    const firstSocket = !this.online.has(userId);
    const sockets = this.online.get(userId) ?? new Set<string>();
    sockets.add(socketId);
    this.online.set(userId, sockets);
    return firstSocket;
  }

  /**
   * 连接下线。返回是否该用户的最后一路连接（用于广播离线事件）。
   */
  markOffline(userId: string, socketId: string): boolean {
    const sockets = this.online.get(userId);
    sockets?.delete(socketId);
    if (sockets && sockets.size === 0) {
      this.online.delete(userId);
      return true;
    }
    return false;
  }

  /** 用户是否有任一在线设备 */
  isOnline(userId: string): boolean {
    return (this.online.get(userId)?.size ?? 0) > 0;
  }

  /** 推给某个用户的全部在线设备（个人房间 `user:{userId}`） */
  toUser<K extends keyof ServerToClientEvents>(
    userId: string,
    event: K,
    payload: ServerEventPayload<K>,
  ): void {
    this.emitRaw(this.io?.to(`user:${userId}`), event, payload);
  }

  /**
   * 批量定向推给多个用户的全部在线设备。
   *
   * 与 TransportBridgeService 同签名（群 fan-out 用批量；Socket.IO 侧本就
   * 是内存循环，不涉及多次 HTTP）。与 toUser 一样保持 fire-and-forget 语义。
   */
  toUsers<K extends keyof ServerToClientEvents>(
    userIds: string[],
    event: K,
    payload: ServerEventPayload<K>,
  ): void {
    for (const userId of userIds) {
      this.emitRaw(this.io?.to(`user:${userId}`), event, payload);
    }
  }

  /** 推给某个会话房间（`conversation:{conversationId}`） */
  toConversation<K extends keyof ServerToClientEvents>(
    conversationId: string,
    event: K,
    payload: ServerEventPayload<K>,
  ): void {
    this.emitRaw(this.io?.to(`conversation:${conversationId}`), event, payload);
  }

  /** 全服广播 */
  broadcast<K extends keyof ServerToClientEvents>(
    event: K,
    payload: ServerEventPayload<K>,
  ): void {
    this.emitRaw(this.io ?? undefined, event, payload);
  }
}
