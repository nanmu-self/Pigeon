/**
 * 实时通道门面（Svelte 5 runes 模块，单例）。
 *
 * 公共 API 与迁移前完全一致（state/socketId/userId/lastError/latency/on/off/
 * onConnected/sendMessage/markRead/rawEmitAck/reconnect/disconnect/connect），
 * 内部按「实现选择顺序」挑选底层传输（决策 D5）：
 *
 *   1. VITE_TRANSPORT（构建期，仅本地开发覆盖用）
 *   2. GET /transport/config 的 transport 字段（生产权威：服务端灰度/回退开关）
 *   3. 不支持 WebTransport（WebView2 过旧 / 非 secure context）→ 自动回退 socket
 *
 * 底层实现（socket.io 与 WebTransport）只与 TransportHost 回调接口对话：
 * 状态、welcome、推送分发、seq 跳号对账、latency 探测统一在门面处理。
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
import { fetchTransportConfig } from '../transport/config';
import { WtTransport } from '../transport/webtransport';
import type { HandlerEntry, TransportHost, TransportImpl, TransportState } from '../transport/types';

export type WsState = TransportState;

/** 注意：客户端 Socket 泛型只有 E/S 两个参数（SocketData 仅服务端可用） */
export type WsSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** 把 WsAck<T> 解包成 T；ok=false 时抛错（与 HTTP ApiError 风格一致） */
function unwrapAck<T>(res: WsAck<T>): T {
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// ── Socket.IO 实现（迁移前路径，保留至 P4 删除） ──────────────────

class SocketIoTransport implements TransportImpl {
  private socket: WsSocket | null = null;
  /** 已绑定到 socket.io 的业务 handler（off 时精确解绑用） */
  private bound: HandlerEntry[] = [];

  constructor(private readonly host: TransportHost) {}

  connect(): void {
    if (this.socket) return;
    const socket: WsSocket = io(SERVER_URL, {
      // Tauri webview 支持 ws，直连省去轮询升级；如需兼容 restrictive
      // 代理可改回 ['websocket', 'polling']
      transports: ['websocket'],
      // auth 用函数形式：每次（重）连都重新读 token，登录后无需重建 socket
      auth: (cb) => cb({ token: this.host.getToken() || undefined, displayName: '我' }),
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 5_000,
      // 心跳与服务端 pingInterval/pingTimeout 对齐（默认值即 25s/20s）
    });
    this.socket = socket;
    // 重新绑定业务 handler（跨重连/重登存活）
    this.syncHandlers();

    socket.on('connect', () => {
      this.host.onWelcome(socket.id ?? '', '');
      this.host.onState('connected', null);
      this.host.onConnected();
    });

    socket.on('connection:welcome', (payload) => {
      this.host.onWelcome(payload.socketId, payload.userId);
    });

    socket.on('disconnect', (reason) => {
      // 主动断开不会重连；被动断开交给 socket.io 自动重连
      this.host.onState(this.intentionalClose ? 'disconnected' : 'reconnecting', reason);
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', (err) => {
      this.host.onState('reconnecting', err.message);
    });
  }

  disconnect(): void {
    if (!this.socket) return;
    this.intentionalClose = true;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
  }

  private intentionalClose = false;

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** 注册表变化后补绑新增 / 解绑移除的 handler（组件可在连接后订阅） */
  syncHandlers(): void {
    const socket = this.socket;
    if (!socket) return;
    const current = this.host.getHandlers();
    for (const { event, handler } of current) {
      const already = this.bound.some((b) => b.event === event && b.handler === handler);
      if (!already) {
        socket.on(event, handler as never);
        this.bound.push({ event, handler });
      }
    }
    this.bound = this.bound.filter((b) => {
      const still = current.some((h) => h.event === b.event && h.handler === b.handler);
      if (!still) {
        socket.off(b.event, b.handler as never);
        return false;
      }
      return true;
    });
  }

  rpc<T>(type: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    void timeoutMs;
    const socket = this.socket;
    if (!socket || !socket.connected) throw new Error('WebSocket 未连接，请稍后重试');
    // 泛型事件名通道对多态 payload 不友好，此处窄化直调
    const emit = (
      socket as unknown as {
        emitWithAck: (ev: string, p: unknown) => Promise<WsAck<never>>;
      }
    ).emitWithAck.bind(socket);
    return emit(type, payload).then((res) => unwrapAck<T>(res));
  }

  /** join/leave 走原始 ack 形状（返回 joined 列表） */
  emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return this.rpc<T>(event, payload);
  }

  typingStart(conversationId: string, displayName?: string): void {
    this.socket?.emit('typing:start', { conversationId, displayName });
  }

  typingStop(conversationId: string): void {
    this.socket?.emit('typing:stop', { conversationId });
  }
}

