#!/usr/bin/env bash
# run-test-e18.sh — E18 Brain2 merge-then-delete + supersede chain-edge regression.
# Pure store ops (no LLM, no mock-llm). ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors.
#
# Run (WSL Ubuntu-24.04, fresh db): bash run-test-e18.sh
set -e
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
# Clear the REAL db (PROJECT_ROOT/data) AND the server-relative data dir — harness fix so rows do
# not leak across suites (DB_PATH resolves to ../data/hermes-memory.db from the server cwd).
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm
node test_e18_merge.mjs
