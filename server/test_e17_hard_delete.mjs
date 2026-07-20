// E17 FK-safe hard-delete — PERMANENT regression test.
//
// hardDeleteMemory (memory-store.mjs) is the merge-then-delete-original primitive. The naive
// delete (deleteMemory / removeById = `DELETE FROM memories WHERE id=?`) raises
// `FOREIGN KEY constraint failed` under PRAGMA foreign_keys=ON (L36) whenever a SURVIVING row
// still references the doomed id: a sibling's superseded_by, a memory's compressed_from /
// contradiction_pair_id, a live memory_edges.from_id/to_id, or a citation_log.memory_id. A Brain2
// merge-then-delete is NOT self-contained (a sibling can still point at an absorbed original), so
// hardDeleteMemory must clean every inbound RESTRICT FK in ONE transaction before the DELETE.
//
// This fixture asserts, against the REAL sqlite store:
//   S2  bare row (no inbound refs) deletes cleanly.
//   S3  a sibling whose superseded_by = deleted id -> sibling survives, its superseded_by NULLified.
//   S4  touching memory_edges + citation_log rows -> removed, no dangling RESTRICT.
//   S5  E6 cardinal guard: L0 (episode) and L3 (persona) NEVER hard-deletable (rejects the call,
//       row survives) — the safety net against a Brain2 merge targeting a cardinal row.
//   S6  not-found + bad-args (0, negative, null, empty) rejected without touching the DB.
//   S7  compressed_from self-FK -> survivor's compressed_from NULLified.
//   S8  contradiction_pair_id self-FK -> survivor's contradiction_pair_id NULLified.
//   S9  ON DELETE CASCADE child (memory_archive_index) auto-removed inside the same tx.
//
// Pure store ops (no LLM, no mock-llm). ENABLE_EMBEDDING=false — no vectors stored, so the
// post-commit deleteVec/removeFromTurboVec arms are no-ops; this isolates FK + cardinal behavior.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e17.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e17_hard_delete.mjs
import { storeMemory, db, storeEdge, updateMemoryStatus, hardDeleteMemory } from './memory-store.mjs';
import { isVecReady } from './vector-index.mjs';

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(` PASS: ${name}`); }
  else { FAIL++; console.log(` FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

// Wait for the vec0 virtual table (initVectorIndex is fire-and-forget at module boot). Even with
// ENABLE_EMBEDDING=false the table is created; hardDeleteMemory's vec-drop arm must not throw.
let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('S0 vec table ready', vecReady);
// hardDeleteMemory is exported (the primitive under test).
check('S0 hardDeleteMemory exported', typeof hardDeleteMemory === 'function');

const getRow    = db.prepare('SELECT id, status, superseded_by, compressed_from, contradiction_pair_id, cone_layer FROM memories WHERE id = ?');
const memExists = db.prepare('SELECT 1 AS x FROM memories WHERE id = ?');
const edgeCount = db.prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE from_id = ? OR to_id = ?');
const citeCount = db.prepare('SELECT COUNT(*) AS c FROM citation_log WHERE memory_id = ?');
const archCount = db.prepare('SELECT COUNT(*) AS c FROM memory_archive_index WHERE archived_id = ?');

function mk(layer, text, { importance = 0.2, entity = 'e17' } = {}) {
  return storeMemory({ session_id: 'e17-test', type: 'fact', text, metadata: {}, cone_layer: layer, importance, entity });
}

if (vecReady) {
  // ── S2: bare row, no inbound refs ─────────────────────────────────────────────────────
  console.log('\n--- S2 bare row deletes ---');
  const s2 = mk(1, 'plain L1 no inbound refs');
  const r2 = hardDeleteMemory(s2);
  check('S2 returns ok', r2.ok === true, JSON.stringify(r2));
  check('S2 row gone', !memExists.get(s2));

  // ── S3: sibling superseded_by (the realistic merge-then-delete FK case) ────────────────
  // child was superseded BY parent (parent newer canonical). We hard-delete parent. child must
  // SURVIVE with superseded_by NULLified (no dangling FK, child stays a 'superseded' row).
  console.log('\n--- S3 sibling superseded_by FK-safe ---');
  const parent = mk(1, 'parent canonical L1');
  const child = mk(1, 'child superseded-by parent');
  updateMemoryStatus(child, 'superseded', parent); // child.superseded_by = parent
  check('S3 child.superseded_by = parent', getRow.get(child)?.superseded_by === parent, `got ${getRow.get(child)?.superseded_by}`);
  const r3 = hardDeleteMemory(parent);
  check('S3 returns ok (FK-safe under inbound superseded_by)', r3.ok === true, JSON.stringify(r3));
  check('S3 parent gone', !memExists.get(parent));
  check('S3 child survives', !!memExists.get(child));
  check('S3 child.superseded_by nullified (no dangling FK)', getRow.get(child)?.superseded_by === null, `got ${getRow.get(child)?.superseded_by}`);

  // ── S4: touching edge + citation (RESTRICT FKs removed) ───────────────────────────────
  console.log('\n--- S4 edges + citation RESTRICT FKs cleaned ---');
  const s4a = mk(1, 'row with an edge endpoint');
  const s4b = mk(1, 'row with a citation');
  storeEdge({ from_id: s4a, to_id: s4b, relation: 'related_to', strength: 0.8 });
  db.prepare('INSERT INTO citation_log (memory_id, session_id, context) VALUES (?,?,?)').run(s4b, 'e17', 'cited in turn 1');
  check('S4 edge created', edgeCount.get(s4a, s4a).c === 1);
  check('S4 cite created', citeCount.get(s4b).c === 1);
  // hard-delete s4a — the edge from_id=s4a is anchored to a doomed row -> must be removed.
  hardDeleteMemory(s4a);
  check('S4a row gone', !memExists.get(s4a));
  check('S4a edge removed (no dangling from_id to dead row)', edgeCount.get(s4a, s4a).c === 0);
  check('S4b survives (edge-to side)', !!memExists.get(s4b));
  check('S4b no touching edges after partner delete', edgeCount.get(s4b, s4b).c === 0);
  // hard-delete s4b — its citation_log row is a RESTRICT FK -> must be removed (not left dangling).
  hardDeleteMemory(s4b);
  check('S4b row gone', !memExists.get(s4b));
  check('S4b citation removed (RESTRICT FK cleaned)', citeCount.get(s4b).c === 0);

  // ── S5: E6 cardinal guard — L0 / L3 never hard-deletable ───────────────────────────────
  console.log('\n--- S5 cardinal guard (L0/L3 protected) ---');
  const l0 = mk(0, 'raw episode must survive hard-delete');
  const l3 = mk(3, 'persona must survive hard-delete');
  const rl0 = hardDeleteMemory(l0);
  check('S5 L0 rejected cardinal-protected', rl0.ok === false && rl0.reason === 'cardinal-protected', JSON.stringify(rl0));
  check('S5 L0 survives', !!memExists.get(l0));
  const rl3 = hardDeleteMemory(l3);
  check('S5 L3 rejected cardinal-protected', rl3.ok === false && rl3.reason === 'cardinal-protected', JSON.stringify(rl3));
  check('S5 L3 survives', !!memExists.get(l3));

  // ── S6: not-found + bad-args validation ─────────────────────────────────────────────────
  console.log('\n--- S6 bad-args + not-found ---');
  const rnf = hardDeleteMemory(999999999);
  check('S6 not-found rejected', rnf.ok === false && rnf.reason === 'not-found', JSON.stringify(rnf));
  check('S6 id=0 bad-args', hardDeleteMemory(0).reason === 'bad-args');
  check('S6 negative bad-args', hardDeleteMemory(-5).reason === 'bad-args');
  check('S6 null bad-args', hardDeleteMemory(null).reason === 'bad-args');
  check('S6 empty string bad-args', hardDeleteMemory('').reason === 'bad-args');

  // ── S7: compressed_from self-FK ────────────────────────────────────────────────────────
  console.log('\n--- S7 compressed_from self-FK ---');
  const cp_parent = mk(1, 'compressed parent (source)');
  const cp_child = mk(1, 'compressed child');
  db.prepare('UPDATE memories SET compression_level = 1, compressed_from = ? WHERE id = ?').run(cp_parent, cp_child);
  check('S7 child.compressed_from = parent', getRow.get(cp_child)?.compressed_from === cp_parent, `got ${getRow.get(cp_child)?.compressed_from}`);
  hardDeleteMemory(cp_parent);
  check('S7 parent gone', !memExists.get(cp_parent));
  check('S7 child survives', !!memExists.get(cp_child));
  check('S7 child.compressed_from nullified', getRow.get(cp_child)?.compressed_from === null, `got ${getRow.get(cp_child)?.compressed_from}`);

  // ── S8: contradiction_pair_id self-FK ──────────────────────────────────────────────────
  console.log('\n--- S8 contradiction_pair_id self-FK ---');
  const ca = mk(1, 'contradiction A');
  const cb = mk(1, 'contradiction B');
  db.prepare("UPDATE memories SET contradiction_pair_id = ?, status = 'contradicted' WHERE id = ?").run(cb, ca);
  db.prepare("UPDATE memories SET contradiction_pair_id = ?, status = 'contradicted' WHERE id = ?").run(ca, cb);
  check('S8 ca.contradiction_pair_id = cb', getRow.get(ca)?.contradiction_pair_id === cb, `got ${getRow.get(ca)?.contradiction_pair_id}`);
  hardDeleteMemory(cb);
  check('S8 cb gone', !memExists.get(cb));
  check('S8 ca survives', !!memExists.get(ca));
  check('S8 ca.contradiction_pair_id nullified', getRow.get(ca)?.contradiction_pair_id === null, `got ${getRow.get(ca)?.contradiction_pair_id}`);

  // ── S9: ON DELETE CASCADE child (memory_archive_index) cleaned in the same tx ──────────
  // If the cascade did not fire inside our tx, either the DELETE would RESTRICT-throw (FK fail) or
  // the archive_index row would linger. Both are failures; a clean 0 proves cascade worked.
  console.log('\n--- S9 ON DELETE CASCADE (memory_archive_index) ---');
  const s9 = mk(2, 'row with an archive_index child');
  db.prepare("INSERT INTO memory_archive_index (archived_id, cone_layer, archived_at) VALUES (?, 2, datetime('now'))").run(s9);
  check('S9 archive_index seeded', archCount.get(s9).c === 1);
  hardDeleteMemory(s9);
  check('S9 row gone', !memExists.get(s9));
  check('S9 archive_index cascaded away (RESTRICT would have thrown)', archCount.get(s9).c === 0);
}

console.log('\n========================================');
console.log(`E17 hard-delete test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
