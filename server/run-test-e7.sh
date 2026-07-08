#!/usr/bin/env bash
# run-test-e7.sh — E7 archive-index + reactivation-on-reference regression.
set -e
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
rm -f data/hermes-memory.db data/hermes-memory.db-wal data/hermes-memory.db-shm
node test_e7_reactivation.mjs
