<script lang="ts">
	import { LogIn } from '@lucide/svelte';
	import { brand } from '$lib/brand';
	import { auth, login } from '$lib/state/auth.svelte';
	import { Button } from '$lib/components/ui/button';
	import Logo from './Logo.svelte';

	let pending = $state(false);

	async function signIn() {
		pending = true;
		try {
			await login();
		} catch (error) {
			console.error('Sign-in failed to start:', error);
			auth.error = 'Could not reach the sign-in service. Please try again.';
			pending = false;
		}
	}
</script>

<!-- Shown instead of the chat when the API needs a signed-in user (AUTH=locci). -->
<div class="flex h-dvh w-full items-center justify-center bg-background px-4 text-foreground">
	<div class="flex w-full max-w-sm flex-col items-center gap-6 text-center">
		<div class="flex items-center gap-2">
			<Logo class="h-8" />
			<span class="text-2xl font-semibold tracking-tight text-muted-foreground">AI</span>
		</div>
		<div class="space-y-2">
			<h1 class="text-xl font-semibold tracking-tight">Sign in to {brand.name}</h1>
			<p class="text-sm text-muted-foreground">Use your Locci account. Your chats are kept for you only.</p>
		</div>
		<Button size="lg" class="w-full gap-2 rounded-xl" onclick={signIn} disabled={pending}>
			<LogIn class="size-[18px]" />
			{pending ? 'Redirecting…' : 'Continue with Locci'}
		</Button>
		{#if auth.error}
			<p class="text-sm text-destructive" role="alert">{auth.error}</p>
		{/if}
	</div>
</div>
