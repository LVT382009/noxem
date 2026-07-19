#!/usr/bin/env bash
# run-regress-guard.sh — regression sweep for E2 + E8 after the mock-llm (FORCE_DISTINCT branch +
# MOCK_LLM_PORT) + consolidateMemories (export + isEmbeddingReady inner-check removal) changes.
# Uses MOCK_LLM_PORT=8011 ONLY and does NOT touch port 8000, so a live qwenproxy stays up.
# Runs the test NODE files directly (not their run-test-*.sh wrappers, which `fuser -k 8000/tcp`).
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false EMBEDDING_DIM=256 ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false
export MOCK_LLM_PORT=8011
export LLM_URL=http://127.0.0.1:8011/v1/chat/completions
export LLM_MODEL=mock-model

rm -f ../data/hermes-memory.db data/hermes-memory.db ..data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm 2>/dev/null
fuser -k 8011/tcp 2>/dev/null || true

MOCK_LLM_PORT=8011 node mock-llm.mjs >/tmp/regress-mock.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT

READY=0
for i in $(seq 1 20); do
  if curl -s --max-time 2 -X POST http://127.0.0.1:8011/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"model":"x","messages":[{"role":"system","content":"ping"},{"role":"user","content":"hi"}]}' \
      -o /dev/null 2>/dev/null; then
    echo "mock-llm ready after ${i}s (port 8011)"
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then echo "mock-llm failed on 8011 — aborting"; exit 2; fi

# E2 first (uses mock consolidate-synth -> exercises FORCE_DEGRADE + canonical); E8 second (no mock).
echo "=== E2 semantic merge (expect 43 PASS 0 FAIL) ==="
node test_e2_semantic_merge.mjs 2>&1 | tail -4

# E8 needs a FRESH db (loads archived candidates, sees effects of E2 rows). Clear between.
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm 2>/dev/null
echo "=== E8 cross-archived dedup (expect 38 PASS 0 FAIL) ==="
node test_e8_crossarchived_dedup.mjs 2>&1 | tail -4
