// E18 Brain2 merge-then-delete + supersede chain edge — PERMANENT regression test.
//
// mergeMemoriesHard (memory-store.mjs, E18) is the redundant-memory cleanup primitive: Brain2
// authored merge text + provenance, originals HARD-DELETED (user Option-2). The merge row mirrors
// consolidateMemories provenance (consolidated_from + source_memory_ids) but, instead of soft-
// superseding, hard-deletes the absorbed originals (FK-safe via E17 hardDeleteMemory) so the DB no
// longer carries redundant rows. Provenance rides citation_log rows citing the SURVIVING merge.
//
// Surfaces + validates, against the REAL sqlite store:
//   S2  3 active L1 same-entity rows -> merge row present, originals hard-deleted, FK inbound refs
//       (a sibling's superseded_by) nullified, touching edges removed, citation_log provenance = 3,
//       source_memory_ids column set, a row that pointed at a deleted original survives.
//   S3  low confidence (0.6) -> originals SOFT-SUPERSEDED (reversible), merge row brain2_review_pending,
//       deleted=[] — never silently finalize an uncertain merge.
//   S4  cardinal guard: merge over [L0,L1] -> rejected 'cardinal-protected', NO merge row, both survive.
//   S5  cross-entity rejected: 2 L1 rows diff entity -> 'mixed-entity', NO merge row, both survive.
//   S9  E18 supersede-chain edge: updateMemoryStatus(old,'superseded',new) + flagSupersededBy(soft)
//       each emit a live `is_newer_version_of` edge (valid_until NULL) so traverseMemoryGraph walks chains.
//   S6  bad inputs: non-array / <2 ids / dup ids / empty mergeText / not-found / non-active original.
//
// Pure store ops (no LLM). ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors (so embeddings
// store deterministically; the memory_vecs vec-prune arm is a guarded soft check).
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e18.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e18_merge.mjs
import { storeMemory, db, storeEdge, updateMemoryStatus, hardDeleteMemory, flagSupersededBy, mergeMemoriesHard } from './memory-store.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
const basis = (d) => { const v = new Float32Array(EMBED_DIM); v[d] = 1.0; return v; };

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(` PASS: ${name}`); }
  else { FAIL++; console.log(` FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('S0 vec table ready', vecReady);
check('S0 mergeMemoriesHard exported', typeof mergeMemoriesHard === 'function');

const rowById    = db.prepare('SELECT id, status, entity, cone_layer, importance, type, source_memory_ids FROM memories WHERE id = ?');
const memExists  = db.prepare('SELECT 1 AS x FROM memories WHERE id = ?');
const memCount   = db.prepare('SELECT COUNT(*) AS c FROM memories');
const edgeAny    = db.prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE from_id = ? OR to_id = ?');
const chainEdge  = db.prepare("SELECT relation, valid_until FROM memory_edges WHERE from_id = ? AND to_id = ? AND relation = 'is_newer_version_of' LIMIT 1");
const citeByMem  = db.prepare('SELECT COUNT(*) AS c FROM citation_log WHERE memory_id = ?');
const vecByRowid = db.prepare('SELECT COUNT(*) AS c FROM memory_vecs WHERE rowid = ?');

function mkL1(entity, text, { imp = 0.2, embDim = 30 } = {}) {
  return storeMemory({ session_id: 'e18', type: 'fact', text, metadata: {}, cone_layer: 1, importance: imp, entity, embedding: basis(embDim) });
}

if (vecReady) {
  // ── S2: hard merge-then-delete, FK-safe, provenance ───────────────────────────────────
  console.log('\n--- S2 hard merge-then-delete + FK-safe + provenance ---');
  const a = mkL1('e18_s2', 'original a fact', { embDim: 30 });
  const b = mkL1('e18_s2', 'original b fact', { embDim: 31 });
  const c = mkL1('e18_s2', 'original c fact', { embDim: 32 });
  const child = mkL1('e18_s2', 'child row superseded-by a', { embDim: 33 });
  storeEdge({ from_id: a, to_id: b, relation: 'related_to', strength: 0.5 });
  updateMemoryStatus(child, 'superseded', a); // child.superseded_by = a (+ chain edge child->a)
  const before = memCount.get().c;
  const r = mergeMemoriesHard([a, b, c], 'Unified scope: a+b+c canonical', { rationale: 'redundant facets', confidence: 0.9, session_id: 'e18', embedding: basis(40) });
  check('S2 returns ok', r.ok === true, JSON.stringify(r));
  check('S2 merge_id present', Number.isFinite(r.merge_id), `merge_id=${r.merge_id}`);
  check('S3 deleted exactly a,b,c', Array.isArray(r.deleted) && r.deleted.length === 3 && [a,b,c].every(x => r.deleted.includes(x)), `deleted=${JSON.stringify(r.deleted)}`);
  check('S2 merge row present + active', rowById.get(r.merge_id)?.status === 'active');
  check('S2 a gone', !memExists.get(a));
  check('S2 b gone', !memExists.get(b));
  check('S2 c gone', !memExists.get(c));
  check('S2 child survives (not a target of the merge)', !!memExists.get(child));
  check('S2 child.superseded_by nullified (a was deleted)', rowById.get(child)?.status === 'superseded' && db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(child).superseded_by === null);
  check('S2 a->b edge removed (both originals deleted)', edgeAny.get(a, a).c === 0 && edgeAny.get(b, b).c === 0);
  check('S2 chain edge child->a removed (to_id=a swept by hardDelete of a)', chainEdge.get(child, a) === undefined);
  check('S2 citation_log provenance = 3 rows citing the surviving merge', citeByMem.get(r.merge_id).c === 3, `cites=${citeByMem.get(r.merge_id).c}`);
  const sids = rowById.get(r.merge_id)?.source_memory_ids;
  check('S2 source_memory_ids column set to the originals', Array.isArray(JSON.parse(sids)) && JSON.parse(sids).length === 3 && [a,b,c].every(x => JSON.parse(sids).includes(x)), `sids=${sids}`);
  check('S2 review_pending not set for conf 0.9', r.review_pending === undefined, JSON.stringify(r));
  // E18 hard-delete prunes each original's vec (both backends) via hardDeleteMemory. Each original
  // had a stored basis vec, so each must be gone from memory_vecs after the merge.
  check('S2 vec a pruned from memory_vecs', vecByRowid.get(BigInt(a)).c === 0, `c=${vecByRowid.get(BigInt(a)).c}`);
  check('S2 vec b pruned from memory_vecs', vecByRowid.get(BigInt(b)).c === 0, `c=${vecByRowid.get(BigInt(b)).c}`);
  check('S2 vec c pruned from memory_vecs', vecByRowid.get(BigInt(c)).c === 0, `c=${vecByRowid.get(BigInt(c)).c}`);

  // ── S3: low confidence -> reversible soft-supersede, no hard delete ─────────────────────
  console.log('\n--- S3 low confidence -> reversible, review_pending ---');
  const d = mkL1('e18_s3', 'low-conf original d', { embDim: 50 });
  const e = mkL1('e18_s3', 'low-conf original e', { embDim: 51 });
  const r3 = mergeMemoriesHard([d, e], 'tentative d+e merge', { rationale: 'uncertain', confidence: 0.6, session_id: 'e18', embedding: basis(52) });
  check('S3 returns ok', r3.ok === true, JSON.stringify(r3));
  check('S3 review_pending true', r3.review_pending === true, JSON.stringify(r3));
  check('S3 deleted is empty (no hard delete)', Array.isArray(r3.deleted) && r3.deleted.length === 0, JSON.stringify(r3.deleted));
  check('S3 originals survive as superseded (reversible)', !!memExists.get(d) && !!memExists.get(e) && rowById.get(d)?.status === 'superseded' && rowById.get(e)?.status === 'superseded');
  check('S3 originals superseded_by the merge', db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(d).superseded_by === r3.merge_id);
  check('S3 merge row present with brain2_review_pending metadata', JSON.parse(rowById.get(r3.merge_id)?.source_memory_ids ?? '[]').length === 2, 'source_memory_ids set even on low-conf');
  const m3meta = db.prepare('SELECT metadata FROM memories WHERE id = ?').get(r3.merge_id).metadata;
  check('S3 merge metadata.brain2_review_pending = true', JSON.parse(m3meta).brain2_review_pending === true);

  // ── S4: cardinal guard — L0 never a merge target ──────────────────────────────────────
  console.log('\n--- S4 cardinal guard (L0/L3 never merged) ---');
  const l0 = mkL1('e18_s4', 'wrong-tier L0 will be stored at layer 0', { embDim: 60 });
  db.prepare('UPDATE memories SET cone_layer = 0 WHERE id = ?').run(l0); // force L0
  const l1 = mkL1('e18_s4', 'legit L1', { embDim: 61 });
  const beforeS4 = memCount.get().c;
  const r4 = mergeMemoriesHard([l0, l1], 'should not be created', { confidence: 0.9, embedding: basis(62) });
  check('S4 rejected cardinal-protected', r4.ok === false && r4.reason === 'cardinal-protected', JSON.stringify(r4));
  check('S4 NO merge row created', memCount.get().c === beforeS4, `count grew: ${memCount.get().c - beforeS4}`);
  check('S4 L0 survives', !!memExists.get(l0));
  check('S4 L1 survives', !!memExists.get(l1));

  // ── S5: cross-entity rejected ──────────────────────────────────────────────────────────
  console.log('\n--- S5 cross-entity rejected ---');
  const x = mkL1('e18_sX', 'entity X fact', { embDim: 70 });
  const y = mkL1('e18_sY', 'entity Y fact', { embDim: 71 });
  const beforeS5 = memCount.get().c;
  const r5 = mergeMemoriesHard([x, y], 'should not merge across entities', { confidence: 0.9, embedding: basis(72) });
  check('S5 rejected mixed-entity', r5.ok === false && r5.reason === 'mixed-entity', JSON.stringify(r5));
  check('S5 NO merge row created', memCount.get().c === beforeS5, `count grew: ${memCount.get().c - beforeS5}`);
  check('S5 X survives', !!memExists.get(x));
  check('S5 Y survives', !!memExists.get(y));

  // ── S9: E18 supersede-chain edge (hard + soft) ──────────────────────────────────────────
  console.log('\n--- S9 supersede emits is_newer_version_of chain edge ---');
  // hard path
  const o = mkL1('e18_s9', 'old version', { embDim: 80 });
  const n = mkL1('e18_s9', 'new version', { embDim: 81 });
  check('S9 no chain edge before supersede', chainEdge.get(o, n) === undefined);
  updateMemoryStatus(o, 'superseded', n);
  const ce = chainEdge.get(o, n);
  check('S9 hard supersede emits is_newer_version_of edge', !!ce && ce.relation === 'is_newer_version_of' && ce.valid_until === null, JSON.stringify(ce));
  // soft path (flagSupersededBy — status stays active)
  const f = mkL1('e18_s9b', 'soft-flagged old', { embDim: 90 });
  const g = mkL1('e18_s9b', 'soft-flagged newer', { embDim: 91 });
  check('S9 no chain edge before soft flag', chainEdge.get(f, g) === undefined);
  flagSupersededBy(f, g, { reason: 'test' });
  const ce2 = chainEdge.get(f, g);
  check('S9 soft flag emits is_newer_version_of edge (row stays active)', !!ce2 && ce2.relation === 'is_newer_version_of' && ce2.valid_until === null, JSON.stringify(ce2));
  check('S9 soft-flagged row stays active', rowById.get(f)?.status === 'active');

  // ── S6: bad inputs + not-active + not-found ─────────────────────────────────────────────
  console.log('\n--- S6 bad inputs ---');
  check('S6 non-array ids', mergeMemoriesHard('nope', 't', { confidence: 0.9 }).reason === 'need-2+-ids');
  check('S6 <2 ids', mergeMemoriesHard([1], 't', { confidence: 0.9 }).reason === 'need-2+-ids');
  check('S6 dup ids (<2 distinct)', mergeMemoriesHard([1, 1], 't', { confidence: 0.9 }).reason === 'need-2+-distinct');
  check('S6 empty mergeText', mergeMemoriesHard([2, 3], '', { confidence: 0.9 }).reason === 'bad-merge-text');
  check('S6 not-found', mergeMemoriesHard([9000001, 9000002], 't', { confidence: 0.9 }).reason === 'not-found');
  const ar1 = mkL1('e18_s6', 'will be archived', { embDim: 10 });
  const ar2 = mkL1('e18_s6', 'still active', { embDim: 11 });
  updateMemoryStatus(ar1, 'archived', null);
  check('S6 non-active original rejected (not-active)', mergeMemoriesHard([ar1, ar2], 't', { confidence: 0.9 }).reason === 'not-active');
}

console.log('\n========================================');
console.log(`E18 merge test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
