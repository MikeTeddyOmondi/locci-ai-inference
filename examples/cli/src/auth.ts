// A Locci token for the example API's /chat when it runs AUTH=locci. Without
// credentials nothing is sent, which is all an AUTH=off API needs.
//
//   LOCCI_ACCESS_TOKEN  sent as-is
//   LOCCI_API_KEY       exchanged at LOCCI_AUTH_URL/keys/token (the same
//                       exchange @locci/ai-sdk does), cached until shortly
//                       before it expires

const SKEW_MS = 60_000;
let cached: { token: string; expiresAt: number } | null = null;

async function token(): Promise<string | undefined> {
  if (process.env.LOCCI_ACCESS_TOKEN) return process.env.LOCCI_ACCESS_TOKEN;
  const key = process.env.LOCCI_API_KEY;
  if (!key) return undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const authURL = (process.env.LOCCI_AUTH_URL ?? 'https://auth.locci.cloud').replace(/\/+$/, '');
  const res = await fetch(`${authURL}/keys/token`, { method: 'POST', headers: { 'x-locci-api-key': key } });
  if (!res.ok) throw new Error(`Locci API key exchange failed (HTTP ${res.status})`);
  const body = (await res.json()) as { token?: string; expiresIn?: number };
  if (!body.token) throw new Error('Locci API key exchange returned no token');
  cached = { token: body.token, expiresAt: Date.now() + (body.expiresIn ?? 3600) * 1000 - SKEW_MS };
  return body.token;
}

/** `Authorization: Bearer` when credentials are set, nothing otherwise. */
export async function authHeaders(): Promise<Record<string, string>> {
  const t = await token();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** A clearer message for a 401 from an AUTH=locci API. */
export function explain401(status: number): string {
  return status === 401 ? ' (the API needs a Locci token: set LOCCI_API_KEY or LOCCI_ACCESS_TOKEN)' : '';
}
