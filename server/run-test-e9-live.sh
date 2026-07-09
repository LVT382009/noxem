#!/usr/bin/env bash
# run-test-e9-live.sh — live E9 wire verification (edge cascade + asOf graph endpoints).
#
# Unit coverage (test_e9.mjs) exercises the STORE functions directly. This script verifies the ENDPOINT
# WIRING — /memory/graph/traverse?asOf=<ISO> + /memory/graph/edges?asOf=<ISO> + 400-on-bad-ISO, AND the
# E9 edge cascade through the real /memory/supersede handler. Graph endpoints are SQL-only (no
# embedding model), so the server boots with ENABLE_EMBEDDING=false. Memories+edge are seeded directly
# via the store (node _e9_live_seed.mjs) to bypass the HTTP store handler's embedding-off "duplicate"
# short-circuit (orthogonal to E9); only the GRAPH HTTP endpoints are wired here.
#
# Run (WSL Ubuntu-24.04): bash run-test-e9-live.sh
set -uo pipefail
cd "$(dirname "$0")"
export MEMORY_PORT=3099 ENABLE_EMBEDDING=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false ENABLE_ADVISOR=false RLM_ENABLED=false EMBEDDING_DIM=256
U=http://127.0.0.1:3099
fuser -k 3099/tcp 2>/dev/null || true
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal data/hermes-memory.db-shm data/hermes-memory.db-shm

