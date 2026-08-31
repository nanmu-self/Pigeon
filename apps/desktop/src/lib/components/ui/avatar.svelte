<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    class?: string;
    src?: string;
    alt?: string;
    fallback?: string;
    size?: "sm" | "md" | "lg" | "xl";
    status?: "online" | "away" | "offline" | "busy";
  }

  let {
    class: className = "",
    src,
    alt = "",
    fallback = "",
    size = "md",
    status,
  }: Props = $props();

  const sizeClasses = {
    sm: "h-7 w-7 text-xs",
    md: "h-9 w-9 text-sm",
    lg: "h-11 w-11 text-base",
    xl: "h-14 w-14 text-lg",
  };

  const indicatorSize = {
    sm: "h-2 w-2 border",
    md: "h-2.5 w-2.5 border-2",
    lg: "h-3 w-3 border-2",
    xl: "h-3.5 w-3.5 border-2",
  };

  const statusColor = {
    online: "bg-[var(--p-success)]",
    away:   "bg-[var(--p-warning)]",
    offline:"bg-[var(--p-muted-fg)]",
    busy:   "bg-[var(--p-error)]",
  };

  let imgFailed = $state(false);
</script>

<div class={cn("relative inline-flex shrink-0", className)}>
  <div
    class={cn(
      "flex items-center justify-center rounded-full overflow-hidden select-none",
      "bg-[var(--p-secondary)] text-[var(--p-secondary-fg)] font-medium",
      sizeClasses[size]
    )}
    aria-label={alt || fallback}
  >
    {#if src && !imgFailed}
      <img
        {src}
        {alt}
        class="h-full w-full object-cover"
        draggable={false}
        onerror={() => (imgFailed = true)}
      />
    {/if}
    {#if !src || imgFailed}
      <span class="leading-none">{fallback.slice(0, 2)}</span>
    {/if}
  </div>

  {#if status}
    <span
      class={cn(
        "absolute bottom-0 right-0 rounded-full border-[var(--p-card)]",
        indicatorSize[size],
        statusColor[status]
      )}
      aria-label={status}
    ></span>
  {/if}
</div>
