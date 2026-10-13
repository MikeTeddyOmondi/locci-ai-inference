/**
 * App-wide UI state: sidebar, temporary-chat mode, and what the API reports
 * about itself. Preferences that should survive a reload go to localStorage
 * (best effort: private windows and blocked storage just fall back to defaults).
 */

import { apiUrl } from '$lib/config';

const COLLAPSED_KEY = 'locci.sidebarCollapsed';
const MODEL_KEY = 'locci.model';

function readFlag(key: string): boolean {
	try {
		return localStorage.getItem(key) === '1';
	} catch {
		return false;
	}
}

function writeFlag(key: string, value: boolean): void {
	writeString(key, value ? '1' : '0');
}

function readString(key: string): string {
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

function writeString(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage unavailable: the preference just won't persist
	}
}

/** A chat model the API offers (GET /models). */
export interface ChatModel {
	id: string;
	description: string;
	/** Can call tools; "Search the web" needs this. */
	tools: boolean;
	/** Reads photos; "Add photos" needs this. */
	images?: boolean;
	/** Listed but not selectable yet (e.g. needs images). */
	disabled?: boolean;
}

export const ui = $state({
	/** Mobile drawer open. */
	sidebarOpen: false,
	/** Desktop sidebar collapsed to an icon rail. */
	sidebarCollapsed: readFlag(COLLAPSED_KEY),
	/** The sidebar's chat search box is open (shared, so the rail can open it in the full sidebar). */
	searchOpen: false,
	/** Temporary chat: nothing is created or saved in the thread store. */
	temporary: false,
	/** Bumped to start a fresh chat even when already on "/". */
	newChatNonce: 0,
	/** The model new messages go to: the user's pick, else the API default. */
	model: readString(MODEL_KEY),
	/** The API's configured model, used when the pick is no longer offered. */
	defaultModel: '',
	/** Chat models the gateway serves, for the composer picker and Settings. */
	models: [] as ChatModel[],
	/** How much conversation text the API sends the model; longer input is shortened. */
	maxInputChars: 0,
	apiReachable: true
});

export function toggleSidebarCollapsed(): void {
	ui.sidebarCollapsed = !ui.sidebarCollapsed;
	writeFlag(COLLAPSED_KEY, ui.sidebarCollapsed);
}

/** The selected model, or undefined while the list hasn't loaded. */
export function currentModel(): ChatModel | undefined {
	return ui.models.find((m) => m.id === ui.model);
}

export function selectModel(id: string): void {
	ui.model = id;
	writeString(MODEL_KEY, id);
}

/** Ask the API which models it offers (cheap: the gateway's model list, cached). */
export async function loadApiInfo(): Promise<void> {
	try {
		const res = await fetch(`${apiUrl()}/models`);
		const body = (await res.json()) as { default: string; models: ChatModel[]; maxInputChars?: number };
		ui.defaultModel = body.default;
		ui.maxInputChars = body.maxInputChars ?? 0;
		ui.models = body.models;
		// Keep a saved pick only while the gateway still offers it.
		const saved = body.models.find((m) => m.id === ui.model && !m.disabled);
		if (!saved) ui.model = body.default;
		ui.apiReachable = true;
	} catch {
		ui.apiReachable = false;
	}
}

/** Start a new chat (leaving temporary mode, as ChatGPT does). */
export function startNewChat(): void {
	ui.temporary = false;
	ui.newChatNonce++;
	ui.sidebarOpen = false;
}
