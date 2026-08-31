<script lang="ts">
  import { cn } from "$lib/utils";
  import type { HTMLInputAttributes } from "svelte/elements";

  interface Props extends HTMLInputAttributes {
    error?: boolean;
    value?: string;
  }

  let {
    class: className = "",
    error = false,
    value = $bindable(""),
    ...restProps
  }: Props = $props();
</script>

<input
  bind:value
  class={cn(
    "flex h-10 w-full rounded-md border border-[var(--p-input)] bg-[var(--p-bg)] px-3 py-2 text-sm ring-offset-[var(--p-bg)] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-[var(--p-muted-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--p-ring)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
    error && "border-[var(--p-destructive)] focus-visible:ring-[var(--p-destructive)]",
    className
  )}
  {...restProps}
/>
