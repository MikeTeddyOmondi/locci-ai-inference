/**
 * Locci AI Gateway provider for the Vercel AI SDK.
 *
 * The gateway speaks the OpenAI-compatible API, so this is a thin layer over
 * `@ai-sdk/openai-compatible`: Locci's model ids, its defaults, and its auth.
 *
 *   import { locci } from "@locci/ai-sdk";
 *   import { streamText } from "ai";
 *
 *   const result = streamText({ model: locci("qwen3-1.7b"), prompt: "..." });
 */

import {
  createOpenAICompatible,
  type OpenAICompatibleProvider,
} from "@ai-sdk/openai-compatible";

import { createAuthFetch, type FetchFunction } from "./auth.js";
import type { LocciChatModelId, LocciEmbeddingModelId } from "./models.js";

export { LocciAuthError } from "./auth.js";
export {
  LOCCI_CHAT_MODELS,
  LOCCI_EMBEDDING_MODELS,
  type LocciChatModelId,
  type LocciEmbeddingModelId,
} from "./models.js";

/**
 * Local defaults. There is no public gateway host yet; set `baseURL` /
 * `LOCCI_AI_BASE_URL` for anything other than the local stack.
 */
const DEFAULT_BASE_URL = "http://localhost:8080/v1";
const DEFAULT_AUTH_URL = "https://auth.locci.cloud";

export interface LocciProviderSettings {
  /** Gateway API root, including `/v1`. Env: `LOCCI_AI_BASE_URL`. */
  baseURL?: string;
  /** Locci API key, exchanged for short-lived access tokens. Env: `LOCCI_API_KEY`. */
  apiKey?: string;
  /** A locci-auth access token to send as-is (e.g. a signed-in user's). */
  accessToken?: string;
  /** Called before each request for a current access token. */
  getAccessToken?: () => string | Promise<string>;
  /** locci-auth origin for API-key exchange. Env: `LOCCI_AUTH_URL`. */
  authURL?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Custom fetch, for tests or proxies. */
  fetch?: FetchFunction;
}

export type LocciProvider = OpenAICompatibleProvider<LocciChatModelId, never, LocciEmbeddingModelId, never>;

/** Read an env var where one exists (Node, Bun, Deno); undefined in a browser. */
function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}

export function createLocci(settings: LocciProviderSettings = {}): LocciProvider {
  return createOpenAICompatible<LocciChatModelId, never, LocciEmbeddingModelId, never>({
    name: "locci",
    baseURL: (settings.baseURL ?? env("LOCCI_AI_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    headers: settings.headers,
    // The gateway meters from this usage block, so the SDK's numbers and the
    // bill agree. It injects the flag itself too; asking keeps them aligned.
    includeUsage: true,
    fetch: createAuthFetch({
      apiKey: settings.apiKey ?? (() => env("LOCCI_API_KEY")),
      accessToken: settings.accessToken,
      getAccessToken: settings.getAccessToken,
      authURL: settings.authURL ?? env("LOCCI_AUTH_URL") ?? DEFAULT_AUTH_URL,
      fetch: settings.fetch,
    }),
  });
}

/** One entry of the gateway's `GET /v1/models`. */
export interface LocciModelInfo {
  id: string;
  /** The gateway pool that serves it, e.g. `/coder`. */
  pool?: string;
}

/**
 * The models the gateway serves right now, from `GET /v1/models`, using the
 * same auth as model calls. Lets a client offer a model picker without
 * hard-coding ids.
 */
export async function listModels(settings: LocciProviderSettings = {}): Promise<LocciModelInfo[]> {
  const baseURL = (settings.baseURL ?? env("LOCCI_AI_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const authFetch = createAuthFetch({
    apiKey: settings.apiKey ?? (() => env("LOCCI_API_KEY")),
    accessToken: settings.accessToken,
    getAccessToken: settings.getAccessToken,
    authURL: settings.authURL ?? env("LOCCI_AUTH_URL") ?? DEFAULT_AUTH_URL,
    fetch: settings.fetch,
  });
  const res = await authFetch(`${baseURL}/models`, { headers: settings.headers });
  if (!res.ok) throw new Error(`GET ${baseURL}/models failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { data?: LocciModelInfo[] };
  return (body.data ?? []).map(({ id, pool }) => ({ id, pool }));
}

/**
 * Default instance, configured from the environment. `LOCCI_API_KEY` is read
 * per request; `LOCCI_AI_BASE_URL` and `LOCCI_AUTH_URL` at import.
 */
export const locci: LocciProvider = createLocci();
