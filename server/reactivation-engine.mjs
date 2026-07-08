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
import { searchByEmbedding } from './embedding-engine.mjs';
import { detectContradiction } from './memory-maintenance.mjs';
import { reactivateMemory, getArchivedCandidates, isForeignEmbeddingModel, getMemoriesByEntityAttr } from './memory-store.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const REACTIVATION_THRESHOLD = parseFloat(process.env.E7_REACTIVATION_THRESHOLD || '0.85');
const REACTIVATION_TOPK = parseInt(process.env.E7_REACTIVATION_TOPK || '50');
const REACTIVATION_MAX = parseInt(process.env.E7_REACTIVATION_MAX || '5');

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
      const newerActive = sameEntity.filter(m => full.created_at && (!m.created_at || m.created_at > full.created_at));
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
