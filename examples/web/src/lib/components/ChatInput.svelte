<script lang="ts">
	import Button from './Button.svelte';
	import Input from './Input.svelte';
	import { Send } from 'lucide-svelte';

	interface Props {
		onSendMessage?: (message: string) => void | Promise<void>;
		disabled?: boolean;
	}

	const { onSendMessage, disabled = false }: Props = $props();

	let inputValue = $state('');

	async function handleSend() {
		if (inputValue.trim() && onSendMessage) {
			await onSendMessage(inputValue);
			inputValue = '';
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	}
</script>

<div class="sticky bottom-0 z-10 shrink-0 border-t border-gray-200 bg-white p-3 dark:border-neutral-800 dark:bg-black md:p-4">
	<div class="mx-auto flex max-w-3xl gap-2 md:gap-3">
		<Input
			type="text"
			placeholder="Type your message..."
			bind:value={inputValue}
			onkeydown={handleKeyDown}
			{disabled}
			class="flex-1 text-base"
		/>
		<Button onclick={handleSend} {disabled} size="icon" class="h-11 w-11 shrink-0 md:h-10 md:w-10">
			<Send class="h-5 w-5 md:h-4 md:w-4" />
		</Button>
	</div>
</div>
