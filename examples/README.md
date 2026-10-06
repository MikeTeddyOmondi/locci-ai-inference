# examples

Real client apps, ported onto `@locci/ai-sdk`, to catch regressions in the SDK and the gateway the way users would hit them. Each mirrors an existing project:

| Folder | Package | Ported from | What it is |
| --- | --- | --- | --- |
| [`api/`](api) | `@locci/example-api` | `locci-chat-cli/src/server.ts` + `autonomous-chatbot/src/routes/api/chat/+server.ts` | The one service that calls models: Express, `@locci/ai-sdk`, tools, optional MCP and a libSQL thread store |
| [`cli/`](cli) | `@locci/example-cli` | `locci-chat-cli` (`cli.ts`, `tui.tsx`) | Terminal clients: `status`, `chat`, `ask`, `mcp list`, and the OpenTUI TUI |
| [`web/`](web) | `@locci/example-web` | `autonomous-chatbot` (SvelteKit) | Browser client: threads in IndexedDB, chat streamed from the API |

```text
cli (status/chat/ask/mcp/tui) ──▶ POST /chat?events=1, GET /info /status /mcp ─┐
                                                                                ├─▶ examples/api ──@locci/ai-sdk──▶ KrakenD :8080 ─▶ gateway ─▶ llama-server
web (SvelteKit SPA)            ──▶ POST /api/chat (UI message stream)  ─────────┘        │
                                                                                tools: weather (OpenWeatherMap), search (Firecrawl), MCP servers
```

The originals each called a provider (Anthropic, OpenAI or Groq) directly. Here only the API does, through the Locci AI Gateway, and the CLI and web are pure clients of it: harmonised onto one service so both exercise the same model, tools and SDK path.

## Run

From the repo root, with the gateway (`just up`) and locci-auth (`just auth`) running:

```bash
just examples-install   # pnpm workspace: SDK + examples
just examples-env       # .env files: tool keys + MCP settings from the original projects, a new Locci API key
just examples-api       # terminal 2: the API on :3939 (rebuilds the SDK first)

just examples-cli status
just examples-cli chat
just examples-cli ask "What is the weather in Nairobi (latitude -1.29, longitude 36.82)?"
just examples-cli mcp list
just examples-tui       # needs Bun
just examples-web       # http://localhost:5173

just examples-check     # regression checks (below)
```

`just examples-env` reads `../locci-chat-cli/.env` and `../../web-apps/autonomous-chatbot/.env` (override with `CHAT_CLI_DIR` / `CHATBOT_DIR`), copies `OPENWEATHERMAP_API_KEY`, `FIRECRAWL_API_KEY` and the `MCP_*` settings plus `mcp.json`, and mints an API key named `locci-ai-inference-examples` through locci-auth. It prints no secrets and leaves existing `.env` files alone unless given `--force`. Every `.env` and `api/mcp.json` is git-ignored; each folder has a committed `.env.example`.

## Regression checks

`just examples-check` (`scripts/examples-check.mjs`) runs against the live API and prints PASS / FAIL / SKIP per check:

| Check | What it proves |
| --- | --- |
| typecheck api, cli, web; web build | The examples still compile against the current SDK and `ai` |
| `/info`, `/status` | API wiring, and a real gateway round trip with the API key |
| CLI protocol: weather tool | `/chat?events=1` streams `tool` → `tool-done` → text → `finish: stop`, with a real OpenWeatherMap result |
| CLI protocol: multi-turn | History is sent and used |
| CLI protocol: MCP tool | An MCP tool (filesystem `list_directory`) runs through the same loop |
| Web protocol | `/api/chat` UI message stream with tool output, and CORS for the web origin |
| `cli ask --json` | The CLI binary itself, end to end |

Checks that need a missing key or MCP server are skipped, not failed. `--no-static` skips typecheck and the build. The interactive parts (`chat` at a terminal, the TUI, the web UI) were verified by hand: see each section below.

## api

`src/server.ts` endpoints:

