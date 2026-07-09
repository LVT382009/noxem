#!/usr/bin/env bash
# run-test-e9.sh — E9 bi-temporal edge cascade + asOf graph traversal regression.
#
# Ledger E9 (narrow tailgates, FF delta c): bi-temporal edges + invalidation-not-delete + 3-tier
# ALREADY existed — only two gaps: (1) supersession/archival did NOT cascade valid_until onto a
# memory's touching edges; (2) traverseMemoryGraph/getEdgesByRelation hardcoded datetime('now') so
# there was no asOf traversal (couldn't mirror /memory/at-time).
#
# Fix: cascadeInvalidateEdges(id) inside updateMemoryStatus's non-active tx; asOf-variant prepared
# statements with datetime(?) bound cutoff (SQLite normalizes the ISO8601 → the space-format
# valid_until is stored in). Test exercises both halves against the real store: deterministic asOf
# logic (parse a KNOWN valid_until, pick asOf ±1s — no wall-clock race), the cascade (supersede +
# archive, only-touching-edges, survivor edge, reactivation-immutability), and backward-compat.
# No LLM, no HTTP — direct store functions.
#
# Run (WSL Ubuntu-24.04): bash run-test-e9.sh
set -euo pipefail
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
rm -f ../data/hermes-memory.db data/hermes-memory.db \
      ../data/hermes-memory.db-wal data/hermes-memory.db-wal \
      ../data/hermes-memory.db-shm data/hermes-memory.db-shm
node test_e9.mjs
exit $?
