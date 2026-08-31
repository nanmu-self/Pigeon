<script lang="ts">
  import { cn } from "$lib/utils";

  let { class: className = "" }: { class?: string } = $props();
</script>

<div class={cn("flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--p-border)]", className)}>
  <slot />
</div>
