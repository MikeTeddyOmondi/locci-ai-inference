# Locci AI Inference: justfile
# Local dev for the SLM gateway stack. `just` lists every recipe.

auth_dir := env_var_or_default("LOCCI_AUTH_DIR", "../locci-auth")
edge := "http://localhost:8080"

default:
    @just --list --unsorted

# -- auth ---------------------------------------------------------------------

# Run locci-auth (the tenant/JWT issuer) on 127.0.0.1:8787. Leave it running.
auth:
    cd {{auth_dir}} && npx wrangler dev --port 8787

# Mint a 1h access token from the local locci-auth (first local user by default).
token user="":
    @scripts/locci-auth-token.sh {{user}}

# Show the issuer and signing keys KrakenD validates against.
jwks:
    @curl -s http://localhost:8787/.well-known/oauth-authorization-server | python3 -c 'import json,sys; print("issuer:", json.load(sys.stdin)["issuer"])'
    @curl -s http://localhost:8787/.well-known/jwks.json | python3 -m json.tool

# -- models -------------------------------------------------------------------

# Download GGUF models. Coder always; pass --vision and/or --embed for the rest.
models *flags:
    scripts/fetch-models.sh {{flags}}

# -- stack --------------------------------------------------------------------

# Build and start the stack with the qwen3-1.7b pool, waiting until it is healthy.
up:
    docker compose up --build -d --wait --wait-timeout 600

# Start with the optional qwen2.5-coder, vision and embeddings pools and Ursula as well.
up-all:
    docker compose --profile qwen25 --profile vision --profile embed --profile ursula up --build -d --wait --wait-timeout 900

# Stop and remove the stack (all profiles).
down:
    docker compose --profile qwen25 --profile vision --profile embed --profile ursula down

# Start Ursula for resumable web replies (RESUMABLE_STREAMS=ursula), reached only via KrakenD.
ursula-up:
    docker compose --profile ursula up -d ursula

# Stop Ursula. Its recordings stay in the ursula-data volume.
ursula-down:
    docker compose --profile ursula stop ursula

# Container status.
ps:
    docker compose ps

# Follow logs, e.g. `just logs locci-ai-gateway`. All services by default.
logs *services:
    docker compose logs -f --tail 100 {{services}}

# Follow only the per-tenant metering lines from the router.
meter:
    docker compose logs -f --no-log-prefix locci-ai-gateway | grep --line-buffered 'meter tenant='

# Rebuild the router image and restart its container after editing its Go code.
up-gateway:
    docker compose up --build -d --wait locci-ai-gateway

# Restart KrakenD after editing krakend/krakend.json (validates first).
krakend:
    docker run --rm -v "$PWD/krakend:/etc/krakend:ro" krakend:2.13 check -c /etc/krakend/krakend.json
    docker compose restart krakend

# -- try it -------------------------------------------------------------------

# End-to-end checks through KrakenD: health, 401, 400, models, streamed chat, meter.
smoke:
    scripts/smoke.sh {{edge}}

# Stream one chat completion through the edge, e.g. `just chat "Reverse a string in Go"`.
# max_tokens caps the answer; a cut-off answer is flagged, not silent. Prompt
# plus answer must fit the per-request window: 8192 tokens on qwen3-1.7b, 2048 on
# qwen2.5-coder-1.5b (docs/LLAMA_SERVER.md).
chat prompt="Write a Go function to reverse a string." model="qwen3-1.7b" max_tokens="1024":
    #!/usr/bin/env sh
    set -eu
    TOKEN=$(scripts/locci-auth-token.sh)
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"stream":True,"max_tokens":int(sys.argv[3]),"messages":[{"role":"user","content":sys.argv[2]}]}))' '{{model}}' '{{prompt}}' '{{max_tokens}}')
    curl -sN {{edge}}/v1/chat/completions \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" \
      | python3 -u -c 'import json,sys
    finish, usage = None, None
    for line in sys.stdin:
        line = line.strip()
        if not line.startswith("data:") or line.endswith("[DONE]"):
            continue
        chunk = json.loads(line[5:])
        usage = chunk.get("usage") or usage
        for choice in chunk.get("choices", []):
            print(choice.get("delta", {}).get("content") or "", end="", flush=True)
            finish = choice.get("finish_reason") or finish
    print()
    if finish == "length":
        print("\n[cut off: hit max_tokens=%s; rerun with a larger max_tokens]" % sys.argv[1], file=sys.stderr)
    elif finish != "stop":
        print("\n[stream ended without finish_reason=stop (got %r)]" % finish, file=sys.stderr)
    if usage:
        print("[tokens: prompt=%d completion=%d]" % (usage["prompt_tokens"], usage["completion_tokens"]), file=sys.stderr)' '{{max_tokens}}'

# List the models the router knows about.
list-models:
    @curl -s {{edge}}/v1/models -H "Authorization: Bearer $(scripts/locci-auth-token.sh)" | python3 -m json.tool

# -- gateway (Go router) ------------------------------------------------------
# The host-run router listens on :8090 and talks to the stack's nginx, which
# compose publishes on 127.0.0.1:8082. Override with UPSTREAM_URL / LISTEN_ADDR.

