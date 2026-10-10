<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { Blobatar } from '@blobatar/svelte';
	import { Check, Copy, Download, Import, LogOut, Monitor, Moon, Sun, Trash2 } from '@lucide/svelte';
	import { anonymousChats, importAnonymousChats } from '$lib/state/anonymousChats.svelte';
	import { setMode, userPrefersMode } from 'mode-watcher';
	import { brand } from '$lib/brand';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import * as RadioGroup from '$lib/components/ui/radio-group';
	import * as Card from '$lib/components/ui/card';
	import { Separator } from '$lib/components/ui/separator';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { apiUrl } from '$lib/config';
	import { auth, logout } from '$lib/state/auth.svelte';
	import { clearAllConversations, conversationState } from '$lib/state/conversationState.svelte';
	import { selectModel, ui } from '$lib/state/ui.svelte';
	import { threadStore } from '$lib/storage/threads';

	let confirmClear = $state(false);
	let copiedTenant = $state(false);

	async function copyTenant() {
		if (!auth.user) return;
		await navigator.clipboard.writeText(auth.user.id);
		copiedTenant = true;
		setTimeout(() => (copiedTenant = false), 1600);
	}
	let exporting = $state(false);

	const storage = env.PUBLIC_THREAD_STORE === 'api' ? 'Example API (libSQL)' : 'This browser (IndexedDB)';
	const themes = [
		{ value: 'system', label: 'System', icon: Monitor },
		{ value: 'light', label: 'Light', icon: Sun },
		{ value: 'dark', label: 'Dark', icon: Moon }
	] as const;

	/** Download every chat, with messages, as one JSON file. */
	async function exportChats() {
		exporting = true;
		try {
			const store = threadStore();
			const threads = await Promise.all(conversationState.threads.map((t) => store.get(t.id)));
			const blob = new Blob([JSON.stringify(threads.filter(Boolean), null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = Object.assign(document.createElement('a'), {
				href: url,
				download: `locci-chats-${new Date().toISOString().slice(0, 10)}.json`
			});
			a.click();
			URL.revokeObjectURL(url);
		} finally {
			exporting = false;
		}
	}
</script>

<svelte:head>
	<title>Settings · {brand.name}</title>
</svelte:head>

<div class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto w-full max-w-2xl px-4 pt-4 pb-safe sm:pt-8">
		<h1 class="mb-6 text-2xl font-semibold tracking-tight">Settings</h1>

		{#if auth.user}
			<section class="mb-8">
				<h2 class="mb-2 text-sm font-medium text-muted-foreground">Account</h2>
				<Card.Root class="flex-row flex-wrap items-center gap-4 rounded-2xl p-4 shadow-none">
					<Blobatar name={auth.user.email || auth.user.id} size={64} animate="always" class="shrink-0" />
					<div class="min-w-0 flex-1 space-y-1">
						<p class="truncate text-sm font-medium" title={auth.user.email}>{auth.user.email}</p>
						<div class="flex items-center gap-1 text-xs text-muted-foreground">
							<span class="shrink-0">Tenant ID</span>
							<code class="min-w-0 rounded bg-secondary px-1.5 py-0.5 font-mono break-all sm:truncate" title={auth.user.id}>{auth.user.id}</code>
							<Button
								variant="ghost"
								size="icon-xs"
								class="shrink-0 rounded-full transition-transform active:scale-90"
								aria-label={copiedTenant ? 'Tenant ID copied' : 'Copy tenant ID'}
								onclick={copyTenant}
							>
								{#if copiedTenant}<Check class="copy-pop" />{:else}<Copy />{/if}
							</Button>
						</div>
					</div>
					<Button variant="outline" size="sm" class="shrink-0 gap-1.5 rounded-full max-sm:w-full" onclick={logout}>
						<LogOut /> Sign out
					</Button>
				</Card.Root>
			</section>
		{/if}

		<section class="mb-8">
			<h2 class="mb-2 text-sm font-medium text-muted-foreground">Appearance</h2>
			<Card.Root class="gap-3 rounded-2xl p-4 shadow-none">
				<p class="text-sm">Theme</p>
				<ToggleGroup.Root
					type="single"
					aria-label="Theme"
					class="w-fit rounded-full bg-secondary p-1"
					bind:value={() => userPrefersMode.current, (v) => v && setMode(v as (typeof themes)[number]['value'])}
				>
					{#each themes as t (t.value)}
						{@const Icon = t.icon}
						<ToggleGroup.Item
							value={t.value}
							class="cursor-pointer gap-1.5 rounded-full! px-3.5 text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
						>
							<Icon />
							{t.label}
						</ToggleGroup.Item>
					{/each}
				</ToggleGroup.Root>
			</Card.Root>
		</section>

		<section class="mb-8">
			<h2 class="mb-2 text-sm font-medium text-muted-foreground">Models</h2>
			<Card.Root class="gap-0 rounded-2xl py-0 shadow-none">
				{#if ui.models.length === 0}
					{#if ui.apiReachable}
						<p class="shimmer p-4 text-sm text-muted-foreground" role="status">Loading models…</p>
					{:else}
						<p class="p-4 text-sm text-muted-foreground">Couldn't reach the API to list models.</p>
					{/if}
				{:else}
					<RadioGroup.Root
						aria-label="Model for new messages"
						class="gap-0"
						value={ui.model}
						onValueChange={(id) => id && selectModel(id)}
					>
						{#each ui.models as m, i (m.id)}
							{#if i > 0}<Separator />{/if}
							<Label
								for={`model-${m.id}`}
								class="flex cursor-pointer items-start gap-3 p-4 font-normal has-disabled:cursor-not-allowed has-disabled:opacity-60"
							>
								<RadioGroup.Item id={`model-${m.id}`} value={m.id} disabled={m.disabled} class="mt-0.5" />
								<span class="flex min-w-0 flex-1 flex-col gap-1">
									<span class="flex flex-wrap items-center gap-1.5">
										<span class="text-sm font-medium">{m.id}</span>
										{#if m.id === ui.defaultModel}<Badge variant="secondary">Default</Badge>{/if}
										{#if m.tools}<Badge variant="outline">Tools</Badge>{/if}
										{#if m.disabled}<Badge variant="outline">Soon</Badge>{/if}
									</span>
									<span class="text-xs text-muted-foreground">{m.description}</span>
								</span>
							</Label>
						{/each}
					</RadioGroup.Root>
				{/if}
			</Card.Root>
			<p class="mt-2 px-1 text-xs text-muted-foreground">
				New messages go to the selected model. You can also switch from the message box.
			</p>
		</section>

		<section class="mb-8">
			<h2 class="mb-2 text-sm font-medium text-muted-foreground">Data controls</h2>
			<Card.Root class="gap-0 rounded-2xl py-0 shadow-none">
				<div class="flex items-center justify-between gap-4 p-4">
					<div>
						<p class="text-sm">Chat history</p>
						<p class="text-xs text-muted-foreground">
							{conversationState.threads.length} chat{conversationState.threads.length === 1 ? '' : 's'}, stored in {storage}.
							Temporary chats are never stored.
						</p>
					</div>
				</div>
				{#if auth.user && (anonymousChats.count > 0 || anonymousChats.imported > 0)}
					<Separator />
					<div class="flex items-center justify-between gap-4 p-4">
						<div>
							<p class="text-sm">Chats from before you signed in</p>
							<p class="text-xs text-muted-foreground">
								{#if anonymousChats.count > 0}
									{anonymousChats.count} chat{anonymousChats.count === 1 ? '' : 's'} saved in this browser without an account. Import moves
									them into your chats.
								{:else}
									Imported {anonymousChats.imported} chat{anonymousChats.imported === 1 ? '' : 's'}.
								{/if}
								{#if anonymousChats.failed > 0}{anonymousChats.failed} could not be imported and stayed where they were.{/if}
							</p>
						</div>
						{#if anonymousChats.count > 0}
							<Button
								variant="outline"
								class="h-9 rounded-full px-4"
								onclick={importAnonymousChats}
								disabled={anonymousChats.importing}
							>
								<Import />
								{anonymousChats.importing ? 'Importing…' : 'Import'}
							</Button>
						{/if}
					</div>
				{/if}
				<Separator />
				<div class="flex items-center justify-between gap-4 p-4">
					<div>
						<p class="text-sm">Export chats</p>
						<p class="text-xs text-muted-foreground">Download all chats and messages as JSON.</p>
					</div>
					<Button
						variant="outline"
						class="h-9 rounded-full px-4"
						onclick={exportChats}
						disabled={exporting || conversationState.threads.length === 0}
					>
						<Download /> Export
					</Button>
				</div>
				<Separator />
				<div class="flex items-center justify-between gap-4 p-4">
					<div>
						<p class="text-sm">Delete all chats</p>
						<p class="text-xs text-muted-foreground">Permanently removes every chat from {storage}.</p>
					</div>
					<Button
						variant="destructive"
						class="h-9 rounded-full px-4"
						onclick={() => (confirmClear = true)}
						disabled={conversationState.threads.length === 0}
					>
						<Trash2 /> Delete all
					</Button>
				</div>
			</Card.Root>
		</section>

		<section class="mb-8">
			<h2 class="mb-2 text-sm font-medium text-muted-foreground">About</h2>
			<dl class="divide-y rounded-2xl border bg-card text-sm">
				<div class="flex justify-between gap-4 p-4">
					<dt class="text-muted-foreground">API</dt>
					<dd class="truncate font-mono text-xs">{apiUrl()}</dd>
				</div>
				<div class="flex justify-between gap-4 p-4">
					<dt class="text-muted-foreground">Status</dt>
					<dd class={ui.apiReachable ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
						{ui.apiReachable ? 'Connected' : 'Unreachable'}
					</dd>
				</div>
			</dl>
		</section>
	</div>
</div>

<ConfirmDialog
	bind:open={confirmClear}
	title="Delete all chats?"
	description="This permanently deletes every chat. It can't be undone."
	confirmLabel="Delete all"
	onConfirm={clearAllConversations}
/>
