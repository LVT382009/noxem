// distinct-fact gate (Phase B) + cone_layer CRON guard — PERMANENT regression test.
//
// Two safety paths had ZERO deterministic coverage before this test:
//   1. Phase B distinct-fact gate — synthesizeConsolidation STEP-1 emits "DEGRADED" (case-insensitive)
//      for a cluster of DISTINCT facts (different attributes/entities) and the caller SKIPS the merge.
//      The only prior coverage was FORCE_DEGRADE -> reason='empty' (the LLM-off miss path); the reason=
//      'distinct' success path was UNVERIFIED because mock-llm is pattern-based and could not judge
//      distinctness. mock-llm 'consolidate-synth' now routes a FORCE_DISTINCT marker to an exact
//      "DEGRADED" reply, so the distinct branch is exercised deterministically.
//   2. cone_layer guard — consolidateMemories (legacy same-source entity merge CRON path) had NO
//      cone_layer filter, so an L3 persona core could cluster + fold with an L0 raw episode
//      (cross-layer identity leak). consolidateSemantically (E2) already restricted to {1,2}; the
//      guard mirrors that discipline for the persona sentinel (cone_layer===3) WITHOUT over-blocking
//      schema-default cone_layer=0 rows. This test proves the persona is excluded AND that a pure
//      L1 facet cluster still consolidates cleanly (positive control) — i.e. the guard does not
//      break legitimate CRON consolidation.
//
// Run (WSL Ubuntu-24.04): bash run-test-guard.sh
// Standalone (mock already up on MOCK_LLM_PORT): ENABLE_EMBEDDING=false EMBEDDING_DIM=256 \
//   LLM_URL=http://127.0.0.1:8011/v1/chat/completions LLM_MODEL=mock-model node test_distinct_cone_guard.mjs
import { storeMemory, db, setEmbeddingModelId, getActiveWithEmbedding } from './memory-store.mjs';
import { synthesizeConsolidation } from './advisor-engine.mjs';
import { consolidateMemories } from './memory-maintenance.mjs';
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
  setEmbeddingModelId('guard-test-model');
  const bh = (d) => { const v = new Float32Array(EMBED_DIM); v[d] = 1.0; return v; };
  // Foundation rows are fetched as REAL DB rows (decoded embeddings) so consolidateMemories sees the
  // same shape runMaintenance feeds it (incl. cone_layer + decoded embedding for cosineSimilarity).
  const rowsOf = (entity) => getActiveWithEmbedding().filter(m => m.entity === entity);
  const statusOf = db.prepare('SELECT id, status, superseded_by, cone_layer FROM memories WHERE id = ?');
  const newConsolidator = db.prepare("SELECT id FROM memories WHERE entity=? AND metadata LIKE '%significance_gated%' AND status='active'");

  // === SECTION 1: distinct-fact gate CONTRACT (raw synthesizeConsolidation, no DB) ===
  // FORCE_DISTINCT marker -> mock returns "DEGRADED" -> parser returns reason='distinct'.
  // Near-duplicate cluster (no marker) -> mock canonical sentence -> degraded=false.
  console.log('\n── S1 distinct-fact gate contract ──');
  const synthDistinct = await synthesizeConsolidation([
    { text: 'User tracks project budget via spreadsheet. FORCE_DISTINCT' },
    { text: 'User cooks Italian recipes on weekends.' },
  ], { maxTokens: 256 });
  check('S1a distinct cluster -> degraded=true', synthDistinct.degraded === true, `degraded=${synthDistinct.degraded}`);
  check('S1b distinct cluster -> reason=distinct', synthDistinct.reason === 'distinct', `reason=${synthDistinct.reason}`);

  const synthMerge = await synthesizeConsolidation([
    { text: 'User prefers vim for editing code.' },
    { text: 'User uses vim as their editor.' },
  ], { maxTokens: 256 });
  check('S1c near-dup cluster -> degraded=false', synthMerge.degraded === false, `degraded=${synthMerge.degraded} reason=${synthMerge.reason}`);
  check('S1d near-dup cluster -> canonical text returned', typeof synthMerge.text === 'string' && synthMerge.text.length > 0, `text=${synthMerge.text}`);

  // === SECTION 2: distinct-fact gate CRON END-TO-END (consolidateMemories) ===
  // Three same-entity low-importance rows cluster (shared basis vector -> cosine 1.0 > 0.75).
  // One text carries FORCE_DISTINCT -> synth returns DEGRADED -> consolidateMemories continues (no
  // merge). All three rows STAY active; zero consolidator inserted (silent-loss gate end-to-end).
  console.log('\n── S2 distinct-fact gate CRON end-to-end ──');
  const eDist = 'cguard_distinct';
  const d1 = storeMemory({ session_id: 'cg', type: 'fact', text: 'User tracks budget via spreadsheet. FORCE_DISTINCT', metadata: {}, embedding: bh(70), importance: 0.3, entity: eDist, attribute: 'budget', cone_layer: 1, intent_type: 'fact' });
  const d2 = storeMemory({ session_id: 'cg', type: 'fact', text: 'User cooks Italian recipes on weekends.', metadata: {}, embedding: bh(70), importance: 0.3, entity: eDist, attribute: 'recipes', cone_layer: 1, intent_type: 'fact' });
  const d3 = storeMemory({ session_id: 'cg', type: 'fact', text: 'User reads sci-fi novels nightly.', metadata: {}, embedding: bh(70), importance: 0.3, entity: eDist, attribute: 'books', cone_layer: 1, intent_type: 'fact' });
  const consD = await consolidateMemories(rowsOf(eDist));
  check('S2a distinct cluster -> consolidateMemories returns 0 (no merge)', consD === 0, `got=${consD}`);
  check('S2b d1 stays active', statusOf.get(d1)?.status === 'active', `status=${statusOf.get(d1)?.status}`);
  check('S2c d2 stays active', statusOf.get(d2)?.status === 'active', `status=${statusOf.get(d2)?.status}`);
  check('S2d d3 stays active', statusOf.get(d3)?.status === 'active', `status=${statusOf.get(d3)?.status}`);
  check('S2e NO consolidator row inserted', !newConsolidator.get(eDist), 'consolidator leaked');

  // === SECTION 3: cone_layer guard — persona (L3) excluded from CRON consolidation ===
  // Two L1 facets + one L3 persona SAME entity SAME embedding (cosine 1.0). WITHOUT the guard the
  // persona enters the bucket, cluster size 3 >= 3 -> fold -> persona superseded off active retrieval
  // (identity leak). WITH the guard the persona is filtered at the candidate sieve -> bucket has 2
  // facets < CONSOLIDATION_MIN_CLUSTER(3) -> no fold. Persona STAYS active + NOT superseded.
  console.log('\n── S3 cone_layer guard: persona excluded ──');
  const ePers = 'cguard_persona';
  const f1 = storeMemory({ session_id: 'cg', type: 'preference', text: 'User prefers vim editor.', metadata: {}, embedding: bh(71), importance: 0.3, entity: ePers, attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  const f2 = storeMemory({ session_id: 'cg', type: 'preference', text: 'User uses vim as editor.', metadata: {}, embedding: bh(71), importance: 0.3, entity: ePers, attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  const personaId = storeMemory({ session_id: 'cg', type: 'profile', text: 'Persona core: vim-using developer.', metadata: {}, embedding: bh(71), importance: 0.3, entity: ePers, attribute: 'persona', cone_layer: 3, intent_type: 'profile' });
  const consP = await consolidateMemories(rowsOf(ePers));
  check('S3a persona-cluster -> consolidateMemories returns 0 (persona filtered)', consP === 0, `got=${consP}`);
  check('S3b persona STAYS active (no cross-layer fold)', statusOf.get(personaId)?.status === 'active', `status=${statusOf.get(personaId)?.status}`);
  check('S3c persona NOT superseded', !statusOf.get(personaId)?.superseded_by, `superseded_by=${statusOf.get(personaId)?.superseded_by}`);
  check('S3d f1 stays active (cluster too small without persona)', statusOf.get(f1)?.status === 'active', `status=${statusOf.get(f1)?.status}`);
  check('S3e NO consolidator row for persona entity', !newConsolidator.get(ePers), 'consolidator leaked');

  // === SECTION 4: positive control — pure L1 facets STILL consolidate (guard doesn't break legit) ===
  console.log('\n── S4 positive control: pure L1 facets still consolidate ──');
  const ePC = 'cguard_pc';
  const p1 = storeMemory({ session_id: 'cg', type: 'preference', text: 'User prefers vim editor.', metadata: {}, embedding: bh(72), importance: 0.3, entity: ePC, attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  const p2 = storeMemory({ session_id: 'cg', type: 'preference', text: 'User uses vim as editor.', metadata: {}, embedding: bh(72), importance: 0.3, entity: ePC, attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  const p3 = storeMemory({ session_id: 'cg', type: 'preference', text: 'User edits code in vim.', metadata: {}, embedding: bh(72), importance: 0.3, entity: ePC, attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  const consPC = await consolidateMemories(rowsOf(ePC));
  check('S4a pure L1 facet cluster -> consolidateMemories returns 1 (merge proceeds)', consPC === 1, `got=${consPC}`);
  check('S4b consolidator row inserted', !!newConsolidator.get(ePC), 'no consolidator');
  check('S4c p1 superseded (folded into consolidator)', statusOf.get(p1)?.status === 'superseded', `status=${statusOf.get(p1)?.status}`);
  check('S4d p2 superseded', statusOf.get(p2)?.status === 'superseded', `status=${statusOf.get(p2)?.status}`);
  check('S4e p3 superseded', statusOf.get(p3)?.status === 'superseded', `status=${statusOf.get(p3)?.status}`);
}

console.log('\n========================================');
console.log(`distinct-gate + cone_layer-guard test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