gw := "locci-ai-gateway"
upstream := env_var_or_default("UPSTREAM_URL", "http://localhost:8082")
listen := env_var_or_default("LISTEN_ADDR", ":8090")

# Create ./bin and sync go.mod/go.sum
setup:
    mkdir -p {{gw}}/bin
    cd {{gw}} && go mod tidy

# Build the router binary to locci-ai-gateway/bin/locci-ai-gateway
build:
    mkdir -p {{gw}}/bin
    cd {{gw}} && go build -o ./bin/locci-ai-gateway .

# Build, then run the binary on the host (needs `just up` for nginx and the pools)
run: build
    UPSTREAM_URL={{upstream}} LISTEN_ADDR={{listen}} ./{{gw}}/bin/locci-ai-gateway

# Run from source with `go run`, no binary
run-bin:
    cd {{gw}} && UPSTREAM_URL={{upstream}} LISTEN_ADDR={{listen}} go run .

# Sync go.mod/go.sum with the imports actually used
tidy:
    cd {{gw}} && go mod tidy

# Format all Go source in place
fmt:
    gofmt -w {{gw}}

# Fail if any Go source needs formatting
fmt-check:
    @out=$(gofmt -l {{gw}}); if [ -n "$out" ]; then echo "$out"; exit 1; fi

vet:
    cd {{gw}} && go vet ./...

test:
    cd {{gw}} && go test ./...

# Everything CI should run
check:
    just fmt-check
    just vet
    just test

# Send a streamed chat straight to the host-run router (skips KrakenD; tenant set by hand)
chat-local prompt="Say hi in five words." tenant="dev-local":
    #!/usr/bin/env sh
    set -eu
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"model":"qwen3-1.7b","stream":True,"max_tokens":64,"messages":[{"role":"user","content":sys.argv[1]}]}))' '{{prompt}}')
    curl -sN http://localhost{{listen}}/v1/chat/completions \
      -H 'X-Locci-Tenant: {{tenant}}' -H 'Content-Type: application/json' -d "$BODY"

# Remove build artefacts
clean:
    rm -rf {{gw}}/bin

# -- @locci/ai-sdk (packages/ai-sdk) ----------------------------------------

sdk := "packages/ai-sdk"

# Install the provider package's dependencies
sdk-install:
    cd {{sdk}} && pnpm install

# Typecheck and run the provider's unit tests (auth and model-id drift)
sdk-test:
    cd {{sdk}} && pnpm typecheck && pnpm test

# Build the provider to packages/ai-sdk/dist
sdk-build:
    cd {{sdk}} && pnpm build

# AI SDK calls through the running stack (needs `just up` and `just auth`)
sdk-e2e:
    #!/usr/bin/env sh
    set -eu
    export LOCCI_TEST_ACCESS_TOKEN="$(scripts/locci-auth-token.sh)"
    export LOCCI_AUTH_URL=http://localhost:8787
    cd {{sdk}} && pnpm test:e2e

# -- tool calling --------------------------------------------------------------
# Protocol checks (well-formed tool_calls, results round-trip, streaming), not
# model quality. MODEL picks the gateway model id. See docs/LLAMA_SERVER.md.

# Tool calling over plain HTTP (curl) through the edge
tools-api:
    scripts/tool-calls-api.sh {{edge}}

# Tool calling with the AI SDK and @locci/ai-sdk through the edge
tools-sdk:
    #!/usr/bin/env sh
    set -eu
    export TOKEN="$(scripts/locci-auth-token.sh)"
    export LOCCI_AI_BASE_URL={{edge}}/v1
    cd {{sdk}} && node --import tsx scripts/tool-calls.ts

# Document OCR through the edge with the committed fixtures (needs the vision pool)
ocr-api:
    scripts/ocr-api.sh {{edge}}

# -- examples (examples/api, cli, web) ------------------------------------------
# Client apps ported from locci-chat-cli and autonomous-chatbot. The API is the
# only one that calls models (through @locci/ai-sdk); cli and web are clients.
# Every recipe that runs code rebuilds the SDK first, so SDK changes are tested.

# Install the workspace (SDK + examples)
examples-install:
    pnpm install

# Build the examples' .env files from the original projects (+ a new Locci API key)
examples-env *flags:
    node scripts/examples-env.mjs {{flags}}

# Run the example API on :3939 (needs `just up` and `just auth`)
examples-api: sdk-build
    pnpm --filter @locci/example-ai-api run dev

# Run the CLI client, e.g. `just examples-cli status`, `chat`, `ask "hi"`, `mcp list`
examples-cli *args:
    pnpm --filter @locci/example-ai-cli exec tsx src/cli.ts {{args}}

# Run the OpenTUI terminal chat (needs Bun)
examples-tui:
    cd examples/cli && bun src/tui.tsx

# Run the web client on :5173 (Vite dev server)
examples-web:
    pnpm --filter @locci/example-ai-web run dev

# Regression checks against the running API: typecheck, web build, CLI and web protocols
examples-check *flags: sdk-build
    node scripts/examples-check.mjs {{flags}}
