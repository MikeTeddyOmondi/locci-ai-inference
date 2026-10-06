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
  curl -fL --retry 3 -C - -o "$DIR/$2.part" "$1"
  mv "$DIR/$2.part" "$DIR/$2"
}

HF=https://huggingface.co

fetch "$HF/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf" \
  qwen2.5-coder-1.5b-instruct-q4_k_m.gguf

for arg in "$@"; do
  case "$arg" in
    --vision)
      fetch "$HF/mys/ggml_llava-v1.5-7b/resolve/main/ggml-model-q4_k.gguf" llava-v1.5-7b-q4_k.gguf
      fetch "$HF/mys/ggml_llava-v1.5-7b/resolve/main/mmproj-model-f16.gguf" llava-v1.5-7b-mmproj-f16.gguf
      ;;
    --embed)
      fetch "$HF/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf" \
        nomic-embed-text-v1.5.Q4_K_M.gguf
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
