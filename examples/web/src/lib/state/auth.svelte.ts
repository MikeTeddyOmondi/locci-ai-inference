import { createClient } from '@openauthjs/openauth/client';
import { goto } from '$app/navigation';
import { apiUrl } from '$lib/config';

// Sign-in with Locci, as OpenAuth's React SPA example does it: the browser runs
// the PKCE code flow against locci-auth, keeps the refresh token in
// localStorage and the access token in memory, and sends the access token to
// the API as `Authorization: Bearer`. The API (AUTH=locci) verifies it and
// keeps threads and recordings per user. Whether sign-in is on, and against
// which issuer, comes from the API's /info, so there is one switch (AUTH on
// the API) and no web env to keep in step.
//
// The refresh token in localStorage is readable by any script on the page, as
// in the OpenAuth example; fine for this example, worth an httpOnly cookie
// (a server in front of the app) for anything more.

const REFRESH_KEY = 'locci-ai.refresh';
const CHALLENGE_KEY = 'locci-ai.challenge';
const RETURN_KEY = 'locci-ai.return';

export interface AuthUser {
	id: string;
	email: string;
}

export const auth = $state({
	/** locci when the API needs a signed-in user. */
	mode: 'off' as 'off' | 'locci',
	user: null as AuthUser | null,
	/** False until /info and any sign-in callback or token refresh are done. */
	ready: false,
	/** Shown on the sign-in screen when the last attempt failed. */
	error: ''
});

let client: ReturnType<typeof createClient> | null = null;
let access: string | undefined;
let refreshing: Promise<string | undefined> | null = null;

/** The user a token was issued for (the API verifies it; this only reads it). */
function userFrom(token: string): AuthUser | null {
	try {
		const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
		const { id, email } = payload.properties ?? {};
		return typeof id === 'string' ? { id, email: typeof email === 'string' ? email : '' } : null;
	} catch {
		return null;
	}
}

function storage(kind: 'local' | 'session'): Storage | null {
	try {
		return kind === 'local' ? localStorage : sessionStorage;
	} catch {
		return null;
	}
}

function signedOut() {
	storage('local')?.removeItem(REFRESH_KEY);
	access = undefined;
	auth.user = null;
}

/** Read /info, finish a sign-in that just returned, or refresh a saved session. Call once at start. */
export async function initAuth(): Promise<void> {
	try {
		const info = (await (await fetch(`${apiUrl()}/info`)).json()) as {
			auth?: string;
			authIssuer?: string;
			authClientId?: string;
		};
		if (info.auth === 'locci' && info.authIssuer && info.authClientId) {
			auth.mode = 'locci';
			client = createClient({ clientID: info.authClientId, issuer: info.authIssuer });
			const params = new URLSearchParams(location.search);
			const code = params.get('code');
			const state = params.get('state');
			if (code && state) await callback(code, state);
			else if (params.get('error')) {
				// The issuer sent the user back without signing in (as the console's login page reads it).
				auth.error = params.get('error_description') || 'Sign-in failed. Please try again.';
				await goto(storage('session')?.getItem(RETURN_KEY) || '/', { replaceState: true });
			} else await getToken();
		}
	} catch (error) {
		// API unreachable: carry on, the chat shows its own unreachable state.
		console.error('Auth setup failed:', error);
	} finally {
		auth.ready = true;
	}
}

async function callback(code: string, state: string) {
	const challenge = JSON.parse(storage('session')?.getItem(CHALLENGE_KEY) ?? 'null') as {
		state: string;
		verifier?: string;
	} | null;
	storage('session')?.removeItem(CHALLENGE_KEY);
	const back = storage('session')?.getItem(RETURN_KEY) || '/';
	storage('session')?.removeItem(RETURN_KEY);
	if (client && challenge?.verifier && challenge.state === state) {
		const exchanged = await client.exchange(code, location.origin, challenge.verifier);
		if (!exchanged.err) {
			storage('local')?.setItem(REFRESH_KEY, exchanged.tokens.refresh);
			access = exchanged.tokens.access;
			auth.user = userFrom(access);
			auth.error = '';
		} else auth.error = 'Sign-in failed. Please try again.';
	} else auth.error = 'Sign-in expired. Please try again.';
	// Drop ?code&state from the address bar and go back where sign-in started.
	await goto(back, { replaceState: true });
}

/**
 * A current access token, refreshed when it is about to expire; undefined when
 * signed out (the sign-in screen then shows). One refresh at a time: refresh
 * tokens rotate, so two at once would spend the same one twice.
 */
export function getToken(): Promise<string | undefined> {
	if (!client) return Promise.resolve(undefined);
	const refresh = storage('local')?.getItem(REFRESH_KEY);
	if (!refresh) {
		signedOut();
		return Promise.resolve(undefined);
	}
	refreshing ??= client
		.refresh(refresh, { access })
		.then((next) => {
			if (next.err) {
				signedOut();
				return undefined;
			}
			if (next.tokens) {
				storage('local')?.setItem(REFRESH_KEY, next.tokens.refresh);
				access = next.tokens.access;
			}
			auth.user = access ? userFrom(access) : null;
			return access;
		})
		.catch(() => access)
		.finally(() => {
			refreshing = null;
		});
	return refreshing;
}

/** Headers for an API call: the bearer token when signed in, nothing otherwise. */
export async function authHeaders(): Promise<Record<string, string>> {
	const token = await getToken();
	return token ? { authorization: `Bearer ${token}` } : {};
}

export async function login(): Promise<void> {
	if (!client) return;
	// One button here; locci-auth's own page offers its sign-in methods.
	const { challenge, url } = await client.authorize(location.origin, 'code', { pkce: true });
	storage('session')?.setItem(CHALLENGE_KEY, JSON.stringify(challenge));
	storage('session')?.setItem(RETURN_KEY, location.pathname + location.search + location.hash);
	location.href = url;
}

export function logout(): void {
	signedOut();
	// A full reload drops every chat held in memory for the previous user.
	location.replace('/');
}
