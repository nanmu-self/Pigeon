<script lang="ts">
  import { cn } from "$lib/utils";

  let { class: className = "" }: { class?: string } = $props();
</script>

<h2 class={cn("text-sm font-semibold text-[var(--p-fg)] tracking-tight", className)}>
  <slot />
</h2>
