<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Button, type ButtonProps } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

	/**
	 * A round icon button with a tooltip. `label` is both the tooltip text and
	 * the accessible name, so every icon-only control is labelled.
	 */
	type Props = Omit<ButtonProps, 'children'> & {
		label: string;
		side?: 'top' | 'bottom' | 'left' | 'right';
		children: Snippet;
	};

	let { label, side = 'bottom', variant = 'subtle', size = 'icon-round', children, ...rest }: Props = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<Button {...props} {...rest} {variant} {size} aria-label={label}>
				{@render children()}
			</Button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content {side}>{label}</Tooltip.Content>
</Tooltip.Root>
