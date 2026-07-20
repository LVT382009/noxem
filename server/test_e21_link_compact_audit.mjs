// E21 — memory_link + memory_compact + memory_audit_report — PERMANENT regression test.
//
// Step 5 of the approved 8-step sequence surfaces three Brain2 reconcile tools:
//   memory_link        — free-form authored edge (memory_edges.relation is free-form TEXT, not an enum).
//                        Wrapper over storeEdge (self-ref rejected, bi-temporal + strength captured).
//   memory_compact     — REVERSIBLE orphan fallback. Brain2 FIRST tried memory_merge (enrich a related
//                        row), found NO neighbor, THEN archives the true orphan. Cardinal L0/L3 survive
//                        forever; reversible via reactivate-on-reference (E7). NOT a hard delete.
//   memory_audit_report — read-only corpus-shape view Brain2 reasons from: status totals, OPEN
//                        contradiction pairs (awaiting a memory_resolve_contradiction verdict), low-conf
//                        merges awaiting review (brain2_review_pending), merged-row count, edge histogram.
//
// Validates via dispatchTool (the agent-loop path) against the REAL sqlite store:
//   S2  memory_link happy: edge persisted, relation free-form, source_session_id='brain2', reason in metadata.
//   S3  memory_link exotic free-form label persists verbatim.
//   S4  memory_link self-ref rejected.
//   S5  memory_link missing-relation rejected.
//   S6  memory_link strength + valid_from captured.
//   S7  memory_compact L1 happy: archived, archive_index row, brain2_compact_reason stamped.
//   S8  memory_compact L0 cardinal guard: rejected cardinal-protected, stays active.
//   S9  memory_compact L3 cardinal guard: rejected cardinal-protected, stays active.
//   S10 memory_compact not-found rejected.
//   S11 memory_compact REVERSIBLE: reactivateMemory restores active + drops archive_index row.
//   S12 memory_audit_report: totals + open contradiction pair + review-pending merge + edge histogram.
//
// Pure store ops (no LLM). ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors (merge + compact
// embedding arms are guarded soft paths, like E18/E19). run via dispatchTool so the full tool-menu path
// (BRAIN2_TOOLS._byName -> handler) is exercised, not the store primitive directly.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e21.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e21_link_compact_audit.mjs
import { storeMemory, db, linkContradictionPair, reactivateMemory } from './memory-store.mjs';
import { BRAIN2_TOOLS, dispatchTool } from './brain2-tools.mjs';
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
check('S0 memory_link registered', BRAIN2_TOOLS.some(t => t.name === 'memory_link'));
check('S0 memory_compact registered', BRAIN2_TOOLS.some(t => t.name === 'memory_compact'));
check('S0 memory_audit_report registered', BRAIN2_TOOLS.some(t => t.name === 'memory_audit_report'));

const rowStatus = id => db.prepare('SELECT status, cone_layer FROM memories WHERE id = ?').get(id);
const edgeRow = (fromId, toId) => db.prepare('SELECT relation, valid_from, valid_until, strength, source_session_id, metadata FROM memory_edges WHERE from_id = ? AND to_id = ? ORDER BY id DESC LIMIT 1').get(fromId, toId);
const edgeByRel = (rel) => db.prepare('SELECT relation, strength, valid_from FROM memory_edges WHERE relation = ? ORDER BY id DESC LIMIT 1').get(rel);
const archiveIdx = id => db.prepare('SELECT archived_id FROM memory_archive_index WHERE archived_id = ?').get(id);
const metaOf = id => { try { return JSON.parse(db.prepare('SELECT metadata FROM memories WHERE id = ?').get(id).metadata || '{}'); } catch { return {}; } };

function mk({ text, layer = 1, embDim, entity = 'user', attribute = 'q', imp = 0.5 }) {
  return storeMemory({ session_id: 'e21', type: 'fact', text, metadata: {}, cone_layer: layer, importance: imp, entity, attribute, embedding: basis(embDim) });
}

