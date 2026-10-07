<script lang="ts">
	import { goto } from '$app/navigation';
	import { Pin, Search, SquarePen } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { brand } from '$lib/brand';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { conversationState } from '$lib/state/conversationState.svelte';
	import { startNewChat } from '$lib/state/ui.svelte';

	let query = $state('');

	onMount(() => {
		conversationState.activeThreadId = null;
	});

	const shown = $derived(
		query.trim()
			? conversationState.threads.filter((t) =>
					`${t.title} ${t.preview}`.toLowerCase().includes(query.trim().toLowerCase())
				)
			: conversationState.threads
	);

	function when(iso: string) {
		const d = new Date(iso);
		const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
		if (days < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}
</script>

<svelte:head>
	<title>Chats · {brand.name}</title>
</svelte:head>

<div class="min-h-0 flex-1 scroll-fade overflow-y-auto scroll-fade-24">
	<div class="mx-auto w-full max-w-2xl px-4 pt-4 pb-safe sm:pt-8">
		<div class="mb-4 flex items-center gap-3">
			<h1 class="text-2xl font-semibold tracking-tight">Chats</h1>
			<Button
				class="ml-auto h-9 rounded-full px-4"
				onclick={() => {
					startNewChat();
					goto('/');
				}}
			>
				<SquarePen /> New chat
			</Button>
		</div>

		<div class="relative mb-4">
			<Search class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input bind:value={query} placeholder="Search chats" aria-label="Search chats" class="h-10 rounded-2xl pl-10 text-base" />
		</div>

		{#if shown.length === 0}
			<p class="py-12 text-center text-sm text-muted-foreground">{query ? 'No chats match.' : 'No chats yet. Start one!'}</p>
		{:else}
			<ul class="divide-y">
				{#each shown as t (t.id)}
					<li>
						<a href={`/chats/${t.id}`} class="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 hover:bg-secondary">
							<div class="min-w-0 flex-1">
								<p class="flex items-center gap-1.5 truncate text-sm font-medium">
									{#if t.starred}<Pin class="size-3.5 shrink-0 text-muted-foreground" />{/if}
									<span class="truncate">{t.title || t.preview || 'New chat'}</span>
								</p>
								{#if t.preview && t.preview !== t.title}
									<p class="truncate text-sm text-muted-foreground">{t.preview}</p>
								{/if}
							</div>
							<span class="shrink-0 text-xs text-muted-foreground">{when(t.updatedAt)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
