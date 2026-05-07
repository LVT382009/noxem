#!/usr/bin/env bash
# Embedding E2E test — starts server WITH embedding enabled, tests the full vector pipeline
set -e
cd "$(dirname "$0")"

export ENABLE_EMBEDDING=true
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false
export MEMORY_PORT=3002
export MEMORY_DB_DIR=./data-test-embed

rm -rf "$MEMORY_DB_DIR"

node memory-server.mjs &
SERVER_PID=$!

# Wait for embedding model to load (can take 30-60s)
echo "Waiting for embedding model to load..."
for i in $(seq 1 120); do
  R=$(curl -s http://127.0.0.1:3002/health 2>/dev/null || echo '')
  if echo "$R" | grep -q '"embedding":true'; then
    echo "Server + embedding ready after ${i}s"
    break
  fi
  if [ $i -eq 120 ]; then
    echo "TIMEOUT waiting for embedding model"
    kill $SERVER_PID 2>/dev/null || true
    rm -rf "$MEMORY_DB_DIR"
    exit 1
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

echo "=== Health with embedding ==="
R=$(curl -s http://127.0.0.1:3002/health)
echo "$R"
echo "$R" | grep -q '"embedding":true' && check "embedding enabled" "true" || check "embedding enabled" "FAIL"
echo "$R" | grep -q '"uptime_seconds"' && check "health has uptime" "true" || check "health uptime" "FAIL"
echo "$R" | grep -q '"memory"' && check "health has memory stats" "true" || check "health memory stats" "FAIL"

echo "=== Store with embedding ==="
R=$(curl -s -X POST http://127.0.0.1:3002/memory/store -H "Content-Type: application/json" -d '{"text":"I prefer dark mode for VS Code","type":"preference"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store pref" "true" || check "store pref" "FAIL"

echo "=== Store another preference ==="
R=$(curl -s -X POST http://127.0.0.1:3002/memory/store -H "Content-Type: application/json" -d '{"text":"I use React for frontend development","type":"setup"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store setup" "true" || check "store setup" "FAIL"

echo "=== Store a fact ==="
R=$(curl -s -X POST http://127.0.0.1:3002/memory/store -H "Content-Type: application/json" -d '{"text":"My name is Tam and I work on Hermes","type":"profile"}')
echo "$R"
echo "$R" | grep -q '"ok":true' && check "store profile" "true" || check "store profile" "FAIL"

echo "=== Verify embedding was stored ==="
R=$(curl -s http://127.0.0.1:3002/memory/1)
echo "$R"
echo "$R" | grep -q '"embedding"' && check "memory has embedding field" "true" || check "embedding field" "FAIL"

echo "=== Embedding search (method=embedding) ==="
R=$(curl -s "http://127.0.0.1:3002/memory/search?q=dark+mode+IDE&limit=5&method=embedding")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "embedding search ok" "true" || check "embedding search" "FAIL"
echo "$R" | grep -q '"method":"embedding"' && check "search method=embedding" "true" || check "search method" "FAIL"
echo "$R" | grep -qE '"results":\s*\[.+' && check "embedding search has results" "true" || check "embedding search results" "FAIL"

echo "=== Hybrid search (default) ==="
R=$(curl -s "http://127.0.0.1:3002/memory/search?q=React+development&limit=5&method=hybrid")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "hybrid search ok" "true" || check "hybrid search" "FAIL"
echo "$R" | grep -qE '"method":"(hybrid|embedding|fts)"' && check "hybrid returns method" "true" || check "hybrid method" "FAIL"

echo "=== FTS-only search ==="
R=$(curl -s "http://127.0.0.1:3002/memory/search?q=dark+mode&limit=5&method=fts")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "fts search ok" "true" || check "fts search" "FAIL"
echo "$R" | grep -q '"method":"fts"' && check "fts method=fts" "true" || check "fts method" "FAIL"

echo "=== Store batch with embeddings ==="
R=$(curl -s -X POST http://127.0.0.1:3002/memory/store-batch -H "Content-Type: application/json" -d '{"memories":[{"text":"I like TypeScript","type":"preference"},{"text":"Project uses SQLite","type":"setup"}]}')
echo "$R"
echo "$R" | grep -q '"ids"' && check "store-batch with embedding" "true" || check "store-batch embed" "FAIL"

echo "=== Reembed (should be no-op, all have embeddings) ==="
R=$(curl -s -X POST http://127.0.0.1:3002/memory/reembed -H "Content-Type: application/json" -d '{}')
echo "$R"
echo "$R" | grep -qE '"ok":true|"reembedded":0' && check "reembed no-op" "true" || check "reembed" "FAIL"

echo "=== Multi-word embedding search ==="
R=$(curl -s "http://127.0.0.1:3002/memory/search?q=what+IDE+theme+do+I+prefer&limit=5&method=embedding")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "semantic search works" "true" || check "semantic search" "FAIL"
echo "$R" | grep -qi 'dark.mode\|prefer' && check "semantic search relevant" "true" || check "semantic relevance" "FAIL"

echo "=== Stats ==="
R=$(curl -s http://127.0.0.1:3002/memory/stats)
echo "$R"
echo "$R" | grep -qE '"active":[1-9]' && check "stats has active memories" "true" || check "stats active" "FAIL"

echo "=== Duplicate detection via maintenance ==="
R=$(curl -s -X POST http://127.0.0.1:3002/memory/store -H "Content-Type: application/json" -d '{"text":"I prefer dark mode for VS Code","type":"preference"}')
echo "$R"
R=$(curl -s -X POST http://127.0.0.1:3002/memory/maintenance/run -H "Content-Type: application/json")
echo "$R"
echo "$R" | grep -q '"ok":true' && check "maintenance with embedding" "true" || check "maintenance embed" "FAIL"

echo ""
echo "========================================"
echo "Embedding E2E: $PASS passed, $FAIL failed"
echo "========================================"

kill $SERVER_PID 2>/dev/null || true
rm -rf "$MEMORY_DB_DIR"
exit $FAIL
