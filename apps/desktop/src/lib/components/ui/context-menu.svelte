<!--
  ContextMenu.svelte — right-click menu.
  Animations: 150ms fade, no elastic.
-->
<script lang="ts">
  import { cn } from "$lib/utils";
  import { onMount } from "svelte";

  interface MenuItem {
    id: string;
    label: string;
    /** Lucide 图标组件（如 `import Trash2 from "@lucide/svelte/icons/trash-2"`） */
    icon?: import("svelte").Component;
    disabled?: boolean;
    danger?: boolean;
    separator?: boolean;
    action?: () => void;
  }

  interface Props {
    items: MenuItem[];
    children: import("svelte").Snippet;
  }

  let { items = [], children }: Props = $props();

  let open = $state(false);
  let x = $state(0);
  let y = $state(0);
  let menuRef: HTMLDivElement | null = $state(null);
  let triggerEl: HTMLElement | null = $state(null);

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    x = Math.min(e.clientX, vw - 220);
    y = Math.min(e.clientY, vh - items.length * 36 - 8);
    open = true;
  }

  function handleClickOutside(e: MouseEvent) {
    if (
      menuRef && !menuRef.contains(e.target as Node) &&
      triggerEl && !triggerEl.contains(e.target as Node)
    ) {
      open = false;
    }
  }

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside, true);
    return () => document.removeEventListener("mousedown", handleClickOutside, true);
  });

  function handleItemClick(item: MenuItem) {
    if (!item.disabled) {
      item.action?.();
      open = false;
    }
  }
</script>

<!-- Trigger wrapper with role for contextmenu -->
<div
  bind:this={triggerEl}
  oncontextmenu={handleContextMenu}
  role="menu"
  class="inline-block"
>
  {@render children()}
</div>

<!-- Menu -->
{#if open}
  <div
    bind:this={menuRef}
    role="menu"
    class="fixed z-[70] min-w-[200px] rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] py-1.5 shadow-lg anim-fade-in"
    style="left:{x}px;top:{y}px;"
  >
    {#each items as item}
      {#if item.separator}
        <div class="h-px bg-[var(--p-border)] my-1 mx-1.5" />
      {:else}
        <button
          role="menuitem"
          disabled={item.disabled}
          onclick={() => handleItemClick(item)}
          class={cn(
            "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-fast",
            item.danger
              ? "text-[var(--p-destructive)] hover:bg-[var(--p-destructive-muted)]"
              : "text-[var(--p-fg)] hover:bg-[var(--p-muted)]",
            item.disabled && "opacity-40 pointer-events-none"
          )}
        >
          {#if item.icon}
            {@const Icon = item.icon}
            <Icon size={16} class="shrink-0" />
          {/if}
          <span class="flex-1">{item.label}</span>
        </button>
      {/if}
    {/each}
  </div>
{/if}
