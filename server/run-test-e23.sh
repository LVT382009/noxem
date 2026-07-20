#!/usr/bin/env bash
# run-test-e23.sh — E23 flag-then-ping-Brain2 regression (flag-only cron + Brain2 SQLite verdict queue +
# dual-mode dedup + watermark loop-breaker + reaper + the memory_resolve_similar tool).
# Pure store ops — NO LLM, NO mock-llm (the drain/agent loop is never invoked; queue + watermark + reaper
# are store-level). LLM_URL is pointed at a closed port so the maintenance side-passes (ambient/strategy/capsule)
# fail FAST (instant ECONNREFUSED) instead of timing out — their errors are swallowed by runMaintenance's try/catch.
#
# Run (WSL Ubuntu-24.04):  bash run-test-e23.sh
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256 LOG_LEVEL=error BRAIN2_ENABLED=1
export LLM_URL=http://127.0.0.1:65535/v1/chat/completions LLM_MODEL=mock-model

# Clear the REAL db paths (mirror run-test-guard.sh) so rows do not leak across suites.
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm

node test_e23_flag_then_ping.mjs
RC=$?
exit $RC
