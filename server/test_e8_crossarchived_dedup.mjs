// E8 cross-archived dedup — PERMANENT regression test.
//
// Master report §3 scenario B line 107: the store path must scan BOTH active AND archived (via the
// E7 archive index) before inserting; on a clean match it REACTIVATES (E7) the archived row instead
// of leaving a duplicate. This test drives the REAL E8 engine (tryCrossArchivedDedup, which reuses
// E7's tryReactivateCandidates with a STRICT 0.92 dedup threshold + maxReactivate=1) and the REAL
// store-path side-effect the memory-server embed worker applies on a hit (updateMemoryStatus(...,
// 'superseded', reactivatedId) to keep the dup out of retrieval).
//
// Why the fresh store stays 'active' at E8 time is load-bearing: E8 hooks after async embed and
// BEFORE the worker adds the vec / supersedes, so the J2 contradiction gate inherited from E7 sees
// the fresh store as the newest active row of any shared entity/attribute. An agreeing re-reference
// reactivates (preserve + recall++); a contradicting re-reference is caught as stale -> skip and
// the new memory is stored as normal (the new truth). E13 foreign-model archived rows are filtered
// before ranking (inherited). L0/L3 never archived (E6 cardinal) -> never candidates here.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e8.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e8_crossarchived_dedup.mjs
import { storeMemory, db, updateMemoryStatus, archiveStaleMemories, setEmbeddingModelId, isForeignEmbeddingModel } from './memory-store.mjs';
import { tryCrossArchivedDedup } from './reactivation-engine.mjs';
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

// Basis vectors isolate each archived candidate on its OWN orthogonal axis: cosine = 1.0 on exact,
// 0.0 across. For S3 strictness we hand-build off-axis unit vectors at a known cosine (0.90 low /
// 0.95 high) to prove the 0.92 boundary.
const basisVec = (dim) => { const v = new Float32Array(EMBED_DIM); v[dim] = 1.0; return v; };
const offAxis = (primary, cosine) => {
  const v = new Float32Array(EMBED_DIM);
  const secondary = primary + 1; // adjacent dim as the off-axis component
  v[primary] = cosine;
  v[secondary] = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  return v; // unit norm
};

