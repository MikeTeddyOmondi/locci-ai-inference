import { env } from '$env/dynamic/public';

/** The example API (examples/api): the only backend this app talks to. */
export function apiUrl(): string {
	return (env.PUBLIC_API_URL || 'http://localhost:3939').replace(/\/+$/, '');
}
