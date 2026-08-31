<script lang="ts">
  import { cn } from "$lib/utils";

  let { class: className = "" }: { class?: string } = $props();
</script>

<div class={cn("flex-1 overflow-y-auto scroll-area-thin", className)}>
  <slot />
</div>
