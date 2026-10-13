<script lang="ts">
	import { X } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	interface Props {
		name: string;
		/** A data URL or any image URL. */
		url: string;
		/** In the composer: a small square with a remove button. In a message: larger. */
		onRemove?: () => void;
	}

	const { name, url, onRemove }: Props = $props();

	let open = $state(false);
</script>

<!-- An attached photo as a thumbnail; clicking it shows the full image. -->
<div class="relative">
	<button
		type="button"
		class={[
			'block cursor-pointer overflow-hidden rounded-2xl border bg-background',
			onRemove ? 'size-16' : 'max-h-64 max-w-full sm:max-w-80'
		]}
		aria-label={`View ${name}`}
		onclick={() => (open = true)}
	>
		<img
			src={url}
			alt={name}
			class={onRemove ? 'size-full object-cover' : 'max-h-64 w-auto max-w-full object-contain'}
		/>
	</button>
	{#if onRemove}
		<Button
			variant="secondary"
			size="icon-xs"
			class="absolute -top-1.5 -right-1.5 rounded-full border shadow-sm"
			aria-label={`Remove ${name}`}
			onclick={onRemove}
		>
			<X />
		</Button>
	{/if}
</div>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[90dvh] flex-col gap-3 rounded-2xl p-4 sm:max-w-3xl">
		<Dialog.Header class="pr-8">
			<Dialog.Title class="truncate text-base">{name}</Dialog.Title>
		</Dialog.Header>
		<img src={url} alt={name} class="min-h-0 w-full flex-1 rounded-xl object-contain" />
	</Dialog.Content>
</Dialog.Root>
