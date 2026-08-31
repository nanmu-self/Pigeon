<script lang="ts">
  /**
   * 设置页 — 个人资料（头像 + 昵称）。
   *
   * 头像链路：选图（前端预校验类型/大小）→ uploadToQiniu(dir 'avatar') 直传七牛
   * → PATCH /users/me 把返回的 publicUrl 写入资料 → 全局 profile 同步（侧边栏即时生效）。
   */
  import { onMount } from "svelte";
  import { showToast } from "$lib/toast";
  import { cn } from "$lib/utils";
  import { ApiError } from "$lib/api/http";
  import { usersApi } from "$lib/api/users";
  import { profile } from "$lib/api/profile.svelte";
  import {
    isUploadCanceled,
    uploadToQiniu,
    type UploadHandle,
  } from "$lib/upload/qiniu";

  // 与服务端 avatar 目录限制一致（见 apps/server/src/storage/qiniu.service.ts DIR_LIMITS）
  const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  const AVATAR_MAX = 5 * 1024 * 1024;

  let nickname = $state("");
  let savingNickname = $state(false);

  let avatarInput = $state<HTMLInputElement | null>(null);
  let avatarUploading = $state(false);
  let avatarPercent = $state(0);
  let avatarHandle: UploadHandle | null = null;

  const nicknameDirty = $derived(
    profile.user !== null &&
      nickname.trim().length >= 2 &&
      nickname.trim() !== profile.user.nickname,
  );

  onMount(() => {
    void (async () => {
      await profile.load();
      nickname = profile.user?.nickname ?? "";
    })();
  });

  function pickAvatar() {
    if (!avatarUploading) avatarInput?.click();
  }

  function onAvatarChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void uploadAvatar(file);
  }

  async function uploadAvatar(file: File) {
    // 前置校验（服务端取票与七牛侧还有同规则强校验，这里提前拦截省一次上传）
    if (!AVATAR_TYPES.has(file.type)) {
      showToast("头像仅支持 JPG / PNG / WebP / GIF", { type: "error" });
      return;
    }
    if (file.size > AVATAR_MAX) {
      showToast("头像不能超过 5 MB", { type: "error" });
      return;
    }

    avatarUploading = true;
    avatarPercent = 0;
    const handle = uploadToQiniu(file, {
      dir: "avatar",
      fileName: file.name,
      onProgress: (p) => (avatarPercent = p.percent),
    });
    avatarHandle = handle;

    try {
      // 1. 直传七牛，拿外链；2. 写入资料（部分更新）
      const { url } = await handle.done;
      const user = await usersApi.updateMe({ avatarUrl: url });
      profile.set(user);
      showToast("头像已更新", { type: "success" });
    } catch (err) {
      if (!isUploadCanceled(err)) {
        showToast(err instanceof ApiError || err instanceof Error ? err.message : "头像上传失败", {
          type: "error",
        });
      }
    } finally {
      avatarUploading = false;
      avatarHandle = null;
    }
  }

  function cancelAvatarUpload() {
    avatarHandle?.cancel();
  }

  async function saveNickname() {
    if (!nicknameDirty || savingNickname) return;
    savingNickname = true;
    try {
      const user = await usersApi.updateMe({ nickname: nickname.trim() });
      profile.set(user);
      showToast("昵称已保存", { type: "success" });
    } catch (err) {
      showToast(err instanceof ApiError || err instanceof Error ? err.message : "保存失败", {
        type: "error",
      });
    } finally {
      savingNickname = false;
    }
  }
</script>

