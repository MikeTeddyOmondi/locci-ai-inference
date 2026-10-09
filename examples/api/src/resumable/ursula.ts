import type { Recorder, ResumableStreams, StartResult, StreamKey } from './index.js';

// Recordings in Ursula (the append-only stream store Locci Cloud uses for build
// logs), reached through this repo's KrakenD at /v1/streams. KrakenD checks the
// caller's token and names the stream after its subject, so tenants cannot read
// each other's chats; Ursula itself has no auth and no published port.
//
// One stream per thread holds its latest reply:
//   {"requestId":"...","messageId":"..."}\n   who the reply belongs to
//   data: {...}\n\n ...                          the SSE text sent to the browser
//   : locci-end\n\n                              the reply ended
//
// Reading uses a catch-up GET and then long-polls from the returned
// Stream-Next-Offset. Ursula's live SSE mode would be one request, but KrakenD
// CE holds a streamed GET until roughly 4 KB has built up, while each long-poll
// completes on its own.

const END = ': locci-end\n\n';
/** Batch small SSE chunks into one append; a reply has hundreds of them. */
const FLUSH_MS = 50;
const FLUSH_BYTES = 16 * 1024;
const TOKEN_SKEW_MS = 60_000;
/**
 * A recording that gets nothing new for this long is treated as over: the API
 * that wrote it died mid-reply and no end marker will come. Longer than the
 * 70 to 90 s a large prompt can take before its first token.
 */
const IDLE_MS = 120_000;

type Header = { requestId: string; messageId: string };

export class UrsulaStreams implements ResumableStreams {
  readonly name = 'ursula';
  private bucket: Promise<void> | null = null;

  constructor(
    private base: string,
    private token: (force?: boolean) => Promise<string>,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv): UrsulaStreams {
    const base = (env.URSULA_URL ?? 'http://localhost:8080/v1/streams').replace(/\/+$/, '');
    return new UrsulaStreams(base, locciToken(env));
  }