if (vecReady) {
  // ── S2: memory_link happy path ──────────────────────────────────────────────────────────
  console.log('\n--- S2 memory_link happy ---');
  const a = mk({ text: 'user likes serif fonts (e21-a)', embDim: 10, attribute: 'font' });
  const b = mk({ text: 'user picks serif for body text (e21-b)', embDim: 11, attribute: 'font' });
  const r2 = await dispatchTool('memory_link', { from_id: a, to_id: b, relation: 'relates_to', reason: 'both speak about serif font' });
  check('S2 link ok', r2.ok === true, JSON.stringify(r2));
  check('S2 edge_id finite', Number.isFinite(r2.edge_id));
  check('S2 relation echoed', r2.relation === 'relates_to');
  const e2 = edgeRow(a, b);
  check('S2 edge persisted', e2 && e2.relation === 'relates_to', JSON.stringify(e2));
  check('S2 source_session_id brain2', e2 && e2.source_session_id === 'brain2');
  check('S2 reason in metadata', e2 && /both speak about serif font/.test(e2.metadata), JSON.stringify(e2 && e2.metadata));

  // ── S3: memory_link exotic free-form label ─────────────────────────────────────────────
  console.log('\n--- S3 memory_link free-form label ---');
  const c = mk({ text: 'fact alpha (e21-c)', embDim: 12 });
  const d = mk({ text: 'fact beta clarifies alpha (e21-d)', embDim: 13 });
  const exotic = '曾经说过_supersedes_explains::v2';
  const r3 = await dispatchTool('memory_link', { from_id: c, to_id: d, relation: exotic, reason: 'exotic authored label' });
  check('S3 link ok', r3.ok === true, JSON.stringify(r3));
  const e3 = edgeRow(c, d);
  check('S3 exotic label persisted verbatim', e3 && e3.relation === exotic, JSON.stringify(e3 && e3.relation));

  // ── S4: memory_link self-ref rejected ───────────────────────────────────────────────────
  console.log('\n--- S4 memory_link self-ref ---');
  const r4 = await dispatchTool('memory_link', { from_id: a, to_id: a, relation: 'relates_to' });
  check('S4 self-ref rejected', r4.ok === false && /self/i.test(r4.error), JSON.stringify(r4));

  // ── S5: memory_link missing relation rejected ────────────────────────────────────────────
  console.log('\n--- S5 memory_link missing relation ---');
  const r5 = await dispatchTool('memory_link', { from_id: a, to_id: b, relation: '' });
  check('S5 missing relation rejected', r5.ok === false && /relation/i.test(r5.error), JSON.stringify(r5));

  // ── S6: memory_link strength + valid_from captured ──────────────────────────────────────
  console.log('\n--- S6 memory_link strength + valid_from ---');
  const f = mk({ text: 'prereq fact (e21-f)', embDim: 14 });
  const g = mk({ text: 'dependent fact (e21-g)', embDim: 15 });
  const vf = '2026-06-24T00:00:00Z';
  const r6 = await dispatchTool('memory_link', { from_id: f, to_id: g, relation: 'prerequisites', strength: 0.4, valid_from: vf, reason: 'prereq' });
  check('S6 link ok', r6.ok === true, JSON.stringify(r6));
  const e6 = edgeRow(f, g);
  check('S6 strength 0.4', e6 && Math.abs(e6.strength - 0.4) < 1e-6, JSON.stringify(e6 && e6.strength));
  check('S6 valid_from captured', e6 && e6.valid_from === vf, JSON.stringify(e6 && e6.valid_from));

  // ── S7: memory_compact L1 happy ────────────────────────────────────────────────────────
  console.log('\n--- S7 memory_compact L1 happy ---');
  const z = mk({ text: 'orphan stale fact no neighbor (e21-z)', embDim: 16, attribute: 'cmp7' });
  const r7 = await dispatchTool('memory_compact', { id: z, reason: 'searched, found no related memory to merge into, true orphan' });
  check('S7 compact ok', r7.ok === true, JSON.stringify(r7));
  check('S7 archived flag', r7.archived === true);
  check('S7 reversible flag', r7.reversible === true);
  check('S7 status archived', rowStatus(z)?.status === 'archived');
  check('S7 archive_index row', !!archiveIdx(z));
  check('S7 brain2_compact_reason stamped', /true orphan/.test(metaOf(z).brain2_compact_reason), JSON.stringify(metaOf(z).brain2_compact_reason));

  // ── S8: memory_compact L0 cardinal guard ────────────────────────────────────────────────
  console.log('\n--- S8 memory_compact L0 cardinal guard ---');
  const l0 = mk({ text: 'raw episode oracle (e21-l0)', layer: 0, embDim: 17, attribute: 'ep' });
  const r8 = await dispatchTool('memory_compact', { id: l0, reason: 'try compact oracle' });
  check('S8 L0 rejected', r8.ok === false && r8.reason === 'cardinal-protected', JSON.stringify(r8));
  check('S8 L0 still active', rowStatus(l0)?.status === 'active');

  // ── S9: memory_compact L3 cardinal guard ────────────────────────────────────────────────
  console.log('\n--- S9 memory_compact L3 cardinal guard ---');
  const l3 = mk({ text: 'persona summary (e21-l3)', layer: 3, embDim: 18, attribute: 'persona' });
  const r9 = await dispatchTool('memory_compact', { id: l3, reason: 'try compact persona' });
  check('S9 L3 rejected', r9.ok === false && r9.reason === 'cardinal-protected', JSON.stringify(r9));
  check('S9 L3 still active', rowStatus(l3)?.status === 'active');

  // ── S10: memory_compact not-found ────────────────────────────────────────────────────────
  console.log('\n--- S10 memory_compact not-found ---');
  const r10 = await dispatchTool('memory_compact', { id: 9000001, reason: 'ghost' });
  check('S10 not-found rejected', r10.ok === false && r10.reason === 'not-found', JSON.stringify(r10));

  // ── S11: memory_compact REVERSIBLE ──────────────────────────────────────────────────────
  console.log('\n--- S11 memory_compact reversible ---');
  const z11 = mk({ text: 'second orphan (e21-z11)', embDim: 19, attribute: 'cmp11' });
  const r11c = await dispatchTool('memory_compact', { id: z11, reason: 'compact then reactivate' });
  check('S11 compact ok', r11c.ok === true, JSON.stringify(r11c));
  check('S11 pre-archived', rowStatus(z11)?.status === 'archived' && !!archiveIdx(z11));
  const revived = reactivateMemory(z11);
  check('S11 reactivate returned a row', !!revived, JSON.stringify(revived));
  check('S11 status active again', rowStatus(z11)?.status === 'active');
  check('S11 archive_index dropped', !archiveIdx(z11));

  // ── S12: memory_audit_report ────────────────────────────────────────────────────────────
  console.log('\n--- S12 memory_audit_report ---');
  // Seed an OPEN contradiction pair (do NOT resolve it — the audit must show it pending verdict).
  const cp1 = mk({ text: 'user likes dark mode (e21-cp1)', embDim: 20, attribute: 'aud' });
  const cp2 = mk({ text: 'user likes light mode (e21-cp2)', embDim: 21, attribute: 'aud' });
  linkContradictionPair(cp1, cp2);
  // Seed a low-conf (review-pending) merge so the review queue is non-empty.
  const rm1 = mk({ text: 'user edits in vim (e21-rm1)', embDim: 22, attribute: 'mrg', importance: 0.6 });
  const rm2 = mk({ text: 'user edits in emacs (e21-rm2)', embDim: 23, attribute: 'mrg', importance: 0.6 });
  const rMerge = await dispatchTool('memory_merge', { ids: [rm1, rm2], merge_text: 'User has used both vim and emacs over time (tentative).', confidence: 0.5, rationale: 'low-conf opposite editors' });
  check('S12 seed low-conf merge ok', rMerge.ok === true && rMerge.review_pending === true, JSON.stringify(rMerge));
  const r12 = await dispatchTool('memory_audit_report', {});
  check('S12 report ok', r12.ok === true, JSON.stringify(r12));
  const rep = r12.report;
  check('S12 report has totals', rep && typeof rep.totals?.active === 'number', JSON.stringify(rep && rep.totals));
  const lo = Math.min(cp1, cp2), hi = Math.max(cp1, cp2);
  check('S12 open contradiction pair surfaced', rep && rep.open_contradiction_pairs?.some(p => p.id === lo && p.pair_id === hi), JSON.stringify(rep && rep.open_contradiction_pairs));
  check('S12 review-pending merge surfaced', rep && rep.review_pending_merges?.length >= 1, JSON.stringify(rep && rep.review_pending_merges));
  check('S12 merged_rows count positive', rep && rep.totals?.merged_rows >= 1, JSON.stringify(rep && rep.totals?.merged_rows));
  check('S12 edge histogram has relates_to', rep && rep.live_edge_relations?.some(e => e.relation === 'relates_to'), JSON.stringify(rep && rep.live_edge_relations));
}

console.log('\n========================================');
console.log(`E21 link/compact/audit test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
