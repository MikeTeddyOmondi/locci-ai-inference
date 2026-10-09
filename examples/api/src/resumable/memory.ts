import type { Owner, Recorder, ResumableStreams, StartResult, StreamKey } from './index.js';

/** How long a finished reply stays replayable, for a refresh that races its end. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;

interface Recording {
  requestId: string;
  messageId: string;
  chunks: string[];
  done: boolean;
  /** Readers waiting for the next chunk. */
  waiting: Set<() => void>;
}

/** Recordings in the API process: one per owner's thread, the latest reply. */
export class MemoryStreams implements ResumableStreams {
  readonly name = 'memory';
  private recordings = new Map<string, Recording>();

  async start({ owner, threadId, requestId, messageId }: StreamKey): Promise<StartResult> {
    const key = keyOf(owner, threadId);
    const existing = this.recordings.get(key);
    if (existing?.requestId === requestId) {
      return existing.messageId === messageId ? { kind: 'replay', stream: replay(existing) } : { kind: 'conflict' };
    }
    // A new turn. Readers of the old one are told it ended.
    if (existing) end(existing);
    const recording: Recording = { requestId, messageId, chunks: [], done: false, waiting: new Set() };
    this.recordings.set(key, recording);
    const recorder: Recorder = {
      append: async (chunk) => {
        if (recording.done) return;
        recording.chunks.push(chunk);
        wake(recording);
      },
      finish: async () => {
        end(recording);
        setTimeout(() => {
          if (this.recordings.get(key) === recording) this.recordings.delete(key);
        }, KEEP_FINISHED_MS).unref();
      },
    };
    return { kind: 'new', recorder };
  }

  async resume(owner: Owner, threadId: string): Promise<ReadableStream<string> | null> {
    const recording = this.recordings.get(keyOf(owner, threadId));
    return recording ? replay(recording) : null;
  }
}

/** Thread ids come from the client, so recordings are kept apart per owner. */
const keyOf = (owner: Owner, threadId: string) => `${owner.id}\n${threadId}`;

function wake(recording: Recording) {
  for (const resolve of recording.waiting) resolve();
  recording.waiting.clear();
}

function end(recording: Recording) {
  recording.done = true;
  wake(recording);
}

/** Every chunk so far, then each new one as it arrives, until the reply ends. */
function replay(recording: Recording): ReadableStream<string> {
  let next = 0;
  return new ReadableStream<string>({
    async pull(controller) {
      while (next >= recording.chunks.length && !recording.done) {
        await new Promise<void>((resolve) => recording.waiting.add(resolve));
      }
      if (next < recording.chunks.length) controller.enqueue(recording.chunks[next++]);
      else controller.close();
    },
  });
}
