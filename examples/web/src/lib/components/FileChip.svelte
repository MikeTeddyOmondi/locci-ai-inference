<script lang="ts">
	import { FileText, X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		name: string;
		/** Bytes; shown as KB when known. */
		size?: number;
		/** The file's text: when given, clicking the card opens a preview. */
		text?: string;
		/** In the composer: show a remove button. */
		onRemove?: () => void;
	}

	const { name, size, text, onRemove }: Props = $props();

	let open = $state(false);

	const kind = $derived(name.split('.').pop()?.toUpperCase() ?? 'File');
	const kb = $derived(size !== undefined ? `${(size / 1000).toFixed(1)} KB` : '');
	const lines = $derived(text ? text.split('\n').length : 0);
</script>

<!-- An attached file or long paste, as a small card: icon, name, type and size.
     Clicking it previews the text. -->
<div class="flex max-w-full min-w-0 items-center gap-1 rounded-2xl border bg-background py-2 pr-2 pl-2.5">
	<button
		type="button"
		class="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left disabled:cursor-default enabled:cursor-pointer"
		disabled={text === undefined}
		aria-label={text === undefined ? undefined : `Preview ${name}`}
		onclick={() => (open = true)}
	>
		<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand">
			<FileText class="size-5" />
		</span>
		<span class="flex min-w-0 flex-col">
			<span class="truncate text-sm font-medium">{name}</span>
			<span class="text-xs text-muted-foreground">{kind}{kb ? ` · ${kb}` : ''}</span>
		</span>
	</button>
	{#if onRemove}
		<Button variant="subtle" size="icon-xs" class="ml-1 rounded-full" aria-label={`Remove ${name}`} onclick={onRemove}>
			<X />
		</Button>
	{/if}
</div>

{#if text !== undefined}
	<Dialog.Root bind:open>
		<Dialog.Content class="flex max-h-[85dvh] flex-col gap-3 rounded-2xl p-5 sm:max-w-2xl">
			<Dialog.Header class="pr-8">
				<Dialog.Title class="truncate text-xl">{name}</Dialog.Title>
				<Dialog.Description>
					{[kb, `${lines.toLocaleString()} line${lines === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
					<span class="opacity-70"> · Formatting may differ from the source</span>
				</Dialog.Description>
			</Dialog.Header>
			<pre
				class="min-h-0 flex-1 overflow-auto rounded-xl border bg-surface-sunken p-4 font-mono text-[13px] leading-relaxed wrap-break-word whitespace-pre-wrap">{text}</pre>
		</Dialog.Content>
	</Dialog.Root>
{/if}
