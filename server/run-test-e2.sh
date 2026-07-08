#!/usr/bin/env bash
# run-test-e2.sh — E2 semantic-intent merge + A-MEM evolve regression.
#
# Drives the REAL engines (tryActiveEvolveDedup / consolidateSemantically / appendEvolvedContext)
# against the REAL sqlite store, using basis-vector embeddings (no live embedding model needed).
# J3 consolidate-synth is exercised through the REAL mock-llm (port 8000, 'consolidate-synth'
# branch): a canonical sentence on success; an empty completion when one clustered text carries the
# FORCE_DEGRADE marker -> the silent-loss gate fires (cluster left untouched, zero data loss).
#
# Run (WSL Ubuntu-24.04): bash run-test-e2.sh
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
export LLM_URL=http://127.0.0.1:8000/v1/chat/completions
export LLM_MODEL=mock-model

fuser -k 3001/tcp 8000/tcp 2>/dev/null || true
# Clear the REAL db (PROJECT_ROOT/data) AND the server-relative data dir — harness fix so rows do
# not leak across suites (DB_PATH resolves to ../data/hermes-memory.db from the server cwd).
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm

# Start mock LLM on port 8000 (J3 consolidate-synth + pipeline branches)
node mock-llm.mjs &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT

# Wait for mock-llm ready
MOCK_READY=0
for i in $(seq 1 20); do
  if curl -s --max-time 2 -X POST http://127.0.0.1:8000/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"model":"x","messages":[{"role":"system","content":"ping consolidate-synth"},{"role":"user","content":"1. hi"}]}' \
      -o /dev/null 2>/dev/null; then
    echo "mock-llm ready after ${i}s"
    MOCK_READY=1
    break
  fi
  sleep 1
done
if [ "$MOCK_READY" -ne 1 ]; then
  echo "mock-llm failed to start — aborting"
  exit 2
fi

node test_e2_semantic_merge.mjs
RC=$?
exit $RC
