// The conversation loop shared by `locci-chat chat` and the TUI: post to the
// API's /chat, read its NDJSON events, and when the model calls a client tool
// (`shell`, `read_file`, `write_file`), run it here, in the start folder, once
// approved, and post again with the result.

import { authHeaders, explain401 } from './auth.js';
import { applyEdit, exists, planEdit, readTool, unchanged, writeTool } from './files.js';
import { describeResult, runShell } from './shell.js';

/** The client tools `chat` and the TUI run. */
const CLIENT_TOOLS = ['shell', 'read_file', 'write_file', 'edit_file'];

/** What needs a yes first. Reads don't: they stay inside the folder. */
export type Action =
  | { kind: 'shell'; command: string }
  | { kind: 'write'; path: string; content: string; creates: boolean }
  | { kind: 'edit'; path: string; find: string; replace: string; count: number };

/** The result the model gets for a declined action starts with this. */
export const DECLINED_PREFIX = 'The user declined';

export const API = process.env.API_URL ?? 'http://localhost:3939';

/**
 * An AI SDK ModelMessage, kept loose: the CLI only builds plain user text and
 * `tool` results, and appends the assistant's messages as the API sent them.
 */
export type Msg = { role: 'user' | 'assistant' | 'tool'; content: unknown };

/** One parsed NDJSON event from POST /chat?events=1. */
export type ChatEvent =
  | { t: 'text'; v?: string }
  | { t: 'tool'; id: string; name?: string; title?: string }
  | { t: 'tool-input'; id: string; input?: unknown }
  | {
      t: 'tool-call';
      id: string;
      name: string;
      input?: { command?: string; path?: string; content?: string; old_text?: string; new_text?: string; all?: boolean };
    }
  | { t: 'tool-done'; id: string; output?: string; error?: string }
  | { t: 'finish'; reason?: string; usage?: Record<string, unknown> }
  | { t: 'thinking' }
  /** Keep-alive while a long prompt is read; nothing to show. */
  | { t: 'ping' }
  | { t: 'messages'; v: Msg[] }
  | { t: 'error'; v?: string };

/** Rounds of "model asks, CLI runs, model reads" in one turn, as the API's own tool loop. */
const MAX_ROUNDS = 8;

/**
 * POST the conversation and call onEvent for each NDJSON line. Shared by
 * `chat` and `ask`, so both read the stream the same way.
 */
