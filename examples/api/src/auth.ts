import { createClient } from '@openauthjs/openauth/client';
import { createSubjects } from '@openauthjs/openauth/subject';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

// Sign-in for the web routes, as OpenAuth's jwt-api example does it: the web
// app runs the PKCE flow against locci-auth itself and sends the access token
// as `Authorization: Bearer`; this only verifies it (signature, issuer,
// expiry) and names the user. Tokens minted from a Locci API key verify too,
// so scripts and curl can call the same routes.
//
// AUTH picks the mode:
//   off (default)  no sign-in; every caller is the same anonymous owner ('')
//   locci          /api/chat and /api/threads need a valid Locci token

const subjects = createSubjects({
  user: z.object({ id: z.string(), email: z.string() }),
});

export interface User {
  /** Owner key for threads and recordings: '' when AUTH=off. */
  id: string;
  email?: string;
  /** The caller's access token, forwarded to Ursula so its gateway scopes streams to this user. */
  token?: string;
}

const ANONYMOUS: User = { id: '' };

export interface AuthConfig {
  mode: 'locci' | 'off';
  issuer: string;
  /** The client id the web app signs in with. */
  clientId: string;
}

export function authConfig(env = process.env): AuthConfig {
  const mode = (env.AUTH ?? 'off').toLowerCase();
  if (mode !== 'locci' && mode !== 'off') throw new Error(`AUTH must be locci or off (got "${mode}")`);
  return {
    mode,
    issuer: (env.LOCCI_AUTH_URL ?? 'https://auth.locci.cloud').replace(/\/+$/, ''),
    clientId: env.AUTH_CLIENT_ID ?? 'locci-ai-chat',
  };
}

/** Middleware putting the caller on res.locals.user; with AUTH=locci, 401 without a valid token. */
export function withUser(config: AuthConfig) {
  const client = config.mode === 'locci' ? createClient({ clientID: 'locci-ai-api', issuer: config.issuer }) : null;
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!client) {
      res.locals.user = ANONYMOUS;
      return next();
    }
    const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const verified = token ? await client.verify(subjects, token).catch(() => null) : null;
    if (!token || !verified || verified.err) {
      res.status(401).json({ error: 'Sign in required' });
      return;
    }
    const { id, email } = verified.subject.properties;
    res.locals.user = { id, email, token } satisfies User;
    next();
  };
}

export const userOf = (res: Response): User => (res.locals.user as User | undefined) ?? ANONYMOUS;
