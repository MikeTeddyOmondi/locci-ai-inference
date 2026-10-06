<script lang="ts">
	import { goto } from '$app/navigation';
	import { Chat } from '@ai-sdk/svelte';
	import ChatMessage from './ChatMessage.svelte';
	import ChatInput from './ChatInput.svelte';
	import { conversationState, createConversation, updateConversation } from '$lib/state/conversationState.svelte';
	import { threadStore } from '$lib/storage/threads';
	import { apiUrl } from '$lib/config';
	import { DefaultChatTransport, type UIMessage } from 'ai';

	// The model call lives in the example API (examples/api), which reaches the
	// Locci AI Gateway through @locci/ai-sdk; this app only streams from it.
	function newChat(messages: UIMessage[] = []): Chat {
		return new Chat({
			messages,
			transport: new DefaultChatTransport({ api: `${apiUrl()}/api/chat` })
		});
	}

	interface Props {
		initialThreadId?: string | null;
	}

	const { initialThreadId = null }: Props = $props();

	let messagesContainer: HTMLDivElement;
	let currentThreadId = $state<string | null>(null);
	let isLoadingThread = $state(true);
	let previousStatus = $state<string>('ready');

	// Chat instance - created after initial messages are loaded
	let chat = $state<Chat | null>(null);

	// Flag to ensure init only runs once (component remounts on thread switch via {#key})
	let hasInitialized = false;

	// Initialize on mount - load messages for active thread if any
	$effect(() => {
		// Only run once on mount - thread switching is handled by component remount
		if (hasInitialized) return;
		hasInitialized = true;

		async function init() {
			// Use prop if provided, otherwise fall back to state
			const activeId = initialThreadId ?? conversationState.activeThreadId;

			if (activeId) {
				isLoadingThread = true;
				try {
					const result = await threadStore().get(activeId);
					if (result) {
						currentThreadId = activeId;
						// Create chat with loaded messages
						chat = newChat(result.messages);
					} else {
						// Thread not found, create empty chat
						chat = newChat();
					}
				} catch (error) {
					console.error('Failed to load thread:', error);
					chat = newChat();
				} finally {
					isLoadingThread = false;
				}
			} else {
				// New chat - no messages to load
				currentThreadId = null;
				chat = newChat();
				isLoadingThread = false;
			}
		}

		init();
	});

	// Track message count for change detection
	let lastSyncedMessageCount = 0;

	// Watch for status changes to sync messages when AI finishes
	$effect(() => {
		if (!chat) return;

		const status = chat.status;
		// When transitioning from streaming/submitted to ready, sync messages
		if (
			(previousStatus === 'streaming' || previousStatus === 'submitted') &&
			status === 'ready' &&
			currentThreadId &&
			chat.messages.length > 0
		) {
			syncMessagesToDb();
			lastSyncedMessageCount = chat.messages.length;
		}
		previousStatus = status;
	});

	// Also sync when message count changes (catches edge cases)
	$effect(() => {
		if (!chat || !currentThreadId) return;

		const messageCount = chat.messages.length;
		// Only sync if we have new messages that haven't been synced
		if (messageCount > 0 && messageCount !== lastSyncedMessageCount) {
			// Use a small delay to batch rapid changes
			const timeout = setTimeout(() => {
				if (chat && currentThreadId && chat.messages.length > lastSyncedMessageCount) {
					syncMessagesToDb();
					lastSyncedMessageCount = chat.messages.length;
				}
			}, 500);

			return () => clearTimeout(timeout);
		}
	});

	async function syncMessagesToDb() {
		if (!currentThreadId || !chat) return;

		try {
			await threadStore().syncMessages(currentThreadId, chat.messages as unknown as UIMessage[]);

			// Update thread preview from first user message
			const firstUserMsg = chat.messages.find((m) => m.role === 'user');
			if (firstUserMsg) {
				const textPart = firstUserMsg.parts?.find((p) => p.type === 'text');
				if (textPart && 'text' in textPart) {
					await updateConversation(currentThreadId, {
						preview: textPart.text.substring(0, 100)
					});
				}
			}
		} catch (error) {
			console.error('Failed to sync messages:', error);
		}
	}

	async function handleSubmit(content: string) {
		if (!content.trim() || !chat) return;

		let isNewThread = false;

		// Create thread on first message if not already created
		if (!currentThreadId) {
			// Create thread with preview only - title defaults to ID (user can edit)
			// Pass setActive=false to prevent component remount before sending message
			const thread = await createConversation('', content.substring(0, 100), false);
			if (thread) {
				currentThreadId = thread.id;
				isNewThread = true;
			}
		}

		// Send the message
		chat.sendMessage({ text: content });

		// Small delay to ensure message is added to chat.messages
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Sync immediately after sending to persist user message
		if (currentThreadId && chat.messages.length > 0) {
			try {
				await threadStore().syncMessages(currentThreadId, chat.messages as unknown as UIMessage[]);
			} catch (error) {
				console.error('Failed to sync user message:', error);
			}
		}

		// Navigate to thread URL after first message (updates URL without remounting)
		if (isNewThread && currentThreadId) {
			goto(`/chats/${currentThreadId}`, { replaceState: true });
		}

		scrollToBottom();
	}

	function scrollToBottom() {
		if (messagesContainer) {
			setTimeout(() => {
				messagesContainer.scrollTo({
					top: messagesContainer.scrollHeight,
					behavior: 'smooth'
				});
			}, 0);
		}
	}

	// Watch for new messages and scroll
	$effect(() => {
		if (chat && chat.messages.length > 0) {
			scrollToBottom();
		}
	});

	// Auto-scroll during streaming to keep latest content visible
	$effect(() => {
		if (!isStreaming) return;

		// Scroll immediately when streaming starts
		scrollToBottom();

		// Continue scrolling as content streams in
		const interval = setInterval(() => {
			scrollToBottom();
		}, 100);

		return () => clearInterval(interval);
	});

	// Derived values for template
	const messages = $derived(chat?.messages ?? []);
	const status = $derived(chat?.status ?? 'ready');
	const error = $derived(chat?.error ?? null);
	const isStreaming = $derived(status === 'streaming' || status === 'submitted');

	// Find the index of the last user message (for retry functionality)
	const lastUserMessageIndex = $derived.by(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') return i;
		}
		return -1;
	});

	// Retry the last user message
	function handleRetry() {
		if (!chat || messages.length === 0) return;

		// Find the last user message
		const lastUserIdx = lastUserMessageIndex;
		if (lastUserIdx === -1) return;

		const lastUserMessage = messages[lastUserIdx];
		const textPart = lastUserMessage.parts?.find((p) => p.type === 'text');
		if (!textPart || !('text' in textPart)) return;

		const content = textPart.text;

		// Recreate chat with messages up to (but not including) the failed user message
		const previousMessages = messages.slice(0, lastUserIdx);
		chat = newChat(previousMessages);

		// Small delay to ensure chat is ready, then resend the message
		setTimeout(() => {
			if (chat) {
				chat.sendMessage({ text: content });
				scrollToBottom();
			}
		}, 50);
	}
