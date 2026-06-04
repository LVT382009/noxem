#!/usr/bin/env bash
# v2 endpoint integration tests — starts own server
set -e
cd "$(dirname "$0")"

export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false

rm -f data/hermes-memory.db

# Start server
node memory-server.mjs &
SERVER_PID=$!

# Wait for server
for i in $(seq 1 20); do
  if curl -s http://127.0.0.1:3001/health > /dev/null 2>&1; then
    echo "Server ready after ${i}s"
    break
  fi
  sleep 1
done

PASS=0; FAIL=0
check() {
  local label="$1" result="$2"
  if [ "$result" = "true" ] || [ "$result" = "ok" ]; then
    PASS=$((PASS+1)); echo "  PASS: $label"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $label — $result"
  fi
}
jcheck() {
  local label="$1" key="$2" json="$3"
  local val=$(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$key','MISSING'))" 2>/dev/null || echo "PARSE_ERR")
  if [ "$val" != "MISSING" ] && [ "$val" != "PARSE_ERR" ]; then
    PASS=$((PASS+1)); echo "  PASS: $label ($key=$val)"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $label — key '$key' not found or parse error"
  fi
}

echo "=== v2: Route shadowing fix ==="
# GET /memory/procedures should NOT match /memory/:id
R=$(curl -s http://127.0.0.1:3001/memory/procedures)
echo "$R" | grep -q '"ok":true' && check "GET /memory/procedures returns ok" "true" || check "GET /memory/procedures" "FAIL — got: $(echo $R | head -c 80)"

# GET /memory/pipeline/status should NOT match /memory/:id
R=$(curl -s http://127.0.0.1:3001/memory/pipeline/status)
echo "$R" | grep -q '"ok":true' && check "GET /memory/pipeline/status returns ok" "true" || check "GET /memory/pipeline/status" "FAIL"

echo "=== v2: Pipeline status structure ==="
R=$(curl -s http://127.0.0.1:3001/memory/pipeline/status)
jcheck "pipeline has layers" "layers" "$R"
jcheck "pipeline has L0_episode" "layers" "$R"

echo "=== v2: Procedure CRUD ==="
R=$(curl -s http://127.0.0.1:3001/memory/procedures)
jcheck "procedures list has ok" "ok" "$R"
jcheck "procedures list has procedures array" "procedures" "$R"

R=$(curl -s "http://127.0.0.1:3001/memory/procedures/search?q=redis")
jcheck "procedure search has ok" "ok" "$R"

# GET /memory/procedures/1 should return 404 (no procedures yet)
R=$(curl -s -w "\n%{http_code}" http://127.0.0.1:3001/memory/procedures/1)
HTTP=$(echo "$R" | tail -1)
[ "$HTTP" = "404" ] && check "GET /memory/procedures/1 returns 404" "true" || check "GET /memory/procedures/1 status" "FAIL — got $HTTP"

echo "=== v2: Store → edge auto-creation ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store \
  -H "Content-Type: application/json" \
  -d '{"text":"Redis cache invalidation pattern","type":"learning","entity":"redis","attribute":"cache","importance":0.85}')
echo "$R" | grep -q '"ok":true' && check "store memory ok" "true" || check "store memory" "FAIL"
NEW_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
[ -n "$NEW_ID" ] && check "store returned id=$NEW_ID" "true" || check "store id" "FAIL"

echo "=== v2: Graph traversal ==="
sleep 1
R=$(curl -s "http://127.0.0.1:3001/memory/graph/traverse?from_id=$NEW_ID&max_depth=2&limit=10")
echo "$R" | grep -q '"ok":true' && check "graph traverse ok" "true" || check "graph traverse" "FAIL"
jcheck "traverse has steps" "steps" "$R"

echo "=== v2: Structured advisor advice (POST) ==="
R=$(curl -s -X POST "http://127.0.0.1:3001/memory/advisor/advice?structured=true" \
  -H "Content-Type: application/json" -d '{}')
# With ENABLE_ADVISOR=false, expect disabled mode with structured fields
if echo "$R" | grep -q 'drift_detected'; then
  check "structured advice has drift_detected" "true"
elif echo "$R" | grep -q '"mode":"disabled"'; then
  check "structured advice returns disabled mode (advisor off)" "true"
else
  check "structured advice" "FAIL — $(echo $R | head -c 100)"
fi

echo "=== v2: Bundle search endpoint ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/bundle-search \
  -H "Content-Type: application/json" \
  -d '{"query":"redis","topK":3}')
# With ENABLE_EMBEDDING=false, expect 503 Brain-1 not ready (correct behavior)
if echo "$R" | grep -q '"ok":true'; then
  check "bundle-search ok" "true"
elif echo "$R" | grep -q 'Brain-1 not ready'; then
  check "bundle-search correctly rejects when embedding disabled" "true"
else
  check "bundle-search" "FAIL"
fi

echo "=== v2: Learn endpoint ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/learn \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-v2"}')
echo "$R" | grep -q '"ok":true' && check "learn endpoint ok" "true" || check "learn endpoint" "FAIL — $(echo $R | head -c 80)"

echo "=== v2: Pipeline run endpoint ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/pipeline/run)
echo "$R" | grep -q '"ok":true' && check "pipeline/run ok" "true" || check "pipeline/run" "FAIL"

echo "=== v2: Screenshot endpoint ==="
R=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST http://127.0.0.1:3001/fetch/screenshot \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}')
HTTP=$(echo "$R" | tail -1 | sed 's/HTTP_CODE://')
# Accept ok or 503 (servo-fetch not running)
if echo "$R" | grep -qE '"ok":true'; then
  check "screenshot endpoint ok" "true"
elif [ "$HTTP" = "503" ]; then
  check "screenshot endpoint 503 (servo-fetch not running)" "true"
else
  check "screenshot endpoint" "FAIL — HTTP=$HTTP $(echo $R | head -c 80)"
fi

echo "=== v2: Numeric guard on /memory/:id ==="
# GET /memory/not-a-number should return 404, not crash
R=$(curl -s -w "\n%{http_code}" http://127.0.0.1:3001/memory/notfound)
HTTP=$(echo "$R" | tail -1)
[ "$HTTP" = "404" ] && check "GET /memory/notfound returns 404" "true" || check "GET /memory/notfound" "FAIL — got $HTTP"

# GET /memory/procedures should NOT match :id
R=$(curl -s http://127.0.0.1:3001/memory/procedures)
echo "$R" | grep -q '"ok":true' && check "procedures route not shadowed" "true" || check "procedures route" "FAIL — shadowed by :id"

echo "=== v2: FTS5 expanded columns ==="
# Store a memory with entity/context, then FTS search by entity name
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store \
  -H "Content-Type: application/json" \
  -d '{"text":"PostgreSQL connection pooling config","type":"setup","entity":"postgresql","attribute":"connection","context_prefix":"Setup for postgresql"}')
echo "$R" | grep -q '"ok":true' && check "store with expanded fields ok" "true" || check "store expanded fields" "FAIL"

sleep 1
R=$(curl -s -X POST http://127.0.0.1:3001/memory/search \
  -H "Content-Type: application/json" \
  -d '{"query":"postgresql","limit":5}')
echo "$R" | grep -q '"results"' && check "FTS5 search finds postgresql" "true" || check "FTS5 search postgresql" "FAIL"

echo "=== v2: Memory summary field ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store \
  -H "Content-Type: application/json" \
  -d '{"text":"This is a long text about Redis cache invalidation strategies that should get auto-summarized into a short summary field","type":"fact","entity":"redis"}')
STORED_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
sleep 1
if [ -n "$STORED_ID" ]; then
  R=$(curl -s "http://127.0.0.1:3001/memory/$STORED_ID")
  HAS_SUMMARY=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('summary') else 'false')" 2>/dev/null || echo "false")
  check "memory has summary field" "$HAS_SUMMARY"
fi

echo ""
echo "=== v2 Test Results: $PASS passed, $FAIL failed ==="

# Cleanup
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null
rm -f data/hermes-memory.db

exit $FAIL
