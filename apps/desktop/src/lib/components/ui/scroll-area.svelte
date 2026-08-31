<!--
  ScrollArea.svelte — lightweight scroll container with styled thin scrollbar.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    class?: string;
    horizontal?: boolean;
    children: import("svelte").Snippet;
  }

  let {
    class: className = "",
    horizontal = false,
    children,
  }: Props = $props();
</script>

<div
  class={cn(
    "scroll-area-thin",
    horizontal
      ? "overflow-x-auto overflow-y-hidden whitespace-nowrap"
      : "overflow-y-auto overflow-x-hidden",
    className
  )}
>
  <slot />
</div>
