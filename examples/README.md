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
| Web resume | a reply dropped after its first chunk replays in full from `GET /api/chat/:threadId/stream`; the same `requestId` again returns the identical reply, and with another message `409` (skipped with `RESUMABLE_STREAMS=off`) |
| Web auth | with `AUTH=locci`: `/api` routes answer `401` without a token or with a bad one and accept a Locci token (from `LOCCI_ACCESS_TOKEN`, or `LOCCI_API_KEY` exchanged at `/keys/token`, read from the environment or `examples/api/.env`); the web checks then send it (skipped with `AUTH=off`) |
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
| `GET /models` | web | `{ default, models: [{ id, description, tools, disabled? }], maxInputChars }`: the gateway's chat models (embeddings left out), from `listModels()` in `@locci/ai-sdk`, cached for a minute. Falls back to the configured model alone if the gateway can't be listed |
| `POST /api/chat` | web | Body `{ messages: UIMessage[], model?, webSearch?, threadId?, requestId? }` (`requestId` may also come as an `Idempotency-Key` header; it is echoed as `X-Request-Id`); the AI SDK UI message stream `Chat` consumes. Uses autonomous-chatbot's system prompt and step limit. `model` must be one `/models` offers (else `400`); only models that can call tools get them. `webSearch: true` runs the `search` tool on the API first, streams it as a tool call, then the model answers from the results |
| `GET /api/chat/:threadId/stream` | web | The thread's latest reply, replayed from its start then followed live (the AI SDK's `chat.resumeStream()`); `204` when there is none |
| `DELETE /api/chat/:threadId/stream` | web | Stop that reply (`204`, or `404` when none is running) |
| `/api/threads` | web (optional) | libSQL thread store, only with `THREAD_STORE=libsql`; 404 otherwise |

