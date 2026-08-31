<script lang="ts">
  import { cn } from "$lib/utils";
  import type { HTMLButtonAttributes } from "svelte/elements";

  interface Props extends HTMLButtonAttributes {
    variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
    size?: "default" | "sm" | "lg" | "icon";
  }

  let {
    class: className = "",
    variant = "default",
    size = "default",
    ...restProps
  }: Props = $props();

  const variants = {
    default:    "bg-[var(--p-primary)] text-[var(--p-primary-fg)] hover:bg-[var(--p-primary-hover)]",
    destructive:"bg-[var(--p-destructive)] text-[var(--p-destructive-fg)] hover:opacity-90",
    outline:    "border border-[var(--p-border)] bg-transparent hover:bg-[var(--p-accent)] hover:text-[var(--p-accent-fg)]",
    secondary:  "bg-[var(--p-secondary)] text-[var(--p-secondary-fg)] hover:bg-[var(--p-secondary)]/80",
    ghost:      "hover:bg-[var(--p-accent)] hover:text-[var(--p-accent-fg)]",
    link:       "text-[var(--p-primary)] underline-offset-4 hover:underline",
  };

  const sizes = {
    default: "h-9 px-4 py-2",
    sm:      "h-8 rounded-md px-3 text-xs",
    lg:      "h-10 rounded-md px-8",
    icon:    "h-9 w-9",
  };
</script>

<button
  class={cn(
    "inline-flex items-center justify-center whitespace-nowrap rounded-md font-medium transition-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--p-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--p-bg)]",
    "disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    sizes[size],
    className
  )}
  {...restProps}
>
  <slot />
</button>
