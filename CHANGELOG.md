# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every entry ends with the short hash of the commit that made it. `scripts/changelog.sh`
and the git hooks keep the list complete; see [CONTRIBUTING.md](CONTRIBUTING.md#changelog).

## [Unreleased]

### Added

- Initial working stack: KrakenD edge with locci-auth JWTs, the Go/Gin router with per-tenant metering, Nginx pools and llama-server, fixed up from REFERENCE.md so it runs (`9ab2f42`)
- Add a justfile for dev commands (`3b38679`)
- Add build and run recipes for the gateway binary (`1337ca7`)
- Add @locci/ai-sdk, a Vercel AI SDK provider for the gateway (`af32365`)
- Add verified API and SDK usage docs (`8dfe8a6`)
- Add llama-server and SLM docs, tool-calling checks for the API and SDK (`ed24b2f`)
- Document which model id to use for each endpoint (`0c914e4`)
- Add api, cli and web example apps on @locci/ai-sdk in a pnpm workspace (`de0da8a`)
- Document Qwen candidate models with resource estimates and add gguf-info (`cded830`)
- Add code of conduct, contributing guide, security policy and MIT/Apache-2.0 licenses (`f828cac`)
- Add hi@mt0.dev as the security and conduct contact (`3fd65b1`)
- Add listModels to @locci/ai-sdk for model pickers (`2f01802`)
- Let the example API serve /models, pick a model per chat and run web search itself (`5dae9aa`)
- Turn long pastes into previewable files and collapse long messages in the web UI (`267f914`)
- Add a Keep a Changelog CHANGELOG.md kept in step by git hooks (`856e0a6`)
- Full-text chat search, a See all chats link, pointer cursors and animated copy icons in the web chat (`9a282fc`)
- Document resumable chat streams (memory and Ursula) and request idempotency in BACKLOG.md (`76ad3bf`)
- Resumable web replies with request ids and idempotent sends, behind RESUMABLE_STREAMS (memory store) (`9c5c631`)
- Ursula store for resumable web replies behind KrakenD, scoped per tenant (RESUMABLE_STREAMS=ursula) (`9b5a7ed`)
- AUTH=locci on the example API verifies Locci tokens and keeps threads and resumable replies per user (`e492888`)
- web sign-in with Locci (PKCE, email and password only) when the API runs AUTH=locci (`b21084a`)
- Document web sign-in and add the AUTH=locci check to examples-check (`7ad045b`)
- blobatar beside the signed-in email and an Account card (blobatar, email, tenant ID) at the top of Settings (`4b590cd`)
- Document resumable replies and Ursula durability in docs/RESUMABILITY.md (`1fac275`)
- bearer auth on /chat with AUTH=locci; the CLI and TUI send LOCCI_ACCESS_TOKEN or an exchanged LOCCI_API_KEY (`baf9aca`)
- import chats a browser kept before sign-in into the signed-in user's chats (`7586e37`)
- gemma-4-e2b pool (Gemma 4 E2B with its vision projector, opt-in profile gemma), measured in docs/SLMS.md (`a7148d8`)
- photo uploads in the web chat (pick, paste or drop; resized in the browser) for models that read images, with an API guard for the rest (`9fdf435`)
- locci-chat login, logout and whoami (browser PKCE login, session in ~/.locci, refreshed per request) with a branded callback page (`b4c6bbb`)
- Document the CLI agent plan in BACKLOG.md: client-side shell tool, Locci Box agent boxes, --continue/--resume, compaction (`2891e5c`)
- CLI agent tools for chat and the TUI (shell, read, write and edit files with approval, folder trust, YOLO via --yolo or /auto, !commands, Esc to stop), TUI composer, /model, /think and history, gemma-4-e2b by default (`7d1daa4`)
- compiled CLI binary (just examples-cli-build), Gemma at 32768 tokens per request with older tool output trimmed per round, /chat keep-alive pings and one clear context error; mcp.json from ~/.locci/ai in examples-env, tmp/ ignored (`e3b7c26`)
- CLI background tasks (shell background, tasks tool, !cmd &, ctrl+b, /tasks, /kill), yes-to-all at approvals, 30-round cap with a repeat guard, a guard on installs into a parent project, and commands tied to the CLI so none outlive it (`96d90d6`)
- the web chat offers loccibox's agent boxes (box_create, box_exec, box_write_file, box_read_file, box_stop) kept per signed-in user, and says it searches the web (`ac17b34`)

### Changed

- Rename docker-compose.yml to compose.yaml (`8e0c4d6`)
- Rename LOCCI to LOCCI_AI_GATEWAY in API docs and ignore .DS_Store (`1d0c81e`)
- Swap in Qwen3-1.7B and PaddleOCR-VL 1.6, pin llama.cpp, add OCR checks and docs (`ffcf99e`)
- Split coder ids into qwen3-1.7b and qwen2.5-coder-1.5b pools (`c96a80c`)
- Show the CLI's output when the examples ask check fails (`2d9851d`)
- Rename example packages to @locci/example-ai-* (`81f0b72`)
- Ignore Python bytecode caches (`1e22fa5`)
- Redesign the web example as the Locci AI chat UI on shadcn-svelte (`cf1d692`)
- Show the thinking indicator as shimmering text with a typing-dot ellipsis (`d3a5674`)
- Use canonical Tailwind classes in the chat view (`c260baf`)
- Move the reference fixes into REFERENCE.md and open issues into BACKLOG.md (`0ca9cd0`)
- Show the loccibox MCP server's env settings in the example config (`a27ef33`)
- Give qwen3 a 16k window per request with a q8 KV cache and make the qwen2.5 pool opt-in (`5613cfa`)
- Plan web searches from the conversation, reuse earlier results, and search thread contents in the API (`a24caf3`)
- Ursula store appends only and KrakenD /v1/streams forwards to the Ursula gateway (events.locci.cloud, template stack locally) (`6d3c01f`)
- /v1/streams back to this repo's Ursula service; events.locci.cloud is the production backend (`85856e1`)
- Record the browser sign-in check in BACKLOG.md (`86cc15e`)
- the CLI keeps its login, history and trusted folders in ~/.locci/ai (moved there on first use), and the API reads ~/.locci/ai/mcp.json when it has no MCP config (`1850b94`)
- faster CLI agent turns on Gemma: prompt-cache warm-up at chat start, history sent unchanged until it is long, no default thinking (`d7aa107`)
- the TUI shows how many background tasks are running under the input (2 tasks), ahead of the list (`5a0a770`)
- gemma-4-e2b is the default pool for just up; qwen3-1.7b moves to the qwen3 profile and just models fetches Qwen only with --qwen (`bc898b2`)

### Fixed

- Return JSON for unavailable pools and the requested model id in responses (`33dcdba`)
- Cap llama-server prompt cache RAM to stop OOM kills under tool load (`a3246a9`)
- Trim web search results to fit the model's context window (`5928f1e`)
- Fit web chats into the model's context and keep attachments readable to it (`91997f2`)
- Stop pnpm's npm_config variables reaching npx-based MCP servers (`82cda7a`)
- Size the web context budget from the loaded tools, retry on overflow, and prompt the model to search first (`f5397a3`)
- web sign-in opens locci-auth's own sign-in page instead of forcing email and password (`d1f8739`)
- the CLI and TUI get the MCP tools again except the filesystem server's (CLI_TOOLS), so loccibox boxes work from the TUI; the footer counts the tools the chat gets (`d4d59cd`)