- **Model:** `MODEL` (default `qwen3-1.7b`) through `@locci/ai-sdk` (`src/provider.ts`), authenticated with `LOCCI_API_KEY` (or `LOCCI_ACCESS_TOKEN`). The web client may pick another gateway model per request; `MODEL_INFO` in `src/provider.ts` adds a description and whether it can call tools (`qwen2.5-coder-1.5b` cannot, so it gets none).
- **Resumable replies** (`src/resumable/`, `RESUMABLE_STREAMS=memory|ursula|off`, default `memory`): a web chat sends its `threadId` and a fresh `requestId` with each message, and the API records the reply's UI message stream per thread as it is sent. The reply keeps running if the browser goes away (the recording reads its own copy of the stream), and reopening the chat replays it from the start and follows it live. The web app saves the question when it is sent and the thread only when a reply ends, so "last saved message is the user's" is the signal to resume, and a saved reply is never replayed twice. Because a disconnect no longer stops the model, Stop also calls `DELETE /api/chat/:threadId/stream`. The recording starts with the request id: a repeated request is answered from it with no second model call, and the same request id for a different message is a `409`. Requests without a `threadId` (the CLI, temporary chats) are not recorded. Finished replies stay replayable for 10 minutes; the memory store is per process and lost on restart. Log lines for a request carry the first 8 characters of its id.
- **Sign-in** (`src/auth.ts`, `AUTH=locci|off`, default `off`): as OpenAuth's `jwt-api` example, `/api/chat`, `/api/chat/:threadId/stream` and `/api/threads` read `Authorization: Bearer`, verify it with `@openauthjs/openauth`'s client against `LOCCI_AUTH_URL` (signature, issuer, expiry) and answer `401` otherwise. Tokens from a Locci API key verify too, so curl and scripts can call these routes. The verified user owns what they create: libSQL threads carry an `owner` column (added on start to older databases; their rows belong to `AUTH=off`) and every query filters on it, so another user's thread id is a `404`; memory recordings and running replies are keyed by user; the Ursula store sends the user's own token, so KrakenD's `{JWT.sub}` prefix (`user:<hash>` for a signed-in user) is theirs and the gateway, not the API, keeps users apart. Model calls still use the API's key. `/info` reports `auth`, and with `locci` the `authIssuer` and `authClientId` (`AUTH_CLIENT_ID`, default `locci-ai-chat`) the web app signs in with. `/chat` (the CLI protocol, which stores nothing) stays open.
- **Ursula store** (`RESUMABLE_STREAMS=ursula`, `src/resumable/ursula.ts`): recordings go to Ursula through KrakenD's `/v1/streams` (`URSULA_URL`), authenticated with the same Locci token as model calls. KrakenD names each stream after the token's `sub` claim, so a caller only reaches its own threads (the nested `properties.id` claim is not substituted in a `url_pattern`; it came through as a literal placeholder, which would have put every tenant in one namespace), then forwards to Ursula (this repo's compose service locally, the `events.locci.cloud` gateway in production). The production gateway has no DELETE, so the store only appends: each thread has an index stream with one `{requestId, messageId}` line per turn, and each turn's reply goes to `<threadId>.<requestId>` as the SSE text plus an end marker. Resume follows the last turn; a repeated request id, for any earlier turn, replays that turn's reply. Reads are a catch-up GET then long-polls from `Stream-Next-Offset`, not Ursula's live SSE, because KrakenD CE held a streamed GET until about 4 KB had built up. Appends are batched (50 ms or 16 KB). Verified: replay after a disconnect, idempotent repeat (also for an earlier turn), 409, Stop, resume following the newest of two turns; a reply generated on one API instance resumed live from another; replay after restarting Ursula; with Ursula stopped, chat still answers and resume returns `204`. A recording whose API died mid-reply ends after 2 minutes with no new data.
- **Web search policy** (`/api/chat`, `src/search-plan.ts`): before the model answers, the API decides whether to search and what for, then searches at most once per turn. Prompt rules alone weren't enough on a 1.7B model: "teach me reqwest in a detailed tutorial" never searched (0 of 3), adding "give up to date information" always did but repeated the same query up to three times, and a pasted document triggered five searches and no answer. Searching the raw message instead fails on follow-ups ("give me another example" searches for those words) and fills the context with unrelated pages. So:
  - **No search**, decided by wording: small talk, a message with an attached file or long paste (the attachment is the source), the weather (its own tool), translation, and reworking earlier text ("make that shorter").
  - **Otherwise the model plans the query** from the last few turns, with worked examples in the prompt (without them it answered NONE to "teach me reqwest" or answered the question instead). Measured: "teach me reqwest" gives `reqwest rust http tutorial`, the follow-up "give me another example" gives `reqwest rust http example`, "tell me more about the second one" after a list of crates gives `ureq rust http client`; under a second each. NONE skips the search.
  - **Off-topic results are dropped**: a result sharing no keyword with the query never reaches the model.
  - **Earlier results are reused.** The client sends the whole thread every turn, earlier search results included, so a follow-up can often be answered from what is already there. The planner sees earlier searches (query and titles), but the 1.7B model writes a new query for nearly every follow-up, so the API also checks in code: if every topic word of the planned query appears in an earlier query or its results, the search is skipped and the model is told to answer from the earlier results. Measured after a `reqwest rust http tutorial` search: "show me a POST example with JSON" and "explain the GET part in more detail" skip the search; "how do I configure a proxy and custom TLS certificates?" searches `reqwest rust proxy tls certificate configure`.
  - With `AUTO_SEARCH` on, the model never gets the `search` tool itself (the API's decision stands). Otherwise it is withdrawn after one search, and tools are removed (the model must answer) on the last of the 5 steps, after 4 tool calls in total, and straight away when the message has an attachment. Removed, not just switched off: with their schemas still in the prompt the model wrote a `<tool_call>` out as text.
  - `AUTO_SEARCH=off` leaves searching to the model; the composer's "Search the web" toggle forces a search either way.
- **Web chat tools:** `/api/chat` offers only the built-ins (`weather`, `search`) by default; the CLI and TUI keep every tool. With all 19 (loccibox and filesystem MCP included) the 1.7B model called the sandbox to "run" a tutorial and filesystem tools on invented paths, once making 63 calls and never answering. `WEB_TOOLS` takes a comma list of tool names, or `all`. Fewer schemas also leave more of the window for the conversation.
- **System prompt** (`webSystemPrompt` in `src/tools.ts`): numbered rules with today's date, telling the model its knowledge is out of date, to answer from the search results rather than memory, and to cite sources. Tool rules are only included for tools the request has (none for `qwen2.5-coder-1.5b`, no search rule without a Firecrawl key).
- **Tools** (`src/tools.ts`): autonomous-chatbot's `weather` and `search`, each registered only if its key is set (`search` now reads Firecrawl 4.x's `web` results, since the original's `success`/`data` check failed every call; it also strips links and images from the scraped markdown, skips pages that failed to scrape, and caps all results together at `SEARCH_MAX_CHARS`, default 4000, so one Wikipedia page can't overflow the model's 8192-token window); plus MCP tools from `mcp.json` (`src/mcp.ts`, unchanged from locci-chat-cli). Built-ins win a name clash. Both clients get every tool.
- **Thread store** (`src/threads.ts`): a `ThreadStore` interface with a libSQL implementation (`THREADS_DB_URL`, default `file:./data/threads.db`), mirroring autonomous-chatbot's Drizzle schema. Verified: create, sync (tool parts kept), get, star, list, delete.
- **Context budget** (`src/context.ts`): `/api/chat` fits the conversation into what the model's window per request (16384 for `qwen3-1.7b`, 2048 for `qwen2.5-coder-1.5b`; `MODEL_CONTEXT_TOKENS` overrides it for `MODEL`) leaves after the system prompt and tool schemas (measured from the tools loaded at startup: ~2,980 tokens with loccibox, filesystem, weather and search), a tool result and the answer; `MAX_INPUT_CHARS` optionally caps it. The estimate can miss on dense code or JSON (~1.5 characters per token), so a model middleware catches llama.cpp's "request (N tokens) exceeds the available context size" rejection, shortens the prompt's largest parts by the reported excess, and retries once. Longer input is shortened: the latest message's largest parts first (pasted text, files), with a note to the model, then the oldest turns are dropped. The UI keeps the full text. Attachments are rewritten for the model as "Text the user pasted" / "Contents of the user's file X", placed before the question, because a `.md` name invited the model to open it with the filesystem tools; and a reply that is just a tool call printed as text is left out of the history together with its question, so the model doesn't copy it. Without this a pasted docs page (~31k tokens) was rejected by llama.cpp outright.
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
- **Layout:** sidebar with pinned and recent chats (the 20 most recent, then a "See all chats" link to `/chats`, which the collapsed rail also links), rename, pin and delete. **Search** (sidebar and `/chats`) matches titles and the text of every message, pasted text included, and shows the text around the match; with `PUBLIC_THREAD_STORE=api` it uses the API's `GET /api/threads/search?q=`. The sidebar search box closes on New chat, Escape, or a click outside it and its results. The sidebar collapses to an icon rail on desktop and is a sheet on mobile. The top bar keeps temporary chat and theme on desktop; on mobile everything is in one "..." menu. Uses `h-dvh` and safe-area padding so the composer stays visible on phones.
- **Composer** (`src/lib/components/Composer.svelte`): the text box on top (grows to ~10 lines, then scrolls), controls underneath: "+" menu (text and code files as attachments, web search toggle), model picker, voice input (Web Speech API), then Send/Stop. Enter sends on desktop, Cmd/Ctrl+Enter everywhere. A paste over 2,000 characters or 30 lines becomes a "Pasted text.md" attachment instead of filling the box, with a notice when it is longer than the model reads (`maxInputChars`).
- **Models:** `ModelPicker.svelte` lists the API's `GET /models`; the pick is remembered in `localStorage` and sent as `model`. Settings lists the same models.
- **Messages:** markdown via marked + DOMPurify, code blocks highlighted by Shiki (`src/lib/markdown.svelte.ts`: JavaScript regex engine, grammars loaded on first use, light and dark themes switched in CSS) with a copy button; collapsible tool cards; copy and regenerate. Long sent messages collapse to ~10 lines with a fade and a "Show more" button (`CollapsibleText.svelte`); attachments show as file cards (`FileChip.svelte`) that open a preview dialog with size and line count. Sent messages can be edited in place, which replaces that turn and everything after it (`sendMessage` with `messageId`).
- **Temporary chats:** never written to the thread store.
- **Sign-in** (`src/lib/state/auth.svelte.ts`, `SignIn.svelte`): when the API's `/info` says `auth: locci`, the app shows a sign-in screen until the user signs in, as OpenAuth's React SPA example does it: the PKCE code flow against `authIssuer`, straight to locci-auth's email and password page (`provider: 'password'`; no GitHub button), redirect back to the app's origin, the refresh token in `localStorage` and the access token in memory, refreshed one at a time before it expires, and sent as `Authorization: Bearer` on chat, resume, Stop and thread calls. The sidebar shows the email and Sign out. Signed in, the browser thread store is one IndexedDB database per user. The refresh token in `localStorage` is readable by any script on the page, as in the OpenAuth example; something beyond an example wants an httpOnly cookie set by a server. With `AUTH=off` nothing changes.
- **Settings** (`/settings`): theme, models, export chats as JSON, delete all, API status.
- **Threads** (`src/lib/storage/threads.ts`): the same `ThreadStore` interface as the API, with `LocalbaseThreadStore` (IndexedDB via `localbase`, the default) and `ApiThreadStore` (the API's libSQL store). Pick with `PUBLIC_THREAD_STORE=indexeddb|api`. Localbase keeps query state on its instance, so the store runs its operations one at a time.
- **Upgraded** to `ai@7` / `@ai-sdk/svelte@5` (the original was on `ai@6`). Dropped server-only dependencies (Groq, Firecrawl, Drizzle, libSQL, zod).

Verified in Chrome at 360 px and 1440 px, light and dark: streaming with tool cards, shallow routing to `/chats/<id>` without interrupting the stream, temporary chats, model switching (the gateway meters the picked model), message edit, web search, reload restoring threads, and no console errors.

## Findings so far

- **Tool schemas overflowed the context window.** With 16 tools the API's first request was 2,567 tokens against a 2048-token per-request window and the gateway rejected it. The `qwen3-1.7b` node now runs `-c 16384 --parallel 2` (8192 per request); see [docs/LLAMA_SERVER.md](../docs/LLAMA_SERVER.md#context-is-split-across-slots).
- **Plain-text `/chat` hides errors.** Without `?events=1`, a failed request returns an empty `200` (the text stream has no error channel). Same in the original; the CLI and TUI use the events mode.
- **pnpm's `npm_config_*` variables made `npx` warn.** An MCP server with its own `env` block inherited the API's environment, including pnpm-only settings (`recursive`, `verify-deps-before-run`, ...), so `npx` printed "Unknown env config" on every start. They are now left out of what MCP servers inherit (`src/mcp.ts`).
- **MCP environment:** `loccibox` crashes on start (its installed build is missing `commander`), and `locci-cloud` needs a server on `localhost:3000`. The API records both as failed and carries on with the filesystem server.
- **The Qwen3 node was OOM-killed under load.** llama-server's host-RAM prompt cache (default cap 8192 MiB) grew the node to 4.3 GiB with these ~5,200-token prompts, and the Colima VM's OOM killer took it; requests during the restart failed with `503 Loading model` (a `/status` failure, and very likely the one earlier `cli ask --json` failure that couldn't be reproduced). Fixed with `--cache-ram 1024`: memory now plateaus at ~3.8 GiB across repeated full check runs, with no restarts. Details in [docs/LLAMA_SERVER.md](../docs/LLAMA_SERVER.md#measured-on-this-machine). The check now prints the CLI's errors, text, tool calls and finish reason if `ask` fails again.
- **Small models don't take a forced tool call.** Forcing `search` by name was ignored by llama.cpp, and `toolChoice: 'required'` made `qwen3-1.7b` print the call as text in a loop. The API now runs the search itself for the web search toggle.
- **Concurrent Localbase calls corrupt each other.** A thread list and a thread load racing on page load returned a single doc instead of an array (`threads.sort is not a function`). Fixed by queueing store operations; the list also skips malformed records.
- **Latency:** the first tool-calling request in a conversation takes ~25 s on the local CPU stack (~5,200 prompt tokens, mostly tool schemas); later ones reuse the node's prompt cache and take 4 to 8 s.
