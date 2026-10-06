<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		conversationState,
		deleteConversation,
		clearAllConversations,
		loadThreads,
		updateConversation,
		toggleStar
	} from '$lib/state/conversationState.svelte';
	import { newChatModalState } from '$lib/state/newChatModalState.svelte';
	import Button from './Button.svelte';
	import { Trash2, Plus, Pencil, Check, X, Star } from 'lucide-svelte';

	interface Props {
		onClose?: () => void;
	}

	const { onClose }: Props = $props();

	// Track which thread is being edited
	let editingThreadId = $state<string | null>(null);
	let editingTitle = $state('');

	// Derived: separate starred and unstarred threads
	const starredThreads = $derived(conversationState.threads.filter((t) => t.starred));
	const unstarredThreads = $derived(conversationState.threads.filter((t) => !t.starred));

	async function handleToggleStar(e: Event, threadId: string) {
		e.stopPropagation();
		await toggleStar(threadId);
	}

	// Load threads on mount
	$effect(() => {
		loadThreads();
	});

	function handleNewChat() {
		newChatModalState.open();
	}

	async function handleDeleteConversation(e: Event, threadId: string) {
		e.stopPropagation();
		await deleteConversation(threadId);
	}

	function handleSelectConversation(threadId: string) {
		if (editingThreadId === threadId) return; // Don't select while editing
		// Navigate to thread URL - this will set activeThreadId via the route
		goto(`/chats/${threadId}`);
		// Close sidebar on mobile after selecting
		onClose?.();
	}

	function handleKeyDown(e: KeyboardEvent, threadId: string) {
		if (editingThreadId === threadId) return;
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			handleSelectConversation(threadId);
		}
	}

	function startEditing(e: Event, threadId: string, currentTitle: string) {
		e.stopPropagation();
		editingThreadId = threadId;
		editingTitle = currentTitle === 'New Chat' ? '' : currentTitle;
	}

	async function saveTitle(e: Event, threadId: string) {
		e.stopPropagation();
		const title = editingTitle.trim() || getShortId(threadId);
		await updateConversation(threadId, { title });
		editingThreadId = null;
		editingTitle = '';
	}

	function cancelEditing(e: Event) {
		e.stopPropagation();
		editingThreadId = null;
		editingTitle = '';
	}

	function handleEditKeyDown(e: KeyboardEvent, threadId: string) {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveTitle(e, threadId);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancelEditing(e);
		}
	}

	async function handleClearAll() {
		if (confirm('Are you sure you want to delete all conversations? This cannot be undone.')) {
			await clearAllConversations();
		}
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

	// Get shortened ID for display (first 8 chars)
	function getShortId(id: string): string {
		return id.substring(0, 8);
	}

	// Get display title - use title if meaningful, otherwise short ID
	function getDisplayTitle(thread: { id: string; title: string }): string {
		if (!thread.title || thread.title === 'New Chat') {
			return getShortId(thread.id);
		}
		return thread.title;
	}
</script>

<div class="flex h-screen w-64 flex-col border-r border-gray-200 bg-white dark:border-neutral-800 dark:bg-black">
	<!-- Header -->
	<div class="border-b border-gray-200 px-4 py-4 dark:border-neutral-800">
		<Button class="w-full" onclick={handleNewChat}>
			<Plus class="mr-2 h-4 w-4" />
			New Chat
		</Button>
	</div>

	<!-- Conversations List -->
	<div class="flex-1 overflow-y-auto">
		{#if conversationState.isLoading}
			<div class="flex items-center justify-center px-4 py-8">
				<p class="text-sm text-gray-500 dark:text-neutral-400">Loading...</p>
			</div>
		{:else if conversationState.threads.length === 0}
			<div class="flex items-center justify-center px-4 py-8 text-center">
				<div>
					<p class="text-sm text-gray-500 dark:text-neutral-400">No conversations yet</p>
					<p class="mt-1 text-xs text-gray-400 dark:text-neutral-500">Start a new chat to begin</p>
				</div>
			</div>
		{:else}
			<div class="p-4">
				<!-- Starred threads section -->
				{#if starredThreads.length > 0}
					<div class="mb-2 flex items-center gap-2 px-2">
						<Star class="h-3 w-3 fill-yellow-400 text-yellow-400" />
						<span class="text-xs font-medium text-gray-500 dark:text-neutral-400">Starred</span>
					</div>
					<div class="space-y-2">
						{#each starredThreads as thread (thread.id)}
							<div
								role="button"
								tabindex="0"
								class="group flex cursor-pointer items-start justify-between gap-2 rounded-lg px-3 py-2 transition-colors {conversationState.activeThreadId ===
								thread.id
									? 'bg-gray-100 dark:bg-neutral-800'
									: 'hover:bg-gray-50 dark:hover:bg-neutral-900'}"
								onclick={() => handleSelectConversation(thread.id)}
								onkeydown={(e) => handleKeyDown(e, thread.id)}
							>
								<div class="min-w-0 flex-1">
									{#if editingThreadId === thread.id}
										<div class="flex items-center gap-1">
											<input
												type="text"
												bind:value={editingTitle}
												onkeydown={(e) => handleEditKeyDown(e, thread.id)}
												onclick={(e) => e.stopPropagation()}
												class="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-black focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-white dark:focus:border-neutral-500"
												placeholder={getShortId(thread.id)}
											/>
											<button
												class="shrink-0 cursor-pointer rounded p-1 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"
												onclick={(e) => saveTitle(e, thread.id)}
												title="Save"
											>
												<Check class="h-3 w-3" />
											</button>
											<button
												class="shrink-0 cursor-pointer rounded p-1 text-gray-400 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
												onclick={cancelEditing}
												title="Cancel"
											>
												<X class="h-3 w-3" />
											</button>
										</div>
									{:else}
										<div class="flex items-center gap-1">
											<h3 class="flex-1 truncate text-sm font-medium text-gray-900 dark:text-white">
												{getDisplayTitle(thread)}
											</h3>
											<button
												class="shrink-0 cursor-pointer rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-200 hover:text-gray-600 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-white"
												onclick={(e) => startEditing(e, thread.id, thread.title)}
												title="Edit title"
											>
												<Pencil class="h-3 w-3" />
											</button>
										</div>
									{/if}
									<p class="truncate text-xs text-gray-500 dark:text-neutral-400">
										{thread.preview || 'No messages yet'}
									</p>
									<p class="mt-1 text-xs text-gray-400 dark:text-neutral-500">
										{formatDate(thread.updatedAt)}
									</p>
								</div>
								<div class="flex shrink-0 flex-col gap-1">
									<button
										class="cursor-pointer rounded p-1 text-yellow-400 transition-colors hover:bg-yellow-50 dark:hover:bg-yellow-900/30"
										onclick={(e) => handleToggleStar(e, thread.id)}
										title="Unstar conversation"
									>
										<Star class="h-4 w-4 fill-yellow-400" />
									</button>
									<button
										class="cursor-pointer rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-neutral-800"
										onclick={(e) => handleDeleteConversation(e, thread.id)}
										title="Delete conversation"
									>
										<Trash2 class="h-4 w-4" />
									</button>
								</div>
							</div>
						{/each}
					</div>

					<!-- Separator between starred and unstarred -->
					{#if unstarredThreads.length > 0}
						<div class="my-3 border-t border-gray-200 dark:border-neutral-800"></div>
					{/if}
				{/if}

				<!-- Unstarred threads section -->
				{#if unstarredThreads.length > 0}
					{#if starredThreads.length > 0}
						<div class="mb-2 px-2">
							<span class="text-xs font-medium text-gray-500 dark:text-neutral-400">Other</span>
						</div>
					{/if}
					<div class="space-y-2">
						{#each unstarredThreads as thread (thread.id)}
							<div
								role="button"
								tabindex="0"
								class="group flex cursor-pointer items-start justify-between gap-2 rounded-lg px-3 py-2 transition-colors {conversationState.activeThreadId ===
								thread.id
									? 'bg-gray-100 dark:bg-neutral-800'
									: 'hover:bg-gray-50 dark:hover:bg-neutral-900'}"
								onclick={() => handleSelectConversation(thread.id)}
								onkeydown={(e) => handleKeyDown(e, thread.id)}
							>
								<div class="min-w-0 flex-1">
									{#if editingThreadId === thread.id}
										<div class="flex items-center gap-1">
											<input
												type="text"
												bind:value={editingTitle}
												onkeydown={(e) => handleEditKeyDown(e, thread.id)}
												onclick={(e) => e.stopPropagation()}
												class="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-black focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-white dark:focus:border-neutral-500"
												placeholder={getShortId(thread.id)}
											/>
											<button
												class="shrink-0 cursor-pointer rounded p-1 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"
												onclick={(e) => saveTitle(e, thread.id)}
												title="Save"
											>
												<Check class="h-3 w-3" />
											</button>
											<button
												class="shrink-0 cursor-pointer rounded p-1 text-gray-400 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
												onclick={cancelEditing}
												title="Cancel"
											>
												<X class="h-3 w-3" />
											</button>
										</div>
									{:else}
										<div class="flex items-center gap-1">
											<h3 class="flex-1 truncate text-sm font-medium text-gray-900 dark:text-white">
												{getDisplayTitle(thread)}
											</h3>
											<button
												class="shrink-0 cursor-pointer rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-200 hover:text-gray-600 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-white"
												onclick={(e) => startEditing(e, thread.id, thread.title)}
												title="Edit title"
											>
												<Pencil class="h-3 w-3" />
											</button>
										</div>
									{/if}
									<p class="truncate text-xs text-gray-500 dark:text-neutral-400">
										{thread.preview || 'No messages yet'}
									</p>
									<p class="mt-1 text-xs text-gray-400 dark:text-neutral-500">
										{formatDate(thread.updatedAt)}
									</p>
								</div>
								<div class="flex shrink-0 flex-col gap-1">
									<button
										class="cursor-pointer rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-yellow-50 hover:text-yellow-400 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-yellow-900/30"
										onclick={(e) => handleToggleStar(e, thread.id)}
										title="Star conversation"
									>
										<Star class="h-4 w-4" />
									</button>
									<button
										class="cursor-pointer rounded p-1 text-gray-400 transition-colors hover:bg-gray-200 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-neutral-800"
										onclick={(e) => handleDeleteConversation(e, thread.id)}
										title="Delete conversation"
									>
										<Trash2 class="h-4 w-4" />
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Footer -->
	{#if conversationState.threads.length > 0}
		<div class="border-t border-gray-200 px-4 py-3 dark:border-neutral-800">
			<button
				class="w-full cursor-pointer text-center text-xs text-gray-500 transition-colors hover:text-red-600 dark:text-neutral-400"
				onclick={handleClearAll}
			>
				Clear all conversations
			</button>
		</div>
	{/if}
</div>
