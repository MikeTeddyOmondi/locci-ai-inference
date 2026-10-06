# llama-server in this project

Everything the inference tier depends on: how the nodes are run, what the flags mean, what the server does with chat templates and tool calls, and the traps found so far. Facts here were read from the running containers (`--help`, `/props`, startup logs) on build **b11434** unless marked otherwise.

Related: [SLMS.md](SLMS.md) (which models, and alternatives), [API_USAGE.md](API_USAGE.md), [SDK_USAGE.md](SDK_USAGE.md).

## Where it sits

```text
KrakenD :8080 -> locci-ai-gateway (router, metering) -> nginx :80 (least_conn) -> llama-server :8080 per node
```

Each node is one `llama-server` process serving one GGUF model over an OpenAI-compatible API. nginx groups nodes into pools by path prefix (`/coder`, `/vision`, `/embed`) and strips the prefix. The router never talks to a node directly.

| Service | Pool | Model file | Profile |
| --- | --- | --- | --- |
| `llama-coder-1`, `llama-coder-2` | `/coder` | `Qwen3-1.7B-Q4_K_M.gguf` | default |
| `llama-vision-1` | `/vision` | `PaddleOCR-VL-1.6.gguf` + `PaddleOCR-VL-1.6-mmproj.gguf` | `vision` |
| `llama-embed-1` | `/embed` | `nomic-embed-text-v1.5.Q4_K_M.gguf` | `embed` |

Filenames come from `.env` (`CODER_MODEL`, `VISION_MODEL`, `VISION_MMPROJ`, `EMBED_MODEL`, plus `CODER_REASONING`); see `.env.example`. `just models --vision --embed` downloads them. Which models and why: [SLMS.md](SLMS.md).

## The image

- **Pinned** to `ghcr.io/ggml-org/llama.cpp:server-b11434` (build 11434, commit `5e03bdd87`), CPU build, multi-arch (arm64 here). The old `ghcr.io/ggerganov/...` path in REFERENCE.md is gone.
- The floating `:server` tag changes with every llama.cpp release, and with it server defaults (`--jinja`) and tool-call parsing. On 2026-10-06 it pointed at the same image as `server-b11434` (identical image ID). Bump the pin deliberately and rerun the checks (`just smoke tools-api tools-sdk ocr-api sdk-e2e`).
- Pinned tags are published as `server-b<build>` for some builds only; check with `docker manifest inspect ghcr.io/ggml-org/llama.cpp:server-b<build>`.

- GPU: the `deploy` block in `compose.yaml` needs a CUDA image (`:server-cuda`) as well as the NVIDIA toolkit. Docker on macOS (Colima) has no GPU passthrough, so local is CPU only.

## Flags we pass

| Flag | Where | Meaning |
| --- | --- | --- |
| `-m /models/<file>` | all | The GGUF to load. |
| `--host 0.0.0.0 --port 8080` | all | Listen inside the container network. |
| `-c 8192` | coder | **Total** context, shared by all slots (see below). |
| `--cont-batching` | coder | Batch concurrent requests into one forward pass. Already the default; kept for clarity. |
| `--parallel 4` | coder | 4 slots: up to 4 requests generate concurrently per node. |
| `--jinja --reasoning off` | coder | Use the model's own template (the default, set explicitly because tool calling depends on it) and keep Qwen3's thinking off so answers and tool calls land in `content` / `tool_calls`. `CODER_REASONING` in `.env` overrides. |
| `--mmproj <file>` | vision | The image projector (vision encoder) that pairs with the language model. |
| `-c 8192 --parallel 2 --temp 0` | vision | 2 slots of 4096 tokens (an image costs ~300 to 500 tokens); greedy decoding as the model card recommends. |
| `--embedding -c 2048` | embed | Serve `/v1/embeddings` instead of chat. |

### Context is split across slots

`-c` is the total KV cache, divided by `--parallel`. The coder nodes log `n_slots = 4, n_ctx_slot = 2048`, so **each request gets 2048 tokens for prompt plus output**, not 8192. A longer conversation fails with a context-size error. Raise `-c` (memory grows with it) or lower `--parallel` (less concurrency) to change the trade-off; `/props` reports the per-slot value as `default_generation_settings.n_ctx`.

### Defaults worth knowing

From `/props` and `--help` on b11434:

