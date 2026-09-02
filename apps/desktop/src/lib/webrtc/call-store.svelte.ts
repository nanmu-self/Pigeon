/**
 * 音视频通话状态机（Svelte 5 runes 单例）。
 *
 * 拓扑：媒体走 WebRTC P2P（RTCPeerConnection 直连，服务器不碰流）；
 * 信令（invite/accept/SDP/ICE）走实时通道门面 ws（Socket.IO 与
 * WebTransport 双轨通用，载荷契约见 @pigeon/shared-types「音视频通话」节）。
 *
 * 角色：主叫固定为 offerer、被叫固定为 answerer（1:1 无 glare，
 * 不需要 perfect negotiation）。ICE candidate 在远端描述就绪前到达
 * 时进入 pendingIce 队列，setRemoteDescription 后补齐。
 */
import type { CallMedia, CallSignal, PublicUser } from '@pigeon/shared-types';
import { ws } from '$lib/api/socket.svelte';
import { showToast } from '$lib/toast';

export type CallStatus = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected';

/** 与服务端 RING_TIMEOUT_MS 对齐（留 2s 余量，让服务端的 cancelled 先到） */
const RING_GUARD_MS = 47_000;

/** 公网打洞用 STUN；日后自部署 coturn / 本机内网直连均可 */
const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

export interface CallPeer {
  id: string;
  name: string;
  avatarUrl?: string;
}

class CallStore {
  status = $state<CallStatus>('idle');
  /** 'audio' | 'video'（本次通话的媒体类型） */
  media = $state<CallMedia>('audio');
  peer = $state<CallPeer | null>(null);
  callId = $state<string | null>(null);
  /** 我是主叫还是被叫（决定谁发 offer） */
  direction = $state<'out' | 'in'>('out');

  localStream = $state<MediaStream | null>(null);
  remoteStream = $state<MediaStream | null>(null);
  micOn = $state(true);
  camOn = $state(true);
  pcState = $state<RTCPeerConnectionState>('new');
  /** 接通时刻（通话时长计时起点；null = 未接通） */
  connectedAt = $state<number | null>(null);

  private pc: RTCPeerConnection | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private ringTimer: ReturnType<typeof setTimeout> | null = null;

  get active(): boolean {
    return this.status !== 'idle';
  }

  // ── 主叫 ─────────────────────────────────────────────────

  /** 发起通话（消息页头部按钮入口）。失败 toast 并回落 idle。 */
  async start(peer: PublicUser, media: CallMedia): Promise<void> {
    if (this.active) {
      showToast('正在通话中');
      return;
    }
    if (!ws.userId) {
      showToast('连接已断开，请稍后重试');
      return;
    }
    this.direction = 'out';
    this.media = media;
    this.peer = { id: String(peer.id), name: peer.nickname, ...(peer.avatarUrl ? { avatarUrl: peer.avatarUrl } : {}) };
    this.status = 'outgoing';
    try {
      // 呼叫前先取媒体：权限/设备问题在振铃前暴露，避免接通后一方崩溃另一方干等
      await this.setupLocal();
    } catch (error) {
      this.cleanup();
      showToast(mediaErrorText(error));
      return;
    }
    this.armRingGuard();
    try {
      const res = await ws.rawRpc<{ callId: string; ringTimeoutMs: number }>('call:invite', {
        targetUserId: peer.id,
        media,
      });
      this.callId = res.callId;
    } catch (error) {
      showToast(error instanceof Error ? error.message : '发起通话失败');
      this.cleanup();
    }
  }

  // ── 被叫 ─────────────────────────────────────────────────

  /** 接听：取媒体 → 建 PC；offer 随后由 webrtc:signal 推来 */
  async accept(): Promise<void> {
    if (this.status !== 'incoming' || !this.callId) return;
    this.disarmRingGuard();
    this.status = 'connecting';
    try {
      await ws.rawRpc('call:accept', { callId: this.callId });
      await this.setupLocal();
      this.setupPeer();
    } catch (error) {
      showToast(mediaErrorText(error));
      await this.hangup();
    }
  }

  /** 拒接 */
  async reject(): Promise<void> {
    if (this.status !== 'incoming' || !this.callId) return;
    const { callId } = this;
    this.cleanup();
    try {
      await ws.rawRpc('call:reject', { callId });
    } catch {
      /* 服务端振铃超时会兜底 */
    }
  }

  // ── 双方通用 ─────────────────────────────────────────────

  /**
   * 挂断/取消。统一发 call:hangup —— 服务端按自己记录的状态映射：
   * 振铃中主叫挂断 → 对端收 cancelled；其余 → 对端收 ended。
   * （不能由客户端猜状态发 call:cancel：接通后 cancel 会被服务端拒绝，
   * 通话条目残留 → 双方都「正在通话中」死锁。）
   */
  async hangup(): Promise<void> {
    const { callId } = this;
    this.cleanup();
    if (!callId) return;
    try {
      await ws.rawRpc('call:hangup', { callId });
    } catch {
      /* 通话可能已被服务端清理 */
    }
  }

  toggleMic(): void {
    this.micOn = !this.micOn;
    for (const track of this.localStream?.getAudioTracks() ?? []) track.enabled = this.micOn;
  }

  toggleCam(): void {
    this.camOn = !this.camOn;
    for (const track of this.localStream?.getVideoTracks() ?? []) track.enabled = this.camOn;
  }

