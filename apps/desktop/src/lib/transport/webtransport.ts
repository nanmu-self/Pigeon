import type { RtHello, RtHelloResult, RtResponse, TransportConfig } from '@pigeon/shared-types';
import { CLIENT_PROTO, type TransportHost, type TransportImpl } from './types';
import { FrameReader, writeFrame } from './frame';
import { fetchTransportConfig } from './config';

/**
 * WebTransport 传输实现（连接状态机，§7）。
 *
 * - 连接：new WebTransport(url, {serverCertificateHashes}) → ready（8s 超时）
 * - hello：bi 流 #0 发 {v:1, type:'hello', token, clientProto} → welcome/error
 * - RPC：每请求一条新 bi 流（天然并发），10s 超时 reject
 * - 推送：服务端开的单向流，{seq, type, payload} 顺序帧；
 *   seq 跳号 / resync 帧 → onReconcile（复用 onConnected 同一套全量对账）
 * - 重连：closed → 1s 起指数退避 + 随机抖动（上限 5s）；
 *   连续 auth_failed/token_expired ≥ 3 次 → 停止重连并提示重新登录
 *   （项目无 refresh token，7 天 token 过期后要求重新登录是预期行为）
 */

const READY_TIMEOUT_MS = 8_000;
const RPC_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 8_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 5_000;
const MAX_AUTH_FAILURES = 3;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class WtTransport implements TransportImpl {
  private wt: WebTransport | null = null;
  private intentionalClose = false;
  private stopped = false;

  private rpcId = 0;

  private authFailures = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: TransportHost,
    /** 每次重连前重新取配置（服务端可灰度/回退，指纹也可能轮换） */
    private readonly getConfig: () => Promise<TransportConfig>,
    private readonly clientVersion: string,
  ) {}

  connect(): void {
    this.intentionalClose = false;
    void this.start();
  }

  private async start(): Promise<void> {
    if (this.stopped || this.wt) return;
    this.host.onState('connecting');
    try {
      // 1. 每次连接前取配置（禁长缓存）
      const config = await this.getConfig();
      if (this.stopped) return;
      if (config.transport !== 'wt') {
        // 服务端把开关切回 socket（灰度/回退）→ 交还门面重选实现
        this.host.onState('reconnecting', '服务端已切换实时通道');
        this.notifyTransportSwitch('socket');
        return;
      }
      if (CLIENT_PROTO < config.minClientProto) {
        this.host.onState('disconnected', '客户端版本过旧，请升级 Pigeon 后重新登录');
        return;
      }

      // 2. QUIC 握手（ready 8s 超时）
      const hashes = config.certSha256.map((v) => ({
        algorithm: 'SHA-256' as const,
        value: base64ToBytes(v),
      }));
      const wt = new WebTransport(config.url, {
        serverCertificateHashes: hashes,
        congestionControl: 'low-latency',
      });
      this.wt = wt;
      await withTimeout(wt.ready, READY_TIMEOUT_MS, 'WebTransport 连接超时');

      // 3. hello 鉴权 + 版本协商
      const result = await this.sayHello(wt);
      if (this.stopped) return;
      if (result.type === 'error') {
        await wt.close({ closeCode: 1, reason: result.code });
        this.wt = null;
        if (result.code === 'client_too_old') {
          this.host.onState('disconnected', '客户端版本过旧，请升级 Pigeon 后重新登录');
          return; // 强制升级提示，不重连
        }
        if (result.code === 'auth_failed' || result.code === 'token_expired') {
          this.authFailures += 1;
          if (this.authFailures >= MAX_AUTH_FAILURES) {
            this.host.onState('disconnected', '登录状态已失效，请重新登录');
            return; // 停止重连风暴：无 refresh token，重新登录是唯一出路
          }
          throw new Error('登录状态已失效，正在重试…');
        }
        throw new Error(result.message ?? `握手失败: ${result.code}`);
      }

      // 4. 就绪
      this.authFailures = 0;
      this.reconnectAttempt = 0;
      this.host.onWelcome(result.connId, result.userId);
      this.host.onState('connected', null);
      this.host.onConnected();

      // 5. 推送流消费 + closed 监听
      void this.readPushStreams(wt);
      void wt.closed.then((error) => {
        if (this.stopped || this.intentionalClose) return;
        this.wt = null;
        this.host.onState('reconnecting', error?.reason || '连接已断开');
        this.scheduleReconnect();
      });
    } catch (error) {
      if (this.stopped || this.intentionalClose) return;
      this.wt = null;
      const message = error instanceof Error ? error.message : String(error);
      this.host.onState('reconnecting', message);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.stopped = true;
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.wt) {
      const wt = this.wt;
      this.wt = null;
      void wt.close({ closeCode: 0, reason: 'client disconnect' });
    }
  }

  isConnected(): boolean {
    return this.wt !== null;
  }

  syncHandlers(): void {
    /* wt 推送统一经 host.onPush 分发，无需绑定 */
  }

  /** RPC：每请求一条新 bi 流，{id, type, payload} → {id, ok, data|error} */
  async rpc<T>(type: string, payload?: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    const wt = this.wt;
    if (!wt) throw new Error('实时通道未连接，请稍后重试');
    const id = ++this.rpcId;
    const bi = await wt.createBidirectionalStream();
    const request = { id, type, ...(payload === undefined ? {} : { payload }) };
    await writeFrame(bi.writable, request);

    const response = await withTimeout(
      new FrameReader(bi.readable).read<RtResponse>(),
      timeoutMs,
      `请求超时（${type}）`,
    );
    if (!response || response.id !== id || response.ok !== true) {
      const error = response && response.ok === false ? response.error : '服务器开小差了，请稍后再试';
      throw new Error(error);
    }
    return response.data as T;
  }

  // ── 内部 ──────────────────────────────────────────────────

  private async sayHello(wt: WebTransport): Promise<RtHelloResult> {
    const bi = await wt.createBidirectionalStream();
    const hello: RtHello = {
      v: 1,
      type: 'hello',
      token: this.host.getToken(),
      clientProto: CLIENT_PROTO,
      clientVersion: this.clientVersion,
    };
    await writeFrame(bi.writable, hello);
    return withTimeout(new FrameReader(bi.readable).read<RtHelloResult>(), HELLO_TIMEOUT_MS, 'hello 超时');
  }

  /** 服务端开的单向推送流（可能多条：每条 seq 独立从 1 起） */
  private async readPushStreams(wt: WebTransport): Promise<void> {
    const reader = wt.incomingUnidirectionalStreams.getReader();
    for (;;) {
      let result: ReadableStreamReadResult<ReadableStream<Uint8Array>>;
      try {
        result = await reader.read();
      } catch {
        return; // closed 会另行处理
      }
      if (result.done) return;
      void this.consumePushStream(result.value);
    }
  }

  private async consumePushStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = new FrameReader(stream);
    let expectedSeq = 1; // 每条流独立计数
    for (;;) {
      let frame: { seq: number; type: string; payload: unknown };
      try {
        frame = await reader.read();
      } catch {
        return; // 流结束（服务端 close/shutdown）；连接级 closed 兜底
      }
      if (frame.type === 'going_away') {
        // 服务端滚动更新：立即重连，不等 idle timeout
        this.host.onState('reconnecting', '服务器正在更新，即将重连');
        continue;
      }
      if (frame.type === 'resync') {
        // 服务端背压丢帧：全量对账 + 对齐水位
        this.host.onReconcile();
        expectedSeq = frame.seq + 1;
        continue;
      }
      if (frame.seq < expectedSeq) continue; // 重复帧，忽略
      if (frame.seq > expectedSeq) {
        // 跳号：丢过帧 → 全量对账（与 onConnected 同一套补偿链路）
        this.host.onReconcile();
      }
      expectedSeq = frame.seq + 1;
      this.host.onPush(frame.type as never, frame.payload);
    }
  }

  /** 指数退避 + 随机抖动重连（1s 起，上限 5s） */
  private scheduleReconnect(): void {
    if (this.stopped || this.intentionalClose || this.reconnectTimer) return;
    const attempt = ++this.reconnectAttempt;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    const jitter = backoff * 0.2 * Math.random();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, backoff + jitter);
  }

  private notifyTransportSwitch(mode: 'socket'): void {
    this.stopped = true;
    this.onSwitch?.(mode);
  }

  /** 门面注入：服务端下发 switch 时重建另一实现 */
  onSwitch: ((mode: 'socket') => void) | null = null;
}

/** base64 → Uint8Array（serverCertificateHashes.value 要原始摘要字节） */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