| Setting | Default | Note |
| --- | --- | --- |
| `--jinja` | **enabled** | Use the model's own chat template (below). `--no-jinja` turns it off. |
| `temperature` / `top_p` / `top_k` | 0.8 / 0.95 / 40 | Per-request values override. |
| `n_predict` (`max_tokens`) | -1 (until EOS or context end) | Always send `max_tokens` from clients. |
| `--reasoning-format` | auto (resolves to `none` for this model) | Where `<think>` output goes for reasoning models. |
| `--reasoning` | auto | `on`/`off` switches thinking for models that have it. |
| `-cb` (continuous batching) | enabled | Our `--cont-batching` flag is redundant but harmless. |
| `-ub` (micro-batch) | 512 | Caps embedding input length (see Embeddings node). |
| `/metrics` | disabled (501) | Enable with `--metrics` for Prometheus. |
| `/slots` | enabled | Per-slot state; useful for debugging, consider `--no-slots` in production. |
| threads | 4 | One per vCPU of the Colima VM. |

## Chat templates and `--jinja`

Every GGUF embeds a chat template: a Jinja script that turns OpenAI `messages` (and `tools`) into the exact prompt text the model was trained on. With `--jinja`, llama-server runs that template. Without it, the server falls back to a fixed set of built-in templates that format plain chat but **ignore `tools` and never parse tool calls**.

So `--jinja` is required for tool calling. It is **on by default** in this build (`--jinja, --no-jinja ... (default: enabled)`), so nothing needs adding today. Pinning the image (above) or passing `--jinja` explicitly protects against a future default change; `LLAMA_ARG_JINJA=1` is the env equivalent.

See what a node will actually send the model:

```bash
curl -s http://localhost:8082/coder/apply-template -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"f","parameters":{"type":"object"}}}]}'
```

(`localhost:8082` is nginx, published for host-side debugging; the path prefix picks the pool.)

## Tool calling

### How it works

1. **Prompting.** With `tools` in the request, the template inserts the tool definitions in the model's trained format. Qwen2.5 uses Hermes style: a `# Tools` system section with `<tools>...</tools>` and an instruction to answer with `<tool_call>{"name": ..., "arguments": ...}</tool_call>`.
2. **Parsing.** The server derives a parser from the template (log: `using differential autoparser`, `chat format: peg-native`). Output wrapped in `<tool_call>` tags becomes an OpenAI `tool_calls` array; anything else stays in `content`.
3. **Constraining.** For `tool_choice: "required"` the server also builds a grammar (log: `Grammar (tool_calls): ...`).

`/props` reports what the template supports; for the coder nodes: `supports_tools: true`, `supports_tool_calls: true`, `supports_parallel_tool_calls: true`.

### What we measured

`just tools-api` (curl) and `just tools-sdk` (AI SDK) check the protocol, not answer quality.

**Now (Qwen3-1.7B, `--reasoning off`): every check passes**, three runs in a row: forced calls parse into `tool_calls`, results round-trip, streamed calls reassemble, and `"auto"` calls the tool when the question needs it but not for unrelated prompts. `/props` reports `supports_tools`, `supports_tool_calls` and `supports_parallel_tool_calls` all true.

**Before (Qwen2.5-Coder-1.5B, retired): both scripts failed**, which is why the coder model changed:

