<script lang="ts">
	import { goto } from '$app/navigation';
	import Modal from './Modal.svelte';
	import Input from './Input.svelte';
	import Button from './Button.svelte';
	import { createConversation } from '$lib/state/conversationState.svelte';

	interface Props {
		open: boolean;
		onClose: () => void;
	}

	const { open, onClose }: Props = $props();

	let title = $state('');
	let isCreating = $state(false);

	async function handleCreate() {
		if (isCreating) return;
		isCreating = true;

		try {
			const thread = await createConversation(title.trim(), '', false);
			if (thread) {
				title = '';
				onClose();
				await goto(`/chats/${thread.id}`);
			}
		} finally {
			isCreating = false;
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !isCreating) {
			e.preventDefault();
			handleCreate();
		}
	}

	function handleClose() {
		title = '';
		onClose();
	}
</script>

<Modal open={open} onClose={handleClose} title="New Chat">
	<div class="flex flex-col gap-4">
		<div>
			<label for="chat-title" class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-neutral-300">
				Chat Title
			</label>
			<Input
				id="chat-title"
				type="text"
				placeholder="Enter a title for your chat..."
				bind:value={title}
				onkeydown={handleKeyDown}
				disabled={isCreating}
			/>
			<p class="mt-1.5 text-xs text-gray-500 dark:text-neutral-400">
				Leave empty to use the thread ID as title
			</p>
		</div>
		<div class="flex justify-end gap-2">
			<Button variant="outline" onclick={handleClose} disabled={isCreating}>
				Cancel
			</Button>
			<Button onclick={handleCreate} disabled={isCreating}>
				{isCreating ? 'Creating...' : 'Create Chat'}
			</Button>
		</div>
	</div>
</Modal>
