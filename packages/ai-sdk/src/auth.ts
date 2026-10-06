/**
 * Turning whatever credential the caller holds into the bearer token the
 * gateway's edge (KrakenD) validates: a locci-auth ES256 access token whose
 * `properties.id` becomes the tenant.
 *
 * Two kinds of caller:
 *
 *   - Servers and web apps already hold a user's access token from the OAuth
 *     flow. They pass `accessToken` (or `getAccessToken` to fetch a fresh one
 *     per request) and nothing is exchanged.
 *   - CLIs and scripts hold a Locci API key. Access tokens from locci-auth's
 *     `/keys/token` last an hour, so the key is exchanged on first use, cached,
 *     and exchanged again shortly before expiry or after a 401.
 */

export type FetchFunction = typeof globalThis.fetch;

export interface LocciAuthOptions {
  /**
   * A Locci API key, exchanged at `${authURL}/keys/token` for access tokens.
   * A function is read on each request, so a key set after startup is seen.
   */
  apiKey?: string | (() => string | undefined);
  /** A locci-auth access token to send as-is. */
  accessToken?: string;
  /** Called before each request for a current access token. */
  getAccessToken?: () => string | Promise<string>;
  /** locci-auth origin used for API-key exchange. */
  authURL: string;
  /** Underlying fetch, for tests or custom agents. */
  fetch?: FetchFunction;
}

/** Re-exchange this long before the token's stated expiry. */
const EXPIRY_SKEW_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class LocciAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LocciAuthError";
  }
}

/**
 * Wraps `fetch` so every request carries `Authorization: Bearer <access token>`.
 *
 * With an API key, a 401 from the gateway triggers one re-exchange and one
 * retry. That covers a token revoked or expired early; anything persistent is
 * returned to the caller as the original 401.
 */
export function createAuthFetch(options: LocciAuthOptions): FetchFunction {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const authURL = options.authURL.replace(/\/+$/, "");

  let cached: CachedToken | null = null;
  let pending: Promise<CachedToken> | null = null;

  async function exchange(apiKey: string): Promise<CachedToken> {
    const response = await baseFetch(`${authURL}/keys/token`, {
      method: "POST",
      headers: { "x-locci-api-key": apiKey },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new LocciAuthError(
        `Locci API key exchange failed (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    const body = (await response.json()) as { token?: string; expiresIn?: number };
    if (!body.token) throw new LocciAuthError("Locci API key exchange returned no token");
    const ttlMs = (body.expiresIn ?? 3600) * 1000;
    return { token: body.token, expiresAt: Date.now() + ttlMs - EXPIRY_SKEW_MS };
  }

  async function tokenFromKey(apiKey: string, force: boolean): Promise<string> {
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    // One exchange in flight at a time, so a burst of parallel requests after
    // expiry does not mint a token each.
    pending ??= exchange(apiKey).finally(() => {
      pending = null;
    });
    cached = await pending;
    return cached.token;
  }

  const apiKey = (): string | undefined =>
    typeof options.apiKey === "function" ? options.apiKey() : options.apiKey;

  async function currentToken(force = false): Promise<string> {
    if (options.getAccessToken) return options.getAccessToken();
    if (options.accessToken) return options.accessToken;
    const key = apiKey();
    if (key) return tokenFromKey(key, force);
    throw new LocciAuthError(
      "No Locci credentials: pass apiKey, accessToken or getAccessToken, or set LOCCI_API_KEY",
    );
  }

  function withBearer(init: RequestInit | undefined, token: string): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return { ...init, headers };
  }

  return async (input, init) => {
    const response = await baseFetch(input, withBearer(init, await currentToken()));

    // Only an exchanged token can be refreshed, and only a replayable body can
    // be resent. The AI SDK sends JSON strings, so in practice it always is.
    const replayable = init?.body == null || typeof init.body === "string";
    const refreshable = !options.accessToken && !options.getAccessToken && Boolean(apiKey());
    if (response.status !== 401 || !refreshable || !replayable) {
      return response;
    }
    await response.body?.cancel();
    return baseFetch(input, withBearer(init, await currentToken(true)));
  };
}
