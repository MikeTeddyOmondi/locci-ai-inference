<script lang="ts">
	import { Moon, Sun } from '@lucide/svelte';
	import { mode, toggleMode } from 'mode-watcher';
	import IconButton from './IconButton.svelte';
</script>

<IconButton label={mode.current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onclick={toggleMode}>
	{#if mode.current === 'dark'}
		<Sun />
	{:else}
		<Moon />
	{/if}
</IconButton>
