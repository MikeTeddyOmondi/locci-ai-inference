<script lang="ts">
	import './layout.css';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { brand } from '$lib/brand';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import SignIn from '$lib/components/SignIn.svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { auth, initAuth } from '$lib/state/auth.svelte';
	import { loadThreads } from '$lib/state/conversationState.svelte';
	import { loadApiInfo, ui } from '$lib/state/ui.svelte';

	let { children } = $props();

	// The drawer only exists below md; widening the window closes it.
	const desktop = new MediaQuery('min-width: 768px');

	// Sign-in settles first: the thread store and the API calls depend on who is signed in.
	onMount(async () => {
		await initAuth();
		if (auth.mode === 'locci' && !auth.user) return;
		loadThreads();
		loadApiInfo();
	});

	const signedIn = $derived(auth.mode === 'off' || auth.user !== null);
</script>

<ModeWatcher defaultMode="system" />
<svelte:head>
	<title>{brand.name}</title>
</svelte:head>

{#if !auth.ready}
	<div class="h-dvh w-full bg-background" aria-busy="true"></div>
{:else if !signedIn}
	<SignIn />
{:else}
<!-- h-dvh tracks the visible viewport on mobile (100vh includes the area under
     the browser's URL bar, which is what pushed the composer off-screen). -->
<Tooltip.Provider delayDuration={300}>
	<div class="flex h-dvh w-full overflow-hidden bg-background text-foreground">
		<!-- Desktop: persistent sidebar, or an icon rail when collapsed. -->
		<div class="hidden shrink-0 md:flex">
			<Sidebar rail={ui.sidebarCollapsed} />
		</div>

		<main class="flex min-w-0 flex-1 flex-col">
			<TopBar />
			{@render children()}
		</main>
	</div>

	<!-- Mobile: the sidebar as a drawer over the chat. -->
	<Sheet.Root bind:open={() => ui.sidebarOpen && !desktop.current, (v) => (ui.sidebarOpen = v)}>
		<Sheet.Content side="left" showCloseButton={false} class="w-[min(18rem,85vw)] gap-0 border-r-0 p-0">
			<Sheet.Title class="sr-only">Chats</Sheet.Title>
			<Sidebar drawer />
		</Sheet.Content>
	</Sheet.Root>
</Tooltip.Provider>
{/if}