</script>

<div class="flex h-full flex-col bg-white dark:bg-black">
	<!-- Messages Container - pb-20 ensures last message visible above input -->
	<div bind:this={messagesContainer} class="min-h-0 flex-1 overflow-y-auto bg-gray-50 dark:bg-neutral-950">
		<div class="mx-auto max-w-3xl p-3 pb-20 md:p-6 md:pb-24">
			{#if isLoadingThread}
				<div class="flex h-full items-center justify-center">
					<p class="text-gray-500 dark:text-neutral-400">Loading conversation...</p>
				</div>
			{:else if messages.length === 0}
				<div class="flex h-full flex-col items-center justify-center px-4 text-center">
					<div
						class="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-linear-to-br from-black to-gray-700 dark:from-neutral-700 dark:to-neutral-900 md:h-16 md:w-16"
					>
						<span class="text-2xl md:text-3xl">💬</span>
					</div>
					<h2 class="text-lg font-semibold text-gray-900 dark:text-white md:text-xl">Start a Conversation</h2>
					<p class="mt-2 max-w-sm text-sm text-gray-600 dark:text-neutral-400 md:text-base">Ask me anything! I'm here to help.</p>
				</div>
			{:else}
				<div class="flex flex-col gap-6">
				{#each messages as message, messageIndex (messageIndex)}
					<ChatMessage
						{message}
						showRetry={error !== null && !isStreaming && messageIndex === lastUserMessageIndex}
						onRetry={handleRetry}
					/>
				{/each}
				{#if isStreaming}
					<div class="flex gap-2 md:gap-3">
						<div
							class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-black to-gray-700 dark:from-neutral-700 dark:to-neutral-900 md:h-8 md:w-8"
						>
							<span class="text-xs font-semibold text-white md:text-sm">A</span>
						</div>
						<div class="flex items-center gap-1 rounded-lg bg-gray-200 px-3 py-2 dark:bg-neutral-800 md:px-4">
							<div class="h-2 w-2 animate-bounce rounded-full bg-gray-500 dark:bg-neutral-500"></div>
							<div
								class="animation-delay-200 h-2 w-2 animate-bounce rounded-full bg-gray-500 dark:bg-neutral-500"
							></div>
							<div
								class="animation-delay-400 h-2 w-2 animate-bounce rounded-full bg-gray-500 dark:bg-neutral-500"
							></div>
						</div>
					</div>
				{/if}
				{#if error && !isStreaming}
					<div class="flex gap-2 md:gap-3">
						<div
							class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30 md:h-8 md:w-8"
						>
							<span class="text-xs md:text-sm">⚠️</span>
						</div>
						<div class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-300 md:px-4">
							<p class="font-medium">Failed to get response</p>
							<p class="mt-1 text-xs opacity-80">Click the retry button on your message to try again.</p>
						</div>
					</div>
				{/if}
			</div>
		{/if}
		</div>
	</div>

	<!-- Input Area -->
	<ChatInput onSendMessage={handleSubmit} disabled={isStreaming || isLoadingThread} />
</div>

<style>
	:global(.animation-delay-200) {
		animation-delay: 0.2s;
	}

	:global(.animation-delay-400) {
		animation-delay: 0.4s;
	}
</style>
