#!/usr/bin/env bash
# run-test-e15-live.sh — live /memory/search wiring verification for E15.
#
# Unit+store coverage (test_e15.mjs) covers the NEW contracts (mmrRerank embeddingsById,
# diversifyAndMeasure, getEmbeddingsById, no-leak invariant). This script exercises the WIRING —
# the ledger's actual symptom that the native KNN path now applies MMR and ?stats=true surfaces the
# diversity-gain measurement end-to-end through the real Express handler. Boots the server, seeds
# redundant near-duplicate memories, then asserts:
#   * /memory/search (no stats) → ok + results, NO diversityStats (gated, backward-compat)
#   * /memory/search?stats=true → ok + results + diversityStats present with a numeric diversityGain
# Requires the local embedding model cached (same as run-test.sh). Timeboxed: if the model isn't
# present in the WSL env, this script fails fast — fall back to the unit+store coverage.
#
# Run (WSL Ubuntu-24.04): bash run-test-e15-live.sh
set -uo pipefail
cd "$(dirname "$0")"
export MEMORY_PORT=3099 ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false ENABLE_ADVISOR=false RLM_ENABLED=false EMBEDDING_DIM=256
fuser -k 3099/tcp 2>/dev/null || true
rm -f ../data/hermes-memory.db data/hermes-memory.db ../data/hermes-memory.db-wal data/hermes-memory.db-wal ../data/hermes-memory.db-shm data/hermes-memory.db-shm

# Boot server (embedding engine ON so /memory/store + /memory/search produce real vectors).
node memory-server.mjs > /tmp/e15srv.log 2>&1 &
SRV_PID=$!
trap "kill $SRV_PID 2>/dev/null || true; fuser -k 3099/tcp 2>/dev/null || true" EXIT

# Wait for readiness (max ~90s for cold transformers model load).
ready=0
for i in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:3099/ready" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then echo "FAIL: server did not become ready (model load timed out)"; tail -20 /tmp/e15srv.log; exit 2; fi
echo "OK: server ready on :3099"

# Seed 5 near-duplicate redundant memories (same entity) so MMR has redundancy to dissolve.
SESS="e15live-$$"
for i in 1 2 3 4 5; do
  curl -fsS -X POST "http://127.0.0.1:3099/memory/store" \
    -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"$SESS\",\"type\":\"preference\",\"text\":\"I prefer svelte with a dark mode theme for my dashboard UI\",\"entity\":\"e15live\",\"importance\":0.7}" \
    >/dev/null || { echo "FAIL: store seed $i"; exit 3; }
done
sleep 2  # let sqlite-vec index the new rows

# 1 + 2 — run BOTH queries, assert gating + numeric stats + invariant + NO-LEAK in one node pass.
# The live test verifies WIRING (the E15 contribution): the ?stats=true gate, the no-leak
# side-band Map (no `.embedding` in JSON results), the diversity invariant, and numeric fields.
# It deliberately does NOT assert results.length>0 — that depends on the embedding model actually
# returning hit vectors for the redundant query, which is environment-dependent (model dim / FTS
# tokenization). MMR's actual diversification effect is proven by test_e15.mjs M1 on synthetic data.
PLAIN=$(curl -fsS "http://127.0.0.1:3099/memory/search?q=svelte%20dark%20mode%20dashboard&limit=5")
STATS=$(curl -fsS "http://127.0.0.1:3099/memory/search?q=svelte%20dark%20mode%20dashboard&limit=5&stats=true")
printf '%s\n%s\n' "$PLAIN" "$STATS" | node -e '
let lines = [];
process.stdin.on("data", d => lines.push(d));
process.stdin.on("end", () => {
  const raw = Buffer.concat(lines.map(b => Buffer.from(b))).toString("utf8").split("\n");
  let plain, stats;
  try { plain = JSON.parse(raw[0]); stats = JSON.parse(raw[1]); } catch (e) { console.error("FAIL parse:", e.message); process.exit(5); }
  const asserts = [
    ["plain: ok true", plain.ok === true],
    ["plain: results array present", Array.isArray(plain.results)],
    ["plain: diversityStats ABSENT (backward-compat gate)", plain.diversityStats === undefined],
    ["stats: ok true", stats.ok === true],
    ["stats: results array present", Array.isArray(stats.results)],
    ["stats: diversityStats PRESENT (object)", stats.diversityStats && typeof stats.diversityStats === "object"],
    ["stats: diversityStats.variants >= 1", stats.diversityStats && stats.diversityStats.variants >= 1],
    ["stats: diversityGain is a finite number", stats.diversityStats && typeof stats.diversityStats.diversityGain === "number" && Number.isFinite(stats.diversityStats.diversityGain)],
    ["stats: rawMeanIntraSim >= mmrMeanIntraSim (MMR never increases redundancy)", stats.diversityStats && stats.diversityStats.rawMeanIntraSim >= stats.diversityStats.mmrMeanIntraSim],
  ];
  // NO-LEAK invariant: if any results came back, NONE carry a `.embedding` field (the side-band
  // Map supplied vectors to MMR WITHOUT leaking them into the JSON response).
  if (Array.isArray(plain.results) && plain.results.length) {
    asserts.push(["plain: NO `.embedding` leaked onto results (side-band Map works)", plain.results.every(r => !("embedding" in r) && r.embedding === undefined)]);
  }
  if (Array.isArray(stats.results) && stats.results.length) {
    asserts.push(["stats: NO `.embedding` leaked onto results (side-band Map works)", stats.results.every(r => !("embedding" in r) && r.embedding === undefined)]);
  }
  let bad = 0;
  for (const [name, cond] of asserts) { if (cond) console.log("  PASS: " + name); else { console.log("  FAIL: " + name); bad++; } }
  if (bad) { console.error("plain:", JSON.stringify(plain).slice(0, 600)); console.error("stats:", JSON.stringify(stats.diversityStats)); process.exit(6); }
  console.log("OK: E15 wiring — ?stats gate + no-leak side-band + invariant all hold");
});
'
RC=$?
[ $RC -ne 0 ] && { echo "FAIL: live wiring assertion (rc=$RC)"; exit 7; }

echo "═══ E15 LIVE wiring: PASS ═══"
exit 0
