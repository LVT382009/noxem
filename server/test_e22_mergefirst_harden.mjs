// E22 — enrichment-merge-first CRON + review-pending harden — PERMANENT regression test.
//
// Step 7 of the approved 8-step sequence. User update (2026-06-24): a stale memory must NOT rot in the
// archive. Brain 2 / the maintenance CRON FIRST looks for a related active memory to ENRICHMENT-MERGE the
// stale INTO (editMemoryText appends the stale's context to the related — related KEEPS its id + edges +
// status — then the stale is HARD-DELETED, content preserved). Compaction/archive is the FALLBACK for
// REAL orphans only. Plus: a low-conf memory_merge left its originals soft-superseded for review; after
// HARDEN_REVIEW_HOURS the CRON FINALIZES it (hard-deletes originals + clears brain2_review_pending).
//
// Exercises the two exported CRON functions (enrichStaleIntoRelated + hardenReviewPendingMerges) —
// exported precisely so this stays deterministic WITHOUT the embedding-ready gate runMaintenance
// early-returns under (vectorKnnSearch itself needs isVecReady — the basis-vector test db satisfies it).
//
// Validates against the REAL sqlite store (EMBEDDING_DIM=256 basis vectors):
//   S2  enrich happy: stale absorbed INTO related — stale hard-deleted, related survives + text enriched + edit audited.
//   S3  enrich orphan: no related → NOT merged, stays active (left for the archive fallback).
//   S4  enrich + archive cardinal guard: an L0 stale is touched by NEITHER enrich (L1/L2-only) NOR archive → stays active forever.
//   S5  merge-FIRST-then-COMPACT pipeline: an orphan stale skipped by enrich, THEN compacted reversible by archiveStaleMemories.
//   S6  harden happy: aged review-pending merge FINALIZED — originals hard-deleted, merge survives + brain2_review_pending cleared.
//   S7  harden window-not-elapsed: a FRESH review-pending merge NOT hardened (originals survive, pending stays).
//   S8  harden boundary: the SAME fresh merge IS hardened when the window collapses to 0 (originals now gone).
//
// Pure store ops (no LLM). ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors (enrich's vectorKnnSearch
// + the harden path both work without the live embedding engine; mergeMemoriesHard low-conf embed arm is guarded).
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e22.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e22_mergefirst_harden.mjs
import { storeMemory, db, mergeMemoriesHard, getActiveWithEmbedding, archiveStaleMemories } from './memory-store.mjs';
import { enrichStaleIntoRelated, hardenReviewPendingMerges } from './memory-maintenance.mjs';
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
check('S0 enrichStaleIntoRelated exported', typeof enrichStaleIntoRelated === 'function');
check('S0 hardenReviewPendingMerges exported', typeof hardenReviewPendingMerges === 'function');

const memExists = id => !!db.prepare('SELECT 1 AS x FROM memories WHERE id = ?').get(id);
const rowById = id => db.prepare('SELECT id, status, text, entity, attribute, cone_layer, importance FROM memories WHERE id = ?').get(id);
const archiveIdx = id => !!db.prepare('SELECT archived_id FROM memory_archive_index WHERE archived_id = ?').get(id);
const metaOf = id => { try { return JSON.parse(db.prepare('SELECT metadata FROM memories WHERE id = ?').get(id).metadata || '{}'); } catch { return {}; } };
const staleDays = 91;
const ageRow = id => db.prepare("UPDATE memories SET created_at = datetime('now', '-" + staleDays + " days'), recall_count = 0 WHERE id = ?").run(id);
const ageMergeMetadata = id => {
  const oldIso = new Date(Date.now() - staleDays * 86400 * 1000).toISOString();
  let m = metaOf(id);
  m.merged_at = oldIso;
  db.prepare("UPDATE memories SET metadata = ? WHERE id = ?").run(JSON.stringify(m), id);
};

function mk({ text, layer = 1, embDim, entity = 'user', attribute = 'q', imp = 0.5 }) {
  return storeMemory({ session_id: 'e22', type: 'fact', text, metadata: {}, cone_layer: layer, importance: imp, entity, attribute, embedding: basis(embDim) });
}

