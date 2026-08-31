<script lang="ts">
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Label from "$lib/components/ui/label.svelte";
  import Toast from "$lib/components/ui/toast.svelte";

  let email = $state("");
  let password = $state("");
  let isLoading = $state(false);
  let toastMessage = $state("");
  let toastType = $state<"error" | "success" | "info">("error");

  async function handleSubmit(event: Event) {
    event.preventDefault();
    toastMessage = "";
    isLoading = true;

    // Simulate login
    await new Promise((resolve) => setTimeout(resolve, 1500));

    if (email && password) {
      console.log("Login:", { email, password });
    } else {
      toastMessage = "请输入邮箱和密码";
      toastType = "error";
    }

    isLoading = false;
  }

  function closeToast() {
    toastMessage = "";
  }
</script>

<svelte:head>
  <title>登录</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-gray-50 px-4">
  <div class="w-full max-w-sm">
    <!-- Logo and Title -->
    <div class="mb-8 text-center">
      <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary">
        <svg
          class="h-6 w-6 text-primary-foreground"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      </div>
      <h1 class="text-2xl font-semibold text-gray-900">欢迎回来</h1>
      <p class="mt-1 text-sm text-gray-600">请登录您的账号</p>
    </div>

    <!-- Login Form -->
    <div class="rounded-lg border bg-white p-6 shadow-sm">
      {#if toastMessage}
        <Toast message={toastMessage} type={toastType} onClose={closeToast} />
      {/if}

      <form onsubmit={handleSubmit} class="space-y-4">
        <!-- 错误提示已改为顶部 Toast，避免表单内部重排 -->

        <div class="space-y-2">
          <Label for="email">邮箱</Label>
          <Input
            id="email"
            type="email"
            placeholder="name@example.com"
            bind:value={email}
            autocomplete="email"
            required
          />
        </div>

        <div class="space-y-2">
          <Label for="password">密码</Label>
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            bind:value={password}
            autocomplete="current-password"
            required
          />
        </div>

        <div class="flex items-center justify-between text-sm">
          <label class="flex items-center space-x-2">
            <input type="checkbox" class="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary" />
            <span class="text-gray-600">记住我</span>
          </label>
          <button type="button" class="text-primary hover:underline">忘记密码？</button>
        </div>

        <Button type="submit" class="w-full" size="lg" disabled={isLoading}>
          {#if isLoading}
            <svg class="mr-2 h-4 w-4 animate-spin" viewBox="0 0 24 24">
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
                fill="none"
              />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            登录中...
          {:else}
            登录
          {/if}
        </Button>
      </form>

      <div class="mt-6 text-center text-sm text-gray-600">
        还没有账号？
        <button type="button" class="font-medium text-primary hover:underline">立即注册</button>
      </div>
    </div>
  </div>
</div>

<style>
  /* Focus ring animation */
  :global(.focus-visible) {
    outline: 2px solid var(--color-ring, #07c160);
    outline-offset: 2px;
  }

  /* Button press feedback - tactile response */
  :global(button:active) {
    transform: scale(0.97);
  }

  /* Checkbox focus */
  input[type="checkbox"]:focus-visible {
    outline: 2px solid var(--color-ring, #07c160);
    outline-offset: 2px;
  }

  /* Smooth color transitions */
  button {
    transition: color 150ms ease-out;
  }
</style>
