#!/usr/bin/env bash
# run-test-e1.sh — E1 stale-vector bleed regression test.
#
# Runs the in-process fixture test_e1_bleed.mjs on a FRESH database (mirrors run-test.sh
# hygiene) with the embedding engine OFF, so the vector-prune code path is exercised
# deterministically without depending on the local embedding model.
#
# The fixture imports memory-store.mjs + vector-index.mjs directly (no HTTP server), so it
# owns the db file exclusively — kill any leftover server on 3001 first.
#
# Run (WSL Ubuntu-24.04):  bash run-test-e1.sh
set -e
cd "$(dirname "$0")"

export ENABLE_EMBEDDING=false
export ENABLE_ADVISOR=false
export ENABLE_MAINTENANCE=false
export ENABLE_RESEARCH=false
export PIPELINE_ENABLED=false
export RLM_ENABLED=false
export EMBEDDING_DIM=256

# Defensive: free port 3001 and drop any stale db so the fixture boots on a clean db.
fuser -k 3001/tcp 2>/dev/null || true
rm -f data/hermes-memory.db data/hermes-memory.db-wal data/hermes-memory.db-shm

node test_e1_bleed.mjs
