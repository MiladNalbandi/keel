#!/usr/bin/env bash
# Smoke checks. Runs locally and after a deploy: BASE_URL and API_URL decide where.
set -euo pipefail
API="${API_URL:-http://localhost:8080}"
APP="${BASE_URL:-http://localhost:5173}"

check() { printf '%-40s' "$1"; shift; if "$@" >/dev/null 2>&1; then echo ok; else echo FAIL; exit 1; fi; }

check "api health is UP" bash -c "curl -fsS $API/actuator/health | grep -q '\"status\":\"UP\"'"
check "app shell loads" bash -c "curl -fsS $APP | grep -qi '<div id=\"root\"'"
# Add one critical write and read back, for example:
# check "create and read a bookmark" bash -c "id=\$(curl -fsS -XPOST $API/bookmarks -H 'content-type: application/json' -d '{\"url\":\"https://x.dev\"}' | jq -r .id) && curl -fsS $API/bookmarks/\$id | jq -e .url"
echo "smoke ok"
