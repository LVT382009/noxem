#!/usr/bin/env bash
# run-test-e21.sh — memory_link + memory_compact + memory_audit_report (step 5).
# Pure store ops via dispatchTool (the agent-loop path). No LLM, no mock-llm.
# ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors (merge/compact embed arms are guarded).
#
# Run (WSL Ubuntu-24.04, fresh db): bash run-test-e21.sh
set -e
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
# Clear both db paths so rows do not leak across suites.
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm
node test_e21_link_compact_audit.mjs
