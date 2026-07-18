// E8 cross-archived dedup — PERMANENT regression test.
//
// Master report §3 scenario B line 107: the store path must scan BOTH active AND archived (via the
// E7 archive index) before inserting; on a clean match it REACTIVATES (E7) the archived row instead
// of leaving a duplicate. This test drives the REAL E8 engine (tryCrossArchivedDedup, which reuses
// E7's tryReactivateCandidates with a STRICT 0.92 dedup threshold + maxReactivate=1).
//
// Option C (Phase A): store-time NO LONGER supersedes a content re-reference on a cosine hit alone
// (the 4000-line paste that killed 134 distinct rows). E8 still REACTIVATES the archived anchor
// (preserve + recall++ + vec reinsert + un-index) as a side effect of tryReactivateCandidates, but
// RETURNS null for content so the worker addVecsToIndex-KEEPS the fresh row active + searchable; the
// Brain-2-gated CRON merges both later (not the store hot path). The only store-time fold Option C
// keeps is the TRIVIAL re-reference (greetings carry no fact): E8 reactivates the anchor, supersedes-
// as-audit the fresh trivial, returns {id}. S1/S3b assert content->null + fresh stays active; the new
// S6 asserts the trivial fold. S2 (stale-skip) / S3a (below-threshold) / S4 (foreign) / S5 (cardinal)
// return null via no reactivated anchor, unchanged.
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
import { storeMemory, db, archiveStaleMemories, setEmbeddingModelId, isForeignEmbeddingModel } from './memory-store.mjs';
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
  const a_hi = mkArchived(1, 'hi', { dim: 60, entity: 'trivial_d', attribute: 'greeting' });   // S6 trivial fold
  const l0card = freshActive(0, 'raw episode audit row', { dim: 40 });
  const l3card = freshActive(3, 'persona core row', { dim: 41 });

  // Archive the L1 facets: populates archive_index + prunes their vecs. L0/L3 stay active (E6).
  console.log('\n--- E8 seed: archive L1 facets, cardinal L0/L3 stay active ---');
  archiveStaleMemories();
  check('a_vim archived + indexed', getRow.get(a_vim)?.status === 'archived' && inIndex.get(BigInt(a_vim)));
  check('a_red archived + indexed', getRow.get(a_red)?.status === 'archived' && inIndex.get(BigInt(a_red)));
  check('L0 cardinal NOT archived', getRow.get(l0card)?.status === 'active');
  check('L3 cardinal NOT archived', getRow.get(l3card)?.status === 'active');

  // === SECTION 1: clean CONTENT re-reference -> archived REACTIVATED (side effect), E8 returns NULL
  // (content deferred to CRON under Option C), fresh STAYS active ===
  // Option C reversed fix-b: store-time no longer supersedes a content re-reference on a cosine hit
  // alone (the 4000-line paste that killed 134 distinct rows). E8 still REACTIVATES the archived anchor
  // via tryReactivateCandidates (preserve + recall++ + vec reinsert + un-index) as a side effect, but
  // RETURNS null so the worker addVecsToIndex-KEEPS the fresh row active + searchable; the Brain-2-
  // gated CRON merges both later (not the store hot path). Both rows survive retrieval.
  console.log('\n--- E8 content re-ref: archived reactivated, e8 null, fresh stays active (Option C) ---');
  const l0_vim = freshActive(0, 'I prefer vim', { dim: 20, entity: 'tool_a', attribute: 'editor' });
  const before = getRow.get(a_vim);
  check('a_vim pre-E8 recall 0', before?.recall_count === 0, `recall=${before?.recall_count}`);
  const e8_1 = tryCrossArchivedDedup(basisVec(20), { id: String(l0_vim), text: 'I prefer vim', intentType: 'preference', entity: 'tool_a' });
  check('E8 returned null (content deferred to CRON under Option C)', e8_1 === null, `got id=${e8_1?.id}`);
  const after = getRow.get(a_vim);
  check('a_vim flipped active (reactivation side effect)', after?.status === 'active', `status=${after?.status}`);
  check('a_vim recall_count incremented to 1', after?.recall_count === 1, `recall=${after?.recall_count}`);
  check('a_vim vec re-inserted', !!inVec.get(BigInt(a_vim)), 'vec not re-inserted');
  check('a_vim removed from archive_index', !inIndex.get(BigInt(a_vim)), 'still indexed');
  // Option C: the fresh content re-reference is NOT superseded at store time (fold deferred to CRON).
  const l0row = getRow.get(l0_vim);
  check('fresh L0 re-mention STAYS active (Option C — CRON merges later)', l0row?.status === 'active', `status=${l0row?.status}`);
  check('fresh L0 vec NOT pruned (stays in retrieval, both rows survive)', !!inVec.get(BigInt(l0_vim)), 'vec wrongly pruned');

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
  // Below 0.92: no reactivation -> null. At 0.95: anchor reactivated (side effect) but content returns
  // null under Option C (fresh stays active; CRON merges), NOT the old supersede-on-cosine.
  console.log('\n--- E8 strictness: 0.90 below threshold skip, 0.95 above reactivate (content still null under Option C) ---');
  const l0_greenLow = freshActive(0, 'I prefer green', { entity: 'color_a', attribute: 'preference' });
  const e8_3a = tryCrossArchivedDedup(offAxis(10, 0.90), { id: String(l0_greenLow), text: 'I prefer green', intentType: 'preference', entity: 'color_a' });
  check('E8 returned null at cosine 0.90 (below 0.92 dedup)', e8_3a === null, `got id=${e8_3a?.id}`);
  check('a_greenA STAYS archived (strict threshold blocked)', getRow.get(a_greenA)?.status === 'archived', `status=${getRow.get(a_greenA)?.status}`);
  check('fresh 0.90 row stays active (insert proceeds)', getRow.get(l0_greenLow)?.status === 'active', `status=${getRow.get(l0_greenLow)?.status}`);
  // 0.95 on a DIFFERENT archived candidate's own axis — isolated section
  const l0_greenHigh = freshActive(0, 'I prefer green', { entity: 'color_b', attribute: 'preference' });
  const e8_3b = tryCrossArchivedDedup(offAxis(11, 0.95), { id: String(l0_greenHigh), text: 'I prefer green', intentType: 'preference', entity: 'color_b' });
  check('E8 returned null at cosine 0.95 (content deferred to CRON; archived still reactivated)', e8_3b === null, `got id=${e8_3b?.id}`);
  check('a_greenB flipped active (reactivation side effect)', getRow.get(a_greenB)?.status === 'active', `status=${getRow.get(a_greenB)?.status}`);
  const greenBrow = getRow.get(a_greenB);
  check('a_greenB recall_count incremented', greenBrow?.recall_count === 1, `recall=${greenBrow?.recall_count}`);
  check('fresh 0.95 row STAYS active (Option C — not superseded; CRON merges)', getRow.get(l0_greenHigh)?.status === 'active', `status=${getRow.get(l0_greenHigh)?.status}`);

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

  // === SECTION 6: TRIVIAL re-reference -> archived reactivated + fresh superseded-as-audit (Option C KEPT) ===
  // Option C keeps the store-time TRIVIAL fold (greetings carry no fact -> no silent-loss risk). An
  // archived greeting anchor + a fresh trivial re-reference (same entity, intentType='greeting') -> E8
  // reactivates the anchor AND returns {id}; the engine supersedes-as-audit the fresh trivial (vec
  // pruned). This is the ONE path that still folds + returns non-null at store time.
  console.log('\n--- E8 trivial: greeting re-ref reactivates archived, supersede fresh (Option-C-kept) ---');
  const l0_hi = freshActive(0, 'hi', { dim: 60, entity: 'trivial_d', attribute: 'greeting' });
  const e8_6 = tryCrossArchivedDedup(basisVec(60), { id: String(l0_hi), text: 'hi', intentType: 'greeting', entity: 'trivial_d' });
  check('E8 returned the reactivated archived trivial anchor', Number(e8_6?.id) === a_hi, `got id=${e8_6?.id} want ${a_hi}`);
  check('a_hi flipped active', getRow.get(a_hi)?.status === 'active', `status=${getRow.get(a_hi)?.status}`);
  check('a_hi removed from archive_index', !inIndex.get(BigInt(a_hi)), 'still indexed');
  check('fresh trivial row superseded-as-audit (Option-C trivial fold)', getRow.get(l0_hi)?.status === 'superseded', `status=${getRow.get(l0_hi)?.status}`);
  check('fresh trivial vec pruned (fold)', !inVec.get(BigInt(l0_hi)), 'vec not pruned on trivial fold');
}

console.log('\n========================================');
console.log(`E8 cross-archived dedup test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
