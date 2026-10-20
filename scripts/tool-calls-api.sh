#!/usr/bin/env sh
# Tool calling through the edge with plain HTTP (curl), OpenAI-style.
#
# Checks the protocol, not the model's judgement: the local stand-in is a 1.5B
# model, so the forced checks use tool_choice "required" (grammar-constrained,
# always a well-formed call) and "auto" is reported but never fails the run.
#
# Usage: scripts/tool-calls-api.sh [base_url]    (TOKEN env overrides minting)
set -u

BASE="${1:-http://localhost:8080}"
TOKEN="${TOKEN:-$("$(dirname "$0")/locci-auth-token.sh")}"
MODEL="${MODEL:-gemma-4-e2b}"
FAIL=0

pass() { echo "PASS $1"; }
# Python assertion failures arrive as tracebacks; keep only the last line.
fail() { echo "FAIL ${1%%:*}: $(printf '%s' "$1" | tail -1)"; FAIL=1; }

post() { # body -> response on stdout
  curl -s "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"
}

TOOLS='[{"type":"function","function":{
  "name":"get_weather",
  "description":"Get the current weather for a city",
  "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]'
ASK='[{"role":"user","content":"What is the weather in Nairobi right now?"}]'

# 1. Forced call, non-streamed: a tool_calls entry with JSON arguments.
R1=$(post "{\"model\":\"$MODEL\",\"max_tokens\":128,\"temperature\":0,\"tools\":$TOOLS,\"tool_choice\":\"required\",\"messages\":$ASK}")
CALL=$(printf '%s' "$R1" | python3 -c '
import json, sys
r = json.load(sys.stdin)
m = r["choices"][0]["message"]
calls = m.get("tool_calls") or []
assert calls, "no tool_calls in: " + json.dumps(m)[:300]
c = calls[0]
args = json.loads(c["function"]["arguments"])
assert c["type"] == "function" and c["function"]["name"] == "get_weather", c
assert isinstance(args.get("city"), str) and args["city"], args
print(json.dumps({"id": c["id"], "args": c["function"]["arguments"], "city": args["city"],
                  "finish": r["choices"][0]["finish_reason"], "model": r["model"]}))
' 2>&1) && pass "required tool call: $(printf '%s' "$CALL" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("get_weather(city=%r) finish=%s model=%s" % (d["city"], d["finish"], d["model"]))')" \
  || { fail "required tool call: $CALL"; CALL=""; }

# 2. Round trip: send the call and a tool result back, expect a text answer.
if [ -n "$CALL" ]; then
  FOLLOW=$(printf '%s' "$CALL" | python3 -c '
import json, sys
c = json.load(sys.stdin)
msgs = [
  {"role": "user", "content": "What is the weather in Nairobi right now?"},
  {"role": "assistant", "content": None, "tool_calls": [
    {"id": c["id"], "type": "function", "function": {"name": "get_weather", "arguments": c["args"]}}]},
  {"role": "tool", "tool_call_id": c["id"], "content": json.dumps({"city": c["city"], "temp_c": 24, "sky": "sunny"})},
]
print(json.dumps(msgs))')
  R2=$(post "{\"model\":\"$MODEL\",\"max_tokens\":64,\"temperature\":0,\"tools\":$TOOLS,\"messages\":$FOLLOW}")
  OUT=$(printf '%s' "$R2" | python3 -c '
import json, sys
m = json.load(sys.stdin)["choices"][0]["message"]
assert (m.get("content") or "").strip(), "no text after tool result: " + json.dumps(m)[:300]
print(m["content"].strip().replace("\n", " ")[:100])' 2>&1) \
    && pass "tool result round trip: \"$OUT\"" || fail "tool result round trip: $OUT"
fi

# 3. Forced call, streamed: arguments arrive as deltas and reassemble to JSON.
OUT=$(curl -sN "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"max_tokens\":128,\"temperature\":0,\"tools\":$TOOLS,\"tool_choice\":\"required\",\"messages\":$ASK}" \
  | python3 -c '
import json, sys
name, args, deltas, usage = "", "", 0, None
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("data:") or line.endswith("[DONE]"):
        continue
    chunk = json.loads(line[5:])
    usage = chunk.get("usage") or usage
    for ch in chunk["choices"]:
        for tc in ch["delta"].get("tool_calls") or []:
            deltas += 1
            name += tc.get("function", {}).get("name") or ""
            args += tc.get("function", {}).get("arguments") or ""
assert name == "get_weather", "streamed name: %r" % name
city = json.loads(args)["city"]
assert usage, "no usage chunk"
print("%d deltas -> get_weather(city=%r), usage total=%s" % (deltas, city, usage["total_tokens"]))' 2>&1) \
  && pass "streamed tool call: $OUT" || fail "streamed tool call: $OUT"

# 4. tool_choice "auto": informational only; a 1.5B model may or may not call.
R4=$(post "{\"model\":\"$MODEL\",\"max_tokens\":128,\"temperature\":0,\"tools\":$TOOLS,\"tool_choice\":\"auto\",\"messages\":$ASK}")
echo "INFO auto tool choice: $(printf '%s' "$R4" | python3 -c '
import json, sys
m = json.load(sys.stdin)["choices"][0]["message"]
print("called " + m["tool_calls"][0]["function"]["name"] if m.get("tool_calls") else "answered in text: %r" % (m.get("content") or "")[:80])' 2>&1)"

exit $FAIL
