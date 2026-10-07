/**
 * Markdown for assistant replies: marked for parsing, Shiki for code blocks,
 * DOMPurify last so nothing the model writes can inject markup.
 *
 * Shiki loads lazily (first code block) with its JavaScript regex engine, so
 * there is no WASM download, and each language grammar loads on first use.
 * Highlighting is synchronous once a grammar is in; until then a block renders
 * as plain text and `highlight.version` bumps when the grammar arrives, which
 * re-runs any `renderMarkdown` call made inside a reactive context.
 */
import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import type { HighlighterCore } from 'shiki/core';

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

export const highlight = $state({ version: 0 });

let highlighter: HighlighterCore | undefined;
let starting: Promise<void> | undefined;
/** Canonical grammar id for every name and alias Shiki knows. */
let langIds: Map<string, string> | undefined;
const loading = new Set<string>();
const cache = new Map<string, string>();

function startHighlighter() {
	starting ??= (async () => {
		const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, langs, themes] = await Promise.all([
			import('shiki/core'),
			import('shiki/engine/javascript'),
			import('shiki/langs'),
			import('shiki/themes')
		]);
		langIds = new Map();
		for (const info of langs.bundledLanguagesInfo) {
			langIds.set(info.id, info.id);
			for (const alias of info.aliases ?? []) langIds.set(alias, info.id);
		}
		highlighter = await createHighlighterCore({
			themes: [themes.bundledThemes[THEMES.light], themes.bundledThemes[THEMES.dark]],
			langs: [],
			engine: createJavaScriptRegexEngine()
		});
		loadLanguage = async (id: string) => {
			const load = langs.bundledLanguages[id as keyof typeof langs.bundledLanguages];
			if (load) await highlighter!.loadLanguage(load);
		};
		highlight.version++;
	})().catch((err) => console.warn('Syntax highlighting unavailable:', err));
}

let loadLanguage: ((id: string) => Promise<void>) | undefined;

function escapeHtml(s: string) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Highlighted `<pre>` for a code block, or a plain one while Shiki warms up. */
function codeToHtml(code: string, lang: string): string {
	const plain = `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
	if (!highlighter || !langIds) {
		startHighlighter();
		return plain;
	}
	const id = langIds.get(lang.toLowerCase());
	if (!id) return plain;
	if (!highlighter.getLoadedLanguages().includes(id)) {
		if (!loading.has(id)) {
			loading.add(id);
			loadLanguage?.(id)
				.then(() => highlight.version++)
				.catch(() => {})
				.finally(() => loading.delete(id));
		}
		return plain;
	}
	const key = `${id}\u0000${code}`;
	let html = cache.get(key);
	if (!html) {
		html = highlighter.codeToHtml(code, { lang: id, themes: THEMES, defaultColor: false });
		if (cache.size > 300) cache.delete(cache.keys().next().value!);
		cache.set(key, html);
	}
	return html;
}

const marked = new Marked({ breaks: true, gfm: true });
marked.use({
	renderer: {
		code({ text, lang }: Tokens.Code) {
			const name = (lang ?? '').trim().split(/\s+/)[0];
			return `<div class="code-block"><div class="code-head"><span>${escapeHtml(name || 'text')}</span><button type="button" data-copy-code>Copy</button></div>${codeToHtml(text, name)}</div>`;
		}
	}
});

export function renderMarkdown(text: string): string {
	// Read the version so callers re-render once a grammar finishes loading.
	void highlight.version;
	return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

/**
 * Attachment for a container of rendered markdown: wires the Copy buttons in
 * code block headers (they are plain HTML, so one delegated listener).
 */
export function codeCopy(node: HTMLElement) {
	async function onClick(e: MouseEvent) {
		const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-code]');
		if (!button) return;
		const code = button.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
		try {
			await navigator.clipboard.writeText(code);
			button.textContent = 'Copied';
			setTimeout(() => (button.textContent = 'Copy'), 1600);
		} catch (err) {
			console.error('Copy failed:', err);
		}
	}
	node.addEventListener('click', onClick);
	return () => node.removeEventListener('click', onClick);
}
