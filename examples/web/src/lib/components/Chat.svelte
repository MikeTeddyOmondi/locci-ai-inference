<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { Chat } from '@ai-sdk/svelte';
	import { DefaultChatTransport, type UIMessage } from 'ai';
	import { ArrowDown, Cloud, Code, Globe, MessageCircleDashed, Pencil, RotateCcw } from '@lucide/svelte';
	import { onMount, tick } from 'svelte';
	import { brand } from '$lib/brand';
	import { apiUrl } from '$lib/config';
	import { conversationState, createConversation } from '$lib/state/conversationState.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { threadStore } from '$lib/storage/threads';
	import ChatMessage, { ATTACHMENT_RE } from './ChatMessage.svelte';
	import Composer, { type ComposerSubmit } from './Composer.svelte';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		initialThreadId?: string | null;
	}

	const { initialThreadId = null }: Props = $props();

	// The model call lives in the example API (examples/api), which reaches the
	// Locci AI Gateway through @locci/ai-sdk; this app only streams from it.
	function newChat(messages: UIMessage[] = []): Chat {
		return new Chat({
			messages,
			transport: new DefaultChatTransport({ api: `${apiUrl()}/api/chat` })
		});
	}

	let chat = $state<Chat | null>(null);
	let currentThreadId = $state<string | null>(null);
	let isLoadingThread = $state(true);
	let scroller: HTMLDivElement | undefined = $state();
	let atBottom = $state(true);

	// A temporary chat never touches the thread store.
	const temporary = ui.temporary;

	// Load the thread once per mount (thread switches remount via {#key}).
	onMount(() => {
		(async () => {
			const activeId = initialThreadId;
			if (activeId && !temporary) {
				try {
					const thread = await threadStore().get(activeId);
					currentThreadId = thread ? activeId : null;
					chat = newChat(thread?.messages ?? []);
				} catch (error) {
					console.error('Failed to load thread:', error);
					chat = newChat();
				}
			} else {
				chat = newChat();
			}
			isLoadingThread = false;
			await tick();
			scrollToBottom('instant');
		})();
	});

	const messages = $derived(chat?.messages ?? []);
	const status = $derived(chat?.status ?? 'ready');
	const error = $derived(chat?.error ?? null);
	const isBusy = $derived(status === 'streaming' || status === 'submitted');
	const lastAssistantIndex = $derived(messages.findLastIndex((m) => m.role === 'assistant'));

	// Persist when a reply finishes, and keep the sidebar preview current.
	let previousStatus = 'ready';
	$effect(() => {
		const now = status;
		if ((previousStatus === 'streaming' || previousStatus === 'submitted') && now !== previousStatus) {
			void persist();
		}
		previousStatus = now;
	});

	async function persist() {
		if (temporary || !currentThreadId || !chat) return;
		try {
			await threadStore().syncMessages(currentThreadId, $state.snapshot(chat.messages) as UIMessage[]);
			const updated = await threadStore().get(currentThreadId);
			const i = conversationState.threads.findIndex((t) => t.id === currentThreadId);
			if (updated && i !== -1) {
				const { messages: _messages, ...thread } = updated;
				conversationState.threads[i] = thread;
			}
		} catch (err) {
			console.error('Failed to save messages:', err);
		}
	}

	async function handleSubmit({ text, attachments, webSearch }: ComposerSubmit) {
		if (!chat) return;

		// Create the thread on the first message, titled after it.
		let isNewThread = false;
		if (!temporary && !currentThreadId) {
			const title = (text || attachments[0]?.name || 'New chat').replace(/\s+/g, ' ').slice(0, 60);
			const thread = await createConversation(title, text.slice(0, 100), false);
			if (thread) {
				currentThreadId = thread.id;
				conversationState.activeThreadId = thread.id;
				isNewThread = true;
			}
		}

		// Attached files go to the model as extra text parts; ChatMessage shows
		// them as file chips rather than their contents.
		const parts = [
			...(text ? [{ type: 'text' as const, text }] : []),
			...attachments.map((a) => ({
				type: 'text' as const,
				text: `<attachment name="${a.name.replaceAll('"', "'")}">\n${a.text}\n</attachment>`
			}))
		];
		chat.sendMessage({ parts }, { body: { webSearch, model: ui.model || undefined } });

		await tick();
		scrollToBottom();
		await persist(); // save the user's message immediately

		// Shallow routing: the URL becomes the thread's, but this component (and
		// the reply streaming into it) stays mounted. A reload opens the thread.
		if (isNewThread && currentThreadId) {
			replaceState(`/chats/${currentThreadId}`, {});
		}
	}

	function regenerate() {
		chat?.regenerate({ body: { model: ui.model || undefined } });
	}

	/**
	 * Edit a sent message in place: replace its text (keeping any attached
	 * files), drop everything after it, and ask again. The AI SDK does the
	 * truncation when `messageId` is given; persist() then saves the new history.
	 */
	async function editMessage(messageId: string, text: string) {
		if (!chat) return;
		const original = chat.messages.find((m) => m.id === messageId);
		if (!original) return;
		const attachments = original.parts.filter((p) => p.type === 'text' && ATTACHMENT_RE.test(p.text));
		chat.sendMessage(
			{ parts: [{ type: 'text', text }, ...attachments], messageId },
			{ body: { model: ui.model || undefined } }
		);
		await tick();
		await persist();
	}

	function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior });
	}

	function onScroll() {
		if (!scroller) return;
		atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
	}

	// Follow the stream while the reader is at the bottom; don't yank them back
	// if they scrolled up to read.
	$effect(() => {
		void messages.length;
		void messages.at(-1)?.parts.length;
		const last = messages.at(-1)?.parts.at(-1);
		void (last && 'text' in last ? last.text : '');
		if (atBottom) scrollToBottom('instant');
	});

	const icons = { cloud: Cloud, globe: Globe, pencil: Pencil, code: Code } as const;
	function useSuggestion(prompt: string) {
		void handleSubmit({ text: prompt, attachments: [], webSearch: prompt.toLowerCase().includes('search the web') });
	}
