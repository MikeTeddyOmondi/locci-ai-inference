# Small language models (SLMs)

Which models the gateway serves today, how they behave, and candidates worth evaluating. "Measured" means checked on this stack; everything else is reported by the linked sources and should be verified with `just tools-api` / `just tools-sdk` / `just sdk-e2e` before switching.

How to run any of these is in [LLAMA_SERVER.md](LLAMA_SERVER.md).

## What we serve now

The gateway's model ids name the target models; locally each pool runs a smaller stand-in so the stack fits in the Colima VM (4 vCPU, 7.7 GiB, CPU only).

| Gateway id | Pool | Running locally | Status |
| --- | --- | --- | --- |
| `qwen-coder-7b` | coder | Qwen2.5-Coder-1.5B-Instruct Q4_K_M (1.0 GB) | Chat and code: works, ~56 tokens/s. **Tool calling: fails** (measured; see below). |
| `qwen-coder-14b` | coder | same file as above | Alias of the same stand-in. |
| `baidu-ocr-vision` | vision | LLaVA v1.5 7B Q4_K + mmproj | Off by default, **untested**. A 2023 general vision model, not an OCR model. |
| `embedding-nomic` | embed | nomic-embed-text v1.5 Q4_K_M (80 MB) | Works, 768 dims (measured). Inputs over 512 tokens fail until `-ub` is raised. |

**Measured tool-calling result for Qwen2.5-Coder-1.5B:** given a `get_weather` tool, it writes the call as a markdown JSON block (or `{{"name": ...}}`, copying literal braces from its template) instead of `<tool_call>` tags, so llama-server parses no call. Even `tool_choice: "required"` does not save it on this llama.cpp build. The serving stack is fine; the model is not trained well enough on the format at this size. Qwen2.5 is also two generations old now.

**Control test (measured):** the same llama.cpp build with a same-size *general* model, Qwen2.5-1.5B-Instruct Q4_K_M, put in the coder pool via `CODER_MODEL`, passed every check of `just tools-api` and `just tools-sdk` three runs in a row: forced calls parsed into `tool_calls`, results round-tripped into a text answer, and streamed calls reassembled from deltas. With `tool_choice: "auto"` it was inconsistent about calling (sometimes asked a question instead) and did not invent a call for an unrelated prompt. So the coder fine-tune is the problem, and even a 1.5B general model handles the protocol.

## Candidates

Sizes are approximate Q4_K_M files. "Fits" is for this 7.7 GiB VM with the other pools running; a GPU box changes the picture.

### Chat, code and tool calling (`coder` pool)

| Model | Size | Why consider it | Fits locally |
| --- | --- | --- | --- |
| **Qwen3-1.7B** | ~1.1 GB | Top sub-2B score (0.960) on a published local tool-calling benchmark, the only one there to get every hard prompt right. Hermes `<tool_call>` format, which llama.cpp parses. Thinking model: run with `--reasoning off`. | Yes, two nodes |
| Qwen2.5-1.5B-Instruct | ~1.1 GB | Measured here: passes the tool-calling protocol checks. Older generation and weak at deciding *when* to call; a safe baseline, not a target. | Yes, two nodes |
| **LFM2.5-1.2B** (Liquid AI) | ~0.8 GB | Second on the same benchmark (0.920); built for edge and CPU. | Yes, two nodes |
| **Qwen 3.5 2B / 4B** | ~2 / ~3 GB | Newest Qwen below 27B (Feb to Mar 2026), 262K context, Apache 2.0. 4B is the laptop-class step up. | 2B yes; 4B one node |
| **Gemma 4 E2B / E4B** | ~1.5 / ~3 GB | Native function calling, 128K context, multimodal (image, audio). Thinking on by default: tool calls land in `reasoning_content` unless disabled. | E2B yes; E4B one node |
| **Qwen 3.5 9B** | ~6 GB | Recommended 8 GB-tier pick for tool calling in a mid-2026 guide. | No (GPU box) |
| **Qwen2.5-Coder-7B** | ~4.7 GB | What `qwen-coder-7b` names. Strong code completion, older tool-calling. | One node only |
| Phi-4-mini (3.8B), SmolLM3-3B | ~2.5 / ~2 GB | Solid 3 to 4B generalists; worth a look if Qwen or Gemma disappoint. | One to two nodes |

Qwen 3.6 and 3.8 start at 27B and Gemma 4's next size is 12B: GPU territory, not SLMs for this box.

**Suggested next step:** put Qwen3-1.7B (or Qwen 3.5 2B) in the coder pool, run with `--reasoning off`, and rerun `just tools-api` / `just tools-sdk`. Both fit two nodes in the current VM.

### Document OCR and vision (`vision` pool)

| Model | Size | Why consider it |
| --- | --- | --- |
| **PaddleOCR-VL 1.6** (Baidu) | ~0.9 GB | The model the `baidu-ocr-vision` id describes. 0.9B document OCR: text in 109 languages, tables, formulas to LaTeX, charts, seals. Reports 96.33% on OmniDocBench v1.6 (v1.5 scored 94.5%, above Qwen2.5-VL-72B at 87.0%). In llama.cpp since b8110 (Feb 2026); our b11434 is newer. |
| Gemma 4 E2B / E4B | ~1.5 / ~3 GB | General image understanding plus chat, if the pool should do more than OCR. |

PaddleOCR-VL replacing LLaVA 1.5 is the clearest upgrade in this list: smaller, purpose-built, and matching the id we already expose.

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

The ids are stand-ins today (`qwen-coder-7b` runs a 1.5B model). When the real models are chosen, ids that name the capability (`locci-coder`, `locci-ocr`) would let the model behind them change without breaking clients.

## Sources

- [Local tool-calling benchmark for sub-2B models (Qwen3, LFM2.5)](https://github.com/MikeVeerman/tool-calling-benchmark)
- [Gemma 4 vs Qwen 3.5, 3.6 and 3.8: every size compared](https://www.betterclaw.io/blog/gemma-4-vs-qwen-3-5)
- [Best local LLMs for function calling (Qwen 3.6, Gemma 4)](https://insiderllm.com/guides/function-calling-local-llms/)
- [The best small language models in 2026](https://tinyweights.dev/posts/best-small-language-models-2026/)
- [PaddleOCR-VL: a 0.9B OCR model](https://insiderllm.com/guides/paddleocr-vl-local-document-ocr/), [PaddleOCR-VL-1.5 GGUF](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5-GGUF)
- [Qwen3 Embedding](https://simonwillison.net/2025/Jun/8/qwen3-embedding/), [embedding models ranking 2026](https://local-ai-zone.github.io/guides/best-ai-embedding-models-ultimate-ranking-2026.html)
