#!/usr/bin/env bash
# run-test-e20.sh — E20 D1 bundle-search status-gate (active || contradicted) regression.
# Pure store ops via the exported searchLayer path (bundleSearch() short-circuits under
# ENABLE_EMBEDDING=false; searchLayer runs the exact same knn + gate path). No LLM, no mock-llm.
# ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors.
#
# Run (WSL Ubuntu-24.04, fresh db): bash run-test-e20.sh
set -e
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
# Clear both db paths so rows do not leak across suites.
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm
node test_e20_bundle_status.mjs
