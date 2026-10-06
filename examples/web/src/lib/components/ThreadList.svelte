<script lang="ts">
	import { goto } from '$app/navigation';
	import { conversationState, loadThreads, toggleStar } from '$lib/state/conversationState.svelte';
	import { newChatModalState } from '$lib/state/newChatModalState.svelte';
	import Button from './Button.svelte';
	import { Plus, MessageSquare, Star } from 'lucide-svelte';

	// Load threads on mount
	$effect(() => {
		loadThreads();
	});

	// Derived: separate starred and unstarred threads
	const starredThreads = $derived(conversationState.threads.filter((t) => t.starred));
	const unstarredThreads = $derived(conversationState.threads.filter((t) => !t.starred));

	function handleSelectThread(threadId: string) {
		goto(`/chats/${threadId}`);
	}

	function handleNewChat() {
		newChatModalState.open();
	}

	async function handleToggleStar(e: Event, threadId: string) {
		e.stopPropagation();
		await toggleStar(threadId);
	}

	function formatDate(date: Date | string): string {
		const dateObj = typeof date === 'string' ? new Date(date) : date;
		const now = new Date();
		const diffMs = now.getTime() - dateObj.getTime();
		const diffMins = Math.floor(diffMs / 60000);
		const diffHours = Math.floor(diffMs / 3600000);
		const diffDays = Math.floor(diffMs / 86400000);

		if (diffMins < 1) return 'just now';
		if (diffMins < 60) return `${diffMins}m ago`;
		if (diffHours < 24) return `${diffHours}h ago`;
		if (diffDays < 7) return `${diffDays}d ago`;

		return dateObj.toLocaleDateString();
	}

	function getShortId(id: string): string {
		return id.substring(0, 8);
	}

	function getDisplayTitle(thread: { id: string; title: string }): string {
		if (!thread.title || thread.title === 'New Chat') {
			return getShortId(thread.id);
		}
		return thread.title;
	}
</script>

<div class="flex h-full flex-col bg-gray-50 dark:bg-black">
	<!-- Header -->
	<div class="border-b border-gray-200 bg-white px-4 py-4 dark:border-neutral-800 dark:bg-black md:px-6">
		<div class="flex items-center justify-between">
			<div>
				<h1 class="text-xl font-bold text-gray-900 dark:text-white md:text-2xl">Your Conversations</h1>
				<p class="mt-1 text-sm text-gray-600 dark:text-neutral-400">Select a conversation or start a new one</p>
			</div>
			<Button onclick={handleNewChat} class="hidden md:flex">
				<Plus class="mr-2 h-4 w-4" />
				New Chat
			</Button>
		</div>
	</div>

	<!-- Thread List -->
	<div class="flex-1 overflow-y-auto p-4 md:p-6">
		{#if conversationState.isLoading}
			<div class="flex items-center justify-center py-12">
				<p class="text-gray-500 dark:text-neutral-500">Loading conversations...</p>
			</div>
		{:else if conversationState.threads.length === 0}
			<div class="flex flex-col items-center justify-center py-12 text-center">
				<div
					class="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-200 dark:bg-neutral-800"
				>
					<MessageSquare class="h-8 w-8 text-gray-400 dark:text-neutral-500" />
				</div>
				<h2 class="text-lg font-semibold text-gray-900 dark:text-white">No conversations yet</h2>
				<p class="mt-2 max-w-sm text-sm text-gray-600 dark:text-neutral-400">
					Start a new conversation to get started
				</p>
				<Button onclick={handleNewChat} class="mt-4">
					<Plus class="mr-2 h-4 w-4" />
					Start New Chat
				</Button>
			</div>
		{:else}
			<!-- Starred threads section -->
			{#if starredThreads.length > 0}
				<div class="mb-3 flex items-center gap-2">
					<Star class="h-4 w-4 fill-yellow-400 text-yellow-400" />
					<h2 class="text-sm font-semibold text-gray-700 dark:text-neutral-300">Starred</h2>
				</div>
				<div class="mb-6 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
					{#each starredThreads as thread (thread.id)}
						<div
							role="button"
							tabindex="0"
							class="group relative flex cursor-pointer flex-col rounded-lg border border-yellow-200 bg-white p-4 text-left transition-all hover:border-yellow-300 hover:shadow-md dark:border-yellow-900 dark:bg-neutral-950 dark:hover:border-yellow-700"
							onclick={() => handleSelectThread(thread.id)}
							onkeydown={(e) => e.key === 'Enter' && handleSelectThread(thread.id)}
						>
							<button
								class="absolute right-2 top-2 cursor-pointer rounded p-1 text-yellow-400 transition-colors hover:bg-yellow-50 dark:hover:bg-yellow-900/30"
								onclick={(e) => handleToggleStar(e, thread.id)}
								title="Unstar conversation"
							>
								<Star class="h-4 w-4 fill-yellow-400" />
							</button>
							<h3 class="truncate pr-8 font-medium text-gray-900 dark:text-white">
								{getDisplayTitle(thread)}
							</h3>
							<p class="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-neutral-400">
								{thread.preview || 'No messages yet'}
							</p>
							<p class="mt-2 text-xs text-gray-400 dark:text-neutral-500">
								{formatDate(thread.updatedAt)}
							</p>
						</div>
					{/each}
				</div>
			{/if}

			<!-- Separator -->
			{#if starredThreads.length > 0 && unstarredThreads.length > 0}
				<div class="mb-6 border-t border-gray-200 dark:border-neutral-800"></div>
			{/if}

			<!-- Unstarred threads section -->
			{#if unstarredThreads.length > 0}
				{#if starredThreads.length > 0}
					<div class="mb-3">
						<h2 class="text-sm font-semibold text-gray-700 dark:text-neutral-300">Other conversations</h2>
					</div>
				{/if}
				<div class="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
					{#each unstarredThreads as thread (thread.id)}
						<div
							role="button"
							tabindex="0"
							class="group relative flex cursor-pointer flex-col rounded-lg border border-gray-200 bg-white p-4 text-left transition-all hover:border-gray-300 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-700"
							onclick={() => handleSelectThread(thread.id)}
							onkeydown={(e) => e.key === 'Enter' && handleSelectThread(thread.id)}
						>
							<button
								class="absolute right-2 top-2 cursor-pointer rounded p-1 text-gray-300 opacity-0 transition-all hover:bg-yellow-50 hover:text-yellow-400 group-hover:opacity-100 dark:text-neutral-600 dark:hover:bg-yellow-900/30"
								onclick={(e) => handleToggleStar(e, thread.id)}
								title="Star conversation"
							>
								<Star class="h-4 w-4" />
							</button>
							<h3 class="truncate pr-8 font-medium text-gray-900 dark:text-white">
								{getDisplayTitle(thread)}
							</h3>
							<p class="mt-1 line-clamp-2 text-sm text-gray-500 dark:text-neutral-400">
								{thread.preview || 'No messages yet'}
							</p>
							<p class="mt-2 text-xs text-gray-400 dark:text-neutral-500">
								{formatDate(thread.updatedAt)}
							</p>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	<!-- Mobile FAB for new chat -->
	<div class="fixed bottom-6 right-6 md:hidden">
		<Button onclick={handleNewChat} size="icon" class="h-14 w-14 rounded-full shadow-lg">
			<Plus class="h-6 w-6" />
		</Button>
	</div>
</div>
