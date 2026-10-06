#!/usr/bin/env sh
# Document OCR through the edge (model `baidu-ocr-vision`, PaddleOCR-VL).
#
# Sends the committed fixture images as base64 data URLs with PaddleOCR-VL task
# prompts and checks that known strings come back. Needs the vision pool:
#   just models --vision && docker compose --profile vision up -d --wait
#
# Usage: scripts/ocr-api.sh [base_url]    (TOKEN env overrides minting)
set -u

BASE="${1:-http://localhost:8080}"
TOKEN="${TOKEN:-$("$(dirname "$0")/locci-auth-token.sh")}"
FIX="$(cd "$(dirname "$0")" && pwd)/fixtures"
FAIL=0

ocr() { # image prompt -> recognised text on stdout
  python3 - "$FIX/$1" "$2" <<'PY' | curl -s "$BASE/v1/chat/completions" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @- \
    | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["choices"][0]["message"]["content"] if "choices" in r else "ERROR " + json.dumps(r))'
import base64, json, sys
img = base64.b64encode(open(sys.argv[1], "rb").read()).decode()
print(json.dumps({
    "model": "baidu-ocr-vision",
    "temperature": 0,
    "max_tokens": 512,
    "messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + img}},
        {"type": "text", "text": sys.argv[2]},
    ]}],
}))
PY
}

expect() { # name text needle...
  name=$1 text=$2; shift 2
  missing=""
  for needle in "$@"; do
    printf '%s' "$text" | tr -d ' ' | grep -qiF "$(printf '%s' "$needle" | tr -d ' ')" || missing="$missing [$needle]"
  done
  if [ -z "$missing" ]; then echo "PASS $name"; else echo "FAIL $name: missing$missing"; FAIL=1; fi
  printf '%s\n' "$text" | sed 's/^/    | /' | head -12
}

START=$(date +%s)
T1=$(ocr ocr-text.png "OCR:")
expect "OCR: text document" "$T1" "LOCCI INVOICE 2026-0142" "Acme Ltd" "Nairobi" "KES 12,450.00"

T2=$(ocr ocr-table.png "Table Recognition:")
expect "Table Recognition:" "$T2" "Qwen3-1.7B" "PaddleOCR-VL" "coder" "vision" "1.3 GB"

echo "took $(( $(date +%s) - START ))s"
exit $FAIL
