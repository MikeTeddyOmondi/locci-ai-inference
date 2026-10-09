import { MemoryStreams } from './memory.js';

// Resumable web chat replies. /api/chat records the UI message stream (the SSE
// text the browser receives) per thread while it is sent, so a browser that
// refreshes mid-reply can replay it from the start and follow it live
// (GET /api/chat/:threadId/stream, which the AI SDK's chat.resumeStream()
// calls). The recording also makes a send idempotent: it starts with the
// request id, and the same request arriving twice is answered from the
// recording instead of calling the model again.
//
// RESUMABLE_STREAMS picks the store:
//   memory (default)  in the API process; lost on restart, one instance only
//   off               nothing recorded; /api/chat behaves as it always did

/** Identifies one send: the chat, this request, and the user message it answers. */
export interface StreamKey {
  threadId: string;
  requestId: string;
  messageId: string;
}

export interface Recorder {
  /** Append the next piece of SSE text, exactly as sent to the browser. */
  append(chunk: string): Promise<void>;
  /** The reply ended (finished, failed or stopped). */
  finish(): Promise<void>;
}

export type StartResult =
  /** A new turn: record it with this. */
  | { kind: 'new'; recorder: Recorder }
  /** This request was already received: its recording, from the start. */
  | { kind: 'replay'; stream: ReadableStream<string> }
  /** This request id was already used for a different message. */
  | { kind: 'conflict' };

export interface ResumableStreams {
  readonly name: string;
  /** Begin a reply for a thread. A new request id replaces the thread's earlier recording. */
  start(key: StreamKey): Promise<StartResult>;
  /** The thread's latest reply, replayed from its start then followed live; null if there is none. */
  resume(threadId: string): Promise<ReadableStream<string> | null>;
}

/** The configured store, or null when RESUMABLE_STREAMS=off. */
export async function resumableStreams(env = process.env): Promise<ResumableStreams | null> {
  const choice = (env.RESUMABLE_STREAMS ?? 'memory').toLowerCase();
  if (choice === 'off') return null;
  if (choice === 'memory') return new MemoryStreams();
  throw new Error(`RESUMABLE_STREAMS must be memory or off (got "${choice}")`);
}

/** Thread ids come from the client and end up in URLs and keys. */
export const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;
