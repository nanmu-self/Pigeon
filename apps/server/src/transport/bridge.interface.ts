import type { EventPayload, ServerToClientEvents } from '@pigeon/shared-types';

/**
 * 传输桥的公共签名 —— 旧实现（Socket.IO 的 WsEventsService）与新实现
 * （WebTransport 的 TransportBridgeService）都按此契约暴露；
 * 消费方（sessions/groups/friends/app）注入 `WsEventsService` token 零改动。
 *
 * `toUsers` 是本次迁移新增的批量投递（群 fan-out 一次内部调用，见 §5）；
 * 旧实现按 userId 循环补齐签名。
 */
export interface TransportBridgeLike {
  /** 当前在线数（口径随实现：socket=Socket.IO 连接数；wt=在线用户数） */
  readonly onlineCount: number;
  /** 保留：Socket.IO 网关 afterInit 时绑定 io 句柄；wt 桥为 noop */
  bind(io: unknown): void;
  /** 连接上线。返回是否该用户的第一路连接（用于广播上线事件） */
  markOnline(userId: string, socketId: string): boolean;
  /** 连接下线。返回是否该用户的最后一路连接（用于广播离线事件） */
  markOffline(userId: string, socketId: string): boolean;
  /** 用户是否有任一在线设备（同步读本地 presence，见 D6） */
  isOnline(userId: string): boolean;
  toUser<K extends keyof ServerToClientEvents>(userId: string, event: K, payload: EventPayload<K>): void;
  toUsers<K extends keyof ServerToClientEvents>(userIds: string[], event: K, payload: EventPayload<K>): void;
  /** 已随房间模型一起废弃（决策 D2）：无业务调用方，保留空签名防误用 */
  toConversation<K extends keyof ServerToClientEvents>(conversationId: string, event: K, payload: EventPayload<K>): void;
  broadcast<K extends keyof ServerToClientEvents>(event: K, payload: EventPayload<K>): void;
}
