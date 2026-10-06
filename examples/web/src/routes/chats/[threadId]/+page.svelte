<script lang="ts">
	import { page } from '$app/stores';
	import Chat from '$lib/components/Chat.svelte';
	import { conversationState } from '$lib/state/conversationState.svelte';

	// Get threadId from URL params
	const threadId = $derived($page.params.threadId);

	// Sync activeThreadId with URL - set immediately for sidebar highlighting
	$effect(() => {
		if (threadId && conversationState.activeThreadId !== threadId) {
			conversationState.activeThreadId = threadId;
		}
	});
</script>

{#key threadId}
	<Chat initialThreadId={threadId} />
{/key}
