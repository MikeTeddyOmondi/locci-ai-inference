<script lang="ts">
	/**
	 * The Locci wordmark (copied from locci-platform, the console).
	 *
	 * Two files rather than one, swapped by CSS: the mark is flat black or flat
	 * white, and neither survives being dropped on the opposite background. The
	 * `dark:` variants mean the swap happens in the same paint as the rest of the
	 * theme, so there is no flash on load or on toggle, which a JS-chosen `src`
	 * would give.
	 *
	 * The masters are square with ~87% padding; these are cropped to the wordmark
	 * (about 3:1), so height drives the size and width follows.
	 */

	let {
		/** Tailwind height classes; width follows the aspect ratio. */
		class: className = 'h-6 sm:h-7'
	}: { class?: string } = $props();
</script>

<span class="inline-flex shrink-0 items-center">
	<img
		src="/logo-light.png"
		alt="Locci"
		class="{className} w-auto dark:hidden"
		width="893"
		height="295"
		decoding="async"
	/>
	<img
		src="/logo-dark.png"
		alt="Locci"
		class="{className} hidden w-auto dark:block"
		width="892"
		height="295"
		decoding="async"
	/>
</span>
