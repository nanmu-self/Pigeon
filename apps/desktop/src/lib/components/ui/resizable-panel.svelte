<!--
  ResizablePanel.svelte — single panel with drag handle.
  Props: defaultSize (number for px or "flex-1"), minSize, maxSize, collapsible.
-->
<script lang="ts">
  import { cn } from "$lib/utils";

  interface Props {
    class?: string;
    defaultSize?: number | string;
    minSize?: number;
    maxSize?: number;
    collapsible?: boolean;
    collapsedSize?: number;
    children: import("svelte").Snippet;
  }

  let {
    class: className = "",
    defaultSize = "flex-1",
    minSize = 60,
    maxSize = 500,
    collapsible = false,
    collapsedSize = 0,
    children,
  }: Props = $props();

  let panelEl: HTMLDivElement | null = $state(null);
  let collapsed = $state(false);
  let isResizing = $state(false);
  let currentSize = $state(0);

  $effect(() => {
    if (typeof defaultSize === "number" && panelEl && !collapsed) {
      panelEl.style.width = `${defaultSize}px`;
      panelEl.style.flex = "none";
      currentSize = defaultSize;
    }
  });

  function handleMouseDown(e: MouseEvent) {
    isResizing = true;
    const startX = e.clientX;
    const startWidth = panelEl?.offsetWidth ?? 200;

    function onMouseMove(e: MouseEvent) {
      if (!panelEl) return;
      const delta = e.clientX - startX;
      let newWidth = startWidth + delta;
      newWidth = Math.max(minSize, Math.min(maxSize, newWidth));
      currentSize = newWidth;
      panelEl.style.width = `${newWidth}px`;
      panelEl.style.flex = "none";
    }

    function onMouseUp() {
      isResizing = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function handleDoubleClick() {
    if (!collapsible) return;
    collapsed = !collapsed;
    if (!panelEl) return;
    if (collapsed) {
      panelEl.style.width = `${collapsedSize}px`;
      panelEl.style.flex = "none";
    } else if (typeof defaultSize === "number") {
      panelEl.style.width = `${defaultSize}px`;
      panelEl.style.flex = "none";
      currentSize = defaultSize;
    } else {
      panelEl.style.width = "";
      panelEl.style.flex = defaultSize;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowLeft") {
      const newW = Math.max(minSize, currentSize - 10);
      if (panelEl) { panelEl.style.width = `${newW}px`; panelEl.style.flex = "none"; }
      currentSize = newW;
    }
    if (e.key === "ArrowRight") {
      const newW = Math.min(maxSize, currentSize + 10);
      if (panelEl) { panelEl.style.width = `${newW}px`; panelEl.style.flex = "none"; }
      currentSize = newW;
    }
  }
</script>

<div
  bind:this={panelEl}
  class={cn(
    "relative flex shrink-0",
    typeof defaultSize === "string" && defaultSize.startsWith("flex") ? defaultSize : "flex-none",
    isResizing && "select-none"
  )}
  style={typeof defaultSize === "number" && !collapsed ? `width:${defaultSize}px;flex:none;` : ""}
>
  {@render children()}

  <!-- Resize handle -->
  <div
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    onmousedown={handleMouseDown}
    ondblclick={handleDoubleClick}
    onkeydown={handleKeydown}
    class={cn(
      "group absolute top-0 right-0 h-full w-[3px] cursor-col-resize",
      "bg-transparent hover:bg-[var(--p-ring)]",
      "transition-colors duration-150 z-10"
    )}
  />
</div>
