// E7 reactivation-on-reference — query-path engine.
//
// Master report §3 scenario B: a memory archived (status='archived') is lost from retrieval, so
// the next reference silently re-inserts a DUPLICATE. E7 keeps a small archive index (memory-
// store.mjs memory_archive_index) of recently-archived L1/L2 rows. When a query embeds close to an
// archived row, we REACTIVATE it (flip active, recall++, importance bump, vec re-inserted) instead
// of letting a later store duplicate it. The reactivated row surfaces to the caller so it's seen
// as referenced, not dropped.
//
// J2 contradiction gate (rule-based by default, LLM off per master report §4 open-decision): before
// promoting, re-check the candidate against NEWER active memories of the same entity/attribute. If a
// newer active fact contradicts it, the candidate is STALE — skip reactivation (leave archived) so
// the stale fact does not surface as truth. A future contradiction-aware reconcile cron can revisit
// skipped rows; E7 intentionally does not half-promote them to a limbo status.
//
// Cardinal: archive_index is L1/L2-only by archiveStaleMemories() construction (E6 guard), so L0/L3
// can never reach here. All-cosine paths honor E13 (isForeignEmbeddingModel filters cross-model rows
// before ranking — a row embedded under a previous model is not reactivate-eligible).
import { searchByEmbedding, isTrivialIntent } from './embedding-engine.mjs';
import { detectContradiction } from './memory-maintenance.mjs';
import { reactivateMemory, getArchivedCandidates, isForeignEmbeddingModel, getMemoriesByEntityAttr, getActiveWithEmbedding, appendEvolvedContext, updateMemoryStatus } from './memory-store.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const REACTIVATION_THRESHOLD = parseFloat(process.env.E7_REACTIVATION_THRESHOLD || '0.85');
const REACTIVATION_TOPK = parseInt(process.env.E7_REACTIVATION_TOPK || '50');
const REACTIVATION_MAX = parseInt(process.env.E7_REACTIVATION_MAX || '5');

// Normalize a row's created_at (SQLite 'YYYY-MM-DD HH:MM:SS' or ISO '...T...') to epoch-ms.
// Returns 0 for missing/invalid (NOT NaN) so comparisons stay total-ordered. The same fix the
// :196 `_ts` helper uses in the E8 store-path; hoisted here so the J2 gate (line ~64) shares it
// instead of comparing raw `m.created_at > full.created_at` STRINGS — a lexicographic compare that
// mis-sorts mixed-format rows ('2026-01-02 ' vs '2026-01-02T...'), and short-circuits to falsy when
// `full.created_at` is null (→ filter keeps nothing → newerActive=[] → stale=false → ALWAYS promote,
// so a possibly-stale archive row with a missing timestamp skipped the gate). Normalizing collapses
// both: an unknown candidate time → 0 → every active same-entity row is "newer" → the contradiction
// scan runs and a stale fact is correctly left archived (conservative, per :67 "do NOT promote").
function _createdTs(row) { try { return new Date(String(row?.created_at || '').replace(' ', 'T')).getTime() || 0; } catch { return 0; } }