export async function streamChat(
  body: {
    messages: Msg[];
    system?: string;
    model?: string;
    reasoning?: boolean;
    clientTools?: string[];
    cwd?: string;
    platform?: string;
    warm?: boolean;
  },
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API}/chat?events=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${errText}${explain401(res.status)}`.trim());
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // NDJSON: whole lines only, keep the remainder for the next read.
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as ChatEvent);
      } catch {
        // a malformed line shouldn't kill the stream
      }
    }
  }
}

export interface TurnOptions {
  system?: string;
  /** A model other than the API's default (one /models offers). */
  model?: string;
  /** Let the model think first; unset leaves it to the API, which knows which models it helps. */
  reasoning?: boolean;
  /** Offer the client tools, run in `cwd`. */
  shell: boolean;
  cwd: string;
  /** Ask before a command or a write; resolves true to go ahead. */
  approve: (action: Action) => Promise<boolean>;
  /** Show a tool's result (the model gets the full, capped text). */
  onToolResult?: (call: { id: string; name: string; label: string }, result: string) => void;
}

/** An edit for the approval prompt: the old text as `- ` lines, the new as `+ ` lines. */
export function editPreview(action: Extract<Action, { kind: 'edit' }>, max = 8): string[] {
  const side = (mark: string, text: string) => {
    const lines = text.split('\n');
    const shown = lines.slice(0, max).map((l) => `${mark} ${l}`);
    if (lines.length > max) shown.push(`${mark} … ${lines.length - max} more lines`);
    return shown;
  };
  return [...side('-', action.find), ...side('+', action.replace)];
}

/** A one-line label for a client tool call, for the terminal. */
export function toolLabel(name: string, input: { command?: string; path?: string } | undefined): string {
  if (name === 'shell') return `$ ${input?.command ?? ''}`;
  if (name === 'read_file') return `read ${input?.path ?? ''}`;
  if (name === 'write_file') return `write ${input?.path ?? ''}`;
  if (name === 'edit_file') return `edit ${input?.path ?? ''}`;
  return name;
}

/** Run one client tool call, asking first where it needs it. */
async function runClientTool(
  call: Extract<ChatEvent, { t: 'tool-call' }>,
  opts: TurnOptions,
  signal?: AbortSignal,
): Promise<string> {
  const input = call.input ?? {};
  switch (call.name) {
    case 'shell': {
      const command = input.command?.trim();
      if (!command) return 'Empty command: nothing was run.';
      if (!(await opts.approve({ kind: 'shell', command }))) {
        return `${DECLINED_PREFIX} to run this command. It was not run.`;
      }
      return describeResult(await runShell(command, opts.cwd, signal));
    }
    case 'read_file':
      return input.path ? readTool(opts.cwd, input.path) : 'No path given.';
    case 'write_file': {
      if (!input.path || typeof input.content !== 'string') return 'write_file needs a path and the content.';
      const same = await unchanged(opts.cwd, input.path, input.content);
      if (same) return same;
      const creates = !(await exists(opts.cwd, input.path));
      if (!(await opts.approve({ kind: 'write', path: input.path, content: input.content, creates }))) {
        return `${DECLINED_PREFIX} this write. ${input.path} was not changed.`;
      }
      return writeTool(opts.cwd, input.path, input.content);
    }
    case 'edit_file': {
      if (!input.path || typeof input.old_text !== 'string' || typeof input.new_text !== 'string') {
        return 'edit_file needs a path, old_text and new_text.';
      }
      // Checked before asking: an edit that can't apply goes straight back to the model.
      const plan = await planEdit(opts.cwd, input.path, input.old_text, input.new_text, input.all === true);
      if (!plan.ok) return plan.error;
      const action: Action = { kind: 'edit', path: input.path, find: input.old_text, replace: input.new_text, count: plan.count };
      if (!(await opts.approve(action))) return `${DECLINED_PREFIX} this edit. ${input.path} was not changed.`;
      return applyEdit(input.path, plan);
    }
    default:
      return `Unknown tool: ${call.name}`;
  }
}

/** What every request of a chat shares: the same system prompt and tools, so the prompt cache holds. */
function requestFor(opts: Pick<TurnOptions, 'system' | 'model' | 'reasoning' | 'shell' | 'cwd'>) {
  return {
    system: opts.system,
    model: opts.model,
    reasoning: opts.reasoning,
    ...(opts.shell ? { clientTools: CLIENT_TOOLS, cwd: opts.cwd, platform: process.platform } : {}),
  };
}

/**
 * Have the model read this chat's system prompt and tools (about 1,200 tokens,
 * some 15 s on CPU) while the user types: llama.cpp keeps them in its prompt
 * cache, so the first message only reads its own tokens. Never throws; a chat
 * started meanwhile awaits it, so it lands on the warmed slot.
 */
export async function warmUp(opts: Pick<TurnOptions, 'system' | 'model' | 'reasoning' | 'shell' | 'cwd'>): Promise<void> {
  try {
    await streamChat({ messages: [{ role: 'user', content: '.' }], ...requestFor(opts), warm: true }, () => {});
  } catch {
    // Only a head start: a failure shows on the first real message instead.
  }
}

/** What the model is told about a reply or a tool the user stopped (Esc). */
export const STOPPED = '[stopped by the user]';

const isAbort = (err: unknown) => (err as Error)?.name === 'AbortError';
const aborted = () => Object.assign(new Error('stopped'), { name: 'AbortError' });

/** How much of an older tool result, or of a file an older call wrote, is sent again. */
const OLD_RESULT_CHARS = 600;
/**
 * Below this size (about 15k tokens, half of Gemma's 32768) the history goes
 * as it is. Changing an earlier message makes the model re-read everything
 * after it (llama.cpp reuses only an unchanged prefix of the prompt), so
 * trimming early costs more time than it saves.
 */
const TRIM_ABOVE_CHARS = Number(process.env.LOCCI_TRIM_ABOVE_CHARS) || 60_000;
const shorten = (text: string) =>
  text.length <= OLD_RESULT_CHARS
    ? text
    : `${text.slice(0, OLD_RESULT_CHARS)}\n[... ${text.length - OLD_RESULT_CHARS} characters left out to save room; read the file or run the command again to see it]`;

type Part = { type?: string; input?: Record<string, unknown>; output?: { type?: string; value?: unknown } };

/**
 * The history as sent. Once it is long, everything before the latest tool
 * results is cut down (results and written file contents shortened, earlier
 * thinking dropped), so a long agent session fits a small model's context;
 * `messages` keeps it all.
 */
export function forModel(messages: Msg[]): Msg[] {
  if (JSON.stringify(messages).length <= TRIM_ABOVE_CHARS) return messages;
  let recent = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      recent = Math.max(0, i - 1); // its assistant message with the calls
      break;
    }
  }
  return messages.map((m, i) => {
    if (i >= recent || !Array.isArray(m.content)) return m;
    if (m.role === 'tool') {
      return {
        ...m,
        content: (m.content as Part[]).map((p) =>
          p.output?.type === 'text' && typeof p.output.value === 'string' ? { ...p, output: { ...p.output, value: shorten(p.output.value) } } : p,
        ),
      };
    }
    if (m.role === 'assistant') {
      return {
        ...m,
        content: (m.content as Part[])
          .filter((p) => p.type !== 'reasoning')
          .map((p) =>
            p.type === 'tool-call' && p.input
              ? { ...p, input: Object.fromEntries(Object.entries(p.input).map(([k, v]) => [k, typeof v === 'string' ? shorten(v) : v])) }
              : p,
          ),
      };
    }
    return m;
  });
}

/**
 * One user turn: post, and while the model calls client tools, run them (once
 * approved), append the results and post again. Appends everything to
 * `messages`, so the history holds the calls and results as the model saw them.
 */

export async function runTurn(
  messages: Msg[],
  opts: TurnOptions,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let retried = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const calls: Extract<ChatEvent, { t: 'tool-call' }>[] = [];
    let reply: Msg[] | undefined;
    let text = '';
    let failed = false;
    try {
      await streamChat(
        { messages: forModel(messages), ...requestFor(opts) },
        (event) => {
          if (event.t === 'tool-call') calls.push(event);
          else if (event.t === 'messages') reply = event.v;
          else if (event.t === 'text') text += event.v ?? '';
          else if (event.t === 'error') failed = true;
          onEvent(event);
        },
        signal,
      );
    } catch (err) {
      // Stopped mid-reply: keep what was said, so the history still reads
      // user, assistant, and the next message can follow.
      if (isAbort(err) || signal?.aborted) {
        messages.push({ role: 'assistant', content: text.trim() ? `${text}\n\n${STOPPED}` : STOPPED });
        throw aborted();
      }
      throw err;
    }
    // Small models now and then end a turn with nothing at all (no text, no
    // tool call); ask once more instead of leaving the user with a blank reply.
    if (calls.length === 0 && !text.trim() && !retried && !failed) {
      retried = true;
      round--;
      continue;
    }
    messages.push(...(reply ?? [{ role: 'assistant', content: text || (failed ? '[no reply: the request failed]' : '') }]));
    // Without the API's copy of the call there is nothing to answer.
    if (calls.length === 0 || !reply) return;

    const results = [];
    for (const call of calls) {
      // Every call needs a result, stopped or not, or the history is invalid.
      const result = signal?.aborted
        ? `${STOPPED} This was not run.`
        : await runClientTool(call, opts, signal).then(
            (r) => (signal?.aborted ? `${STOPPED} ${r}` : r),
            // An approval prompt the stop interrupted.
            (err: unknown) => {
              if (signal?.aborted) return `${STOPPED} This was not run.`;
              throw err;
            },
          );
      opts.onToolResult?.({ id: call.id, name: call.name, label: toolLabel(call.name, call.input) }, result);
      results.push({
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.name,
        output: { type: 'text', value: result },
      });
    }
    messages.push({ role: 'tool', content: results });
    if (signal?.aborted) throw aborted();
  }
  onEvent({ t: 'error', v: `stopped after ${MAX_ROUNDS} rounds of tool calls; say "continue" to let it go on` });
}

/** A model the API offers (GET /models). */
export interface ModelInfo {
  id: string;
  description?: string;
  tools?: boolean;
  images?: boolean;
  disabled?: boolean;
}

/** The API's models and its default, for `/model`. */
export async function fetchModels(): Promise<{ default: string; models: ModelInfo[] }> {
  const res = await fetch(`${API}/models`);
  if (!res.ok) throw new Error(`GET /models: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { default: string; models?: ModelInfo[] };
  return { default: body.default, models: body.models ?? [] };
}

