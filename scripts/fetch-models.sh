#!/usr/bin/env sh
# Download GGUF models into ./models. Gemma (the default pool) always; others opt-in.
# Usage: scripts/fetch-models.sh [--qwen] [--vision] [--embed] [--qwen-candidates | --qwen3-0.6b
#        --qwen3-4b --qwen3-4b-instruct --qwen3.5-2b --qwen3.5-4b]
# The --qwen* flags fetch alternatives to Qwen3-1.7B for trials; see docs/SLMS.md.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/models"
mkdir -p "$DIR"

fetch() { # url filename
  if [ -s "$DIR/$2" ]; then
    echo "have $2"
    return
  fi
  echo "fetching $2"
  # Large files over HTTP/2 sometimes drop mid-stream; retry everything, resuming.
  curl -fL --retry 5 --retry-all-errors --retry-delay 2 -C - -o "$DIR/$2.part" "$1"
  mv "$DIR/$2.part" "$DIR/$2"
}

HF=https://huggingface.co

# Pool for `gemma-4-e2b`, the default: the model and its vision projector,
# so the pool reads images too.
fetch "$HF/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf" gemma-4-E2B-it-Q4_K_M.gguf
fetch "$HF/unsloth/gemma-4-E2B-it-GGUF/resolve/main/mmproj-F16.gguf" gemma-4-E2B-it-mmproj-F16.gguf

for arg in "$@"; do
  case "$arg" in
    --qwen)
      # Pool for `qwen3-1.7b` (profile qwen3; ggml-org is the llama.cpp project's own repo).
      fetch "$HF/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf" Qwen3-1.7B-Q4_K_M.gguf
      # Pool for `qwen2.5-coder-1.5b` (profile qwen25): code generation only.
      fetch "$HF/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf" \
        qwen2.5-coder-1.5b-instruct-q4_k_m.gguf
      ;;
    --vision)
      # Vision pool: PaddleOCR-VL 1.6, Baidu's document OCR model, plus its projector.
      fetch "$HF/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF.gguf" PaddleOCR-VL-1.6.gguf
      fetch "$HF/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF-mmproj.gguf" PaddleOCR-VL-1.6-mmproj.gguf
      ;;
    --embed)
      fetch "$HF/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf" \
        nomic-embed-text-v1.5.Q4_K_M.gguf
      ;;
    # Qwen candidates for the `qwen3-1.7b` pool (docs/SLMS.md, "Trying a candidate").
    --qwen3-0.6b) fetch "$HF/ggml-org/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf" Qwen3-0.6B-Q8_0.gguf ;;
    --qwen3-4b) fetch "$HF/ggml-org/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf" Qwen3-4B-Q4_K_M.gguf ;;
    --qwen3-4b-instruct)
      fetch "$HF/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" \
        Qwen3-4B-Instruct-2507-Q4_K_M.gguf
      ;;
    --qwen3.5-2b) fetch "$HF/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf" Qwen3.5-2B-Q4_K_M.gguf ;;
    --qwen3.5-4b) fetch "$HF/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf" Qwen3.5-4B-Q4_K_M.gguf ;;
    --gemma4-e2b) ;; # fetched by default now; kept so older commands still work
    --qwen-candidates)
      "$0" --qwen3-0.6b --qwen3-4b --qwen3-4b-instruct --qwen3.5-2b --qwen3.5-4b
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