- **The model does not use the format.** Asked for the weather in Nairobi with a `get_weather` tool, it writes the call as a markdown ```` ```json ```` block, or as `{{"name": ...}}` copying literal double braces that appear in Qwen2.5's template. No `<tool_call>` tags, so nothing is parsed and the call arrives as text.
- **`tool_choice: "required"` does not force a call on this build.** The generated grammar is `root ::= "<|im_start|>assistant\n" space until-168? tool-calls`, where `until-168` permits any text before the first `<tool_call>`. A model that never emits the tag writes until `max_tokens` (`finish_reason: "length"`). The AI SDK then throws `AI_ToolChoiceViolationError`.

The template, the parser, our router and the SDK all behaved correctly; the gateway passes `tools` and `tool_choice` through unchanged (checked by sending the same request straight to a node). The blocker was the model. The `required` grammar loophole still exists on this build; it only matters for models that don't emit the tag.

**Control:** a same-size general model, Qwen2.5-1.5B-Instruct, passed every check on the same build, isolating the coder fine-tune as the problem. Any model can be tried the same way without editing files:

```bash
CODER_MODEL=<file>.gguf docker compose up -d --wait llama-coder-1 llama-coder-2
just tools-api && just tools-sdk
docker compose up -d --wait llama-coder-1 llama-coder-2   # back to the configured model
```

### Writing tool-calling checks

- **Use `temperature: 0`.** At the default 0.8, the loose `required` grammar lets a capable model occasionally open with text and never reach the call: one of five forced calls failed that way before the scripts pinned temperature; none failed after.
- **Test the protocol, not judgement.** Force the call with `tool_choice: "required"`, then check the shape. Treat `"auto"` results as information; small models are erratic about *whether* to call.
- **The AI SDK raises `AI_ToolChoiceViolationError`** when `toolChoice: "required"` gets no call, carrying the text the model produced instead; useful when debugging.

### Model-specific catches

- **Thinking models** (Qwen3, Qwen 3.5, Gemma 4) may put tool calls in `reasoning_content` unless thinking is off. This build has `--reasoning off` for that; template-level alternatives are `--chat-template-kwargs '{"enable_thinking":false}'` (reported to need no spaces in the JSON for Qwen) or per request `"chat_template_kwargs":{"enable_thinking":false}`.
- **Template bugs** are worked around with `--chat-template-file <file.jinja>` (a corrected copy of the model's template). Qwen2.5's own template contains literal `{{"name": ...}}` double braces in its tool instructions, which the 1.5B coder copies into its output.

## Endpoints on a node

| Path | Use |
| --- | --- |
| `/health` | 200 once the model is loaded; the compose healthchecks wait on it. |
| `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` | OpenAI-compatible API (what the gateway uses). |
| `/props` | Build, template, capabilities, per-slot context and default sampling. |
| `/slots` | Live slot state. |
| `/apply-template` | Render the prompt for given messages/tools without generating. |
| `/tokenize`, `/detokenize` | Token counts for budgeting prompts. |

## Responses

- **Usage**: non-streamed responses always include `usage`; streamed ones include a final usage chunk only when asked with `stream_options.include_usage`, which the router always injects. Metering depends on it.
- **`model`** in the response is the GGUF path the node loaded; the router rewrites it to the requested id before it reaches clients.
- **`timings`**: llama.cpp's own block (prompt and generation tokens and milliseconds) is passed through.

## Embeddings node

- `nomic-embed-text-v1.5` returns 768-dimensional vectors.
- The node warns at startup: `embeddings enabled with n_batch (2048) > n_ubatch (512)`. For embeddings a whole input must fit in one micro-batch, so **inputs over 512 tokens fail**. Measured: a 531-token input returns `500 {"error":{"code":500,"message":"input (531 tokens) is too large to process. increase the physical batch size (current batch size: 512)","type":"server_error"}}`, and the gateway passes it through. Add `-ub 2048 -b 2048` to the embed command if longer inputs are expected (nomic-embed v1.5 is trained up to 8192 tokens; `-c` caps it too).
- nomic-embed is trained with task prefixes (`search_query: `, `search_document: `); retrieval quality is better when clients add them. The gateway does not.

## Measured on this machine

Colima VM, 4 vCPU, 7.7 GiB RAM, CPU only, b11434:

| Node | Resident memory | Speed |
| --- | --- | --- |
| coder (Qwen3-1.7B Q4_K_M, `-c 8192`) | ~2.1 GiB each | ~50 tokens/s generation, ~190 tokens/s prompt |
| vision (PaddleOCR-VL 1.6 + F16 mmproj) | ~1.5 GiB | 13 to 14 tokens/s generation; **image prompts ~2.8 tokens/s**: 110 to 180 s per image |
| embed (nomic Q4_K_M) | ~100 to 150 MiB | |
| (retired) coder Qwen2.5-Coder-1.5B | ~1.25 GiB each | ~56 tokens/s generation |

All four nodes together use ~5.8 GiB of the 7.7 GiB VM: there is no room for another coder node or a bigger model. A 7B Q4_K_M model needs ~4.5 to 5 GiB per node.

The vision encoder is the slow part on CPU: the 900x420 test invoice (493 prompt tokens, mostly image) took 175 s to read and 4 s to write out. Long timeouts are already in place (600 s at KrakenD and nginx), but real documents want a GPU.

## Debugging

```bash
docker compose logs -f llama-coder-1                       # server log
docker compose exec llama-coder-1 /app/llama-server --help # flags of the running build
curl -s http://localhost:8082/coder/props | python3 -m json.tool
```

For a verbose look at templating, grammar and parsing, run a throwaway node with `--verbose` (it logs the generated parser, the grammar, and `Parsed message:` for each response):

```bash
docker run --rm --network locci-network -v "$PWD/models:/models:ro" \
  ghcr.io/ggml-org/llama.cpp:server -m /models/<file>.gguf --host 0.0.0.0 --port 8080 -c 2048 --verbose
```
