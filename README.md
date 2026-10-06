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
| `scripts/` | `fetch-models.sh`, `locci-auth-token.sh`, `smoke.sh` |
| `models/` | GGUF files (git-ignored) |

## Dev commands

Everything below is wrapped in `.justfile`; run `just` to list the recipes. The usual loop:

```bash
just auth        # terminal 1: locci-auth on :8787
just models      # once
just up          # build, start, wait for healthy
just chat "Reverse a string in Go"
just meter       # follow per-tenant usage
just down
```

## Quick start

Auth comes from [locci-auth](../locci-auth) running locally. Its users are the tenants: KrakenD validates the ES256 access token against locci-auth's JWKS and propagates `properties.id` as `X-Locci-Tenant` (and `properties.email` as `X-Locci-Email`).

```bash
(cd ../locci-auth && npx wrangler dev --port 8787)   # separate terminal; needs fix/issuer-forwarded-proto or later
scripts/fetch-models.sh            # ~1 GB coder model; add --vision / --embed for the optional pools
docker compose up --build -d       # first start waits for both coder nodes to load the model
scripts/smoke.sh                   # health, 401, 400, /v1/models, a streamed chat, and meter lines
```

`scripts/locci-auth-token.sh [user_id]` mints a 1h user token through locci-auth's `/internal/push-deploy-token`, using `SERVICE_TOKEN` from `../locci-auth/.dev.vars`. With no argument it uses the first user in locci-auth's local D1.

KrakenD fetches the JWKS from `http://host.docker.internal:8787/.well-known/jwks.json` (cached 15 min) and requires `iss` to be exactly `http://localhost:8787`, locci-auth's `AUTH_PUBLIC_ORIGIN`. A locci-auth without `fix/issuer-forwarded-proto` mints `https://localhost:8787` from its service and API-key routes, which KrakenD rejects with 401. The `krakend` service maps `host.docker.internal` to `host-gateway`, which reaches the host's loopback under both Colima and Docker Desktop, so plain `wrangler dev` on 127.0.0.1 is enough. `172.17.0.1` does not work under Colima: it is the bridge inside the VM, not the Mac. In production the URL is `https://auth.locci.cloud/.well-known/jwks.json` with `issuer` set and `disable_jwk_security: false`.

Manual request:

```bash
TOKEN=$(scripts/locci-auth-token.sh)
curl -N http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"qwen-coder-7b","stream":true,"messages":[{"role":"user","content":"Reverse a string in Go"}]}'
docker compose logs locci-ai-gateway | grep meter
```

Optional pools: `docker compose --profile vision --profile embed up -d`. Until those run, `baidu-ocr-vision` and `embedding-nomic` return `502`.

## Models

| Requested `model` | Pool | Local default GGUF |
| --- | --- | --- |
| `qwen-coder-7b`, `qwen-coder-14b` | coder | `qwen2.5-coder-1.5b-instruct-q4_k_m.gguf` (small stand-in for both) |
| `baidu-ocr-vision` | vision | llava v1.5 7B + mmproj |
| `embedding-nomic` | embed | `nomic-embed-text-v1.5.Q4_K_M.gguf` |

To use other files, set the filenames in `.env` (see `.env.example`).

## Git hooks

`.githooks/` holds `pre-commit` (rejects added lines with em or en dashes) and `commit-msg` (rejects AI attribution). After cloning, enable them with:

```bash
git config core.hooksPath .githooks
```

## Router development

```bash
cd locci-ai-gateway
go test ./...
UPSTREAM_URL=http://localhost:8082 LISTEN_ADDR=:8090 go run .   # point at any OpenAI-compatible upstream
```

## Changes from REFERENCE.md

Fixes needed to make the reference stack actually run:

- Compose: `depends_on: locci-gateway` renamed to `locci-ai-gateway`; the obsolete `version` key dropped; healthchecks added so nginx waits for models to load.
- llama.cpp image moved to `ghcr.io/ggml-org/llama.cpp:server`. Vision gets `--mmproj`. A `llama-embed-1` service is added (nginx referenced it but compose did not define it). Vision and embed sit behind profiles.
- Nginx: resolver plus `zone` and `resolve` on upstreams. Without these, a missing pool host stops nginx from starting.
- KrakenD: global and endpoint `timeout` raised to 600s (the 2s default cuts off generation). The invalid `router.disable_strict_restful` key is removed. Rate limiting is configured. Added the `/v1/embeddings` and `/v1/models` endpoints. Auth is ES256 against locci-auth instead of an HS256 dev key.
- Router: `/v1/embeddings` shares the chat handler; `/v1/models` lists the registry; upstream is set by `UPSTREAM_URL`; the Dockerfile copies `go.sum`.
- Scaling: use `docker compose up --scale locci-ai-gateway=N` after removing the `8081` debug port mapping.

## Tenant header and spoofing

KrakenD 2.13 only forwards a `propagate_claims` header when that header is also listed in `input_headers`. Without it, the router sees no tenant and answers 401. Listing it would normally let clients send their own value, but the validator overwrites it with the claim. This was verified: a valid token plus `X-Locci-Tenant: evil-tenant` was metered under the token's user id, and the same header without a token got 401 at the edge.

Remaining gap: if a valid token lacks `properties.id`, nothing overwrites the header and a client-supplied value would pass through. Every locci-auth user token carries `properties.id` today. Keep it that way, or have KrakenD strip the header first.

## Not production-ready yet

- KrakenD fetches the JWKS over plain HTTP (`disable_jwk_security`) and has no TLS. Production should use `https://auth.locci.cloud` as both `issuer` and JWKS origin, with `disable_jwk_security: false` and TLS.
- `LogSink` only logs. Implement `MeterSink` (Postgres, Redis, NATS) and the quota check at the marked hook in `proxyHandler`.
