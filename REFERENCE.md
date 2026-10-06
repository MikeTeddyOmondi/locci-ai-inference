# Locci AI Gateway - Specialized SLM Inference-as-a-Service

A horizontally scalable, streaming-first gateway for serving **specialized small language models (SLMs)** over an OpenAI-compatible API from self-hosted GPU/CPU nodes, with per-tenant metering built in.

This is **not** a general-purpose LLM router. Locci curates a small set of task-specific SLMs (coder, vision/OCR, embeddings) served by `llama-server`, load-balanced by Nginx, and multiplexed by a Go router, chosen deliberately to be affordable to run in-region.

Requests flow through four layers, each with a single responsibility:

| Layer         | Component                         | Responsibility                                                                                     |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Edge          | **KrakenD**                       | TLS, API keys / JWT validation, rate limiting, **injects tenant from the JWT claim**               |
| Router        | **`locci-ai-gateway`** (Go / Gin) | Reads `model`, routes to the right pool, proxies the SSE stream, **meters token usage per tenant** |
| Load balancer | **Nginx**                         | `least_conn` distribution across nodes, buffering disabled                                         |
| Inference     | **`llama-server`** (llama.cpp)    | SLM execution on GPU/CPU                                                                           |

```text
Client  ── Authorization: Bearer <jwt> ──▶
KrakenD            validate JWT → propagate tenant_id claim as X-Locci-Tenant     :8080
  ▼
locci-ai-gateway   read X-Locci-Tenant + model → rewrite path → meter stream      :8080 (internal)
  ▼
Nginx              least_conn load balancing                                      :80
  ▼
llama-server pool  coder / vision / embed                                         :8080 each
  ▼
(async)            MeterEvent → billing store
```

---

## Project Structure

```text
locci-ai-inference/
├── docker-compose.yml          # Full orchestration stack
├── locci-ai-gateway/           # Go/Gin AI router + metering
│   ├── main.go                 # Routing, SSE proxy, model registry, token metering
│   ├── go.mod                  # Go dependencies
│   └── Dockerfile              # Multi-stage Go build
├── nginx/
│   └── nginx.conf              # SSE-optimized, least-connections config
├── krakend/
│   ├── krakend.json            # Auth / rate-limit edge routing + claim propagation
│   └── jwk.json                # Local JWK(s) for JWT validation
└── models/                     # GGUF files (mounted into inference containers)
```

---

## Prerequisites

