import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { createHash, randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
  WsAckCallback,
  WsChatMessage,
} from '@pigeon/shared-types';
import { Inject } from '@nestjs/common';
import { allowedOrigins } from '../config.js';
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

  /** userId → 在线 socketId 集合，用于 presence 广播 */
  private readonly online = new Map<string, Set<string>>();

  // 注意：本仓库用 swc/esbuild 编译，不产出装饰器元数据，
  // 因此依赖注入一律显式 @Inject（见 app.controller.ts），
  // WS 消息处理器用普通参数而非 @MessageBody。
  constructor(
    @Inject(WsEventsService) private readonly events: WsEventsService,
  ) {}

  afterInit(server: IoServer): void {
    // 把 io 句柄交给桥接服务，HTTP 侧即可注入 WsEventsService 做推送
    this.events.bind(server);
    this.logger.log('Socket.IO gateway ready');
  }

  async handleConnection(client: IoSocket): Promise<void> {
    const token = (client.handshake.auth?.token as string | undefined) ?? '';

    // TODO(安全): 接入登录后在此验签 JWT：
    //   const payload = await this.jwt.verify(token) → { userId, displayName }
    //   验签失败：client.emit('exception', ...) + client.disconnect(true)
    // 当前骨架：有 token 时透传为临时身份；无 token 且非 strict 模式则分配游客身份。
    const strict = process.env.WS_STRICT_AUTH === 'true';
    if (!token && strict) {
      this.logger.warn(`rejected unauthenticated handshake ${client.id}`);
      client.disconnect(true);
      return;
    }

    // 占位身份：token 的 sha256 前 16 位（不同 token → 不同用户，且不泄露原始 token）。
    // 接入 JWT 后替换为验签得到的 payload.userId。
    const userIdFromToken = (t: string) =>
      `user:${createHash('sha256').update(t).digest('hex').slice(0, 16)}`;
    client.data.userId = token ? userIdFromToken(token) : `guest:${randomUUID().slice(0, 8)}`;
    client.data.displayName = client.handshake.auth?.displayName as string | undefined ??
      client.data.userId;
    client.data.connectedAt = Date.now();

    // 加入个人房间，便于定向推送（后续配合真实登录使用）
    await client.join(`user:${client.data.userId}`);

    const firstSocketOfUser = !this.online.has(client.data.userId);
    const sockets = this.online.get(client.data.userId) ?? new Set<string>();
    sockets.add(client.id);
    this.online.set(client.data.userId, sockets);

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

    const sockets = this.online.get(userId);
    sockets?.delete(client.id);
    if (sockets && sockets.size === 0) {
      this.online.delete(userId);
      // 该用户的最后一路连接断开 → 广播离线
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

  @SubscribeMessage('message:send')
  async onMessageSend(
    client: IoSocket,
    payload: { conversationId: string; content: string; kind?: WsChatMessage['kind'] },
    ack?: Ack<WsChatMessage>,
  ): Promise<void> {
    const { conversationId, content } = payload;
    if (!conversationId || !content?.trim()) {
      ack?.({ ok: false, error: 'conversationId and content are required' });
      return;
    }

    // TODO(业务): 校验 client.data.userId 是否为该会话成员（查 Prisma），
    // 通过后再落库并把 DB id 填进 message.id，最后广播。
    const message: WsChatMessage = {
      id: randomUUID(),
      conversationId,
      senderId: client.data.userId,
      senderName: client.data.displayName,
      kind: payload.kind ?? 'text',
      content,
      createdAt: Date.now(),
    };

    // 先 ack（发送方获得回执），再向房间广播（含发送方自己的其他设备）
    ack?.({ ok: true, data: message });
    this.server.to(`conversation:${conversationId}`).emit('message:new', message);
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
