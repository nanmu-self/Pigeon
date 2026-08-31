<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    message: string;
    type?: "error" | "success" | "info";
    onClose?: () => void;
  }

  let { message, type = "error", onClose }: Props = $props();

  const variants = {
    error: "border-destructive/50 text-destructive",
    success: "border-green-500/50 text-green-700",
    info: "border-blue-500/50 text-blue-700",
  };

  const icons = {
    error: `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    success: `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    info: `<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  };
</script>

{#if message}
  <div
    class={cn(
      "fixed top-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-white px-4 py-3 shadow-lg",
      "transition-all duration-200 ease-out",
      "opacity-100 translate-y-0",
      variants[type]
    )}
    role="alert"
  >
    <span>{@html icons[type]}</span>
    <span class="text-sm font-medium">{message}</span>
    {#if onClose}
      <button
        type="button"
        onclick={onClose}
        aria-label="关闭提示"
        class="ml-2 rounded-sm opacity-70 hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    {/if}
  </div>
{/if}
