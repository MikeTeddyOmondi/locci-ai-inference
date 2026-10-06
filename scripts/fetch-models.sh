#!/usr/bin/env sh
# Download GGUF models into ./models. Coder model always; others opt-in.
# Usage: scripts/fetch-models.sh [--vision] [--embed]
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

# Pool for `qwen3-1.7b` (ggml-org is the llama.cpp project's own repo).
fetch "$HF/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf" Qwen3-1.7B-Q4_K_M.gguf
# Pool for `qwen2.5-coder-1.5b`: code generation only.
fetch "$HF/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf" \
  qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

for arg in "$@"; do
  case "$arg" in
    --vision)
      # Vision pool: PaddleOCR-VL 1.6, Baidu's document OCR model, plus its projector.
      fetch "$HF/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF.gguf" PaddleOCR-VL-1.6.gguf
      fetch "$HF/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF-mmproj.gguf" PaddleOCR-VL-1.6-mmproj.gguf
      ;;
    --embed)
      fetch "$HF/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf" \
        nomic-embed-text-v1.5.Q4_K_M.gguf
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
