<script lang="ts">
  /**
   * 文件页 — 七牛云直传（后端签凭证 / 前端 qiniu-js 直传）的落地演示。
   *
   * 数据流：选文件 → uploadToQiniu() 先向 /storage/upload-token 取票
   * （JWT 鉴权）→ qiniu.upload 直传七牛上传域名 → 完成后用 publicUrl 访问。
   * 业务服务器只过签名与授权，不承接文件流。
   */
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { showToast } from "$lib/toast";
  import { cn } from "$lib/utils";
  import {
    isUploadCanceled,
    uploadToQiniu,
    type UploadHandle,
  } from "$lib/upload/qiniu";
  import type { UploadDir } from "@pigeon/shared-types";

  type ItemStatus = "uploading" | "done" | "error" | "canceled";

  interface Item {
    id: number;
    file: File;
    name: string;
    size: number;
    dir: UploadDir;
    status: ItemStatus;
    percent: number;
    handle?: UploadHandle;
    url?: string;
    error?: string;
  }

  // 上传目录（avatar 语义上是头像，此处不提供；聊天媒体 / 普通文件）
  const DIRS: { value: UploadDir; label: string }[] = [
    { value: "file", label: "文件" },
    { value: "chat", label: "聊天媒体" },
  ];

  let items = $state<Item[]>([]);
  let dragOver = $state(false);
  let dir = $state<UploadDir>("file");
  let fileInput = $state<HTMLInputElement | null>(null);
  let idSeq = 0;

  const uploadingCount = $derived(items.filter((i) => i.status === "uploading").length);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function addFile(file: File) {
    const id = ++idSeq;
    const item: Item = {
      id,
      file,
      name: file.name,
      size: file.size,
      dir,
      status: "uploading",
      percent: 0,
    };
    items.push(item);
    start(item);
  }

  function start(item: Item) {
    const handle = uploadToQiniu(item.file, {
      dir: item.dir,
      fileName: item.name,
      onProgress: (p) => {
        const it = items.find((x) => x.id === item.id);
        if (it) it.percent = p.percent;
      },
    });
    item.handle = handle;
    handle.done
      .then((res) => {
        const it = items.find((x) => x.id === item.id);
        if (!it) return;
        it.status = "done";
        it.percent = 100;
        it.url = res.url;
      })
      .catch((err: unknown) => {
        const it = items.find((x) => x.id === item.id);
        if (!it) return;
        if (isUploadCanceled(err)) {
          it.status = "canceled";
          return;
        }
        it.status = "error";
        it.error = err instanceof Error ? err.message : String(err);
        showToast(`「${it.name}」上传失败：${it.error}`, { type: "error" });
      });
  }

  function retry(item: Item) {
    const it = items.find((x) => x.id === item.id);
    if (!it) return;
    it.status = "uploading";
    it.percent = 0;
    it.error = undefined;
    start(it);
  }

  function cancel(item: Item) {
    const it = items.find((x) => x.id === item.id);
    if (!it || it.status !== "uploading") return;
    it.handle?.cancel();
    it.status = "canceled";
  }

  function remove(item: Item) {
    cancel(item);
    items = items.filter((x) => x.id !== item.id);
  }

  function clearFinished() {
    items = items.filter((x) => x.status === "uploading");
  }

  async function copyUrl(item: Item) {
    if (!item.url) return;
    try {
      await navigator.clipboard.writeText(item.url);
      showToast("链接已复制", { type: "success" });
    } catch {
      showToast("复制失败，请手动选择链接", { type: "error" });
    }
  }

  function onDrop(e: DragEvent) {
    dragOver = false;
    const files = e.dataTransfer?.files;
    if (files?.length) enqueue(files);
  }

  function onPick(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) enqueue(input.files);
    input.value = "";
  }

  /** 逐个入队（qiniu-js 内部并发控制分片请求；这里串行入队即可） */
  function enqueue(list: FileList) {
    for (const file of Array.from(list)) addFile(file);
  }
</script>

