package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func init() { gin.SetMode(gin.TestMode) }

// chanSink forwards recorded events to a channel so tests can assert on them.
type chanSink chan MeterEvent

func (s chanSink) Record(e MeterEvent) { s <- e }

func newTestWriter() *meteringWriter {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	return &meteringWriter{ResponseWriter: c.Writer}
}

func TestMeteringWriterSSESplitAcrossWrites(t *testing.T) {
	w := newTestWriter()
	stream := "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":5,\"total_tokens\":8}}\n\n" +
		"data: [DONE]\n\n"
	// Feed in awkward 7-byte chunks so the usage line straddles writes.
	for i := 0; i < len(stream); i += 7 {
		end := min(i+7, len(stream))
		w.Write([]byte(stream[i:end]))
	}
	u := w.finalize()
	if u == nil || u.PromptTokens != 3 || u.CompletionTokens != 5 || u.TotalTokens != 8 {
		t.Fatalf("unexpected usage: %+v", u)
	}
}

func TestMeteringWriterPlainJSONNoTrailingNewline(t *testing.T) {
	w := newTestWriter()
	w.Write([]byte(`{"object":"list","usage":{"prompt_tokens":4,"total_tokens":4}}`))
	u := w.finalize()
	if u == nil || u.PromptTokens != 4 || u.TotalTokens != 4 {
		t.Fatalf("unexpected usage: %+v", u)
	}
}

func TestMeteringWriterNoUsage(t *testing.T) {
	w := newTestWriter()
	w.Write([]byte("data: {\"choices\":[]}\n\ndata: [DONE]\n\n"))
	if u := w.finalize(); u != nil {
		t.Fatalf("expected no usage, got %+v", u)
	}
}

func setup(t *testing.T, upstream http.HandlerFunc) (*httptest.Server, chanSink) {
	t.Helper()
	backend := httptest.NewServer(upstream)
	t.Cleanup(backend.Close)
	u, _ := url.Parse(backend.URL)
	sink := make(chanSink, 8)
	gw := httptest.NewServer(newRouter(u, NewMeter(sink, 8)))
	t.Cleanup(gw.Close)
	return gw, sink
}

func post(t *testing.T, base, path, tenant, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, base+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if tenant != "" {
		req.Header.Set("X-Locci-Tenant", tenant)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestMissingTenantIs401(t *testing.T) {
	gw, _ := setup(t, func(w http.ResponseWriter, r *http.Request) { t.Error("upstream must not be called") })
	resp := post(t, gw.URL, "/v1/chat/completions", "", `{"model":"qwen-coder-7b"}`)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", resp.StatusCode)
	}
}

func TestUnknownModelIs400(t *testing.T) {
	gw, _ := setup(t, func(w http.ResponseWriter, r *http.Request) { t.Error("upstream must not be called") })
	resp := post(t, gw.URL, "/v1/chat/completions", "acme", `{"model":"gpt-9"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", resp.StatusCode)
	}
}

func TestStreamIsRoutedRewrittenAndMetered(t *testing.T) {
	gw, sink := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/coder/v1/chat/completions" {
			t.Errorf("unexpected upstream path %q", r.URL.Path)
		}
		if r.Header.Get("X-Locci-Tenant") != "acme" {
			t.Errorf("tenant header not propagated")
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if opts, _ := body["stream_options"].(map[string]any); opts["include_usage"] != true {
			t.Errorf("stream_options.include_usage not injected: %v", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")
		w.(http.Flusher).Flush()
		io.WriteString(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":1,\"total_tokens\":3}}\n\ndata: [DONE]\n\n")
	})

	resp := post(t, gw.URL, "/v1/chat/completions", "acme", `{"model":"qwen-coder-7b","stream":true,"messages":[]}`)
	got, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(got), "[DONE]") {
		t.Fatalf("bad response %d: %s", resp.StatusCode, got)
	}

	select {
	case e := <-sink:
		if e.Tenant != "acme" || e.Model != "qwen-coder-7b" || e.Pool != "/coder" || e.TotalTokens != 3 {
			t.Fatalf("unexpected meter event: %+v", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no meter event recorded")
	}
}

func TestEmbeddingsRouteToEmbedPool(t *testing.T) {
	gw, sink := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/embed/v1/embeddings" {
			t.Errorf("unexpected upstream path %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"data":[],"usage":{"prompt_tokens":6,"total_tokens":6}}`)
	})
	resp := post(t, gw.URL, "/v1/embeddings", "acme", `{"model":"embedding-nomic","input":"hello"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	select {
	case e := <-sink:
		if e.Pool != "/embed" || e.TotalTokens != 6 {
			t.Fatalf("unexpected meter event: %+v", e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no meter event recorded")
	}
}

func TestUpstreamDownIs502(t *testing.T) {
	u, _ := url.Parse("http://127.0.0.1:1")
	gw := httptest.NewServer(newRouter(u, NewMeter(LogSink{}, 1)))
	defer gw.Close()
	resp := post(t, gw.URL, "/v1/chat/completions", "acme", `{"model":"qwen-coder-7b"}`)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("want 502, got %d", resp.StatusCode)
	}
}
