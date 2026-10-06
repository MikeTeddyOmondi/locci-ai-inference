package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
)

// ModelRegistry maps the requested model to the Nginx routing prefix (pool).
// Ids name the model that actually runs in the pool.
var ModelRegistry = map[string]string{
	"qwen3-1.7b":         "/coder",        // chat, code, tool calling
	"qwen2.5-coder-1.5b": "/qwen25-coder", // code generation only; cannot call tools
	"baidu-ocr-vision":   "/vision",
	"embedding-nomic":    "/embed",
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

// meteringWriter forwards the upstream response to the client line by line,
// scanning each line for the OpenAI `usage` object and, when model is set,
// replacing the response's `model` (llama-server reports its GGUF path) with
// the id the client asked for. It handles both SSE streams ("data:" lines) and
// plain JSON bodies, and retains only a partial-line tail in memory: SSE events
// end in a newline, so streamed tokens are not held back.
type meteringWriter struct {
	gin.ResponseWriter
	model     string
	tail      bytes.Buffer
	lastUsage *usage
}

func (w *meteringWriter) Write(p []byte) (int, error) {
	w.tail.Write(p)
	data := w.tail.Bytes()
	var out bytes.Buffer
	for {
		i := bytes.IndexByte(data, '\n')
		if i < 0 {
			break
		}
		w.parseLine(data[:i])
		out.Write(w.rewriteLine(data[:i+1]))
		data = data[i+1:]
	}
	rest := append([]byte(nil), data...) // keep the trailing partial line
	w.tail.Reset()
	w.tail.Write(rest)

	if out.Len() > 0 {
		if _, err := w.ResponseWriter.Write(out.Bytes()); err != nil {
			return 0, err
		}
	}
	// The proxy expects the bytes it handed over to be accepted; a held-back
	// partial line is written by the next Write or by finalize.
	return len(p), nil
}

// rewriteLine replaces the top-level `model` of a JSON (or "data: " JSON) line
// with w.model. Anything else, including "[DONE]" and non-JSON, is returned
// unchanged.
func (w *meteringWriter) rewriteLine(line []byte) []byte {
	if w.model == "" {
		return line
	}
	body := bytes.TrimRight(line, "\r\n")
	ending := line[len(body):]

	payload := bytes.TrimSpace(body)
	isEvent := bytes.HasPrefix(payload, []byte("data:"))
	payload = bytes.TrimSpace(bytes.TrimPrefix(payload, []byte("data:")))
	if len(payload) == 0 || payload[0] != '{' {
		return line
	}

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return line
	}
	if _, ok := fields["model"]; !ok {
		return line
	}
	fields["model"], _ = json.Marshal(w.model)
	rewritten, err := json.Marshal(fields)
	if err != nil {
		return line
	}

	var out bytes.Buffer
	if isEvent {
		out.WriteString("data: ")
	}
	out.Write(rewritten)
	out.Write(ending)
	return out.Bytes()
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

// finalize writes out any buffered tail (e.g. a non-streamed JSON body with no
// trailing newline) and returns the last usage object seen.
func (w *meteringWriter) finalize() *usage {
	if w.tail.Len() > 0 {
		w.parseLine(w.tail.Bytes())
		w.ResponseWriter.Write(w.rewriteLine(w.tail.Bytes()))
		w.tail.Reset()
	}
	return w.lastUsage
}

// --- Proxy ------------------------------------------------------------------

func newProxy(upstream *url.URL) *httputil.ReverseProxy {
	// High-concurrency transport tuned for long-lived SSE streams.
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100, // keep upstream SSE connections warm
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true, // faster for SSE
	}

	// One reverse proxy, shared across requests (safe for concurrent use).
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.Transport = transport
	proxy.FlushInterval = -1 // flush every write immediately for SSE
	// meteringWriter rewrites `model`, which changes the body length, so the
	// upstream Content-Length no longer holds; let the response be chunked.
	proxy.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("Content-Length")
		resp.ContentLength = -1
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("proxy error to upstream: %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"error":{"message":"Inference backend unavailable","type":"upstream_error"}}`))
	}
	return proxy
}

// proxyHandler serves any OpenAI-compatible endpoint whose body carries a
// `model` field: chat completions and embeddings share the same flow.
func proxyHandler(proxy *httputil.ReverseProxy, meter *Meter) gin.HandlerFunc {
	return func(c *gin.Context) {
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
			c.JSON(http.StatusBadRequest, gin.H{
				"error": gin.H{"message": "failed to read request body", "type": "invalid_request_error"},
			})
			return
		}

		var reqBody map[string]interface{}
		if err := json.Unmarshal(bodyBytes, &reqBody); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": gin.H{"message": "invalid JSON", "type": "invalid_request_error"},
			})
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
		c.Request.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		c.Request.ContentLength = int64(len(bodyBytes))
		c.Request.Header.Set("Content-Type", "application/json")
		c.Request.Header.Set("X-Locci-Tenant", tenant)   // propagate downstream
		c.Request.URL.Path = prefix + c.Request.URL.Path // e.g. /coder/v1/chat/completions

		// 4. Proxy while metering the stream.
		mw := &meteringWriter{ResponseWriter: c.Writer, model: modelName}
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
	}
}

// listModels returns the registry in the OpenAI /v1/models shape.
func listModels(c *gin.Context) {
	ids := make([]string, 0, len(ModelRegistry))
	for id := range ModelRegistry {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	data := make([]gin.H, 0, len(ids))
	for _, id := range ids {
		data = append(data, gin.H{"id": id, "object": "model", "owned_by": "locci", "pool": ModelRegistry[id]})
	}
	c.JSON(http.StatusOK, gin.H{"object": "list", "data": data})
}

func newRouter(upstream *url.URL, meter *Meter) *gin.Engine {
	proxy := newProxy(upstream)
	handle := proxyHandler(proxy, meter)

	r := gin.Default()
	r.POST("/v1/chat/completions", handle)
	r.POST("/v1/embeddings", handle)
	r.GET("/v1/models", listModels)

	// Healthcheck endpoint for Docker / K8s.
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "locci-ai-gateway"})
	})
	return r
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	upstream, err := url.Parse(getenv("UPSTREAM_URL", "http://nginx:80"))
	if err != nil {
		log.Fatalf("invalid UPSTREAM_URL: %v", err)
	}
	addr := getenv("LISTEN_ADDR", ":8080")

	meter := NewMeter(LogSink{}, 1024)
	r := newRouter(upstream, meter)

	log.Printf("Locci AI Gateway listening on %s (upstream %s)", addr, upstream)
	if err := r.Run(addr); err != nil {
		log.Fatal(err)
	}
}
