<!--
  Skeleton.svelte — content placeholder for loading states.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    class?: string;
    variant?: "text" | "circular" | "rectangular";
    width?: number | string;
    height?: number | string;
  }

  let {
    class: className = "",
    variant = "rectangular",
    width,
    height,
  }: Props = $props();

  const variants = {
    text: "rounded-sm",
    circular: "rounded-full",
    rectangular: "rounded-md",
  };

  // Build style string reactively
  let w = $derived(width !== undefined ? (typeof width === "number" ? `${width}px` : width) : "");
  let h = $derived(height !== undefined ? (typeof height === "number" ? `${height}px` : height) : "");
  let styleStr = $derived([w, h].filter(Boolean).join(";"));
</script>

<div
  class={cn(
    "animate-pulse bg-[var(--p-muted)]",
    variants[variant],
    className
  )}
  style={styleStr || undefined}
  aria-hidden="true"
/>
