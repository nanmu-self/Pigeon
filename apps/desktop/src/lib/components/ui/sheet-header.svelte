<script lang="ts">
  import { cn } from "$lib/utils";

  let { class: className = "" }: { class?: string } = $props();
</script>

<div class={cn("flex items-center justify-between px-5 py-3.5 border-b border-[var(--p-border)]", className)}>
  <slot />
</div>
