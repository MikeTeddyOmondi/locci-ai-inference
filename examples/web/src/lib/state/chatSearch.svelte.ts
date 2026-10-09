/**
 * Chat search, shared by the sidebar and the /chats page. Matches titles and
 * the text of every message (the thread store's `search`), debounced, and
 * re-runs when the thread list changes so new replies are found too.
 */

import { threadStore, type Thread } from '$lib/storage/threads';
import { conversationState } from './conversationState.svelte';

const DEBOUNCE_MS = 150;

export interface ChatSearch {
	query: string;
	/** The threads to show: all of them, or the matches while searching. */
	readonly threads: Thread[];
	/** Text around the match in a thread's messages ('' when the title matched). */
	snippet(id: string): string;
	/** A search is typed but its results haven't come back yet. */
	readonly pending: boolean;
}

/** Call during component initialisation: it sets up an effect. */
export function createChatSearch(): ChatSearch {
	let query = $state('');
	let hits = $state<Map<string, string> | null>(null);
	let searchedFor = $state('');

	$effect(() => {
		const q = query.trim();
		// Track the thread list so a search refreshes as chats change.
		void conversationState.threads.length;
		void conversationState.threads[0]?.updatedAt;
		if (!q) {
			hits = null;
			searchedFor = '';
			return;
		}
		let cancelled = false;
		const timer = setTimeout(async () => {
			try {
				const found = await threadStore().search(q);
				if (!cancelled) hits = new Map(found.map((h) => [h.id, h.snippet]));
			} catch (error) {
				console.error('Chat search failed:', error);
				if (!cancelled) hits = new Map();
			}
			if (!cancelled) searchedFor = q;
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	const threads = $derived.by(() => {
		if (!query.trim() || !hits) return query.trim() ? [] : conversationState.threads;
		const found = hits;
		return conversationState.threads.filter((t) => found.has(t.id));
	});

	return {
		get query() {
			return query;
		},
		set query(value: string) {
			query = value;
		},
		get threads() {
			return threads;
		},
		snippet: (id) => hits?.get(id) ?? '',
		get pending() {
			return query.trim() !== '' && searchedFor !== query.trim();
		}
	};
}
