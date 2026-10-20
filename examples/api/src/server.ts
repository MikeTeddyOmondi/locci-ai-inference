import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  asSchema,
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  generateText,
  pipeUIMessageStreamToResponse,
  wrapLanguageModel,
  type LanguageModel,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from 'ai';
import { contextTokensFor, resolveModel, supportsImages, supportsTools, thinksWithTools } from './provider.js';
import {
  describeImages,
  describeModelImages,
  dropPrintedToolCalls,
  fitToContext,
  hasImage,
  imagesFirst,
  inlineAttachments,
  modelMessageHasImage,
  overflowRetry,
} from './context.js';
import { clearlyNoSearch, earlierSearches, planSearchQuery, relevantResults } from './search-plan.js';
import { builtinTools, clientTools, shellPrompt, webSystemPrompt } from './tools.js';
import { LibsqlThreadStore, type ThreadStore, type ThreadWithMessages } from './threads.js';
import { onShutdown, installShutdown } from './shutdown.js';
import { connectMcpServers, hasMcpConfig, mcpConfigPath, type McpServerStatus } from './mcp.js';
import { resumableStreams, THREAD_ID, type Recorder } from './resumable/index.js';
import { authConfig, userOf, withUser } from './auth.js';

// Shared chat API for the examples. Ported from locci-chat-cli's src/server.ts
// and harmonised with autonomous-chatbot's /api/chat route, so both the CLI and
// the web app are pure clients of this one service:
//
//   CLI (examples/cli)  -> GET /info, GET /status, POST /chat[?events=1], GET /mcp
//   web (examples/web)  -> POST /api/chat (UI message stream), /api/threads (opt-in)
//
// Every model call goes through the Locci AI Gateway via @locci/ai-sdk.

const PORT = Number(process.env.PORT ?? 3939);

// Resolve the model once at startup from MODEL / LOCCI_* env vars.
const { provider, modelId, model, baseURL, modelFor, chatModels } = resolveModel();

const SEARCH_MAX_CHARS = Number(process.env.SEARCH_MAX_CHARS) || 4000;

/**
 * The search rule for the system prompt. With AUTO_SEARCH the API has already
 * decided, so the model is never told to search, only to use results it has.
 */
type SearchState = { searched: boolean; earlier: boolean };
const searchMode = (toolSet: ToolSet | undefined, s: SearchState) =>
  s.searched ? 'done' : AUTO_SEARCH || !toolSet?.search ? (s.earlier ? 'earlier' : 'none') : 'available';

/** The web system prompt for a request's tool set (see webSystemPrompt). */
const webPrompt = (toolSet: ToolSet | undefined, s: SearchState) =>
  webSystemPrompt({ now: new Date(), search: searchMode(toolSet, s), weather: !!toolSet?.weather });

/** The system prompt for a step that must answer with no tools. */
const answerPrompt = (s: SearchState) =>
  webSystemPrompt({ now: new Date(), search: s.searched ? 'done' : s.earlier ? 'earlier' : 'none', weather: false });

// Web search policy. A 1.7B model doesn't decide reliably when to search
// (phrasing like "teach me" skips it, "up to date" triggers it), and once it
// has results it tends to search again with the same query until it runs out
// of steps. So the API decides: it searches before the model runs, at most
// once per turn, and the last step always answers.
const MAX_STEPS = 5;
const MAX_TOOL_CALLS = 4;
// AUTO_SEARCH=off restores the model's own choice (plus the UI's toggle).
const AUTO_SEARCH = process.env.AUTO_SEARCH !== 'off';
const SMALL_TALK =
  /^\s*(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|cool|great|nice|bye|good (morning|afternoon|evening|night))\b[\s!.?,]*$/i;

const app = express();
// Web chats carry their photos (resized in the browser) in every request's history.
app.use(express.json({ limit: '25mb' }));

// --- CORS for the web example ----------------------------------------------
// The web app is a static client on its own origin (Vite dev server on :5173 by
// default). CORS_ORIGIN is a comma-separated allowlist; "*" allows any origin.
const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, idempotency-key, authorization');
    res.setHeader('access-control-expose-headers', 'x-request-id');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// --- Tools: the web example's built-ins plus optional MCP ------------------
const builtin = builtinTools();
for (const line of builtin.report) console.log(line);

// MCP is off by default so the harness stays a plain chat service. Opt in with
// either MCP_ENABLED=1 or an mcp.json (MCP_CONFIG, the project's, or ~/.locci/ai/mcp.json);
// MCP_ENABLED=0 forces it off regardless. Servers are declared in the JSON
// config using the same `mcpServers` shape as Claude Desktop / Cursor.
let mcpTools: ToolSet = {};
let mcpServers: McpServerStatus[] = [];
const mcpEnabled =
  process.env.MCP_ENABLED === '0' ? false : process.env.MCP_ENABLED === '1' || hasMcpConfig();