// Scan the archive hot set, rerank the query against it, reactivate the high-confidence hits that
// pass the J2 contradiction gate. Returns reactivated rows (already flipped active + vec re-inserted)
// for the caller to surface. Returns [] if nothing eligible. Never throws to the query hot path.
export function tryReactivateCandidates(queryEmbedding, {
  topK = REACTIVATION_TOPK,
  threshold = REACTIVATION_THRESHOLD,
  maxReactivate = REACTIVATION_MAX,
  coneLayers = [1, 2],
} = {}) {
  if (!queryEmbedding) return [];
  let candidates;
  try {
    candidates = getArchivedCandidates(coneLayers, 500)
      .filter(m => m.embedding && !isForeignEmbeddingModel(m));
  } catch (e) {
    if (LOG_DEBUG) console.error('[E7] getArchivedCandidates error:', e.message);
    return [];
  }
  if (candidates.length === 0) return [];

  // searchByEmbedding ranks by cosine (intent='mixed' applies its own 0.3 floor) + returns topK.
  const ranked = searchByEmbedding(queryEmbedding, candidates, topK, 'mixed') || [];
  const hits = ranked.filter(h => (h.score ?? 0) >= threshold).slice(0, maxReactivate);
  // searchByEmbedding trims each hit to {id,text,type,...,created_at,importance,recall_count,score}
  // and DROPS entity/attribute — re-attach the full archived candidate so the J2 gate can map
  // entity/attribute -> newer active rows. Without this the gate saw undefined keys and skipped
  // every contradiction scan, promoting stale facts back as truth.
  const candById = new Map(candidates.map(c => [String(c.id), c]));
  const reactivated = [];
  for (const h of hits) {
    const full = candById.get(String(h.id)) || h;
    // J2 gate: scan NEWER active memories of the same entity/attribute for a contradiction. If the
    // archive candidate is stale (a newer fact changed the preference/state), leave it archived.
    let stale = false;
    try {
      const sameEntity = getMemoriesByEntityAttr(full.entity, full.attribute) || [];
      const candTs = _createdTs(full);
      const newerActive = sameEntity.filter(m => _createdTs(m) > candTs);
      stale = newerActive.some(n => detectContradiction(full.text, n.text) != null);
    } catch (e) {
      // If the contradiction lookup fails, be conservative: do NOT promote a possibly-stale fact.
      if (LOG_DEBUG) console.error('[E7] J2 contradiction scan error:', e.message);
      continue;
    }
    if (stale) continue;
    try {
      const row = reactivateMemory(full.id);
      if (row) reactivated.push(row);
    } catch (e) {
      if (LOG_DEBUG) console.error('[E7] reactivateMemory error for', full.id, ':', e.message);
    }
  }
  return reactivated;
}