- Docker and Docker Compose
- One or more GGUF model files (a small one is fine for testing)
- An `llama-server` build recent enough to emit `usage` on streamed responses (see [Metering](https://claude.ai/chat/39016341-dcc9-47d4-a4b4-07364f17772f#multi-tenancy--metering))
- Optional: NVIDIA Container Toolkit for GPU (see the commented `deploy` block in `docker-compose.yml`)

---

## Components

### 1. AI Router: `locci-ai-gateway` (Go / Gin)

For each request the router:

1. Reads `X-Locci-Tenant` (set by KrakenD from the validated JWT; the gateway is internal-only and trusts it).
2. Reads `model` and maps it to a pool; **unknown models are rejected with `400`**, with no silent fallback.
3. Injects `stream_options.include_usage` so the backend returns a token `usage` object on streamed responses.
4. Rewrites the path and reverse-proxies the stream.
5. **Meters** the response: extracts `usage` from the stream and emits a per-tenant event asynchronously, off the request hot path.

**Model registry**

| Requested model    | Nginx prefix | Pool   |
| ------------------ | ------------ | ------ |
| `qwen-coder-7b`    | `/coder`     | coder  |
| `qwen-coder-14b`   | `/coder`     | coder  |
| `baidu-ocr-vision` | `/vision`    | vision |
| `embedding-nomic`  | `/embed`     | embed  |

**`locci-ai-gateway/main.go`**

```go
package main

import (
    "bytes"
    "encoding/json"
    "io"
    "log"
    "net/http"
    "net/http/httputil"
    "net/url"
    "time"

    "github.com/gin-gonic/gin"
)

// ModelRegistry maps the requested model to the Nginx routing prefix (pool).
var ModelRegistry = map[string]string{
    "qwen-coder-7b":    "/coder",
    "qwen-coder-14b":   "/coder",
    "baidu-ocr-vision": "/vision",
    "embedding-nomic":  "/embed",
}

// --- Metering ---------------------------------------------------------------

// MeterEvent is a single billable unit of work for one tenant.
type MeterEvent struct {
    Tenant           string    `json:"tenant"`
    Model            string    `json:"model"`
    Pool             string    `json:"pool"`
    PromptTokens     int       `json:"prompt_tokens"`
    CompletionTokens int       `json:"completion_tokens"`
    TotalTokens      int       `json:"total_tokens"`
    Timestamp        time.Time `json:"timestamp"`
}

// MeterSink persists usage. Swap LogSink for Redis / Postgres / Kafka in prod.
type MeterSink interface {
    Record(MeterEvent)
}

// LogSink is a placeholder sink that just logs. Replace in production.
type LogSink struct{}

func (LogSink) Record(e MeterEvent) {
    log.Printf("meter tenant=%s model=%s pool=%s prompt=%d completion=%d total=%d",
        e.Tenant, e.Model, e.Pool, e.PromptTokens, e.CompletionTokens, e.TotalTokens)
}

// Meter records events asynchronously so billing never blocks inference.
type Meter struct {
    ch chan MeterEvent
}

func NewMeter(sink MeterSink, buffer int) *Meter {
    m := &Meter{ch: make(chan MeterEvent, buffer)}
    go func() {
        for e := range m.ch {
            sink.Record(e)
        }
    }()
    return m
}

func (m *Meter) Emit(e MeterEvent) {
    select {
    case m.ch <- e:
    default:
        // Never block the request path on a full buffer; drop and log.
        log.Printf("meter buffer full; dropped event tenant=%s model=%s", e.Tenant, e.Model)
    }
}

// --- Usage extraction from the (possibly streamed) response -----------------

type usage struct {
    PromptTokens     int `json:"prompt_tokens"`
    CompletionTokens int `json:"completion_tokens"`
    TotalTokens      int `json:"total_tokens"`
}

type usageEnvelope struct {
    Usage *usage `json:"usage"`
}

// meteringWriter tees the upstream response to the client while scanning for
// the OpenAI `usage` object. It handles both SSE streams ("data:" lines) and
// plain JSON bodies, and retains only a partial-line tail in memory.
type meteringWriter struct {
    gin.ResponseWriter
    tail      bytes.Buffer
    lastUsage *usage
}

func (w *meteringWriter) Write(p []byte) (int, error) {
    w.scan(p)
    return w.ResponseWriter.Write(p) // forward to the client unchanged
}

func (w *meteringWriter) scan(p []byte) {
    w.tail.Write(p)
    data := w.tail.Bytes()
    for {
        i := bytes.IndexByte(data, '\n')
        if i < 0 {
            break
        }
        w.parseLine(data[:i])
        data = data[i+1:]
    }
    rest := append([]byte(nil), data...) // keep the trailing partial line
    w.tail.Reset()
    w.tail.Write(rest)
}

func (w *meteringWriter) parseLine(line []byte) {
    line = bytes.TrimSpace(line)
    line = bytes.TrimPrefix(line, []byte("data:"))
    line = bytes.TrimSpace(line)
    if len(line) == 0 || bytes.Equal(line, []byte("[DONE]")) {
        return
    }
    var env usageEnvelope
    if err := json.Unmarshal(line, &env); err != nil {
        return // not a JSON usage-bearing line; ignore
    }
    if env.Usage != nil {
        w.lastUsage = env.Usage
    }
}

// finalize flushes any buffered tail (e.g. a non-streamed JSON body with no
// trailing newline) and returns the last usage object seen.
func (w *meteringWriter) finalize() *usage {
    if w.tail.Len() > 0 {
        w.parseLine(w.tail.Bytes())
    }
    return w.lastUsage
}

// ---------------------------------------------------------------------------

func main() {
    meter := NewMeter(LogSink{}, 1024)

    // High-concurrency transport tuned for long-lived SSE streams.
    transport := &http.Transport{
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 100, // keep upstream SSE connections warm
        IdleConnTimeout:     90 * time.Second,
        DisableCompression:  true, // faster for SSE
    }

    nginxURL, _ := url.Parse("http://nginx:80")

    // One reverse proxy, shared across requests (safe for concurrent use).
    proxy := httputil.NewSingleHostReverseProxy(nginxURL)
    proxy.Transport = transport
    proxy.FlushInterval = -1 // flush every write immediately for SSE
    proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
        log.Printf("proxy error to nginx: %v", err)
        w.WriteHeader(http.StatusBadGateway)
        w.Write([]byte(`{"error":{"message":"Inference backend unavailable","type":"upstream_error"}}`))
    }

    r := gin.Default()

    r.POST("/v1/chat/completions", func(c *gin.Context) {
        // 1. Tenant is injected by KrakenD from the validated JWT claim.
        //    The gateway is not publicly reachable, so this header is trusted.
        tenant := c.GetHeader("X-Locci-Tenant")
        if tenant == "" {
            c.JSON(http.StatusUnauthorized, gin.H{
                "error": gin.H{"message": "missing tenant", "type": "auth_error"},
            })
            return
        }

        bodyBytes, err := io.ReadAll(c.Request.Body)
        if err != nil {
            c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read request body"})
            return
        }

        var reqBody map[string]interface{}
        if err := json.Unmarshal(bodyBytes, &reqBody); err != nil {
            c.JSON(http.StatusBadRequest, gin.H{"error": "invalid JSON"})
            return
        }

        modelName, _ := reqBody["model"].(string)
        prefix, ok := ModelRegistry[modelName]
        if !ok {
            // Fail loud: an unknown model must not silently hit the wrong pool.
            c.JSON(http.StatusBadRequest, gin.H{
                "error": gin.H{
                    "message": "unknown model: " + modelName,
                    "type":    "invalid_request_error",
                },
            })
            return
        }

        // 2. Ask the backend to emit a usage chunk on streamed responses.
        if stream, _ := reqBody["stream"].(bool); stream {
            reqBody["stream_options"] = map[string]interface{}{"include_usage": true}
            if b, err := json.Marshal(reqBody); err == nil {
                bodyBytes = b
            }
        }

        // (Quota hook): check the tenant's remaining balance here before
        // proxying, using the same store the Meter writes to, and return
        // 402/429 if the tenant is over its limit.

        // 3. Prepare the request for the shared reverse proxy.
        c.Request.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
        c.Request.ContentLength = int64(len(bodyBytes))
        c.Request.Header.Set("X-Locci-Tenant", tenant)             // propagate downstream
        c.Request.URL.Path = prefix + c.Request.URL.Path           // e.g. /coder/v1/chat/completions

        // 4. Proxy while metering the stream.
        mw := &meteringWriter{ResponseWriter: c.Writer}
        proxy.ServeHTTP(mw, c.Request)

        if u := mw.finalize(); u != nil {
            meter.Emit(MeterEvent{
                Tenant:           tenant,
                Model:            modelName,
                Pool:             prefix,
                PromptTokens:     u.PromptTokens,
                CompletionTokens: u.CompletionTokens,
                TotalTokens:      u.TotalTokens,
                Timestamp:        time.Now(),
            })
        }
    })

    // Healthcheck endpoint for Docker / K8s.
    r.GET("/health", func(c *gin.Context) {
        c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "locci-ai-gateway"})
    })

    log.Println("🚀 Locci AI Gateway listening on :8080")
    r.Run(":8080")
}
```

**`locci-ai-gateway/Dockerfile`**

```dockerfile
FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o locci-ai-gateway .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/locci-ai-gateway .
EXPOSE 8080
CMD ["./locci-ai-gateway"]
```

---

### 2. Load Balancer: Nginx

Distributes streams across nodes with `least_conn` (avoids queueing behind a busy node) and disables buffering so tokens are forwarded as they arrive.

**`nginx/nginx.conf`**

```nginx
worker_processes auto;
events { worker_connections 1024; }

http {
    # --- Upstream Pools (The inference nodes) ---

    upstream coder_pool {
        least_conn; # send to the node with the fewest active streams
        server llama-coder-1:8080;
        server llama-coder-2:8080;
    }

    upstream vision_pool {
        least_conn;
        server llama-vision-1:8080;
    }

    upstream embed_pool {
        least_conn;
        server llama-embed-1:8080;
    }

    server {
        listen 80;

        # --- CRITICAL: SSE & LLM Streaming Optimizations ---
        proxy_buffering off;            # do not buffer generated tokens
        proxy_cache off;
        proxy_set_header Connection ''; # required for HTTP/1.1 streaming
        proxy_http_version 1.1;
        chunked_transfer_encoding off;

        # Generation can take a while; prevent proxy timeouts.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;

        # --- Routing based on Locci's path rewriting ---

        location /coder/ {
            rewrite ^/coder/(.*)$ /$1 break;
            proxy_pass http://coder_pool;
        }

        location /vision/ {
            rewrite ^/vision/(.*)$ /$1 break;
            proxy_pass http://vision_pool;
        }

        location /embed/ {
            rewrite ^/embed/(.*)$ /$1 break;
            proxy_pass http://embed_pool;
        }

        # Healthcheck
        location /health {
            return 200 'OK';
            add_header Content-Type text/plain;
        }
    }
}
```

---

### 3. Edge Gateway: KrakenD

Public-facing entry point. It terminates TLS, validates the JWT, applies rate limits, and (importantly) **propagates the tenant identity from the token into a header** the router can trust.

> **`propagate_claims`** maps the `tenant_id` claim of the validated JWT into the `X-Locci-Tenant` header sent to the backend. Because the router sits on the internal network behind KrakenD, it can trust this header as the authenticated tenant.
> 
> **`output_encoding: "no-op"`** (and the backend `encoding: "no-op"`) is **mandatory** for SSE; otherwise KrakenD tries to parse the JSON chunks and breaks the stream.
> 
> **Security:** ensure clients cannot spoof `X-Locci-Tenant`. KrakenD does not forward arbitrary client headers by default; keep it that way (don't add `X-Locci-Tenant` to any `input_headers` allowlist) so the value can only come from the validated claim.

**`krakend/krakend.json`**

```json
{
  "version": 3,
  "port": 8080,
  "host": ["http://0.0.0.0:8080"],
  "endpoints": [
    {
      "endpoint": "/v1/chat/completions",
      "method": "POST",
      "output_encoding": "no-op",
      "backend": [
        {
          "url_pattern": "/v1/chat/completions",
          "host": ["http://locci-ai-gateway:8080"],
          "encoding": "no-op"
        }
      ],
      "extra_config": {
        "router": {
          "disable_strict_restful": true
        },
        "auth/validator": {
          "alg": "HS256",
          "jwk_local_path": "/etc/krakend/jwk.json",
          "disable_jwk_security": true,
          "propagate_claims": [
            ["tenant_id", "X-Locci-Tenant"]
          ]
        }
      }
    },
    {
      "endpoint": "/health",
      "method": "GET",
      "backend": [
        {
          "url_pattern": "/health",
          "host": ["http://locci-ai-gateway:8080"]
        }
      ]
    }
  ]
}
```

---

### 4. Orchestration: `docker-compose.yml`

Brings up the full stack. Uncomment the `deploy` block on the inference services to attach GPUs. Note the `--cont-batching --parallel` flags; see [Scaling the inference tier](https://claude.ai/chat/39016341-dcc9-47d4-a4b4-07364f17772f#scaling-the-inference-tier).

**`docker-compose.yml`**

```yaml
version: '3.8'

services:
  # 1. The Edge Gateway (Public Facing)
  krakend:
    image: krakend:2.7
    ports:
      - "8080:8080" # exposed to clients
    volumes:
      - ./krakend/krakend.json:/etc/krakend/krakend.json
      - ./krakend/jwk.json:/etc/krakend/jwk.json
    depends_on:
      - locci-gateway
    networks:
      - locci-network

  # 2. The AI Router + Metering (Locci)
  locci-ai-gateway:
    build: ./locci-ai-gateway
    ports:
      - "8081:8080" # internal debugging only
    depends_on:
      - nginx
    networks:
      - locci-network

  # 3. The Load Balancer
  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - llama-coder-1
      - llama-coder-2
      - llama-vision-1
    networks:
      - locci-network

  # 4. Inference: Coder Pool (2 nodes, continuous batching enabled)
  llama-coder-1:
    image: ghcr.io/ggerganov/llama.cpp:server
    volumes:
      - ./models:/models
    # Small model for testing. Replace with your actual GGUF path.
    command: ["-m", "/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf", "--host", "0.0.0.0", "--port", "8080", "-c", "8192", "--cont-batching", "--parallel", "4"]
    networks:
      - locci-network
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]

  llama-coder-2:
    image: ghcr.io/ggerganov/llama.cpp:server
    volumes:
      - ./models:/models
    command: ["-m", "/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf", "--host", "0.0.0.0", "--port", "8080", "-c", "8192", "--cont-batching", "--parallel", "4"]
    networks:
      - locci-network

  # 5. Inference: Vision/OCR Pool
  llama-vision-1:
    image: ghcr.io/ggerganov/llama.cpp:server
    volumes:
      - ./models:/models
    command: ["-m", "/models/llava-v1.5-7b-q4_k_m.gguf", "--host", "0.0.0.0", "--port", "8080", "-c", "4096"]
    networks:
      - locci-network

networks:
  locci-network:
    name: locci-network  
    driver: bridge
```

---

## Multi-tenancy & Metering

Tenancy and billing are the actual product here, so they're first-class.

**Identity flow.** The client authenticates with a JWT. KrakenD validates it at the edge and, via `propagate_claims`, injects the `tenant_id` claim as the `X-Locci-Tenant` header. The router (reachable only through KrakenD on the internal network) reads that header as the authenticated tenant. No tenant, no service (`401`).

**Token accounting.** The router asks the backend for usage (`stream_options.include_usage` on streamed requests; non-streamed responses always include `usage`). As the response streams back, `meteringWriter` tees it: bytes are forwarded to the client untouched while a line scanner watches for the `usage` object, keeping only a partial-line tail in memory. When the response completes, the last `usage` seen becomes a `MeterEvent` (`{tenant, model, pool, prompt/completion/total tokens, timestamp}`), pushed onto a buffered channel and written to the sink by a background goroutine. **Billing never sits on the request hot path**, and a full buffer drops-and-logs rather than blocking a stream.

**Making it production-grade:**

- Replace `LogSink` with a durable sink: Postgres for billing records, Redis for fast running counters, or Kafka/NATS if you want an event stream other services consume.
- Add a **quota check** at the marked hook point in the handler: look up the tenant's balance in the counter store and return `402`/`429` before proxying if they're over. The Meter and the quota check read/write the same store.
- **`llama-server` must report usage.** Use a build recent enough to honor `stream_options.include_usage` on the OpenAI-compatible endpoint. If a node doesn't emit `usage`, that request meters as zero, which is worth a startup assertion or a fallback token estimate.

---

## Quick Start

**1. Prepare a model**

```bash
mkdir models
# Small Qwen model for testing (requires huggingface-cli or wget)
wget -O models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf \
  https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
```

**2. Start the stack**

```bash
docker compose up --build
```

**3. Send a streaming request**

The request hits KrakenD (`:8080`), which validates the JWT, injects the tenant, and forwards to the router → Nginx → a coder node. Use a JWT whose payload carries a `tenant_id` claim.

```bash
curl -N http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt-with-tenant_id-claim>" \
  -d '{
    "model": "qwen-coder-7b",
    "messages": [{"role": "user", "content": "Write a quick Go function to reverse a string."}],
    "stream": true
  }'
```

Watch the router logs for the metering line once the stream finishes:

```text
meter tenant=acme model=qwen-coder-7b pool=/coder prompt=24 completion=118 total=142
```

---

## Design Notes

- **Horizontal scaling.** The router is stateless CPU work, so it scales independently of the inference tier: `docker compose up --scale locci-gateway=5`. Nginx distributes across nodes.
- **One shared reverse proxy.** The proxy is built once and reused across requests (safe for concurrent use), rather than allocated per request.
- **Low stream latency.** Go's `FlushInterval = -1`, Nginx `proxy_buffering off`, and KrakenD `no-op` encoding keep tokens flowing to the client as they're generated, with no buffering step in between. Metering tees the stream without adding a buffering stage.
- **Fail loud on unknown models.** Unrecognized `model` values return `400` instead of silently routing to the coder pool.
- **Metering off the hot path.** Usage events are emitted to a buffered channel and persisted by a background goroutine; a full buffer drops-and-logs rather than blocking inference.

### Scaling the inference tier

The engine choice (llama.cpp) is deliberate: GGUF quantization and CPU offload make it affordable to run in-region on modest hardware. The efficiency levers, in order:

1. **Continuous batching first.** Run each `llama-server` with `--cont-batching --parallel N` so a single process serves N concurrent requests on the same GPU (batched), instead of scaling one-slot containers that contend for hardware. This is the biggest tokens-per-GPU-dollar win.
2. **`least_conn` across physical nodes.** Once you have more than one GPU box, keep Nginx spreading load across them. Container-per-model is fine for a small, curated catalog.
3. **`llama-swap` for a larger catalog.** Hot-swap models on a single GPU so a multi-model menu doesn't require a pinned GPU per model.
4. **vLLM / TGI / SGLang later.** Higher throughput via paged attention and continuous batching, but they want more VRAM and are heavier. They are a migration target once specific models are standardized and GPU budget allows, not a starting point.

## Extending

- **Add a node to a pool:** append a `server` line to the relevant `upstream` in `nginx.conf`, add the service to `docker-compose.yml`, reload Nginx. The router doesn't change.
- **Add a model:** add an entry to `ModelRegistry` in `main.go` pointing at the appropriate pool prefix, and ensure a matching `location` block and upstream exist in Nginx.
- **Add a durable meter sink:** implement `MeterSink` (e.g. `PostgresSink`) and pass it to `NewMeter`.

---


