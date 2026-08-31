<!--
  Popover.svelte — click-triggered floating panel.
  Animations: 150ms scaleIn.
-->
<script lang="ts">
  import { cn } from "$lib/utils";
  import { onMount } from "svelte";

  interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    side?: "top" | "bottom" | "left" | "right";
    class?: string;
    children: import("svelte").Snippet;
    trigger: import("svelte").Snippet;
  }

  let {
    open = $bindable(false),
    onOpenChange,
    side = "bottom",
    class: className = "",
    children,
    trigger,
  }: Props = $props();

  let triggerRef: HTMLElement | null = $state(null);
  let popoverRef: HTMLDivElement | null = $state(null);

  function handleTriggerClick() {
    onOpenChange(!open);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpenChange(!open);
    }
    if (e.key === "Escape") {
      onOpenChange(false);
    }
  }

  onMount(() => {
    function handleDocClick(e: MouseEvent) {
      if (
        popoverRef && !popoverRef.contains(e.target as Node) &&
        triggerRef && !triggerRef.contains(e.target as Node)
      ) {
        onOpenChange(false);
      }
    }
    document.addEventListener("mousedown", handleDocClick);
    return () => document.removeEventListener("mousedown", handleDocClick);
  });

  const sideClasses = {
    bottom: "top-full mt-1.5 left-0",
    top:    "bottom-full mb-1.5 left-0",
    right:  "left-full ml-1.5 top-0",
    left:   "right-full mr-1.5 top-0",
  };
</script>

<div class="relative inline-flex" bind:this={triggerRef}>
  <div
    role="button"
    tabindex="0"
    onclick={handleTriggerClick}
    onkeydown={handleKeydown}
  >
    {@render trigger()}
  </div>

  {#if open}
    <div
      bind:this={popoverRef}
      role="dialog"
      class={cn(
        "absolute z-50 rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] shadow-lg anim-scale-in",
        sideClasses[side],
        className
      )}
    >
      {@render children()}
    </div>
  {/if}
</div>
