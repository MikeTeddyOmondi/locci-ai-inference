# examples

Real client apps, ported onto `@locci/ai-sdk`, to catch regressions in the SDK and the gateway the way users would hit them. Each mirrors an existing project:

| Folder | Package | Ported from | What it is |
| --- | --- | --- | --- |
| [`api/`](api) | `@locci/example-ai-api` | `locci-chat-cli/src/server.ts` + `autonomous-chatbot/src/routes/api/chat/+server.ts` | The one service that calls models: Express, `@locci/ai-sdk`, tools, optional MCP and a libSQL thread store |
| [`cli/`](cli) | `@locci/example-ai-cli` | `locci-chat-cli` (`cli.ts`, `tui.tsx`) | Terminal clients: `status`, `chat`, `ask`, `mcp list`, and the OpenTUI TUI |
| [`web/`](web) | `@locci/example-ai-web` | `autonomous-chatbot` (SvelteKit), redesigned as the Locci AI chat UI | Browser client: threads in IndexedDB, chat streamed from the API, model picker |

```text
cli (status/chat/ask/mcp/tui) ──▶ POST /chat?events=1, GET /info /status /mcp ─┐
                                                                                ├─▶ examples/api ──@locci/ai-sdk──▶ KrakenD :8080 ─▶ gateway ─▶ llama-server
web (SvelteKit SPA)            ──▶ POST /api/chat (UI message stream), GET /models ┘        │
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
| `GET /models` | web | `{ default, models: [{ id, description, tools, disabled? }] }`: the gateway's chat models (embeddings left out), from `listModels()` in `@locci/ai-sdk`, cached for a minute. Falls back to the configured model alone if the gateway can't be listed |
| `POST /api/chat` | web | Body `{ messages: UIMessage[], model?, webSearch? }`; the AI SDK UI message stream `Chat` consumes. Uses autonomous-chatbot's system prompt and step limit. `model` must be one `/models` offers (else `400`); only models that can call tools get them. `webSearch: true` runs the `search` tool on the API first, streams it as a tool call, then the model answers from the results |
| `/api/threads` | web (optional) | libSQL thread store, only with `THREAD_STORE=libsql`; 404 otherwise |

- **Model:** `MODEL` (default `qwen3-1.7b`) through `@locci/ai-sdk` (`src/provider.ts`), authenticated with `LOCCI_API_KEY` (or `LOCCI_ACCESS_TOKEN`). The web client may pick another gateway model per request; `MODEL_INFO` in `src/provider.ts` adds a description and whether it can call tools (`qwen2.5-coder-1.5b` cannot, so it gets none).
- **Tools** (`src/tools.ts`): autonomous-chatbot's `weather` and `search`, each registered only if its key is set (`search` now reads Firecrawl 4.x's `web` results, since the original's `success`/`data` check failed every call; it also strips links and images from the scraped markdown, skips pages that failed to scrape, and caps all results together at `SEARCH_MAX_CHARS`, default 4000, so one Wikipedia page can't overflow the model's 8192-token window); plus MCP tools from `mcp.json` (`src/mcp.ts`, unchanged from locci-chat-cli). Built-ins win a name clash. Both clients get every tool.
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

A ChatGPT-style chat UI branded "Locci AI", built as a base to clone for other Locci chat experiences. Started from autonomous-chatbot, now mostly rewritten:

- **Client-only:** `@sveltejs/adapter-static` with an SPA fallback and `ssr = false`; no server routes, no server env.
- **Components:** [shadcn-svelte](https://www.shadcn-svelte.com) (`components.json`, `src/lib/components/ui/`) on bits-ui, with lucide icons. The theme is shadcn's CSS variables in `src/routes/layout.css`; rebrand by changing those and `src/lib/brand.ts` (name, greeting, placeholder, suggestions). `shadcn-svelte/tailwind.css` supplies `scroll-fade` (chat scrollers) and `shimmer` (waiting states).
- **Layout:** sidebar with pinned and recent chats, search, rename, pin and delete; it collapses to an icon rail on desktop and is a sheet on mobile. The top bar keeps temporary chat and theme on desktop; on mobile everything is in one "..." menu. Uses `h-dvh` and safe-area padding so the composer stays visible on phones.
- **Composer** (`src/lib/components/Composer.svelte`): the text box on top, controls underneath: "+" menu (text and code files as attachments, web search toggle), model picker, voice input (Web Speech API), then Send/Stop. Enter sends on desktop, Cmd/Ctrl+Enter everywhere.
- **Models:** `ModelPicker.svelte` lists the API's `GET /models`; the pick is remembered in `localStorage` and sent as `model`. Settings lists the same models.
- **Messages:** markdown via marked + DOMPurify, code blocks highlighted by Shiki (`src/lib/markdown.svelte.ts`: JavaScript regex engine, grammars loaded on first use, light and dark themes switched in CSS) with a copy button; collapsible tool cards; copy and regenerate. Sent messages can be edited in place, which replaces that turn and everything after it (`sendMessage` with `messageId`).
- **Temporary chats:** never written to the thread store.
- **Settings** (`/settings`): theme, models, export chats as JSON, delete all, API status.
- **Threads** (`src/lib/storage/threads.ts`): the same `ThreadStore` interface as the API, with `LocalbaseThreadStore` (IndexedDB via `localbase`, the default) and `ApiThreadStore` (the API's libSQL store). Pick with `PUBLIC_THREAD_STORE=indexeddb|api`. Localbase keeps query state on its instance, so the store runs its operations one at a time.
- **Upgraded** to `ai@7` / `@ai-sdk/svelte@5` (the original was on `ai@6`). Dropped server-only dependencies (Groq, Firecrawl, Drizzle, libSQL, zod).

Verified in Chrome at 360 px and 1440 px, light and dark: streaming with tool cards, shallow routing to `/chats/<id>` without interrupting the stream, temporary chats, model switching (the gateway meters the picked model), message edit, web search, reload restoring threads, and no console errors.

## Findings so far

- **Tool schemas overflowed the context window.** With 16 tools the API's first request was 2,567 tokens against a 2048-token per-request window and the gateway rejected it. The `qwen3-1.7b` node now runs `-c 16384 --parallel 2` (8192 per request); see [docs/LLAMA_SERVER.md](../docs/LLAMA_SERVER.md#context-is-split-across-slots).
- **Plain-text `/chat` hides errors.** Without `?events=1`, a failed request returns an empty `200` (the text stream has no error channel). Same in the original; the CLI and TUI use the events mode.
- **MCP environment:** `loccibox` crashes on start (its installed build is missing `commander`), and `locci-cloud` needs a server on `localhost:3000`. The API records both as failed and carries on with the filesystem server.
- **The Qwen3 node was OOM-killed under load.** llama-server's host-RAM prompt cache (default cap 8192 MiB) grew the node to 4.3 GiB with these ~5,200-token prompts, and the Colima VM's OOM killer took it; requests during the restart failed with `503 Loading model` (a `/status` failure, and very likely the one earlier `cli ask --json` failure that couldn't be reproduced). Fixed with `--cache-ram 1024`: memory now plateaus at ~3.8 GiB across repeated full check runs, with no restarts. Details in [docs/LLAMA_SERVER.md](../docs/LLAMA_SERVER.md#measured-on-this-machine). The check now prints the CLI's errors, text, tool calls and finish reason if `ask` fails again.
- **Small models don't take a forced tool call.** Forcing `search` by name was ignored by llama.cpp, and `toolChoice: 'required'` made `qwen3-1.7b` print the call as text in a loop. The API now runs the search itself for the web search toggle.
- **Concurrent Localbase calls corrupt each other.** A thread list and a thread load racing on page load returned a single doc instead of an array (`threads.sort is not a function`). Fixed by queueing store operations; the list also skips malformed records.
- **Latency:** the first tool-calling request in a conversation takes ~25 s on the local CPU stack (~5,200 prompt tokens, mostly tool schemas); later ones reuse the node's prompt cache and take 4 to 8 s.