  /** A request to KrakenD with the Locci token, retried once with a fresh token on 401. */
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (force: boolean) =>
      fetch(`${this.base}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await this.token(force)}` },
      });
    const res = await send(false);
    return res.status === 401 ? send(true) : res;
  }

  private ensureBucket(): Promise<void> {
    this.bucket ??= this.call('', { method: 'PUT' }).then((res) => {
      if (!res.ok && res.status !== 409) {
        this.bucket = null;
        throw new Error(`Ursula: creating the bucket failed (HTTP ${res.status})`);
      }
    });
    return this.bucket;
  }

  private path(threadId: string) {
    return `/${encodeURIComponent(threadId)}`;
  }

  async start({ threadId, requestId, messageId }: StreamKey): Promise<StartResult> {
    await this.ensureBucket();
    const existing = await this.call(`${this.path(threadId)}?offset=-1`);
    if (existing.ok) {
      const header = parseHeader(await existing.text());
      if (header?.requestId === requestId) {
        if (header.messageId !== messageId) return { kind: 'conflict' };
        const stream = await this.resume(threadId);
        if (stream) return { kind: 'replay', stream };
      }
    } else if (existing.status !== 404) {
      throw new Error(`Ursula: reading thread ${threadId} failed (HTTP ${existing.status})`);
    }

    // A new turn replaces the thread's recording.
    await this.call(this.path(threadId), { method: 'DELETE' });
    const created = await this.call(this.path(threadId), { method: 'PUT' });
    if (!created.ok && created.status !== 409) throw new Error(`Ursula: creating the stream failed (HTTP ${created.status})`);
    return { kind: 'new', recorder: this.recorder(threadId, `${JSON.stringify({ requestId, messageId })}\n`) };
  }

  /**
   * Appends, batched. Never throws: if Ursula fails mid-reply the chat carries
   * on unrecorded rather than breaking.
   */
  private recorder(threadId: string, header: string): Recorder {
    let pending = header;
    let timer: NodeJS.Timeout | undefined;
    let chain = Promise.resolve();
    let failed = false;

    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      const body = pending;
      pending = '';
      if (!body || failed) return chain;
      chain = chain.then(async () => {
        try {
          const res = await this.call(this.path(threadId), {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (error) {
          failed = true;
          console.error(`[ursula] recording thread ${threadId} stopped:`, error instanceof Error ? error.message : error);
        }
      });
      return chain;
    };
    // The header goes out at once, so a resume right away finds the stream.
    void flush();

    return {
      append: async (chunk) => {
        pending += chunk;
        if (pending.length >= FLUSH_BYTES) void flush();
        else timer ??= setTimeout(() => void flush(), FLUSH_MS);
      },
      finish: async () => {
        pending += END;
        await flush();
      },
    };
  }

  async resume(threadId: string): Promise<ReadableStream<string> | null> {
    const first = await this.call(`${this.path(threadId)}?offset=-1`);
    if (first.status === 404) return null;
    if (!first.ok) throw new Error(`Ursula: reading thread ${threadId} failed (HTTP ${first.status})`);

    let offset = first.headers.get('stream-next-offset');
    let body: string | null = await first.text();
    let headerSeen = false;
    let carry = '';
    let done = false;
    let lastData = Date.now();
    const abort = new AbortController();

    /** Turn raw stream text into what the browser gets: no header line, nothing from the end marker on. */
    const take = (text: string): string => {
      let out = carry + text;
      carry = '';
      if (!headerSeen) {
        const newline = out.indexOf('\n');
        if (newline === -1) {
          carry = out;
          return '';
        }
        headerSeen = true;
        out = out.slice(newline + 1);
      }
      const end = out.indexOf(END);
      if (end !== -1) {
        done = true;
        return out.slice(0, end);
      }
      // Hold back a possible start of the marker split across reads.
      const keep = Math.min(out.length, END.length - 1);
      carry = out.slice(out.length - keep);
      return out.slice(0, out.length - keep);
    };

    return new ReadableStream<string>({
      pull: async (controller) => {
        try {
          while (true) {
            if (body !== null) {
              const text = take(body);
              body = null;
              if (text) controller.enqueue(text);
              if (done) return controller.close();
              if (text) return;
              continue;
            }
            if (done || !offset) return controller.close();
            if (Date.now() - lastData > IDLE_MS) {
              console.log(`  [ursula] thread ${threadId}: no new data for ${IDLE_MS / 1000}s, ending the replay`);
              return controller.close();
            }
            const res = await this.call(`${this.path(threadId)}?offset=${encodeURIComponent(offset)}&live=long-poll`, {
              signal: abort.signal,
            });
            // The thread moved on to a new turn (stream deleted): this reply is over.
            if (res.status === 404) return controller.close();
            if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
            offset = res.headers.get('stream-next-offset') ?? offset;
            body = res.status === 204 ? null : await res.text();
            if (body) lastData = Date.now();
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            console.error(`[ursula] reading thread ${threadId}:`, error instanceof Error ? error.message : error);
          }
          controller.close();
        }
      },
      cancel: () => abort.abort(),
    });
  }
}

function parseHeader(text: string): Header | null {
  try {
    const header = JSON.parse(text.slice(0, text.indexOf('\n'))) as Partial<Header>;
    return typeof header.requestId === 'string' && typeof header.messageId === 'string'
      ? { requestId: header.requestId, messageId: header.messageId }
      : null;
  } catch {
    return null;
  }
}

/**
 * A Locci access token for KrakenD, as the gateway calls use: LOCCI_ACCESS_TOKEN
 * as-is, or LOCCI_API_KEY exchanged at locci-auth's /keys/token and cached
 * until shortly before it expires (the same exchange @locci/ai-sdk does).
 */
function locciToken(env: NodeJS.ProcessEnv): (force?: boolean) => Promise<string> {
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  return async (force = false) => {
    if (env.LOCCI_ACCESS_TOKEN) return env.LOCCI_ACCESS_TOKEN;
    if (!env.LOCCI_API_KEY) throw new Error('RESUMABLE_STREAMS=ursula needs LOCCI_API_KEY or LOCCI_ACCESS_TOKEN');
    if (!force && cached && cached.expiresAt > Date.now()) return cached.token;
    pending ??= (async () => {
      const authURL = (env.LOCCI_AUTH_URL ?? 'https://auth.locci.cloud').replace(/\/+$/, '');
      const res = await fetch(`${authURL}/keys/token`, { method: 'POST', headers: { 'x-locci-api-key': env.LOCCI_API_KEY! } });
      if (!res.ok) throw new Error(`Locci API key exchange failed (HTTP ${res.status})`);
      const body = (await res.json()) as { token?: string; expiresIn?: number };
      if (!body.token) throw new Error('Locci API key exchange returned no token');
      cached = { token: body.token, expiresAt: Date.now() + (body.expiresIn ?? 3600) * 1000 - TOKEN_SKEW_MS };
      return body.token;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
