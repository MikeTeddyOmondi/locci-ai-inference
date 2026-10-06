<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils/cn';

	type Props = HTMLInputAttributes;

	let { class: className, value = $bindable(), ...rest }: Props = $props();
</script>

<input
	class={cn(
		'flex h-11 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base placeholder:text-gray-500 focus:border-gray-400 focus:ring-1 focus:ring-gray-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-white dark:placeholder:text-neutral-500 dark:focus:border-neutral-500 dark:focus:ring-neutral-500 md:h-10 md:text-sm',
		className
	)}
	bind:value
	{...rest}
/>
