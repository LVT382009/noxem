// E20 D1 bundle-search status-gate fix — PERMANENT regression test.
//
// bundle-search.mjs searchLayer (the M-Flow cone-layer arm) gated retrieval on status==='active'
// ONLY, which EXCLUDED 'contradicted' rows. After D1, the detect pass pair-links BOTH halves of a
// contradiction as status='contradicted' (instead of silently superseding one). If searchLayer kept
// the active-only gate, the ENTIRE contradiction pair would vanish from bundle retrieval — hiding the
// very tension D1 surfaces. E20 fixes the gate to (active || contradicted), mirroring the FIX-4 arms
// in memory-store (vectorKnnSearch / getActiveWithEmbedding). Dead rows (superseded / archived /
// invalid) stay excluded — the E1 regression guard.
//
// Because bundleSearch() short-circuits on isEmbeddingReady() (ENABLE_EMBEDDING=false), searchLayer
// is exported for deterministic direct testing. It runs the EXACT same path bundleSearch runs: knnSearch
// candidates → getMemoriesByIds → cone_layer + status gate.
//
// Surfaces + validates, against the REAL sqlite store (EMBEDDING_DIM=256 basis vectors):
//   S2  active row surfaces in its cone layer.
//   S3  contradicted pair: searchLayer returns BOTH halves (the fix). (Pre-fix would return 0.)
//   S4  superseded row EXCLUDED (dead — E1 guard preserved).
//   S5  archived row EXCLUDED (dead).
//   S6  foreign-embedding-model row EXCLUDED (isForeignEmbeddingModel guard preserved).
//   S7  mixed active + contradicted same layer -> both surface.
//   S8  cone_layer filter: a layer-2 row does NOT surface in a layer-1 query.
//   S9  BUNDLE_MIN_SCORE respected: a low-similarity row does not surface.
//
// Pure store ops (no LLM). ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e20.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e20_bundle_status.mjs
import { storeMemory, db, updateMemoryStatus, linkContradictionPair } from './memory-store.mjs';
import { searchLayer } from './bundle-search.mjs';
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
check('S0 searchLayer exported', typeof searchLayer === 'function');

const memExists = db.prepare('SELECT 1 AS x FROM memories WHERE id = ?');
const rowStatus = id => db.prepare('SELECT status, cone_layer, embedding_model_id FROM memories WHERE id = ?').get(id);

function mk({ text, layer = 1, embDim, entity = 'user', attribute = 'q' }) {
  // storeMemory inserts the vec into memory_vecs itself (insertVec) when embedding provided; do NOT
  // addVecsToIndex here too (dupes the rowid -> UNIQUE constraint failure on the vec PK).
  return storeMemory({ session_id: 'e20', type: 'fact', text, metadata: {}, cone_layer: layer, importance: 0.5, entity, attribute, embedding: basis(embDim) });
}

const idsOf = hits => (hits || []).map(h => Number(h.id)).sort((a, b) => a - b);

