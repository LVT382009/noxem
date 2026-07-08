// E13 embedding-drift — PERMANENT regression test.
//
// Asserts the drift guard drops rows embedded under a DIFFERENT model than the current one
// (cosine across embedding spaces is meaningless — silent recall corruption on a 384->768 or
// model swap), while NULL model id rows (pre-E13 legacy) stay compatible.
//
// CRITICAL: verifies BOTH the isolated vectorKnnSearchAsync AND the LIVE search paths that
// production actually uses:
//   - vectorKnnSearch (SYNC) — the /memory/search primary + memory-maintenance (the async variant
//     has zero production callers; testing it alone certifies a dead function).
//   - searchByEmbedding at call sites — /memory/search fallback, /memory/bundle-search, MCP
//     memory_search. These filter foreign-model rows at the call site via isForeignEmbeddingModel
//     before passing the corpus into the cosine ranker.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e13.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e13_drift.mjs
import { storeMemory, db, vectorKnnSearch, vectorKnnSearchAsync, setEmbeddingModelId, getCurrentEmbeddingModelId, isForeignEmbeddingModel, getActiveWithEmbedding } from './memory-store.mjs';
import { searchByEmbedding } from './embedding-engine.mjs';
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

if (vecReady) {
  // Non-zero deterministic vector so cosine is defined (a zero-norm vector makes searchByEmbedding
  // skip every row with a zero-norm warning — unrelated to the drift guard under test).
  const fakeVec = () => {
    const v = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) v[i] = 0.1 + (i % 5) * 0.01;
    return v;
  };

  // Register model A, store a row WITH an embedding -> stamped embedding_model_id='modelA'.
  setEmbeddingModelId('embedding-model-A');
  const idA = storeMemory({ session_id: 'e13-test', type: 'fact', text: 'row under model A', metadata: {}, embedding: fakeVec(), cone_layer: 1 });
  const stamped = db.prepare('SELECT embedding_model_id em FROM memories WHERE id = ?').get(idA)?.em;
  check('stored row stamped with current model id (A)', stamped === 'embedding-model-A', `got ${stamped}`);

  // Legacy pre-E13 row: directly NULL its model id to emulate a row that pre-dates the column.
  const idLegacy = storeMemory({ session_id: 'e13-test', type: 'fact', text: 'legacy null-model row', metadata: {}, embedding: fakeVec(), cone_layer: 1 });
  db.prepare('UPDATE memories SET embedding_model_id = NULL WHERE id = ?').run(idLegacy);
  const stampedLegacy = db.prepare('SELECT embedding_model_id em FROM memories WHERE id = ?').get(idLegacy)?.em;
  check('legacy row has NULL model id', stampedLegacy === null, `got ${stampedLegacy}`);

  // Swap the live model to B — emulating a 384->768 / model swap.
  setEmbeddingModelId('embedding-model-B');
  check('getCurrentEmbeddingModelId reflects swap', getCurrentEmbeddingModelId() === 'embedding-model-B');

  // Search under model B. The drift filter must DROP idA (model A) but KEEP idLegacy (NULL=compat).
  const results = await vectorKnnSearchAsync(fakeVec(), 50);
  const ids = new Set((results || []).map(r => r.id));
  check('model-A row DROPPED by drift filter (cross-model cosine)', !ids.has(idA), 'cross-model row surfaced — silent recall corruption');
  check('NULL-model legacy row KEPT (treated compatible)', ids.has(idLegacy), 'legacy pre-E13 row wrongly dropped');

  // === LIVE-PATH: vectorKnnSearch (SYNC) — the REAL /memory/search primary + maintenance path.
  // The async variant above has zero production callers; this sync one is what actually runs.
  console.log('\n--- E13 LIVE path: vectorKnnSearch (sync) drops cross-model, keeps legacy ---');
  const syncHits = vectorKnnSearch(fakeVec(), 50);
  const syncIds = new Set((syncHits || []).map(r => r.id));
  check('LIVE vectorKnnSearch (sync) drops model-A row', !syncIds.has(idA), 'sync primary search surfaced a cross-model row — recall corruption');
  check('LIVE vectorKnnSearch (sync) keeps legacy NULL row', syncIds.has(idLegacy), 'primary search dropped a compatible legacy row');

  // === LIVE-PATH: searchByEmbedding at call sites (/memory/search fallback, bundle-search,
  // MCP memory_search). Call sites filter the corpus via isForeignEmbeddingModel before ranking.
  // Reproduce that exact pattern to prove the live corpus is cross-model-clean at the cosine ranker.
  console.log('\n--- E13 LIVE path: searchByEmbedding call-site filter drops cross-model ---');
  const corpus = getActiveWithEmbedding().filter(m => !isForeignEmbeddingModel(m));
  const sbeHits = searchByEmbedding(fakeVec(), corpus, 50);
  const sbeIds = new Set((sbeHits || []).map(r => r.id));
  check('LIVE searchByEmbedding (filtered corpus) drops model-A row', !sbeIds.has(idA), 'fallback/bundle/MCP corpus surfaced a cross-model row');
  check('LIVE searchByEmbedding (filtered corpus) keeps legacy NULL row', sbeIds.has(idLegacy), 'fallback/bundle/MCP dropped a compatible legacy row');
  check('isForeignEmbeddingModel true for cross-model row under model B', isForeignEmbeddingModel({ embedding_model_id: 'embedding-model-A' }) === true);
  check('isForeignEmbeddingModel false for legacy NULL row', isForeignEmbeddingModel({ embedding_model_id: null }) === false);

  // Sanity: under the ORIGINAL model again, both rows return.
  setEmbeddingModelId('embedding-model-A');
  const resultsA = await vectorKnnSearchAsync(fakeVec(), 50);
  const idsA = new Set((resultsA || []).map(r => r.id));
  check('under model A again, row A returns', idsA.has(idA));
  check('under model A, legacy NULL row still returns', idsA.has(idLegacy));
}

console.log('\n========================================');
console.log(`E13 drift test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
