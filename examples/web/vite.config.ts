import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	build: {
		// The biggest chunks are single Shiki grammars (C++, Emacs Lisp), fetched
		// only when a reply contains that language; the app shell stays small.
		chunkSizeWarningLimit: 1000
	}
});
