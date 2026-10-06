# Small language models (SLMs)

Which models the gateway serves today, how they behave, and candidates worth evaluating. "Measured" means checked on this stack; everything else is reported by the linked sources and should be verified with `just tools-api` / `just tools-sdk` / `just sdk-e2e` before switching.

How to run any of these is in [LLAMA_SERVER.md](LLAMA_SERVER.md).

## What we serve now

The gateway's model ids are placeholders that predate the model choice: `qwen-coder-7b` and `qwen-coder-14b` both run Qwen3-1.7B locally. Everything runs in the Colima VM (4 vCPU, 7.7 GiB, CPU only), on llama.cpp `server-b11434` (pinned).

| Gateway id | Pool | Running | Status (measured on this stack) |
| --- | --- | --- | --- |
| `qwen-coder-7b`, `qwen-coder-14b` | coder | **Qwen3-1.7B** Q4_K_M (1.28 GB, ggml-org), `--reasoning off` | Chat and code ~50 tokens/s generation, ~190 tokens/s prompt. **Tool calling passes** every `just tools-api` / `just tools-sdk` check, 3 runs in a row. ~2.1 GiB resident per node. |
| `baidu-ocr-vision` | vision | **PaddleOCR-VL 1.6** (0.94 GB) + mmproj (0.88 GB), `--temp 0` | `just ocr-api` passes: exact text from an invoice image, and a 3x3 table. **Slow on CPU**: 110 to 180 s per image (see below). ~1.5 GiB resident. |
| `embedding-nomic` | embed | nomic-embed-text v1.5 Q4_K_M (80 MB) | 768 dims. Inputs over 512 tokens fail until `-ub` is raised. |

### Qwen3-1.7B (coder pool), measured

- **Tool calling:** forced calls (`tool_choice: "required"`) are parsed into `tool_calls`, tool results round-trip into a text answer, and streamed calls reassemble from deltas, through curl and through the AI SDK. With `"auto"` it called the tool when the question needed it (3 of 3) and answered in plain text for an unrelated prompt with tools present (3 of 3).
- **Thinking:** off via `--reasoning off`; no `<think>` text or `reasoning_content` in responses. Set `CODER_REASONING=on` in `.env` to enable it (answers get slower and longer; tool calls may then appear in `reasoning_content`).
- **Memory:** ~2.1 GiB per node with `-c 8192 --parallel 4`, against ~1.25 GiB for the previous model; Qwen3 has a larger KV cache per token.

### PaddleOCR-VL 1.6 (vision pool), measured

- **Prompts:** send the image plus a task prompt: `OCR:`, `Table Recognition:`, `Formula Recognition:`, `Chart Recognition:` or `Seal Recognition:`. (`Spotting:` also exists but needs the mmproj's `clip.vision.image_max_pixels` raised; not set up here.)
- **Output:** `OCR:` returns plain text with line breaks. **`Table Recognition:` returns OTSL tokens, not HTML or Markdown**: `<fcel>` starts a cell, `<nl>` ends a row, e.g. `<fcel>Model<fcel>Pool<nl><fcel>Qwen3-1.7B<fcel>coder<nl>`. Clients convert it (empty cells and spans use further OTSL tokens such as `<ecel>`, `<lcel>`, `<ucel>`).
- **Speed:** generation is fine (13 to 14 tokens/s), but encoding the image is CPU-bound at ~2.8 tokens/s of prompt: 175 s for a 900x420 invoice (493 prompt tokens) and 109 s for a small table (313). Expect minutes per page on this VM. A GPU, more cores, or a quantized mmproj (only F16 is published officially) are the levers. Callers need generous timeouts; the gateway's are 600 s.

### Previous coder model: Qwen2.5-Coder-1.5B (retired)

It could not call tools: given a `get_weather` tool it wrote the call as a markdown JSON block (or `{{"name": ...}}`, copying literal braces from its own template) instead of `<tool_call>` tags, so llama-server parsed nothing, and `tool_choice: "required"` did not force it on this build. A same-size general model, Qwen2.5-1.5B-Instruct, passed the same checks, which isolated the coder fine-tune as the problem. Details in [LLAMA_SERVER.md](LLAMA_SERVER.md#tool-calling).

## Candidates

Sizes are approximate Q4_K_M files. "Fits" is for this 7.7 GiB VM with the other pools running; a GPU box changes the picture.

### Chat, code and tool calling (`coder` pool)

| Model | Size | Why consider it | Fits locally |
| --- | --- | --- | --- |
| **Qwen3-1.7B** (in use) | 1.28 GB | Top sub-2B score (0.960) on a published local tool-calling benchmark. Hermes `<tool_call>` format, which llama.cpp parses. **Running now; passes our checks.** | Yes, two nodes |
| Qwen2.5-1.5B-Instruct | ~1.1 GB | Measured here: passes the protocol checks but is weak at deciding *when* to call. A baseline, superseded by Qwen3-1.7B. | Yes, two nodes |
| **LFM2.5-1.2B** (Liquid AI) | ~0.8 GB | Second on the same benchmark (0.920); built for edge and CPU. | Yes, two nodes |
| **Qwen 3.5 2B / 4B** | ~2 / ~3 GB | Newest Qwen below 27B (Feb to Mar 2026), 262K context, Apache 2.0. 4B is the laptop-class step up. | 2B yes; 4B one node |
| **Gemma 4 E2B / E4B** | ~1.5 / ~3 GB | Native function calling, 128K context, multimodal (image, audio). Thinking on by default: tool calls land in `reasoning_content` unless disabled. | E2B yes; E4B one node |
| **Qwen 3.5 9B** | ~6 GB | Recommended 8 GB-tier pick for tool calling in a mid-2026 guide. | No (GPU box) |
| **Qwen2.5-Coder-7B** | ~4.7 GB | What `qwen-coder-7b` names. Strong code completion, older tool-calling. | One node only |
| Phi-4-mini (3.8B), SmolLM3-3B | ~2.5 / ~2 GB | Solid 3 to 4B generalists; worth a look if Qwen or Gemma disappoint. | One to two nodes |

Qwen 3.6 and 3.8 start at 27B and Gemma 4's next size is 12B: GPU territory, not SLMs for this box.

**Next to try:** Qwen 3.5 2B (newer, longer context) against Qwen3-1.7B with the same checks. Memory is the constraint: two Qwen3-1.7B nodes already take ~4.2 GiB.

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

The ids are placeholders today (`qwen-coder-7b` runs Qwen3-1.7B). When the real models are chosen, ids that name the capability (`locci-coder`, `locci-ocr`) would let the model behind them change without breaking clients.

## Sources

- [Local tool-calling benchmark for sub-2B models (Qwen3, LFM2.5)](https://github.com/MikeVeerman/tool-calling-benchmark)
- [Gemma 4 vs Qwen 3.5, 3.6 and 3.8: every size compared](https://www.betterclaw.io/blog/gemma-4-vs-qwen-3-5)
- [Best local LLMs for function calling (Qwen 3.6, Gemma 4)](https://insiderllm.com/guides/function-calling-local-llms/)
- [The best small language models in 2026](https://tinyweights.dev/posts/best-small-language-models-2026/)
- [PaddleOCR-VL: a 0.9B OCR model](https://insiderllm.com/guides/paddleocr-vl-local-document-ocr/), [PaddleOCR-VL-1.5 GGUF](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5-GGUF)
- [Qwen3 Embedding](https://simonwillison.net/2025/Jun/8/qwen3-embedding/), [embedding models ranking 2026](https://local-ai-zone.github.io/guides/best-ai-embedding-models-ultimate-ranking-2026.html)
