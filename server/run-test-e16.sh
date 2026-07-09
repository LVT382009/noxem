#!/usr/bin/env bash
# run-test-e16.sh — E16 migration stop-on-first-error regression.
#
# Two layers:
#   1) test_e16_migration_hardfail.mjs — in-process contract: drives the REAL makeMigrationRunner
#      factory against a throwaway :memory: SQLite DB + poisoned migration maps (happy path,
#      hard-stop re-throw, partial boundary v1→v2→v3, no-op when fully migrated, transaction
#      rollback of side effects). Production schema is never mutated.
#   2) test_e16_poison_child.mjs — process-level guard: a child whose migration throws at import
#      time must exit non-zero (the server never boots on a partial schema). The harness asserts a
#      "SURVIVED" sentinel never prints AND the exit code is non-zero.
#
# Run (WSL Ubuntu-24.04): bash run-test-e16.sh
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
# Clear the REAL db (PROJECT_ROOT/data) AND the server-relative data dir so rows do not leak across
# suites (DB_PATH resolves to ../data/hermes-memory.db from the server cwd).
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm

echo "== E16 in-process contract =="
node test_e16_migration_hardfail.mjs
RC1=$?
echo "in-process exit: $RC1"

echo "== E16 process-level hard-stop (poison child) =="
CHILD_OUT=$(node test_e16_poison_child.mjs 2>&1)
RC2=$?
echo "poison child exit: $RC2 (non-zero is the EXPECTED hard-stop result)"
# Hard-stop SUCCEEDED iff the child died non-zero AND never reached the survival sentinel.
# (A non-zero exit is the PASS condition here — the whole point of E16 is that a poisoned migration
# must abort the process before the server boots.)
CHILD_OK=1
if echo "$CHILD_OUT" | grep -q 'E16_POISON_CHILD_SURVIVED_FAILURE'; then
  echo "FAIL: poison child SURVIVED its migration failure — hard-stop broken (sentinel printed)"
  CHILD_OK=0
elif [ "$RC2" -eq 0 ]; then
  echo "FAIL: poison child exited 0 — hard-stop did NOT cause a non-zero process exit"
  CHILD_OK=0
fi

echo ""
echo "========================================"
echo "E16 Results: in-process=$RC1 child-ok=$CHILD_OK (poison child exit=$RC2)"
echo "========================================"
if [ "$RC1" -ne 0 ] || [ "$CHILD_OK" -ne 1 ]; then exit 1; fi
exit 0
