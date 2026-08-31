<script lang="ts">
  import { cn } from "$lib/utils";

  let { class: className = "" }: { class?: string } = $props();
</script>

<p class={cn("text-xs text-[var(--p-muted-fg)] mt-0.5", className)}>
  <slot />
</p>
