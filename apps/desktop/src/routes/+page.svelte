<script lang="ts">
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Label from "$lib/components/ui/label.svelte";
  import { showToast } from "$lib/toast";
  import { goto } from "$app/navigation";

  let email = $state("");
  let password = $state("");
  let isLoading = $state(false);

  async function handleSubmit(event: Event) {
    event.preventDefault();
    isLoading = true;

    await new Promise((resolve) => setTimeout(resolve, 1200));

    if (email && password) {
      showToast("登录成功", { type: "success" });
      setTimeout(() => goto("/messages"), 500);
    } else {
      showToast("请输入邮箱和密码", { type: "error" });
    }
    isLoading = false;
  }
</script>

<svelte:head>
  <title>登录 — Pigeon</title>
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

        <div class="space-y-1">
          <Label for="password" class="text-xs">密码</Label>
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            bind:value={password}
            autocomplete="current-password"
            class="h-9 text-xs"
          />
        </div>

        <div class="flex items-center justify-between">
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" class="h-3.5 w-3.5 cursor-pointer accent-[var(--p-primary)]" />
            <span class="text-xs text-[var(--p-muted-fg)]">记住我</span>
          </label>
          <button type="button" class="text-xs text-[var(--p-primary)] hover:underline">忘记密码？</button>
        </div>

        <Button type="submit" class="w-full h-9 text-sm" disabled={isLoading}>
          {#if isLoading}
            <svg class="mr-2 h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"/>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
            </svg>
            登录中…
          {:else}
            登录
          {/if}
        </Button>
      </form>

      <p class="mt-3 text-center text-xs text-[var(--p-muted-fg)]">
        还没有账号？
        <button type="button" class="text-[var(--p-primary)] hover:underline">立即注册</button>
      </p>
    </div>

    <p class="mt-4 text-center text-[10px] text-[var(--p-muted-fg)]">
      Pigeon · 开源 · 端到端加密
    </p>
  </div>
</div>