if (mcpEnabled) {
  const mcp = await connectMcpServers();
  mcpTools = mcp.tools;
  mcpServers = mcp.servers;

  if (mcp.servers.length === 0) {
    console.log(`  · MCP enabled but no servers configured (${mcpConfigPath()})`);
  }
  for (const server of mcp.servers) {
    console.log(
      server.ok
        ? `  ✓ MCP ${server.name}: ${server.toolCount} tool(s)`
        : `  ✗ MCP ${server.name}: failed: ${server.error}`,
    );
    // Registered BEFORE the http server below, so on shutdown the server
    // (registered later) drains first, then each MCP client closes.
    if (server.close) onShutdown(`mcp: ${server.name}`, server.close);
  }
}

// Built-ins win a name clash with an MCP tool, so the web example's prompt
// always gets the `weather` / `search` it was written for.
const clashes = Object.keys(builtin.tools).filter((name) => name in mcpTools);
if (clashes.length) console.log(`  ↔ MCP tool(s) shadowed by built-ins: ${clashes.join(', ')}`);
const allTools: ToolSet = { ...mcpTools, ...builtin.tools };
const tools: ToolSet | undefined = Object.keys(allTools).length > 0 ? allTools : undefined;

// The web chat's tools. A 1.7B model handed 19 tools calls whatever looks
// plausible (the loccibox sandbox to "run" a tutorial, filesystem tools on
// invented paths), so /api/chat offers only the built-ins by default; the CLI
// and TUI keep every tool. WEB_TOOLS: a comma list of tool names, or "all".
const webToolNames = (() => {
  const setting = (process.env.WEB_TOOLS ?? Object.keys(builtin.tools).join(',')).trim();
  if (setting === 'all') return Object.keys(allTools);
  return setting.split(',').map((n) => n.trim()).filter((n) => n in allTools);
})();
const webTools: ToolSet | undefined =
  webToolNames.length > 0 ? Object.fromEntries(webToolNames.map((n) => [n, allTools[n]])) : undefined;
console.log(`  ✓ web chat tools: ${webToolNames.join(', ') || 'none'}`);

// The MCP tools a client that runs `shell` itself (the CLI, the TUI) gets on top
// of its own tools and the built-ins. It works in its own folder, so an MCP
// server on the API host's disk (filesystem) would point the model at the wrong
// machine, and small models pick it over `shell`; tools that work elsewhere
// (loccibox's sandboxes and boxes) are fine. CLI_TOOLS: a comma list of tool or
// MCP server names, "all" or "none"; by default every MCP tool but filesystem's.
const cliMcpToolNames = (() => {
  const setting = (process.env.CLI_TOOLS ?? '').trim();
  if (setting === 'none') return [];
  if (setting === 'all') return Object.keys(mcpTools);
  if (!setting) return mcpServers.filter((s) => s.name !== 'filesystem').flatMap((s) => s.toolNames);
  const byServer = new Map(mcpServers.map((s) => [s.name, s.toolNames]));
  const names = setting.split(',').map((n) => n.trim());
  return [...new Set(names.flatMap((n) => byServer.get(n) ?? (n in mcpTools ? [n] : [])))];
})();
const cliMcpTools: ToolSet = Object.fromEntries(cliMcpToolNames.map((n) => [n, mcpTools[n]]));
console.log(`  ✓ CLI MCP tools: ${cliMcpToolNames.join(', ') || 'none'}`);

// --- Context budget (web endpoint) ------------------------------------------
// How much conversation /api/chat can send: the model's window minus what every
// request already spends on the system prompt and tool schemas (measured from
// the tools actually loaded, so adding an MCP server shrinks it), plus room for
// one tool result and the answer. context.ts shortens the conversation to fit.
const ANSWER_TOKENS = 1024;
const TOOL_RESULT_TOKENS = 1024;
// Measured on qwen3-1.7b: the system prompt and 19 tool schemas (~11.7k
// characters) cost 2,978 tokens, ~3.9 per token. Conversation text varies more
// (prose ~4, code ~2.5, dense JSON ~1.5); overflowRetry catches the misses.
const SCHEMA_CHARS_PER_TOKEN = 3.9;
const TEXT_CHARS_PER_TOKEN = 2.5;

async function promptChars(toolSet: ToolSet | undefined): Promise<number> {
  // The longest variant of the system prompt.
  let n = Math.max(
    ...[false, true].map((searched) => webPrompt(toolSet, { searched, earlier: true }).length),
  );
  for (const [name, t] of Object.entries(toolSet ?? {})) {
    const parameters = t.inputSchema ? await asSchema(t.inputSchema).jsonSchema : {};
    n += JSON.stringify({ type: 'function', function: { name, description: t.description, parameters } }).length;
  }
  return n;
}
const promptCharsWithTools = await promptChars(webTools);
const promptCharsWithoutTools = await promptChars(undefined);

