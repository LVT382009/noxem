#!/usr/bin/env bash
# Start server, run tests, kill server — all in one process group
set -e
cd "$(dirname "$0")"

export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false

# Kill any leftover server on port 3001
fuser -k 3001/tcp 2>/dev/null || true
sleep 1

rm -f data/hermes-memory.db data/hermes-memory.db-wal data/hermes-memory.db-shm

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
PASS=$((PASS+1)); echo " PASS: $1"
else
FAIL=$((FAIL+1)); echo " FAIL: $1 — $2"
fi
}

# Helper: extract numeric ID from store response JSON
extract_id() {
echo "$1" | grep -oE '"id":[0-9]+' | grep -oE '[0-9]+' | head -1
}

echo "=== Health ==="
R=$(curl -s http://127.0.0.1:3001/health)
echo "$R"
echo "$R" | grep -q '"ok":true' && check "health" "true" || check "health" "FAIL"

echo "=== Store preference ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"I prefer dark mode for VS Code","type":"preference"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store1" "true" || check "store1" "FAIL"
ID1=$(extract_id "$R")
echo "  ID1=$ID1"

echo "=== Store contradicting preference ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"I prefer light mode for VS Code","type":"preference"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store2" "true" || check "store2" "FAIL"
ID2=$(extract_id "$R")
echo "  ID2=$ID2"

echo "=== Store profile ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"My name is Tam","type":"profile"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store3" "true" || check "store3" "FAIL"
ID3=$(extract_id "$R")
echo "  ID3=$ID3"

echo "=== Get memory 1 (entity/attr) ==="
R=$(curl -s "http://127.0.0.1:3001/memory/$ID1")
echo "$R"
echo "$R" | grep -q '"entity"' && check "entity field" "true" || check "entity field" "FAIL"
echo "$R" | grep -q '"attribute"' && check "attribute field" "true" || check "attribute field" "FAIL"
echo "$R" | grep -q '"context_prefix"' && check "context_prefix field" "true" || check "context_prefix field" "FAIL"
echo "$R" | grep -q '"importance"' && check "importance field" "true" || check "importance field" "FAIL"
echo "$R" | grep -q 'extraction_method' && check "provenance metadata" "true" || check "provenance metadata" "FAIL"

echo "=== Get memory 3 (profile) ==="
R=$(curl -s "http://127.0.0.1:3001/memory/$ID3")
echo "$R"
echo "$R" | grep -qE '"importance":(0\.[5-9]|1)' && check "profile importance high" "true" || check "profile importance" "FAIL"
echo "$R" | grep -q '"entity":"user"' && check "profile entity=user" "true" || check "profile entity" "FAIL"
echo "$R" | grep -q '"attribute":"name"' && check "profile attr=name" "true" || check "profile attr" "FAIL"

echo "=== Supersede ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/supersede -H "Content-Type: application/json" -d "{\"old_id\":$ID1,\"new_id\":$ID2,\"reason\":\"preference_change\"}")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "supersede" "true" || check "supersede" "FAIL"

echo "=== Lineage ==="
R=$(curl -s "http://127.0.0.1:3001/memory/$ID1/lineage")
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
R=$(curl -s "http://127.0.0.1:3001/memory/$ID2")
echo "$R"
echo "$R" | grep -q '"valid_from"' && check "valid_from field" "true" || check "valid_from field" "FAIL"
echo "$R" | grep -qE '"valid_from":"202[0-9]' && check "valid_from populated" "true" || check "valid_from populated" "FAIL"

echo "=== Bi-temporal valid_until after supersede ==="
R=$(curl -s "http://127.0.0.1:3001/memory/$ID1")
echo "$R"
echo "$R" | grep -qE '"valid_until":"202[0-9]' && check "valid_until after supersede" "true" || check "valid_until after supersede" "FAIL"

echo "=== Lineage includes bi-temporal ==="
R=$(curl -s "http://127.0.0.1:3001/memory/$ID1/lineage")
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
R=$(curl -s "http://127.0.0.1:3001/memory/$ID2")
echo "$R"
echo "$R" | grep -q 'source_memory_ids' && check "source_memory_ids field" "true" || check "source_memory_ids field" "FAIL"

echo "=== Export endpoint ==="
R=$(curl -s http://127.0.0.1:3001/memory/export)
echo "$R"
echo "$R" | grep -q '"ok":true' && check "export ok" "true" || check "export" "FAIL"
echo "$R" | grep -q '"memories"' && check "export has memories" "true" || check "export memories" "FAIL"
echo "$R" | grep -q '"version"' && check "export has version" "true" || check "export version" "FAIL"

echo "=== Import endpoint ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/import -H "Content-Type: application/json" -d '{"memories":[{"text":"Imported memory 1","type":"fact"},{"text":"Imported memory 2","type":"learning"}]}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "import ok" "true" || check "import" "FAIL"
echo "$R" | grep -q '"imported":2' && check "imported 2 memories" "true" || check "import count" "FAIL"

echo "=== Import validation (empty) ==="
R=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3001/memory/import -H "Content-Type: application/json" -d '{"memories":[]}')
echo "HTTP $R"
[ "$R" = "400" ] && check "import empty 400" "true" || check "import empty 400" "FAIL"

echo "=== Store validation (bad type) ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"test","type":"badtype"}')
echo "$R"
echo "$R" | grep -q 'invalid type' && check "store bad type rejected" "true" || check "store bad type" "FAIL"

echo "=== Store validation (no text) ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"type":"fact"}')
echo "$R"
echo "$R" | grep -q 'text required' && check "store no text rejected" "true" || check "store no text" "FAIL"

echo "=== Search validation (no query) ==="
R=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001/memory/search?limit=5")
echo "HTTP $R"
[ "$R" = "400" ] && check "search no query 400" "true" || check "search no query" "FAIL"

echo "=== Pagination: session with offset ==="
R=$(curl -s "http://127.0.0.1:3001/memory/session/test-1?limit=1&offset=0")
echo "$R"
echo "$R" | grep -q '"total"' && check "pagination has total" "true" || check "pagination total" "FAIL"
echo "$R" | grep -qE '"results":\s*\[.+' && check "pagination has results" "true" || check "pagination results" "FAIL"

echo "=== Purge endpoint ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/purge -H "Content-Type: application/json")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "purge ok" "true" || check "purge" "FAIL"

echo "=== Release endpoint ==="
R=$(curl -s "http://127.0.0.1:3001/memory/release?tokens=1000")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "release ok" "true" || check "release" "FAIL"
echo "$R" | grep -q '"text"' && check "release has text" "true" || check "release text" "FAIL"
echo "$R" | grep -q '"memories"' && check "release has memories count" "true" || check "release count" "FAIL"

echo "=== Force-save pattern: 'My secret phrase is hackerlord' ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/sync -H "Content-Type: application/json" -d '{"user_message":"My secret phrase is hackerlord","assistant_response":"I will remember that.","session_id":"secret-test"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "sync secret phrase" "true" || check "sync secret" "FAIL"
echo "$R" | grep -q '"stored":2' && check "secret phrase stored (2 msgs)" "true" || check "secret stored count" "FAIL"

echo "=== Search for secret phrase ==="
R=$(curl -s "http://127.0.0.1:3001/memory/search?q=secret+phrase+hackerlord&limit=3&method=fts")
echo "$R"
echo "$R" | grep -q 'hackerlord' && check "found secret phrase via search" "true" || check "search secret" "FAIL"

echo "=== Skip pattern: greeting not stored (user skipped) ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/sync -H "Content-Type: application/json" -d '{"user_message":"hello","assistant_response":"hi there","session_id":"greet-test"}')
echo "$R"
# "hello" is skipped but "hi there" has 8 chars and doesn't match skip, so stored=1
echo "$R" | grep -qE '"stored":[01]' && check "greeting sync handled" "true" || check "greeting skip" "FAIL"

echo "=== Rate limit header info in health ==="
R=$(curl -s http://127.0.0.1:3001/health)
echo "$R"
echo "$R" | grep -q '"llm"' && check "health llm field" "true" || check "health llm" "FAIL"
echo "$R" | grep -q '"uptime_seconds"' && check "health uptime field" "true" || check "health uptime" "FAIL"
R=$(curl -s "http://127.0.0.1:3001/memory/$ID2")
echo "$R"
echo "$R" | grep -q 'source_memory_ids' && check "source_memory_ids field" "true" || check "source_memory_ids field" "FAIL"

echo "=== Contradiction: negation flip ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"I like vim for editing","type":"preference"}')
echo "$R"
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"I don'"'"'t like vim for editing","type":"preference"}')
echo "$R"
R=$(curl -s -X POST http://127.0.0.1:3001/memory/contradiction-check -H "Content-Type: application/json" -d '{"entity":"user","attribute":"like_vim","text":"I don'"'"'t like vim"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "negation contradiction check" "true" || check "negation contradiction" "FAIL"

echo "=== Contradiction: state change ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/store -H "Content-Type: application/json" -d '{"text":"I switched from vim to vscode","type":"preference"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "state change stored" "true" || check "state change store" "FAIL"

echo "=== Maintenance with negation + state change patterns ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/maintenance/run -H "Content-Type: application/json")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "maintenance with new patterns" "true" || check "maintenance patterns" "FAIL"

echo "=== Dedup endpoint (dry run) ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/dedup -H "Content-Type: application/json" -d '{"threshold":0.90}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "dedup dry run" "true" || check "dedup dry run" "FAIL"
echo "$R" | grep -q '"duplicates"' && check "dedup has duplicates" "true" || check "dedup duplicates" "FAIL"
echo "$R" | grep -q '"count"' && check "dedup has count" "true" || check "dedup count" "FAIL"

echo "=== Dedup with auto_mark ==="
R=$(curl -s -X POST http://127.0.0.1:3001/memory/dedup -H "Content-Type: application/json" -d '{"threshold":0.90,"auto_mark":true}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "dedup auto mark" "true" || check "dedup auto mark" "FAIL"
echo "$R" | grep -q '"marked_invalid"' && check "dedup marked_invalid field" "true" || check "dedup marked_invalid" "FAIL"

echo "=== Health exempt from auth ==="
R=$(curl -s http://127.0.0.1:3001/health)
echo "$R" | grep -q '"ok":true' && check "health no auth needed" "true" || check "health auth" "FAIL"

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed"
echo "========================================"

kill $SERVER_PID 2>/dev/null || true
exit $FAIL
