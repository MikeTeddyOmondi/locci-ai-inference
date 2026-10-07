<script lang="ts">
	import { ChevronDown } from '@lucide/svelte';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils';
	import { selectModel, ui } from '$lib/state/ui.svelte';

	interface Props {
		disabled?: boolean;
		class?: string;
	}

	const { disabled = false, class: className }: Props = $props();
</script>

<!-- Which gateway model the next message goes to. The list comes from the
     API's GET /models; the pick is remembered in localStorage. -->
<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class={cn(
			buttonVariants({ variant: 'subtle' }),
			'h-9 min-w-0 gap-1 rounded-full px-3 text-sm font-medium',
			className
		)}
		aria-label={`Model: ${ui.model || 'loading'}. Change model`}
		disabled={disabled || ui.models.length === 0}
	>
		<span class="max-w-36 truncate sm:max-w-none">{ui.model || 'Model'}</span>
		<ChevronDown class="size-4 shrink-0 opacity-70" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content side="top" align="end" sideOffset={8} class="w-72">
		<DropdownMenu.Label class="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">Model</DropdownMenu.Label>
		<DropdownMenu.RadioGroup value={ui.model} onValueChange={(id) => id && selectModel(id)}>
			{#each ui.models as m (m.id)}
				<DropdownMenu.RadioItem value={m.id} disabled={m.disabled} closeOnSelect class="items-start">
					<span class="flex min-w-0 flex-col">
						<span class="truncate font-medium">{m.id}</span>
						<span class="text-xs text-muted-foreground">{m.description}</span>
					</span>
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>
