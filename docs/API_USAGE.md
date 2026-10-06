# API usage (curl)

The gateway speaks the OpenAI-compatible HTTP API. Every example here runs against the local stack (`just up`, `just auth`) and was checked against it; the responses shown are real, trimmed only where marked.

For the TypeScript client, see [SDK_USAGE.md](SDK_USAGE.md).

## Setup

```bash
export LOCCI_AI_GATEWAY=http://localhost:8080        # KrakenD, the only public entry point
export LOCCI_AUTH=http://localhost:8787   # locci-auth (https://auth.locci.cloud in production)
```

## Authentication

Every `/v1/*` request needs `Authorization: Bearer <access token>`. The token is a locci-auth ES256 JWT; the edge validates it against locci-auth's JWKS, requires `iss` to match the issuer, and takes the tenant from its `properties.id` claim. Tokens last one hour.

**With an API key** (CLIs, scripts, CI). Exchange the key for a token:

```bash
export TOKEN=$(curl -s -X POST "$LOCCI_AUTH/keys/token" \
  -H "x-locci-api-key: $LOCCI_API_KEY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
```

The exchange returns:

```json
{ "token": "eyJhbGciOiJFUzI1NiIs...", "expiresIn": 3600, "tokenType": "Bearer" }
```

Exchange again when it expires; an invalid, revoked or expired key gets `401 {"error":"Invalid API key"}`.

**Local dev shortcut.** Mint a token for the first local user without an API key:

```bash
export TOKEN=$(just token)
```

A web app signed in through locci-auth's OAuth flow already holds an access token and sends that.

The tenant comes only from the token. An `X-Locci-Tenant` header sent by a client is overwritten by the edge.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness |
| `GET` | `/v1/models` | token | Models the gateway routes |
| `POST` | `/v1/chat/completions` | token | Chat, streaming or not |
| `POST` | `/v1/embeddings` | token | Embeddings |

Anything else is `404`; a wrong method is `405`.

### Health

```bash
curl -s "$LOCCI_AI_GATEWAY/health"
```

```json
{"service":"locci-ai-gateway","status":"ok"}
```

### List models

```bash
curl -s "$LOCCI_AI_GATEWAY/v1/models" -H "Authorization: Bearer $TOKEN"
```

```json
{
  "object": "list",
  "data": [
    { "id": "baidu-ocr-vision", "object": "model", "owned_by": "locci", "pool": "/vision" },
    { "id": "embedding-nomic", "object": "model", "owned_by": "locci", "pool": "/embed" },
    { "id": "qwen-coder-14b", "object": "model", "owned_by": "locci", "pool": "/coder" },
    { "id": "qwen-coder-7b", "object": "model", "owned_by": "locci", "pool": "/coder" }
  ]
}
```

A model is listed even when its pool is not running (see `502` below). Locally only the coder pool runs by default; `just up-all` adds vision and embeddings.

### Chat completion

```bash
curl -s "$LOCCI_AI_GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-coder-7b",
    "max_tokens": 64,
    "messages": [{ "role": "user", "content": "Say hi in three words." }]
  }'
```

```json
{
  "id": "chatcmpl-bT7a1PA4dI3XzIHZlasK222a29FlTGlL",
  "object": "chat.completion",
  "created": 1791314192,
  "model": "qwen-coder-7b",
  "choices": [
    { "index": 0, "finish_reason": "stop", "message": { "role": "assistant", "content": "Hello" } }
  ],
  "usage": { "prompt_tokens": 35, "completion_tokens": 2, "total_tokens": 37, "prompt_tokens_details": { "cached_tokens": 24 } },
  "system_fingerprint": "b11434-5e03bdd87",
  "timings": { "prompt_n": 11, "prompt_ms": 322.3, "predicted_n": 2, "predicted_ms": 17.2 }
}
```

Request fields are passed through to llama-server, so the usual OpenAI parameters work (`temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `response_format`). `model` in the response is the id you requested; `timings` is llama.cpp's own performance block (trimmed above), not part of the OpenAI schema.

### Streaming

Add `"stream": true` and keep the connection open with `-N`:

```bash
curl -sN "$LOCCI_AI_GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "model": "qwen-coder-7b",
    "stream": true,
    "max_tokens": 64,
    "messages": [{ "role": "user", "content": "Write a Go function to reverse a string." }]
  }'
