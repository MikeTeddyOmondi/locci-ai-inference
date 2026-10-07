<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Ellipsis, PanelLeft, PanelLeftClose, Pencil, Pin, PinOff, Search, Settings, SquarePen, Trash2, X } from '@lucide/svelte';
	import { brand } from '$lib/brand';
	import {
		conversationState,
		currentThreadId,
		deleteConversation,
		toggleStar,
		updateConversation
	} from '$lib/state/conversationState.svelte';
	import { startNewChat, toggleSidebarCollapsed, ui } from '$lib/state/ui.svelte';
	import type { Thread } from '$lib/storage/threads';
	import Logo from './Logo.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import IconButton from './IconButton.svelte';

	interface Props {
		/** Desktop icon rail instead of the full panel. */
		rail?: boolean;
		/** Inside the mobile drawer: show a close button, close on navigate. */
		drawer?: boolean;
	}

	const { rail = false, drawer = false }: Props = $props();

	let query = $state('');
	let searching = $state(false);
	let searchInput: HTMLInputElement | undefined = $state();
	let editingId = $state<string | null>(null);
	let editTitle = $state('');
	let pendingDelete = $state<Thread | null>(null);
	let confirmOpen = $state(false);

	const activeId = $derived(currentThreadId(page.params.threadId));

	const filtered = $derived(
		query.trim()
			? conversationState.threads.filter((t) =>
					`${t.title} ${t.preview}`.toLowerCase().includes(query.trim().toLowerCase())
				)
			: conversationState.threads
	);
	const pinned = $derived(filtered.filter((t) => t.starred));
	const recent = $derived(filtered.filter((t) => !t.starred));

	function label(t: Thread) {
		return t.title || t.preview || 'New chat';
	}

	function newChat() {
		startNewChat();
		goto('/');
	}

	function openSearch() {
		if (rail) toggleSidebarCollapsed();
		searching = true;
		queueMicrotask(() => searchInput?.focus());
	}

	function startRename(t: Thread) {
		editingId = t.id;
		editTitle = label(t);
	}

	async function saveRename() {
		const id = editingId;
		editingId = null;
		const title = editTitle.trim();
		if (id && title) await updateConversation(id, { title });
	}

	function askDelete(t: Thread) {
		pendingDelete = t;
		confirmOpen = true;
	}

	async function confirmDelete() {
		const t = pendingDelete;
		if (!t) return;
		await deleteConversation(t.id);
		if (activeId === t.id) newChat();
	}

	function closeDrawer() {
		if (drawer) ui.sidebarOpen = false;
	}

	function focusOnMount(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

{#snippet threadRow(t: Thread)}
	<li class="group/row relative">
		{#if editingId === t.id}
			<Input
				class="h-9 rounded-xl bg-background"
				bind:value={editTitle}
				{@attach focusOnMount}
				onblur={saveRename}
				onkeydown={(e) => {
					if (e.key === 'Enter') saveRename();
					if (e.key === 'Escape') editingId = null;
				}}
				aria-label="Chat title"
			/>
		{:else}
			<a
				href={`/chats/${t.id}`}
				onclick={closeDrawer}
				class="flex items-center rounded-xl py-2 pr-9 pl-3 text-sm transition-colors {activeId === t.id
					? 'bg-accent text-accent-foreground'
					: 'hover:bg-accent'}"
				aria-current={activeId === t.id ? 'page' : undefined}
			>
				<span class="truncate">{label(t)}</span>
			</a>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					class="absolute top-1/2 right-1 inline-flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-muted-foreground opacity-100 hover:bg-background hover:text-foreground data-[state=open]:opacity-100 sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-visible:opacity-100"
					aria-label={`Options for ${label(t)}`}
				>
					<Ellipsis class="size-4" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" sideOffset={4} class="min-w-44">
					<DropdownMenu.Item onSelect={() => toggleStar(t.id)}>
						{#if t.starred}
							<PinOff class="text-muted-foreground" /> Unpin
						{:else}
							<Pin class="text-muted-foreground" /> Pin
						{/if}
					</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => startRename(t)}>
						<Pencil class="text-muted-foreground" /> Rename
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onSelect={() => askDelete(t)}>
						<Trash2 /> Delete
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
	</li>
{/snippet}

{#if rail}
	<!-- Collapsed desktop rail: icons only. -->
	<nav class="flex h-full w-14 flex-col items-center gap-1 border-r bg-surface-sunken py-3" aria-label="Sidebar">
		<a href="/" onclick={newChat} class="mb-1 flex size-9 items-center justify-center" aria-label={`${brand.name}, new chat`}>
			<img src="/favicon-32x32.png" alt="" class="size-7 rounded-md" width="32" height="32" />
		</a>
		<IconButton label="Open sidebar" side="right" onclick={toggleSidebarCollapsed}><PanelLeft /></IconButton>
		<IconButton label="New chat" side="right" onclick={newChat}><SquarePen /></IconButton>
		<IconButton label="Search chats" side="right" onclick={openSearch}><Search /></IconButton>
		<IconButton label="Settings" side="right" href="/settings" class="mt-auto"><Settings /></IconButton>
	</nav>
{:else}
	<nav class="flex h-full w-full flex-col bg-surface-sunken pt-safe md:w-72 md:border-r" aria-label="Sidebar">
		<div class="flex items-center gap-2 px-3 pt-3 pb-2">
			<a
				href="/"
				onclick={newChat}
				class="flex items-center gap-1.5 rounded-xl px-2 py-1.5 hover:bg-accent"
				aria-label={`${brand.name}, new chat`}
			>
				<Logo class="h-5" />
				<span class="text-[15px] font-semibold tracking-tight text-muted-foreground">AI</span>
			</a>
			{#if drawer}
				<IconButton label="Close sidebar" class="ml-auto" onclick={() => (ui.sidebarOpen = false)}><X /></IconButton>
			{:else}
				<IconButton label="Collapse sidebar" class="ml-auto" onclick={toggleSidebarCollapsed}><PanelLeftClose /></IconButton>
			{/if}
		</div>

		<div class="space-y-0.5 px-3">
			<Button variant="ghost" class="h-9 w-full justify-start gap-3 rounded-xl px-3 text-sm font-normal" onclick={newChat}>
				<SquarePen class="size-[18px] text-muted-foreground" /> New chat
			</Button>
			{#if searching}
				<div class="relative">
					<Search class="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground" />
					<Input
						bind:ref={searchInput}
						bind:value={query}
						placeholder="Search chats"
						aria-label="Search chats"
						class="h-9 rounded-xl bg-background pr-9 pl-10"
						onkeydown={(e) => {
							if (e.key === 'Escape') {
								query = '';
								searching = false;
							}
						}}
					/>
					<Button
						variant="subtle"
						size="icon-xs"
						class="absolute top-1/2 right-2 -translate-y-1/2 rounded-full"
						aria-label="Close search"
						onclick={() => {
							query = '';
							searching = false;
						}}
					>
						<X />
					</Button>
				</div>
			{:else}
				<Button variant="ghost" class="h-9 w-full justify-start gap-3 rounded-xl px-3 text-sm font-normal" onclick={openSearch}>
					<Search class="size-[18px] text-muted-foreground" /> Search chats
				</Button>
			{/if}
		</div>

		<div class="mt-4 min-h-0 flex-1 scroll-fade overflow-y-auto px-3 pb-3">
			{#if conversationState.isLoading && conversationState.threads.length === 0}
				<p class="shimmer px-3 text-sm text-muted-foreground" role="status">Loading…</p>
			{:else if filtered.length === 0}
				<p class="px-3 text-sm text-muted-foreground">{query ? 'No chats match.' : 'No chats yet.'}</p>
			{/if}

			{#if pinned.length > 0}
				<h2 class="px-3 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Pinned</h2>
				<ul class="mb-4 space-y-0.5">
					{#each pinned as t (t.id)}{@render threadRow(t)}{/each}
				</ul>
			{/if}
			{#if recent.length > 0}
				<h2 class="px-3 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Chats</h2>
				<ul class="space-y-0.5">
					{#each recent as t (t.id)}{@render threadRow(t)}{/each}
				</ul>
			{/if}
		</div>

		<div class="border-t px-3 pt-2 pb-safe">
			<Button
				variant="ghost"
				href="/settings"
				onclick={closeDrawer}
				class="h-9 w-full justify-start gap-3 rounded-xl px-3 text-sm font-normal {page.url.pathname === '/settings' ? 'bg-accent' : ''}"
			>
				<Settings class="size-[18px] text-muted-foreground" /> Settings
			</Button>
		</div>
	</nav>
{/if}

<ConfirmDialog
	bind:open={confirmOpen}
	title="Delete chat?"
	description={`This will delete "${pendingDelete ? label(pendingDelete) : ''}".`}
	onConfirm={confirmDelete}
/>
