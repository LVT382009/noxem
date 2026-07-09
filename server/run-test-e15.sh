#!/usr/bin/env bash
# run-test-e15.sh — E15 MMR-diversity consistency (both KNN backends) + diversity-gain measurement.
#
# E15 ledger symptom: MMR (lambda=0.7) ran only on the JS-cosine fallback, never on native KNN → the
# same query got different diversity per backend (and on neither path effectively — cands had no
# embeddings). Fix: mmrRerank takes an optional embeddingsById side-band Map (real candidate cosine
# without leaking `.embedding` into the JSON response); the native KNN path now applies MMR too via
# getEmbeddingsById (a ~topK lookup, NOT a full active-set load); diversifyAndMeasure quantifies the
# diversityGain and exposes it via /memory/search?stats=true. Test: pure-function MMR+measurement
# on synthetic basis/2-sparse embeddings + getEmbeddingsById against the real store. No LLM.
#
# Run (WSL Ubuntu-24.04): bash run-test-e15.sh
set -euo pipefail
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
rm -f ../data/hermes-memory.db data/hermes-memory.db \
      ../data/hermes-memory.db-wal data/hermes-memory.db-wal \
      ../data/hermes-memory.db-shm data/hermes-memory.db-shm
node test_e15.mjs
exit $?
