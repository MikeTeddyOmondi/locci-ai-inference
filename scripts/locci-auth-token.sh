#!/usr/bin/env sh
# Mint a 1h user access token from a local locci-auth (`wrangler dev`).
#
# Uses locci-auth's service-token route (/internal/push-deploy-token), which
# signs an ordinary user token with the issuer's own key. The tenant claim is
# `properties.id`, i.e. the user id.
#
# Usage: scripts/locci-auth-token.sh [user_id]
#   LOCCI_AUTH_DIR      path to the locci-auth checkout (default ../locci-auth)
#   LOCCI_AUTH_URL      issuer URL (default http://localhost:8787)
#   LOCCI_SERVICE_TOKEN service secret (default: SERVICE_TOKEN from .dev.vars)
set -eu

AUTH_DIR="${LOCCI_AUTH_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/locci-auth}"
ISSUER="${LOCCI_AUTH_URL:-http://localhost:8787}"

SECRET="${LOCCI_SERVICE_TOKEN:-$(sed -n 's/^SERVICE_TOKEN=//p' "$AUTH_DIR/.dev.vars" | tr -d '"' | head -1)}"
[ -n "$SECRET" ] || { echo "no SERVICE_TOKEN; set LOCCI_SERVICE_TOKEN" >&2; exit 1; }

USER_ID="${1:-}"
if [ -z "$USER_ID" ]; then
  USER_ID=$(cd "$AUTH_DIR" && npx wrangler d1 execute AUTH_DB --local --json \
    --command "select id from user order by rowid limit 1" 2>/dev/null \
    | sed -n 's/.*"id": *"\([^"]*\)".*/\1/p' | head -1)
fi
[ -n "$USER_ID" ] || { echo "no user found; sign in to locci-auth once" >&2; exit 1; }

curl -fsS -X POST "$ISSUER/internal/push-deploy-token" \
  -H "x-locci-service-token: $SECRET" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$USER_ID\",\"clientID\":\"locci-ai-inference\"}" \
  | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p'
