import type { ServerToClientEvents, TransportConfig } from '@pigeon/shared-types';

/** 连接状态（与 SocketManager 的 WsState 同构，避免循环依赖放这里） */
export type TransportState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** 业务事件处理器注册表的一行 */
export interface HandlerEntry {
  event: keyof ServerToClientEvents;
  handler: ServerToClientEvents[keyof ServerToClientEvents];
}

/**
 * 传输实现与 SocketManager（门面）之间的宿主回调。
 */
export interface TransportHost {
  /** token 每次连接从 tokenStore 现读（登录/登出后无需重建实现） */
  getToken(): string;
  /** 当前业务 handler 注册表（门面按它分发推送） */
  getHandlers(): HandlerEntry[];
  /** 状态流转（connecting/connected/reconnecting/disconnected + lastError） */
  onState(state: TransportState, error?: string | null): void;
  /** 握手完成（hello 响应 welcome） */
  onWelcome(socketId: string, userId: string): void;
  /** S2C 推送分发（门面按 handlerList 转发） */
  onPush(type: keyof ServerToClientEvents, payload: unknown): void;
  /** 推送流 seq 跳号 / resync：断线期间丢过推送，订阅方需对账刷新 */
  onReconcile(): void;
  /** 连接成功（含重连）：触发 onConnected 对账回调 */
  onConnected(): void;
}

/** 传输实现公共接口（门面唯一依赖面） */
export interface TransportImpl {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  /** 请求-应答：ok=false 或超时 → reject(Error) */
  rpc<T>(type: string, payload?: unknown, timeoutMs?: number): Promise<T>;
}

/** 帧协议版本（Rust MIN_CLIENT_PROTO 同步） */
export const CLIENT_PROTO = 1;

export type { TransportConfig };
