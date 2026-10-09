import type { LanguageModelMiddleware, UIMessage } from 'ai';

/**
 * Keeps a web conversation inside the model's context window.
 *
 * The local models get 8192 tokens per request, and about 2,600 of those are
 * the system prompt and tool schemas. A pasted document or a long history can
 * blow past that (a SvelteKit docs page is ~31k tokens), which llama.cpp
 * rejects outright. The budget is in characters, a cheap stand-in for tokens:
 * code and markdown run about 2.5 characters per token.
 *
 * Order of cuts, cheapest loss first:
 *  1. The latest user message's largest parts (pasted text, attached files)
 *     are shortened to three quarters of the budget, with a note saying so.
 *  2. The oldest turns are dropped until the rest fits.
 *  3. Anything still over is shortened, largest part first.
 * The UI keeps the full text; only what the model sees is cut.
 */

type Part = UIMessage['parts'][number];

const KEEP_AT_LEAST = 500;
const ATTACHMENT = /^(<attachment name="[^"]*">\n?)([\s\S]*?)(\n?<\/attachment>)$/;

function lastUserIndex(messages: UIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
  return -1;
}

function partSize(part: Part): number {
  if (part.type === 'text' || part.type === 'reasoning') return part.text.length;
  if (part.type.startsWith('tool-') || part.type === 'dynamic-tool') {
    const p = part as { input?: unknown; output?: unknown };
    return JSON.stringify(p.input ?? null).length + JSON.stringify(p.output ?? null).length;
  }
  return 0;
}

function messageSize(message: UIMessage): number {
  return message.parts.reduce((n, p) => n + partSize(p), 0);
}

/** Shorten a text part by `cut` characters, keeping attachment tags intact. */
function shorten(part: Part, cut: number): Part {
  if (part.type !== 'text') return part;
  const match = part.text.match(ATTACHMENT);
  const [head, body, tail] = match ? [match[1], match[2], match[3]] : ['', part.text, ''];
  const keep = Math.max(KEEP_AT_LEAST, body.length - cut);
  if (keep >= body.length) return part;
  const note = `\n[Truncated: the remaining ${body.length - keep} characters were cut to fit the model's context.]`;
  return { ...part, text: `${head}${body.slice(0, keep)}${note}${tail}` };
}

/** Shorten the largest text parts of one message until it is at most `limit`. */
function shrinkMessage(message: UIMessage, limit: number): UIMessage {
  const parts = [...message.parts];
  let over = parts.reduce((n, p) => n + partSize(p), 0) - limit;
  while (over > 0) {
    let largest = -1;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.type === 'text' && p.text.length > KEEP_AT_LEAST + 200) {
        if (largest === -1 || partSize(p) > partSize(parts[largest])) largest = i;
      }
    }
    if (largest === -1) break;
    const before = partSize(parts[largest]);
    parts[largest] = shorten(parts[largest], over);
    const saved = before - partSize(parts[largest]);
    if (saved <= 0) break;
    over -= saved;
  }
  return { ...message, parts };
}

/**
 * The web client sends attached files and long pastes as
 * `<attachment name="x.md">...</attachment>` text parts. Small models with file
 * tools read that name as a path and try to open it (filesystem MCP: ENOENT),
 * so spell out that the contents are right here.
 */
export function inlineAttachments(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user') return message;
    const attached: Part[] = [];
    const rest: Part[] = [];
    for (const part of message.parts) {
      const match = part.type === 'text' ? part.text.match(ATTACHMENT) : null;
      if (!match || part.type !== 'text') {
        rest.push(part);
        continue;
      }
      const name = match[1].slice('<attachment name="'.length, match[1].indexOf('">'));
      // A paste has no meaningful file name, and a ".md" name invites the model
      // to "open" it; real files keep theirs as a label.
      const label = name.startsWith('Pasted text') ? 'Text the user pasted' : `Contents of the user's file ${name}`;
      attached.push({ ...part, text: `${label}:\n"""\n${match[2]}\n"""` });
    }
    if (attached.length === 0) return message;
    // Material first, the user's request last: small models follow the end of
    // the message, so the question should come after the document, not before it.
    const ask = rest.length > 0 ? rest : [{ type: 'text' as const, text: 'Please look at the text above.' }];
    return { ...message, parts: [...attached, ...ask] };
  });
}

/** An assistant reply that is only a tool call written out as text. */
const PRINTED_TOOL_CALL =
  /^\s*(<tool_call>\s*)?\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:[\s\S]*\}\s*(<\/tool_call>\s*)?$/;

function isPrintedToolCall(message: UIMessage): boolean {
  const texts = message.parts.filter((p) => p.type === 'text');
  return message.role === 'assistant' && texts.length > 0 && texts.every((p) => PRINTED_TOOL_CALL.test(p.text));
}

/**
 * Small models sometimes print a tool call as plain text instead of making it.
 * Left in the history, the model copies that pattern on later turns, so the
 * whole exchange (the reply and the question it failed to answer) is left out
 * of what the model sees. Dropping only the reply would leave two user turns in
 * a row, which confuses it just as much. The UI still shows both.
 */
