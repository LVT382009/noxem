#!/usr/bin/env bash
# run-test-e10.sh — E10 keyset (seek) pagination + drop COUNT(*) regression.
#
# E10: /memory/session/:id + /memory/type/:id list endpoints replace OFFSET/LIMIT slice + the
# per-page COUNT(*) total (S-#54) with keyset (seek) pagination — ORDER BY (created_at DESC, id DESC)
# composite tiebreak, cursor = base64url('created_at|id'), fetch limit+1 → hasMore, total: null.
# Migration v9 adds the covering composite indexes (session_id,type × status × created_at DESC, id DESC)
# so the seek predicate resolves on a real index. Test drives the real store against a fresh db with
# basis-vector embeddings (no live model). No LLM.
#
# Run (WSL Ubuntu-24.04): bash run-test-e10.sh
set -euo pipefail
cd "$(dirname "$0")"
export ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3001/tcp 2>/dev/null || true
# Clear the REAL db (PROJECT_ROOT/data) AND the server-relative data dir so rows/seeds do not leak
# across suites (DB_PATH resolves to ../data/hermes-memory.db from the server cwd).
rm -f ../data/hermes-memory.db data/hermes-memory.db \
      ../data/hermes-memory.db-wal data/hermes-memory.db-wal \
      ../data/hermes-memory.db-shm data/hermes-memory.db-shm
node test_e10.mjs
exit $?