/** One line per model for `/model`, the one in use marked. */
export function describeModel(m: ModelInfo, current: string): string {
  const can = [m.tools ? 'tools' : 'no tools', m.images ? 'images' : ''].filter(Boolean).join(', ');
  const mark = m.id === current ? '*' : ' ';
  return `${mark} ${m.id}${m.description ? `  ${m.description}` : ''} (${can})${m.disabled ? ' [unavailable]' : ''}`;
}

/**
 * `/model <id>`: the model to switch to, or why not. A model without tools
 * can't run commands or touch files; say so rather than fail quietly.
 */
export function pickModel(
  list: { default: string; models: ModelInfo[] },
  id: string,
): { ok: true; model: ModelInfo; warning?: string } | { ok: false; error: string } {
  const model = list.models.find((m) => m.id === id);
  if (!model) return { ok: false, error: `No model ${id}. /model lists them.` };
  if (model.disabled) return { ok: false, error: `${id} isn't available here (${model.description ?? 'disabled'}).` };
  return {
    ok: true,
    model,
    warning: model.tools ? undefined : `${id} can't call tools: no commands, file reads or writes with it.`,
  };
}

/** `/think`'s setting: forced on or off, or left to the API (per model). */
export type ThinkSetting = 'auto' | 'on' | 'off';

export function thinkFlag(setting: ThinkSetting): boolean | undefined {
  return setting === 'auto' ? undefined : setting === 'on';
}

/** `/think` or `/think on|off|auto`: the new setting, or null for a bad argument. */
export function parseThink(line: string, current: ThinkSetting): ThinkSetting | null {
  const arg = line.slice('/think'.length).trim();
  if (!arg) return current === 'auto' ? 'on' : current === 'on' ? 'off' : 'auto';
  return arg === 'on' || arg === 'off' || arg === 'auto' ? arg : null;
}

export const THINK_NOTE: Record<ThinkSetting, string> = {
  auto: 'Thinking: auto (the API decides per model; Gemma thinks on turns with tools, qwen3 does not).',
  on: 'Thinking: on (slower, more careful with files and commands).',
  off: 'Thinking: off (faster).',
};