if (vecReady) {
  // ── S2: enrich happy — stale absorbed INTO related ─────────────────────────────────────
  console.log('\n--- S2 enrich happy ---');
  const related = mk({ text: 'user prefers dark mode (e22-rel)', embDim: 10, attribute: 'pref', imp: 0.7 });
  const stale = mk({ text: 'user mentioned dark mode months prior (e22-stale)', embDim: 10, attribute: 'pref' });
  ageRow(stale); // 91d old, 0 recalls, L1, same entity as related, basis(10) == related -> cosine 1.0
  const r2 = enrichStaleIntoRelated(getActiveWithEmbedding());
  check('S2 enriched=1', r2.enriched === 1, JSON.stringify(r2));
  check('S2 stale hard-deleted (absorbed)', !memExists(stale), `stale #${stale} still present`);
  check('S2 related survives', !!memExists(related) && rowById(related)?.status === 'active');
  check('S2 related id unchanged (in-place enrich)', rowById(related)?.id === related);
  check('S2 related text enriched with stale content', /mentioned dark mode months prior/.test(rowById(related)?.text || ''), JSON.stringify(rowById(related)?.text));
  check('S2 edit audit stamped with absorbed reason', Array.isArray(metaOf(related).brain2_edit) && /absorbed/.test(metaOf(related).brain2_edit.at(-1)?.reason || ''), JSON.stringify(metaOf(related).brain2_edit));

  // ── S3: enrich orphan — no related, stays active ──────────────────────────────────────
  console.log('\n--- S3 enrich orphan ---');
  const orphan = mk({ text: 'unrelated orphan fact (e22-orph)', embDim: 77, attribute: 'orph' });
  ageRow(orphan); // basis(77) orthogonal to the basis(10) related -> cosine 0 < ENRICH_MIN_COSINE
  const r3 = enrichStaleIntoRelated(getActiveWithEmbedding());
  check('S3 orphan not enriched (enriched 0 for this call)', r3.enriched === 0, JSON.stringify(r3));
  check('S3 orphan NOT deleted (left for archive)', !!memExists(orphan));
  check('S3 orphan still active (not archived by enrich)', rowById(orphan)?.status === 'active');

  // ── S4: enrich + archive cardinal guard — L0 stale untouched by both ───────────────────
  console.log('\n--- S4 enrich + archive cardinal guard (L0) ---');
  const l0 = mk({ text: 'raw episode from months ago (e22-l0)', layer: 0, embDim: 88, attribute: 'ep' });
  ageRow(l0);
  const r4 = enrichStaleIntoRelated(getActiveWithEmbedding());
  check('S4 L0 not enriched (cone filter L1/L2)', r4.enriched === 0, JSON.stringify(r4));
  const arch4 = archiveStaleMemories();
  // arch4 counts ALL eligible L1/L2 orphans aged 90d+ (the S3 orphan is also archived here);
  // the cardinal guard is what this step proves — it asserts L0 specifically survives BOTH passes.
  check('S4 archive call did not throw', typeof arch4 === 'number', `archived=${arch4}`);
  check('S4 archive skipped L0 (cardinal)', rowById(l0)?.status === 'active' && !archiveIdx(l0), `l0 status=${rowById(l0)?.status}`);
  check('S4 L0 survives active forever', rowById(l0)?.status === 'active');

  // ── S5: merge-FIRST-then-COMPACT pipeline for a real orphan ────────────────────────────
  console.log('\n--- S5 merge-first then compact-fallback ---');
  const orphan5 = mk({ text: 'genuine orphan (e22-s5)', embDim: 99, attribute: 's5' });
  ageRow(orphan5);
  const r5 = enrichStaleIntoRelated(getActiveWithEmbedding());
  check('S5 orphan skipped by enrich (no related)', r5.enriched === 0, JSON.stringify(r5));
  check('S5 orphan still active before archive', rowById(orphan5)?.status === 'active');
  const arch5 = archiveStaleMemories();
  check('S5 archive compacted the orphan (>=1)', arch5 >= 1, `archived=${arch5}`);
  check('S5 orphan archived (REVERSIBLE compaction fallback)', rowById(orphan5)?.status === 'archived', `status=${rowById(orphan5)?.status}`);
  check('S5 orphan archive_index row exists (reversible)', !!db.prepare('SELECT archived_id FROM memory_archive_index WHERE archived_id = ?').get(orphan5));

  // ── S6: harden happy — aged review-pending merge FINALIZED ─────────────────────────────
  console.log('\n--- S6 harden happy ---');
  const m1 = mk({ text: 'user uses vim (e22-m1)', embDim: 60, attribute: 'hrd', imp: 0.6 });
  const m2 = mk({ text: 'user uses emacs (e22-m2)', embDim: 61, attribute: 'hrd', imp: 0.6 });
  const mg = mergeMemoriesHard([m1, m2], 'User has used both vim and emacs over time (tentative).', { confidence: 0.5, session_id: 'e22' });
  check('S6 seed low-conf merge ok', mg.ok === true && mg.review_pending === true && Number.isFinite(mg.merge_id), JSON.stringify(mg));
  check('S6 originals soft-superseded (survive)', !mg.deleted.length && memExists(m1) && memExists(m2) && rowById(m1)?.status === 'superseded' && rowById(m2)?.status === 'superseded');
  check('S6 merge review_pending stamped', metaOf(mg.merge_id).brain2_review_pending === true);
  ageMergeMetadata(mg.merge_id); // back-date the merge so the review window has elapsed
  const r6 = hardenReviewPendingMerges(24);
  check('S6 hardened=1', r6.hardened === 1, JSON.stringify(r6));
  check('S6 originals HARD-DELETED after harden', !memExists(m1) && !memExists(m2), `m1=${memExists(m1)} m2=${memExists(m2)}`);
  check('S6 merge survives', !!memExists(mg.merge_id) && rowById(mg.merge_id)?.status === 'active');
  check('S6 merge brain2_review_pending CLEARED', metaOf(mg.merge_id).brain2_review_pending === false, JSON.stringify(metaOf(mg.merge_id).brain2_review_pending));

  // ── S7: harden window-not-elapsed — a FRESH merge NOT hardened ────────────────────────
  console.log('\n--- S7 harden window-not-elapsed ---');
  const m3 = mk({ text: 'user picks vscode (e22-m3)', embDim: 62, attribute: 'fr', imp: 0.6 });
  const m4 = mk({ text: 'user picks zed (e22-m4)', embDim: 63, attribute: 'fr', imp: 0.6 });
  const mg2 = mergeMemoriesHard([m3, m4], 'User has tried both vscode and zed (tentative).', { confidence: 0.5, session_id: 'e22' });
  check('S7 seed low-conf merge ok', mg2.ok === true && mg2.review_pending === true, JSON.stringify(mg2));
  const r7 = hardenReviewPendingMerges(24); // fresh merge, merged_at = now -> (now - now) < 24h -> skipped
  check('S7 hardened=0 (window not elapsed)', r7.hardened === 0 && r7.skipped >= 1, JSON.stringify(r7));
  check('S7 originals SURVIVE (soft-superseded)', memExists(m3) && memExists(m4) && rowById(m3)?.status === 'superseded');
  check('S7 merge review_pending STAYS true', metaOf(mg2.merge_id).brain2_review_pending === true);

  // ── S8: harden boundary — the SAME fresh merge hardened when the window collapses to 0 ──
  console.log('\n--- S8 harden boundary (window=0) ---');
  const r8 = hardenReviewPendingMerges(0); // cutoff 0 -> (now - merged_at) >= 0 always -> finalizes
  check('S8 hardened>=1 (the S7 merge finalized)', r8.hardened >= 1, JSON.stringify(r8));
  check('S8 m3 + m4 now HARD-DELETED', !memExists(m3) && !memExists(m4));
  check('S8 merge review_pending CLEARED', metaOf(mg2.merge_id).brain2_review_pending === false);
}

console.log('\n========================================');
console.log(`E22 merge-first/harden test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