export function dropPrintedToolCalls(messages: UIMessage[]): UIMessage[] {
  const drop = new Set<number>();
  messages.forEach((m, i) => {
    // Never the latest turn: that is the one being answered now.
    if (i === messages.length - 1 || !isPrintedToolCall(m)) return;
    drop.add(i);
    if (messages[i - 1]?.role === 'user') drop.add(i - 1);
  });
  return drop.size === 0 ? messages : messages.filter((_, i) => !drop.has(i));
}

export interface FitResult {
  messages: UIMessage[];
  /** Characters removed or messages dropped, for logging. */
  trimmed: boolean;
}

export function fitToContext(messages: UIMessage[], maxChars: number): FitResult {
  if (messages.length === 0) return { messages, trimmed: false };
  let fitted = [...messages];
  const total = () => fitted.reduce((n, m) => n + messageSize(m), 0);
  if (total() <= maxChars) return { messages, trimmed: false };

  const lastUser = lastUserIndex(fitted);
  if (lastUser !== -1) fitted[lastUser] = shrinkMessage(fitted[lastUser], Math.floor(maxChars * 0.75));

  // Drop the oldest turns, never the latest user message or anything after it.
  while (total() > maxChars && fitted.length > 1 && lastUserIndex(fitted) > 0) {
    fitted = fitted.slice(1);
  }

  if (total() > maxChars) {
    const last = fitted.length - 1;
    const others = total() - messageSize(fitted[last]);
    fitted[last] = shrinkMessage(fitted[last], Math.max(KEEP_AT_LEAST, maxChars - others));
  }
  return { messages: fitted, trimmed: true };
}

// --- Overflow retry ----------------------------------------------------------
// The character budget above is an estimate, and dense code or JSON can run
// 1.5 characters per token, so a request can still overflow. llama.cpp says by
// how much ("request (8334 tokens) exceeds the available context size (8192
// tokens)"), and rejects before generating anything, so the model call is
// retried once with the prompt's largest parts shortened by that excess. This
// also covers tool results added mid-answer (a large file read over MCP).

const OVERFLOW = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/;
/** Upper bound for text, so one retry cuts enough. */
const RETRY_CHARS_PER_TOKEN = 4;
const RETRY_KEEP = 300;

type PromptPart = { type: string; text?: string; output?: { type: string; value: unknown } };
type PromptMessage = { role: string; content: string | PromptPart[] };

function errorText(error: unknown): string {
  const e = error as { message?: string; responseBody?: string } | undefined;
  return `${e?.responseBody ?? ''} ${e?.message ?? String(error)}`;
}

/** Text a part carries (message text, or a tool result), as a mutable slot. */
function slots(prompt: PromptMessage[]): { get: () => string; set: (t: string) => void }[] {
  const out: { get: () => string; set: (t: string) => void }[] = [];
  for (const message of prompt) {
    if (typeof message.content === 'string') continue; // the system prompt stays whole
    for (const part of message.content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        out.push({ get: () => part.text ?? '', set: (t) => (part.text = t) });
      } else if (part.type === 'tool-result' && part.output) {
        const output = part.output;
        out.push({
          get: () => (typeof output.value === 'string' ? output.value : JSON.stringify(output.value ?? null)),
          set: (t) => {
            part.output = { type: output.type === 'error-text' ? 'error-text' : 'text', value: t };
          },
        });
      }
    }
  }
  return out;
}

/** A copy of the prompt with its largest text parts shortened by `cut` characters in total. */
export function shrinkPrompt<T>(prompt: T, cut: number): T {
  const copy = structuredClone(prompt) as unknown as PromptMessage[];
  const all = slots(copy);
  let left = cut;
  while (left > 0) {
    const largest = all.reduce((a, b) => (b.get().length > (a?.get().length ?? -1) ? b : a), all[0]);
    const text = largest?.get() ?? '';
    if (!largest || text.length <= RETRY_KEEP + 100) break;
    const keep = Math.max(RETRY_KEEP, text.length - left);
    largest.set(`${text.slice(0, keep)}\n[Truncated: ${text.length - keep} characters cut to fit the model's context.]`);
    left -= text.length - keep;
  }
  return copy as unknown as T;
}

/** Model middleware: on a context-size rejection, shorten the prompt and retry once. */
export function overflowRetry(answerTokens: number, tag = ''): LanguageModelMiddleware {
  return {
    wrapStream: async ({ doStream, params, model }) => {
      try {
        return await doStream();
      } catch (error) {
        const match = OVERFLOW.exec(errorText(error));
        if (!match) throw error;
        const used = Number(match[1]);
        const window = Number(match[2]);
        const cut = Math.ceil((used - (window - answerTokens)) * RETRY_CHARS_PER_TOKEN);
        console.log(`  ${tag}[context] model rejected ${used} tokens (window ${window}); cutting ${cut} characters and retrying`);
        return model.doStream({ ...params, prompt: shrinkPrompt(params.prompt, cut) });
      }
    },
  };
}
