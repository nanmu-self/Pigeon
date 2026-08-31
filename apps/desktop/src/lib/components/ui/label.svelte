<script lang="ts">
  import { cn } from "$lib/utils";
  import type { HTMLLabelAttributes } from "svelte/elements";

  interface Props extends HTMLLabelAttributes {}

  let { class: className = "", ...restProps }: Props = $props();
</script>

<label
  class={cn(
    "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
    className
  )}
  {...restProps}
>
  <slot />
</label>
