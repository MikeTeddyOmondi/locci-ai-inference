import type { Owner, Recorder, ResumableStreams, StartResult, StreamKey } from './index.js';

// Recordings in Ursula (the append-only stream store Locci Cloud uses for build
// logs), reached through this repo's KrakenD at /v1/streams. KrakenD checks the
// caller's token and names every stream after its subject (<sub>--<name>) in
// the `chats` bucket, then forwards to Ursula: this repo's compose service
// locally (`just ursula-up`, no published port, Ursula has no auth), the
// events.locci.cloud gateway in production, which checks the token again.
//
// The production gateway allows no DELETE, so nothing is ever replaced. Per thread:
//   <threadId>              one line per turn: {"requestId":"...","messageId":"..."}
//   <threadId>.<requestId>  that turn's reply: the SSE text sent to the browser,
//                           then `: locci-end` when the reply ended
// The last index line is the reply to resume; any line answers a repeated
// request. Neither id can contain a dot (THREAD_ID, pickRequestId).
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

type Turn = { requestId: string; messageId: string };

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

  /**
   * A request to KrakenD. With a signed-in owner it carries their token, so
   * the gateway files the stream under them; otherwise (AUTH=off) the API's
   * own Locci token, retried once with a fresh one on 401.
   */
  private async call(path: string, init: RequestInit = {}, owner?: Owner): Promise<Response> {
    const send = async (force: boolean) =>
      fetch(`${this.base}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${owner?.token ?? (await this.token(force))}`,
        },
      });
    const res = await send(false);
    return res.status === 401 && !owner?.token ? send(true) : res;
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

  private path(name: string) {
    return `/${encodeURIComponent(name)}`;
  }

  private async create(owner: Owner, name: string) {
    const res = await this.call(this.path(name), { method: 'PUT' }, owner);
    if (!res.ok && res.status !== 409) throw new Error(`Ursula: creating stream ${name} failed (HTTP ${res.status})`);
  }

  /** The thread's turns, oldest first; none if the thread was never recorded. */
  private async turns(owner: Owner, threadId: string): Promise<Turn[]> {
    const res = await this.call(`${this.path(threadId)}?offset=-1`, {}, owner);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Ursula: reading thread ${threadId} failed (HTTP ${res.status})`);
    return (await res.text()).split('\n').flatMap((line) => {
      const turn = parseTurn(line);
      return turn ? [turn] : [];
    });
  }

  async start({ owner, threadId, requestId, messageId }: StreamKey): Promise<StartResult> {
    await this.ensureBucket();
    const reply = `${threadId}.${requestId}`;
    const earlier = (await this.turns(owner, threadId)).find((turn) => turn.requestId === requestId);
    if (earlier) {
      if (earlier.messageId !== messageId) return { kind: 'conflict' };
      const stream = await this.follow(owner, reply);
      if (stream) return { kind: 'replay', stream };
    }

    // The reply stream exists before the index names it, so a resume that
    // finds this turn always finds its stream (empty at first, then live).
    await this.create(owner, reply);
    await this.create(owner, threadId);
    if (!earlier) {
      const res = await this.call(this.path(threadId), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: `${JSON.stringify({ requestId, messageId })}\n`,
      }, owner);
      if (!res.ok) throw new Error(`Ursula: recording turn for thread ${threadId} failed (HTTP ${res.status})`);
    }
    return { kind: 'new', recorder: this.recorder(owner, reply) };
  }

  /**
   * Appends, batched. Never throws: if Ursula fails mid-reply the chat carries
   * on unrecorded rather than breaking.
   */
  private recorder(owner: Owner, name: string): Recorder {
    let pending = '';
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
          const res = await this.call(this.path(name), {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body,
          }, owner);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (error) {
          failed = true;
          console.error(`[ursula] recording ${name} stopped:`, error instanceof Error ? error.message : error);
        }
      });
      return chain;
    };

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

  async resume(owner: Owner, threadId: string): Promise<ReadableStream<string> | null> {
    const latest = (await this.turns(owner, threadId)).at(-1);
    return latest ? this.follow(owner, `${threadId}.${latest.requestId}`) : null;
  }

  /** A reply stream from its start, then live until its end marker; null if it does not exist. */
  private async follow(owner: Owner, name: string): Promise<ReadableStream<string> | null> {
    const first = await this.call(`${this.path(name)}?offset=-1`, {}, owner);
    if (first.status === 404) return null;
    if (!first.ok) throw new Error(`Ursula: reading ${name} failed (HTTP ${first.status})`);

    let offset = first.headers.get('stream-next-offset');
    let body: string | null = await first.text();
    let carry = '';
    let done = false;
    let lastData = Date.now();
    const abort = new AbortController();

    /** Turn raw stream text into what the browser gets: nothing from the end marker on. */
    const take = (text: string): string => {
      const out = carry + text;
      carry = '';
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
              console.log(`  [ursula] ${name}: no new data for ${IDLE_MS / 1000}s, ending the replay`);
              return controller.close();
            }
            const res = await this.call(`${this.path(name)}?offset=${encodeURIComponent(offset)}&live=long-poll`, {
              signal: abort.signal,
            }, owner);
            if (res.status === 404) return controller.close();
            if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
            offset = res.headers.get('stream-next-offset') ?? offset;
            body = res.status === 204 ? null : await res.text();
            if (body) lastData = Date.now();
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            console.error(`[ursula] reading ${name}:`, error instanceof Error ? error.message : error);
          }
          controller.close();
        }
      },
      cancel: () => abort.abort(),
    });
  }
}

function parseTurn(line: string): Turn | null {
  try {
    const turn = JSON.parse(line) as Partial<Turn>;
    return typeof turn.requestId === 'string' && typeof turn.messageId === 'string'
      ? { requestId: turn.requestId, messageId: turn.messageId }
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
