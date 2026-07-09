// test_archive_cascade_regression.mjs — regression for the E9 archive-bypass invariant.
//
// Claude's audit flagged that the raw-archive paths (archiveStaleMemories ln983, enforceActiveSetBound
// ln1032) flip status='archived' via a bulk UPDATE that BYPASSES cascadeInvalidateEdges — the only
// non-active path that does so (updateMemoryStatus's non-active branch cascades at ln746). Because
// traverseGraph JOINs memory_edges ONLY and never JOINs memories.status, a live edge
// (valid_until IS NULL) anchored to an archived memory keeps surfacing in now AND asOf traversal,
// silently breaking the E9 bi-temporal invariant the memory-pipeline.mjs supersede branch relies on.
//
// Fix: both archive loops now call cascadeInvalidateEdges.run(r.id, r.id) in the same TX as the
// status flip + vector prune, mirroring updateMemoryStatus. This test pins it on the REAL store:
//   Phase A — archiveStaleMemories:  stale (>90d, recall 0) L1 A  has edge A->B live;
//     after archive → A.status='archived', edge valid_until NOT NULL, traverseMemoryGraph(A) == [].
//   Phase B — enforceActiveSetBound: surplus L1 demoted,  its live edge cascade + traverse dead.
//
// Ownership rule: every fix ships a permanent regression test. Reverting the cascade additions
// makes `edge valid_until NOT NULL` and `traverse == []` fail (edge stays live).
//
// Run (WSL Ubuntu-24.04, better-sqlite3+sqlite-vec native required):
//   EMBEDDING_DIM=256 ENABLE_EMBEDDING=false node test_archive_cascade_regression.mjs
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.MEMORY_DB_DIR) {
  process.env.MEMORY_DB_DIR = path.join(os.tmpdir(), `archcas-${Math.floor(Math.random() * 1e9)}`);
}
process.env.EMBEDDING_DIM ||= '256';
process.env.ENABLE_EMBEDDING = 'false';
process.env.LOG_LEVEL = 'error';

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  PASS: ${name}`); }
  else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

const { storeMemory, storeEdge, archiveStaleMemories, enforceActiveSetBound, traverseMemoryGraph, db } =
  await import('./memory-store.mjs');
const { isVecReady } = await import('./vector-index.mjs');

let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('vec table ready (migration ran)', vecReady);
const fk = db.pragma('foreign_keys', { simple: true });
check('runtime PRAGMA foreign_keys === 1', fk === 1, `got ${fk}`);

const emb = () => { const v = new Float32Array(parseInt(process.env.EMBEDDING_DIM)); v[0] = 1.0; return v; };
const edgeRow = (fromId, toId) =>
  db.prepare('SELECT valid_until FROM memory_edges WHERE from_id=? AND to_id=?').get(fromId, toId);

// ───────────── Phase A: archiveStaleMemories cascade ─────────────
console.log('── Phase A: archiveStaleMemories — stale memory + live edge ──');
const aId = storeMemory({
  type: 'fact', text: 'stale facet A (will archive)', session_id: 'archcas', metadata: {},
  embedding: emb(), importance: 0.5, entity: 'entA', cone_layer: 1, intent_type: 'fact',
});
const bId = storeMemory({
  type: 'fact', text: 'fresh facet B (stays active)', session_id: 'archcas', metadata: {},
  embedding: emb(), importance: 0.9, entity: 'entB', cone_layer: 1, intent_type: 'fact',
});
check('seeded L1 A + B', typeof aId === 'number' && typeof bId === 'number', `a=${aId} b=${bId}`);
// Backdate A past the 90-day archive threshold; recall_count defaults 0 (archive gate needs 0).
db.prepare("UPDATE memories SET created_at = datetime('now','-91 days') WHERE id = ?").run(aId);
storeEdge({ from_id: aId, to_id: bId, relation: 'related', strength: 0.8 });

const edgeBefore = edgeRow(aId, bId);
check('A->B edge live before archive (valid_until NULL)', edgeBefore && edgeBefore.valid_until === null, `v=${edgeBefore?.valid_until}`);

const archivedCount = archiveStaleMemories();
check('archiveStaleMemories archived >= 1 row', archivedCount >= 1, `n=${archivedCount}`);

const aRow = db.prepare('SELECT status FROM memories WHERE id=?').get(aId);
check('A flipped to status=archived', aRow?.status === 'archived', `status=${aRow?.status}`);

const edgeAfter = edgeRow(aId, bId);
check('A->B edge INVALIDATED on archive (valid_until NOT NULL) — FK-style cascade', edgeAfter && edgeAfter.valid_until !== null, `v=${edgeAfter?.valid_until}`);

const travA = traverseMemoryGraph(aId, 2, 10, 'outgoing', '', null);
check('traverseMemoryGraph(A) returns no live path (archived mem no longer reaches B)', Array.isArray(travA) && travA.length === 0, `len=${travA?.length}`);

// ───────────── Phase B: enforceActiveSetBound cascade ─────────────
console.log('\n── Phase B: enforceActiveSetBound — surplus demotion + live edge ──');
const cId = storeMemory({
  type: 'fact', text: 'surplus facet C (lowest importance, gets demoted)', session_id: 'archcas', metadata: {},
  embedding: emb(), importance: 0.3, entity: 'entC', cone_layer: 1, intent_type: 'fact',
});
const dId = storeMemory({
  type: 'fact', text: 'keeper facet D (high importance, stays active)', session_id: 'archcas', metadata: {},
  embedding: emb(), importance: 0.95, entity: 'entD', cone_layer: 1, intent_type: 'fact',
});
check('seeded L1 C + D', typeof cId === 'number' && typeof dId === 'number', `c=${cId} d=${dId}`);
storeEdge({ from_id: cId, to_id: dId, relation: 'related', strength: 0.7 });
const edgeCBefore = edgeRow(cId, dId);
check('C->D edge live before bound (valid_until NULL)', edgeCBefore && edgeCBefore.valid_until === null, `v=${edgeCBefore?.valid_until}`);

// Force a tight active-set cap so C (lowest importance) is demoted above the surplus line.
const { demoted } = enforceActiveSetBound({ maxActive: 1 });
check('enforceActiveSetBound demoted >= 1 row', demoted >= 1, `n=${demoted}`);

const cRow = db.prepare('SELECT status FROM memories WHERE id=?').get(cId);
check('C demoted to status=archived (lowest importance)', cRow?.status === 'archived', `status=${cRow?.status}`);

const edgeCAfter = edgeRow(cId, dId);
check('C->D edge INVALIDATED on demotion (valid_until NOT NULL) — cascade runs on bound path too', edgeCAfter && edgeCAfter.valid_until !== null, `v=${edgeCAfter?.valid_until}`);

const travC = traverseMemoryGraph(cId, 2, 10, 'outgoing', '', null);
check('traverseMemoryGraph(C) returns no live path (demoted mem no longer reaches D)', Array.isArray(travC) && travC.length === 0, `len=${travC?.length}`);

// Cleanup
try { db.close(); } catch {}
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(path.join(process.env.MEMORY_DB_DIR, `hermes-memory.db${ext}`)); } catch {}
}
try { fs.rmdirSync(process.env.MEMORY_DB_DIR, { recursive: true }); } catch {}

console.log(`\n═══ archive-cascade regression: ${PASS} pass, ${FAIL} fail ═══`);
process.exitCode = FAIL > 0 ? 1 : 0;
