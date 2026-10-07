import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  convertToModelMessages,
  createUIMessageStream,
  generateId,
  generateText,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from 'ai';
import { resolveModel, supportsTools } from './provider.js';
import { builtinTools, WEB_SYSTEM_PROMPT } from './tools.js';
import { LibsqlThreadStore, type ThreadStore } from './threads.js';
import { onShutdown, installShutdown } from './shutdown.js';
import { connectMcpServers, hasMcpConfig, mcpConfigPath, type McpServerStatus } from './mcp.js';

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

const app = express();
app.use(express.json({ limit: '10mb' }));

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
    res.setHeader('access-control-allow-headers', 'content-type');
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
// either MCP_ENABLED=1 or an mcp.json (MCP_CONFIG) next to the project;
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

// --- Optional server-side thread store (libSQL) ----------------------------
const threadStore: ThreadStore | null =
  process.env.THREAD_STORE === 'libsql' ? LibsqlThreadStore.open() : null;
if (threadStore) console.log(`  ✓ thread store: libsql (${process.env.THREADS_DB_URL ?? 'file:./data/threads.db'})`);

/** What the status endpoints report about the local wiring, no API call. */
const wiring = () => ({
  provider,
  model: modelId,
  gateway: baseURL,
  tools: tools ? Object.keys(tools).length : 0,
  toolNames: tools ? Object.keys(tools) : [],
  mcp: mcpServers.map(({ name, ok, toolCount, error }) => ({ name, ok, toolCount, error })),
  threadStore: threadStore ? 'libsql' : 'none',
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
    res.json({ default: modelId, models: await chatModels() });
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
 */
app.post('/chat', async (req, res) => {
  const { messages, system } = req.body as {
    messages?: ModelMessage[];
    system?: string;
  };

  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'Body must be { messages: ModelMessage[] }' });
    return;
  }

  const result = streamText({
    model,
    system,
    messages,
    tools,
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

  try {
    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          write({ t: 'text', v: part.text });
          break;
        // Fires as soon as the model commits to a tool, before its arguments
        // finish streaming: that's what lets a client say "Using x…" early.
        case 'tool-input-start':
          write({ t: 'tool', id: part.id, name: part.toolName, title: part.title });
          break;
        case 'tool-call':
          write({ t: 'tool-input', id: part.toolCallId, input: part.input });
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
          write({ t: 'error', v: describeError(part.error) });
          break;
      }
    }
  } catch (err) {
    // The stream itself failed; tell the client rather than hanging up silently.
    write({ t: 'error', v: describeError(err) });
  }
  res.end();
});

/**
 * Web chat, as autonomous-chatbot's src/routes/api/chat/+server.ts:
 * Body { messages: UIMessage[] }, responds with the AI SDK UI message stream
 * that `Chat` from @ai-sdk/svelte (or useChat) consumes.
 */
app.post('/api/chat', async (req, res) => {
  const {
    messages,
    webSearch,
    model: requested,
  } = req.body as { messages?: UIMessage[]; webSearch?: boolean; model?: string };
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
  const chatTools = supportsTools(chatModelId) ? tools : undefined;

  const modelMessages = await convertToModelMessages(messages);
  const stream = (history: ModelMessage[]) =>
    streamText({
      model: chatModel,
      system: WEB_SYSTEM_PROMPT,
      messages: history,
      stopWhen: stepCountIs(5),
      tools: chatTools,
      onError: ({ error }) => console.error('[stream error]', describeError(error)),
    });

  // The web composer's "Search the web" toggle. Small models don't reliably
  // make a forced tool call (they skip it, or print the call as text), so the
  // API runs the search itself, streams it to the UI as a normal tool call,
  // and hands the model the results to answer from.
  const search = webSearch === true ? chatTools?.search : undefined;
  if (!search?.execute) {
    stream(modelMessages).pipeUIMessageStreamToResponse(res, {
      // Surface the real reason in the client's chat.error instead of the
      // SDK's generic "An error occurred."
      onError: (error) => describeError(error),
    });
    return;
  }
  const runSearch = search.execute;

  const uiStream = createUIMessageStream({
    onError: (error) => describeError(error),
    execute: async ({ writer }) => {
      const toolCallId = generateId();
      const input = { query: lastUserText(messages).slice(0, 300), limit: 3 };
      writer.write({ type: 'start' });
      writer.write({ type: 'start-step' });
      writer.write({ type: 'tool-input-available', toolCallId, toolName: 'search', input });

      let output: unknown;
      let errorText: string | undefined;
      try {
        output = await runSearch(input as never, { toolCallId, messages: modelMessages, context: undefined });
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
      writer.merge(stream(history).toUIMessageStream({ sendStart: false }));
    },
  });
  pipeUIMessageStreamToResponse({ response: res, stream: uiStream });
});

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
threads.use((_req, res, next) => {
  if (!threadStore) {
    res.status(404).json({ error: 'thread store disabled: set THREAD_STORE=libsql on the API' });
    return;
  }
  next();
});
const store = () => threadStore as ThreadStore;
threads.get('/', async (_req, res) => {
  res.json(await store().list());
});
threads.post('/', async (req, res) => {
  res.status(201).json(await store().create(req.body ?? {}));
});
threads.delete('/', async (_req, res) => {
  await store().clear();
  res.json({ success: true });
});
threads.get('/:id', async (req, res) => {
  const thread = await store().get(req.params.id);
  if (!thread) res.status(404).json({ error: 'thread not found' });
  else res.json(thread);
});
threads.patch('/:id', async (req, res) => {
  const thread = await store().update(req.params.id, req.body ?? {});
  if (!thread) res.status(404).json({ error: 'thread not found' });
  else res.json(thread);
});
threads.delete('/:id', async (req, res) => {
  await store().remove(req.params.id);
  res.json({ success: true });
});
threads.put('/:id/messages', async (req, res) => {
  const messages = (req.body as { messages?: UIMessage[] })?.messages;
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: 'Body must be { messages: UIMessage[] }' });
    return;
  }
  await store().syncMessages(req.params.id, messages);
  res.json({ success: true });
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
