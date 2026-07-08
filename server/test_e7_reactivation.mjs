// E7 reactivation-on-reference — PERMANENT regression test.
//
// Master report §3 scenario B: an archived memory (status='archived') is lost from retrieval, so
// the next reference silently re-inserts a DUPLICATE. E7 keeps an archive index (memory_archive_
// index) of recently-archived L1/L2 rows; the query path (reactivation-engine) scans it and
// REACTIVATES an exact reference (flip active, recall_count++, importance bump, last_recalled_at
// refresh, vec re-inserted from the stored BLOB) instead of letting a later store duplicate it.
// A J2 rule-based contradiction gate skips a candidate that a NEWER active fact has overtaken, so
// a stale fact is never surfaced as truth. E13 cross-model rows are filtered out by
// isForeignEmbeddingModel before ranking. L0/L3 are never archived (E6 cardinal guard) so never
// reach the archive index.
//
// This test drives the REAL engine (tryReactivateCandidates) + the REAL archive hook
// (archiveStaleMemories populates memory_archive_index + prunes vec) + reactivateMemory vec
// re-insert round trip — not a mocked subset.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e7.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e7_reactivation.mjs
import { storeMemory, db, archiveStaleMemories, setEmbeddingModelId, isForeignEmbeddingModel } from './memory-store.mjs';
import { tryReactivateCandidates } from './reactivation-engine.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(` PASS: ${name}`); }
  else { FAIL++; console.log(` FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('vec table ready', vecReady);

// Basis vectors: each archived row lives on its OWN orthogonal axis so cosine(query=e_k, stored=e_j)
// = 1.0 (k==j) or 0.0 (k!=j). This isolates each section deterministically — a query targets exactly
// one archived row instead of ranking several across the 0.85 reactivation threshold. Non-zero norm.
const basisVec = (dim) => { const v = new Float32Array(EMBED_DIM); v[dim] = 1.0; return v; };

if (vecReady) {
  setEmbeddingModelId('e7-test-model');
  const setCreated = db.prepare("UPDATE memories SET created_at = datetime('now', ?) WHERE id = ?");
  const setRecallImp = db.prepare('UPDATE memories SET importance = ?, recall_count = ? WHERE id = ?');
  const setEmModel = db.prepare('UPDATE memories SET embedding_model_id = ? WHERE id = ?');
  const getRow = db.prepare('SELECT id, status, recall_count, importance, last_recalled_at, embedding_model_id FROM memories WHERE id = ?');
  const inVec = db.prepare('SELECT rowid FROM memory_vecs WHERE rowid = ?');
  const inIndex = db.prepare('SELECT archived_id, cone_layer FROM memory_archive_index WHERE archived_id = ?');

  function mk(layer, text, { dim, importance = 0.2, recall = 0, ageDays = 100, entity = '', attribute = '' } = {}) {
    const id = storeMemory({ session_id: 'e7', type: 'fact', text, metadata: {}, embedding: basisVec(dim), importance, entity, attribute, cone_layer: layer });
    setRecallImp.run(importance, recall, id);
    setCreated.run(`-${ageDays} days`, id);
    return id;
  }

  // Seed: r_neutral (clean-reactivation target, animal/preference, dim 50), r_green (contradiction
  // candidate, color/preference, dim 10), r_red (foreign-model target, tool/editor, dim 20), plus
  // L0 + L3 cardinal rows that must NOT be archived.
  const r_neutral = mk(1, 'I like cats', { dim: 50, entity: 'animal', attribute: 'preference' });
  const r_green = mk(1, 'I prefer green', { dim: 10, entity: 'color', attribute: 'preference', importance: 0.1, recall: 0 });
  const r_red = mk(1, 'I use vim', { dim: 20, entity: 'tool', attribute: 'editor' });
  const l0old = mk(0, 'raw episode audit row must NOT be archived', { dim: 60 });
  const l3old = mk(3, 'persona core row must NOT be archived', { dim: 70 });

  // === SECTION 1: archive hooks the index, prunes vec, L0/L3 stay active ===
  console.log('\n--- E7 archive hook: populates index, prunes vec, L0/L3 cardinal ---');
  const archivedCount = archiveStaleMemories();
  const idxNeutral = inIndex.get(BigInt(r_neutral));
  check('archiveStaleMemories archived >=3 L1 rows', archivedCount >= 3, `got ${archivedCount}`);
  check('r_neutral (L1) landed in archive_index', !!idxNeutral);
  check('r_neutral archived', getRow.get(r_neutral)?.status === 'archived', `status=${getRow.get(r_neutral)?.status}`);
  check('r_neutral vec pruned from memory_vecs', !inVec.get(BigInt(r_neutral)), 'vec not pruned on archive');
  check('r_green archived + indexed', !!inIndex.get(BigInt(r_green)) && getRow.get(r_green)?.status === 'archived');
  check('r_red archived + indexed', !!inIndex.get(BigInt(r_red)) && getRow.get(r_red)?.status === 'archived');
  check('L0 row NOT archived (cardinal)', getRow.get(l0old)?.status === 'active');
  check('L3 row NOT archived (cardinal)', getRow.get(l3old)?.status === 'active');
  check('L0 not in archive_index (cardinal)', !inIndex.get(BigInt(l0old)));
  check('L3 not in archive_index (cardinal)', !inIndex.get(BigInt(l3old)));

  // === SECTION 2: clean reactivation — exact reference reactivates (no newer contradiction) ===
  console.log('\n--- E7 clean reactivation: round trip active + recall++ + importance bump + vec back ---');
  const before = getRow.get(r_neutral);
  check('r_neutral pre-reactivate importance 0.2', before?.importance === 0.2, `imp=${before?.importance}`);
  check('r_neutral pre-reactivate recall 0', before?.recall_count === 0, `recall=${before?.recall_count}`);
  const react2 = tryReactivateCandidates(basisVec(50), { coneLayers: [1, 2] });
  const after = getRow.get(r_neutral);
  check('tryReactivateCandidates returned 1 row (the referenced archived row)', react2?.length === 1, `got ${react2?.length}`);
  check('reactivated exactly r_neutral', react2?.[0]?.id === r_neutral);
  check('r_neutral flipped back active', after?.status === 'active', `status=${after?.status}`);
  check('r_neutral recall_count incremented to 1', after?.recall_count === 1, `recall=${after?.recall_count}`);
  check('r_neutral importance bumped +0.1 -> 0.3', Math.abs((after?.importance) - 0.3) < 1e-9, `imp=${after?.importance}`);
  check('r_neutral last_recalled_at refreshed', !!after?.last_recalled_at, 'last_recalled_at unset');
  check('r_neutral vec re-inserted into memory_vecs', !!inVec.get(BigInt(r_neutral)), 'vec not re-inserted on reactivation');
  check('r_neutral removed from archive_index (active again)', !inIndex.get(BigInt(r_neutral)), 'still indexed');

  // === SECTION 3: J2 contradiction gate — newer active fact overtakes -> skip (stay archived) ===
  // Store a NEWER active row for the same entity/attribute whose value contradicts the archived
  // candidate. The gate must keep the stale candidate archived, NOT promote it back as truth.
  console.log('\n--- E7 J2 contradiction gate: newer active overtakes -> stays archived ---');
  // r_blue: newer, active, same entity('color')/attribute('preference'), contradicting value.
  const r_blue = storeMemory({ session_id: 'e7', type: 'fact', text: 'I prefer blue', metadata: {}, embedding: basisVec(12), importance: 0.6, entity: 'color', attribute: 'preference', cone_layer: 1 });
  // leave r_blue created_at = now (default), so it's "newer" than the -100d r_green.
  const react3 = tryReactivateCandidates(basisVec(10), { coneLayers: [1, 2] });
  const greenRow = getRow.get(r_green);
  check('tryReactivateCandidates skipped the contradicted candidate (returned 0)', (react3 || []).length === 0, `got ${react3?.length}`);
  check('r_green STAYS archived (stale fact not promoted as truth)', greenRow?.status === 'archived', `status=${greenRow?.status}`);
  check('r_green still in archive_index (not reactivated)', !!inIndex.get(BigInt(r_green)), 'wrongly removed from index');
  check('r_green vec NOT re-inserted (stays pruned)', !inVec.get(BigInt(r_green)), 'vec re-inserted on a skipped stale candidate');
  check('r_blue newer active NOT affected by reactivation', getRow.get(r_blue)?.status === 'active' && getRow.get(r_blue)?.recall_count === 0);

  // === SECTION 4: E13 cross-model rows filtered before reactivation ===
  // Mark r_red as embedded under a FOREIGN model (a prior swap). It's the only dim-20 candidate, no
  // newer contradiction — so if the foreign filter worked it STAYS archived; if broken it would
  // reactivate (score 1.0, no contradiction) and flip active.
  console.log('\n--- E7 E13 link: foreign-model archived row filtered, stays archived ---');
  setEmModel.run('e7-foreign', r_red);
  const react4 = tryReactivateCandidates(basisVec(20), { coneLayers: [1, 2] });
  check('tryReactivateCandidates returned 0 (foreign row filtered)', (react4 || []).length === 0, `got ${react4?.length}`);
  check('r_red STAYS archived (foreign model blocked reactivation)', getRow.get(r_red)?.status === 'archived', `status=${getRow.get(r_red)?.status}`);
  check('isForeignEmbeddingModel true for e7-foreign row', isForeignEmbeddingModel({ embedding_model_id: 'e7-foreign' }) === true);
}

console.log('\n========================================');
console.log(`E7 reactivation test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
