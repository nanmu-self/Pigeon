export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

export interface Message {
  id: string;
  content: string;
  senderId: string;
  timestamp: number;
  encrypted: boolean;
}

export interface ApiResponse<T = unknown> {
  data: T;
  message: string;
  code: number;
}

export enum MessageType {
  Text = 'text',
  Image = 'image',
  Video = 'video',
}

// ─────────────────────────────────────────────────────────────
// WebSocket (Socket.IO) 事件契约
//
// server / desktop 两侧均只做 `import type`（编译期擦除），事件名与载荷
// 由下列接口约束；socket.io-client 与 @nestjs/websockets 都支持泛型注入。
// ─────────────────────────────────────────────────────────────

/** 事件 ack 的统一返回结构 */
export type WsAck<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** 事件 ack 回调（client → server 事件的最后一个参数） */
export type WsAckCallback<T = unknown> = (res: WsAck<T>) => void;

/** 跨端传输的聊天消息载荷 */
export interface WsChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  kind: 'text' | 'image' | 'file' | 'system';
  content: string;
  /** Unix 毫秒时间戳 */
  createdAt: number;
}

export interface WsTypingState {
  conversationId: string;
  userId: string;
  displayName: string;
  typing: boolean;
}

export interface WsPresenceState {
  userId: string;
  online: boolean;
  /** Unix 毫秒时间戳 */
  at: number;
}

/** Server → Client */
export interface ServerToClientEvents {
  'connection:welcome': (payload: {
    socketId: string;
    userId: string;
    serverTime: number;
  }) => void;
  'message:new': (payload: WsChatMessage) => void;
  'typing:update': (payload: WsTypingState) => void;
  'presence:update': (payload: WsPresenceState) => void;
}

/** Client → Server */
export interface ClientToServerEvents {
  'conversation:join': (
    conversationId: string,
    ack: WsAckCallback<{ joined: string[] }>,
  ) => void;
  'conversation:leave': (
    conversationId: string,
    ack: WsAckCallback<{ joined: string[] }>,
  ) => void;
  'message:send': (
    payload: {
      conversationId: string;
      content: string;
      kind?: WsChatMessage['kind'];
    },
    ack: WsAckCallback<WsChatMessage>,
  ) => void;
  'typing:start': (payload: { conversationId: string; displayName?: string }) => void;
  'typing:stop': (payload: { conversationId: string }) => void;
  'health:ping': (ack: WsAckCallback<{ pong: number; online: number }>) => void;
}

/** 多实例间广播（当前单实例部署，留空） */
export interface InterServerEvents {}

/** 挂在每个 socket 实例上的会话数据 */
export interface SocketData {
  userId: string;
  displayName: string;
  /** Unix 毫秒时间戳 */
  connectedAt: number;
}
