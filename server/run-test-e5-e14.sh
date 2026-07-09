#!/usr/bin/env bash
# run-test-e5-e14.sh — E5 bounded active set + E14 dedup pagination regression.
#
# E5: enforceActiveSetBound (memory-store) bounds the active set at ACTIVE_SET_MAX, demoting
# surplus lowest-value L1/L2 facets to 'archived' (L0/L3 cardinal survive — E6 guard); value rank
# importance ASC, recall_count ASC, created_at ASC. E14: findDuplicates / findContradictions
# (embedding-engine) paginate via a windowed pass — NO 1000-input truncation, O(n*window) (closes
# the BUG-HUNT-v3 DoS), pair ceiling lifted to DEDUP_MAX_PAIRS (default 50000). Also exercises
# runActiveSetBoundStep (the maintenance wiring) without booting the embedding engine. No LLM.
#
# Run (WSL Ubuntu-24.04): bash run-test-e5-e14.sh
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
# Clear the REAL db (PROJECT_ROOT/data) AND the server-relative data dir so rows do not leak across
# suites (DB_PATH resolves to ../data/hermes-memory.db from the server cwd).
rm -f ../data/hermes-memory.db data/hermes-memory.db data/hermes-memory.db-wal ../data/hermes-memory.db-wal data/hermes-memory.db-shm ../data/hermes-memory.db-shm
node test_e5_e14.mjs
exit $?
