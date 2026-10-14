// A Locci token for the example API's /chat when it runs AUTH=locci. Without
// credentials nothing is sent, which is all an AUTH=off API needs.
//
// First match wins:
//   LOCCI_ACCESS_TOKEN  sent as-is
//   LOCCI_API_KEY       exchanged at LOCCI_AUTH_URL/keys/token (the same
//                       exchange @locci/ai-sdk does), cached until shortly
//                       before it expires
//   `locci-chat login`  the signed-in user's token, refreshed as needed
//
// Login follows iaas-service's `locci-compute login` (OpenAuth's PKCE code
// flow with a localhost callback, tokens kept under ~/.locci/ai), with its own
// client id and file so the two CLIs' sessions don't overwrite each other.

import { createClient } from '@openauthjs/openauth/client';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { loginPage } from './login-page.js';
import { aiFile } from './paths.js';

const SKEW_MS = 60_000;
const CLIENT_ID = 'locci-ai-cli';
const SESSION_FILE = aiFile('session.json');
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const API = () => process.env.API_URL ?? 'http://localhost:3939';

let cached: { token: string; expiresAt: number } | null = null;

interface Session {
  issuer: string;
  access: string;
  refresh: string;
  savedAt: number;
}

async function apiKeyToken(key: string): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const authURL = (process.env.LOCCI_AUTH_URL ?? 'https://auth.locci.cloud').replace(/\/+$/, '');
  const res = await fetch(`${authURL}/keys/token`, { method: 'POST', headers: { 'x-locci-api-key': key } });
  if (!res.ok) throw new Error(`Locci API key exchange failed (HTTP ${res.status})`);
  const body = (await res.json()) as { token?: string; expiresIn?: number };
  if (!body.token) throw new Error('Locci API key exchange returned no token');
  cached = { token: body.token, expiresAt: Date.now() + (body.expiresIn ?? 3600) * 1000 - SKEW_MS };
  return body.token;
}

async function loadSession(): Promise<Session | null> {
  try {
    const s = JSON.parse(await readFile(SESSION_FILE, 'utf8')) as Partial<Session>;
    return s.issuer && s.access && s.refresh ? (s as Session) : null;
  } catch {
    return null;
  }
}

async function saveSession(session: Session): Promise<void> {
  await mkdir(path.dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  // Owner-only: the refresh token is a long-lived credential.
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

/** The saved login's access token, refreshed when it is about to expire. Undefined when not logged in. */
async function sessionToken(): Promise<string | undefined> {
  const session = await loadSession();
  if (!session) return undefined;
  const client = createClient({ issuer: session.issuer, clientID: CLIENT_ID });
  // Returns no tokens while the access token is still good.
  const next = await client.refresh(session.refresh, { access: session.access });
  if (next.err) throw new Error('Your Locci login has expired: run `locci-chat login` again');
  if (!next.tokens) return session.access;
  await saveSession({ ...session, access: next.tokens.access, refresh: next.tokens.refresh, savedAt: Date.now() });
  return next.tokens.access;
}

async function token(): Promise<string | undefined> {
  if (process.env.LOCCI_ACCESS_TOKEN) return process.env.LOCCI_ACCESS_TOKEN;
  if (process.env.LOCCI_API_KEY) return apiKeyToken(process.env.LOCCI_API_KEY);
  return sessionToken();
}

/** `Authorization: Bearer` when credentials are set, nothing otherwise. */
export async function authHeaders(): Promise<Record<string, string>> {
  const t = await token();
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** A clearer message for a 401 from an AUTH=locci API. */
export function explain401(status: number): string {
  return status === 401 ? ' (the API needs a Locci login: run `locci-chat login`, or set LOCCI_API_KEY)' : '';
}

/**
 * The issuer to log in with: LOCCI_AUTH_URL, else the one the API verifies
 * tokens against (its /info), else Locci Cloud's.
 */
async function issuer(): Promise<string> {
  if (process.env.LOCCI_AUTH_URL) return process.env.LOCCI_AUTH_URL.replace(/\/+$/, '');
  try {
    const info = (await (await fetch(`${API()}/info`)).json()) as { authIssuer?: string };
    if (info.authIssuer) return info.authIssuer.replace(/\/+$/, '');
  } catch {
    // API not running: fall through to the default.
  }
  return 'https://auth.locci.cloud';
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // The URL is printed too.
  }
}

/**
 * Sign in in the browser. A one-off server on a free localhost port takes the
 * redirect (locci-auth allows any localhost redirect), checks the state, and
 * exchanges the code with the PKCE verifier.
 */
export async function login(): Promise<void> {
  const iss = await issuer();
  const client = createClient({ issuer: iss, clientID: CLIENT_ID });
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirect = `http://localhost:${(server.address() as AddressInfo).port}/callback`;

  try {
    const { challenge, url } = await client.authorize(redirect, 'code', { pkce: true });
    const tokens = await new Promise<{ access: string; refresh: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the browser (5 minutes)')), LOGIN_TIMEOUT_MS);
      server.on('request', async (req, res) => {
        const params = new URL(req.url ?? '/', redirect).searchParams;
        if (!req.url?.startsWith('/callback')) {
          res.writeHead(404).end();
          return;
        }
        const fail = (reason: string) => {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(loginPage({ ok: false, reason }));
          clearTimeout(timer);
          reject(new Error(reason));
        };
        if (params.get('error')) return fail(params.get('error_description') ?? params.get('error') ?? 'sign-in failed');
        const code = params.get('code');
        if (!code) return fail('no authorization code in the callback');
        if (params.get('state') !== challenge.state) return fail('state mismatch');
        const exchanged = await client.exchange(code, redirect, challenge.verifier);
        if (exchanged.err) return fail(`token exchange failed: ${exchanged.err.message}`);
        res
          .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(loginPage({ ok: true, email: userFrom(exchanged.tokens.access)?.email }));
        clearTimeout(timer);
        resolve(exchanged.tokens);
      });
      console.log(`Opening your browser to sign in with ${iss}`);
      console.log(`If it doesn't open, visit:\n  ${url}\n`);
      openBrowser(url);
    });
    await saveSession({ issuer: iss, access: tokens.access, refresh: tokens.refresh, savedAt: Date.now() });
    const user = userFrom(tokens.access);
    console.log(`✅ Logged in${user?.email ? ` as ${user.email}` : ''}. Saved to ${SESSION_FILE}`);
  } finally {
    server.close();
  }
}

export async function logout(): Promise<void> {
  const had = await loadSession();
  await rm(SESSION_FILE, { force: true });
  console.log(had ? '✅ Logged out.' : 'Not logged in.');
}

/** Who requests are sent as, and from which source. */
export async function whoami(): Promise<void> {
  const source = process.env.LOCCI_ACCESS_TOKEN
    ? 'LOCCI_ACCESS_TOKEN'
    : process.env.LOCCI_API_KEY
      ? 'LOCCI_API_KEY'
      : (await loadSession())
        ? `login (${SESSION_FILE})`
        : null;
  if (!source) {
    console.log('Not logged in. Run `locci-chat login` (or set LOCCI_API_KEY).');
    process.exitCode = 1;
    return;
  }
  const t = await token();
  const user = t ? userFrom(t) : null;
  console.log(`✅ ${user?.email || user?.id || 'token'} via ${source}`);
  if (user?.id) console.log(`   tenant: ${user.id}`);
}

/** The user a token was issued for (the API verifies it; this only reads it). */
function userFrom(t: string): { id?: string; email?: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
    return { id: payload.properties?.id ?? payload.sub, email: payload.properties?.email };
  } catch {
    return null;
  }
}