/** Characters of conversation that fit, for a request to `id` with or without tools. */
function inputBudget(id: string, withTools: boolean): number {
  const prompt = withTools ? promptCharsWithTools : promptCharsWithoutTools;
  const left =
    contextTokensFor(id) -
    Math.ceil(prompt / SCHEMA_CHARS_PER_TOKEN) -
    ANSWER_TOKENS -
    (withTools ? TOOL_RESULT_TOKENS : 0);
  const chars = Math.floor(Math.max(500, left) * TEXT_CHARS_PER_TOKEN);
  const cap = Number(process.env.MAX_INPUT_CHARS);
  return cap > 0 ? Math.min(chars, cap) : chars;
}
console.log(
  `  ✓ context: ${contextTokensFor(modelId)} tokens per request; prompt + ${webToolNames.length} web tool schemas ≈ ` +
    `${Math.ceil(promptCharsWithTools / SCHEMA_CHARS_PER_TOKEN)} tokens; conversation budget ${inputBudget(modelId, !!webTools)} characters`,
);

// --- Optional server-side thread store (libSQL) ----------------------------
const threadStore: LibsqlThreadStore | null =
  process.env.THREAD_STORE === 'libsql' ? LibsqlThreadStore.open() : null;
if (threadStore) console.log(`  ✓ thread store: libsql (${process.env.THREADS_DB_URL ?? 'file:./data/threads.db'})`);

// Resumable replies (src/resumable): a reply keeps running when the browser
// refreshes, and GET /api/chat/:threadId/stream replays it.
const replyStreams = await resumableStreams();
console.log(`  ✓ resumable replies: ${replyStreams?.name ?? 'off'}`);
/** Replies being generated in this process, so Stop can abort them; keyed by replyKey. */
const activeReplies = new Map<string, { requestId: string; controller: AbortController }>();
/** Thread ids come from the client, so running replies are told apart per user. */
const replyKey = (owner: string, threadId: string) => `${owner}\n${threadId}`;

// Sign-in (src/auth.ts): AUTH=locci makes the web routes need a Locci token.
const auth = authConfig();
const requireUser = withUser(auth);
console.log(`  ✓ auth: ${auth.mode === 'locci' ? `locci (${auth.issuer})` : 'off'}`);

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
};

/** Send recorded SSE text as the response, stopping if the client goes away. */
async function sendRecorded(res: Response, stream: ReadableStream<string>) {
  res.writeHead(200, SSE_HEADERS);
  const reader = stream.getReader();
  res.once('close', () => void reader.cancel().catch(() => {}));
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      res.write(value);
    }
  } catch (error) {
    console.error('[replay]', describeError(error));
  } finally {
    res.end();
  }
}

/** Copy the SSE text sent to the browser into the recording, until the reply ends. */
async function record(stream: ReadableStream<string>, recorder: Recorder, key: string, requestId: string) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await recorder.append(value);
    }
  } catch (error) {
    console.error(`  [${requestId.slice(0, 8)}] [record]`, describeError(error));
  } finally {
    await recorder.finish().catch(() => {});
    if (activeReplies.get(key)?.requestId === requestId) activeReplies.delete(key);
  }
}

/** What the status endpoints report about the local wiring, no API call. */
const wiring = () => ({
  provider,
  model: modelId,
  gateway: baseURL,
  tools: tools ? Object.keys(tools).length : 0,
  toolNames: tools ? Object.keys(tools) : [],
  /** What a client that runs `shell` gets from this server, besides its own tools. */
  cliToolNames: [...cliMcpToolNames.filter((n) => !(n in builtin.tools)), ...Object.keys(builtin.tools)],
  mcp: mcpServers.map(({ name, ok, toolCount, error }) => ({ name, ok, toolCount, error })),
  threadStore: threadStore ? 'libsql' : 'none',
  resumable: replyStreams?.name ?? 'off',
  // The web app signs in against this issuer when auth is locci.
  auth: auth.mode,
  ...(auth.mode === 'locci' ? { authIssuer: auth.issuer, authClientId: auth.clientId } : {}),
});

/**
 * Cheap metadata for clients (the TUI shows this in its footer). Unlike
 * /status this makes no API call, so it's safe to hit on every launch.
 */
app.get('/info', (_req, res) => {
  res.json(wiring());
});

/**
 * Chat models the gateway serves, for the web model picker. Falls back to the
 * configured model alone when the gateway can't be listed, so the UI still works.
 */
app.get('/models', async (_req, res) => {
  try {
    res.json({ default: modelId, models: await chatModels(), maxInputChars: inputBudget(modelId, !!webTools && supportsTools(modelId)) });
  } catch (error) {
    console.error('[models]', describeError(error));
    res.json({
      default: modelId,
      models: [{ id: modelId, description: 'Configured model', tools: supportsTools(modelId) }],
      error: describeError(error),
    });
  }
});

/**
 * Full status: the local wiring above plus a live check, a tiny generateText
 * call through the gateway, so you can confirm credentials and the model work,
 * and see the exact error if they don't. Returns 200 with { ok: false, ... } on
 * failure so the CLI can read the body.
 */
