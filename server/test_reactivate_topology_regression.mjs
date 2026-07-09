// test_reactivate_topology_regression.mjs — regression for the reactivateMemory edge-reopen bug.
//
// Claude's audit (confirmed against the real store): reactivateMemory (memory-store.mjs ln1078-1089)
// flips status archived->active, re-inserts the vector, deletes the archive_index row — but NEVER
// touches memory_edges. The only writers of valid_until all set it to datetime('now')
// (invalidateEdge ln551, cascadeInvalidateEdges ln556); nothing sets valid_until back to NULL. So
// once an archived memory's edges were cascade-killed by the archive path (commit 120c1b1 added that
// cascade to FIX the archive-bypass invariant), a later reactivate restores the row but its graph
// reach stays permanently dead — traverseMemoryGraph(id) == [] forever. The cascade fix EXPOSED this:
// pre-cascade the edges never died on archive, so reactivate "accidentally" kept topology. Now it
// doesn't. Genuine regression path.
//
// Fix direction (c): an invalidation_reason column distinguishes cascade-archive (reversible — the
// mem can come back) from cascade-supersede / manual (irreversible — topology stays dead).
// reactivateMemory reopens ONLY cascade-archive edges, and only toward a partner that is itself
// active (so a reactivated mem doesn't drag a still-archived partner back into the live graph).
// Pre-existing dead edges (invalidation_reason NULL — invalidated before the column existed) are
// NOT reopened: they were dead before this feature and reopening them would be incorrect.
//
// Phase 1 — the core bug: A archived->reactivated retains ZERO graph reach to its active partner B.
// Phase 2 — safety: a manually-invalidated edge A->D stays dead across A's archive->reactivate.
//
// Ownership rule: every fix ships a permanent regression test. Run BEFORE the fix: Phase 1
// `traverseAfterReact.length === 1` FAILS (bug). Run AFTER the reactivate-reopen fix: it PASSES.
//
// Run (WSL Ubuntu-24.04, better-sqlite3+sqlite-vec native required):
//   EMBEDDING_DIM=256 ENABLE_EMBEDDING=false node test_reactivate_topology_regression.mjs
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.MEMORY_DB_DIR) {
  process.env.MEMORY_DB_DIR = path.join(os.tmpdir(), `reacttop-${Math.floor(Math.random() * 1e9)}`);
}
process.env.EMBEDDING_DIM ||= '256';
process.env.ENABLE_EMBEDDING = 'false';
process.env.LOG_LEVEL = 'error';

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  PASS: ${name}`); }
  else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

const { storeMemory, storeEdge, archiveStaleMemories, reactivateMemory, traverseMemoryGraph,
  invalidateEdgeById, getEdgesFromMemory, db } = await import('./memory-store.mjs');
const { isVecReady } = await import('./vector-index.mjs');

let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('vec table ready (migration ran)', vecReady);
const fk = db.pragma('foreign_keys', { simple: true });
check('runtime PRAGMA foreign_keys === 1', fk === 1, `got ${fk}`);

const emb = () => { const v = new Float32Array(parseInt(process.env.EMBEDDING_DIM)); v[0] = 1.0; return v; };
const edgeRow = (fromId, toId) =>
  db.prepare('SELECT valid_until, invalidation_reason FROM memory_edges WHERE from_id=? AND to_id=?').get(fromId, toId);

// ───────────── Phase 1: reactivate must restore graph reach ─────────────
console.log('── Phase 1: reactivate reopens cascade-archive edge to an active partner ──');
const aId = storeMemory({
  type: 'fact', text: 'facet A: archived then reactivated', session_id: 'reacttop', metadata: {},
  embedding: emb(), importance: 0.6, entity: 'entA', cone_layer: 1, intent_type: 'fact',
});
const bId = storeMemory({
  type: 'fact', text: 'facet B: always active partner', session_id: 'reacttop', metadata: {},
  embedding: emb(), importance: 0.9, entity: 'entB', cone_layer: 1, intent_type: 'fact',
});
check('seeded L1 A + B', typeof aId === 'number' && typeof bId === 'number', `a=${aId} b=${bId}`);
const edgeId = storeEdge({ from_id: aId, to_id: bId, relation: 'related', strength: 0.8 });
check('stored live edge A->B', typeof edgeId === 'number' && edgeId > 0, `id=${edgeId}`);
check('A->B edge live (valid_until NULL) before archive', edgeRow(aId, bId)?.valid_until === null);

check('traverseMemoryGraph(A) reaches B before archive', traverseMemoryGraph(aId, 2, 10, 'outgoing', '', null).length === 1);

// Backdate A past the 90-day stale threshold; B stays fresh (active). recall_count defaults 0.
db.prepare("UPDATE memories SET created_at = datetime('now','-91 days') WHERE id = ?").run(aId);
const archived = archiveStaleMemories();
check('archiveStaleMemories archived >= 1 (A)', archived >= 1, `n=${archived}`);
check('A is archived', db.prepare('SELECT status FROM memories WHERE id=?').get(aId)?.status === 'archived');
const edgeAfterArchive = edgeRow(aId, bId);
check('A->B edge INVALIDATED on archive (cascade-archive)', edgeAfterArchive?.valid_until !== null, `v=${edgeAfterArchive?.valid_until}`);

// Reactivate A — restoring its row, vector, archive_index. The graph reach should ALSO come back.
const restored = reactivateMemory(aId);
check('reactivateMemory(A) restored A to active', restored && restored.status === 'active', `status=${restored?.status}`);

const edgeAfterReact = edgeRow(aId, bId);
check('A->B edge REOPENED on reactivate (valid_until NULL)', edgeAfterReact?.valid_until === null, `v=${edgeAfterReact?.valid_until}`);

const traverseAfterReact = traverseMemoryGraph(aId, 2, 10, 'outgoing', '', null);
check('★ traverseMemoryGraph(A) reaches B again after reactivate (topology restored)', traverseAfterReact.length === 1, `len=${traverseAfterReact.length}`);

// ───────────── Phase 2: manual edges must NOT be reopened by reactivate ─────────────
console.log('\n── Phase 2: a manually-invalidated edge stays dead across archive->reactivate ──');
const cId = storeMemory({
  type: 'fact', text: 'facet C: has a manual-invalidated edge', session_id: 'reacttop', metadata: {},
  embedding: emb(), importance: 0.4, entity: 'entC', cone_layer: 1, intent_type: 'fact',
});
const dId = storeMemory({
  type: 'fact', text: 'facet D: always active, edge manually killed', session_id: 'reacttop', metadata: {},
  embedding: emb(), importance: 0.9, entity: 'entD', cone_layer: 1, intent_type: 'fact',
});
const manEdge = storeEdge({ from_id: cId, to_id: dId, relation: 'manual', strength: 0.5 });
check('seeded L1 C + D with live edge', typeof manEdge === 'number' && manEdge > 0);
invalidateEdgeById(manEdge);
check('C->D edge manually invalidated', edgeRow(cId, dId)?.valid_until !== null);

// Now archive C (its OTHER live edges would cascade — but C only has the already-dead C->D, which the
// valid_until-IS-NULL guard skips; so nothing else gets invalidated) then reactivate C. The manual
// C->D edge must STAY dead: reactivate only reopens cascade-archive edges, never manual ones.
db.prepare("UPDATE memories SET created_at = datetime('now','-91 days') WHERE id = ?").run(cId);
archiveStaleMemories();
check('C is archived', db.prepare('SELECT status FROM memories WHERE id=?').get(cId)?.status === 'archived');
reactivateMemory(cId);
check('C reactivated to active', db.prepare('SELECT status FROM memories WHERE id=?').get(cId)?.status === 'active');
const manEdgeAfter = edgeRow(cId, dId);
check('manual C->D edge stays DEAD after reactivate (reason respected)', manEdgeAfter?.valid_until !== null, `v=${manEdgeAfter?.valid_until}`);
check('traverseMemoryGraph(C) empty (no live path)', traverseMemoryGraph(cId, 2, 10, 'outgoing', '', null).length === 0);

// Cleanup
try { db.close(); } catch {}
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(path.join(process.env.MEMORY_DB_DIR, `hermes-memory.db${ext}`)); } catch {}
}
try { fs.rmdirSync(process.env.MEMORY_DB_DIR, { recursive: true }); } catch {}

console.log(`\n═══ reactivate-topology regression: ${PASS} pass, ${FAIL} fail ═══`);
process.exitCode = FAIL > 0 ? 1 : 0;