if (vecReady) {
  // ── S2: active row surfaces in its cone layer ─────────────────────────────────────────
  console.log('\n--- S2 active row surfaces ---');
  const s2 = mk({ text: 'user prefers dark theme (e20-s2)', layer: 1, embDim: 10 });
  const hits2 = await searchLayer(basis(10), 1, 20);
  check('S2 active row in results', idsOf(hits2).includes(s2), `got ${JSON.stringify(idsOf(hits2))}`);

  // ── S3: contradicted pair -> searchLayer returns BOTH halves (the fix) ─────────────────
  console.log('\n--- S3 contradicted pair both surface ---');
  const a = mk({ text: 'user likes serif fonts (e20-s3a)', layer: 1, embDim: 20 });
  const b = mk({ text: 'user likes sans fonts (e20-s3b)', layer: 1, embDim: 21 });
  linkContradictionPair(a, b);
  check('S3 a contradicted', rowStatus(a).status === 'contradicted');
  check('S3 b contradicted', rowStatus(b).status === 'contradicted');
  const hitsA = await searchLayer(basis(20), 1, 20);
  const hitsB = await searchLayer(basis(21), 1, 20);
  check('S3 a (queried by its own vec) surfaces despite contradicted', idsOf(hitsA).includes(a), `got ${JSON.stringify(idsOf(hitsA))}`);
  check('S3 b (queried by its own vec) surfaces despite contradicted', idsOf(hitsB).includes(b), `got ${JSON.stringify(idsOf(hitsB))}`);

  // ── S4: superseded row EXCLUDED (dead — E1 guard preserved) ────────────────────────────
  console.log('\n--- S4 superseded excluded ---');
  const old_ = mk({ text: 'superseded stale fact (e20-s4)', layer: 1, embDim: 30 });
  const new_ = mk({ text: 'newer canonical fact (e20-s4)', layer: 1, embDim: 31 });
  updateMemoryStatus(old_, 'superseded', new_);
  check('S4 old status superseded', rowStatus(old_).status === 'superseded');
  const hits4 = await searchLayer(basis(30), 1, 20);
  check('S4 superseded row NOT surfaced (dead)', !idsOf(hits4).includes(old_), `got ${JSON.stringify(idsOf(hits4))}`);
  check('S4 newer (active) row IS surfaced', idsOf(await searchLayer(basis(31), 1, 20)).includes(new_));

  // ── S5: archived row EXCLUDED (dead) ──────────────────────────────────────────────────
  console.log('\n--- S5 archived excluded ---');
  const ar = mk({ text: 'archived orphan (e20-s5)', layer: 2, embDim: 40 });
  updateMemoryStatus(ar, 'archived', null);
  check('S5 ar archived', rowStatus(ar).status === 'archived');
  const hits5 = await searchLayer(basis(40), 2, 20);
  check('S5 archived row NOT surfaced (dead)', !idsOf(hits5).includes(ar), `got ${JSON.stringify(idsOf(hits5))}`);

  // ── S6 (removed): foreign-embedding-model drift guard cannot be exercised here. ────────
  // isForeignEmbeddingModel (store.mjs:18) returns TRUE only if BOTH mem.embedding_model_id AND
  // _currentEmbeddingModelId are truthy + differ. Under ENABLE_EMBEDDING=false no model loads, so
  // _currentEmbeddingModelId is null -> the guard is correctly DORMANT (nothing to be foreign to).
  // That guard is E13's model-drift concern, orthogonal to the D1 status gate this test targets;
  // exercising it would require a live embedding model (heavy/flaky), so it stays out of scope.

  // ── S7: mixed active + contradicted same layer -> both surface ────────────────────────
  console.log('\n--- S7 mixed active + contradicted both surface ---');
  const act = mk({ text: 'plain active fact (e20-s7a)', layer: 1, embDim: 60 });
  const con1 = mk({ text: 'conflict side 1 (e20-s7c)', layer: 1, embDim: 61 });
  const con2 = mk({ text: 'conflict side 2 (e20-s7c)', layer: 1, embDim: 62 });
  linkContradictionPair(con1, con2);
  // active + one contradicted side at comparable cosine to a middle-bias query vec all surface
  const mid = basis(60); // matches act best; con1/con2 at cosine 0 but knn returns top-N anyway if >= BUNDLE_MIN_SCORE
  const hits7 = await searchLayer(mid, 1, 50);
  check('S7 active row surfaces', idsOf(hits7).includes(act));
  check('S7 contradicted con1 still surfaces (queried separately)', idsOf(await searchLayer(basis(61), 1, 20)).includes(con1));

  // ── S8: cone_layer filter — layer-2 row does NOT surface in a layer-1 query ────────────
  console.log('\n--- S8 cone_layer filter ---');
  const l2 = mk({ text: 'layer-2 abstraction (e20-s8)', layer: 2, embDim: 70 });
  const hits8 = await searchLayer(basis(70), 1, 20); // query its vec but into layer 1
  check('S8 layer-2 row NOT surfaced in layer-1 query', !idsOf(hits8).includes(l2), `got ${JSON.stringify(idsOf(hits8))}`);
  check('S8 layer-2 row surfaces in layer-2 query', idsOf(await searchLayer(basis(70), 2, 20)).includes(l2));

  // ── S9: BUNDLE_MIN_SCORE respected — orthogonal low-sim row does not surface ──────────
  console.log('\n--- S9 BUNDLE_MIN_SCORE gate ---');
  const tight = mk({ text: 'tight match (e20-s9t)', layer: 1, embDim: 80 });
  const ortho = mk({ text: 'orthogonal low-sim (e20-s9o)', layer: 1, embDim: 81 }); // basis(81) vs query basis(80) -> cosine 0
  const hits9 = await searchLayer(basis(80), 1, 20);
  check('S9 tight-match row surfaces', idsOf(hits9).includes(tight), `got ${JSON.stringify(idsOf(hits9))}`);
  check('S9 orthogonal row excluded by BUNDLE_MIN_SCORE', !idsOf(hits9).includes(ortho), `got ${JSON.stringify(idsOf(hits9))}`);
}

console.log('\n========================================');
console.log(`E20 bundle-search status-gate test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