app.get('/status', async (_req, res) => {
  try {
    const { text, usage } = await generateText({
      model,
      prompt: 'Reply with exactly: OK',
      maxOutputTokens: 16,
    });
    res.json({ ok: true, ...wiring(), text, usage });
  } catch (err: any) {
    res.json({
      ok: false,
      ...wiring(),
      statusCode: err?.statusCode,
      error: describeError(err),
    });
  }
});

/** Per-server MCP detail, including tool names, for the CLI's `mcp list`. */
app.get('/mcp', (_req, res) => {
  res.json({
    enabled: mcpEnabled,
    config: mcpConfigPath(),
    servers: mcpServers.map(({ name, ok, toolCount, error, toolNames }) => ({
      name,
      ok,
      toolCount,
      error,
      toolNames,
    })),
  });
});

/** Longest tool payload we'll forward to a client, so one huge result can't
 *  swamp the stream. Clients truncate again for display. */
const MAX_PAYLOAD = 4_000;

/**
 * Pull a human-readable message out of whatever the SDK or provider threw.
 * Provider errors arrive as plain objects like { message, type }; String()
 * on those yields "[object Object]", which tells the user nothing.
 */
function describeError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error && err.message) return err.message;

  const e = err as Record<string, any>;
  const message = e.message ?? e.error?.message;
  if (typeof message === 'string' && message) {
    const code = e.code ?? e.error?.code ?? e.type ?? e.error?.type;
    return code ? `${message} (${code})` : message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Flatten a tool result into something readable in a terminal. */
function summarize(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output.slice(0, MAX_PAYLOAD);
  const o = output as { content?: { type?: string; text?: string }[] };
  if (Array.isArray(o.content)) {
    const text = o.content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (text) return text.slice(0, MAX_PAYLOAD);
  }
  try {
    return JSON.stringify(output, null, 2).slice(0, MAX_PAYLOAD);
  } catch {
    return String(output).slice(0, MAX_PAYLOAD);
  }
}

/**
 * CLI chat. Body: { messages: ModelMessage[], system?: string }.
 *
 * By default streams raw text: the plain CLI reads it chunk by chunk. With
 * `?events=1` it streams NDJSON instead, one JSON object per line, so a client
 * can also show tool activity as it happens:
 *
 *   { "t": "text",       "v": "partial text" }
 *   { "t": "tool",       "id": "…", "name": "read_file", "title": "Read File" }
 *   { "t": "tool-input", "id": "…", "input": { … } }
 *   { "t": "tool-done",  "id": "…", "output": "…" }   // or "error"
 *   { "t": "finish",     "reason": "stop", "usage": { … } }
 *   { "t": "error",      "v": "…" }
 *   { "t": "thinking" }                               // with `reasoning: true`, when the model starts to think
 *
 * A client that can run tools itself lists them: `clientTools: ["shell",
 * "read_file", "write_file", "edit_file"]`,
 * with `cwd` and `platform` for the system prompt (events only). The model's
 * call to one ends the reply with
 *
 *   { "t": "tool-call",  "id": "…", "name": "shell", "input": { "command": "…" } }
 *   { "t": "finish",     "reason": "tool-calls", … }
 *   { "t": "messages",   "v": [ …ModelMessage ] }   // this reply, to append to the history
 *
 * and the client runs it, appends a `tool` message with the result, and posts
 * again. `messages` is sent on every reply to such a client, so its history
 * keeps tool calls and results, not only text.
 */
app.post('/chat', requireUser, async (req, res) => {
  const { messages, system, cwd, platform, model: requested, reasoning, warm } = req.body as {
    messages?: ModelMessage[];
    /**
     * Read the system prompt and tools into the model's prompt cache and stop
     * after one token: a client sends it when a chat starts, so the first real
     * message only has its own tokens left to read.
     */
    warm?: boolean;
    system?: string;
    model?: string;
    /**
     * Let the model think before it answers (Qwen3 and Gemma 4 chat templates).
     * Unset: the model's default for turns with client tools (thinksWithTools).
     */
    reasoning?: boolean;
    clientTools?: unknown;
    cwd?: unknown;
    platform?: unknown;
  };
  const onClient = clientTools(req.body.clientTools);
  const hasClientTools = Object.keys(onClient).length > 0;

  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'Body must be { messages: ModelMessage[] }' });
    return;
  }
  if (hasClientTools && req.query.events !== '1') {
    res.status(400).json({ error: 'clientTools needs ?events=1 (the tool calls come as events)' });
    return;
  }

  // `model`, as in /api/chat: one /models offers. The TUI picks a model that
  // reads images for a conversation with photos.
  let chatModel = model;
  let chatModelId = modelId;
  if (requested && requested !== modelId) {
    const known = await chatModels().catch(() => []);
    if (!known.some((m) => m.id === requested && !m.disabled)) {
      res.status(400).json({ error: `Unknown or unavailable model: ${requested}` });
      return;
    }
    chatModel = modelFor(requested);
    chatModelId = requested;
  }
  // As /api/chat: a new photo for a model that can't see it is refused; photos
  // earlier in the chat (before a /model switch) become notes.
  const withImage = messages.some(modelMessageHasImage);
  const seesImages = supportsImages(chatModelId);
  if (!seesImages && modelMessageHasImage([...messages].reverse().find((m) => m.role === 'user'))) {
    res.status(400).json({ error: `${chatModelId} can't read images. Pick a model that can, such as gemma-4-e2b.` });
    return;
  }

  // The CLI stopping a reply (Esc) closes the connection: stop the model too,
  // or it keeps generating and holds one of the node's slots.
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) stop.abort();
  });

  const result = streamText({
    model: chatModel,
    abortSignal: stop.signal,
    ...(warm ? { maxOutputTokens: 1 } : {}),
    // A node the VM's OOM killer restarted answers `503 Loading model` for a
    // few seconds: retry for about 30 s (2, 4, 8, 16) instead of the default 6.
    maxRetries: 4,
    // The pools run with --reasoning off; enable_thinking turns it back on for
    // this request (llama.cpp passes chat_template_kwargs to the template).
    ...((reasoning ?? (hasClientTools && thinksWithTools(chatModelId)))
      ? { providerOptions: { locci: { chat_template_kwargs: { enable_thinking: true } } } }
      : {}),
    system:
      'shell' in onClient
        ? [system, shellPrompt({ cwd, platform, files: 'write_file' in onClient || 'edit_file' in onClient })].filter(Boolean).join('\n\n')
        : system,
    messages: !withImage ? messages : seesImages ? imagesFirst(messages) : describeModelImages(messages),
    // A client that runs `shell` gets its own tools, the built-ins (which win a
    // clash) and the CLI_TOOLS MCP tools (see cliMcpToolNames).
    // A picked model that can't call tools would print the call as text (as
    // in /api/chat); the configured MODEL keeps them, as before.
    tools:
      chatModelId !== modelId && !supportsTools(chatModelId)
        ? undefined
        : hasClientTools
          ? { ...cliMcpTools, ...onClient, ...builtin.tools }
          : tools,
    // Turn a single request into a tool-calling loop: the model can call a
    // tool, get the result, and keep going until it answers (or 8 steps).
    stopWhen: stepCountIs(8),
    onError: ({ error }) => console.error('[stream error]', describeError(error)),
  });

  if (req.query.events !== '1') {
    result.pipeTextStreamToResponse(res);
    return;
  }

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  const write = (event: Record<string, unknown>) => res.write(`${JSON.stringify(event)}\n`);
  // A long prompt can take minutes to read on CPU before the first token
  // (Gemma: ~50 tokens/s). Headers now and a line every 20 s keep the client's
  // fetch, which gives up after 300 s of silence, waiting.
  res.flushHeaders();
  const ping = setInterval(() => write({ t: 'ping' }), 20_000);
  res.on('close', () => clearInterval(ping));

  // One error per failed request: after it, the SDK's "No output generated"
  // only repeats it.
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    write({ t: 'error', v: tooLong(describeError(error), chatModelId) });
  };
  try {
    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          write({ t: 'text', v: part.text });
          break;
        // Only that it is thinking: the thoughts themselves stay out of the
        // terminal, and they go back in the history the client keeps.
        case 'reasoning-start':
          write({ t: 'thinking' });
          break;
        // Fires as soon as the model commits to a tool, before its arguments
        // finish streaming: that's what lets a client say "Using x…" early.
        case 'tool-input-start':
          write({ t: 'tool', id: part.id, name: part.toolName, title: part.title });
          break;
        case 'tool-call':
          write(
            part.toolName in onClient && !(part.toolName in builtin.tools)
              ? { t: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input }
              : { t: 'tool-input', id: part.toolCallId, input: part.input },
          );
          break;
        case 'tool-result':
          write({ t: 'tool-done', id: part.toolCallId, output: summarize(part.output) });
          break;
        case 'tool-error':
          write({ t: 'tool-done', id: part.toolCallId, error: describeError(part.error) });
          break;
        case 'finish':
          // Lets a client tell a complete answer from one cut off by the
          // gateway's max_tokens / context window ("length").
          write({ t: 'finish', reason: part.finishReason, usage: part.totalUsage });
          break;
        case 'error':
          fail(part.error);
          break;
      }
    }
    if (hasClientTools && !failed) write({ t: 'messages', v: (await result.response).messages });
  } catch (err) {
    // The stream itself failed; tell the client rather than hanging up silently.
    fail(err);
  }
  clearInterval(ping);
  res.end();
});

