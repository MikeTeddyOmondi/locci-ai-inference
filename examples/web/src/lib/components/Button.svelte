<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils/cn';

	interface Props extends HTMLAttributes<HTMLButtonElement> {
		variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
		size?: 'default' | 'sm' | 'lg' | 'icon';
		disabled?: boolean;
	}

	const {
		variant = 'default',
		size = 'default',
		disabled = false,
		class: className,
		children,
		...rest
	}: Props = $props();

	const variants = {
		default: 'bg-black text-white hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200',
		destructive: 'bg-red-600 text-white hover:bg-red-600/90',
		outline: 'border border-gray-300 bg-white hover:bg-gray-100 dark:border-neutral-700 dark:bg-transparent dark:text-white dark:hover:bg-neutral-800',
		secondary: 'bg-gray-200 text-gray-900 hover:bg-gray-300 dark:bg-neutral-800 dark:text-white dark:hover:bg-neutral-700',
		ghost: 'hover:bg-gray-100 dark:hover:bg-neutral-800 dark:text-white',
		link: 'text-blue-600 underline-offset-4 hover:underline dark:text-blue-400'
	};

	const sizes = {
		default: 'h-10 px-4 py-2',
		sm: 'h-9 rounded-md px-3 text-sm',
		lg: 'h-11 rounded-md px-8',
		icon: 'h-10 w-10'
	};
</script>

<button
	class={cn(
		'inline-flex cursor-pointer items-center justify-center rounded-md text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-gray-300 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 dark:focus-visible:ring-neutral-600',
		variants[variant],
		sizes[size],
		className
	)}
	{disabled}
	{...rest}
>
	{@render children?.()}
</button>
