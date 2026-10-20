# Small language models (SLMs)

Which models the gateway serves today, how they behave, and candidates worth evaluating. "Measured" means checked on this stack; everything else is reported by the linked sources and should be verified with `just tools-api` / `just tools-sdk` / `just sdk-e2e` before switching.

How to run any of these is in [LLAMA_SERVER.md](LLAMA_SERVER.md).

## What we serve now

Each gateway model id names the model running in its pool. Everything runs in the Colima VM (4 vCPU, 7.7 GiB, CPU only), on llama.cpp `server-b11434` (pinned).

| Gateway id | Pool | Running | Status (measured on this stack) |
| --- | --- | --- | --- |
| `qwen2.5-coder-1.5b` | qwen25-coder (1 node) | Qwen2.5-Coder-1.5B-Instruct Q4_K_M (1.0 GB) | Code generation, ~56 tokens/s. **Cannot call tools** (see below). 1.25 to 2.3 GiB resident. |
| `qwen3-1.7b` | coder (1 node) | **Qwen3-1.7B** Q4_K_M (1.28 GB, ggml-org), `--reasoning off` | Chat and code ~50 tokens/s generation, ~190 tokens/s prompt. **Tool calling passes** every `just tools-api` / `just tools-sdk` check, 3 runs in a row. ~2.8 to 3.8 GiB resident (8192 tokens per request, prompt cache capped at 1 GiB). |
| `gemma-4-e2b` | gemma (1 node, opt-in) | **Gemma 4 E2B** Q4_K_M (3.1 GB) + F16 mmproj (0.99 GB), `--reasoning off` | On trial. **Tool calling passes** every `just tools-api` / `tools-sdk` check. **Reads images**: exact text from both OCR fixtures in 5 to 6 s. ~33 tokens/s. ~2.9 to 3.1 GiB resident. |
| `baidu-ocr-vision` | vision | **PaddleOCR-VL 1.6** (0.94 GB) + mmproj (0.88 GB), `--temp 0` | `just ocr-api` passes: exact text from an invoice image, and a 3x3 table. **Slow on CPU**: 110 to 180 s per image (see below). ~1.5 GiB resident. |
| `embedding-nomic` | embed | nomic-embed-text v1.5 Q4_K_M (80 MB) | 768 dims. Inputs over 512 tokens fail until `-ub` is raised. |

### Qwen3-1.7B (coder pool), measured

