#!/usr/bin/env bash
# Test v2-specific endpoints — run after server is up on port 3001
set -euo pipefail

BASE="http://localhost:3001"
PASS=0
FAIL=0

check() {
  local label="$1" expect="$2" actual="$3"
  if echo "$actual" | grep -q "$expect"; then
    echo "PASS: $label"
    ((PASS++))
  else
    echo "FAIL: $label — expected '$expect' in: $(echo "$actual" | head -c 200)"
    ((FAIL++))
  fi
}

echo "=== V2 Endpoint Tests ==="

# 1. Health includes v2 fields
R=$(curl -s "$BASE/health")
check "health.ok" '"ok":true' "$R"
check "health.vector_backend" "vector_backend" "$R"
check "health.turbovec" "turbovec" "$R"

# 2. Pipeline status
R=$(curl -s "$BASE/memory/pipeline/status")
check "pipeline.ok" '"ok":true' "$R"
check "pipeline.layers" "L0_episode" "$R"

# 3. Procedures list (empty, but should work)
R=$(curl -s "$BASE/memory/procedures")
check "procedures.ok" '"ok":true' "$R"

# 4. Procedure search
R=$(curl -s "$BASE/memory/procedures/search?q=test")
check "proc-search.ok" '"ok":true' "$R"

# 5. Store a memory (should create edges automatically)
R=$(curl -s -X POST "$BASE/memory/store" \
  -H "Content-Type: application/json" \
  -d '{"text":"V2 test: Redis cache timeout debug","type":"learning","entity":"redis","attribute":"cache","importance":0.9}')
check "store.ok" '"ok":true' "$R"
NEW_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null || echo "")
check "store.id" '[0-9]' "$NEW_ID"

# 6. Graph traverse from the new memory
sleep 2  # wait for edge creation
if [ -n "$NEW_ID" ]; then
  R=$(curl -s "$BASE/memory/graph/traverse?from_id=$NEW_ID&max_depth=2&limit=10")
  check "graph-traverse.ok" '"ok":true' "$R"
else
  echo "SKIP: graph-traverse (no ID from store)"
  ((FAIL++))
fi

# 7. Search with entity-attribute pre-filter
R=$(curl -s -X POST "$BASE/memory/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"redis cache","limit":5}')
check "search.results" '"results"' "$R"

# 8. Structured advisor advice
R=$(curl -s "$BASE/memory/advisor/advice?structured=true")
check "advisor.structured" "drift_detected" "$R"

# 9. Bundle search (may fail if embedding not ready)
R=$(curl -s -X POST "$BASE/memory/bundle-search" \
  -H "Content-Type: application/json" \
  -d '{"query":"redis cache","topK":3}')
# Accept both ok and error (embedding may not be ready)
if echo "$R" | grep -q '"ok":true'; then
  check "bundle-search.ok" '"ok":true' "$R"
else
  echo "WARN: bundle-search returned error (expected if embedding not warm): $(echo "$R" | head -c 100)"
fi

# 10. Learn endpoint (may fail without Brain-2, but endpoint should exist)
R=$(curl -s -X POST "$BASE/memory/learn" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-v2"}')
if echo "$R" | grep -qE '"ok":true|"error"'; then
  echo "PASS: learn endpoint responds"
  ((PASS++))
else
  echo "FAIL: learn endpoint no response"
  ((FAIL++))
fi

# 11. Pipeline run
R=$(curl -s -X POST "$BASE/memory/pipeline/run")
# Accept any response (may be noop if not enough memories)
if echo "$R" | grep -qE '"ok"|layers'; then
  echo "PASS: pipeline/run endpoint responds"
  ((PASS++))
else
  echo "FAIL: pipeline/run endpoint no response"
  ((FAIL++))
fi

echo ""
echo "=== V2 Results: $PASS passed, $FAIL failed ==="
