<script lang="ts">
	import ThreadList from '$lib/components/ThreadList.svelte';
	import { conversationState } from '$lib/state/conversationState.svelte';

	// Clear active thread when viewing home/thread list
	$effect(() => {
		if (conversationState.activeThreadId !== null) {
			conversationState.activeThreadId = null;
		}
	});
</script>

<ThreadList />