// ── 门面 ──────────────────────────────────────────────────────

class SocketManager {
  // ── 响应式状态（组件可直接读取渲染） ──────────────────────
  state = $state<WsState>('idle');
  socketId = $state<string | null>(null);
  /** 服务端在 hello/welcome 里分配的身份 */
  userId = $state<string>('');
  lastError = $state<string | null>(null);
  /** 最近一次 health:ping 往返延迟（ms），未测量时为 null */
  latency = $state<number | null>(null);

  private impl: TransportImpl | null = null;
  private configRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private latencyTimer: ReturnType<typeof setInterval> | null = null;
  /** 连接建立回调（每次 connect 触发，含首次与重连）：断线期间错过的推送无法回放，由订阅方对账刷新 */
  private connectedListeners = new Set<() => void>();
  /**
   * 业务 handler 注册表：disconnect() 之后从这里重新绑定
   * （保证跨重连/重登的生命周期）。
   */
  private handlerList: HandlerEntry[] = [];

  /** 幂等连接：已连接/连接中时重复调用无效 */
  connect(): void {
    if (this.impl) return;
    this.intentionalClose = false;
    this.state = 'connecting';
    void this.start();
  }

  /** 实现选择 + 建立连接（异步入口，状态全部经 onState 反馈） */
  private async start(): Promise<void> {
    let mode: 'wt' | 'socket';
    const override = import.meta.env.VITE_TRANSPORT as string | undefined;
    if (override === 'wt' || override === 'socket') {
      mode = override; // 本地开发覆盖（仅 dev 有意义，生产包内联慎用）
    } else {
      try {
        const config = await fetchTransportConfig();
        if (this.intentionalClose || this.impl) return;
        mode = config.transport;
      } catch (error) {
        if (this.intentionalClose || this.impl) return;
        const status = (error as { status?: number }).status;
        if (status === 401) {
          // 未登录/过期：不连接（登录成功后调用 ws.reconnect()）
          this.state = 'disconnected';
          this.lastError = '登录状态已失效，请重新登录';
          return;
        }
        this.state = 'reconnecting';
        this.lastError = '无法获取实时通道配置，正在重试…';
        this.scheduleConfigRetry();
        return;
      }
    }
    if (mode === 'wt' && typeof WebTransport === 'undefined') {
      // WebView2 过旧 / 非 secure context → 自动回退 Socket.IO（§7）
      mode = 'socket';
    }

    if (mode === 'wt') {
      const transport = new WtTransport(this.host(), fetchTransportConfig, 'desktop');
      transport.onSwitch = (nextMode) => {
        // 服务端把开关切回 socket：重建实现
        this.impl = null;
        this.socketId = null;
        this.stopLatencyProbe();
        if (nextMode === 'socket') {
          this.impl = new SocketIoTransport(this.host());
          this.impl.connect();
        }
      };
      this.impl = transport;
    } else {
      this.impl = new SocketIoTransport(this.host());
    }
    this.impl.connect();
  }

  /** 配置获取失败的退避重试（2s；连接成功后自然失效） */
  private scheduleConfigRetry(): void {
    if (this.configRetryTimer || this.intentionalClose) return;
    this.configRetryTimer = setTimeout(() => {
      this.configRetryTimer = null;
      if (!this.impl && !this.intentionalClose) void this.start();
    }, 2_000);
  }

