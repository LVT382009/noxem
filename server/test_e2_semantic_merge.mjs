// E2 semantic-intent merge + A-MEM evolve — PERMANENT regression test.
//
// Master report §3 scenario A (6 steps) + §4 LLM judge plan (J1 store-time, J3 consolidate-synth).
// Covers BOTH E2 mechanisms:
//   1) tryActiveEvolveDedup — STORE-time A-MEM evolve (scenario A: trivial greetings "hi" /
//      "nice to meet you" fold into ONE evolving facet instead of piling up as L0 near-dups).
//   2) consolidateSemantically  — CRON A-MEM evolve + intent-cluster merge over L1/L2 facets, with
//      the SILENT-LOSS gate: content clusters merge ONLY on a clean J3 synth (degraded===false);
//      on any LLM miss the cluster is left untouched (zero data loss). Trivial clusters merge even
//      when the LLM is degraded (interchangeable, carry no fact). L0 raw + L3 persona are NEVER
//      touched by the CRON (cardinal). E13 foreign-model rows are filtered before matching.
//
// Drives the REAL engines (tryActiveEvolveDedup / consolidateSemantically / appendEvolvedContext)
// against the REAL sqlite store, using basis-vector embeddings to isolate cosine without depending
// on the live embedding model. J3 synth is exercised through the REAL mock-llm ('consolidate-synth'
// branch) — success returns a canonical sentence; a "FORCE_DEGRADE" marker in the clustered texts
// makes the mock emit an empty completion so the silent-loss gate fires.
//
// Isolation: every section uses a distinct entity (e2_s1..e2_s8) so the trivial-bucket + entity
// match (store-time) and the (intent_bucket, entity) clustering (CRON) never cross-pollute. The
// CRON calls are given a pre-filtered array (only that section's rows) so other active rows do
// not participate.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e2.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e2_semantic_merge.mjs
import { storeMemory, db, updateMemoryStatus, getActiveWithEmbedding, setEmbeddingModelId } from './memory-store.mjs';
import { tryActiveEvolveDedup } from './reactivation-engine.mjs';
import { consolidateSemantically, detectContradiction } from './memory-maintenance.mjs';
import { classifyIntent, isTrivialIntent } from './embedding-engine.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  PASS: ${name}`); }
  else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('S0 vec table ready', vecReady);

// Basis vectors isolate each row on its OWN orthogonal axis: cosine = 1.0 on exact, 0.0 across.
// Collinear (same-axis) vectors give cosine = 1.0 for content-cluster tests.
const basisVec = (dim) => { const v = new Float32Array(EMBED_DIM); v[dim] = 1.0; return v; };

