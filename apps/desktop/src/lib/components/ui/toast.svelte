<script lang="ts">
  import { cn } from "$lib/utils";

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
    error: `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
    success: `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`,
    info: `<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>`,
  };
</script>

{#if message}
  <div
    role="alert"
    class={cn(
      "fixed top-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2.5 rounded-lg border px-4 py-2.5 shadow-lg anim-fade-in",
      variants[type]
    )}
  >
    <svg class="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      {@html icons[type]}
    </svg>
    <span class="text-sm font-medium">{message}</span>
    {#if onClose}
      <button
        type="button"
        onclick={onClose}
        aria-label="关闭"
        class="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 transition-fast"
      >
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    {/if}
  </div>
{/if}