// E8 cross-archived dedup — STORE-path engine. Master report §3 scenario B line 107: the store
// path scans BOTH active AND archived (via the E7 archive index) before inserting; on a clean
// match it REACTIVATES (E7) the archived row instead of leaving a duplicate. The v2 store path
// embeds asynchronously (memory-server embed worker), so E8 hooks AFTER the fresh row is embedded
// and persisted — and CRUCIALLY while it is still 'active'. That lets the inherited J2 contradiction
// gate treat the fresh store as the newest row of any shared entity/attribute: an incoming
// re-reference that AGREES with the archived candidate reactivates it (preserve + recall++), while
// one that CONTRADICTS (detectContradiction != null) is caught as stale -> skip, the new memory is
// stored as normal (it is the new truth). This is the E7 gate reused; E8 reuses it to RESURRECT a
// referenced archived fact, then (trivial only) supersedes the fresh as-audit - else keeps both for CRON.
//
// Threshold: strict 0.92 (cross-archived DEDUP), not E7's fuzzy 0.85 (query reference). Archived
// candidates are L1/L2 facets; the fresh store is usually L0 — cross-layer cosine is naturally a
// hair lower, so 0.92 fires only on genuine near-identical re-references, never on loose relations
// (avoids the false-positive-merge = silent-loss risk the master report flags). maxReactivate=1:
// dedup wants the single best match, not a fuzzy handful. E13 foreign-model archived rows are
// filtered before ranking (inherited). Enabled alongside E7 by ENABLE_REACTIVATION (default on).
//
// Option C (ADR-001 fix-b REVERSED): store-time does NO content fold. A content re-reference
// reactivates the archived anchor (E7 machinery: flipped active + recalled + vec re-inserted,
// J2-gated) but does NOT supersede the fresh row - the caller addVecsToIndex-keeps BOTH active +
// searchable, and the CRON (consolidateMemories / consolidateSemantically, Brain-2-gated) merges
// them later. This removes the silent-loss vector: distinct-attribute facts were killed on a pure
// cosine gate (the 4000-line paste that superseded 134 rows). Trivial intents stay exempt - folded
// by reactivate + supersede-as-audit alone, NO LLM, NO cosine bar (greetings carry no fact). Sync
// - no Brain 2 call on the store hot path. Returns {id} for a trivial fold (fresh superseded as
// audit) or null for content (caller addVecsToIndex keeps fresh) / no eligible archived match.
// Never throws to the store hot path.
export function tryCrossArchivedDedup(queryEmbedding, freshCtx, {
  threshold = parseFloat(process.env.E8_DEDUP_THRESHOLD || '0.92'),
  maxReactivate = 1,
  coneLayers = [1, 2],
} = {}) {
  if (!queryEmbedding) return null;
  if (process.env.ENABLE_REACTIVATION === 'false') return null;
  const freshId = freshCtx?.id != null ? String(freshCtx.id) : null;
  const freshText = (freshCtx?.text ?? '').toString();
  const freshTrivial = isTrivialIntent(freshCtx?.intentType);
  try {
    const rows = tryReactivateCandidates(queryEmbedding, { threshold, maxReactivate, coneLayers });
    const anchor = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (!anchor) return null;
    const anchorIdStr = String(anchor.id);
    // No fresh-store ctx to fold against -> skip the fold; the caller addVecsToIndex-keeps the fresh
    // row searchable. (The embed worker always passes freshCtx; this guards stub callers.)
    if (!freshId || !freshText) return null;
    // Trivial exemption (ADR-001): trivials carry no fact -> fold by reactivate+supersede alone,
    // NO LLM call. Anchor stays active with its original text; fresh row superseded as audit.
    if (freshTrivial) {
      updateMemoryStatus(freshId, 'superseded', anchorIdStr);
      if (LOG_DEBUG) console.log(`[E8] cross-archived dedup: folded mem #${freshId} -> anchor #${anchorIdStr} (trivial)`);
      return { id: anchorIdStr };
    }
    // Content path: Option C - ALL content fold deferred to the CRON (consolidateMemories /
    // consolidateSemantically, Brain-2-gated). At store time we do NOT fold on a cosine hit alone:
    // that was the silent-loss vector (distinct-attribute facts superseded-as-audit on a green
    // cosine gate - the 4000-line paste that killed 134 rows). The archived anchor was already
    // reactivated by tryReactivateCandidates above (flipped active, recall++, vec re-inserted,
    // J2 contradiction-gated) so it surfaces as referenced-not-dropped; we keep the fresh row
    // active too (caller addVecsToIndex) and let CRON merge them under a Brain 2 gate. No
    // synthesizeConsolidation call at store time, no supersede - nothing leaves retrieval.
    if (LOG_DEBUG) console.log(`[E8] cross-archived dedup: content re-reference deferred to CRON (#${freshId} <-> #${anchorIdStr})`);
    return null;
  } catch (e) {
    if (LOG_DEBUG) console.error('[E8] cross-archived dedup error:', e.message);
    return null;
  }
}

