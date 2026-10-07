<script lang="ts">
	import { onMount } from 'svelte';
	import Chat from '$lib/components/Chat.svelte';
	import { conversationState } from '$lib/state/conversationState.svelte';
	import { ui } from '$lib/state/ui.svelte';

	// "/" opens a fresh chat. Cleared once on arrival (not in an effect): the
	// chat sets the id itself when its first message creates a thread.
	onMount(() => {
		conversationState.activeThreadId = null;
	});
</script>

{#key `${ui.newChatNonce}:${ui.temporary}`}
	<Chat />
{/key}