<div class="flex h-full flex-col">
  <!-- ── 页头 ── -->
  <header class="border-b border-[var(--p-border)] px-6 py-4">
    <h1 class="text-lg font-semibold text-[var(--p-fg)]">设置</h1>
    <p class="mt-0.5 text-xs text-[var(--p-muted-fg)]">个人资料与账户偏好</p>
  </header>

  <div class="scroll-area-thin flex-1 overflow-y-auto p-6">
    <div class="mx-auto max-w-xl">
      <!-- ── 个人资料 ── -->
      <section
        class="rounded-xl border border-[var(--p-border)] bg-[var(--p-card)] p-6"
      >
        <h2 class="text-sm font-semibold text-[var(--p-fg)]">个人资料</h2>

        {#if profile.user === null}
          <p class="mt-4 text-sm text-[var(--p-muted-fg)]">
            未获取到登录信息，请先登录后再修改资料。
          </p>
        {:else}
          <div class="mt-5 flex items-start gap-6">
            <!-- 头像 -->
            <div class="flex flex-col items-center gap-2">
              <button
                type="button"
                onclick={pickAvatar}
                aria-label="更换头像"
                title="更换头像"
                class="group relative h-20 w-20 overflow-hidden rounded-full border border-[var(--p-border)] transition-fast hover:border-[var(--p-primary)]"
              >
                {#if profile.avatarUrl}
                  <img
                    src={profile.avatarUrl}
                    alt={profile.displayName}
                    class="h-full w-full object-cover"
                  />
                {:else}
                  <span
                    class="flex h-full w-full items-center justify-center bg-[var(--p-primary-muted)] text-2xl font-semibold text-[var(--p-primary)]"
                  >
                    {profile.displayName.slice(0, 1).toUpperCase()}
                  </span>
                {/if}

                {#if avatarUploading}
                  <!-- 上传中遮罩：进度 + 取消 -->
                  <div
                    class="absolute inset-0 flex flex-col items-center justify-center bg-black/55 text-white"
                  >
                    <span class="text-xs font-medium tabular-nums">{avatarPercent}%</span>
                    <div class="mt-1 h-1 w-10 overflow-hidden rounded-full bg-white/30">
                      <div
                        class="h-full rounded-full bg-white transition-[width] duration-200"
                        style="width: {avatarPercent}%"
                      ></div>
                    </div>
                  </div>
                {:else}
                  <div
                    class="absolute inset-0 hidden items-center justify-center bg-black/40 text-white group-hover:flex"
                  >
                    <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                      <circle cx="12" cy="13" r="4" />
                    </svg>
                  </div>
                {/if}
              </button>

              {#if avatarUploading}
                <button
                  type="button"
                  onclick={cancelAvatarUpload}
                  class="text-xs text-[var(--p-muted-fg)] transition-fast hover:text-red-500"
                >
                  取消上传
                </button>
              {:else}
                <button
                  type="button"
                  onclick={pickAvatar}
                  class="text-xs text-[var(--p-primary)] transition-fast hover:underline"
                >
                  更换头像
                </button>
              {/if}
            </div>

            <!-- 字段 -->
            <div class="min-w-0 flex-1 space-y-4">
              <div>
                <label class="mb-1 block text-xs text-[var(--p-muted-fg)]" for="settings-email">
                  邮箱
                </label>
                <input
                  id="settings-email"
                  type="text"
                  value={profile.user.email}
                  disabled
                  class="h-9 w-full rounded-md border border-[var(--p-border)] bg-[var(--p-muted)] px-3 text-sm text-[var(--p-muted-fg)] opacity-80"
                />
              </div>

              <div>
                <label class="mb-1 block text-xs text-[var(--p-muted-fg)]" for="settings-nickname">
                  昵称
                </label>
                <div class="flex gap-2">
                  <input
                    id="settings-nickname"
                    type="text"
                    bind:value={nickname}
                    maxlength="32"
                    placeholder="2~32 个字符"
                    class="h-9 w-full rounded-md border border-[var(--p-border)] bg-[var(--p-bg)] px-3 text-sm text-[var(--p-fg)] placeholder:text-[var(--p-muted-fg)] focus:border-[var(--p-ring)] focus:outline-none focus:ring-1 focus:ring-[var(--p-ring)]/30"
                  />
                  <button
                    type="button"
                    onclick={saveNickname}
                    disabled={!nicknameDirty || savingNickname}
                    class={cn(
                      "h-9 shrink-0 rounded-md px-4 text-sm font-medium transition-fast",
                      nicknameDirty && !savingNickname
                        ? "bg-[var(--p-primary)] text-white hover:opacity-90"
                        : "cursor-not-allowed bg-[var(--p-muted)] text-[var(--p-muted-fg)]",
                    )}
                  >
                    {savingNickname ? "保存中…" : "保存"}
                  </button>
                </div>
                {#if nickname.trim().length > 0 && nickname.trim().length < 2}
                  <p class="mt-1 text-xs text-red-500">昵称至少 2 个字符</p>
                {/if}
              </div>
            </div>
          </div>

          <p class="mt-5 border-t border-[var(--p-border)] pt-3 text-xs text-[var(--p-muted-fg)]">
            头像支持 JPG / PNG / WebP / GIF，不超过 5 MB；上传后直存七牛云，仅保存外链地址。
          </p>
        {/if}
      </section>

      <input
        bind:this={avatarInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        class="hidden"
        onchange={onAvatarChange}
      />
    </div>
  </div>
</div>
