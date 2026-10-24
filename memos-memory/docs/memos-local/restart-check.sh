#!/bin/bash
# restart-check.sh - SLS-61 deliverable 3: add a memory, restart the API, search for it.
set -euo pipefail
R=/Users/claude/work/memos-runtime
API=http://127.0.0.1:${MEMOS_API_PORT:-8001}
U=sls61-restart-check; CUBE=sls61-restart-check-cube
MARK="restart-check marker $(date -u +%Y%m%dT%H%M%SZ): the paperclip memos smoke test likes teal kayaks"
"$R/bin/memosctl" start
echo "== add"; jq -n --arg u "$U" --arg c "$CUBE" --arg m "$MARK" \
  '{user_id:$u, writable_cube_ids:[$c], async_mode:"sync", mode:"fine", messages:[{role:"user",content:$m}]}' \
  | curl -fsS -X POST "$API/product/add" -H 'Content-Type: application/json' -d @- | jq -c '{code,message,n:(.data|length)}'
echo "== full restart (API, Qdrant, Neo4j)"; "$R/bin/memosctl" restart
echo "== search after restart"
# Query the marker's own words: a vague question scores ~0.33, below MemOS's 0.45 relevance cutoff.
jq -n --arg u "$U" --arg c "$CUBE" '{user_id:$u, readable_cube_ids:[$c], query:"paperclip memos smoke test teal kayaks", top_k:5}' \
  | curl -fsS -X POST "$API/product/search" -H 'Content-Type: application/json' -d @- > "$R/run/restart-check-search.json"
if grep -qi 'teal kayak' "$R/run/restart-check-search.json"; then echo "PASS: memory survived the restart"; else echo "FAIL: marker not found"; jq -c . "$R/run/restart-check-search.json" | cut -c1-600; exit 1; fi
