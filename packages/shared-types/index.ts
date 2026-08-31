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
// 认证（REST /auth/*）契约
//
// server 与 desktop 共用：server 端做 DTO 实现与响应，desktop 端做请求与存储。
// ─────────────────────────────────────────────────────────────

/** 不含密码哈希的用户公开信息 */
export interface PublicUser {
  id: number;
  email: string;
  nickname: string;
  /** 七牛外链头像地址（未设置时缺省） */
  avatarUrl?: string;
  createdAt: string;
}

/** PATCH /users/me 入参（部分更新：只传需要改的字段） */
export interface UpdateProfileInput {
  nickname?: string;
  /** 头像外链（来自 UploadTicket.publicUrl） */
  avatarUrl?: string;
}

/** 注册/登录成功响应 */
export interface AuthResult {
  user: PublicUser;
  /** JWT：HTTP 请求放 Authorization: Bearer <token>；WS 握手放 auth.token */
  token: string;
}

/** GET /auth/captcha 响应：image 为 PNG dataURL，可直接绑给 <img src> */
export interface CaptchaChallenge {
  captchaId: string;
  image: string;
}

/** 注册入参（captchaId/captchaCode 由 GET /auth/captcha 获得，一次性） */
export interface RegisterInput {
  email: string;
  password: string;
  nickname: string;
  captchaId: string;
  captchaCode: string;
}

/** 登录入参 */
export interface LoginInput {
  email: string;
  password: string;
  captchaId: string;
  captchaCode: string;
}

// ─────────────────────────────────────────────────────────────
// 文件存储（七牛云 Kodo 直传）契约
//
// 流程：desktop 携带 JWT 请求 POST /storage/upload-token → server 校验后
// 按目录生成受限上传凭证（scope 定向到服务端生成的 key）→ desktop 用
// qiniu-js 凭 token 直传七牛，不经过业务服务器中转。
//
// 注意：本包运行时零依赖（无 main/exports/JS 产物），两端只能 import type；
// 需要值形式的白名单/常量时，在使用方模块内定义并用编译期断言对齐类型
// （参考 apps/server/src/storage/dto.ts）。
// ─────────────────────────────────────────────────────────────

/** 上传目录：决定存储路径前缀、大小限制与（头像的）类型限制 */
export type UploadDir = 'avatar' | 'chat' | 'file';

/** POST /storage/upload-token 入参 */
export interface UploadTokenInput {
  /** 上传目录，缺省为 file */
  dir?: UploadDir;
  /** 原始文件名，服务端用于推断扩展名（不作为存储名） */
  fileName?: string;
}

/** POST /storage/upload-token 响应：前端直传所需的一票式凭证 */
export interface UploadTicket {
  /** 七牛上传凭证（前端直传时作为 token 参数） */
  token: string;
  /** 服务端生成的资源名（scope 已定向到该 key，前端原样使用，不可自改） */
  key: string;
  /** 存储区域代号（z0/z1/z2/na0/as0），映射 qiniu.region */
  region: string;
  /** 空间外链域名（不含末尾斜杠，含协议） */
  domain: string;
  /** 上传成功后的最终访问地址 = domain + '/' + key */
  publicUrl: string;
  /** 凭证过期时间（Unix 秒） */
  expiresAt: number;
  /** 该目录允许的最大文件大小（字节），超出时七牛直接拒绝 */
  maxSize: number;
}

/**
 * GET /storage/session-token 响应：目录级会话凭证（仅 chat/file）。
 * scope=bucket + insertOnly，同一凭证在有效期内可复用于该目录的多个文件；
 * key 由客户端按 `{dir}/{年月}/{uuid}.{净化ext}` 规则生成（chat 前缀配合
 * 七牛生命周期规则自动清理）。有效期默认 1 小时，客户端剩余 < 10 分钟时懒刷新。
 */
export interface UploadSessionTicket {
  token: string;
  /** 空间外链域名（不含末尾斜杠），最终 URL = domain + '/' + key */
  domain: string;
  region: string;
  /** 凭证过期时间（Unix 秒） */
  expiresAt: number;
  /** 该目录允许的最大文件大小（字节） */
  maxSize: number;
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

/** 消息引用预览（渲染引用块用；服务端在发送/历史时内嵌） */
export interface MessageReplySummary {
  /** 被引用消息的 id */
  id: string;
  senderName: string;
  kind: 'text' | 'image' | 'file' | 'system';
  /** 被引用消息的正文/外链（UI 截断展示） */
  content: string;
}

/** 表情回应聚合（按 emoji 分组） */
export interface MessageReactionSummary {
  emoji: string;
  count: number;
  /** 点了该 emoji 的用户 id（含自己，UI 据此高亮） */
  userIds: string[];
}

/** 跨端传输的聊天消息载荷 */
export interface WsChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  kind: 'text' | 'image' | 'file' | 'system';
  content: string;
  /**
   * 附加信息（image/file 消息）：{ fname, size, mime, ... }；
   * E2EE 接入后可携带加密信封。服务端不解析，透传存储。
   */
  meta?: Record<string, unknown> | null;
  /** 引用预览（仅回复消息携带） */
  replyTo?: MessageReplySummary | null;
  /** 表情回应聚合（历史下发携带；实时变化走 reaction:update） */
  reactions?: MessageReactionSummary[];
  /** 撤回时间（Unix 毫秒；撤回消息 content 已清空，UI 渲染撤回占位） */
  recalledAt?: number | null;
  /** Unix 毫秒时间戳 */
  createdAt: number;
}