# Seed 2 memories + 1 parent edge via the store (reliable path; HTTP store skips id when embedding off).
SEED=$(node _e9_live_seed.mjs 2>/dev/null | grep '^E9SEED:') || { echo "FAIL: seed produced no marker line"; exit 2; }
LINE=${SEED#E9SEED:}
IFS=':' read -r M0 M1 EID <<< "$LINE"
[ -z "$M0" ] || [ -z "$M1" ] || [ -z "$EID" ] && { echo "FAIL: seed produced no ids ('$SEED')"; exit 3; }
echo "OK: seeded m0=$M0 m1=$M1 edge=$EID (parent)"

# Boot server on the seeded db.
node memory-server.mjs > /tmp/e9srv.log 2>&1 &
SRV_PID=$!
trap "kill $SRV_PID 2>/dev/null || true; fuser -k 3099/tcp 2>/dev/null || true" EXIT
ready=0
for i in $(seq 1 60); do
  if curl -fsS "$U/ready" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then echo "FAIL: server did not become ready"; tail -20 /tmp/e9srv.log; exit 4; fi
echo "OK: server ready on :3099 (embedding off, seeded db)"

# Pre-invalidation: traverse + edges should surface the seeded parent edge live.
TRAV_NOW=$(curl -fsS "$U/memory/graph/traverse?from_id=$M0&direction=outgoing")
EDGE_NOW=$(curl -fsS "$U/memory/graph/edges?relation=parent&limit=50")
# Invalidate the edge → valid_until = datetime('now'). Then confirm post-invalidation queries exclude it.
curl -fsS -X POST "$U/memory/graph/edge/$EID/invalidate" >/dev/null
TRAV_NOW2=$(curl -fsS "$U/memory/graph/traverse?from_id=$M0&direction=outgoing")
EDGE_NOW2=$(curl -fsS "$U/memory/graph/edges?relation=parent&limit=50")
BAD=$(curl -s -o /dev/null -w "%{http_code}" "$U/memory/graph/traverse?from_id=$M0&asOf=not-a-date")
# Fixed asOf cutoffs around the invalidation: PAST = 1h ago (before the invalidation, edge was live),
# FUTURE = 1h ahead (after the invalidation, edge dead). Fixed offsets avoid needing to read valid_until
# first (the now-query excludes the invalidated edge, so its valid_until can't be read off the now-list).
ASOF_PAST=$(node -e 'console.log(new Date(Date.now()-3600000).toISOString())')
ASOF_FUT=$(node -e 'console.log(new Date(Date.now()+3600000).toISOString())')
TRAV_ASOF_PAST=$(curl -fsS "$U/memory/graph/traverse?from_id=$M0&direction=outgoing&asOf=$ASOF_PAST")
EDGE_ASOF_PAST=$(curl -fsS "$U/memory/graph/edges?relation=parent&limit=50&asOf=$ASOF_PAST")
TRAV_ASOF_FUT=$(curl -fsS "$U/memory/graph/traverse?from_id=$M0&direction=outgoing&asOf=$ASOF_FUT")
# Supersede m1 → cascade should invalidate the touching parent edge via the real handler.
curl -fsS -X POST "$U/memory/supersede" -H 'Content-Type: application/json' -d "{\"old_id\":$M1,\"new_id\":$M0,\"reason\":\"e9live-cascade\"}" >/dev/null
EDGE_POST_SUPER=$(curl -fsS "$U/memory/graph/edges?relation=parent&limit=50")

export M0 M1 EID ASOF_PAST ASOF_FUT BAD
printf '%s\n' "$TRAV_NOW" "$EDGE_NOW" "$TRAV_NOW2" "$EDGE_NOW2" "$TRAV_ASOF_PAST" "$EDGE_ASOF_PAST" "$TRAV_ASOF_FUT" "$EDGE_POST_SUPER" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const lines = s.replace(/\n$/, "").split("\n");
  let travNow, edgeNow, travNow2, edgeNow2, travAsPast, edgeAsPast, travAsFut, edgePostSuper;
  try { [travNow, edgeNow, travNow2, edgeNow2, travAsPast, edgeAsPast, travAsFut, edgePostSuper] = lines.map(JSON.parse); }
  catch (e) { console.error("FAIL parse:", e.message, s.slice(0, 400)); process.exit(7); }
  const M0 = Number(process.env.M0), M1 = Number(process.env.M1), EID = Number(process.env.EID), BAD = process.env.BAD;
  const PAST = process.env.ASOF_PAST, FUT = process.env.ASOF_FUT;
  const reaches = (t, id) => !!(t.steps || []).some(st => Number(st.to_id) === id);
  const findEdge = (e, id) => (e.edges || []).find(x => Number(x.id) === id);
  const touchingLive = (e, id) => (e.edges || []).filter(x => x.from_id === id || x.to_id === id);
  const pastEdge = findEdge(edgeAsPast, EID);
  const asserts = [
    ["traverse(now, before-invalidation) reaches m1", reaches(travNow, M1)],
    ["edges?relation=parent (before-invalidation) lists edge", !!findEdge(edgeNow, EID)],
    ["traverse(now, AFTER-invalidation) excludes m1", !reaches(travNow2, M1)],
    ["edges?relation=parent (AFTER-invalidation) excludes edge", !findEdge(edgeNow2, EID)],
    [`traverse?asOf=past (${PAST}) reaches m1 (edge was live at asOf)`, reaches(travAsPast, M1)],
    [`edges?relation=parent&asOf=past includes edge`, !!pastEdge],
    ["edges?asOf=past edge carries valid_until (confirms it was invalidated)", pastEdge && pastEdge.valid_until !== null],
    ["traverse?asOf=future EXCLUDES m1 (asOf filters, not always-inclusive)", !reaches(travAsFut, M1)],
    ["traverse?asOf echoes the asOf param", travAsPast.asOf === PAST],
    ["edges?asOf echoes the asOf param", edgeAsPast.asOf === PAST],
    [`bad ISO asOf → 400 (got ${BAD})`, BAD === "400"],
    ["supersede→cascade: no live parent edge touches superseded m1", touchingLive(edgePostSuper, M1).length === 0],
  ];
  let bad = 0;
  for (const [name, cond] of asserts) { if (cond) console.log("  PASS: " + name); else { console.log("  FAIL: " + name); bad++; } }
  if (bad) { console.error("edgeNow:", JSON.stringify(edgeNow).slice(0,500)); console.error("edgeNow2:", JSON.stringify(edgeNow2).slice(0,500)); console.error("edgeAsPast:", JSON.stringify(edgeAsPast).slice(0,500)); console.error("travAsPast:", JSON.stringify(travAsPast).slice(0,500)); console.error("travAsFut:", JSON.stringify(travAsFut).slice(0,500)); console.error("edgePostSuper:", JSON.stringify(edgePostSuper).slice(0,500)); process.exit(8); }
  console.log("OK: E9 live — traverse/edges?asOf + 400 gate + supersede cascade all hold");
});
'
RC=$?
[ $RC -ne 0 ] && { echo "FAIL: live asserting (rc=$RC)"; exit 9; }
echo "═══ E9 LIVE wiring: PASS ═══"
exit 0