```

Server-sent events, one `data:` line per token. The gateway always asks the node for usage, so the final chunk before `[DONE]` has empty `choices` and a `usage` block, even if you did not send `stream_options`:

```text
data: {"choices":[{"delta":{"content":null,"role":"assistant"},"finish_reason":null,"index":0}],"model":"qwen-coder-7b","object":"chat.completion.chunk",...}
data: {"choices":[{"delta":{"content":"Sure"},"finish_reason":null,"index":0}],"model":"qwen-coder-7b","object":"chat.completion.chunk",...}
...
data: {"choices":[{"delta":{},"finish_reason":"length","index":0}],"model":"qwen-coder-7b","object":"chat.completion.chunk",...}
data: {"choices":[],"model":"qwen-coder-7b","object":"chat.completion.chunk","usage":{"completion_tokens":6,"prompt_tokens":32,"total_tokens":38},...}
data: [DONE]
```

Print just the text:

```bash
curl -sN "$LOCCI_AI_GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"qwen-coder-7b","stream":true,"max_tokens":64,"messages":[{"role":"user","content":"Name three Go keywords."}]}' \
  | sed -n 's/^data: //p' | grep -v '^\[DONE\]' \
  | python3 -c 'import json,sys
for line in sys.stdin:
    for c in json.loads(line)["choices"]:
        print(c["delta"].get("content") or "", end="", flush=True)
print()'
```

### Embeddings

Needs the embeddings pool (`docker compose --profile embed up -d`, after `just models --embed`).

```bash
curl -s "$LOCCI_AI_GATEWAY/v1/embeddings" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "model": "embedding-nomic", "input": ["hello world", "second"] }'
```

```json
{
  "object": "list",
  "model": "embedding-nomic",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [-0.0171, 0.0151, -0.1738, "... 768 floats"] },
    { "object": "embedding", "index": 1, "embedding": [0.0428, 0.0099, -0.1790, "... 768 floats"] }
  ],
  "usage": { "prompt_tokens": 7, "total_tokens": 7 }
}
```

`input` takes a string or an array of strings. Vectors are 768-dimensional.

## Errors

| Status | When | Body |
| --- | --- | --- |
| `400` | Unknown `model` | `{"error":{"message":"unknown model: gpt-9","type":"invalid_request_error"}}` |
| `400` | Body is not JSON | `{"error":{"message":"invalid JSON","type":"invalid_request_error"}}` |
| `401` | Missing, invalid, expired token, or wrong issuer | empty |
| `404` / `405` | Unknown path / wrong method | plain text |
| `429` | Rate limit exceeded | empty |
| `502` | The model's pool is not running | `{"error":{"message":"Model pool unavailable","type":"upstream_error"}}` |
| `502` | The router cannot reach nginx | `{"error":{"message":"Inference backend unavailable","type":"upstream_error"}}` |

The `401` and `429` bodies are empty: KrakenD Community Edition rejects at the edge with a bare status and cannot be configured to send a body (custom error bodies are an Enterprise feature), and nothing sits in front of KrakenD by design, to keep latency down. The `404`/`405` routing errors are KrakenD's plain text for the same reason. Branch on the status code; the `400` and `502` errors carry the OpenAI error shape.

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$LOCCI_AI_GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"gpt-9","messages":[]}'
# 400
```

## Rate limits

Per endpoint, enforced at the edge:

| Endpoint | Per client IP | All clients |
| --- | --- | --- |
| `/v1/chat/completions` | 10 req/s | 100 req/s |
| `/v1/embeddings` | 20 req/s | 200 req/s |

A burst of 25 parallel chat requests from one IP gets 10 through and 15 `429`s. Limits are per IP, not per tenant.

## Usage metering

Every completed request is metered per tenant from the response's `usage` block, off the request path. Watch it locally with `just meter`:

```text
meter tenant=2c31b52aa58f5fec7831a2b8e1861946 model=qwen-coder-7b pool=/coder prompt=35 completion=2 total=37
```

A request the gateway rejects (`400`, `401`, `429`) is not metered.