</script>

{#if isLoadingThread}
	<div class="flex flex-1 items-center justify-center">
		<p class="shimmer text-sm text-muted-foreground" role="status">Loading conversation…</p>
	</div>
{:else if messages.length === 0}
	<!-- Empty chat. Desktop: greeting, composer, suggestions centred together.
	     Phone: greeting in the middle, suggestions and composer at the bottom. -->
	<div class="flex min-h-0 flex-1 flex-col px-4 pb-safe sm:justify-center sm:pb-[12vh]">
		<div class="order-1 flex flex-1 flex-col items-center justify-center gap-3 text-center sm:mb-8 sm:flex-none">
			{#if temporary}
				<span class="flex size-12 items-center justify-center rounded-full bg-surface-raised">
					<MessageCircleDashed class="size-6 text-muted-foreground" />
				</span>
				<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{brand.temporaryGreeting}</h1>
				<p class="max-w-sm text-sm text-muted-foreground">{brand.temporaryNote}</p>
			{:else}
				<h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{brand.greeting}</h1>
			{/if}
		</div>

		<div class="order-3 mx-auto w-full max-w-3xl sm:order-2">
			<Composer onSubmit={handleSubmit} autofocus />
		</div>

		{#if !temporary}
			<ul class="order-2 mx-auto mb-3 grid w-full max-w-3xl gap-1 sm:order-3 sm:mt-4 sm:mb-0 sm:grid-cols-2">
				{#each brand.suggestions as s (s.label)}
					{@const Icon = icons[s.icon]}
					<li>
						<Button
							variant="ghost"
							onclick={() => useSuggestion(s.prompt)}
							class="h-auto w-full justify-start gap-3 rounded-2xl px-3 py-2.5 text-[15px] font-normal text-muted-foreground hover:bg-secondary hover:text-foreground dark:hover:bg-secondary"
						>
							<Icon class="size-5" />
							<span class="truncate">{s.label}</span>
						</Button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{:else}
	<div class="relative flex min-h-0 flex-1 flex-col">
		<div
			bind:this={scroller}
			onscroll={onScroll}
			class="min-h-0 flex-1 scroll-fade overflow-y-auto overscroll-contain scroll-fade-24"
		>
			<div class="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-4 pb-10 sm:pt-8">
				{#each messages as message, i (message.id)}
					<ChatMessage
						{message}
						streaming={isBusy && i === messages.length - 1}
						onRegenerate={i === lastAssistantIndex && !isBusy ? regenerate : undefined}
						onEdit={isBusy ? undefined : (text) => editMessage(message.id, text)}
					/>
				{/each}

				{#if status === 'submitted'}
					<!-- "Thinking" with the dots as its ellipsis, sitting on the text baseline. -->
					<p class="flex items-baseline py-1 text-[15px] text-muted-foreground" role="status">
						<span class="shimmer">Thinking</span>
						<span class="ml-0.5 inline-flex gap-[3px]" aria-hidden="true">
							<span class="size-1 animate-typing rounded-full bg-current"></span>
							<span class="size-1 animate-typing rounded-full bg-current [animation-delay:160ms]"></span>
							<span class="size-1 animate-typing rounded-full bg-current [animation-delay:320ms]"></span>
						</span>
					</p>
				{/if}

				{#if error && !isBusy}
					<div
						class="flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-300"
						role="alert"
					>
						<div class="min-w-0 flex-1">
							<p class="font-medium">Couldn't get a response</p>
							<p class="mt-0.5 break-words opacity-80">{error.message}</p>
						</div>
						<Button variant="destructive" size="sm" class="shrink-0 rounded-full px-3" onclick={regenerate}>
							<RotateCcw /> Retry
						</Button>
					</div>
				{/if}
			</div>
		</div>

		{#if !atBottom}
			<Button
				variant="outline"
				size="icon-round"
				class="absolute bottom-36 left-1/2 z-10 -translate-x-1/2 shadow-md"
				aria-label="Scroll to latest"
				onclick={() => scrollToBottom()}
			>
				<ArrowDown class="size-4" />
			</Button>
		{/if}

		<div class="shrink-0 bg-surface px-3 pt-1 pb-safe sm:px-4">
			<div class="mx-auto w-full max-w-3xl">
				<Composer onSubmit={handleSubmit} onStop={() => chat?.stop()} busy={isBusy} />
			</div>
		</div>
	</div>
{/if}
