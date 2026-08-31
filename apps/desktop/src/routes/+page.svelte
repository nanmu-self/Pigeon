<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Label from "$lib/components/ui/label.svelte";
  import { showToast } from "$lib/toast";
  import { ApiError, rememberEmailStore, tokenStore } from "$lib/api/http";
  import { authApi } from "$lib/api/auth";

  type Mode = "login" | "register";

  let mode = $state<Mode>("login");
  const isLogin = $derived(mode === "login");

  let email = $state("");
  let password = $state("");
  let nickname = $state("");
  let captchaCode = $state("");
  let rememberMe = $state(false);

  let captcha = $state<{ captchaId: string; image: string } | null>(null);
  let isLoading = $state(false);

  /** 拉取新验证码:captchaId 一次性,任何一次提交后都要换新码 */
  async function refreshCaptcha() {
    captchaCode = "";
    try {
      captcha = await authApi.captcha();
    } catch {
      captcha = null;
      showToast("验证码加载失败，请检查服务端连接", { type: "error" });
    }
  }

  onMount(() => {
    // “记住我”留下的邮箱自动填充
    email = rememberEmailStore.get();
    if (email) rememberMe = true;
    void refreshCaptcha();
  });

  function switchMode(next: Mode) {
    mode = next;
    password = "";
    void refreshCaptcha();
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    if (!captcha) {
      showToast("验证码未加载，正在重试…", { type: "error" });
      await refreshCaptcha();
      return;
    }
    isLoading = true;
    const currentCaptchaId = captcha.captchaId;
    try {
      const result = isLogin
        ? await authApi.login({
            email,
            password,
            captchaId: currentCaptchaId,
            captchaCode,
          })
        : await authApi.register({
            email,
            password,
            nickname,
            captchaId: currentCaptchaId,
            captchaCode,
          });

      // 记住我：勾选 → 长期凭据 + 记住邮箱；不勾 → 仅当前会话
      tokenStore.set(result.token, rememberMe);
      rememberEmailStore.set(rememberMe ? email.trim().toLowerCase() : "");

      showToast(isLogin ? "登录成功" : "注册成功", { type: "success" });
      setTimeout(() => goto("/messages"), 500);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "网络错误，请稍后再试", {
        type: "error",
      });
      await refreshCaptcha();
    } finally {
      isLoading = false;
    }
  }
</script>

<svelte:head>
  <title>{isLogin ? "登录" : "注册"} — Pigeon</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-[var(--p-bg)] px-4">
  <div class="w-full max-w-sm anim-fade-in">
    <!-- Logo -->
    <div class="mb-6 text-center">
      <div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-[var(--p-primary)] text-[var(--p-primary-fg)]">
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
          <polyline points="22,6 12,13 2,6"/>
        </svg>
      </div>
      <h1 class="text-lg font-semibold text-[var(--p-fg)]">Pigeon</h1>
      <p class="mt-0.5 text-xs text-[var(--p-muted-fg)]">开源高性能即时通讯</p>
    </div>

    <!-- Form card -->
    <div class="rounded-md border border-[var(--p-border)] bg-[var(--p-card)] p-4 shadow-sm">
      <form onsubmit={handleSubmit} class="space-y-3">
        <div class="space-y-1">
          <Label for="email" class="text-xs">邮箱</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            bind:value={email}
            autocomplete="email"
            class="h-9 text-xs"
          />
        </div>

        {#if !isLogin}
          <div class="space-y-1">
            <Label for="nickname" class="text-xs">昵称</Label>
            <Input
              id="nickname"
              type="text"
              placeholder="2~32 个字符"
              bind:value={nickname}
              maxlength={32}
              autocomplete="nickname"
              class="h-9 text-xs"
            />
          </div>
        {/if}

        <div class="space-y-1">
          <Label for="password" class="text-xs">密码</Label>
          <Input
            id="password"
            type="password"
            placeholder={isLogin ? "••••••••" : "至少 8 位"}
            bind:value={password}
            autocomplete={isLogin ? "current-password" : "new-password"}
            class="h-9 text-xs"
          />
        </div>

        <!-- 图形验证码：点图换一张 -->
        <div class="space-y-1">
          <Label for="captcha" class="text-xs">验证码</Label>
          <div class="flex items-center gap-2">
            <Input
              id="captcha"
              type="text"
              placeholder="4 位字符"
              bind:value={captchaCode}
              maxlength={16}
              autocomplete="off"
              class="h-9 flex-1 text-xs"
            />
            <button
              type="button"
              onclick={refreshCaptcha}
              title="点击刷新验证码"
              aria-label="刷新验证码"
              class="h-9 w-[104px] shrink-0 overflow-hidden rounded-md border border-[var(--p-border)] bg-white/80"
            >
              {#if captcha}
                <img src={captcha.image} alt="验证码" class="h-full w-full object-cover" />
              {:else}
                <span class="text-xs text-[var(--p-muted-fg)]">加载中…</span>
              {/if}
            </button>
          </div>
        </div>

        {#if isLogin}
          <div class="flex items-center justify-between">
            <label class="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" bind:checked={rememberMe} class="h-3.5 w-3.5 cursor-pointer accent-[var(--p-primary)]" />
              <span class="text-xs text-[var(--p-muted-fg)]">记住我</span>
            </label>
            <button type="button" class="text-xs text-[var(--p-primary)] hover:underline">忘记密码？</button>
          </div>
        {/if}

        <Button type="submit" class="w-full h-9 text-sm" disabled={isLoading}>
          {#if isLoading}
            <svg class="mr-2 h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
            </svg>
            {isLogin ? "登录中…" : "注册中…"}
          {:else}
            {isLogin ? "登录" : "注册"}
          {/if}
        </Button>
      </form>

      <p class="mt-3 text-center text-xs text-[var(--p-muted-fg)]">
        {#if isLogin}
          还没有账号？
          <button type="button" onclick={() => switchMode("register")} class="text-[var(--p-primary)] hover:underline">立即注册</button>
        {:else}
          已有账号？
          <button type="button" onclick={() => switchMode("login")} class="text-[var(--p-primary)] hover:underline">去登录</button>
        {/if}
      </p>
    </div>

    <p class="mt-4 text-center text-[10px] text-[var(--p-muted-fg)]">
      Pigeon · 开源 · 端到端加密
    </p>
  </div>
</div>
