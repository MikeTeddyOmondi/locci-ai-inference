<script lang="ts">
	import { page } from '$app/state';
	import Chat from '$lib/components/Chat.svelte';
	import { conversationState } from '$lib/state/conversationState.svelte';

	const threadId = $derived(page.params.threadId ?? null);

	// Keep the active thread in sync with the URL (sidebar highlighting).
	$effect(() => {
		if (threadId && conversationState.activeThreadId !== threadId) {
			conversationState.activeThreadId = threadId;
		}
	});
</script>

{#key threadId}
	<Chat initialThreadId={threadId} />
{/key}
