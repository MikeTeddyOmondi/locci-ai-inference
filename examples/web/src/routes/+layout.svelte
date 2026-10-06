<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import NewChatModal from '$lib/components/NewChatModal.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { newChatModalState } from '$lib/state/newChatModalState.svelte';
	import { ModeWatcher } from 'mode-watcher';
	import { Menu, X } from 'lucide-svelte';

	let { children } = $props();

	let isSidebarOpen = $state(false);

	function toggleSidebar() {
		isSidebarOpen = !isSidebarOpen;
	}

	function closeSidebar() {
		isSidebarOpen = false;
	}

	function handleNewChatModalClose() {
		newChatModalState.close();
		closeSidebar();
	}
</script>

<ModeWatcher />
<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<div class="flex h-screen w-screen overflow-hidden bg-white dark:bg-black">
	<!-- Sidebar backdrop -->
	{#if isSidebarOpen}
		<button
			class="fixed inset-0 z-40 bg-black/50"
			onclick={closeSidebar}
			aria-label="Close sidebar"
		></button>
	{/if}

	<!-- Sidebar - hidden by default, shown when toggled -->
	<div
		class="fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-300 ease-in-out {isSidebarOpen
			? 'translate-x-0'
			: '-translate-x-full'}"
	>
		<Sidebar onClose={closeSidebar} />
	</div>

	<!-- Main content -->
	<div class="flex flex-1 flex-col overflow-hidden">
		<!-- Header with hamburger menu -->
		<div
			class="relative z-10 flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-black"
		>
			<div class="flex items-center">
				<button
					onclick={toggleSidebar}
					class="mr-3 cursor-pointer rounded-md p-2 text-gray-600 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
					aria-label="Toggle sidebar"
				>
					{#if isSidebarOpen}
						<X class="h-6 w-6" />
					{:else}
						<Menu class="h-6 w-6" />
					{/if}
				</button>
				<h1 class="text-lg font-semibold text-gray-900 dark:text-white">Autonomous Chatbot</h1>
			</div>
			<ThemeToggle />
		</div>

		{@render children()}
	</div>
</div>

<NewChatModal open={newChatModalState.isOpen} onClose={handleNewChatModalClose} />
