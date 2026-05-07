#!/usr/bin/env bash
# Start server, run tests, kill server — all in one process group
set -e
cd "$(dirname "$0")"

export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false

rm -f data/hermes-memory.db

# Start server in background of THIS script's process group
node memory-server.mjs &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 20); do
  if curl -s http://127.0.0.1:3001/health > /dev/null 2>&1; then
    echo "Server ready after ${i}s"
    break
  fi
  sleep 1
done

PASS=0; FAIL=0
check() {
  if [ "$2" = "true" ] || [ "$2" = "ok" ]; then
    PASS=$((PASS+1)); echo "  PASS: $1"
  else
    FAIL=$((FAIL+1)); echo "  FAIL: $1 — $2"
  fi
}

echo "=== Health ==="
R=$(curl -s http://127.0.0.1:3001/health)
echo "$R"
echo "$R" | grep -q '"ok":true' && check "health" "true" || check "health" "FAIL"

echo "=== Store preference ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"I prefer dark mode for VS Code","type":"preference"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store1" "true" || check "store1" "FAIL"

echo "=== Store contradicting preference ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"I prefer light mode for VS Code","type":"preference"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store2" "true" || check "store2" "FAIL"

echo "=== Store profile ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"My name is Tam","type":"profile"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store3" "true" || check "store3" "FAIL"

echo "=== Get memory 1 (entity/attr) ==="
R=$(curl -s http://127.0.0.1:3001/memory/1)
echo "$R"
echo "$R" | grep -q '"entity"' && check "entity field" "true" || check "entity field" "FAIL"
echo "$R" | grep -q '"attribute"' && check "attribute field" "true" || check "attribute field" "FAIL"
echo "$R" | grep -q '"context_prefix"' && check "context_prefix field" "true" || check "context_prefix field" "FAIL"
echo "$R" | grep -q '"importance"' && check "importance field" "true" || check "importance field" "FAIL"
echo "$R" | grep -q 'extraction_method' && check "provenance metadata" "true" || check "provenance metadata" "FAIL"

echo "=== Get memory 3 (profile) ==="
R=$(curl -s http://127.0.0.1:3001/memory/3)
echo "$R"
echo "$R" | grep -qE '"importance":(0\.[5-9]|1)' && check "profile importance high" "true" || check "profile importance" "FAIL"
echo "$R" | grep -q '"entity":"user"' && check "profile entity=user" "true" || check "profile entity" "FAIL"
echo "$R" | grep -q '"attribute":"name"' && check "profile attr=name" "true" || check "profile attr" "FAIL"

echo "=== Supersede ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/supersede -H "Content-Type: application/json" -d '{"old_id":1,"new_id":2,"reason":"preference_change"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "supersede" "true" || check "supersede" "FAIL"

echo "=== Lineage ==="
R=$(curl -s http://127.0.0.1:3001/memory/1/lineage)
echo "$R"
echo "$R" | grep -q '"lineage"' && check "lineage" "true" || check "lineage" "FAIL"

echo "=== Contradiction check ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/contradiction-check -H "Content-Type: application/json" -d '{"entity":"user","attribute":"prefer_light_mode","text":"I prefer dark mode for VS Code"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "contradiction check" "true" || check "contradiction check" "FAIL"

echo "=== Search ==="
R=$(curl -s "http://127.0.0.1:3001/memory/search?q=dark+mode&limit=5")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "search" "true" || check "search" "FAIL"

echo "=== Sync ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/sync -H "Content-Type: application/json" -d '{"user_message":"I need to fix the critical auth bug","assistant_response":"Looking at the auth module","session_id":"test-1"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "sync" "true" || check "sync" "FAIL"

echo "=== Stats ==="
R=$(curl -s http://127.0.0.1:3001/memory/stats)
echo "$R"
echo "$R" | grep -q '"active"' && check "stats" "true" || check "stats" "FAIL"

echo "=== Re-embed ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/reembed -H "Content-Type: application/json" -d '{}')
echo "$R"
echo "$R" | grep -qE '"ok":true|"error":"Embedding engine not ready"' && check "reembed (disabled ok)" "true" || check "reembed" "FAIL"

echo "=== Maintenance run ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/maintenance/run -H "Content-Type: application/json")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "maintenance" "true" || check "maintenance" "FAIL"

echo "=== Type filter ==="
R=$(curl -s "http://127.0.0.1:3001/memory/type/profile")
echo "$R"
echo "$R" | grep -q '"results"' && check "type filter" "true" || check "type filter" "FAIL"

echo "=== Session filter ==="
R=$(curl -s "http://127.0.0.1:3001/memory/session/test-1")
echo "$R"
echo "$R" | grep -q '"results"' && check "session filter" "true" || check "session filter" "FAIL"

echo "=== Bi-temporal valid_from at store ==="
R=$(curl -s http://127.0.0.1:3001/memory/2)
echo "$R"
echo "$R" | grep -q '"valid_from"' && check "valid_from field" "true" || check "valid_from field" "FAIL"
echo "$R" | grep -qE '"valid_from":"202[0-9]' && check "valid_from populated" "true" || check "valid_from populated" "FAIL"

echo "=== Bi-temporal valid_until after supersede ==="
R=$(curl -s http://127.0.0.1:3001/memory/1)
echo "$R"
echo "$R" | grep -qE '"valid_until":"202[0-9]' && check "valid_until after supersede" "true" || check "valid_until after supersede" "FAIL"

echo "=== Lineage includes bi-temporal ==="
R=$(curl -s http://127.0.0.1:3001/memory/1/lineage)
echo "$R"
echo "$R" | grep -q '"valid_from"' && check "lineage valid_from" "true" || check "lineage valid_from" "FAIL"
echo "$R" | grep -q '"valid_until"' && check "lineage valid_until" "true" || check "lineage valid_until" "FAIL"

echo "=== FTS search with active results ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"I use React for frontend development","type":"setup"}')
echo "$R"
R=$(curl -s "http://127.0.0.1:3001/memory/search?q=React+frontend&limit=5")
echo "$R"
echo "$R" | grep -qE '"results":\s*\[.+' && check "fts search returns results" "true" || check "fts search results" "FAIL"

echo "=== Store-batch ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store-batch -H "Content-Type: application/json" -d '{"memories":[{"text":"First batch item","type":"fact"},{"text":"Second batch item","type":"fact"}]}')
echo "$R"
echo "$R" | grep -q '"ids"' && check "store-batch" "true" || check "store-batch" "FAIL"

echo "=== Session filter on search ==="
R=$(curl -s "http://127.0.0.1:3001/memory/search?q=auth&limit=5&session_id=test-1")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "search session filter" "true" || check "search session filter" "FAIL"

echo "=== Delete memory ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"Temporary memory to delete","type":"fact"}')
DEL_ID=$(echo "$R" | grep -oE '"id":[0-9]+' | grep -oE '[0-9]+')
R=$(curl -s -X DELETE "http://127.0.0.1:3001/memory/$DEL_ID")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "delete memory" "true" || check "delete memory" "FAIL"
R=$(curl -s "http://127.0.0.1:3001/memory/$DEL_ID")
echo "$R" | grep -q '"not found"' && check "deleted memory is 404" "true" || check "deleted memory 404" "FAIL"

echo "=== Ready endpoint ==="
R=$(curl -s http://127.0.0.1:3001/ready)
echo "$R"
echo "$R" | grep -q '"ok":true' && check "ready check" "true" || check "ready check" "FAIL"

echo "=== Source memory IDs in supersede ==="
R=$(curl -s http://127.0.0.1:3001/memory/2)
echo "$R"
echo "$R" | grep -q 'source_memory_ids' && check "source_memory_ids field" "true" || check "source_memory_ids field" "FAIL"

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"

kill $SERVER_PID 2>/dev/null || true
exit $FAIL
