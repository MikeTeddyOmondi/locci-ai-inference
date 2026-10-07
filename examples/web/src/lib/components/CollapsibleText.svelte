<script lang="ts">
	import { ChevronDown, ChevronUp } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		text: string;
	}

	const { text }: Props = $props();

	let expanded = $state(false);
	let overflowing = $state(false);

	/** Show "Show more" only when the text is taller than the collapsed height. */
	function measure(node: HTMLElement) {
		const check = () => (overflowing = node.scrollHeight > node.clientHeight + 1);
		const observer = new ResizeObserver(check);
		observer.observe(node);
		check();
		return () => observer.disconnect();
	}
</script>

<!-- A sent message: long text shows its first ~10 lines, fading out, with a
     ghost "Show more" to expand it in place. -->
<div class="max-w-[85%] rounded-3xl bg-bubble px-4 py-2.5 text-[15px] leading-relaxed sm:max-w-[75%]">
	<div
		class={['wrap-break-word whitespace-pre-wrap', !expanded && 'max-h-64 scroll-fade overflow-hidden scroll-fade-4']}
		{@attach measure}
	>
		{text}
	</div>
	{#if overflowing || expanded}
		<Button
			variant="ghost"
			size="sm"
			class="-ml-2 mt-1 gap-1 rounded-full px-2 text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			{#if expanded}Show less <ChevronUp />{:else}Show more <ChevronDown />{/if}
		</Button>
	{/if}
</div>
