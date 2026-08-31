import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  InterServerEvents,
  MessageReadAck,
  ServerToClientEvents,
  SocketData,
  WsAckCallback,
  WsChatMessage,
} from '@pigeon/shared-types';
import { HttpException, Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { allowedOrigins } from '../config.js';
import type { JwtPayload } from '../auth/auth.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { WsEventsService, type IoServer } from './ws-events.service.js';

/** ack 回调（client → server 事件的最后一个参数） */
type Ack<T> = WsAckCallback<T>;
type IoSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Socket.IO 网关 — Tauri 前端（Svelte）直连的实时通道。
 *
 * 房间模型：
 *  - `user:{userId}`            一个用户的所有在线设备
 *  - `conversation:{convId}`    会话消息广播房间，客户端通过 `conversation:join` 进入
 *
 * 鉴权（骨架版）：客户端在握手时带上 `auth.token`；当前仅做占位解析，
 * 接入真实登录后应在此验签 JWT 并写入 client.data（见 handleConnection 内 TODO）。
 * 设置 WS_STRICT_AUTH=true 后，未携带 token 的握手会被直接拒绝。
 */
@WebSocketGateway({
  cors: { origin: allowedOrigins(), credentials: true },
  // 与 socket.io-client 默认心跳对齐：断网 20s 内不丢连接，跨网络切换可较快恢复
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 1e6, // 1 MB：聊天文本足够，大文件以后走 HTTP/分片
})
export class EventsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: IoServer;

  private readonly logger = new Logger(EventsGateway.name);

  // 注意：本仓库用 swc/esbuild 编译，不产出装饰器元数据，
  // 因此依赖注入一律显式 @Inject（见 app.controller.ts），
  // WS 消息处理器用普通参数而非 @MessageBody。
  constructor(
    @Inject(WsEventsService) private readonly events: WsEventsService,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  /** 把业务异常（HttpException）转成给客户端的 ack 文案 */
  private errorText(error: unknown): string {
    if (error instanceof HttpException) {
      const res = error.getResponse();
      if (typeof res === 'string') return res;
      return (res as { message?: string }).message ?? error.message;
    }
    this.logger.error(`ws handler failed: ${String(error)}`);
    return '服务器开小差了，请稍后再试';
  }

  afterInit(server: IoServer): void {
    // 把 io 句柄交给桥接服务，HTTP 侧即可注入 WsEventsService 做推送
    this.events.bind(server);
    this.logger.log('Socket.IO gateway ready');
  }

  async handleConnection(client: IoSocket): Promise<void> {
    const token = (client.handshake.auth?.token as string | undefined) ?? '';

    const strict = process.env.WS_STRICT_AUTH === 'true';
    if (!token && strict) {
      this.logger.warn(`rejected unauthenticated handshake ${client.id}`);
      client.disconnect(true);
      return;
    }

    // 验签 JWT(由 POST /auth/login 签发,载荷结构见 auth.service.ts 的 JwtPayload)。
    // 验签失败:strict 模式直接断开;否则降级为游客身份。
    let authenticated = false;
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<JwtPayload>(token);
        client.data.userId = String(payload.userId);
        client.data.displayName = payload.nickname;
        authenticated = true;
      } catch {
        if (strict) {
          this.logger.warn(`rejected handshake with invalid token ${client.id}`);
          client.disconnect(true);
          return;
        }
        this.logger.warn(`invalid token, falling back to guest: ${client.id}`);
      }
    }
    if (!authenticated) {
      client.data.userId = `guest:${randomUUID().slice(0, 8)}`;
      client.data.displayName =
        (client.handshake.auth?.displayName as string | undefined) ?? client.data.userId;
    }
    client.data.connectedAt = Date.now();

    // 加入个人房间，便于定向推送（后续配合真实登录使用）
    await client.join(`user:${client.data.userId}`);

    const firstSocketOfUser = this.events.markOnline(client.data.userId, client.id);

    client.emit('connection:welcome', {
      socketId: client.id,
      userId: client.data.userId,
      serverTime: Date.now(),
    });

    if (firstSocketOfUser) {
      this.events.broadcast('presence:update', {
        userId: client.data.userId,
        online: true,
        at: Date.now(),
      });
    }

    this.logger.log(
      `+ ${client.id} as ${client.data.userId} (online: ${this.events.onlineCount})`,
    );
  }

  handleDisconnect(client: IoSocket): void {
    const userId = client.data?.userId;
    if (!userId) return;

    // 该用户的最后一路连接断开 → 广播离线
    if (this.events.markOffline(userId, client.id)) {
      this.events.broadcast('presence:update', {
        userId,
        online: false,
        at: Date.now(),
      });
    }

    this.logger.log(`- ${client.id} as ${userId} (online: ${this.events.onlineCount})`);
  }

  // ── 会话房间 ─────────────────────────────────────────────

  @SubscribeMessage('conversation:join')
  async onConversationJoin(
    client: IoSocket,
    conversationId: string,
    ack?: Ack<{ joined: string[] }>,
  ): Promise<void> {
    if (!conversationId) {
      ack?.({ ok: false, error: 'conversationId is required' });
      return;
    }
    await client.join(`conversation:${conversationId}`);
    ack?.({
      ok: true,
      data: { joined: [...client.rooms].filter((r) => r.startsWith('conversation:')) },
    });
  }

  @SubscribeMessage('conversation:leave')
  async onConversationLeave(
    client: IoSocket,
    conversationId: string,
    ack?: Ack<{ joined: string[] }>,
  ): Promise<void> {
    await client.leave(`conversation:${conversationId}`);
    ack?.({
      ok: true,
      data: { joined: [...client.rooms].filter((r) => r.startsWith('conversation:')) },
    });
  }

  // ── 消息 ─────────────────────────────────────────────────

  /**
   * 发消息：会话成员 + 好友关系校验后事务落库（消息 + 回实行 + 会话活跃指针），
   * 推送由 SessionsService 统一向双方 user 房间广播 message:new。
   */
  @SubscribeMessage('message:send')
  async onMessageSend(
    client: IoSocket,
    payload: {
      conversationId: string;
      content: string;
      kind?: WsChatMessage['kind'];
      clientMsgId?: string;
    },
    ack?: Ack<WsChatMessage>,
  ): Promise<void> {
    const { conversationId, content, kind, clientMsgId } = payload;
    if (!conversationId || !content?.trim()) {
      ack?.({ ok: false, error: 'conversationId and content are required' });
      return;
    }
    const senderId = Number(client.data.userId);
    if (!Number.isInteger(senderId)) {
      ack?.({ ok: false, error: '游客不能发送消息，请先登录' });
      return;
    }
    const sessionId = Number(conversationId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      ack?.({ ok: false, error: '会话不存在' });
      return;
    }
    if (kind && !['text', 'image', 'file'].includes(kind)) {
      ack?.({ ok: false, error: '不支持的消息类型' });
      return;
    }

    try {
      const message = await this.sessions.sendMessage({
        sessionId,
        senderId,
        senderName: client.data.displayName,
        content,
        kind: kind ?? 'text',
        ...(clientMsgId ? { clientMsgId } : {}),
      });
      // 先 ack（发送方获得回执）；message:new 由服务层推给双方所有设备
      ack?.({ ok: true, data: message });
    } catch (error) {
      ack?.({ ok: false, error: this.errorText(error) });
    }
  }

  /**
   * 标记会话已读：批量写 readAt + 计算已读水位，
   * 对端会收到 message:read 推送（已读回执）。
   */
  @SubscribeMessage('message:read')
  async onMessageRead(
    client: IoSocket,
    payload: { conversationId: string },
    ack?: Ack<MessageReadAck>,
  ): Promise<void> {
    const readerId = Number(client.data.userId);
    if (!Number.isInteger(readerId)) {
      ack?.({ ok: false, error: '游客没有消息状态，请先登录' });
      return;
    }
    const sessionId = Number(payload?.conversationId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      ack?.({ ok: false, error: '会话不存在' });
      return;
    }

    try {
      const result = await this.sessions.markRead(readerId, sessionId);
      ack?.({ ok: true, data: result });
    } catch (error) {
      ack?.({ ok: false, error: this.errorText(error) });
    }
  }

  // ── 正在输入 ─────────────────────────────────────────────

  @SubscribeMessage('typing:start')
  onTypingStart(
    client: IoSocket,
    payload: { conversationId: string; displayName?: string },
  ): void {
    client.to(`conversation:${payload.conversationId}`).emit('typing:update', {
      conversationId: payload.conversationId,
      userId: client.data.userId,
      displayName: payload.displayName ?? client.data.displayName,
      typing: true,
    });
  }

  @SubscribeMessage('typing:stop')
  onTypingStop(client: IoSocket, payload: { conversationId: string }): void {
    client.to(`conversation:${payload.conversationId}`).emit('typing:update', {
      conversationId: payload.conversationId,
      userId: client.data.userId,
      displayName: client.data.displayName,
      typing: false,
    });
  }

  // ── 探活 ─────────────────────────────────────────────────

  // 注意：未用参数装饰器时，Nest 按位置注入 (client, data, ack)；
  // 即使事件没有载荷（客户端只发 ack），也必须占住 data 位。
  @SubscribeMessage('health:ping')
  onHealthPing(
    _client: IoSocket,
    _data: undefined,
    ack?: Ack<{ pong: number; online: number }>,
  ): void {
    ack?.({ ok: true, data: { pong: Date.now(), online: this.events.onlineCount } });
  }
}