/**
 * llama.cpp's "request (10673 tokens) exceeds the available context size (8192
 * tokens), try increasing it", said in terms of what the user can do.
 */
function tooLong(message: string, modelId: string): string {
  const m = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/.exec(message);
  return m
    ? `This chat (${m[1]} tokens) no longer fits ${modelId}'s context (${m[2]} tokens per request). Start a new one with /clear, or switch to a model with more room with /model.`
    : message;
}

/**
 * Web chat, as autonomous-chatbot's src/routes/api/chat/+server.ts:
 * Body { messages: UIMessage[] }, responds with the AI SDK UI message stream
 * that `Chat` from @ai-sdk/svelte (or useChat) consumes.
 */
app.post('/api/chat', requireUser, async (req, res) => {
  const {
    messages,
    webSearch,
    model: requested,
    threadId: rawThreadId,
    requestId: rawRequestId,
  } = req.body as { messages?: UIMessage[]; webSearch?: boolean; model?: string; threadId?: unknown; requestId?: unknown };
  // A request id per send (body, or an Idempotency-Key header), echoed back and
  // tagged on this request's log lines.
  const requestId = pickRequestId(rawRequestId ?? req.get('idempotency-key'));
  const tag = `[${requestId.slice(0, 8)}] `;
  res.setHeader('x-request-id', requestId);
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'Body must be { messages: UIMessage[] }' });
    return;
  }

  // The web model picker. Only ids the gateway lists are accepted, and tools
  // go only to models that can call them (qwen2.5-coder would print the call
  // as text instead).
  let chatModel = model;
  let chatModelId = modelId;
  if (requested && requested !== modelId) {
    const known = await chatModels().catch(() => []);
    const entry = known.find((m) => m.id === requested && !m.disabled);
    if (!entry) {
      res.status(400).json({ error: `Unknown or unavailable model: ${requested}` });
      return;
    }
    chatModel = modelFor(requested);
    chatModelId = requested;
  }
  const chatTools = supportsTools(chatModelId) ? webTools : undefined;
  // A photo sent to a model that can't see it would be dropped silently; say so
  // instead. Photos earlier in the thread become notes (describeImages below).
  const seesImages = supportsImages(chatModelId);
  if (!seesImages && hasImage([...messages].reverse().find((m) => m.role === 'user'))) {
    res.status(400).json({ error: `${chatModelId} can't read images. Pick a model that can, such as gemma-4-e2b.` });
    return;
  }

  // Resumable replies (web chats send their thread id; the CLI and temporary
  // chats don't, and are never recorded). The recording starts with this
  // request's ids, so a repeated request is answered from it.
  const threadId = typeof rawThreadId === 'string' && THREAD_ID.test(rawThreadId) ? rawThreadId : undefined;
  const messageId = [...messages].reverse().find((m) => m.role === 'user')?.id ?? '';
  const user = userOf(res);
  const key = threadId ? replyKey(user.id, threadId) : '';
  let recorder: Recorder | undefined;
  let abortSignal: AbortSignal | undefined;
  // If the store is unreachable the reply goes out unrecorded rather than failing.
  const started =
    replyStreams && threadId
      ? await replyStreams.start({ owner: user, threadId, requestId, messageId }).catch((error: unknown) => {
          console.error(`  ${tag}[resume] not recording this reply:`, describeError(error));
          return null;
        })
      : null;
  if (started && threadId) {
    if (started.kind === 'conflict') {
      res.status(409).json({ error: `Request id ${requestId} was already used for another message` });
      return;
    }
    if (started.kind === 'replay') {
      console.log(`  ${tag}[resume] repeated request: replaying its reply`);
      await sendRecorded(res, started.stream);
      return;
    }
    recorder = started.recorder;
    // A new turn supersedes one still running in this thread.
    activeReplies.get(key)?.controller.abort();
    const controller = new AbortController();
    activeReplies.set(key, { requestId, controller });
    abortSignal = controller.signal;
  }
  // The reply keeps running if the browser disconnects; the recording reads
  // its own copy of the stream.
  const consumeSseStream =
    recorder && threadId
      ? ({ stream }: { stream: ReadableStream<string> }) => record(stream, recorder, key, requestId)
      : undefined;
  // One id for the reply, so a replay rebuilds the same message.
  const assistantId = randomUUID();

  try {

  // Long pastes and histories are shortened to fit the model's window; the
  // forced web search needs room for its results too.
  const ask = lastUserText(messages);
  // Pasted text and files are the source the user wants used: no web search.
  const attached = lastUserHasAttachment(messages) || hasImage([...messages].reverse().find((m) => m.role === 'user'));
  // The model plans the query from the conversation (search-plan.ts), so a
  // follow-up like "another example" searches for the right thing, or nothing.
  // Small talk, attachments, weather, translation and reworking earlier text
  // skip planning altogether.
  let query: string | null = null;
  const skip =
    attached ||
    SMALL_TALK.test(ask) ||
    clearlyNoSearch(ask, { weatherTool: !!chatTools?.weather, hasHistory: messages.length > 1 });
  if (chatTools?.search && !skip && (AUTO_SEARCH || webSearch === true)) {
    query = await planSearchQuery(chatModel, messages, { tag, abortSignal });
  }
  // The composer's "Search the web" toggle always searches, with the raw message if need be.
  if (webSearch === true && !query && chatTools?.search) query = ask.slice(0, 300) || null;
  console.log(`  ${tag}[search] ${query ? `query "${query}"` : 'none'}`);
  const search = query ? chatTools?.search : undefined;
  const room = inputBudget(chatModelId, !!chatTools);
  const budget = search ? Math.max(1000, room - SEARCH_MAX_CHARS) : room;
  const fitted = fitToContext(dropPrintedToolCalls(seesImages ? messages : describeImages(messages)), budget);
  if (fitted.trimmed) console.log(`  ${tag}[context] conversation shortened to fit ${budget} characters`);
  const modelMessages = await convertToModelMessages(inlineAttachments(fitted.messages));
  // Retry once, shortened, if the model still rejects the prompt as too long.
  const guardedModel = wrapLanguageModel({
    model: chatModel as Exclude<LanguageModel, string>,
    middleware: overflowRetry(ANSWER_TOKENS, tag),
  });
  const toolNames = Object.keys(chatTools ?? {});
  const withoutSearch = toolNames.filter((name) => name !== 'search');
  // Results from earlier turns stay in the history, so a follow-up the planner
  // judged covered is answered from them.
  const earlier = earlierSearches(fitted.messages).length > 0;
  const stream = (history: ModelMessage[], searchedFirst: boolean) =>
    streamText({
      model: guardedModel,
      system: webPrompt(chatTools, { searched: searchedFirst, earlier }),
      messages: history,
      stopWhen: stepCountIs(MAX_STEPS),
      tools: chatTools,
      abortSignal,
      prepareStep: ({ stepNumber, steps }) => {
        const calls = steps.flatMap((s) => s.toolCalls);
        const searched = searchedFirst || calls.some((call) => call.toolName === 'search');
        // Answer now: on the last step, after MAX_TOOL_CALLS calls (a model can
        // make several per step), or when the user attached the source to read.
        // The tools are removed, not just switched off: with their schemas still in
        // the prompt the model writes a <tool_call> out as text instead.
        if (stepNumber >= MAX_STEPS - 1 || calls.length >= MAX_TOOL_CALLS || attached) {
          return { activeTools: [], toolChoice: 'none', system: answerPrompt({ searched, earlier }) };
        }
        // One search per turn, and with AUTO_SEARCH only the one the API ran.
        if (!searched && !AUTO_SEARCH) return {};
        return {
          activeTools: withoutSearch,
          system: webPrompt(chatTools, { searched, earlier }),
        };
      },
      onError: ({ error }) => console.error(`${tag}[stream error]`, describeError(error)),
    });

  // The web composer's "Search the web" toggle. Small models don't reliably
  // make a forced tool call (they skip it, or print the call as text), so the
  // API runs the search itself, streams it to the UI as a normal tool call,
  // and hands the model the results to answer from.
  if (!search?.execute) {
    stream(modelMessages, false).pipeUIMessageStreamToResponse(res, {
      // Surface the real reason in the client's chat.error instead of the
      // SDK's generic "An error occurred."
      onError: (error) => describeError(error),
      originalMessages: messages,
      generateMessageId: () => assistantId,
      consumeSseStream,
    });
    return;
  }
  const runSearch = search.execute;

  const uiStream = createUIMessageStream({
    onError: (error) => describeError(error),
    execute: async ({ writer }) => {
      const toolCallId = generateId();
      const input = { query: query ?? ask, limit: 3 };
      writer.write({ type: 'start', messageId: assistantId });
      writer.write({ type: 'start-step' });
      writer.write({ type: 'tool-input-available', toolCallId, toolName: 'search', input });

      let output: unknown;
      let errorText: string | undefined;
      try {
        output = relevantResults(
          input.query,
          await runSearch(input as never, { toolCallId, messages: modelMessages, context: undefined }),
        );
        writer.write({ type: 'tool-output-available', toolCallId, output });
      } catch (error) {
        errorText = describeError(error);
        writer.write({ type: 'tool-output-error', toolCallId, errorText });
      }
      writer.write({ type: 'finish-step' });

      const history: ModelMessage[] = [
        ...modelMessages,
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName: 'search', input }] },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId,
              toolName: 'search',
              output:
                errorText !== undefined
                  ? { type: 'error-text', value: errorText }
                  : { type: 'json', value: JSON.parse(JSON.stringify(output ?? null)) },
            },
          ],
        },
      ];
      writer.merge(stream(history, true).toUIMessageStream({ sendStart: false, onError: (error) => describeError(error) }));
    },
  });
  pipeUIMessageStreamToResponse({ response: res, stream: uiStream, consumeSseStream });
  } catch (error) {
    // Failed before streaming began: end the recording so a resume doesn't wait on it.
    if (recorder) await recorder.finish().catch(() => {});
    if (threadId && activeReplies.get(key)?.requestId === requestId) activeReplies.delete(key);
    throw error;
  }
});

