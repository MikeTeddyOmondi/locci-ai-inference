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

# Build and start the stack (coder pool), waiting until everything is healthy.
up:
    docker compose up --build -d --wait --wait-timeout 600

# Start with the optional vision and embeddings pools as well.
up-all:
    docker compose --profile vision --profile embed up --build -d --wait --wait-timeout 900

# Stop and remove the stack (all profiles).
down:
    docker compose --profile vision --profile embed down

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
chat prompt="Write a Go function to reverse a string." model="qwen-coder-7b":
    #!/usr/bin/env sh
    set -eu
    TOKEN=$(scripts/locci-auth-token.sh)
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"model":sys.argv[1],"stream":True,"max_tokens":256,"messages":[{"role":"user","content":sys.argv[2]}]}))' '{{model}}' '{{prompt}}')
    curl -sN {{edge}}/v1/chat/completions \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$BODY" \
      | python3 -u -c 'import json,sys
    for line in sys.stdin:
        line = line.strip()
        if not line.startswith("data:") or line.endswith("[DONE]"):
            continue
        for choice in json.loads(line[5:]).get("choices", []):
            print(choice.get("delta", {}).get("content") or "", end="", flush=True)
    print()'

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
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"model":"qwen-coder-7b","stream":True,"max_tokens":64,"messages":[{"role":"user","content":sys.argv[1]}]}))' '{{prompt}}')
    curl -sN http://localhost{{listen}}/v1/chat/completions \
      -H 'X-Locci-Tenant: {{tenant}}' -H 'Content-Type: application/json' -d "$BODY"

# Remove build artefacts
clean:
    rm -rf {{gw}}/bin
