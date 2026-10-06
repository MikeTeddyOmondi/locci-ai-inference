<script lang="ts">
	import { Sun, Moon } from 'lucide-svelte';
	import { toggleMode, mode } from 'mode-watcher';
</script>

<button
	onclick={toggleMode}
	class="cursor-pointer rounded-md p-2 text-gray-600 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
	aria-label="Toggle theme"
>
	{#if mode.current === 'dark'}
		<Sun class="h-5 w-5" />
	{:else}
		<Moon class="h-5 w-5" />
	{/if}
</button>
