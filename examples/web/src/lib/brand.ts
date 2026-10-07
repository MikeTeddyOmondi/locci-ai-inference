/**
 * Everything a site-specific clone of this chat UI is expected to change.
 * Components read from here; restyle colours in routes/layout.css.
 */

export interface Suggestion {
	/** lucide icon name rendered by EmptyState (see its icon map). */
	icon: 'cloud' | 'globe' | 'pencil' | 'code';
	label: string;
	prompt: string;
}

export const brand = {
	name: 'Locci AI',
	/** Shown on an empty chat. */
	greeting: "What's on the agenda today?",
	/** Shown on an empty temporary chat. */
	temporaryGreeting: 'Temporary chat',
	temporaryNote: "This chat won't appear in your history and isn't saved on this device.",
	placeholder: 'Ask anything',
	/** Footer under the composer. */
	disclaimer: 'Locci AI can make mistakes. Check important info.',
	suggestions: [
		{ icon: 'cloud', label: 'Check the weather', prompt: 'What is the weather in Nairobi right now?' },
		{ icon: 'globe', label: 'Search the web', prompt: 'Search the web for the latest news on small language models.' },
		{ icon: 'code', label: 'Write some code', prompt: 'Write a TypeScript function that debounces another function.' },
		{ icon: 'pencil', label: 'Write or edit', prompt: 'Help me write a short, friendly product announcement.' }
	] satisfies Suggestion[]
};
