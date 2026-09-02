<script lang="ts">
  /**
   * 全局通话浮层（挂 (app) 布局；call-store 非 idle 时渲染）。
   * 来电 → 接听/拒接；去电 → 振铃/连接中/通话中；音视频二态由 call.media 决定。
   */
  import Mic from '@lucide/svelte/icons/mic';
  import MicOff from '@lucide/svelte/icons/mic-off';
  import Video from '@lucide/svelte/icons/video';
  import VideoOff from '@lucide/svelte/icons/video-off';
  import PhoneOff from '@lucide/svelte/icons/phone-off';
  import Phone from '@lucide/svelte/icons/phone';
  import { call } from '$lib/webrtc/call-store.svelte';

  let localVideoEl = $state<HTMLVideoElement | null>(null);
  let remoteVideoEl = $state<HTMLVideoElement | null>(null);
  /** 通话时长（秒；接通后每秒 +1） */
  let elapsed = $state(0);

  // <video> 绑定 MediaStream：srcObject 不是响应式属性，需 effect 手工同步
  $effect(() => {
    if (localVideoEl) localVideoEl.srcObject = call.localStream;
    if (remoteVideoEl) remoteVideoEl.srcObject = call.remoteStream;
  });

  // 接通后计时
  $effect(() => {
    if (call.connectedAt == null) return;
    elapsed = 0;
    const timer = setInterval(() => {
      elapsed = Math.floor((Date.now() - (call.connectedAt ?? Date.now())) / 1000);
    }, 1000);
    return () => clearInterval(timer);
  });

  const statusText = $derived.by(() => {
    switch (call.status) {
      case 'outgoing':
        return '等待对方接听…';
      case 'incoming':
        return call.media === 'video' ? '邀请你视频通话' : '邀请你语音通话';
      case 'connecting':
        return '正在建立连接…';
      case 'connected':
        return fmt(elapsed);
      default:
        return '';
    }
  });

  function fmt(total: number): string {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
</script>

{#if call.active}
  <div class="fixed inset-0 z-50 flex flex-col items-center justify-between bg-zinc-950/95 py-10 text-white backdrop-blur">
    <!-- 远端画面（视频通话时全屏铺底） -->
    {#if call.media === 'video'}
      <video
        bind:this={remoteVideoEl}
        autoplay
        playsinline
        class="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-90 {call.remoteStream ? '' : 'invisible'}"
      ></video>
    {/if}

    <!-- 顶部：对方信息 + 状态 -->
    <div class="relative z-10 flex flex-col items-center gap-3">
      <div class="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full bg-white/10 text-2xl font-semibold ring-2 ring-white/20">
        {#if call.peer?.avatarUrl}
          <img src={call.peer.avatarUrl} alt={call.peer.name} class="h-full w-full object-cover" />
        {:else}
          {call.peer?.name.slice(0, 2).toUpperCase() ?? '?'}
        {/if}
      </div>
      <p class="text-xl font-medium">{call.peer?.name ?? ''}</p>
      <p class="text-sm text-white/70 tabular-nums {call.status === 'outgoing' || call.status === 'incoming' ? 'animate-pulse' : ''}">
        {statusText}
      </p>
      {#if call.status === 'connecting' && call.pcState === 'failed'}
        <p class="text-sm text-red-400">连接失败</p>
      {/if}
    </div>

    <!-- 本地预览（视频通话 + 摄像头开启时，右上角小窗） -->
    {#if call.media === 'video' && call.localStream}
      <video
        bind:this={localVideoEl}
        autoplay
        playsinline
        muted
        class="absolute top-6 right-6 z-10 h-40 w-30 w-48 rounded-xl border border-white/20 bg-black object-cover shadow-lg"
      ></video>
    {/if}

    <!-- 底部：控制按钮 -->
    <div class="relative z-10 flex items-center gap-5">
      {#if call.status === 'incoming'}
        <!-- 来电：拒接 / 接听 -->
        <button
          class="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 transition hover:bg-red-600"
          title="拒接"
          onclick={() => void call.reject()}
        >
          <PhoneOff size={24} />
        </button>
        <button
          class="flex h-16 w-16 animate-bounce items-center justify-center rounded-full bg-green-500 transition hover:bg-green-600"
          title="接听"
          onclick={() => void call.accept()}
        >
          <Phone size={26} />
        </button>
      {:else}
        <!-- 静音 -->
        <button
          class="flex h-12 w-12 items-center justify-center rounded-full {call.micOn ? 'bg-white/15 hover:bg-white/25' : 'bg-white text-zinc-900'} transition"
          title={call.micOn ? '关闭麦克风' : '开启麦克风'}
          onclick={() => call.toggleMic()}
        >
          {#if call.micOn}<Mic size={20} />{:else}<MicOff size={20} />{/if}
        </button>
        <!-- 挂断 -->
        <button
          class="flex h-16 w-16 items-center justify-center rounded-full bg-red-500 transition hover:bg-red-600"
          title="挂断"
          onclick={() => void call.hangup()}
        >
          <PhoneOff size={26} />
        </button>
        <!-- 摄像头（仅视频通话） -->
        {#if call.media === 'video'}
          <button
            class="flex h-12 w-12 items-center justify-center rounded-full {call.camOn ? 'bg-white/15 hover:bg-white/25' : 'bg-white text-zinc-900'} transition"
            title={call.camOn ? '关闭摄像头' : '开启摄像头'}
            onclick={() => call.toggleCam()}
          >
            {#if call.camOn}<Video size={20} />{:else}<VideoOff size={20} />{/if}
          </button>
        {/if}
      {/if}
    </div>
  </div>
{/if}