/** The client's request id if it looks like one, else a fresh UUID. */
function pickRequestId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(value) ? value : randomUUID();
}

/**
 * Resume a web chat's latest reply (the AI SDK's chat.resumeStream()): the
 * recording from its start, then live until it ends. 204 when there is none.
 */
app.get('/api/chat/:threadId/stream', requireUser, async (req, res) => {
  const threadId = String(req.params.threadId);
  const stream =
    replyStreams && THREAD_ID.test(threadId)
      ? await replyStreams.resume(userOf(res), threadId).catch((error: unknown) => {
          console.error('[resume]', describeError(error));
          return null;
        })
      : null;
  if (!stream) {
    res.status(204).end();
    return;
  }
  await sendRecorded(res, stream);
});

/** Stop a web chat's reply. It runs on after a disconnect, so closing the request alone no longer stops it. */
app.delete('/api/chat/:threadId/stream', requireUser, (req, res) => {
  const active = activeReplies.get(replyKey(userOf(res).id, String(req.params.threadId)));
  if (!active) {
    res.status(404).json({ error: 'no reply is running for this thread' });
    return;
  }
  active.controller.abort();
  console.log(`  [${active.requestId.slice(0, 8)}] [stop] reply stopped by the user`);
  res.status(204).end();
});

/** Whether the user's latest message carries an attached file or long paste (photos: hasImage). */
function lastUserHasAttachment(messages: UIMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return (last?.parts ?? []).some((p) => p.type === 'text' && p.text.startsWith('<attachment '));
}

