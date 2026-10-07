<script lang="ts" module>
	/** Attachments travel as text parts wrapped in this tag (see Chat.svelte). */
	export const ATTACHMENT_RE = /^<attachment name="([^"]*)">\n?([\s\S]*?)\n?<\/attachment>$/;
</script>

<script lang="ts">
	import type { UIMessage } from 'ai';
	import { Check, ChevronRight, Copy, FileText, LoaderCircle, Pencil, RotateCcw, TriangleAlert, Wrench } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import { codeCopy, renderMarkdown } from '$lib/markdown.svelte';
	import IconButton from './IconButton.svelte';

	interface Props {
		message: UIMessage;
		/** Streaming into this message right now. */
		streaming?: boolean;
		/** Show "regenerate" (the latest assistant reply, or a failed turn). */
		onRegenerate?: () => void;
		/** User messages: resend with new text, replacing what came after. Absent while a reply streams. */
		onEdit?: (text: string) => void;
	}

	const { message, streaming = false, onRegenerate, onEdit }: Props = $props();

	const isUser = $derived(message.role === 'user');
	let copied = $state(false);
	let editing = $state(false);
	let draft = $state('');

	function startEdit() {
		draft = plainText;
		editing = true;
	}

	function saveEdit() {
		const text = draft.trim();
		if (!text || !onEdit) return;
		editing = false;
		if (text !== plainText.trim()) onEdit(text);
	}

	function onEditKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			editing = false;
		}
		// Enter sends, Shift+Enter adds a line; touch keyboards keep Enter as a
		// newline. Cmd/Ctrl+Enter always sends.
		if (e.key !== 'Enter' || e.isComposing) return;
		const touch = window.matchMedia('(pointer: coarse)').matches;
		if (e.metaKey || e.ctrlKey || (!e.shiftKey && !touch)) {
			e.preventDefault();
			saveEdit();
		}
	}

	function focusEnd(node: HTMLTextAreaElement) {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}

	type ToolPart = {
		type: string;
		state?: string;
		input?: unknown;
		output?: unknown;
		errorText?: string;
	};

	/** Plain text of the message, without attachments, for copying. */
	const plainText = $derived(
		message.parts
			.filter((p) => p.type === 'text' && !ATTACHMENT_RE.test((p as { text: string }).text))
			.map((p) => (p as { text: string }).text)
			.join('\n\n')
	);

	async function copy() {
		try {
			await navigator.clipboard.writeText(plainText);
			copied = true;
			setTimeout(() => (copied = false), 1600);
		} catch (err) {
			console.error('Copy failed:', err);
		}
	}

	function toolName(part: ToolPart) {
		return part.type.replace(/^tool-/, '').replaceAll('_', ' ');
	}

	/** A one-line summary for the tools we know, else a generic status. */
	function toolSummary(part: ToolPart): string {
		if (part.state === 'output-error') return part.errorText ?? 'failed';
		if (part.state !== 'output-available') return 'Working…';
		const out = part.output as Record<string, unknown> | undefined;
		const weather = out?.weather as { temperature?: string; condition?: string } | undefined;
		if (weather?.temperature) return `${weather.temperature}, ${weather.condition ?? ''}`.trim();
		const results = out?.results as unknown[] | undefined;
		if (Array.isArray(results)) return `${results.length} result${results.length === 1 ? '' : 's'}`;
		return 'Done';
	}

	function pretty(value: unknown): string {
		try {
			return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}
</script>

{#if isUser && editing}
	<!-- Editing in place: the bubble becomes a text box with Cancel and Send. -->
	<div class="ml-auto w-full rounded-3xl bg-bubble p-3 sm:max-w-[85%]">
		<textarea
			bind:value={draft}
			onkeydown={onEditKeydown}
			aria-label="Edit message"
			rows="1"
			class="block max-h-80 min-h-12 w-full resize-none border-0 bg-transparent px-1.5 py-1 text-[15px] leading-relaxed field-sizing-content focus:ring-0"
			{@attach focusEnd}
		></textarea>
		<div class="mt-2 flex justify-end gap-2">
			<Button variant="outline" class="h-9 rounded-full px-4" onclick={() => (editing = false)}>Cancel</Button>
			<Button class="h-9 rounded-full px-4" disabled={!draft.trim()} onclick={saveEdit}>Send</Button>
		</div>
	</div>
{:else if isUser}
	<div class="group flex flex-col items-end gap-1.5">
		{#each message.parts as part, i (i)}
			{#if part.type === 'text'}
				{@const attachment = part.text.match(ATTACHMENT_RE)}
				{#if attachment}
					<div class="flex max-w-[85%] items-center gap-2 rounded-xl border border-subtle bg-surface px-3 py-2 text-sm">
						<FileText class="size-4 shrink-0 text-muted-foreground" />
						<span class="truncate">{attachment[1]}</span>
					</div>
				{:else if part.text}
					<div
						class="max-w-[85%] rounded-3xl bg-bubble px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap sm:max-w-[75%]"
					>
						{part.text}
					</div>
				{/if}
			{/if}
		{/each}
		<div class="flex opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
			<IconButton label={copied ? 'Copied' : 'Copy message'} size="icon" class="rounded-full" onclick={copy}>
				{#if copied}<Check />{:else}<Copy />{/if}
			</IconButton>
			{#if onEdit}
				<IconButton label="Edit message" size="icon" class="rounded-full" onclick={startEdit}>
					<Pencil />
				</IconButton>
			{/if}
		</div>
	</div>
{:else}
	<div class="group flex flex-col gap-2">
		{#each message.parts as part, i (i)}
			{#if part.type === 'text' && part.text}
				<div class="markdown text-[15px]" {@attach codeCopy}>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised by DOMPurify -->
					{@html renderMarkdown(part.text)}
				</div>
			{:else if part.type.startsWith('tool-')}
				{@const tool = part as ToolPart}
				{@const running = tool.state !== 'output-available' && tool.state !== 'output-error'}
				<details class="group/tool w-full max-w-full rounded-2xl border border-subtle bg-surface-sunken text-sm sm:max-w-md">
					<summary class="flex cursor-pointer list-none items-center gap-2.5 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden">
						{#if tool.state === 'output-error'}
							<TriangleAlert class="size-4 shrink-0 text-destructive" />
						{:else if tool.state === 'output-available'}
							<Wrench class="size-4 shrink-0 text-muted-foreground" />
						{:else}
							<LoaderCircle class="size-4 shrink-0 animate-spin text-muted-foreground" />
						{/if}
						<span class={['font-medium capitalize', running && 'shimmer']}>{toolName(tool)}</span>
						<span class={['min-w-0 truncate text-muted-foreground', running && 'shimmer']}>{toolSummary(tool)}</span>
						<ChevronRight class="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />
					</summary>
					<div class="space-y-2 border-t border-subtle px-3.5 py-3">
						{#if tool.input !== undefined}
							<p class="text-xs font-medium text-muted-foreground">Input</p>
							<pre class="max-h-48 overflow-auto rounded-lg bg-surface p-2.5 font-mono text-xs">{pretty(tool.input)}</pre>
						{/if}
						{#if tool.output !== undefined}
							<p class="text-xs font-medium text-muted-foreground">Result</p>
							<pre class="max-h-64 overflow-auto rounded-lg bg-surface p-2.5 font-mono text-xs">{pretty(tool.output)}</pre>
						{/if}
						{#if tool.errorText}
							<p class="text-xs text-destructive">{tool.errorText}</p>
						{/if}
					</div>
				</details>
			{/if}
		{/each}

		{#if !streaming && plainText}
			<div class="-ml-2 flex items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
				<IconButton label={copied ? 'Copied' : 'Copy reply'} size="icon" class="rounded-full" onclick={copy}>
					{#if copied}<Check />{:else}<Copy />{/if}
				</IconButton>
				{#if onRegenerate}
					<IconButton label="Regenerate reply" size="icon" class="rounded-full" onclick={onRegenerate}>
						<RotateCcw />
					</IconButton>
				{/if}
			</div>
		{/if}
	</div>
{/if}
