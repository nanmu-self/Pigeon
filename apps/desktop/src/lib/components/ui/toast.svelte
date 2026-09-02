<script lang="ts">
  import { cn } from "$lib/utils";

  // ── Lucide 图标（官方推荐：子路径单独导入，tree-shakable） ──
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import CircleCheckBig from "@lucide/svelte/icons/circle-check-big";
  import Info from "@lucide/svelte/icons/info";
  import X from "@lucide/svelte/icons/x";

  interface Props {
    message: string;
    type?: "error" | "success" | "info";
    /** Auto-dismiss after ms; 0 = keep until manually closed */
    duration?: number;
    onClose?: () => void;
  }

  let { message, type = "error", duration = 3000, onClose }: Props = $props();

  $effect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => onClose?.(), duration);
      return () => clearTimeout(timer);
    }
  });

  const variants = {
    error:   "border-[var(--p-destructive)]/30 bg-[var(--p-destructive-muted)] text-[var(--p-destructive)]",
    success: "border-[var(--p-success)]/30 bg-[var(--p-success-muted)] text-[var(--p-success)]",
    info:    "border-[var(--p-ring)]/30 bg-[var(--p-primary-muted)] text-[var(--p-primary)]",
  };

  const icons = {
    error: TriangleAlert,
    success: CircleCheckBig,
    info: Info,
  };
</script>

{#if message}
  {@const Icon = icons[type]}
  <div
    role="alert"
    class={cn(
      "fixed top-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2.5 rounded-lg border px-4 py-2.5 shadow-lg anim-fade-in",
      variants[type]
    )}
  >
    <Icon size={16} class="shrink-0" />
    <span class="text-sm font-medium">{message}</span>
    {#if onClose}
      <button
        type="button"
        onclick={onClose}
        aria-label="关闭"
        class="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 transition-fast"
      >
        <X size={12} strokeWidth={3} />
      </button>
    {/if}
  </div>
{/if}
