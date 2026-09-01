/**
 * Socket.IO 连接管理（Svelte 5 runes 模块，单例）。
 *
 * 与 alova（普通 HTTP）互补：实时事件（新消息、正在输入、在线状态）走这里。
 *
 * - 状态机：idle → connecting → connected ⇄ reconnecting/disconnected，
 *   组件直接读 `ws.state` 渲染连接指示器；
 * - 鉴权：握手 auth 以函数形式提供，每次（重）连都会重新读取 tokenStore，
 *   登录写入 token 后调用 `ws.reconnect()` 即可以新身份上线；
 * - 事件契约：事件名/载荷类型来自 @pigeon/shared-types，编译期约束两端；
 * - emit 封装：join/leave/sendMessage 返回 Promise，内部用 ack 并把
 *   `WsAck.ok=false` 转成异常，业务侧 try/catch 即可。
 */
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  WsAck,
  WsChatMessage,
} from '@pigeon/shared-types';
import { SERVER_URL } from './config';
import { tokenStore } from './http';

export type WsState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

/** 注意：客户端 Socket 泛型只有 E/S 两个参数（SocketData 仅服务端可用） */
export type WsSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 把 WsAck<T> 解包成 T；ok=false 时抛错（与 HTTP ApiError 风格一致） */
function unwrapAck<T>(res: WsAck<T>): T {
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

class SocketManager {
  // ── 响应式状态（组件可直接读取渲染） ──────────────────────
  state = $state<WsState>('idle');
  socketId = $state<string | null>(null);
  /** 服务端在 connection:welcome 里分配的身份 */
  userId = $state<string>('');
  lastError = $state<string | null>(null);
  /** 最近一次 health:ping 往返延迟（ms），未测量时为 null */
  latency = $state<number | null>(null);

  private socket: WsSocket | null = null;
  private intentionalClose = false;
  private latencyTimer: ReturnType<typeof setInterval> | null = null;
  /** 连接建立回调（每次 connect 触发，含首次与重连）：断线期间错过的推送无法回放，由订阅方对账刷新 */
  private connectedListeners = new Set<() => void>();
  /**
   * 业务 handler 注册表：disconnect() 会 removeAllListeners，
   * 重建连接后从这里重新绑定（保证跨重连/重登的生命周期）。
   */
  private handlerList: {
    event: keyof ServerToClientEvents;
    handler: ServerToClientEvents[keyof ServerToClientEvents];
  }[] = [];

  /** 幂等连接：已连接/连接中时重复调用无效 */
  connect(): void {
    if (this.socket) return;
    this.intentionalClose = false;
    this.state = 'connecting';

    const socket: WsSocket = io(SERVER_URL, {
      // Tauri webview 支持 ws，直连省去轮询升级；如需兼容 restrictive
      // 代理可改回 ['websocket', 'polling']
      transports: ['websocket'],
      // auth 用函数形式：每次（重）连都重新读 token，登录后无需重建 socket
      auth: (cb) => cb({ token: tokenStore.get() || undefined, displayName: '我' }),
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
      // 心跳与服务端 pingInterval/pingTimeout 对齐（默认值即 25s/20s）
    });
    this.socket = socket;
    // 重新绑定业务 handler（跨重连/重登存活）
    for (const { event, handler } of this.handlerList) {
      socket.on(event, handler as never);
    }

    socket.on('connect', () => {
      this.state = 'connected';
      this.socketId = socket.id ?? null;
      this.lastError = null;
      this.startLatencyProbe();
      // 重连成功 ≠ 状态如旧：服务端重启/断网期间的 presence、消息推送都丢过，
      // 这里通知订阅方做对账刷新（见 ws.onConnected）
      for (const cb of this.connectedListeners) cb();
    });

    socket.on('connection:welcome', (payload) => {
      this.userId = payload.userId;
    });

    socket.on('disconnect', (reason) => {
      this.stopLatencyProbe();
      this.socketId = null;
      // 主动断开不会重连；被动断开交给 socket.io 自动重连
      this.state = this.intentionalClose ? 'disconnected' : 'reconnecting';
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', (err) => {
      this.lastError = err.message;
      this.state = 'reconnecting';
    });
  }

  /** 主动断开（登出等场景）。业务 handler 保留，重连后自动重绑 */
  disconnect(): void {
    if (!this.socket) return;
    this.intentionalClose = true;
    this.stopLatencyProbe();
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.socketId = null;
    this.state = 'disconnected';
  }

  /** 以当前 tokenStore 里的 token 重新握手（登录/登出后调用） */
  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  // ── 事件订阅透传（组件里建议在 $effect 中订阅并返回 off 清理） ──
  // 注：socket.io-client 的条件监听器类型与泛型 K 不兼容，内部做一次窄化，
  // 对外仍保持完整的事件名/载荷类型约束。
  private typed(): {
    on<K extends keyof ServerToClientEvents>(event: K, handler: ServerToClientEvents[K]): void;
    off<K extends keyof ServerToClientEvents>(event: K, handler: ServerToClientEvents[K]): void;
  } | null {
    return this.socket as never;
  }

  on<K extends keyof ServerToClientEvents>(
    event: K,
    handler: ServerToClientEvents[K],
  ): void {
    this.handlerList = [
      ...this.handlerList.filter((h) => h.event !== event || h.handler !== handler),
      { event, handler },
    ];
    this.typed()?.on(event, handler);
  }

  /**
   * 注册「连接建立」回调（含首次连接与每次重连），返回取消注册函数。
   * 用途：断线/服务端重启期间错过的推送（presence、消息）无法回放，
   * 订阅方在此对账刷新本地状态。
   */
  onConnected(cb: () => void): () => void {
    this.connectedListeners.add(cb);
    return () => this.connectedListeners.delete(cb);
  }

  off<K extends keyof ServerToClientEvents>(
    event: K,
    handler: ServerToClientEvents[K],
  ): void {
    this.handlerList = this.handlerList.filter((h) => h.event !== event || h.handler !== handler);
    this.typed()?.off(event, handler);
  }

  // ── 业务封装（ack → Promise） ─────────────────────────────

  /** 加入会话房间；之后该会话的 message:new 会推送过来 */
  async joinConversation(conversationId: string): Promise<string[]> {
    const socket = this.requireConnected();
    const res = await socket.emitWithAck('conversation:join', conversationId);
    return unwrapAck(res).joined;
  }

  async leaveConversation(conversationId: string): Promise<string[]> {
    const socket = this.requireConnected();
    const res = await socket.emitWithAck('conversation:leave', conversationId);
    return unwrapAck(res).joined;
  }

  /**
   * 发送消息，resolve 服务端生成的完整消息（含 id/createdAt）；失败 reject。
   * clientMsgId 由调用方生成（UUID）：网络重试/多端同步时幂等去重；
   * replyToId = 被引用消息的服务端 id。
   */
  async sendMessage(
    conversationId: string,
    content: string,
    kind: WsChatMessage['kind'] = 'text',
    clientMsgId?: string,
    replyToId?: string,
    mentions?: string[],
  ): Promise<WsChatMessage> {
    const socket = this.requireConnected();
    const res = await socket.emitWithAck('message:send', {
      conversationId,
      content,
      kind,
      ...(clientMsgId ? { clientMsgId } : {}),
      ...(replyToId ? { replyToId } : {}),
      ...(mentions?.length ? { mentions } : {}),
    });
    return unwrapAck(res);
  }

  /** 通用 ack 事件调用（reaction:add/remove 等） */
  async rawEmitAck(
    event: 'reaction:add' | 'reaction:remove' | 'message:read',
    payload: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    const socket = this.requireConnected();
    // 泛型事件名通道对多态 payload 不友好，此处窄化直调
    const res = (await (socket as unknown as {
      emitWithAck: (ev: string, p: unknown) => Promise<{ ok: boolean; error?: string }>;
    }).emitWithAck(event, payload));
    return res;
  }

  /** 标记会话已读（服务端同时把已读回执推给对端） */
  async markRead(conversationId: string): Promise<void> {
    if (!this.socket?.connected) return; // 离线时静默跳过，打开会话后由 REST 补偿
    const res = await this.socket.emitWithAck('message:read', { conversationId });
    unwrapAck(res);
  }

  typingStart(conversationId: string, displayName?: string): void {
    this.socket?.emit('typing:start', { conversationId, displayName });
  }

  typingStop(conversationId: string): void {
    this.socket?.emit('typing:stop', { conversationId });
  }

  // ── 内部 ──────────────────────────────────────────────────

  private requireConnected(): WsSocket {
    if (!this.socket || !this.socket.connected) {
      throw new Error('WebSocket 未连接，请稍后重试');
    }
    return this.socket;
  }

  /** 连接期间每 30s 探活一次，测 RTT（不依赖两端系统时钟） */
  private startLatencyProbe(): void {
    this.stopLatencyProbe();
    this.latencyTimer = setInterval(async () => {
      const socket = this.socket;
      if (!socket?.connected) return;
      const t0 = Date.now();
      try {
        const res = await socket.emitWithAck('health:ping');
        if (!res.ok) return;
        this.latency = Date.now() - t0;
      } catch {
        /* 探活失败不打扰用户，state 会由 connect_error 反映 */
      }
    }, 30_000);
    // 立即先测一次
    const socket = this.socket;
    if (socket?.connected) {
      const t0 = Date.now();
      void socket
        .emitWithAck('health:ping')
        .then((res) => {
          if (res.ok) this.latency = Date.now() - t0;
        })
        .catch(() => {});
    }
  }

  private stopLatencyProbe(): void {
    if (this.latencyTimer) {
      clearInterval(this.latencyTimer);
      this.latencyTimer = null;
    }
  }
}

export const ws = new SocketManager();
