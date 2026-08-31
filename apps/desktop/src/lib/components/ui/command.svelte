<!--
  Command.svelte — global command palette (Ctrl+K).
  Built with native HTML: input filter, scrollable list, keyboard nav.
-->
<script lang="ts">
  import { cn } from "$lib/utils";
  import { onMount } from "svelte";
  import Search from "@lucide/svelte/icons/search";

  interface CommandItem {
    id: string;
    label: string;
    shortcut?: string[];
    action?: () => void;
  }

  interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    items?: CommandItem[];
    filterPlaceholder?: string;
  }

  let {
    open = $bindable(false),
    onOpenChange,
    items = [],
    filterPlaceholder = "搜索…",
  }: Props = $props();

  let query = $state("");
  let selectedIdx = $state(0);
  let inputEl: HTMLInputElement | null = $state(null);
  let listRef: HTMLDivElement | null = $state(null);

  const flatItems = $derived(() => {
    const q = query.toLowerCase().trim();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q));
  });

  function handleKeydown(e: KeyboardEvent) {
    const list = flatItems();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, list.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
    } else if (e.key === "Enter" && list[selectedIdx]) {
      e.preventDefault();
      list[selectedIdx].action?.();
      onOpenChange(false);
    } else if (e.key === "Escape") {
      onOpenChange(false);
    }
  }

  $effect(() => {
    if (open) {
      query = "";
      selectedIdx = 0;
      onMount(() => inputEl?.focus());
    }
  });

  $effect(() => {
    if (listRef) {
      const selected = listRef.querySelector('[aria-selected="true"]');
      selected?.scrollIntoView({ block: "nearest" });
    }
  });

  // Ctrl+K shortcut
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  });
</script>

{#if open}
  <div role="presentation" class="fixed inset-0 z-[60] bg-black/50" onclick={() => onOpenChange(false)} />
  <div
    role="dialog"
    aria-modal="true"
    class="fixed left-1/2 top-[20%] z-[61] w-full max-w-lg -translate-x-1/2 anim-scale-in"
  >
    <div class="flex flex-col overflow-hidden rounded-lg border border-[var(--p-border)] bg-[var(--p-card)] shadow-lg">
      <!-- Search -->
      <div class="flex items-center gap-2.5 border-b border-[var(--p-border)] px-4">
        <Search class="h-4 w-4 shrink-0 text-[var(--p-muted-fg)]" />
        <input
          bind:this={inputEl}
          bind:value={query}
          onkeydown={handleKeydown}
          type="text"
          placeholder={filterPlaceholder}
          class="h-11 w-full bg-transparent text-sm text-[var(--p-fg)] placeholder:text-[var(--p-muted-fg)] focus:outline-none"
        />
        <kbd class="hidden sm:inline-flex shrink-0 items-center gap-0.5 rounded border border-[var(--p-border)] bg-[var(--p-muted)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--p-muted-fg)]">
          ESC
        </kbd>
      </div>

      <!-- List -->
      <div bind:this={listRef} class="scroll-area-thin max-h-[18rem] overflow-y-auto py-1.5">
        {#if flatItems().length === 0}
          <p class="px-4 py-6 text-center text-sm text-[var(--p-muted-fg)]">
            未找到「{query}」的结果
          </p>
        {:else}
          {#each flatItems() as item, idx (item.id)}
            {@const selected = idx === selectedIdx}
            <button
              aria-selected={selected}
              onclick={() => {
                item.action?.();
                onOpenChange(false);
              }}
              onmouseenter={() => (selectedIdx = idx)}
              class={cn(
                "flex w-full items-center gap-3 px-4 py-2 text-left transition-fast",
                selected
                  ? "bg-[var(--p-primary-muted)] text-[var(--p-fg)]"
                  : "text-[var(--p-muted-fg)] hover:bg-[var(--p-muted)] hover:text-[var(--p-fg)]"
              )}
            >
              <span class="flex-1 text-sm">{item.label}</span>
              {#if item.shortcut}
                <div class="flex items-center gap-1">
                  {#each item.shortcut as key}
                    <kbd class="rounded border border-[var(--p-border)] bg-[var(--p-muted)] px-1.5 py-px text-[10px] font-mono text-[var(--p-muted-fg)]">
                      {key}
                    </kbd>
                  {/each}
                </div>
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      <!-- Footer -->
      <div class="flex items-center gap-3 border-t border-[var(--p-border)] px-4 py-2 text-[11px] text-[var(--p-muted-fg)]">
        <span>↑↓ 导航 · ↵ 选择 · Esc 关闭</span>
      </div>
    </div>
  </div>
{/if}
