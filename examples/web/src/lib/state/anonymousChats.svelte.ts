import { loadThreads } from '$lib/state/conversationState.svelte';
import { anonymousBrowserStore, threadStore } from '$lib/storage/threads';

// Chats this browser kept before sign-in. Signed in, the app reads the user's
// own store (a per-user IndexedDB database, or the API's threads), so chats
// from the anonymous database drop out of sight. Importing moves them into the
// signed-in user's store, keeping ids, titles, pins and dates, and removes each
// from the anonymous database once it is safely copied.

export const anonymousChats = $state({
	/** Chats waiting in the anonymous database. */
	count: 0,
	importing: false,
	/** Result of the last import, for a one-line notice. */
	imported: 0,
	failed: 0
});

/** Count what is waiting. Cheap: one IndexedDB read, and nothing when signed out. */
export async function checkAnonymousChats(): Promise<void> {
	try {
		const source = await anonymousBrowserStore();
		anonymousChats.count = source ? (await source.list()).length : 0;
	} catch (error) {
		console.error('Checking chats from before sign-in failed:', error);
		anonymousChats.count = 0;
	}
}

/** Move every waiting chat into the signed-in user's store. */
export async function importAnonymousChats(): Promise<void> {
	const source = await anonymousBrowserStore();
	if (!source || anonymousChats.importing) return;
	anonymousChats.importing = true;
	let imported = 0;
	let failed = 0;
	try {
		for (const { id } of await source.list()) {
			try {
				const thread = await source.get(id);
				if (!thread) continue;
				await threadStore().importThread(thread);
				// Only after the copy is stored: a failure leaves the original in place.
				await source.remove(id);
				imported++;
			} catch (error) {
				console.error(`Importing chat ${id} failed:`, error);
				failed++;
			}
		}
	} finally {
		anonymousChats.importing = false;
		anonymousChats.imported = imported;
		anonymousChats.failed = failed;
		await checkAnonymousChats();
		await loadThreads();
	}
}
