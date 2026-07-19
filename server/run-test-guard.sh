#!/usr/bin/env bash
# run-test-guard.sh — distinct-fact gate (Phase B) + cone_layer CRON guard regression.
# Mirrors run-test-e2.sh but uses MOCK_LLM_PORT=8011 so a LIVE qwenproxy adapter already on :8000
# is NOT disturbed (the E2 wrapper does `fuser -k 3001/tcp 8000/tcp`; that would kill your live
# server). We deliberately do NOT touch port 8000 here.
#
# Run (WSL Ubuntu-24.04): bash run-test-guard.sh
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
export MOCK_LLM_PORT=8011
export LLM_URL=http://127.0.0.1:8011/v1/chat/completions
export LLM_MODEL=mock-model

# Clear the REAL db paths (mirror run-test-e2.sh) so rows do not leak across suites.
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm

# Free port 8011 ONLY (leave 8000 alone — qwenproxy may be live there).
fuser -k 8011/tcp 2>/dev/null || true

# Start mock LLM on port 8011 (J3 consolidate-synth -> FORCE_DISTINCT/FORCE_DEGRADE/canonical routes).
MOCK_LLM_PORT=8011 node mock-llm.mjs &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT

MOCK_READY=0
for i in $(seq 1 20); do
  if curl -s --max-time 2 -X POST http://127.0.0.1:8011/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"model":"x","messages":[{"role":"system","content":"ping consolidate-synth"},{"role":"user","content":"1. hi"}]}' \
      -o /dev/null 2>/dev/null; then
    echo "mock-llm ready after ${i}s (port 8011)"
    MOCK_READY=1
    break
  fi
  sleep 1
done
if [ "$MOCK_READY" -ne 1 ]; then
  echo "mock-llm failed to start on 8011 — aborting"
  exit 2
fi

node test_distinct_cone_guard.mjs
RC=$?
exit $RC
