#!/usr/bin/env bash
# MCP protocol check with the official MCP Inspector CLI (Streamable HTTP, spec 2025-11-25):
# starts a local server, then lists the tools and calls a read-only tool, a write tool and an
# invalid call, exactly as an MCP client such as Alexa+ would.
#   npm run check:mcp                       # local server on a spare port
#   npm run check:mcp -- https://<url>/mcp  # an already running server (set API_KEY for its key)
set -euo pipefail
cd "$(dirname "$0")/.."

INSPECTOR="@modelcontextprotocol/inspector@2.9.0"
URL="${1:-}"
PID=""
if [ -z "$URL" ]; then
  PORT="${PORT:-3398}"
  URL="http://localhost:$PORT/mcp"
  PORT="$PORT" API_KEY="" ASSISTANT_ENGINE=rules CHECK_EVERY_MIN=0 npx tsx src/server.ts >/dev/null 2>&1 &
  PID=$!
  trap 'kill "$PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do curl -s -m 1 "${URL%/mcp}/health" >/dev/null && break; sleep 0.5; done
fi
AUTH=()
if [ -n "${API_KEY:-}" ]; then AUTH=(--header "Authorization: Bearer $API_KEY"); fi

inspect() { npx -y "$INSPECTOR" --cli "$URL" --transport http ${AUTH[@]+"${AUTH[@]}"} "$@" 2>&1; }
# Print one field of the Inspector's JSON output (it may log a line or two before the JSON).
field() { node -e '
  const s = require("fs").readFileSync(0, "utf8"); const j = JSON.parse(s.slice(s.indexOf("{")));
  const v = eval(process.argv[1]); if (v === undefined || j.isError) process.exit(1); console.log(v);' "$1"; }
# check <label> <expression on the result j> <inspector args...>: stop at the first failure.
check() {
  local label=$1 expr=$2 out val
  shift 2
  out=$(inspect "$@") || true
  if ! val=$(printf '%s' "$out" | field "$expr" 2>/dev/null); then echo "✗ $label: $out"; exit 1; fi
  echo "✔ $label: $val"
}

echo "MCP Inspector CLI ($INSPECTOR) → $URL"
check "tools/list" 'j.tools.map((t) => t.name).join(", ")' --method tools/list
check "get_status (read-only)" 'j.content[0].text' --method tools/call --tool-name get_status --tool-arg pet=Mochi
check "log_care (write)" 'j.structuredContent.status + " · " + j.content[0].text' \
  --method tools/call --tool-name log_care --tool-arg pet=Biscuit --tool-arg activity=walk --tool-arg by=Inspector
OUT=$(inspect --method tools/call --tool-name log_care --tool-arg pet=Biscuit --tool-arg activity=dance || true)
if echo "$OUT" | grep -q "isError"; then
  echo "✔ invalid argument (activity=dance) → tool error, not a protocol failure"
else
  echo "✗ invalid argument was not reported as a tool error: $OUT"; exit 1
fi
echo "All MCP Inspector checks passed."
