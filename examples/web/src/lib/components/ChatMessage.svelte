<script lang="ts">
	import type { UIMessage } from 'ai';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import { Copy, Check, RotateCcw } from 'lucide-svelte';

	interface Props {
		message: UIMessage;
		showRetry?: boolean;
		onRetry?: () => void;
	}

	const { message, showRetry = false, onRetry }: Props = $props();

	// Use $derived to reactively compute isUser
	const isUser = $derived(message.role === 'user');

	// State for copy feedback
	let copied = $state(false);

	// Configure marked for safe rendering
	marked.setOptions({
		breaks: true,
		gfm: true
	});

	// Parse and sanitize markdown for AI responses
	function parseMarkdown(text: string): string {
		const html = marked.parse(text) as string;
		return DOMPurify.sanitize(html);
	}

	// Get plain text content from message
	function getMessageText(): string {
		return message.parts
			.filter((part) => part.type === 'text')
			.map((part) => (part as { type: 'text'; text: string }).text)
			.join('\n');
	}

	// Copy message to clipboard
	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(getMessageText());
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy:', err);
		}
	}
</script>

<div class="group mb-2 flex gap-2 md:gap-3" class:justify-end={isUser}>
	{#if !isUser}
		<div
			class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-black to-gray-700 dark:from-neutral-700 dark:to-neutral-900 md:h-8 md:w-8"
		>
			<span class="text-xs font-semibold text-white md:text-sm">A</span>
		</div>
	{/if}
	<div class="relative max-w-[85%] md:max-w-[88%]">
		<div
			class="rounded-lg px-3 py-2 text-sm md:px-4 {isUser ? 'bg-black text-white' : 'bg-gray-200 text-gray-900 dark:bg-neutral-800 dark:text-white'}"
		>
			{#each message.parts as part, index (index)}
				{#if part.type === 'text'}
					{#if isUser}
						<p class="whitespace-pre-wrap">{part.text}</p>
					{:else}
						<div class="prose prose-sm prose-gray max-w-none dark:prose-invert">
							{@html parseMarkdown(part.text)}
						</div>
					{/if}
				{:else if part.type.startsWith('tool-')}
					{@const toolPart = part as { type: string; state?: string; output?: unknown }}
					<div class="my-2 rounded bg-gray-100 p-2 text-xs dark:bg-neutral-700">
						<p class="font-semibold">{part.type.replace('tool-', '')} Tool</p>
						{#if toolPart.state === 'output-available' && toolPart.output}
							{@const output = toolPart.output as { weather?: { temperature?: string; condition?: string } }}
							<p>{output.weather?.temperature} - {output.weather?.condition}</p>
						{:else}
							<p class="text-gray-500 dark:text-neutral-400">Processing...</p>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
		<!-- Action buttons -->
		<div
			class="absolute -bottom-6 flex gap-1"
			class:right-0={isUser}
			class:left-0={!isUser}
		>
			{#if showRetry && isUser && onRetry}
				<button
					onclick={onRetry}
					class="cursor-pointer rounded p-1 text-red-400 transition-all hover:bg-red-50 hover:text-red-600 dark:text-red-400 dark:hover:bg-red-900/30 dark:hover:text-red-300"
					title="Retry message"
				>
					<RotateCcw class="h-4 w-4" />
				</button>
			{/if}
			<button
				onclick={copyToClipboard}
				class="cursor-pointer rounded p-1 text-gray-400 opacity-0 transition-all hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-white"
				title="Copy to clipboard"
			>
				{#if copied}
					<Check class="h-4 w-4 text-green-500" />
				{:else}
					<Copy class="h-4 w-4" />
				{/if}
			</button>
		</div>
	</div>
	{#if isUser}
		<div
			class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-gray-800 to-gray-900 md:h-8 md:w-8"
		>
			<span class="text-xs font-semibold text-white md:text-sm">U</span>
		</div>
	{/if}
</div>

<style>
	/* Markdown prose styles for AI messages */
	:global(.prose) {
		line-height: 1.6;
	}

	:global(.prose p) {
		margin-bottom: 0.75rem;
	}

	:global(.prose p:last-child) {
		margin-bottom: 0;
	}

	:global(.prose h1),
	:global(.prose h2),
	:global(.prose h3),
	:global(.prose h4) {
		font-weight: 600;
		margin-top: 1rem;
		margin-bottom: 0.5rem;
	}

	:global(.prose h1) {
		font-size: 1.25rem;
	}

	:global(.prose h2) {
		font-size: 1.125rem;
	}

	:global(.prose h3) {
		font-size: 1rem;
	}

	:global(.prose ul),
	:global(.prose ol) {
		margin-left: 1.25rem;
		margin-bottom: 0.75rem;
	}

	:global(.prose ul) {
		list-style-type: disc;
	}

	:global(.prose ol) {
		list-style-type: decimal;
	}

	:global(.prose li) {
		margin-bottom: 0.25rem;
	}

	:global(.prose code) {
		background-color: rgba(0, 0, 0, 0.1);
		padding: 0.125rem 0.25rem;
		border-radius: 0.25rem;
		font-size: 0.875em;
		font-family: ui-monospace, monospace;
	}

	:global(.prose pre) {
		background-color: #1f2937;
		color: #e5e7eb;
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		margin-bottom: 0.75rem;
	}

	:global(.prose pre code) {
		background-color: transparent;
		padding: 0;
		color: inherit;
	}

	:global(.prose blockquote) {
		border-left: 3px solid #d1d5db;
		padding-left: 0.75rem;
		margin-left: 0;
		margin-bottom: 0.75rem;
		color: #6b7280;
		font-style: italic;
	}

	:global(.prose a) {
		color: #2563eb;
		text-decoration: underline;
	}

	:global(.prose a:hover) {
		color: #1d4ed8;
	}

	:global(.prose strong) {
		font-weight: 600;
	}

	:global(.prose em) {
		font-style: italic;
	}

	:global(.prose hr) {
		border-top: 1px solid #d1d5db;
		margin: 1rem 0;
	}

	:global(.prose table) {
		width: 100%;
		border-collapse: collapse;
		margin-bottom: 0.75rem;
	}

	:global(.prose th),
	:global(.prose td) {
		border: 1px solid #d1d5db;
		padding: 0.5rem;
		text-align: left;
	}

	:global(.prose th) {
		background-color: #f3f4f6;
		font-weight: 600;
	}
</style>
