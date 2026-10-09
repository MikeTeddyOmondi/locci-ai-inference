# Locci AI Inference

Streaming-first gateway for specialized small language models (SLMs) behind an OpenAI-compatible API, with per-tenant token metering. The full design is in [REFERENCE.md](REFERENCE.md), which ends with what this repo changed to make it run. This README covers running it; [CHANGELOG.md](CHANGELOG.md) lists every change and [BACKLOG.md](BACKLOG.md) what is still open.

```text
Client --Bearer JWT--> KrakenD :8080 --X-Locci-Tenant--> locci-ai-gateway --> Nginx --> llama-server pools
                       (JWT, rate limit)                 (route, meter)      (least_conn)  coder / vision / embed
```

## Layout

| Path | What |
| --- | --- |
| `locci-ai-gateway/` | Go/Gin router: model registry, SSE proxy, async metering (`main.go`, tests in `main_test.go`) |
| `nginx/nginx.conf` | Pools with `least_conn`; buffering off; `resolve` so absent pools don't stop nginx from starting |
| `krakend/` | Edge config; validates against locci-auth's JWKS at `host.docker.internal:8787` |
| `scripts/` | `fetch-models.sh`, `locci-auth-token.sh`, and the checks: `smoke.sh`, `tool-calls-api.sh`, `ocr-api.sh` (with images in `scripts/fixtures/`) |
| `models/` | GGUF files (git-ignored) |
| `ursula/` | Config for the opt-in Ursula event stream store (`--profile ursula`, `just ursula-up`): records web chat replies so they resume after a reload, reached only through KrakenD's `/v1/streams` |
| `docs/` | [API_USAGE.md](docs/API_USAGE.md) (curl), [SDK_USAGE.md](docs/SDK_USAGE.md) (`@locci/ai-sdk`), [LLAMA_SERVER.md](docs/LLAMA_SERVER.md) (inference nodes, flags, templates, tool calling), [SLMS.md](docs/SLMS.md) (models we run, measurements, candidates including Baidu's Unlimited-OCR), [RESUMABILITY.md](docs/RESUMABILITY.md) (resumable, idempotent web replies and what Ursula adds) |
| `packages/` | Client libraries; see [packages/README.md](packages/README.md). `@locci/ai-sdk` is the Vercel AI SDK provider |
| `examples/` | Real apps on `@locci/ai-sdk` for catching regressions: `api` (shared chat API), `cli` (terminal + TUI), `web` (the Locci AI chat UI, SvelteKit + shadcn-svelte); see [examples/README.md](examples/README.md) |
| `pnpm-workspace.yaml` | One pnpm workspace for `packages/*` and `examples/*`; run `pnpm install` at the root |

## Dev commands

Everything below is wrapped in `.justfile`; run `just` to list the recipes. The usual loop:

```bash
just auth        # terminal 1: locci-auth on :8787
just models      # once (add --vision --embed for the optional pools)
just up          # build, start the qwen3-1.7b pool, wait for healthy (just up-all adds qwen2.5-coder, vision, embed)
just chat "Reverse a string in Go"     # flags answers cut off by max_tokens; just chat "..." <model> <max_tokens>
just meter       # follow per-tenant usage
just down
```

Checks against the running stack, all through the public edge:

```bash
just smoke       # health, 401, 400, /v1/models, a streamed chat, meter lines
just tools-api   # tool calling over curl: forced call, result round trip, streamed call
just tools-sdk   # the same through the AI SDK and @locci/ai-sdk
just ocr-api     # PaddleOCR-VL on the fixture images (vision pool; minutes on CPU)
just sdk-e2e     # @locci/ai-sdk end to end (API-key exchange, streaming, errors)
just examples-check  # the example apps: CLI and web protocols through examples/api (needs just examples-api)
```

Working on the Go router itself, like `locci-bundler`'s recipes:

```bash
just check       # gofmt check, vet, test
just build       # -> locci-ai-gateway/bin/locci-ai-gateway
just run         # build, then run on :8090 against the stack's nginx (127.0.0.1:8082)
just run-bin     # same, via `go run`
just chat-local  # stream a chat straight to the host-run router (no KrakenD; X-Locci-Tenant set by hand)
just up-gateway  # rebuild and restart the router container instead
```

## Quick start

Auth comes from [locci-auth](../locci-auth) running locally. Its users are the tenants: KrakenD validates the ES256 access token against locci-auth's JWKS and propagates `properties.id` as `X-Locci-Tenant` (and `properties.email` as `X-Locci-Email`).

```bash
(cd ../locci-auth && npx wrangler dev --port 8787)   # separate terminal; locci-auth master (issuer fix, PR #5)
scripts/fetch-models.sh            # 2.3 GB of coder models; add --vision (1.8 GB) / --embed (80 MB)
docker compose up --build -d       # first start waits for the two coder pools to load their models
scripts/smoke.sh                   # health, 401, 400, /v1/models, a streamed chat, and meter lines
```

`scripts/locci-auth-token.sh [user_id]` mints a 1h user token through locci-auth's `/internal/push-deploy-token`, using `SERVICE_TOKEN` from `../locci-auth/.dev.vars`. With no argument it uses the first user in locci-auth's local D1.

KrakenD fetches the JWKS from `http://host.docker.internal:8787/.well-known/jwks.json` (cached 15 min) and requires `iss` to be exactly `http://localhost:8787`, locci-auth's `AUTH_PUBLIC_ORIGIN`. A locci-auth older than its PR #5 (`fix/issuer-forwarded-proto`) mints `https://localhost:8787` from its service and API-key routes, which KrakenD rejects with 401. The `krakend` service maps `host.docker.internal` to `host-gateway`, which reaches the host's loopback under both Colima and Docker Desktop, so plain `wrangler dev` on 127.0.0.1 is enough. `172.17.0.1` does not work under Colima: it is the bridge inside the VM, not the Mac. In production the URL is `https://auth.locci.cloud/.well-known/jwks.json` with `issuer` set and `disable_jwk_security: false`.

Manual request:

```bash
TOKEN=$(scripts/locci-auth-token.sh)
curl -N http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"qwen3-1.7b","stream":true,"messages":[{"role":"user","content":"Reverse a string in Go"}]}'
docker compose logs locci-ai-gateway | grep meter
```

Optional pools: `docker compose --profile vision --profile embed up -d`. Until those run, `baidu-ocr-vision` and `embedding-nomic` return `502`.

KrakenD's `/v1/streams` endpoints front Ursula, the event stream store the example API uses with `RESUMABLE_STREAMS=ursula`. They check the token, name each stream after the token's subject (`/chats/<sub>--<stream>`) so callers only reach their own streams, and forward to `ursula:4437`, this repo's Ursula (`just ursula-up`, no published port since Ursula has no auth). In production the backend is `https://events.locci.cloud` instead, whose gateway checks the forwarded token again and has no DELETE route, so the store only appends. Until Ursula runs, those endpoints return `5xx` and the API records nothing (chat still works).

## Models

All on llama.cpp `server-b11434` (pinned), CPU only in the local Colima VM (4 vCPU, 7.7 GiB).

| Requested `model` | Pool | Running | Measured here |
| --- | --- | --- | --- |
| `qwen3-1.7b` | `/coder` (1 node) | Qwen3-1.7B Q4_K_M, `--reasoning off`, 16384 tokens per request (q8_0 KV cache) | ~50 tokens/s; tool calling passes every check; 3.1 to 4.2 GiB |
| `qwen2.5-coder-1.5b` | `/qwen25-coder` (1 node, opt-in) | Qwen2.5-Coder-1.5B-Instruct Q4_K_M | ~56 tokens/s; code generation; **cannot call tools**; 1.25 to 2.3 GiB |
| `baidu-ocr-vision` | vision (`--profile vision`) | PaddleOCR-VL 1.6 + mmproj | Exact text and table recognition on the fixtures; 2 to 3 min per new image on CPU |
| `embedding-nomic` | embed (`--profile embed`) | nomic-embed-text v1.5 Q4_K_M | 768 dims; inputs over 512 tokens fail until `-ub` is raised |

### Which model for what

| Model id | Call it with | `just chat` | Wrong use gives |
| --- | --- | --- | --- |
| `qwen3-1.7b` | `/v1/chat/completions`; SDK `streamText` / `generateText`, tools. `just chat`'s default | Yes | |
| `qwen2.5-coder-1.5b` | `/v1/chat/completions`; SDK `streamText` / `generateText`. Code generation, no tools | Yes | With `tools`, the call comes back as plain text in `content` (no `tool_calls`); with `tool_choice: "required"` it runs to `max_tokens` |
| `baidu-ocr-vision` | `/v1/chat/completions` with an image plus a task prompt (`OCR:`, `Table Recognition:`, ...); SDK `generateText` with a `file` part | No | Junk text for a text-only prompt (measured: `貨貨`) |
| `embedding-nomic` | `/v1/embeddings`; SDK `embed` / `embedMany` | No | An empty chat stream with no `finish_reason` |

```bash
just chat "Solve two sum in JavaScript"                            # qwen3-1.7b, max_tokens 1024
just chat "Solve two sum in JavaScript" qwen2.5-coder-1.5b 2048 # model, then max_tokens
just list-models                                           # ids the gateway routes
```

`just list-models` lists every id even when its pool is stopped (that request gets a `502`). `just up` starts the `qwen3-1.7b` pool; `just up-all` adds qwen2.5-coder, vision and embed. Examples per endpoint: [docs/API_USAGE.md](docs/API_USAGE.md) (curl) and [docs/SDK_USAGE.md](docs/SDK_USAGE.md).

Ids name the model running in each pool. Swap files with `.env` (see `.env.example`), or try one without editing: `CODER_MODEL=<file>.gguf docker compose up -d llama-coder-1`. Why these models, what was tried, and candidates (Qwen 3.5, Gemma 4, LFM2.5, Unlimited-OCR, Qwen3-Embedding): [docs/SLMS.md](docs/SLMS.md). Flags, context per request (16384 tokens on `qwen3-1.7b`, 2048 on `qwen2.5-coder-1.5b`; see [API_USAGE.md](docs/API_USAGE.md#context-window)) and performance: [docs/LLAMA_SERVER.md](docs/LLAMA_SERVER.md).

## Router development

```bash
cd locci-ai-gateway
go test ./...
UPSTREAM_URL=http://localhost:8082 LISTEN_ADDR=:8090 go run .   # nginx is published on 127.0.0.1:8082
```

## Contributing, security and conduct

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks each change needs and the repo's conventions; [SECURITY.md](SECURITY.md) to report a vulnerability privately ([hi@mt0.dev](mailto:hi@mt0.dev)); and the [Code of Conduct](CODE_OF_CONDUCT.md) (Mozilla's Community Participation Guidelines).

## License

Dual-licensed under either of [Apache License, Version 2.0](APACHE_LICENSE.md) or [MIT](MIT_LICENSE.md), at your option. Contributions are accepted under the same terms (see [CONTRIBUTING.md](CONTRIBUTING.md#license)).