| Endpoint | For | Notes |
| --- | --- | --- |
| `GET /info` | CLI, TUI footer | Model, gateway, tools, MCP servers; no model call |
| `GET /status` | `cli status` | `/info` plus a tiny live completion through the gateway |
| `POST /chat` | CLI, TUI | Body `{ messages: ModelMessage[], system? }`. Plain text stream, or NDJSON events with `?events=1`: `text`, `tool`, `tool-input`, `tool-done`, `finish` (new: `reason` and `usage`, so clients can flag cut-off answers), `error` |
| `GET /mcp` | `cli mcp list` | Per-server MCP status and tool names (the CLI no longer connects to MCP itself) |
| `POST /api/chat` | web | Body `{ messages: UIMessage[] }`; the AI SDK UI message stream `Chat` consumes. Uses autonomous-chatbot's system prompt and step limit |
| `/api/threads` | web (optional) | libSQL thread store, only with `THREAD_STORE=libsql`; 404 otherwise |

- **Model:** `MODEL` (default `qwen3-1.7b`) through `@locci/ai-sdk` (`src/provider.ts`), authenticated with `LOCCI_API_KEY` (or `LOCCI_ACCESS_TOKEN`).
- **Tools** (`src/tools.ts`): autonomous-chatbot's `weather` and `search`, unchanged, each registered only if its key is set; plus MCP tools from `mcp.json` (`src/mcp.ts`, unchanged from locci-chat-cli). Built-ins win a name clash. Both clients get every tool.
- **Thread store** (`src/threads.ts`): a `ThreadStore` interface with a libSQL implementation (`THREADS_DB_URL`, default `file:./data/threads.db`), mirroring autonomous-chatbot's Drizzle schema. Verified: create, sync (tool parts kept), get, star, list, delete.
- **CORS:** `CORS_ORIGIN` allowlist, default the web dev and preview origins.

## cli

`src/cli.ts`, `src/tui.tsx`, `src/markdown.tsx`, behaviour unchanged from locci-chat-cli except:

- `ask <prompt...>` is new: one-shot, prints the answer (tool activity on stderr), exits non-zero on error or an empty answer; `--json` prints one summary object for scripts.
- `mcp list` asks the API's `/mcp` instead of starting MCP servers itself.
- `chat`, `ask` and the TUI flag answers cut off by the token limit (the API's `finish` event).
- The TUI defaults to the API on `:3939` (the original pointed at `:3000`).

Verified by hand: `status`, `mcp list`, `ask`, interactive `chat`, and the TUI starting and reading `/info` under a pseudo-terminal. Piping several lines into `chat` only answers the first (readline drops lines that arrive before the next prompt; the original behaves the same); use `ask` or the API for scripted multi-turn.

## web

autonomous-chatbot's components, layout and routes, unchanged except:

- **Client-only:** `@sveltejs/adapter-static` with an SPA fallback and `ssr = false`; no server routes, no server env.
- **Chat:** `Chat` from `@ai-sdk/svelte` with a `DefaultChatTransport` to `${PUBLIC_API_URL}/api/chat` (`src/lib/components/Chat.svelte`).
- **Threads** (`src/lib/storage/threads.ts`): the same `ThreadStore` interface as the API, with `LocalbaseThreadStore` (IndexedDB via `localbase`, the default) and `ApiThreadStore` (the API's libSQL store). Pick with `PUBLIC_THREAD_STORE=indexeddb|api`. `conversationState` keeps its original functions, now over the store.
- **Upgraded** to `ai@7` / `@ai-sdk/svelte@5` (the original was on `ai@6`). Dropped server-only dependencies (Groq, Firecrawl, Drizzle, libSQL, zod).

Verified in Chrome: create a thread, ask for the weather, the `weather` tool card and the answer stream in, and after a reload the thread, tool card and answer come back from IndexedDB, with no console errors. `svelte-check` reports four accessibility warnings in `Modal.svelte`, carried over unchanged from the original.

## Findings so far

- **Tool schemas overflowed the context window.** With 16 tools the API's first request was 2,567 tokens against a 2048-token per-request window and the gateway rejected it. The `qwen3-1.7b` node now runs `-c 16384 --parallel 2` (8192 per request); see [docs/LLAMA_SERVER.md](../docs/LLAMA_SERVER.md#context-is-split-across-slots).
- **Plain-text `/chat` hides errors.** Without `?events=1`, a failed request returns an empty `200` (the text stream has no error channel). Same in the original; the CLI and TUI use the events mode.
- **MCP environment:** `loccibox` crashes on start (its installed build is missing `commander`), and `locci-cloud` needs a server on `localhost:3000`. The API records both as failed and carries on with the filesystem server.
- **Latency:** the first tool-calling request in a conversation takes ~25 s on the local CPU stack (~5,200 prompt tokens, mostly tool schemas); later ones reuse the node's prompt cache and take 4 to 8 s.