  /** 主动断开（登出等场景）。业务 handler 保留，重连后自动重绑 */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.configRetryTimer) {
      clearTimeout(this.configRetryTimer);
      this.configRetryTimer = null;
    }
    this.stopLatencyProbe();
    this.impl?.disconnect();
    this.impl = null;
    this.socketId = null;
    this.state = 'disconnected';
  }

  /** 以当前 tokenStore 里的 token 重新握手（登录/登出后调用） */
  reconnect(): void {
    this.disconnect();
    this.connect();
  }

  // ── TransportHost 回调（两种实现共用） ──────────────────────

  private host(): TransportHost {
    return {
      getToken: () => tokenStore.get(),
      getHandlers: () => this.handlerList,
      onState: (state, error) => {
        this.state = state;
        this.lastError = error ?? null;
        if (state === 'connected') this.startLatencyProbe();
        else this.stopLatencyProbe();
      },
      onWelcome: (socketId, userId) => {
        this.socketId = socketId || this.socketId;
        if (userId) this.userId = userId;
      },
      onPush: (type, payload) => {
        for (const { event, handler } of this.handlerList) {
          if (event === type) (handler as (p: unknown) => void)(payload);
        }
      },
      onReconcile: () => {
        // seq 跳号 / resync：与重连成功同一套对账链路
        for (const cb of this.connectedListeners) cb();
      },
      onConnected: () => {
        this.lastError = null;
        for (const cb of this.connectedListeners) cb();
      },
    };
  }

  // ── 事件订阅透传（组件里建议在 $effect 中订阅并返回 off 清理） ──
  on<K extends keyof ServerToClientEvents>(
    event: K,
    handler: ServerToClientEvents[K],
  ): void {
    this.handlerList = [
      ...this.handlerList.filter((h) => h.event !== event || h.handler !== handler),
      { event, handler },
    ];
    this.impl?.syncHandlers();
  }

  off<K extends keyof ServerToClientEvents>(
    event: K,
    handler: ServerToClientEvents[K],
  ): void {
    this.handlerList = this.handlerList.filter((h) => h.event !== event || h.handler !== handler);
    this.impl?.syncHandlers();
  }

  /**
   * 注册「连接建立」回调（含首次连接与每次重连），返回取消注册函数。
   * 用途：断线/服务端重启期间错过的推送（presence、消息）无法回放，
   * 订阅方在此对账刷新本地状态。WT 推送流 seq 跳号 / resync 帧也触发同一回调。
   */
  onConnected(cb: () => void): () => void {
    this.connectedListeners.add(cb);
    return () => this.connectedListeners.delete(cb);
  }

  // ── 业务封装（ack → Promise） ─────────────────────────────

  /** 加入会话房间；之后该会话的 message:new 会推送过来（协议保留位，暂无调用方） */
  async joinConversation(conversationId: string): Promise<string[]> {
    const result = await this.requireImpl().rpc<{ joined: string[] }>('conversation:join', conversationId);
    return result.joined;
  }

  async leaveConversation(conversationId: string): Promise<string[]> {
    const result = await this.requireImpl().rpc<{ joined: string[] }>('conversation:leave', conversationId);
    return result.joined;
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
    return this.requireImpl().rpc<WsChatMessage>('message:send', {
      conversationId,
      content,
      kind,
      ...(clientMsgId ? { clientMsgId } : {}),
      ...(replyToId ? { replyToId } : {}),
      ...(mentions?.length ? { mentions } : {}),
    });
  }

  /** 通用 ack 事件调用（reaction:add/remove 等） */
  async rawEmitAck(
    event: 'reaction:add' | 'reaction:remove' | 'message:read',
    payload: unknown,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const data = await this.requireImpl().rpc<unknown>(event, payload);
      return { ok: true, ...(data === undefined ? {} : { error: undefined }) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 标记会话已读（服务端同时把已读回执推给对端） */
  async markRead(conversationId: string): Promise<void> {
    if (!this.impl?.isConnected()) return; // 离线时静默跳过，打开会话后由 REST 补偿
    await this.impl.rpc<void>('message:read', { conversationId });
  }

  // typing 是协议保留位（D2 确认无调用方）：socket 实现照发，WT 实现静默跳过
  typingStart(conversationId: string, displayName?: string): void {
    (this.impl as SocketIoTransport | null)?.typingStart?.(conversationId, displayName);
  }

  typingStop(conversationId: string): void {
    (this.impl as SocketIoTransport | null)?.typingStop?.(conversationId);
  }

  // ── 内部 ──────────────────────────────────────────────────

  private intentionalClose = false;

  private requireImpl(): TransportImpl {
    const impl = this.impl;
    if (!impl || !impl.isConnected()) {
      throw new Error('WebSocket 未连接，请稍后重试');
    }
    return impl;
  }

  /** 连接期间每 30s 探活一次，测 RTT（不依赖两端系统时钟）；health:ping 两种实现都支持 */
  private startLatencyProbe(): void {
    this.stopLatencyProbe();
    const probe = async (): Promise<void> => {
      const impl = this.impl;
      if (!impl?.isConnected()) return;
      const t0 = Date.now();
      try {
        await impl.rpc('health:ping', undefined);
        this.latency = Date.now() - t0;
      } catch {
        /* 探活失败不打扰用户，state 会由连接回调反映 */
      }
    };
    this.latencyTimer = setInterval(() => void probe(), 30_000);
    // 立即先测一次
    void probe();
  }

  private stopLatencyProbe(): void {
    if (this.latencyTimer) {
      clearInterval(this.latencyTimer);
      this.latencyTimer = null;
    }
  }
}

export const ws = new SocketManager();