  // ── 信令处理（构造器里注册，跨重连存活） ─────────────────

  constructor() {
    ws.on('call:incoming', (payload) => {
      if (this.active) return; // 忙碌：不响铃，服务端超时后主叫收「无应答」
      this.direction = 'in';
      this.media = payload.media;
      this.callId = payload.callId;
      this.peer = { id: payload.fromUserId, name: payload.fromName };
      this.status = 'incoming';
      this.armRingGuard();
    });

    ws.on('call:accepted', () => {
      if (this.direction !== 'out' || !this.callId) return;
      this.disarmRingGuard();
      this.status = 'connecting';
      // 媒体已在 start() 取好；这里只建 PC + 发 offer
      this.setupPeer();
      this.createAndSendOffer().catch((error) => {
        showToast(error instanceof Error ? error.message : '通话建立失败');
        void this.hangup();
      });
    });

    ws.on('call:rejected', () => {
      showToast('对方已拒接');
      this.cleanup();
    });

    ws.on('call:cancelled', (payload) => {
      if (payload.callId !== this.callId) return;
      if (this.status === 'incoming' || this.status === 'outgoing') {
        showToast(payload.reason === 'missed' ? '对方无人接听' : '对方已取消');
      }
      this.cleanup();
    });

    ws.on('call:ended', (payload) => {
      if (payload.callId !== this.callId) return;
      showToast('通话已结束');
      this.cleanup();
    });

    ws.on('webrtc:signal', (payload) => {
      if (payload.callId !== this.callId || !this.pc) return;
      void this.onSignal(payload.data);
    });
  }

  // ── WebRTC 内部 ──────────────────────────────────────────

  private async setupLocal(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前环境不支持音视频采集（需要 HTTPS/Tauri 安全上下文）');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: this.media === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });
    this.localStream = stream;
    this.micOn = true;
    this.camOn = this.media === 'video';
  }

  private setupPeer(): void {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    this.pendingIce = [];
    this.pcState = pc.connectionState;
    pc.onconnectionstatechange = () => {
      this.pcState = pc.connectionState;
      if (pc.connectionState === 'connected' && this.status === 'connecting') {
        this.status = 'connected';
        this.connectedAt = Date.now();
      } else if (pc.connectionState === 'failed') {
        showToast('连接失败，请检查网络');
        void this.hangup();
      }
    };
    pc.onicecandidate = (event) => {
      if (event.candidate && this.callId) {
        void ws
          .rawRpc('webrtc:signal', {
            callId: this.callId,
            data: {
              type: 'ice',
              candidate: {
                candidate: event.candidate.candidate,
                ...(event.candidate.sdpMid != null ? { sdpMid: event.candidate.sdpMid } : {}),
                ...(event.candidate.sdpMLineIndex != null
                  ? { sdpMLineIndex: event.candidate.sdpMLineIndex }
                  : {}),
              },
            },
          })
          .catch(() => {});
      }
    };
    pc.ontrack = (event) => {
      this.remoteStream = event.streams[0] ?? null;
    };
    for (const track of this.localStream?.getTracks() ?? []) pc.addTrack(track, this.localStream!);
  }

  private async createAndSendOffer(): Promise<void> {
    const pc = this.pc;
    if (!pc || !this.callId) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await ws.rawRpc('webrtc:signal', { callId: this.callId, data: { type: 'offer', sdp: offer.sdp ?? '' } });
  }

  private async onSignal(data: CallSignal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (this.callId) {
          await ws.rawRpc('webrtc:signal', { callId: this.callId, data: { type: 'answer', sdp: answer.sdp ?? '' } });
        }
      } else if (data.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
        }
      } else {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(data.candidate);
        } else {
          this.pendingIce.push(data.candidate); // 远端描述未就绪，先排队
        }
      }
      // answer 落定后补投递排队中的 ICE
      if (pc.remoteDescription && this.pendingIce.length) {
        const queued = this.pendingIce.splice(0);
        for (const candidate of queued) await pc.addIceCandidate(candidate);
      }
    } catch {
      /* 单个 candidate/信令失败不致命，后续 candidate 会自愈 */
    }
  }

  // ── 生命周期 ─────────────────────────────────────────────

  private armRingGuard(): void {
    this.disarmRingGuard();
    this.ringTimer = setTimeout(() => {
      if (this.status === 'incoming' || this.status === 'outgoing') {
        void this.hangup();
      }
    }, RING_GUARD_MS);
  }

  private disarmRingGuard(): void {
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
  }

  /** 归零全部状态（停止媒体轨道、关 PC；内存态即 UI 态） */
  private cleanup(): void {
    this.disarmRingGuard();
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    this.pc?.close();
    this.pc = null;
    this.pendingIce = [];
    this.localStream = null;
    this.remoteStream = null;
    this.pcState = 'closed';
    this.status = 'idle';
    this.callId = null;
    this.peer = null;
    this.connectedAt = null;
  }
}

export const call = new CallStore();

/** getUserMedia 错误 → 可读提示（权限拒绝是最常见原因） */
function mediaErrorText(error: unknown): string {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '无法访问摄像头/麦克风：请在系统与 WebView2 权限设置中允许后重试';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '未找到可用的摄像头/麦克风设备';
  }
  if (name === 'NotReadableError') {
    return '摄像头/麦克风被其它应用占用';
  }
  return error instanceof Error ? error.message : '音视频采集失败';
}
