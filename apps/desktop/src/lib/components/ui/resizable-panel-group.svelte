<!--
  ResizablePanelGroup.svelte — horizontal panel container.
  Supports drag-to-resize via native mouse events.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    class?: string;
    direction?: "horizontal" | "vertical";
    children: import("svelte").Snippet;
  }

  let {
    class: className = "",
    direction = "horizontal",
    children,
  }: Props = $props();

  let groupRef: HTMLDivElement | null = $state(null);
  let panels: { el: HTMLElement; minSize: number; maxSize: number; size: number }[] = $state([]);

  export function registerPanel(el: HTMLElement, min: number, max: number, size: number) {
    panels = [...panels, { el, minSize: min, maxSize: max, size }];
  }
  export function unregisterPanel(el: HTMLElement) {
    panels = panels.filter((p) => p.el !== el);
  }
</script>

<div
  bind:this={groupRef}
  class={cn(
    "flex",
    direction === "horizontal" ? "flex-row" : "flex-col",
    "h-full w-full",
    className
  )}
>
  {@render children?.()}
</div>
