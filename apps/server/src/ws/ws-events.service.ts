import type { EventPayload, ServerToClientEvents } from '@pigeon/shared-types';

/**
 * 实时推送服务的注入 token（业务侧唯一依赖面）。
 *
 * P4 起 Socket.IO 已删除，WebTransport 是唯一实时通道：WsModule 把本 token
 * 绑定到 TransportBridgeService（HTTP 桥 → Rust /internal/publish）；
 * e2e 用 FakeTransportBridge 替换。presence 权威状态在 Rust，本进程读本地镜像。
 */
export abstract class WsEventsService {
  /** 当前在线用户数（去重口径，非连接数；/health 与 health:ping 消费） */
  abstract get onlineCount(): number;

  /** 用户是否有任一在线设备（同步读 presence 镜像，见迁移方案 D6） */
  abstract isOnline(userId: string): boolean;

  /** 推给某个用户的全部在线设备 */
  abstract toUser<K extends keyof ServerToClientEvents>(
    userId: string,
    event: K,
    payload: EventPayload<K>,
  ): void;

  /** 批量定向推给多个用户（群 fan-out 单次内部调用，禁止 for 循环调 toUser） */
  abstract toUsers<K extends keyof ServerToClientEvents>(
    userIds: string[],
    event: K,
    payload: EventPayload<K>,
  ): void;

  /** 全服广播（presence:update、group:updated） */
  abstract broadcast<K extends keyof ServerToClientEvents>(
    event: K,
    payload: EventPayload<K>,
  ): void;
}