// E2 A-MEM store-time evolve — STORE-path engine (ACTIVE agree-fold). Master report §3 scenario A
// + step 5: when a fresh store AGREES (non-contradicting) with an EXISTING *active* memory of the
// same intent bucket + entity, we do NOT create a retrieval duplicate — we APPEND the fresh context
// to the older row IN PLACE (A-MEM evolve: metadata.evolved_context[], importance bump) and
// SUPERSEDE-AS-AUDIT the fresh row (audit kept, vec pruned). This is the structural fix for the
// silent-loss vector the §7 symptom names: trivial greetings ("hi" / "nice to meet you") used to
// pile up as L0 near-dups that overwhelmed retrieval; now they fold into a single evolving facet.
//
// Bucket: trivials (greeting/ack/agreement/farewell/thanks/smalltalk) share bucket '__trivial__'
// (interchangeable — folding carries no fact, so NO cosine bar; anchor = oldest = lineage root).
// Content intents cluster by the specific intent_type and REQUIRE cosine >= E2_EVOLVE_THRESHOLD
// (0.85 default) + detectContradiction==null, which rules out silently dropping a distinct,
// contradicting, updating fact.
//
// Cardinal guards: cone_layer 3 (persona) is never a candidate; L0/L1/L2 all evolve (greetings land
// as L0). E13 foreign-model active rows are filtered before matching. Enabled by ENABLE_AEVOLVE
// (default on; independent of ENABLE_REACTIVATION so it survives even if reactivation is disabled).
//
// Runs in the embed worker AFTER E8 (cross-archived) returns null — archived reactivation takes
// precedence; only when no archived dup exists do we check active agree-evolution. Never throws to
// the store worker. Returns { id } of the anchor folded into (caller SUPERSEDEs-as-audit the fresh
// row by it — shape mirrors tryCrossArchivedDedup) or null = normal store (addVecsToIndex).
//
// Option C (ADR-001 fix-b REVERSED): store-time does NO content fold. A content-agree cluster is
// left in place - the caller addVecsToIndex-keeps the fresh row active + searchable and the CRON
// (consolidateMemories / consolidateSemantically, Brain-2-gated) merges it later. This removes the
// silent-loss vector: a fresh distinct-attribute fact was superseded-as-audit on a green cosine +
// detectContradiction==null gate (the 4000-line paste that killed 134 rows). Trivial-intent
// clusters stay exempt (cosine-bar-free oldest-anchor fold, NO LLM, NO content gate) - greetings
// carry no fact, so folding carries no silent-loss risk. E13 foreign-model filter, cone_layer in
// {0,1,2} (L3 never a candidate), and ENABLE_AEVOLVE are preserved. threshold/detectContradiction
// are no longer exercised (content short-circuits before them). Sync - no Brain 2 call on the store
// hot path. Returns {id} for a trivial fold or null (caller addVecsToIndex keeps fresh) for content
// / no eligible active trivial. Never throws to the store worker.
export function tryActiveEvolveDedup(queryEmbedding, freshCtx, {
  threshold = parseFloat(process.env.E2_EVOLVE_THRESHOLD || '0.85'),
} = {}) {
  if (!queryEmbedding) return null;
  if (process.env.ENABLE_AEVOLVE === 'false') return null;
  const freshId = freshCtx?.id != null ? String(freshCtx.id) : null;
  if (!freshId) return null;
  const freshIntent = freshCtx?.intentType || null;
  const freshTrivial = isTrivialIntent(freshIntent);
  const freshEntity = (freshCtx?.entity ?? '').toString();
  const freshText = (freshCtx?.text ?? '').toString();
  const _ts = x => { try { return new Date(String(x?.created_at || '').replace(' ', 'T')).getTime() || 0; } catch { return 0; } };
  try {
    // Content intents: Option C - ALL content fold deferred to the CRON (consolidateMemories /
    // consolidateSemantically, Brain-2-gated). At store time we do NOT fold an active-agree
    // cluster on cosine + detectContradiction alone: that was the silent-loss vector (a fresh
    // distinct-attribute fact superseded-as-audit on a green cosine gate - the 4000-line paste
    // that killed 134 rows). Store the fresh row as normal (caller addVecsToIndex keeps it
    // active + searchable); CRON merges the agree-cluster under a Brain 2 gate. Short-circuit
    // before the candidate scan / rank / contradiction check - all moot once we never fold content.
    if (!freshTrivial) return null;
    const all = getActiveWithEmbedding();
    const cand = all.filter(m =>
      (m.cone_layer === 0 || m.cone_layer === 1 || m.cone_layer === 2)
      && !isForeignEmbeddingModel(m)
      && String(m.id) !== freshId
      && isTrivialIntent(m.intent_type)
      && ((m.entity ?? '') === freshEntity)
    );
    if (cand.length === 0) return null;
    // Trivial fold (ADR-001 exempt): trivials carry no fact -> oldest anchor = lineage root, NO
    // cosine bar, NO LLM call. Raw-append evolved_context; importance NOT bumped (still 0). Fresh
    // row superseded-as-audit (vec pruned, audit row kept) - no silent-loss risk on a greeting.
    const anchor = cand.slice().sort((a, b) =>
      (_ts(a) - _ts(b)) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
    )[0];
    const ok = appendEvolvedContext(anchor.id, [{ id: freshId, text: freshText }], {
      importanceBump: 0,
    });
    if (!ok) return null;
    updateMemoryStatus(freshId, 'superseded', anchor.id);
    if (LOG_DEBUG) console.log(`[E2] active-evolve: folded mem #${freshId} -> anchor #${anchor.id} (trivial)`);
    return { id: anchor.id };
  } catch (e) {
    if (LOG_DEBUG) console.error('[E2] active-evolve error:', e.message);
    return null;
  }
}
