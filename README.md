# Locci AI Inference

Streaming-first gateway for specialized small language models (SLMs) behind an OpenAI-compatible API, with per-tenant token metering. The full design is in [REFERENCE.md](REFERENCE.md). This README covers running it.

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
| `docs/` | [API_USAGE.md](docs/API_USAGE.md) (curl), [SDK_USAGE.md](docs/SDK_USAGE.md) (`@locci/ai-sdk`), [LLAMA_SERVER.md](docs/LLAMA_SERVER.md) (inference nodes, flags, templates, tool calling), [SLMS.md](docs/SLMS.md) (models we run, measurements, candidates including Baidu's Unlimited-OCR) |
| `packages/` | Client libraries; see [packages/README.md](packages/README.md). `@locci/ai-sdk` is the Vercel AI SDK provider |

## Dev commands

Everything below is wrapped in `.justfile`; run `just` to list the recipes. The usual loop:

```bash
just auth        # terminal 1: locci-auth on :8787
just models      # once (add --vision --embed for the optional pools)
just up          # build, start, wait for healthy (just up-all adds vision and embed)
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

## Models

All on llama.cpp `server-b11434` (pinned), CPU only in the local Colima VM (4 vCPU, 7.7 GiB).

| Requested `model` | Pool | Running | Measured here |
| --- | --- | --- | --- |
| `qwen3-1.7b` | `/coder` (1 node) | Qwen3-1.7B Q4_K_M, `--reasoning off` | ~50 tokens/s; tool calling passes every check; ~2.1 GiB |
| `qwen2.5-coder-1.5b` | `/qwen25-coder` (1 node) | Qwen2.5-Coder-1.5B-Instruct Q4_K_M | ~56 tokens/s; code generation; **cannot call tools**; 1.25 to 2.3 GiB |
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

`just list-models` lists every id even when its pool is stopped (that request gets a `502`). `just up` starts the two coder pools; `just up-all` adds vision and embed. Examples per endpoint: [docs/API_USAGE.md](docs/API_USAGE.md) (curl) and [docs/SDK_USAGE.md](docs/SDK_USAGE.md).

Ids name the model running in each pool. Swap files with `.env` (see `.env.example`), or try one without editing: `CODER_MODEL=<file>.gguf docker compose up -d llama-coder-1`. Why these models, what was tried, and candidates (Qwen 3.5, Gemma 4, LFM2.5, Unlimited-OCR, Qwen3-Embedding): [docs/SLMS.md](docs/SLMS.md). Flags, context per request (2048 tokens on the coder nodes) and performance: [docs/LLAMA_SERVER.md](docs/LLAMA_SERVER.md).

## Git hooks

`.githooks/` holds `pre-commit` (rejects added lines with em or en dashes) and `commit-msg` (rejects AI attribution). After cloning, enable them with:

```bash
git config core.hooksPath .githooks
```

## Router development

```bash
cd locci-ai-gateway
go test ./...
UPSTREAM_URL=http://localhost:8082 LISTEN_ADDR=:8090 go run .   # nginx is published on 127.0.0.1:8082
```

## Changes from REFERENCE.md

Fixes needed to make the reference stack actually run:

- Compose: `depends_on: locci-gateway` renamed to `locci-ai-gateway`; the obsolete `version` key dropped; healthchecks added so nginx waits for models to load.
- llama.cpp image moved to `ghcr.io/ggml-org/llama.cpp`, pinned to `server-b11434`. A `llama-embed-1` service is added (nginx referenced it but compose did not define it). Vision and embed sit behind profiles.
- Models and ids: the reference's `qwen-coder-7b` / `qwen-coder-14b` ids are replaced by ids that name what runs. `qwen3-1.7b` (Qwen3-1.7B, tool calling) and `qwen2.5-coder-1.5b` (Qwen2.5-Coder-1.5B, code only; it cannot call tools) each get a pool, and the vision pool runs PaddleOCR-VL 1.6 with its mmproj instead of LLaVA 1.5.
- Nginx: resolver plus `zone` and `resolve` on upstreams. Without these, a missing pool host stops nginx from starting.
- KrakenD: global and endpoint `timeout` raised to 600s (the 2s default cuts off generation). The invalid `router.disable_strict_restful` key is removed. Rate limiting is configured. Added the `/v1/embeddings` and `/v1/models` endpoints. Auth is ES256 against locci-auth instead of an HS256 dev key.
- Router: `/v1/embeddings` shares the chat handler; `/v1/models` lists the registry; responses report the requested model id instead of llama-server's GGUF path; upstream is set by `UPSTREAM_URL`; the Dockerfile copies `go.sum`.
- Errors: a pool that is not running answers `502` in the OpenAI error shape. KrakenD's own `401`/`429` stay empty-bodied (a Community Edition limit; nothing is placed in front of KrakenD, to keep latency down).
- Scaling: use `docker compose up --scale locci-ai-gateway=N` after removing the `8081` debug port mapping.

## Tenant header and spoofing

KrakenD 2.13 only forwards a `propagate_claims` header when that header is also listed in `input_headers`. Without it, the router sees no tenant and answers 401. Listing it would normally let clients send their own value, but the validator overwrites it with the claim. This was verified: a valid token plus `X-Locci-Tenant: evil-tenant` was metered under the token's user id, and the same header without a token got 401 at the edge.

Remaining gap: if a valid token lacks `properties.id`, nothing overwrites the header and a client-supplied value would pass through. Every locci-auth user token carries `properties.id` today. Keep it that way, or have KrakenD strip the header first.

## Not production-ready yet

- OCR on CPU takes minutes per page: the vision pool wants a GPU before real traffic.
- KrakenD fetches the JWKS over plain HTTP (`disable_jwk_security`) and has no TLS. Production should use `https://auth.locci.cloud` as both `issuer` and JWKS origin, with `disable_jwk_security: false` and TLS.
- `LogSink` only logs. Implement `MeterSink` (Postgres, Redis, NATS) and the quota check at the marked hook in `proxyHandler`.
