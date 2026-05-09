#!/usr/bin/env bash
# Noxem Benchmark — measures store, search, batch, and maintenance performance
# Usage: bash benchmark.sh
set -e
cd "$(dirname "$0")"

export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false
export LOG_LEVEL=silent

rm -f data/hermes-memory.db

# Start server
node memory-server.mjs &
SERVER_PID=$!

# Wait for ready
for i in $(seq 1 15); do
  if curl -s http://127.0.0.1:3001/ready > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -s http://127.0.0.1:3001/ready | grep -q '"ok":true'; then
  echo "Server failed to start"
  kill $SERVER_PID 2>/dev/null || true
  exit 1
fi

echo "=== Noxem Benchmark ==="
echo ""

# ─── Store Latency ───
echo "--- Store (FTS-only, 100 memories) ---"
STORE_TOTAL=0
for i in $(seq 1 100); do
  START=$(date +%s%N)
  curl -s -X POST http://127.0.0.1:3001/memory/store \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"Memory item $i about project setup and configuration\",\"type\":\"setup\",\"session_id\":\"bench\"}" > /dev/null
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  STORE_TOTAL=$((STORE_TOTAL + ELAPSED))
done
STORE_AVG=$((STORE_TOTAL / 100))
echo "  100 stores: ${STORE_TOTAL}ms total, ${STORE_AVG}ms avg"

# ─── Batch Store ───
echo ""
echo "--- Batch Store (50 memories at once) ---"
BATCH_JSON='{"memories":['
for i in $(seq 1 50); do
  if [ $i -gt 1 ]; then BATCH_JSON="$BATCH_JSON,"; fi
  BATCH_JSON="$BATCH_JSON{\"text\":\"Batch memory $i for benchmarking performance\",\"type\":\"fact\"}"
done
BATCH_JSON="$BATCH_JSON]}"

START=$(date +%s%N)
curl -s -X POST http://127.0.0.1:3001/memory/store-batch \
  -H "Content-Type: application/json" \
  -d "$BATCH_JSON" > /dev/null
END=$(date +%s%N)
BATCH_MS=$(( (END - START) / 1000000 ))
echo "  50 memories in batch: ${BATCH_MS}ms ($((BATCH_MS / 50))ms avg)"

# ─── FTS Search Latency ───
echo ""
echo "--- FTS Search (200 queries) ---"
QUERIES=("project setup" "configuration" "memory item" "benchmarking" "batch memory" "dark mode" "auth bug" "React frontend" "secret phrase" "VS Code")
SEARCH_TOTAL=0
for q in "${QUERIES[@]}"; do
  for r in $(seq 1 20); do
    START=$(date +%s%N)
    curl -s "http://127.0.0.1:3001/memory/search?q=$(echo "$q" | tr ' ' '+')&limit=5&method=fts" > /dev/null
    END=$(date +%s%N)
    ELAPSED=$(( (END - START) / 1000000 ))
    SEARCH_TOTAL=$((SEARCH_TOTAL + ELAPSED))
  done
done
SEARCH_AVG=$((SEARCH_TOTAL / 200))
echo "  200 queries: ${SEARCH_TOTAL}ms total, ${SEARCH_AVG}ms avg"

# ─── Hybrid Search Latency ───
echo ""
echo "--- Hybrid Search (100 queries, no embedding) ---"
SEARCH2_TOTAL=0
for q in "${QUERIES[@]}"; do
  for r in $(seq 1 10); do
    START=$(date +%s%N)
    curl -s "http://127.0.0.1:3001/memory/search?q=$(echo "$q" | tr ' ' '+')&limit=5" > /dev/null
    END=$(date +%s%N)
    ELAPSED=$(( (END - START) / 1000000 ))
    SEARCH2_TOTAL=$((SEARCH2_TOTAL + ELAPSED))
done
done
SEARCH2_AVG=$((SEARCH2_TOTAL / 100))
echo "  100 queries: ${SEARCH2_TOTAL}ms total, ${SEARCH2_AVG}ms avg"

# ─── Sync Turn Latency ───
echo ""
echo "--- Sync Turn (50 turns) ---"
SYNC_TOTAL=0
for i in $(seq 1 50); do
  START=$(date +%s%N)
  curl -s -X POST http://127.0.0.1:3001/memory/sync \
    -H "Content-Type: application/json" \
    -d "{\"user_message\":\"Tell me about feature $i\",\"assistant_response\":\"Feature $i is a new capability for the system\",\"session_id\":\"bench-sync\"}" > /dev/null
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  SYNC_TOTAL=$((SYNC_TOTAL + ELAPSED))
done
SYNC_AVG=$((SYNC_TOTAL / 50))
echo "  50 syncs: ${SYNC_TOTAL}ms total, ${SYNC_AVG}ms avg"

# ─── Maintenance Cycle ───
echo ""
echo "--- Maintenance (dedup + contradict + consolidate + archive) ---"
START=$(date +%s%N)
curl -s -X POST http://127.0.0.1:3001/memory/maintenance/run \
  -H "Content-Type: application/json" > /dev/null
END=$(date +%s%N)
MAINT_MS=$(( (END - START) / 1000000 ))
echo "  Full cycle: ${MAINT_MS}ms"

# ─── Release (Context Injection) ───
echo ""
echo "--- Release (context injection, 200 requests) ---"
RELEASE_TOTAL=0
for i in $(seq 1 200); do
  START=$(date +%s%N)
  curl -s "http://127.0.0.1:3001/memory/release?tokens=2000" > /dev/null
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  RELEASE_TOTAL=$((RELEASE_TOTAL + ELAPSED))
done
RELEASE_AVG=$((RELEASE_TOTAL / 200))
echo "  200 requests: ${RELEASE_TOTAL}ms total, ${RELEASE_AVG}ms avg"

# ─── Stats ───
echo ""
echo "--- Memory Stats ---"
curl -s http://127.0.0.1:3001/memory/stats | python3 -c "
import sys, json
s = json.load(sys.stdin)
print(f\"  Active memories: {s.get('active', 0)}\")
print(f\"  Total memories: {s.get('total', 0)}\")
" 2>/dev/null || curl -s http://127.0.0.1:3001/memory/stats

echo ""
echo "=== Benchmark Complete ==="

kill $SERVER_PID 2>/dev/null || true
rm -f data/hermes-memory.db
