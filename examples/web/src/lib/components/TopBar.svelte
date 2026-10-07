<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		Ellipsis,
		Menu,
		MessageCircleDashed,
		Moon,
		Pin,
		PinOff,
		Settings,
		SquarePen,
		Sun,
		Trash2
	} from '@lucide/svelte';
	import { mode, toggleMode } from 'mode-watcher';
	import { Badge } from '$lib/components/ui/badge';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { conversationState, currentThreadId, deleteConversation, toggleStar } from '$lib/state/conversationState.svelte';
	import { startNewChat, ui } from '$lib/state/ui.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import IconButton from './IconButton.svelte';
	import ThemeToggle from './ThemeToggle.svelte';

	const threadId = $derived(currentThreadId(page.params.threadId));
	const thread = $derived(threadId ? conversationState.threads.find((t) => t.id === threadId) : undefined);
	const onChat = $derived(page.url.pathname === '/' || page.url.pathname.startsWith('/chats/'));
	let confirmOpen = $state(false);

	/** Temporary chats start fresh and are never saved. */
	function toggleTemporary() {
		const next = !ui.temporary;
		startNewChat();
		ui.temporary = next;
		goto('/');
	}

	function newChat() {
		startNewChat();
		goto('/');
	}

	async function deleteThisChat() {
		if (!threadId) return;
		await deleteConversation(threadId);
		newChat();
	}
</script>

<header class="flex h-14 shrink-0 items-center gap-1 px-2 pt-safe sm:px-3">
	<IconButton label="Open sidebar" class="md:hidden" onclick={() => (ui.sidebarOpen = true)}>
		<Menu />
	</IconButton>

	<div class="flex min-w-0 items-center gap-2 px-1.5">
		{#if ui.temporary}
			<!-- Mobile has no temporary button in the bar, so say it here. -->
			<Badge variant="secondary" class="md:hidden">Temporary</Badge>
		{/if}
	</div>

	<!-- Desktop: temporary and theme as buttons. Mobile: one "..." menu holds every action. -->
	<div class="ml-auto flex items-center gap-0.5">
		{#if onChat}
			<span class="hidden md:contents">
				<IconButton
					label={ui.temporary ? 'Turn off temporary chat' : 'Turn on temporary chat'}
					aria-pressed={ui.temporary}
					onclick={toggleTemporary}
				>
					<MessageCircleDashed />
				</IconButton>
			</span>
		{/if}
		<span class="hidden md:contents"><ThemeToggle /></span>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="{buttonVariants({ variant: 'subtle', size: 'icon-round' })} -mr-1 md:hidden"
				aria-label="More options"
			>
				<Ellipsis />
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" sideOffset={6}>
				<DropdownMenu.Item onSelect={newChat}>
					<SquarePen class="text-muted-foreground" /> New chat
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={toggleTemporary}>
					<MessageCircleDashed class="text-muted-foreground" />
					{ui.temporary ? 'Leave temporary chat' : 'Temporary chat'}
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				{#if thread}
					<DropdownMenu.Item onSelect={() => toggleStar(thread.id)}>
						{#if thread.starred}
							<PinOff class="text-muted-foreground" /> Unpin chat
						{:else}
							<Pin class="text-muted-foreground" /> Pin chat
						{/if}
					</DropdownMenu.Item>
					<DropdownMenu.Item variant="destructive" onSelect={() => (confirmOpen = true)}>
						<Trash2 /> Delete chat
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
				{/if}
				<DropdownMenu.Item onSelect={toggleMode}>
					{#if mode.current === 'dark'}
						<Sun class="text-muted-foreground" /> Light mode
					{:else}
						<Moon class="text-muted-foreground" /> Dark mode
					{/if}
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => goto('/settings')}>
					<Settings class="text-muted-foreground" /> Settings
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</header>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Delete chat?"
	description={`This will delete "${thread?.title || thread?.preview || 'this chat'}".`}
	onConfirm={deleteThisChat}
/>
