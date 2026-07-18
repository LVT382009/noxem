// LIVE smoke — Brain 2 augment loop against a running qwenproxy adapter (:8000).
// Controlled: throwaway temp DB (MEMORY_DB_DIR), embedding OFF (basis vectors), no sidecars.
// Pre-seeds "Brain 1 chunked facts" (one incomplete so Brain 2 should memory_edit it), then fires
// runAugment with the FULL conversation carrying the truer facts + one fact Brain 1 MISSED
// (-> Brain 2 should memory_store it). Then re-reads the corpus to PROVE a live qwenproxy-driven
// mutation landed (edit audit / annotation / importance / brain2_augment-sourced row).
//
// PASS BAR (deep-think early-detect): lastToolCalls>0 AND lastOk=true. Bonus: visible mutation.
//
// Run (WSL Ubuntu-24.04, qwenproxy up on :8000):
//   MEMORY_DB_DIR=/tmp/noxem-smoke LLM_URL=http://127.0.0.1:8000/v1/chat/completions \
//   LLM_MODEL=qwen3.7-plus ENABLE_EMBEDDING=false EMBEDDING_DIM=256 \
//   ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false \
//   PIPELINE_ENABLED=false RLM_ENABLED=false BRAIN2_MAX_TOKENS=2048 \
//   node smoke_brain2_live.mjs
import { storeMemory, getMemory, getSessionMemories } from './memory-store.mjs';
import { runAugment, getAugmentStatus } from './brain2-agent.mjs';

const DIM = parseInt(process.env.EMBEDDING_DIM || '256');
const SESSION = 'smoke-brain2';
const basis = (d) => { const v = new Float32Array(DIM); v[d] = 1.0; return v; };
// memory-store hands back metadata as a JSON STRING (parsed at the API boundary, not here). Parse it
// so the inspection prints the real edits / notes / source instead of 'undefined'.
const _meta = (m) => {
  let met = m?.metadata;
  if (typeof met === 'string') { try { met = JSON.parse(met); } catch { met = {}; } }
  return met || {};
};

// ── simulate Brain 1 chunked facts: 3 rows (one incomplete, one fine, one trivial) ──
const s1 = storeMemory({ session_id: SESSION, type: 'preference', text: 'User prefers vim for editing code.', embedding: basis(0), importance: 0.6, entity: 'user', attribute: 'editor', metadata: {}, cone_layer: 1, intent_type: null });
const s2 = storeMemory({ session_id: SESSION, type: 'project',   text: 'User is working on the noxem memory.',          embedding: basis(1), importance: 0.5, entity: 'noxem', attribute: 'current_task', metadata: {}, cone_layer: 1, intent_type: null }); // INCOMPLETE ("memory engine" missing)
const s3 = storeMemory({ session_id: SESSION, type: 'smalltalk', text: 'hi',                                            embedding: basis(2), importance: 0.1, entity: 'trivial', attribute: 'greeting', metadata: {}, cone_layer: 1, intent_type: null });
console.log(`[smoke] seeded 3 Brain-1 chunked facts: s1=${s1} s2=${s2} s3=${s3}`);

const storedMemories = [
  { id: s1, text: 'User prefers vim for editing code.', type: 'preference', entity: 'user', attribute: 'editor', importance: 0.6 },
  { id: s2, text: 'User is working on the noxem memory.', type: 'project', entity: 'noxem', attribute: 'current_task', importance: 0.5 },
  { id: s3, text: 'hi', type: 'smalltalk', entity: 'trivial', attribute: 'greeting', importance: 0.1 },
];

const userMessage = `hi. I prefer vim for editing code. I'm working on the noxem memory engine — specifically the Brain 2 augment feature that verifies + supplements what Brain 1 chunked. Important deployment note for later: we only ever test in WSL Ubuntu-24.04, NEVER 26.04, and we push from Windows git only. Build on Windows, deploy in WSL.`;
const assistantResponse = `Noted. You use vim, and you're working on the noxem memory engine's Brain 2 augment feature. Deployment discipline: test in WSL Ubuntu-24.04 (never 26.04), build on Windows, push from Windows git.`;

console.log('[smoke] firing runAugment against qwenproxy ...');
const t0 = Date.now();
const r = await runAugment({ sessionId: SESSION, userMessage, assistantResponse, storedMemories });
const dt = Date.now() - t0;
console.log(`\n[smoke] RESULT (took ${dt}ms):`, JSON.stringify(r, null, 2));
console.log('\n[smoke] AUGMENT STATUS:', JSON.stringify(getAugmentStatus(), null, 2));

// ── prove a live-qwenproxy-driven mutation landed ──
console.log('\n=== CORPUS AFTER AUGMENT (seeded rows re-read) ===');
for (const id of [s1, s2, s3]) {
  const m = getMemory(id);
  if (!m) { console.log(`  #${id}: GONE (!)`); continue; }
  const met = _meta(m);
  console.log(`  #${id} [${m.type}] imp=${Number(m.importance).toFixed(2)} status=${m.status}`);
  console.log(`    text: ${m.text}`);
  if (met.brain2_edit) console.log(`    brain2_edit: ${JSON.stringify(met.brain2_edit)}`);
  if (met.brain2_importance) console.log(`    brain2_importance: ${JSON.stringify(met.brain2_importance)}`);
  if (met.brain2_flagged_superseded_by) console.log(`    brain2_flagged_superseded_by: ${met.brain2_flagged_superseded_by}`);
  if (Array.isArray(met.notes) && met.notes.length) console.log(`    notes: ${JSON.stringify(met.notes)}`);
}
console.log('\n=== NEW ROWS Brain 2 STORED (metadata.source=brain2_augment) ===');
const sessRows = getSessionMemories(SESSION, 500) || [];
let stored = 0;
for (const m of sessRows) {
  if ([s1, s2, s3].includes(Number(m.id))) continue;
  const met = _meta(m);
  if (met.source === 'brain2_augment') {
    stored++;
    console.log(`  #${m.id} [${m.type}] imp=${Number(m.importance).toFixed(2)} entity=${m.entity}/${m.attribute}`);
    console.log(`    text: ${m.text}`);
  }
}

const st = getAugmentStatus();
const pass = st.lastToolCalls > 0 && st.lastOk === true;
console.log(`\n========================================`);
console.log(`  SMOKE ${pass ? 'PASS' : 'FAIL'}  — lastToolCalls=${st.lastToolCalls} lastOk=${st.lastOk} lastTurns=${st.lastTurns} stored=${stored}`);
if (st.lastError) console.log(`  lastError: ${st.lastError}`);
console.log(`========================================`);
process.exit(pass ? 0 : 1);
