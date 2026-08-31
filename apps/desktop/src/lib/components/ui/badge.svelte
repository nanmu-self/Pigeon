<!--
  Badge.svelte — minimal status badge for unread counts and labels.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    class?: string;
    variant?: "default" | "success" | "warning" | "error" | "outline" | "muted";
    size?: "sm" | "md";
    children: import("svelte").Snippet;
  }

  let {
    class: className = "",
    variant = "default",
    size = "sm",
    children,
  }: Props = $props();

  const base = "inline-flex items-center justify-center font-medium leading-none shrink-0";

  const variants = {
    default: "bg-[var(--p-primary)] text-[var(--p-primary-fg)]",
    success: "bg-[var(--p-success-muted)] text-[var(--p-success)]",
    warning: "bg-[var(--p-warning-muted)] text-[var(--p-warning)]",
    error:   "bg-[var(--p-error-muted)]   text-[var(--p-error)]",
    outline: "border border-[var(--p-border)] text-[var(--p-fg)]",
    muted:   "bg-[var(--p-muted)] text-[var(--p-muted-fg)]",
  };

  const sizes = {
    sm: "min-h-[1.125rem] px-1.5 rounded-full text-[10px]",
    md: "min-h-[1.375rem] px-2 rounded-full text-xs",
  };
</script>

<span class={cn(base, variants[variant], sizes[size], className)}>
  {@render children()}
</span>
