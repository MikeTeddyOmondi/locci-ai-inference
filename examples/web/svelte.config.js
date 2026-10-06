import adapter from '@sveltejs/adapter-static';

// A pure client: built to static files with an SPA fallback, no server routes.
// The chat model and tools live in the example API (examples/api).
/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({ fallback: 'index.html' })
	},
	compilerOptions: {
		experimental: {
			async: true
		}
	}
};

export default config;