// ─────────────────────────────────────────────────────────────
// 好友关系（REST /friends/* + 实时通知）契约
// ─────────────────────────────────────────────────────────────

/** 好友列表项：资料 + 在线状态 + 成为好友的时间 */
export interface FriendItem {
  user: PublicUser;
  online: boolean;
  /** 成为好友的时间（服务端时间戳字符串） */
  since: string;
}

/** 好友申请项（direction 标明申请流向，user 恒为对方） */
export interface FriendRequestItem {
  id: number;
  direction: 'incoming' | 'outgoing';
  user: PublicUser;
  createdAt: string;
}

/** POST /friends/requests 入参 */
export interface SendFriendRequestInput {
  userId: number;
}

/** WS 实时通知：收到好友申请 */
export interface WsFriendRequest {
  from: PublicUser;
  createdAt: string;
}

/** WS 实时通知：申请被对方通过 */
export interface WsFriendAccepted {
  /** 接受申请的人（即成为好友的对方） */
  user: PublicUser;
  since: string;
}

// ─────────────────────────────────────────────────────────────
// 会话与消息（REST /sessions/*）契约
//
// 服务端表名 Session/Message；线上统一把 id string 化后放进
// conversationId / message.id（与 WsChatMessage 对齐）。
// ─────────────────────────────────────────────────────────────

/** POST /sessions 入参：与哪个好友建会话（幂等，重复调用返回既有会话） */
export interface CreateSessionInput {
  peerId: number;
}

/** 会话列表项：对端资料 + 在线状态 + 最后一条消息 + 未读数 */
export interface SessionSummary {
  id: string;
  peer: PublicUser;
  peerOnline: boolean;
  /** 最后一条消息（会话尚无消息时不出现） */
  lastMessage?: WsChatMessage;
  /** 会话活跃时间（服务端时间戳字符串，列表按它倒序） */
  lastMessageAt: string;
  /** 当前用户在该会话的未读数 */
  unreadCount: number;
  createdAt: string;
}

/** GET /sessions/:id/messages 响应：一页历史消息（按时间正序返回） */
export interface MessageHistoryPage {
  messages: WsChatMessage[];
  /** 是否还有更早的消息（拿本页最早一条的 id 作下一页 cursor） */
  hasMore: boolean;
  /** 对端已读水位（已读的最大消息 id；单聊才有，无记录时缺省） */
  peerReadUpTo?: string;
  /** 对端送达水位（已送达的最大消息 id；单聊才有，无记录时缺省） */
  peerDeliveredUpTo?: string;
}

/** message:read ack / POST /sessions/:id/read 响应 */
export interface MessageReadAck {
  conversationId: string;
  /** 已读水位：本端已读的最大消息 id */
  lastReadMessageId: string;
  /** Unix 毫秒 */
  readAt: number;
}

/** S2C 已读回执推送：对方读到了哪条 */
export interface WsReadReceipt {
  conversationId: string;
  /** 执行已读的用户 id */
  userId: string;
  lastReadMessageId: string;
  /** Unix 毫秒 */
  readAt: number;
}

/** S2C 送达回执推送：消息已推到对方设备（对方在线即视为送达） */
export interface WsDeliveredReceipt {
  conversationId: string;
  /** 收到消息的用户 id */
  userId: string;
  lastDeliveredMessageId: string;
  /** Unix 毫秒 */
  deliveredAt: number;
}

/** S2C 撤回通知：content 已清空，客户端渲染撤回占位 */
export interface WsRecalledNotice {
  conversationId: string;
  messageId: string;
  /** 撤回者（= 原发送者） */
  userId: string;
  /** Unix 毫秒 */
  recalledAt: number;
}

/** S2C 表情回应增量更新（add/remove） */
export interface WsReactionUpdate {
  conversationId: string;
  messageId: string;
  emoji: string;
  /** 操作者 */
  userId: string;
  action: 'add' | 'remove';
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
  'message:read': (payload: WsReadReceipt) => void;
  'message:delivered': (payload: WsDeliveredReceipt) => void;
  'reaction:update': (payload: WsReactionUpdate) => void;
  'message:recalled': (payload: WsRecalledNotice) => void;
  'typing:update': (payload: WsTypingState) => void;
  'presence:update': (payload: WsPresenceState) => void;
  'friend:request': (payload: WsFriendRequest) => void;
  'friend:accepted': (payload: WsFriendAccepted) => void;
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
      /** 客户端幂等键（UUID）：重试重发不会产生重复消息 */
      clientMsgId?: string;
      /** image/file 消息的附加信息（fname/size/mime），≤4KB 的 JSON 对象 */
      meta?: Record<string, unknown>;
      /** 引用回复：被引用消息的 id（必须同会话） */
      replyToId?: string;
    },
    ack: WsAckCallback<WsChatMessage>,
  ) => void;
  /** 标记会话已读（打开会话/收到新消息时调用），服务端推已读回执给对方 */
  'message:read': (
    payload: { conversationId: string },
    ack: WsAckCallback<MessageReadAck>,
  ) => void;
  /** 表情回应（成员互动；服务端广播 reaction:update 给双方） */
  'reaction:add': (
    payload: { conversationId: string; messageId: string; emoji: string },
    ack: WsAckCallback<null>,
  ) => void;
  'reaction:remove': (
    payload: { conversationId: string; messageId: string; emoji: string },
    ack: WsAckCallback<null>,
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
