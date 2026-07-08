// E13 embedding-drift — PERMANENT regression test.
//
// Asserts the drift guard in vectorKnnSearchAsync drops rows embedded under a DIFFERENT model
// than the current one (cosine across embedding spaces is meaningless — silent recall corruption
// on a 384->768 or model swap), while NULL model id rows (pre-E13 legacy) stay compatible.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e13.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e13_drift.mjs
import { storeMemory, db, vectorKnnSearchAsync, setEmbeddingModelId, getCurrentEmbeddingModelId } from './memory-store.mjs';
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
  const fakeVec = () => new Float32Array(EMBED_DIM);

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
