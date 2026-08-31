<!--
  Sheet.svelte — slide-in panel (drawer).
  Animations: 150ms slide via svelte/transition.
-->
<script lang="ts">
  import { cn } from "$lib/utils";
  import { slide } from "svelte/transition";

  interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    side?: "left" | "right";
    class?: string;
    children: import("svelte").Snippet;
  }

  let {
    open: sheetOpen = $bindable(false),
    onOpenChange,
    side = "right",
    class: className = "",
    children,
  }: Props = $props();

  let sheetRef: HTMLDivElement | null = $state(null);

  function handleOverlayClick() {
    onOpenChange(false);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onOpenChange(false);
  }

  const sideClasses = {
    right: "inset-y-0 right-0 border-l",
    left:  "inset-y-0 left-0 border-r",
  };

  $effect(() => {
    document.body.style.overflow = sheetOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  });
</script>

{#if sheetOpen}
  <!-- Overlay -->
  <div
    role="presentation"
    class="fixed inset-0 z-50 bg-black/40 transition-opacity duration-150 anim-fade-in"
    onclick={handleOverlayClick}
    onkeydown={handleKeydown}
  />

  <!-- Panel -->
  <div
    bind:this={sheetRef}
    role="dialog"
    aria-modal="true"
    class={cn(
      "fixed z-50 flex flex-col bg-[var(--p-card)] shadow-lg",
      "w-full max-w-sm sm:max-w-md",
      sideClasses[side]
    )}
    transition:slide={{ duration: 150 }}
  >
    {@render children()}
  </div>
{/if}
