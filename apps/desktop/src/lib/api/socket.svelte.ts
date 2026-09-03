/**
 * 实时通道门面（Svelte 5 runes 模块，单例）。
 *
 * 公共 API 与迁移前完全一致（state/socketId/userId/lastError/latency/on/off/
 * onConnected/sendMessage/markRead/rawEmitAck/rawRpc/reconnect/disconnect/connect），
 * 底层唯一实现是 WebTransport（P4 起 Socket.IO 已删除）：
 * 配置（url + 证书指纹 + 版本门槛）经 GET /transport/config 下发，
 * welcome、推送分发、seq 跳号对账、latency 探测统一在门面处理。
 */
import type { ServerToClientEvents, WsChatMessage } from '@pigeon/shared-types';
import { tokenStore } from './http';
import { fetchTransportConfig } from '../transport/config';
import { WtTransport } from '../transport/webtransport';
import type { HandlerEntry, TransportHost, TransportState } from '../transport/types';

export type WsState = TransportState;

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

  private impl: WtTransport | null = null;
  private latencyTimer: ReturnType<typeof setInterval> | null = null;
  /** 连接建立回调（每次 connect 触发，含首次与重连）：断线期间错过的推送无法回放，由订阅方对账刷新 */
  private connectedListeners = new Set<() => void>();
  /**
   * 业务 handler 注册表：disconnect() 之后保留，重连后照常分发
   * （保证跨重连/重登的生命周期）。
   */
  private handlerList: HandlerEntry[] = [];

  /** 幂等连接：已连接/连接中时重复调用无效 */
  connect(): void {
    if (this.impl) return;
    this.intentionalClose = false;
    this.state = 'connecting';
    this.impl = new WtTransport(this.host(), fetchTransportConfig, 'desktop');
    this.impl.connect();
  }

  /** 主动断开（登出等场景）。业务 handler 保留，重连后自动分发 */
  disconnect(): void {
    this.intentionalClose = true;
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

  // ── TransportHost 回调 ────────────────────────────────────

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
  }

  off<K extends keyof ServerToClientEvents>(
    event: K,
    handler: ServerToClientEvents[K],
  ): void {
    this.handlerList = this.handlerList.filter((h) => h.event !== event || h.handler !== handler);
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

  // ── 业务封装（RPC → Promise） ─────────────────────────────

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

  /**
   * 通用 RPC（ack → Promise）：音视频通话信令等新增 C2S 事件走这里，
   * 无需在门面逐个包一层。失败（ok=false / 超时 / 未连接）reject Error。
   */
  async rawRpc<T>(type: string, payload?: unknown): Promise<T> {
    return this.requireImpl().rpc<T>(type, payload);
  }

  // ── 内部 ──────────────────────────────────────────────────

  private intentionalClose = false;

  private requireImpl(): WtTransport {
    const impl = this.impl;
    if (!impl || !impl.isConnected()) {
      throw new Error('实时通道未连接，请稍后重试');
    }
    return impl;
  }

  /** 连接期间每 30s 探活一次，测 RTT（不依赖两端系统时钟）；health:ping 由 Rust 本地应答 */
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
