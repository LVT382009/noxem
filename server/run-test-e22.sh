#!/usr/bin/env bash
# run-test-e22.sh — enrichment-merge-first CRON + review-pending harden (step 7).
# Pure store ops via the exported CRON functions (no agent loop, no LLM, no mock-llm).
# ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors (enrich's vectorKnnSearch + the
# harden path both work without the live embedding engine; mergeMemoriesHard low-conf embed arm guarded).
#
# Run (WSL Ubuntu-24.04, fresh db): bash run-test-e22.sh
set -e
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
# E23 dual-mode: S2 asserts the stale is HARD-DELETED INTO related — the Brain1 concat+delete path.
# Pin BRAIN2_ENABLED=0 so the Brain2-on deferred-flag branch (linkSimilarPair only, no delete) does
# not make !memExists(stale) fail. Matches run-test-guard.sh/run-regress-guard.sh (both pin Brain2 off).
# The Brain2-on flag path is covered by run-test-e23.sh (S7/S9/S10).
export BRAIN2_ENABLED=0
fuser -k 3001/tcp 2>/dev/null || true
# Clear both db paths so rows do not leak across suites.
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm
node test_e22_mergefirst_harden.mjs