if (vecReady) {
  setEmbeddingModelId('e2-test-model');
  const getRow = db.prepare('SELECT id, status, superseded_by, importance, metadata, intent_type, cone_layer FROM memories WHERE id = ?');
  const getMeta = (id) => { const r = getRow.get(id); try { return r?.metadata ? JSON.parse(r.metadata) : {}; } catch { return {}; } };

  // ── S1: classifyIntent unit (J1 rule-tier regex classifier) ───────────────────────────
  console.log('\n── S1 classifyIntent unit ──');
  check('greeting trivial', isTrivialIntent(classifyIntent('hi')) === true);
  check('smalltalk trivial', isTrivialIntent(classifyIntent('nice to meet you')) === true);
  check('smalltalk trivial 2', isTrivialIntent(classifyIntent("how's it going")) === true);
  check('thanks trivial', isTrivialIntent(classifyIntent('thanks')) === true);
  check('farewell trivial', isTrivialIntent(classifyIntent('see you later')) === true);
  check('preference NOT trivial', isTrivialIntent(classifyIntent('I prefer vim')) === false);
  check('setup NOT trivial', isTrivialIntent(classifyIntent('the project uses sqlite')) === false);
  check('fact NOT trivial', isTrivialIntent(classifyIntent('User prefers dark mode')) === false);

  // ── S2: store-time intent_type persists on the row ───────────────────────────────────
  console.log('\n── S2 store-time intent_type ──');
  const s2 = storeMemory({ session_id: 'e2', type: 'preference', text: 'I prefer vim', metadata: {}, embedding: basisVec(60), importance: 0.3, entity: 'e2_s2', attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  check('intent_type persisted', getRow.get(s2)?.intent_type === 'preference');
  check('cone_layer persisted', getRow.get(s2)?.cone_layer === 1);

  // ── S3: STORE-time A-MEM evolve — scenario A trivial greetings fold ───────────────────
  // "hi" (greeting) + "nice to meet you" (smalltalk) share the '__trivial__' bucket + same entity
  // -> trivial merge, NO cosine bar. anchor = oldest ("hi"); fresh folded in (audit kept, vec
  // pruned); anchor grows metadata.evolved_context in place.
  console.log('\n── S3 store-time trivial fold (scenario A) ──');
  const hiId = storeMemory({ session_id: 'e2', type: 'greeting', text: 'hi', metadata: {}, embedding: basisVec(61), importance: 0.1, entity: 'e2_s3', cone_layer: 0, intent_type: 'greeting' });
  // make "hi" the older row
  db.prepare("UPDATE memories SET created_at = datetime('now','-5 minutes') WHERE id = ?").run(hiId);
  const niceId = storeMemory({ session_id: 'e2', type: 'smalltalk', text: 'nice to meet you', metadata: {}, embedding: basisVec(62), importance: 0.1, entity: 'e2_s3', cone_layer: 0, intent_type: 'smalltalk' });
  const folded = tryActiveEvolveDedup(basisVec(62), { id: String(niceId), text: 'nice to meet you', intentType: 'smalltalk', entity: 'e2_s3' });
  check('fold returned anchor id', String(folded?.id) === String(hiId), `got ${folded?.id} want ${hiId}`);
  check('fresh folded -> superseded-as-audit', getRow.get(niceId)?.status === 'superseded');
  check('fresh superseded_by anchor', getRow.get(niceId)?.superseded_by === hiId);
  const hiMeta = getMeta(hiId);
  check('anchor evolved_context has fresh text', Array.isArray(hiMeta.evolved_context) && hiMeta.evolved_context.includes('nice to meet you'));
  check('anchor evolved_from_ids has fresh id', Array.isArray(hiMeta.evolved_from_ids) && hiMeta.evolved_from_ids.includes(String(niceId)));
  check('anchor still active (survives)', getRow.get(hiId)?.status === 'active');
  check('trivial anchor importance NOT bumped (stays low)', getRow.get(hiId)?.importance <= 0.11);

  // ── S4: CRON content merge LLM ON (J3 canonical synth) ──────────────────────────────
  // 3 near-dup L1 'preference' facets same entity, same value (non-contradicting), low importance,
  // collinear embeddings (cosine=1.0). Mock returns a canonical sentence -> anchor grows
  // metadata.canonical + importance bump; 2 non-anchors superseded-as-audit.
  console.log('\n── S4 CRON content merge LLM ON (canonical synth) ──');
  const s4anchor = storeMemory({ session_id: 'e2', type: 'preference', text: 'I prefer vim', metadata: {}, embedding: basisVec(70), importance: 0.3, entity: 'e2_s4', attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  db.prepare("UPDATE memories SET created_at = datetime('now','-7 minutes') WHERE id = ?").run(s4anchor);
  const s4b = storeMemory({ session_id: 'e2', type: 'preference', text: 'I like vim', metadata: {}, embedding: basisVec(70), importance: 0.25, entity: 'e2_s4', attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  db.prepare("UPDATE memories SET created_at = datetime('now','-4 minutes') WHERE id = ?").run(s4b);
  const s4c = storeMemory({ session_id: 'e2', type: 'preference', text: 'I love vim', metadata: {}, embedding: basisVec(70), importance: 0.28, entity: 'e2_s4', attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  db.prepare("UPDATE memories SET created_at = datetime('now','-2 minutes') WHERE id = ?").run(s4c);
  const s4rows = getActiveWithEmbedding().filter(m => m.entity === 'e2_s4');
  const s4n = await consolidateSemantically(s4rows);
  check('S4 merged 1 cluster', s4n === 1, `got ${s4n}`);
  check('S4 anchor still active', getRow.get(s4anchor)?.status === 'active');
  check('S4 b superseded-as-audit', getRow.get(s4b)?.status === 'superseded');
  check('S4 c superseded-as-audit', getRow.get(s4c)?.status === 'superseded');
  const s4Meta = getMeta(s4anchor);
  check('S4 anchor canonical set', typeof s4Meta.canonical === 'string' && s4Meta.canonical.length > 5, `meta=${JSON.stringify(s4Meta).slice(0,120)}`);
  check('S4 anchor synthesized flag', s4Meta.synthesized === true);
  check('S4 anchor importance bumped', getRow.get(s4anchor)?.importance > 0.3);
  check('S4 anchor evolved_context has folded texts', Array.isArray(s4Meta.evolved_context) && s4Meta.evolved_context.length === 2);

  // ── S5: SILENT-LOSS GATE — content cluster + LLM degraded -> NO merge ────────────────
  // Same shape as S4 but one cluster text carries FORCE_DEGRADE -> mock returns empty ->
  // synthesizeConsolidation -> {degraded:true} -> CRON leaves ALL rows active (zero data loss).
  console.log('\n── S5 SILENT-LOSS GATE (content + degraded LLM -> no merge) ──');
  const s5a = storeMemory({ session_id: 'e2', type: 'preference', text: 'I prefer python', metadata: {}, embedding: basisVec(71), importance: 0.3, entity: 'e2_s5', attribute: 'lang', cone_layer: 1, intent_type: 'preference' });
  db.prepare("UPDATE memories SET created_at = datetime('now','-7 minutes') WHERE id = ?").run(s5a);
  const s5b = storeMemory({ session_id: 'e2', type: 'preference', text: 'I like python', metadata: {}, embedding: basisVec(71), importance: 0.25, entity: 'e2_s5', attribute: 'lang', cone_layer: 1, intent_type: 'preference' });
  const s5c = storeMemory({ session_id: 'e2', type: 'preference', text: 'FORCE_DEGRADE marker python', metadata: {}, embedding: basisVec(71), importance: 0.27, entity: 'e2_s5', attribute: 'lang', cone_layer: 1, intent_type: 'preference' });
  const s5rows = getActiveWithEmbedding().filter(m => m.entity === 'e2_s5');
  const s5n = await consolidateSemantically(s5rows);
  check('S5 NO merge (degraded gate)', s5n === 0, `got merged=${s5n}`);
  check('S5 a still active', getRow.get(s5a)?.status === 'active');
  check('S5 b still active', getRow.get(s5b)?.status === 'active');
  check('S5 c still active', getRow.get(s5c)?.status === 'active');
  check('S5 a NO canonical (not merged)', getMeta(s5a).canonical === undefined);

  // ── S6: contradiction skip — content cluster with a contradicting pair -> NO merge ───
  // "I prefer vim" + "I prefer emacs" are different values, both non-negated -> preference_change
  // contradiction. The whole cluster is skipped (zero silent loss of the update).
  console.log('\n── S6 contradiction skip ──');
  check('unit: vim vs emacs contradict', detectContradiction('I prefer vim', 'I prefer emacs') != null);
  const s6a = storeMemory({ session_id: 'e2', type: 'preference', text: 'I prefer vim', metadata: {}, embedding: basisVec(72), importance: 0.2, entity: 'e2_s6', attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  db.prepare("UPDATE memories SET created_at = datetime('now','-7 minutes') WHERE id = ?").run(s6a);
  const s6b = storeMemory({ session_id: 'e2', type: 'preference', text: 'I prefer emacs', metadata: {}, embedding: basisVec(72), importance: 0.2, entity: 'e2_s6', attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  const s6c = storeMemory({ session_id: 'e2', type: 'preference', text: 'I like vim', metadata: {}, embedding: basisVec(72), importance: 0.2, entity: 'e2_s6', attribute: 'editor', cone_layer: 1, intent_type: 'preference' });
  const s6rows = getActiveWithEmbedding().filter(m => m.entity === 'e2_s6');
  const s6n = await consolidateSemantically(s6rows);
  check('S6 NO merge (contradiction pair)', s6n === 0, `got merged=${s6n}`);
  check('S6 a still active', getRow.get(s6a)?.status === 'active');
  check('S6 b still active', getRow.get(s6b)?.status === 'active');
  check('S6 c still active', getRow.get(s6c)?.status === 'active');

  // ── S7: L0 never merged by CRON (cardinal guard) ─────────────────────────────────────
  // 2 L0 trivial greetings -> CRON must skip them (consolidateSemantically operates on L1/L2 only).
  console.log('\n── S7 L0 never merged by CRON ──');
  const s7a = storeMemory({ session_id: 'e2', type: 'greeting', text: 'hi', metadata: {}, embedding: basisVec(73), importance: 0.1, entity: 'e2_s7', cone_layer: 0, intent_type: 'greeting' });
  const s7b = storeMemory({ session_id: 'e2', type: 'greeting', text: 'hello there', metadata: {}, embedding: basisVec(73), importance: 0.1, entity: 'e2_s7', cone_layer: 0, intent_type: 'greeting' });
  const s7rows = getActiveWithEmbedding().filter(m => m.entity === 'e2_s7');
  const s7n = await consolidateSemantically(s7rows);
  check('S7 NO merge (L0 cardinal guard)', s7n === 0, `got merged=${s7n}`);
  check('S7 L0 a still active', getRow.get(s7a)?.status === 'active');
  check('S7 L0 b still active', getRow.get(s7b)?.status === 'active');

  // ── S8: importance ceiling — high-importance content NOT silently merged ────────────
  // content cluster but importance >= 0.5 -> CRON skips (never silently merge a high-stakes fact).
  console.log('\n── S8 importance ceiling ──');
  const s8a = storeMemory({ session_id: 'e2', type: 'preference', text: 'I prefer rust', metadata: {}, embedding: basisVec(74), importance: 0.7, entity: 'e2_s8', attribute: 'lang', cone_layer: 1, intent_type: 'preference' });
  db.prepare("UPDATE memories SET created_at = datetime('now','-7 minutes') WHERE id = ?").run(s8a);
  const s8b = storeMemory({ session_id: 'e2', type: 'preference', text: 'I like rust', metadata: {}, embedding: basisVec(74), importance: 0.7, entity: 'e2_s8', attribute: 'lang', cone_layer: 1, intent_type: 'preference' });
  const s8c = storeMemory({ session_id: 'e2', type: 'preference', text: 'I love rust', metadata: {}, embedding: basisVec(74), importance: 0.7, entity: 'e2_s8', attribute: 'lang', cone_layer: 1, intent_type: 'preference' });
  const s8rows = getActiveWithEmbedding().filter(m => m.entity === 'e2_s8');
  const s8n = await consolidateSemantically(s8rows);
  check('S8 NO merge (high importance)', s8n === 0, `got merged=${s8n}`);
  check('S8 a still active', getRow.get(s8a)?.status === 'active');
  check('S8 b still active', getRow.get(s8b)?.status === 'active');
  check('S8 c still active', getRow.get(s8c)?.status === 'active');
}

console.log(`\n═══ E2 semantic-merge: ${PASS} pass, ${FAIL} fail ═══`);
if (FAIL > 0) process.exit(1);
