/**
 * Thread persistence for the web example, which is client-only: the original
 * autonomous-chatbot kept threads server-side (Turso/libSQL via Drizzle and
 * remote functions). Here they live in the browser by default:
 *
 *   PUBLIC_THREAD_STORE=indexeddb (default)  IndexedDB via localbase
 *   PUBLIC_THREAD_STORE=api                  the example API's /api/threads
 *                                            (needs THREAD_STORE=libsql there)
 *
 * Both implement the same ThreadStore interface as examples/api/src/threads.ts,
 * so switching is configuration, not code.
 */

import Localbase from 'localbase';
import type { UIMessage } from 'ai';
import { env } from '$env/dynamic/public';
import { apiUrl } from '$lib/config';

export interface Thread {
	id: string;
	title: string;
	preview: string;
	starred: boolean;
	createdAt: string; // ISO 8601
	updatedAt: string;
}

export interface ThreadWithMessages extends Thread {
	messages: UIMessage[];
}

export type ThreadPatch = Partial<Pick<Thread, 'title' | 'preview' | 'starred'>>;

export interface ThreadStore {
	list(): Promise<Thread[]>;
	get(id: string): Promise<ThreadWithMessages | null>;
	create(data?: { title?: string; preview?: string }): Promise<Thread>;
	update(id: string, patch: ThreadPatch): Promise<Thread | null>;
	remove(id: string): Promise<void>;
	clear(): Promise<void>;
	syncMessages(id: string, messages: UIMessage[]): Promise<void>;
}

/** First text part of a message, as the original getMessageContent. */
function textOf(message: UIMessage): string {
	const part = message.parts?.find((p) => p.type === 'text');
	return part && 'text' in part ? part.text : '';
}

/** Starred first, then most recently updated, as the original ordering. */
function sortThreads(threads: Thread[]): Thread[] {
	return threads.sort((a, b) => {
		if (a.starred !== b.starred) return a.starred ? -1 : 1;
		return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
	});
}

/**
 * A usable thread record. Overlapping Localbase calls (before operations were
 * queued) could write a stray doc into `threads`; one bad record must not hide
 * every chat, so the list skips anything that isn't a thread.
 */
function isThread(doc: unknown): doc is Thread {
	const t = doc as Partial<Thread> | null;
	return !!t && typeof t.id === 'string' && !('messages' in t);
}

/**
 * IndexedDB through localbase. Two collections: `threads` (one doc per thread)
 * and `messages` (one doc per thread, holding its UIMessage array), which keeps
 * the thread list cheap to load.
 */
export class LocalbaseThreadStore implements ThreadStore {
	private db: Localbase;

	constructor(name = 'locci-chat') {
		this.db = new Localbase(name);
		this.db.config.debug = false;
	}

	/**
	 * Localbase keeps query state (collection, doc filter) on the instance, so
	 * two overlapping calls corrupt each other: a list() racing a get() can come
	 * back as a single doc. Run every operation one at a time.
	 */
	private queue: Promise<unknown> = Promise.resolve();
	private serial<T>(op: () => Promise<T>): Promise<T> {
		const run = this.queue.then(op, op);
		this.queue = run.catch(() => {});
		return run;
	}

	list(): Promise<Thread[]> {
		return this.serial(async () => {
			const docs = await this.db.collection('threads').get();
			const all: unknown[] = Array.isArray(docs) ? docs : [];
			const threads = all.filter(isThread);
			if (threads.length !== all.length) {
				console.warn(`Skipped ${all.length - threads.length} malformed thread record(s)`);
			}
			return sortThreads(threads);
		});
	}

	get(id: string): Promise<ThreadWithMessages | null> {
		return this.serial(async () => {
			const thread = (await this.db.collection('threads').doc({ id }).get()) as Thread | undefined;
			if (!thread) return null;
			const doc = (await this.db.collection('messages').doc({ id }).get()) as
				| { id: string; messages: UIMessage[] }
				| undefined;
			return { ...thread, messages: doc?.messages ?? [] };
		});
	}

	create(data: { title?: string; preview?: string } = {}): Promise<Thread> {
		return this.serial(async () => {
			const now = new Date().toISOString();
			const thread: Thread = {
				id: crypto.randomUUID(),
				title: data.title ?? '',
				preview: data.preview ?? '',
				starred: false,
				createdAt: now,
				updatedAt: now
			};
			await this.db.collection('threads').add(thread);
			return thread;
		});
	}

	update(id: string, patch: ThreadPatch): Promise<Thread | null> {
		return this.serial(() => this.updateUnqueued(id, patch));
	}

	/** For use inside another queued operation; queueing again would deadlock. */
	private async updateUnqueued(id: string, patch: ThreadPatch): Promise<Thread | null> {
		const current = (await this.db.collection('threads').doc({ id }).get()) as Thread | undefined;
		if (!current) return null;
		const updated: Thread = { ...current, ...patch, updatedAt: new Date().toISOString() };
		await this.db.collection('threads').doc({ id }).set(updated);
		return updated;
	}

	remove(id: string): Promise<void> {
		return this.serial(async () => {
			await this.db.collection('threads').doc({ id }).delete();
			await this.db.collection('messages').doc({ id }).delete();
		});
	}

	clear(): Promise<void> {
		return this.serial(async () => {
			await this.db.collection('threads').delete();
			await this.db.collection('messages').delete();
		});
	}

	syncMessages(id: string, messages: UIMessage[]): Promise<void> {
		return this.serial(async () => {
			// Svelte state proxies can't be stored by IndexedDB's structured clone.
			const plain = JSON.parse(JSON.stringify(messages)) as UIMessage[];
			const existing = await this.db.collection('messages').doc({ id }).get();
			if (existing) await this.db.collection('messages').doc({ id }).set({ id, messages: plain });
			else await this.db.collection('messages').add({ id, messages: plain });

			const firstUser = plain.find((m) => m.role === 'user');
			await this.updateUnqueued(id, firstUser ? { preview: textOf(firstUser).substring(0, 100) } : {});
		});
	}
}

/** The example API's libSQL store, over HTTP. */
export class ApiThreadStore implements ThreadStore {
	constructor(private base = `${apiUrl()}/api/threads`) {}

	private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
		const res = await fetch(`${this.base}${path}`, {
			...init,
			headers: { 'content-type': 'application/json', ...init.headers }
		});
		if (res.status === 404 && path !== '') return null as T;
		if (!res.ok) throw new Error(`threads API ${res.status}: ${await res.text().catch(() => '')}`);
		return (await res.json()) as T;
	}

	list = () => this.call<Thread[]>('');
	get = (id: string) => this.call<ThreadWithMessages | null>(`/${id}`);
	create = (data: { title?: string; preview?: string } = {}) =>
		this.call<Thread>('', { method: 'POST', body: JSON.stringify(data) });
	update = (id: string, patch: ThreadPatch) =>
		this.call<Thread | null>(`/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
	remove = async (id: string) => {
		await this.call(`/${id}`, { method: 'DELETE' });
	};
	clear = async () => {
		await this.call('', { method: 'DELETE' });
	};
	syncMessages = async (id: string, messages: UIMessage[]) => {
		await this.call(`/${id}/messages`, { method: 'PUT', body: JSON.stringify({ messages }) });
	};
}

let store: ThreadStore | null = null;

/** The configured store, created on first use (in the browser only). */
export function threadStore(): ThreadStore {
	store ??= env.PUBLIC_THREAD_STORE === 'api' ? new ApiThreadStore() : new LocalbaseThreadStore();
	return store;
}
