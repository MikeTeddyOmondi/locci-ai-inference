/**
 * Shared conversation history state
 * Manages all conversation sessions across the application
 * Syncs with the configured thread store (IndexedDB by default, see
 * $lib/storage/threads) instead of the original's server remote functions.
 */

import { threadStore, type Thread } from '$lib/storage/threads';

export interface ConversationState {
	threads: Thread[];
	activeThreadId: string | null;
	isLoading: boolean;
}

// Initialize with default state
const initialState: ConversationState = {
	threads: [],
	activeThreadId: null,
	isLoading: false
};

export const conversationState = $state<ConversationState>(initialState);

/**
 * Load all threads from the store
 */
export async function loadThreads(): Promise<void> {
	conversationState.isLoading = true;
	try {
		conversationState.threads = await threadStore().list();
	} catch (error) {
		console.error('Failed to load threads:', error);
	} finally {
		conversationState.isLoading = false;
	}
}

/**
 * Create a new thread
 * @param title - Thread title (defaults to empty for ID display)
 * @param preview - Thread preview text
 * @param setActive - Whether to set this as the active thread (default: true)
 */
export async function createConversation(
	title: string = '',
	preview: string = '',
	setActive: boolean = true
): Promise<Thread | null> {
	try {
		const thread = await threadStore().create({ title, preview });
		conversationState.threads.unshift(thread);
		if (setActive) {
			conversationState.activeThreadId = thread.id;
		}
		return thread;
	} catch (error) {
		console.error('Failed to create thread:', error);
		return null;
	}
}

/**
 * Set the active thread
 */
export function setActiveConversation(threadId: string | null): void {
	conversationState.activeThreadId = threadId;
}

/**
 * Update a thread
 */
export async function updateConversation(
	threadId: string,
	updates: { title?: string; preview?: string; starred?: boolean }
): Promise<void> {
	try {
		const updated = await threadStore().update(threadId, updates);
		if (updated) {
			const index = conversationState.threads.findIndex((t) => t.id === threadId);
			if (index !== -1) {
				conversationState.threads[index] = updated;
			}
			// Re-sort threads after starring change
			if (updates.starred !== undefined) {
				sortThreads();
			}
		}
	} catch (error) {
		console.error('Failed to update thread:', error);
	}
}

/**
 * Toggle star status for a thread
 */
export async function toggleStar(threadId: string): Promise<void> {
	const thread = conversationState.threads.find((t) => t.id === threadId);
	if (thread) {
		await updateConversation(threadId, { starred: !thread.starred });
	}
}

/**
 * Sort threads: starred first, then by updatedAt
 */
function sortThreads(): void {
	conversationState.threads.sort((a, b) => {
		// Starred threads first
		if (a.starred && !b.starred) return -1;
		if (!a.starred && b.starred) return 1;
		// Then by updatedAt (most recent first)
		return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
	});
}

/**
 * Delete a thread
 */
export async function deleteConversation(threadId: string): Promise<void> {
	try {
		await threadStore().remove(threadId);
		const index = conversationState.threads.findIndex((t) => t.id === threadId);
		if (index !== -1) {
			conversationState.threads.splice(index, 1);
		}

		// If deleted thread was active, clear active or set to first
		if (conversationState.activeThreadId === threadId) {
			conversationState.activeThreadId =
				conversationState.threads.length > 0 ? conversationState.threads[0].id : null;
		}
	} catch (error) {
		console.error('Failed to delete thread:', error);
	}
}

/**
 * Clear all threads
 */
export async function clearAllConversations(): Promise<void> {
	try {
		await threadStore().clear();
		conversationState.threads = [];
		conversationState.activeThreadId = null;
	} catch (error) {
		console.error('Failed to clear threads:', error);
	}
}

/**
 * Get the active thread
 */
export function getActiveThread(): Thread | undefined {
	return conversationState.threads.find((t) => t.id === conversationState.activeThreadId);
}