if (vecReady) {
  setEmbeddingModelId('e8-test-model');
  const setCreated = db.prepare("UPDATE memories SET created_at = datetime('now', ?) WHERE id = ?");
  const setRecallImp = db.prepare('UPDATE memories SET importance = ?, recall_count = ? WHERE id = ?');
  const setEmModel = db.prepare('UPDATE memories SET embedding_model_id = ? WHERE id = ?');
  const getRow = db.prepare('SELECT id, status, recall_count, importance, last_recalled_at, embedding_model_id, superseded_by FROM memories WHERE id = ?');
  const inVec = db.prepare('SELECT rowid FROM memory_vecs WHERE rowid = ?');
  const inIndex = db.prepare('SELECT archived_id FROM memory_archive_index WHERE archived_id = ?');

  function mkArchived(layer, text, { dim, entity = '', attribute = '' }) {
    const id = storeMemory({ session_id: 'e8', type: 'fact', text, metadata: {}, embedding: basisVec(dim), importance: 0.2, entity, attribute, cone_layer: layer });
    setRecallImp.run(0.2, 0, id);
    setCreated.run('-100 days', id);
    return id;
  }
  function freshActive(layer, text, { dim, embedding, entity = '', attribute = '' }) {
    const id = storeMemory({ session_id: 'e8', type: 'fact', text, metadata: {}, embedding: embedding ?? basisVec(dim), importance: 0.5, entity, attribute, cone_layer: layer });
    return id; // created_at = now (default) -> 'newer' than the -100d archived candidates
  }

  // Seed archived L1 facets — one per section, distinct entity/attr so the J2 newer-active scan
  // (getMemoriesByEntityAttr) is isolated per section. Plus L0 + L3 cardinal rows.
  const a_vim = mkArchived(1, 'I prefer vim', { dim: 20, entity: 'tool_a', attribute: 'editor' });            // S1 agree / reactivation
  const a_emacs = mkArchived(1, 'I prefer emacs', { dim: 21, entity: 'tool_b', attribute: 'editor' });         // S2 contradict / stale skip
  const a_greenA = mkArchived(1, 'I prefer green', { dim: 10, entity: 'color_a', attribute: 'preference' });   // S3a strict-low (0.90)
  const a_greenB = mkArchived(1, 'I prefer green', { dim: 11, entity: 'color_b', attribute: 'preference' });    // S3b strict-high (0.95)
  const a_red = mkArchived(1, 'I like red', { dim: 30, entity: 'color_c', attribute: 'preference' });          // S4 foreign-model
  const l0card = freshActive(0, 'raw episode audit row', { dim: 40 });
  const l3card = freshActive(3, 'persona core row', { dim: 41 });

  // Archive the L1 facets: populates archive_index + prunes their vecs. L0/L3 stay active (E6).
  console.log('\n--- E8 seed: archive L1 facets, cardinal L0/L3 stay active ---');
  archiveStaleMemories();
  check('a_vim archived + indexed', getRow.get(a_vim)?.status === 'archived' && inIndex.get(BigInt(a_vim)));
  check('a_red archived + indexed', getRow.get(a_red)?.status === 'archived' && inIndex.get(BigInt(a_red)));
  check('L0 cardinal NOT archived', getRow.get(l0card)?.status === 'active');
  check('L3 cardinal NOT archived', getRow.get(l3card)?.status === 'active');

  // === SECTION 1: clean re-reference -> reactivate archived + supersede the fresh store ===
  console.log('\n--- E8 clean dedup: agreeing re-reference reactivates archived, supersede fresh ---');
  const l0_vim = freshActive(0, 'I prefer vim', { dim: 20, entity: 'tool_a', attribute: 'editor' });
  const before = getRow.get(a_vim);
  check('a_vim pre-E8 recall 0', before?.recall_count === 0, `recall=${before?.recall_count}`);
  const e8_1 = tryCrossArchivedDedup(basisVec(20));
  check('E8 returned the reactivated archived row', e8_1?.id === a_vim, `got id=${e8_1?.id}`);
  const after = getRow.get(a_vim);
  check('a_vim flipped active', after?.status === 'active', `status=${after?.status}`);
  check('a_vim recall_count incremented to 1', after?.recall_count === 1, `recall=${after?.recall_count}`);
  check('a_vim vec re-inserted', !!inVec.get(BigInt(a_vim)), 'vec not re-inserted');
  check('a_vim removed from archive_index', !inIndex.get(BigInt(a_vim)), 'still indexed');
  // store-path side-effect the worker applies on a hit: supersede the fresh dup (audit kept, vec pruned)
  updateMemoryStatus(l0_vim, 'superseded', e8_1.id);
  const l0row = getRow.get(l0_vim);
  check('fresh L0 re-mention superseded (kept as audit, not active)', l0row?.status === 'superseded', `status=${l0row?.status}`);
  check('fresh L0 superseded_by = reactivated archived id', Number(l0row?.superseded_by) === a_vim, `sb=${l0row?.superseded_by}`);
  check('fresh L0 vec pruned (out of retrieval, no duplicate)', !inVec.get(BigInt(l0_vim)), 'vec not pruned on supersede');

  // === SECTION 2: contradicting re-reference -> J2 stale skip, archived stays archived ===
  // Fresh store negates the archived emacs preference. It is 'active' at E8 time, so the J2 gate sees
  // it as the newest tool_b/editor row; detectContradiction("I prefer emacs","I no longer prefer emacs")
  // = negation_flip -> stale -> skip. The new memory is stored as normal (new truth), not reactivated.
  console.log('\n--- E8 contradiction: incoming negates archived -> J2 skip, new truth stored ---');
  const l0_emacs = freshActive(0, 'I no longer prefer emacs', { entity: 'tool_b', attribute: 'editor' });
  // I no longer prefer emacs embedding: hand a high-cosine vector INTO the archived emacs axis so the
  // 0.92 threshold passes (text decides contradiction, not the basis orthogonality).
  const embNoEmacs = offAxis(21, 0.99);
  const e8_2 = tryCrossArchivedDedup(embNoEmacs);
  check('E8 returned null (stale candidate skipped)', e8_2 === null, `got id=${e8_2?.id}`);
  check('a_emacs STAYS archived (stale fact not promoted)', getRow.get(a_emacs)?.status === 'archived', `status=${getRow.get(a_emacs)?.status}`);
  check('a_emacs still in archive_index', !!inIndex.get(BigInt(a_emacs)), 'wrongly removed');
  check('a_emacs vec NOT re-inserted', !inVec.get(BigInt(a_emacs)), 'vec re-inserted');
  check('fresh negate row stays active (stored as the new truth)', getRow.get(l0_emacs)?.status === 'active', `status=${getRow.get(l0_emacs)?.status}`);

  // === SECTION 3: strict 0.92 threshold boundary (dedup, not fuzzy 0.85 reference) ===
  console.log('\n--- E8 strictness: 0.90 below threshold skip, 0.95 above reactivate ---');
  const l0_greenLow = freshActive(0, 'I prefer green', { entity: 'color_a', attribute: 'preference' });
  const e8_3a = tryCrossArchivedDedup(offAxis(10, 0.90));
  check('E8 returned null at cosine 0.90 (below 0.92 dedup)', e8_3a === null, `got id=${e8_3a?.id}`);
  check('a_greenA STAYS archived (strict threshold blocked)', getRow.get(a_greenA)?.status === 'archived', `status=${getRow.get(a_greenA)?.status}`);
  check('fresh 0.90 row stays active (insert proceeds)', getRow.get(l0_greenLow)?.status === 'active', `status=${getRow.get(l0_greenLow)?.status}`);
  // 0.95 on a DIFFERENT archived candidate's own axis — isolated section
  const l0_greenHigh = freshActive(0, 'I prefer green', { entity: 'color_b', attribute: 'preference' });
  const e8_3b = tryCrossArchivedDedup(offAxis(11, 0.95));
  check('E8 returned the reactivated row at cosine 0.95 (>=0.92)', e8_3b?.id === a_greenB, `got id=${e8_3b?.id}`);
  check('a_greenB flipped active', getRow.get(a_greenB)?.status === 'active', `status=${getRow.get(a_greenB)?.status}`);
  const greenBrow = getRow.get(a_greenB);
  check('a_greenB recall_count incremented', greenBrow?.recall_count === 1, `recall=${greenBrow?.recall_count}`);
  updateMemoryStatus(l0_greenHigh, 'superseded', e8_3b.id);
  check('fresh 0.95 row superseded (clean dedup)', getRow.get(l0_greenHigh)?.status === 'superseded');

  // === SECTION 4: E13 foreign-model archived candidate filtered before dedup ===
  console.log('\n--- E8 E13 link: foreign-model archived row filtered, no reactivation ---');
  setEmModel.run('e8-foreign', a_red);
  const l0_red = freshActive(0, 'I like red', { dim: 30, entity: 'color_c', attribute: 'preference' });
  const e8_4 = tryCrossArchivedDedup(basisVec(30));
  check('E8 returned null (foreign archived row filtered)', e8_4 === null, `got id=${e8_4?.id}`);
  check('a_red STAYS archived (foreign model blocked dedup)', getRow.get(a_red)?.status === 'archived', `status=${getRow.get(a_red)?.status}`);
  check('fresh red row stays active (insert proceeds)', getRow.get(l0_red)?.status === 'active', `status=${getRow.get(l0_red)?.status}`);
  check('isForeignEmbeddingModel true for foreign row', isForeignEmbeddingModel({ embedding_model_id: 'e8-foreign' }) === true);

  // === SECTION 5: cardinal L0/L3 never candidates — fresh L0/L3 stores dedup to nothing ===
  console.log('\n--- E8 cardinal: fresh L0/L3 raw stores find no archived match (insert proceeds) ---');
  const l0_audit = freshActive(0, 'user scrolled past the login form', { dim: 50 });
  const e8_5a = tryCrossArchivedDedup(basisVec(50));
  check('E8 null for fresh L0 with no archived match', e8_5a === null, `got id=${e8_5a?.id}`);
  check('fresh L0 audit stays active (normal insert)', getRow.get(l0_audit)?.status === 'active');
  const e8_5b = tryCrossArchivedDedup(basisVec(41)); // L3 cardinal axis
  check('E8 null for L3 cardinal axis (never archived)', e8_5b === null, `got id=${e8_5b?.id}`);
  check('L3 cardinal still active', getRow.get(l3card)?.status === 'active');
}

console.log('\n========================================');
console.log(`E8 cross-archived dedup test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
