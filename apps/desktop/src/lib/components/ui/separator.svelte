<!--
  Separator.svelte — minimal divider. No decorative borders by default.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    class?: string;
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
  }

  let {
    class: className = "",
    orientation = "horizontal",
    decorative = true,
  }: Props = $props();
</script>

<div
  role={decorative ? "none" : "separator"}
  aria-orientation={decorative ? undefined : orientation}
  class={cn(
    "shrink-0 bg-[var(--p-border)]",
    orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
    className
  )}
/>
