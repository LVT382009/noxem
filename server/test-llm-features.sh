#!/usr/bin/env bash
# Test LLM-dependent features with a mock LLM server
set -e
cd "$(dirname "$0")"
fuser -k 3001/tcp 8000/tcp 2>/dev/null || true
sleep 2
rm -f data/hermes-memory.db*

# Start mock LLM on port 8000
node mock-llm.mjs &
MOCK_PID=$!
sleep 2

# Start memory server
export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=true
export ENABLE_MAINTENANCE=false
export LLM_URL=http://127.0.0.1:8000/v1/chat/completions
export LLM_MODEL=mock-model
node memory-server.mjs &
SERVER_PID=$!

# Wait for both servers
for i in $(seq 1 30); do
  if curl -s --max-time 2 http://127.0.0.1:3001/health > /dev/null 2>&1; then
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

# Store some memories for pipeline/learn
echo "=== Storing test memories ==="
for i in 1 2 3 4 5; do
  curl -s --max-time 5 -X POST http://127.0.0.1:3001/memory/store \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"Auth bug fix step $i: checking middleware component\",\"type\":\"fact\",\"session_id\":\"pipeline-test\"}" > /dev/null
done

# 1. Test /memory/learn
echo "=== Test: /memory/learn ==="
LEARN_R=$(curl -s --max-time 30 -X POST http://127.0.0.1:3001/memory/learn \
  -H "Content-Type: application/json" \
  -d '{"session_id":"pipeline-test"}')
echo "$LEARN_R"
echo "$LEARN_R" | grep -q '"ok":true' && check "learn ok" "true" || check "learn ok" "FAIL"
echo "$LEARN_R" | grep -q '"procedure_id"' && check "learn has procedure_id" "true" || check "learn procedure_id" "FAIL"

# 2. Test pipeline status
echo "=== Test: Pipeline status ==="
PIPE_R=$(curl -s --max-time 5 http://127.0.0.1:3001/memory/pipeline/status)
echo "$PIPE_R"
echo "$PIPE_R" | grep -q '"ok":true' && check "pipeline status ok" "true" || check "pipeline status" "FAIL"
echo "$PIPE_R" | grep -q '"L0_episode"' && check "pipeline has L0" "true" || check "pipeline L0" "FAIL"

# 3. Test pipeline run
echo "=== Test: Pipeline run ==="
RUN_R=$(curl -s --max-time 30 -X POST http://127.0.0.1:3001/memory/pipeline/run \
  -H "Content-Type: application/json")
echo "$RUN_R"
echo "$RUN_R" | grep -q '"ok":true' && check "pipeline run ok" "true" || check "pipeline run" "FAIL"

# 4. Test advisor compress
echo "=== Test: Advisor compress ==="
ADV_R=$(curl -s --max-time 30 -X POST http://127.0.0.1:3001/memory/advisor/compress \
  -H "Content-Type: application/json" \
  -d '{"conversation_history":[{"role":"user","content":"fix auth bug"},{"role":"assistant","content":"checking middleware"}]}')
echo "$ADV_R"
echo "$ADV_R" | grep -q '"ok":true' && check "advisor compress ok" "true" || check "advisor compress" "FAIL"

# 5. Test procedures list
echo "=== Test: Procedures list ==="
PROC_R=$(curl -s --max-time 5 http://127.0.0.1:3001/memory/procedures)
echo "$PROC_R"
echo "$PROC_R" | grep -q '"ok":true' && check "procedures list ok" "true" || check "procedures list" "FAIL"

echo ""
echo "========================================"
echo "LLM Feature Results: $PASS passed, $FAIL failed"
echo "========================================"

kill $SERVER_PID $MOCK_PID 2>/dev/null || true
exit $FAIL