/** The user's latest message as plain text (attached files left out), for a search query. */
function lastUserText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return (last?.parts ?? [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && !p.text.startsWith('<attachment '))
    .map((p) => p.text)
    .join(' ')
    .trim();
}

// --- Thread routes (THREAD_STORE=libsql) -----------------------------------
const threads = express.Router();
threads.use(requireUser);
threads.use((_req, res, next) => {
  if (!threadStore) {
    res.status(404).json({ error: 'thread store disabled: set THREAD_STORE=libsql on the API' });
    return;
  }
  next();
});
/** The caller's threads only. */
const store = (res: Response): ThreadStore => (threadStore as LibsqlThreadStore).forOwner(userOf(res).id);
threads.get('/', async (_req, res) => {
  res.json(await store(res).list());
});
/** Bring in a thread made elsewhere (the web app's chats from before sign-in), keeping its id and dates. */
threads.post('/import', async (req, res) => {
  const thread = req.body as ThreadWithMessages | undefined;
  if (!thread || typeof thread.id !== 'string' || !THREAD_ID.test(thread.id) || !Array.isArray(thread.messages)) {
    res.status(400).json({ error: 'Body must be a thread with an id and messages' });
    return;
  }
  const result = await store(res).importThread(thread);
  if (result === 'taken') res.status(409).json({ error: 'thread id belongs to another user' });
  else res.status(result === 'imported' ? 201 : 200).json({ result });
});
threads.post('/', async (req, res) => {
  res.status(201).json(await store(res).create(req.body ?? {}));
});
threads.delete('/', async (_req, res) => {
  await store(res).clear();
  res.json({ success: true });
});
threads.get('/search', async (req, res) => {
  res.json(await store(res).search(String(req.query.q ?? '')));
});
threads.get('/:id', async (req, res) => {
  const thread = await store(res).get(req.params.id);
  if (!thread) res.status(404).json({ error: 'thread not found' });
  else res.json(thread);
});
threads.patch('/:id', async (req, res) => {
  const thread = await store(res).update(req.params.id, req.body ?? {});
  if (!thread) res.status(404).json({ error: 'thread not found' });
  else res.json(thread);
});
threads.delete('/:id', async (req, res) => {
  await store(res).remove(req.params.id);
  res.json({ success: true });
});
threads.put('/:id/messages', async (req, res) => {
  const messages = (req.body as { messages?: UIMessage[] })?.messages;
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'Body must be { messages: UIMessage[] }' });
    return;
  }
  if (await store(res).syncMessages(req.params.id, messages)) res.json({ success: true });
  else res.status(404).json({ error: 'thread not found' });
});
app.use('/api/threads', threads);

const server = app.listen(PORT, () => {
  console.log(`▶ server on http://localhost:${PORT}  (provider: ${provider}, model: ${modelId}, gateway: ${baseURL})`);
});

// --- Graceful shutdown ---------------------------------------------------
// Cleanups run LIFO on SIGTERM/SIGINT. The MCP clients (if enabled) were
// registered above; the http server is registered last so it drains first.
onShutdown('http server', async () => {
  // Streaming responses hold connections open, so close idle ones
  // immediately, give active streams a few seconds, then force the rest so
  // server.close() can actually resolve.
  server.closeIdleConnections();
  const forceConns = setTimeout(() => server.closeAllConnections(), 5_000);
  forceConns.unref();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  clearTimeout(forceConns);
});

installShutdown({ timeoutMs: 10_000 });
