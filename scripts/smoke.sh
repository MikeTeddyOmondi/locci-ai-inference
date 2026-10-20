#!/usr/bin/env sh
# End-to-end checks against the running stack through KrakenD.
# Usage: scripts/smoke.sh [base_url]
set -u

BASE="${1:-http://localhost:8080}"
TOKEN="${TOKEN:-$("$(dirname "$0")/locci-auth-token.sh")}"
FAIL=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS $1 ($3)"; else echo "FAIL $1: want $2, got $3"; FAIL=1; fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

check "health" 200 "$(code "$BASE/health")"
check "no token -> 401" 401 "$(code -X POST "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' -d '{"model":"gemma-4-e2b","messages":[]}')"
check "unknown model -> 400" 400 "$(code -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-9","messages":[]}')"
check "models list" 200 "$(code -H "Authorization: Bearer $TOKEN" "$BASE/v1/models")"

echo "--- streaming chat (watch tokens arrive) ---"
curl -sN "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"gemma-4-e2b","stream":true,"max_tokens":64,
       "messages":[{"role":"user","content":"Write a Go function to reverse a string."}]}' \
  | while IFS= read -r line; do
      [ -n "$line" ] && printf '%s %s\n' "$(date +%T)" "$(printf '%s' "$line" | cut -c1-110)"
    done

echo "--- meter lines from the router ---"
sleep 1
docker compose logs --no-log-prefix locci-ai-gateway 2>/dev/null | grep '^.*meter tenant=' | tail -3

exit $FAIL
