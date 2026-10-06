<script lang="ts">
	import { X } from 'lucide-svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
		title?: string;
		children: Snippet;
	}

	const { open, onClose, title, children }: Props = $props();

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onClose();
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
		}
	}
</script>

<svelte:window onkeydown={handleKeyDown} />

{#if open}
	<div
		class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
		onclick={handleBackdropClick}
		role="dialog"
		aria-modal="true"
	>
		<div
			class="w-full max-w-md rounded-lg bg-white shadow-xl dark:bg-neutral-900"
			onclick={(e) => e.stopPropagation()}
		>
			{#if title}
				<div class="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-neutral-800">
					<h2 class="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
					<button
						onclick={onClose}
						class="cursor-pointer rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
						aria-label="Close"
					>
						<X class="h-5 w-5" />
					</button>
				</div>
			{/if}
			<div class="p-4">
				{@render children()}
			</div>
		</div>
	</div>
{/if}
