#!/usr/bin/env python3
"""Print what a GGUF needs to run here, read from its own metadata.

Reads the header only (no tensors), so it is instant even on multi-GB files.
For each file: architecture, size on disk, layers, attention layout, the KV
cache cost per token, and what the chat template supports (tool calls,
thinking). The KV figure assumes llama-server's default f16 cache.

Usage: scripts/gguf-info.py models/*.gguf
       scripts/gguf-info.py --json models/Qwen3-1.7B-Q4_K_M.gguf
"""

import json
import os
import struct
import sys

# GGUF value types
U8, I8, U16, I16, U32, I32, F32, BOOL, STR, ARR, U64, I64, F64 = range(13)
SCALAR = {U8: "<B", I8: "<b", U16: "<H", I16: "<h", U32: "<I", I32: "<i", F32: "<f",
          BOOL: "<?", U64: "<Q", I64: "<q", F64: "<d"}


def read_str(f):
    (n,) = struct.unpack("<Q", f.read(8))
    return f.read(n).decode("utf-8", "replace")


def read_value(f, t, keep_arrays):
    if t in SCALAR:
        fmt = SCALAR[t]
        return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]
    if t == STR:
        return read_str(f)
    if t == ARR:
        (et,) = struct.unpack("<I", f.read(4))
        (n,) = struct.unpack("<Q", f.read(8))
        if et in SCALAR and not keep_arrays:
            f.seek(n * struct.calcsize(SCALAR[et]), 1)  # skip big numeric arrays
            return f"<array of {n}>"
        items = [read_value(f, et, keep_arrays) for _ in range(n)]
        return items if keep_arrays or len(items) <= 64 else f"<array of {n}>"
    raise ValueError(f"unknown GGUF type {t}")


def metadata(path):
    with open(path, "rb") as f:
        if f.read(4) != b"GGUF":
            raise ValueError("not a GGUF file")
        (version,) = struct.unpack("<I", f.read(4))
        _tensors, kv_count = struct.unpack("<QQ", f.read(16))
        meta = {}
        for _ in range(kv_count):
            key = read_str(f)
            (t,) = struct.unpack("<I", f.read(4))
            # Per-layer head counts are small arrays worth keeping; token lists are not.
            keep = key.endswith(("head_count_kv", "head_count", "full_attention_interval"))
            meta[key] = read_value(f, t, keep)
        meta["_version"] = version
    return meta


def summarize(path):
    m = metadata(path)
    arch = m.get("general.architecture", "?")
    g = lambda k, d=None: m.get(f"{arch}.{k}", d)

    layers = g("block_count", 0)
    heads = g("attention.head_count", 0)
    kv_heads = g("attention.head_count_kv", heads)
    emb = g("embedding_length", 0)
    k_len = g("attention.key_length") or (emb // heads if isinstance(heads, int) and heads else 0)
    v_len = g("attention.value_length") or k_len

    # Hybrid models (linear-attention layers mixed with full attention) only keep
    # a KV cache for the attention layers: per-layer head_count_kv of 0 marks the
    # others, or a full_attention_interval says every Nth layer attends.
    if isinstance(kv_heads, list):
        attn = [h for h in kv_heads if h]
        attn_layers, kv_per_layer = len(attn), (max(attn) if attn else 0)
    else:
        interval = g("full_attention_interval")
        attn_layers = layers // interval if isinstance(interval, int) and interval > 1 else layers
        kv_per_layer = kv_heads

    kv_bytes_per_token = attn_layers * kv_per_layer * (k_len + v_len) * 2  # f16 K + V
    template = m.get("tokenizer.chat_template", "") or ""

    return {
        "file": os.path.basename(path),
        "size_gib": round(os.path.getsize(path) / 2**30, 2),
        "name": m.get("general.name", ""),
        "architecture": arch,
        "params": m.get("general.size_label", ""),
        "layers": layers,
        "attention_layers": attn_layers,
        "kv_heads": kv_per_layer,
        "head_dim": k_len,
        "train_context": g("context_length"),
        "kv_kib_per_token": round(kv_bytes_per_token / 1024, 1),
        "kv_gib_at_16k": round(kv_bytes_per_token * 16384 / 2**30, 2),
        "kv_gib_at_8k": round(kv_bytes_per_token * 8192 / 2**30, 2),
        "template_tool_calls": "<tool_call>" in template or "tool_call" in template,
        "template_tools": "tools" in template,
        "template_thinking": "<think>" in template or "enable_thinking" in template,
    }


def main(argv):
    as_json = "--json" in argv
    paths = [a for a in argv if not a.startswith("--")]
    if not paths:
        print(__doc__)
        return 2
    rows = []
    for p in paths:
        try:
            rows.append(summarize(p))
        except Exception as e:  # keep going past a bad file
            rows.append({"file": os.path.basename(p), "error": str(e)})
    if as_json:
        print(json.dumps(rows, indent=2))
        return 0
    cols = ["file", "size_gib", "architecture", "params", "layers", "attention_layers", "kv_heads",
            "head_dim", "train_context", "kv_kib_per_token", "kv_gib_at_16k", "template_tool_calls",
            "template_thinking"]
    for r in rows:
        if "error" in r:
            print(f"{r['file']}: {r['error']}")
            continue
        print(" | ".join(f"{c}={r.get(c)}" for c in cols))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