<div class="flex h-full flex-col">
  <!-- ── 页头 ── -->
  <header class="flex items-center justify-between border-b border-[var(--p-border)] px-6 py-4">
    <div>
      <h1 class="text-lg font-semibold text-[var(--p-fg)]">文件</h1>
      <p class="mt-0.5 text-xs text-[var(--p-muted-fg)]">
        后端签发上传凭证 · 前端直传七牛云（> 4 MB 自动分片，支持断点续传）
      </p>
    </div>
    <div class="flex items-center gap-2">
      <div class="flex rounded-md border border-[var(--p-border)] p-0.5">
        {#each DIRS as d (d.value)}
          <button
            onclick={() => (dir = d.value)}
            class={cn(
              "rounded px-2.5 py-1 text-xs transition-fast",
              dir === d.value
                ? "bg-[var(--p-primary-muted)] font-medium text-[var(--p-primary)]"
                : "text-[var(--p-muted-fg)] hover:text-[var(--p-fg)]",
            )}
          >
            {d.label}
          </button>
        {/each}
      </div>
      {#if uploadingCount > 0}
        <span class="text-xs text-[var(--p-muted-fg)]">上传中 {uploadingCount}</span>
      {:else if items.length > 0}
        <button
          onclick={clearFinished}
          class="rounded px-2 py-1 text-xs text-[var(--p-muted-fg)] transition-fast hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
        >
          清空已完成
        </button>
      {/if}
    </div>
  </header>

  <div class="scroll-area-thin flex-1 overflow-y-auto p-6">
    <!-- ── 拖放区 ── -->
    <button
      type="button"
      aria-label="选择或拖入文件"
      onclick={() => fileInput?.click()}
      ondragover={(e) => {
        e.preventDefault();
        dragOver = true;
      }}
      ondragleave={() => (dragOver = false)}
      ondrop={(e) => {
        e.preventDefault();
        onDrop(e);
      }}
      class={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 transition-fast",
        dragOver
          ? "border-[var(--p-primary)] bg-[var(--p-primary-muted)]/40"
          : "border-[var(--p-border)] bg-[var(--p-card)] hover:border-[var(--p-muted-fg)]",
      )}
    >
      <svg
        class="h-8 w-8 text-[var(--p-muted-fg)]"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
      <p class="text-sm text-[var(--p-fg)]">点击选择文件，或拖拽到此处</p>
      <p class="text-xs text-[var(--p-muted-fg)]">
        目标目录：{DIRS.find((d) => d.value === dir)?.label}
      </p>
      <input
        bind:this={fileInput}
        type="file"
        multiple
        class="hidden"
        onchange={onPick}
      />
    </button>

    <!-- ── 上传列表 ── -->
    {#if items.length === 0}
      <div class="mt-6 text-center text-xs text-[var(--p-muted-fg)]">
        还没有文件。上传完成后会生成外链，可直接用于头像或聊天图片。
      </div>
    {:else}
      <ul class="mt-6 space-y-2">
        {#each items as item (item.id)}
          <li
            class="rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] px-4 py-3"
          >
            <div class="flex items-center gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-3">
                  <span class="truncate text-sm text-[var(--p-fg)]" title={item.name}>
                    {item.name}
                  </span>
                  <span class="shrink-0 text-xs tabular-nums text-[var(--p-muted-fg)]">
                    {#if item.status === "uploading"}
                      {item.percent}%
                    {:else if item.status === "done"}
                      {formatSize(item.size)}
                    {:else if item.status === "canceled"}
                      已取消
                    {:else}
                      失败
                    {/if}
                  </span>
                </div>

                <!-- 进度条 -->
                {#if item.status === "uploading"}
                  <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--p-muted)]">
                    <div
                      class="h-full rounded-full bg-[var(--p-primary)] transition-[width] duration-200"
                      style="width: {item.percent}%"
                    ></div>
                  </div>
                {:else if item.status === "error"}
                  <p class="mt-1 truncate text-xs text-red-500" title={item.error}>
                    {item.error}
                  </p>
                {/if}

                <!-- 完成态：外链 -->
                {#if item.status === "done" && item.url}
                  <div class="mt-1.5 flex min-w-0 items-center gap-2">
                    <span class="truncate font-mono text-xs text-[var(--p-muted-fg)]" title={item.url}>
                      {item.url}
                    </span>
                  </div>
                {/if}
              </div>

              <!-- 操作 -->
              <div class="flex shrink-0 items-center gap-1">
                {#if item.status === "uploading"}
                  <button
                    onclick={() => cancel(item)}
                    class="rounded px-2 py-1 text-xs text-[var(--p-muted-fg)] transition-fast hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
                  >
                    取消
                  </button>
                {:else if item.status === "error"}
                  <button
                    onclick={() => retry(item)}
                    class="rounded px-2 py-1 text-xs text-[var(--p-primary)] transition-fast hover:bg-[var(--p-primary-muted)]"
                  >
                    重试
                  </button>
                {:else if item.status === "done"}
                  <button
                    onclick={() => copyUrl(item)}
                    class="rounded px-2 py-1 text-xs text-[var(--p-primary)] transition-fast hover:bg-[var(--p-primary-muted)]"
                  >
                    复制链接
                  </button>
                  <button
                    onclick={() => item.url && openUrl(item.url)}
                    class="rounded px-2 py-1 text-xs text-[var(--p-muted-fg)] transition-fast hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
                  >
                    打开
                  </button>
                {:else if item.status === "canceled"}
                  <button
                    onclick={() => retry(item)}
                    class="rounded px-2 py-1 text-xs text-[var(--p-muted-fg)] transition-fast hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
                  >
                    重新上传
                  </button>
                {/if}
                <button
                  onclick={() => remove(item)}
                  aria-label="移除记录"
                  class="rounded p-1.5 text-[var(--p-muted-fg)] transition-fast hover:bg-[var(--p-muted)] hover:text-red-500"
                >
                  <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