- **Tool calling:** forced calls (`tool_choice: "required"`) are parsed into `tool_calls`, tool results round-trip into a text answer, and streamed calls reassemble from deltas, through curl and through the AI SDK. With `"auto"` it called the tool when the question needed it (3 of 3) and answered in plain text for an unrelated prompt with tools present (3 of 3).
- **Thinking:** off via `--reasoning off`; no `<think>` text or `reasoning_content` in responses. Set `CODER_REASONING=on` in `.env` to enable it (answers get slower and longer; tool calls may then appear in `reasoning_content`).
- **Memory:** 3.1 GiB after start and 4.2 GiB under a 13,000-token prompt with `-c 32768 --parallel 2`, q8_0 KV cache, `--cache-ram 1024` (16384 tokens per request; previously ~2.8 to 3.8 GiB at 8192 per request with an f16 cache), against ~1.25 GiB for Qwen2.5-Coder. Without the `--cache-ram` cap the prompt cache grew until the OOM killer took the node; see [LLAMA_SERVER.md](LLAMA_SERVER.md#measured-on-this-machine).

### Gemma 4 E2B (gemma pool), measured

- **Setup:** the default pool: `just models`, then `just up`. Q4_K_M from `unsloth/gemma-4-E2B-it-GGUF` plus its `mmproj-F16.gguf`, `-c 65536 --parallel 2` (32768 tokens per request; it was 8192 until CLI agent sessions ran past it, and the larger window kept resident memory at ~2.9 GiB, since most of Gemma 4's layers attend over a 512-token sliding window; prompts read at ~50 tokens/s on 4 vCPUs, slowing as they grow, so a full window takes minutes the first time and llama.cpp's prefix cache spares the rest), q8_0 KV cache, `--cache-ram 512`, `--reasoning off`. The projector also enables audio input, which llama.cpp marks experimental (untested here).
- **Tool calling:** with thinking off, every check in `MODEL=gemma-4-e2b scripts/tool-calls-api.sh` and the SDK's `scripts/tool-calls.ts` passes: forced call, result round trip, streamed call, and `"auto"` calls the tool when the question needs it.
- **Images:** sent as `image_url` parts with a plain instruction (no task prompts needed). "Transcribe all the text in this image exactly" returned every line of the invoice fixture in 6.2 s (192 prompt tokens), and "Convert this table to Markdown" a correct Markdown table in 4.6 s (125 prompt tokens). PaddleOCR-VL takes 110 to 175 s for the same images, because Gemma encodes an image into far fewer tokens. PaddleOCR-VL remains the specialist for dense documents, formulas and seals; not compared on those yet.
- **Speed:** ~33 tokens/s generation, ~40 tokens/s on short prompts (Qwen3-1.7B: ~50).
- **Memory:** 3.1 GiB after start, 2.9 GiB after the checks. Next to the Qwen3 node (3.6 GiB) that is 6.7 of the 7.7 GiB VM before long prompts, so run either alongside Qwen3 with the other opt-in pools off, or instead of it.

### PaddleOCR-VL 1.6 (vision pool), measured

- **Prompts:** send the image plus a task prompt: `OCR:`, `Table Recognition:`, `Formula Recognition:`, `Chart Recognition:` or `Seal Recognition:`. (`Spotting:` also exists but needs the mmproj's `clip.vision.image_max_pixels` raised; not set up here.)
- **Output:** `OCR:` returns plain text with line breaks. **`Table Recognition:` returns OTSL tokens, not HTML or Markdown**: `<fcel>` starts a cell, `<nl>` ends a row, e.g. `<fcel>Model<fcel>Pool<nl><fcel>Qwen3-1.7B<fcel>coder<nl>`. Clients convert it (empty cells and spans use further OTSL tokens such as `<ecel>`, `<lcel>`, `<ucel>`).
- **Speed:** generation is fine (13 to 14 tokens/s), but encoding the image is CPU-bound at ~2.8 tokens/s of prompt: 175 s for a 900x420 invoice (493 prompt tokens) and 109 s for a small table (313). Expect minutes per page on this VM. A GPU, more cores, or a quantized mmproj (only F16 is published officially) are the levers. Callers need generous timeouts; the gateway's are 600 s.

### Qwen2.5-Coder-1.5B (`qwen2.5-coder-1.5b` pool), measured

Served for code generation (~56 tokens/s). It cannot call tools: given a `get_weather` tool it wrote the call as a markdown JSON block (or `{{"name": ...}}`, copying literal braces from its own template) instead of `<tool_call>` tags, so llama-server parsed nothing, and `tool_choice: "required"` did not force it on this build. A same-size general model, Qwen2.5-1.5B-Instruct, passed the same checks, which isolated the coder fine-tune as the problem. Details in [LLAMA_SERVER.md](LLAMA_SERVER.md#tool-calling). It used to back the coder pool alone; it now has its own pool and id so tool-calling clients use `qwen3-1.7b`.

## Candidates

Sizes are approximate Q4_K_M files. "Fits" is for this 7.7 GiB VM with the other pools running; a GPU box changes the picture.

### Chat, code and tool calling (`coder` pool)

| Model | Size | Why consider it | Fits locally |
| --- | --- | --- | --- |
| **Qwen3-1.7B** (in use) | 1.28 GB | Top sub-2B score (0.960) on a published local tool-calling benchmark. Hermes `<tool_call>` format, which llama.cpp parses. **Running now; passes our checks.** | Yes, two nodes |
| Qwen2.5-1.5B-Instruct | ~1.1 GB | Measured here: passes the protocol checks but is weak at deciding *when* to call. A baseline, superseded by Qwen3-1.7B. | Yes, two nodes |
| **LFM2.5-1.2B** (Liquid AI) | ~0.8 GB | Second on the same benchmark (0.920); built for edge and CPU. | Yes, two nodes |
| **Qwen3.5 2B / 4B** | 1.28 / 2.74 GB | Newest Qwen below 27B (Feb to Mar 2026), 262K context, hybrid attention (small KV cache). Downloaded; see below. | 2B yes; 4B one node |
| **Gemma 4 E2B / E4B** | 3.1 / ~5 GB | Native function calling, 128K context, multimodal (image, audio). **E2B runs as `gemma-4-e2b`, the default pool; passes our checks** (see above). | E2B yes (one node); E4B GPU box |
| **Qwen 3.5 9B** | ~6 GB | Recommended 8 GB-tier pick for tool calling in a mid-2026 guide. | No (GPU box) |
| **Qwen2.5-Coder-7B** | ~4.7 GB | The model the old `qwen-coder-7b` id named. Strong code completion, older tool-calling. | One node only |
| Phi-4-mini (3.8B), SmolLM3-3B | ~2.5 / ~2 GB | Solid 3 to 4B generalists; worth a look if Qwen or Gemma disappoint. | One to two nodes |

Qwen 3.6 and 3.8 start at 27B and Gemma 4's next size is 12B: GPU territory, not SLMs for this box.

### Qwen candidates: downloaded, not yet tested

`scripts/fetch-models.sh --qwen-candidates` downloads five alternatives to the running Qwen3-1.7B into `models/` (git-ignored; one flag per model is listed in the script). None has been run through the checks yet. Architecture and template facts below come from each file's own metadata (`scripts/gguf-info.py`); memory and speed are estimates until measured.

| Model | File (repo) | Disk | Tool-call format | Thinking | Smoothness |
| --- | --- | --- | --- | --- | --- |
| Qwen3-1.7B (running) | `Qwen3-1.7B-Q4_K_M.gguf` (ggml-org) | 1.19 GiB | `<tool_call>` JSON | switchable; we run `--reasoning off` | Measured: passes everything |
| **Qwen3-4B-Instruct-2507** | `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (unsloth) | 2.33 GiB | `<tool_call>` JSON, same as now | none: a non-thinking model | Drop-in; the most likely upgrade in answer quality and tool judgement |
| Qwen3-4B | `Qwen3-4B-Q4_K_M.gguf` (ggml-org, official) | 2.33 GiB | `<tool_call>` JSON, same as now | switchable, keep `--reasoning off` | Drop-in |
| Qwen3-0.6B | `Qwen3-0.6B-Q8_0.gguf` (ggml-org; no Q4_K_M published) | 0.75 GiB | `<tool_call>` JSON, same as now | switchable, keep `--reasoning off` | Drop-in; fastest, weakest (0.880 on the sub-2B tool benchmark vs 0.960 for 1.7B) |
| **Qwen3.5-2B** | `Qwen3.5-2B-Q4_K_M.gguf` (unsloth) | 1.19 GiB | **XML style**: `<tool_call><function=name><parameter=…>` | switchable, keep `--reasoning off` | Likely, unverified: needs llama.cpp to parse the newer format |
| Qwen3.5-4B | `Qwen3.5-4B-Q4_K_M.gguf` (unsloth) | 2.55 GiB | XML style, as above | switchable, keep `--reasoning off` | Likely, unverified, as above |

#### Architecture and memory

The KV cache is the per-token memory a request's context costs; it is what decides how many tokens a 7.7 GiB VM can afford. Qwen3.5 is a hybrid: most of its layers use linear attention with a small fixed state, so only a quarter of the layers keep a KV cache.

| Model | Layers (with KV cache) | KV heads × dim | Trained context | KV per token | KV at our 16k (`-c 16384`) | KV at 8k |
| --- | --- | --- | --- | --- | --- | --- |
| Qwen3-1.7B (running) | 28 (28) | 8 × 128 | 40,960 | 112 KiB | 1.75 GiB | 0.88 GiB |
| Qwen3-0.6B | 28 (28) | 8 × 128 | 40,960 | 112 KiB | 1.75 GiB | 0.88 GiB |
| Qwen3-4B / 4B-Instruct-2507 | 36 (36) | 8 × 128 | 40,960 / 262,144 | 144 KiB | 2.25 GiB | 1.13 GiB |
| Qwen3.5-2B | 24 (6) | 2 × 256 | 262,144 | 12 KiB | 0.19 GiB | 0.09 GiB |
| Qwen3.5-4B | 32 (8) | 4 × 256 | 262,144 | 32 KiB | 0.50 GiB | 0.25 GiB |

#### Minimum resources

Peak memory is estimated from the one measured point: Qwen3-1.7B peaks at ~3.8 GiB (`RssAnon`) with our settings (`-c 16384 --parallel 2 --cache-ram 1024`, 8192 tokens per request), and the estimate adds each model's difference in file size and KV cache. "Fits" assumes the rest of the default stack is up (Qwen2.5-Coder ~1.3 GiB, embed, KrakenD, router, nginx, the VM itself: ~2.2 GiB), leaving ~5.5 GiB of the 7.7 GiB VM for this node, or ~4.3 GiB with the vision pool on. Speed scales roughly inversely with parameter count from the measured ~50 tokens/s on 4 vCPUs.

| Model | Disk | Peak RAM, our settings (est.) | Peak RAM at `-c 8192 --parallel 1` (est.) | Fits the 8 GiB Colima VM | Generation on 4 vCPU (est.) |
| --- | --- | --- | --- | --- | --- |
| Qwen3-1.7B (running) | 1.2 GiB | 3.8 GiB (measured) | ~2.9 GiB | Yes (measured) | ~50 tokens/s (measured) |
| Qwen3-0.6B | 0.75 GiB | ~3.3 GiB | ~2.5 GiB | Yes | ~100 tokens/s |
| Qwen3.5-2B | 1.2 GiB | ~2.2 GiB | ~2.1 GiB | Yes, with the most headroom | ~40 tokens/s |
| Qwen3.5-4B | 2.6 GiB | ~3.9 GiB | ~3.6 GiB | Yes | ~20 tokens/s |
| Qwen3-4B / 4B-Instruct-2507 | 2.3 GiB | ~5.4 GiB | ~4.3 GiB | Only with vision off, or at `-c 8192 --parallel 1`, or with Colima at 12 GiB | ~20 tokens/s |

Every candidate needs at least 8192 tokens per request for the examples' 16 tools (their schemas alone are ~2,550 tokens), so don't go below `-c 8192 --parallel 1`.

#### Caveats

- **None are tested here yet.** "Drop-in" means the same template family and tool-call syntax as the running model, not a passed check.
- **Qwen3.5's tool-call format is new to this stack.** llama.cpp derives its parser from the template, and b11434 is recent, but if `just tools-api` shows calls arriving as text in `content`, the format is not parsed.
- **Community quants.** Qwen's own Qwen3.5 GGUF repos are gated (they return 401), and the 4B-Instruct-2507 Q4_K_M is also unsloth's; ggml-org publishes the plain Qwen3 files. Pin the file you test.
- **4B models are slower:** about half the speed of the 1.7B on CPU, so the first tool-calling request (~5,200 prompt tokens) would take roughly 50 s instead of 25.
- **Thinking:** keep `CODER_REASONING=off` for tool calling with every switchable model. The 4B-Instruct-2507 has no thinking mode, so the flag does nothing there.

#### Trying a candidate

No file edits are needed to try one; the override lasts until the node is recreated without it.

```bash
just auth && just up                      # locci-auth and the gateway
scripts/fetch-models.sh --qwen3.5-2b      # if not downloaded yet
CODER_MODEL=Qwen3.5-2B-Q4_K_M.gguf docker compose up -d --wait llama-coder-1

just tools-api && just tools-sdk          # protocol: forced call, round trip, streaming
just examples-api                         # terminal 2
just examples-check                       # the real apps, 16 tools
docker compose exec llama-coder-1 grep RssAnon /proc/1/status   # memory, after the checks

docker compose up -d --wait llama-coder-1 # back to the configured model
```

For a 4B Qwen3 on the 8 GiB VM, add `CODER_CTX=8192 CODER_PARALLEL=1` (or stop the vision pool) to the override. Record what you measure (pass/fail, tokens/s, peak `RssAnon`) in this file. To adopt one, set `CODER_MODEL` in `.env`, and rename the `qwen3-1.7b` id in `locci-ai-gateway/main.go` and `packages/ai-sdk/src/models.ts` to match (see "Switching a model").

### Other families (not downloaded)

Different tool-call formats or thinking defaults, so more risk than the Qwen candidates. Sizes are Q4_K_M files on Hugging Face.

| Model | GGUF | Size | Caveats |
| --- | --- | --- | --- |
| LFM2.5-1.2B (Liquid AI) | `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` (official) | 0.73 GB | 0.920 on the sub-2B tool benchmark and built for CPU, but Liquid uses its own tool-call format; llama.cpp parsing of it unconfirmed |
| SmolLM3-3B | `ggml-org/SmolLM3-3B-GGUF` | 1.92 GB | Has a thinking mode to turn off; tool calls through its own template |
| Gemma 4 E2B | `unsloth/gemma-4-E2B-it-GGUF` | 3.11 GB | Larger than "2B" suggests (multimodal); thinks by default, so tool calls land in `reasoning_content` unless disabled |
| Phi-4-mini | `unsloth/Phi-4-mini-instruct-GGUF` | 2.49 GB | Community quant only; llama.cpp tool-call support unconfirmed |

### Document OCR and vision (`vision` pool)

| Model | Size | Why consider it |
| --- | --- | --- |
| **PaddleOCR-VL 1.6** (Baidu, in use) | 0.94 GB + 0.88 GB mmproj | **Running now** (see above). The model the `baidu-ocr-vision` id describes. 0.9B document OCR: text in 109 languages, tables, formulas to LaTeX, charts, seals. Reports 96.33% on OmniDocBench v1.6 (v1.5 scored 94.5%, above Qwen2.5-VL-72B at 87.0%). In llama.cpp since b8110 (Feb 2026); our b11434 is newer. |
| **Unlimited-OCR** (Baidu) | ~1.95 GB Q4_K_M + ~0.83 GB mmproj | Whole-document parsing in one pass, including multi-page PDFs. See below. |
| Gemma 4 E2B / E4B | ~1.5 / ~3 GB | General image understanding plus chat, if the pool should do more than OCR. |

PaddleOCR-VL replaced LLaVA 1.5 (a 2023 general vision model, never tested here) in the vision pool.

#### Unlimited-OCR (Baidu)

[GitHub](https://github.com/baidu/Unlimited-OCR) · [Hugging Face](https://huggingface.co/baidu/Unlimited-OCR) · [paper (arXiv 2606.23050)](https://arxiv.org/abs/2606.23050) · MIT license · released 2026-06-22

Baidu's long-document parser, positioned as taking DeepSeek-OCR "one step further". Where PaddleOCR-VL recognises one element at a time from a task prompt (`OCR:`, `Table Recognition:`, ...), Unlimited-OCR parses a whole page, or a sequence of pages, into structured output in a single generation ("one-shot long-horizon parsing").

| | |
| --- | --- |
| Architecture | DeepSeek-OCR v1's DeepEncoder (vision) + a DeepSeek-V2 MoE decoder whose attention is replaced by R-SWA (Reference Sliding Window Attention). llama.cpp architecture name: `deepseek2-ocr`. |
| Size | 3.34B parameters; 6.8 GB in BF16. Community GGUFs: ~1.95 GB at Q4_K_M plus a ~0.83 GB F16 mmproj. |
| Prompts | `<image>document parsing.` for a page; `<image>Multi page parsing.` for several pages (PDFs are converted to page images first, at 300 DPI in the reference code). |
| Reference runtimes | `transformers` with `trust_remote_code` on NVIDIA GPUs (bf16, `max_length=32768`); vLLM (`vllm/vllm-openai:unlimited-ocr` images, [recipe](https://recipes.vllm.ai/baidu/Unlimited-OCR)); also on Baidu Cloud and ModelScope. |
| llama.cpp | Supported in mainline since PR [#24969](https://github.com/ggml-org/llama.cpp/pull/24969) (merged around 2026-07-01), so our b11434 should load it. That support runs the decoder with **full attention**; R-SWA is in PR [#24975](https://github.com/ggml-org/llama.cpp/pull/24975), still open as of the GGUF publishers' notes, so long multi-page inputs cost more memory than in the reference implementation. The tile-limit fix [#25614](https://github.com/ggml-org/llama.cpp/pull/25614) is merged. |
| GGUFs | No official one. Community: [sabafallah/Unlimited-OCR-GGUF](https://huggingface.co/sabafallah/Unlimited-OCR-GGUF) (documents the PR status, mmproj re-uploaded 2026-07-13 with `preproc_max_tiles = 32`), [vimalnakrani/unlimited-ocr-gguf](https://huggingface.co/vimalnakrani/unlimited-ocr-gguf), [sahilchachra/Unlimited-OCR-GGUF](https://huggingface.co/sahilchachra/Unlimited-OCR-GGUF) (an older upload that needed an unmerged PR build). |

**Caveats before adopting it here.** One GGUF publisher verified image inference only with `llama-mtmd-cli` and reports that `llama-server`'s multimodal endpoint did not accept the model's image prompt in their build; that must be tested on our build before it can sit behind the gateway. At ~2.8 GB resident plus full-attention KV for long documents, it does not fit beside two coder nodes and PaddleOCR-VL in the current 7.7 GiB VM; it would replace PaddleOCR-VL locally or run on a bigger box.

**Where it fits.** PaddleOCR-VL for fast, small, per-element recognition (a field, a table, a formula); Unlimited-OCR for turning whole documents or PDFs into structured text in one call. If both are offered they deserve separate ids (for example `baidu-ocr-vision` and `baidu-unlimited-ocr`), since prompts and output shape differ.

### Embeddings (`embed` pool)

| Model | Size | Dims | Why consider it |
| --- | --- | --- | --- |
| nomic-embed-text v1.5 (current) | 80 MB | 768 | Small and fast; English-centric. Wants `search_query:` / `search_document:` prefixes. |
| **Qwen3-Embedding-0.6B** | ~640 MB (Q8) | up to 1024 | Multilingual; the family's 8B tops MTEB multilingual, the 0.6B is the small end. |
| **EmbeddingGemma-300m** | ~300 MB | 768 | Google's small multilingual embedder. |
| nomic-embed v2 (MoE) | larger | 768 | 8K context, Apache 2.0. |

Changing the embedding model changes the vector space (and possibly the dimension): every stored vector must be re-embedded. Expose a new model id (for example `embedding-qwen3`) beside the old one rather than swapping in place.

## Switching a model

1. Download the GGUF into `models/` (add it to `scripts/fetch-models.sh`).
2. Point the pool at it: set `CODER_MODEL` / `VISION_MODEL` / `EMBED_MODEL` in `.env`, or edit the command in `compose.yaml` (add `--reasoning off` for thinking models).
3. If the id should change, edit `ModelRegistry` in `locci-ai-gateway/main.go` **and** `packages/ai-sdk/src/models.ts`; `just sdk-test` fails if they disagree.
4. `just up`, then `just smoke`, `just tools-api`, `just tools-sdk` and `just sdk-e2e`.

Ids currently name the model (`qwen3-1.7b`, `qwen2.5-coder-1.5b`): honest, but a model swap changes the id clients use. Capability ids (`locci-coder`, `locci-ocr`) would let the model behind them change without breaking clients; worth deciding before external clients depend on the names.

## Sources

- [Local tool-calling benchmark for sub-2B models (Qwen3, LFM2.5)](https://github.com/MikeVeerman/tool-calling-benchmark)
- [Gemma 4 vs Qwen 3.5, 3.6 and 3.8: every size compared](https://www.betterclaw.io/blog/gemma-4-vs-qwen-3-5)
- [Best local LLMs for function calling (Qwen 3.6, Gemma 4)](https://insiderllm.com/guides/function-calling-local-llms/)
- [The best small language models in 2026](https://tinyweights.dev/posts/best-small-language-models-2026/)
- [PaddleOCR-VL: a 0.9B OCR model](https://insiderllm.com/guides/paddleocr-vl-local-document-ocr/), [PaddleOCR-VL-1.5 GGUF](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5-GGUF)
- [Qwen3 Embedding](https://simonwillison.net/2025/Jun/8/qwen3-embedding/), [embedding models ranking 2026](https://local-ai-zone.github.io/guides/best-ai-embedding-models-ultimate-ranking-2026.html)
