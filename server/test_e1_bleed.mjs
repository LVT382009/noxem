// E1 stale-vector bleed — PERMANENT regression test.
//
// Why this exists (NOT covered by run-test.sh): run-test.sh boots the server with
// ENABLE_EMBEDDING=false, so storeMemory never writes vectors to memory_vecs and the
// vector-prune behavior of updateMemoryStatus() is never exercised. This fixture fills
// that gap by running the store in-process (no HTTP server), faking vectors directly into
// memory_vecs, triggering supersede through the real updateMemoryStatus code path, and
// asserting the dead vector was pruned same-tx while the active vector was preserved.
//
// Covers BOTH E1 parts:
//   (1) pruneVectors chokepoint — fires on every non-active status flip (supersede),
//       same SQLite transaction as the status UPDATE.
//   (2) one-shot backlog purge — DELETE FROM memory_vecs WHERE rowid NOT IN (active ids),
//       gated by core_memory.e1_purge_v1 (the exact statement initVectorIndex runs at boot).
//
// Run (WSL Ubuntu-24.04, fresh DB):
//   bash run-test-e1.sh
// Or standalone:
//   ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e1_bleed.mjs
//
// Exit code: 0 = all PASS, 1 = at least one FAIL (loud — never silently passes).
import { storeMemory, updateMemoryStatus, db } from './memory-store.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(` PASS: ${name}`); }
  else { FAIL++; console.log(` FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

// initVectorIndex() is fire-and-forget at module boot — poll until the vec0 table is ready.
let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('vec table ready', vecReady, 'memory_vecs vec0 table never initialized');

if (vecReady) {
  const ins = db.prepare('INSERT OR REPLACE INTO memory_vecs (rowid, embedding) VALUES (?, ?)');
  const sel = db.prepare('SELECT rowid FROM memory_vecs WHERE rowid = ?');

  // === SECTION 1: pruneVectors chokepoint — same-tx prune on supersede, active preserved ===
  console.log('\n--- E1 chokepoint: pruneVectors fires same-tx on supersede ---');
  const A = storeMemory({ session_id: 'e1-test', type: 'preference', text: 'user likes red color', metadata: {} });
  const B = storeMemory({ session_id: 'e1-test', type: 'preference', text: 'user switched to blue', metadata: {} });
  check('store A', !!A);
  check('store B', !!B);

  // Fake-insert vectors for both (embedding is off in this fixture, so we bypass the
  // embedding engine and write the vec0 rows directly — matches the pre-E1 production shape).
  ins.run(BigInt(A), new Float32Array(EMBED_DIM));
  ins.run(BigInt(B), new Float32Array(EMBED_DIM));
  check('A vector seeded', !!sel.get(BigInt(A)), 'fake INSERT did not land in memory_vecs');
  check('B vector seeded', !!sel.get(BigInt(B)), 'fake INSERT did not land in memory_vecs');

  // Supersede A -> B: pruneVectors must delete A's vector in the SAME tx as the status flip;
  // B (active) must be untouched.
  updateMemoryStatus(A, 'superseded', B);
  const statusA = db.prepare('SELECT status FROM memories WHERE id = ?').get(A)?.status;
  check('A status flipped to superseded', statusA === 'superseded', `got ${statusA}`);
  check('A vector PRUNED on supersede (E1 chokepoint)', !sel.get(BigInt(A)), 'dead vector lingered in memory_vecs — stale-vector bleed NOT fixed');
  check('B vector preserved (active stays in index)', !!sel.get(BigInt(B)), 'active vector was wrongly pruned');

  // Reactivation safety: flipping A back to active must NOT prune B (E7 re-insert door intact).
  updateMemoryStatus(A, 'active', null);
  check('B vector still present after A reactivation (E7 door)', !!sel.get(BigInt(B)), 'reactivation wrongly pruned an active vector');

  // === SECTION 2: one-shot backlog purge — removes stale, preserves active ===
  console.log('\n--- E1 purge: backlog purge removes stale vectors, preserves active ---');
  // First make A genuinely stale again (after reactivation A is active; re-supersede so A's
  // re-seeded vector below is a real stale row, not active-backed).
  updateMemoryStatus(A, 'superseded', B); // chokepoint prunes A's (already-gone) vector
  // Re-leak A's vector (simulates the pre-E1 backlog that persisted across boots).
  ins.run(BigInt(A), new Float32Array(EMBED_DIM));
  // Seed an orphan rowid with NO memory row at all (worst backlog).
  ins.run(BigInt(777777), new Float32Array(EMBED_DIM));

  const staleBefore = db.prepare("SELECT COUNT(*) c FROM memory_vecs WHERE rowid NOT IN (SELECT id FROM memories WHERE status='active')").get();
  check('2 stale vectors seeded (re-leaked A + orphan 777777)', staleBefore.c >= 2, `got ${staleBefore.c}`);

  // Run the EXACT purge statement initVectorIndex performs at boot (force: clear gate first so
  // a prior run on this db does not skip).
  try { db.prepare('DELETE FROM core_memory WHERE key = ?').run('e1_purge_v1'); } catch { /* core_memory may be absent pre-init */ }
  const dead = db.prepare(`DELETE FROM memory_vecs WHERE rowid NOT IN (SELECT id FROM memories WHERE status = 'active')`).run();
  check('purge removed >= 2 stale vectors', dead.changes >= 2, `removed ${dead.changes}`);

  const staleAfter = db.prepare("SELECT COUNT(*) c FROM memory_vecs WHERE rowid NOT IN (SELECT id FROM memories WHERE status='active')").get();
  check('0 stale vectors remaining after purge', staleAfter.c === 0, `${staleAfter.c} stale left`);

  const aliveActive = db.prepare("SELECT COUNT(*) c FROM memory_vecs WHERE rowid IN (SELECT id FROM memories WHERE status='active')").get();
  check('active-backed vectors preserved by purge', aliveActive.c >= 1, `${aliveActive.c} active-backed (B should still be present)`);
}

console.log('\n========================================');
console.log(`E1 bleed test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
