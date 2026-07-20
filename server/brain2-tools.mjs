// Phase C-2: noxem-INTERNAL Brain 2 tool suite. NOT an MCP tool, NOT a Hermes plugin — noxem's own
// tools giving Brain 2 (qwenproxy, 1M-context) control over its memory corpus. Used by the augment
// hook in /memory/sync (Phase C-4): Brain 1 chunks at a 2048-token embedding ctx and may split a
// fact across chunks or miss a cross-chunk bridge; Brain 2 re-reads the full session (1M ctx
// headroom), verifies each Brain 1 fact, EDITS incomplete ones (memory_edit), STORES missed ones
// (memory_store), ANNOTATES nuance/provenance (memory_annotate), ranks (memory_set_importance),
// and may FLAG a fact a newer row supersedes (memory_flag_superseded) — but ONLY softly: downrank +
// footnote, the row stays active + retrievable.
//
// Tool-call FORMAT driven by the qwenproxy prompt (hermesprompt.md): the system prompt lists tools as
// [{name,description,parameters}] under `# TOOLS AVAILABLE` + `# TOOL CALLING FORMAT (MANDATORY)`
// using <antml:tool_call>{json}</antml:tool_call>; brain2-agent.mjs parses those tags + dispatches
// here. The adapter (:8000) is backend-agnostic — it just shuttles chat completions.
//
// RECOVERABILITY INVARIANT: none of the mutate handlers call pruneVectors / deleteMemory /
// updateMemoryStatus. Store / edit / rank / flag / annotate mutate text / importance / metadata
// only; status stays 'active'; vec is only REPLACED (storeMemory inserts, editMemoryText
// drops-stale-then-re-embeds). The worst Brain 2 can do is footnote + downrank — it cannot remove a
// fact from retrieval. This closes the 4000-line paste vector at the Brain 2 tool layer too: even a
// wrong judgment is recoverable on the next augment pass / a Brain-2-gated reconcile CRON.
//
// E18 exception (user Option-2, 2026-06-24): memory_merge is the ONE narrow carve-out. It absorbs
// REDUNDANT originals into a Brain2-authored merge row + hard-deletes the originals post-merge
// (content preserved inside the merge text + citation_log + merge_row.metadata.consolidated_from).
// Delete is permitted ONLY as this post-merge step — never as standalone AI judgment. Low confidence
// (<0.7) does NOT hard-delete: originals are soft-superseded (reversible) + brain2_review_pending.
// The cardinal guard (mergeMemoriesHard + hardDeleteMemory, both at the SQL source) refuses L0/L3
// even via a merge, so a Brain2 merge error can never destroy an episode oracle or persona.
//
// memory_compact is the SECOND narrow carve-out, and unlike memory_merge it does NOT hard-delete:
// an orphan stale row (no related memory to enrichment-merge into) is REVERSIBLY demoted to
// 'archived' via archiveMemoryById — status flip + edge cascade + vec prune + archive_index insert +
// a brain2_compact_reason stamp. Reactivation-on-reference (E7) can revive it on a later exact hit.
// It still honors the RECOVERABILITY spirit: the row + its embedding BLOB + the archive_index row
// survive; cardinal guard refuses L0/L3 even here. So Brain2 compaction errors self-heal on reference.

import { embed, searchByEmbedding, estimateImportance, generateContextPrefix, extractEntityAttribute } from './embedding-engine.mjs';
import {
  storeMemory, getMemory, getMemoriesByEntityAttr, getSessionMemories, getMemoryStats,
  getActiveWithEmbedding, editMemoryText, setImportance, flagSupersededBy, appendAnnotation,
  updateMemoryEmbedding, addVecsToIndex, mergeMemoriesHard, resolveContradictionPair,
  storeEdge, archiveMemoryById, getAuditReport,
} from './memory-store.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// Strip the embedding BLOB from any row we hand back to Brain 2 — it never needs raw bytes, and
// keeping it out keeps tool responses small (1M ctx is generous but not infinite).
const _trim = m => {
  if (!m) return null;
  const { embedding, ...rest } = m;
  return rest;
};
// Normalize id/importance to plain numbers (sqlite may return BigInt-safe ints or strings).
const _nums = m => ({ ...m, id: Number(m.id), importance: Number(m.importance) || 0 });

// ── READ tools ──────────────────────────────────────────────
async function h_memory_search({ query, limit = 10 }) {
  if (!query || typeof query !== 'string') return { ok: false, error: 'query required' };
  const lim = Math.min(Math.max(1, Number(limit) || 10), 50);
  try {
    const vec = await embed(query, 'query');
    const active = getActiveWithEmbedding();
    const ranked = searchByEmbedding(vec, active, lim, 'mixed') || [];
    return { ok: true, results: ranked.map(h => _nums({ ...h, score: Number(h.score) || 0 })) };
  } catch (e) {
    LOG_DEBUG && console.error('[Brain2] memory_search error:', e.message);
    return { ok: false, error: e.message };
  }
}
function h_memory_get({ id }) {
  if (!id) return { ok: false, error: 'id required' };
  try { return { ok: true, memory: _trim(getMemory(Number(id))) }; }
  catch (e) { return { ok: false, error: e.message }; }
}
function h_memory_list_by_entity({ entity, attribute = null }) {
  if (!entity) return { ok: false, error: 'entity required' };
  try {
    const rows = (getMemoriesByEntityAttr(entity, attribute) || []).map(_trim);
    return { ok: true, count: rows.length, memories: rows };
  } catch (e) { return { ok: false, error: e.message }; }
}
function h_memory_list_session({ session_id, limit = 50 }) {
  if (!session_id) return { ok: false, error: 'session_id required' };
  try {
    const lim = Math.min(Math.max(1, Number(limit) || 50), 500);
    const rows = (getSessionMemories(session_id, lim) || []).map(_trim);
    return { ok: true, count: rows.length, memories: rows };
  } catch (e) { return { ok: false, error: e.message }; }
}
function h_memory_stats() {
  try { return { ok: true, stats: getMemoryStats() }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ── WRITE/augment — additive store (Brain 1 missed a fact) ──
// Embeds synchronously in-process. Option C philosophy: we do NOT inline-prune a near-dup here; even
// a near-identical insert is non-destructive — the CRON (Brain-2-gated, distinct-fact-aware) later
// dedups/merges under the gate that closed the 134-row loss vector. Storing is always additive.
async function h_memory_store({ text, type = 'fact', entity = '', attribute = '', importance = null, context_prefix = '', session_id = '', metadata = {}, reason = null }) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'text required' };
  try {
    let vec = null;
    try { vec = await embed(text, 'document'); }
    catch (e) { LOG_DEBUG && console.error('[Brain2] memory_store embed miss:', e.message); }
    const { entity: eEnt, attribute: eAttr } = extractEntityAttribute(text);
    const ent = entity || eEnt || '';
    const attr = attribute || eAttr || '';
    const imp = importance != null ? Math.min(1, Math.max(0, Number(importance))) : estimateImportance(text, type);
    const prefix = context_prefix || generateContextPrefix(text, type, session_id);
    const meta = { ...(metadata || {}), source: 'brain2_augment', extraction_method: 'brain2_tool' };
    if (reason) meta.brain2_reason = reason;
    const id = storeMemory({ session_id, type, text, embedding: vec, metadata: meta, importance: imp, context_prefix: prefix, entity: ent, attribute: attr, cone_layer: 0, intent_type: null });
    if (vec) addVecsToIndex([id], [vec]);
    return { ok: true, id: Number(id) };
  } catch (e) { LOG_DEBUG && console.error('[Brain2] memory_store error:', e.message); return { ok: false, error: e.message }; }
}

// ── REFINE — edit text + re-embed (Brain 2 verified a chunked fact was incomplete/wrong) ──
// editMemoryText drops the stale vec + sets the new text; we re-embed new text in-process + reinsert.
// If the embed model is offline, the text update still stands (FTS + by-id retrieval serve it); the
// handler reports reembedded:false so Brain 2 knows vec KNN lags until the next reembed pass.
async function h_memory_edit({ id, new_text, reason = null, context_prefix = null }) {
  if (!id || !new_text || typeof new_text !== 'string') return { ok: false, error: 'id + new_text required' };
  try {
    const r = editMemoryText(Number(id), new_text, { reason, contextPrefix: context_prefix });
    if (!r.ok) return r;
    try {
      const vec = await embed(new_text, 'document');
      updateMemoryEmbedding(Number(id), vec);
      addVecsToIndex([Number(id)], [vec]);
      return { ok: true, id: Number(id), reembedded: true };
    } catch (e) {
      LOG_DEBUG && console.error('[Brain2] memory_edit re-embed miss:', e.message);
      return { ok: true, id: Number(id), reembedded: false, warn: 'text updated; vec re-embed failed — FTS/by-id still serve new text' };
    }
  } catch (e) { LOG_DEBUG && console.error('[Brain2] memory_edit error:', e.message); return { ok: false, error: e.message }; }
}

// ── MERGE — absorb redundant originals into one Brain2-authored merge row (E18 carve-out) ──
// Brain 2 found N same-entity, same-cone-layer memories that restate the same fact in slightly
// different chunks. It writes ONE canonical merge_text that subsumes them all, lists the original
// ids, and sets a confidence. mergeMemoriesHard stores the merge row + provenance
// (metadata.consolidated_from + citation_log citing the survivor) + sets source_memory_ids, then
// (high conf) hard-deletes the originals / (low conf <0.7) soft-supersedes them reversibly with
// brain2_review_pending. We embed merge_text here so the merge row is KNN-retrievable; the store
// layer owns the row insert + the originals' fate (never duplicated here). Bad-input / cardinal /
// cross-entity rejections bubble up as {ok:false, reason} so Brain 2 can self-correct next turn.
async function h_memory_merge({ ids, merge_text, rationale = null, confidence = null, session_id = '', keep_type = null, keep_entity = null }) {
  if (!Array.isArray(ids) || ids.length < 2) return { ok: false, error: 'ids: array of >=2 memory ids required' };
  if (!merge_text || typeof merge_text !== 'string') return { ok: false, error: 'merge_text required' };
  const numIds = ids.map(Number).filter(n => Number.isFinite(n));
  if (numIds.length < 2) return { ok: false, error: 'ids must be >=2 finite numbers' };
  try {
    let vec = null;
    try { vec = await embed(merge_text, 'document'); }
    catch (e) { LOG_DEBUG && console.error('[Brain2] memory_merge embed miss:', e.message); }
    const opts = { rationale, session_id, keep_type, keep_entity, embedding: vec };
    const conf = confidence != null ? Math.min(1, Math.max(0, Number(confidence))) : null;
    if (conf != null) opts.confidence = conf;
    return mergeMemoriesHard(numIds, merge_text, opts);
  } catch (e) { LOG_DEBUG && console.error('[Brain2] memory_merge error:', e.message); return { ok: false, error: e.message }; }
}

// ── RESOLVE CONTRADICTION — explicit reasoning over a pair-link, never silent (D1) ──
// D1 flips the old silent auto-supersede: detectContradiction now pair-links both rows as
// 'contradicted' + surfaces them; THIS tool is where Brain 2 actually decides the verdict. Three
// modes, all non-destructive + recoverable:
//   unlink — false alarm. Clear the contradiction_pair_id on both, restore status='active'.
//   uphold — one side won. Clear the pair, restore both active, then SOFT-flag the loser
//            superseded-by winner (flagSupersededBy: downrank + is_newer_version_of chain edge;
//            status stays active, fully retrievable, reversible).
//   merge  — the pair are facets of one truth. Route to mergeMemoriesHard (high conf>=0.7
//            hard-deletes + clears the inbound pair FK via hardDeleteMemory's _nullPairHD; low conf
//            soft-supersedes both + review_pending). Reuses h_memory_merge's embed path.
// The cardinal guard rides inside mergeMemoriesHard/hardDeleteMemory — L0/L3 never lost. unlink +
// uphold only touch text-adjacent columns, so cardinal rows are safe by construction.
async function h_memory_resolve_contradiction({ id_a, id_b, mode = 'unlink', winner_id = null, merge_text = null, rationale = null, confidence = null, session_id = '' }) {
  const a = Number(id_a), b = Number(id_b);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return { ok: false, error: 'id_a + id_b: two distinct ids required' };
  if (mode === 'unlink') {
    return resolveContradictionPair(a, b, { reason: rationale });
  }
  if (mode === 'uphold') {
    if (winner_id == null || !Number.isFinite(Number(winner_id))) return { ok: false, error: 'uphold requires winner_id (a or b)' };
    return resolveContradictionPair(a, b, { winnerId: Number(winner_id), reason: rationale });
  }
  if (mode === 'merge') {
    if (!merge_text || typeof merge_text !== 'string') return { ok: false, error: 'merge requires merge_text' };
    return h_memory_merge({ ids: [a, b], merge_text, rationale, confidence, session_id });
  }
  return { ok: false, error: `mode must be unlink|uphold|merge, got '${mode}'` };
}

// ── ANNOTATE / RANK / FLAG (soft) ──────────────────────────
function h_memory_annotate({ id, note, tag = 'brain2' }) {
  if (!id || !note) return { ok: false, error: 'id + note required' };
  return appendAnnotation(Number(id), note, { tag });
}
function h_memory_set_importance({ id, importance, reason = null }) {
  if (!id || !Number.isFinite(Number(importance))) return { ok: false, error: 'id + importance required' };
  return setImportance(Number(id), Number(importance), { reason });
}
function h_memory_flag_superseded({ id, superseded_by, reason = null }) {
  if (!id || !superseded_by) return { ok: false, error: 'id + superseded_by required' };
  return flagSupersededBy(Number(id), Number(superseded_by), { reason });
}

// ── LINK (free-form authored edge) — D2/step-5 ─────────────
// The memory_edges.relation column is free-form TEXT (memory-store.mjs insertEdge), so Brain 2 can
// author ANY relationship label its reasoning surfaces — not a closed enum. This is exactly what the user
// asked for: let the agent invent the edge it needs (relates_to, supersedes_explains, dual_of, blocks,
// prerequisites, …) instead of being limited to is_newer_version_of / flagSupersededBy's fixed chain.
// Thin wrapper over storeEdge (which throws on from===to self-ref); params pass straight through.
// Bi-temporal (valid_from/until) + strength captured so a later audit / traversal sees the edge's
// confidence + a reasoning provenance string (why Brain 2 drew it) in the edge metadata.
function h_memory_link({ from_id, to_id, relation, valid_from = null, valid_until = null, strength = 1.0, reason = null, metadata = {} }) {
  if (!Number.isFinite(Number(from_id)) || !Number.isFinite(Number(to_id))) return { ok: false, error: 'from_id + to_id: two finite ids required' };
  if (Number(from_id) === Number(to_id)) return { ok: false, error: 'from_id === to_id: self-referential edge not allowed' };
  if (!relation || typeof relation !== 'string' || !relation.trim()) return { ok: false, error: 'relation: non-empty label required (free-form)' };
  const meta = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  if (reason) meta.brain2_link_reason = reason;
  try {
    const edgeId = storeEdge({
      from_id: Number(from_id), to_id: Number(to_id), relation: relation.trim(),
      valid_from, valid_until, strength: Number.isFinite(Number(strength)) ? Number(strength) : 1.0,
      source_session_id: 'brain2', metadata: meta,
    });
    return { ok: true, edge_id: edgeId, from_id: Number(from_id), to_id: Number(to_id), relation: relation.trim() };
  } catch (e) { LOG_DEBUG && console.error('[Brain2] memory_link error:', e.message); return { ok: false, error: e.message }; }
}

// ── COMPACT (orphan fallback archive) — D1 user Option-2 / step-5 ──
// User update: a stale memory must NOT rot in archive forever. Brain 2 FIRST searches for a related
// memory to enrichment-merge it into (memory_merge), and ONLY if NO related row exists does it fall
// back to compaction here. archiveMemoryById is reversible (reactivate-on-reference, E7) + cardinal
// L0/L3 rows survive forever, so a wrong compaction self-heals. NEVER use this as a substitute for
// merge when a related memory exists — the audit report's open_contradiction_pairs + review_pending
// fields exist precisely so Brain 2 resolves/reconciles THOSE before reaching for compact.
function h_memory_compact({ id, reason = null }) {
  if (!Number.isFinite(Number(id))) return { ok: false, error: 'id: finite memory id required' };
  return archiveMemoryById(Number(id), { reason: reason || 'brain2_compact_orphan_fallback' });
}

// ── AUDIT REPORT — the corpus-shape view Brain 2 reasons from — D1 / step-5 ──
// Read-only aggregation: status totals (active/contradicted/superseded/archived/invalid/merged_rows),
// open contradiction pairs (each reported once via the lower id — these AWAIT a memory_resolve_contradiction
// verdict), low-confidence merges awaiting review (brain2_review_pending set on low-conf memory_merge),
// the consolidated merge-row count, + a live free-form edge histogram. This is the SAME shape the
// maintenance CRON consumes to decide harden-enrichment merges — surfaced to Brain 2 so its next pass
// resolves the open tensions instead of leaving them. No mutation.
function h_memory_audit_report() {
  try { return { ok: true, report: getAuditReport() }; }
  catch (e) { LOG_DEBUG && console.error('[Brain2] memory_audit_report error:', e.message); return { ok: false, error: e.message }; }
}

// ── Registry ───────────────────────────────────────────────
// Each entry: { name, description, parameters(JSON Schema, OpenAI-style), handler(async(args)->JSON) }.
// The handler is stripped for BRAIN2_TOOLS_SPEC (the system-prompt tool list) — Brain 2 only sees
// name + description + parameters, never the handler or the store internals. Handlers are async and
// return a JSON-serializable {ok,...} object the agent loop feeds back as the tool result.
export const BRAIN2_TOOLS = [
  { name: 'memory_search', description: 'Semantic search across all active memories. Returns id/text/entity/attribute/type/importance/score for each hit. Use it to verify what is already stored before editing or storing (avoids duplicates).', handler: h_memory_search,
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Free-text query or the fact to match' }, limit: { type: 'integer', default: 10, minimum: 1, maximum: 50 } }, required: ['query'] } },
  { name: 'memory_get', description: 'Fetch one memory by id including its metadata. Returns the row without the embedding blob.', handler: h_memory_get,
    parameters: { type: 'object', properties: { id: { type: 'integer', description: 'Memory id' } }, required: ['id'] } },
  { name: 'memory_list_by_entity', description: 'List all memories for a given entity, optionally filtered by attribute. Use to inspect the prior facts known about a person, project, or tool before refining them.', handler: h_memory_list_by_entity,
    parameters: { type: 'object', properties: { entity: { type: 'string', description: 'Entity name (person/project/tool/service)' }, attribute: { type: 'string', description: 'Optional attribute filter' } }, required: ['entity'] } },
  { name: 'memory_list_session', description: 'List the memories stored in a session. Use to see exactly what Brain 1 just chunked from the conversation so you can verify each chunked fact against the full context.', handler: h_memory_list_session,
    parameters: { type: 'object', properties: { session_id: { type: 'string' }, limit: { type: 'integer', default: 50 } }, required: ['session_id'] } },
  { name: 'memory_stats', description: 'Database statistics (counts by status, cone layer, type). Use to gauge corpus size and composition.', handler: h_memory_stats, parameters: { type: 'object', properties: {} } },
  { name: 'memory_store', description: 'Store a NEW fact that Brain 1 missed entirely. Additive only — never deletes anything. The maintenance CRON later dedups/merges under the distinct-fact gate, so a near-duplicate insert is safe (non-destructive). Set entity/attribute when extractable.', handler: h_memory_store,
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'The fact sentence to store' }, type: { type: 'string', default: 'fact', description: 'fact|preference|project|setup|goal|pattern|entity|event|issue|learning|profile' }, entity: { type: 'string' }, attribute: { type: 'string' }, importance: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string' } }, required: ['text'] } },
  { name: 'memory_edit', description: 'Correct or expand an existing memory\'s text (Brain 1 chunked it incompletely or rephrased it wrong). Re-embeds the new text; status stays active; the previous text preview is audited in metadata.brain2_edit so the edit is traceable. Non-destructive and recoverable.', handler: h_memory_edit,
    parameters: { type: 'object', properties: { id: { type: 'integer' }, new_text: { type: 'string', description: 'The corrected / completed sentence' }, reason: { type: 'string', description: 'Why the edit (what was wrong/incomplete)' } }, required: ['id', 'new_text'] } },
  { name: 'memory_annotate', description: 'Append a free-form note to a memory (nuance, uncertainty, source provenance, a caveat). Stored in metadata.notes; does not change the memory text or ranking.', handler: h_memory_annotate,
    parameters: { type: 'object', properties: { id: { type: 'integer' }, note: { type: 'string' }, tag: { type: 'string', default: 'brain2' } }, required: ['id', 'note'] } },
  { name: 'memory_set_importance', description: 'Adjust a memory\'s importance from 0 to 1 (how central/dear the fact is). Pure ranking — the memory stays fully retrievable. Recoverable.', handler: h_memory_set_importance,
    parameters: { type: 'object', properties: { id: { type: 'integer' }, importance: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string' } }, required: ['id', 'importance'] } },
  { name: 'memory_flag_superseded', description: 'Soft-flag that a memory is now stale/incorrect and a NEWER memory (superseded_by id) better represents the truth. DOWNRANKS + footnotes the stale row; it STAYS active + retrievable (never removed) so a reconsider can reverse a wrong judgment. Use sparingly and always cite the newer id.', handler: h_memory_flag_superseded,
    parameters: { type: 'object', properties: { id: { type: 'integer', description: 'The stale memory to flag' }, superseded_by: { type: 'integer', description: 'The id of the newer, better memory that now represents the truth' }, reason: { type: 'string', description: 'Why the newer fact supersedes the older' } }, required: ['id', 'superseded_by'] } },
  { name: 'memory_merge', description: 'Merge N (>=2) REDUNDANT same-entity memories that restate the same fact into ONE canonical merge_text you author. Stores the merge row + provenance (consolidated_from + citation_log). High confidence (>=0.7): originals HARD-DELETED (content preserved in the merge text). Low confidence (<0.7): originals SOFT-SUPERSEDED reversibly + brain2_review_pending — never silently finalize an uncertain merge. Cardinal rows (L0 episode / L3 persona) are NEVER deletable, even here — use memory_edit + memory_flag_superseded for those. Use after memory_search confirms the originals are genuinely redundant, not distinct facets.', handler: h_memory_merge,
    parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'integer' }, description: 'The 2+ original memory ids to absorb (same entity, same cone layer, all active)' }, merge_text: { type: 'string', description: 'Your canonical sentence that subsumes every original — preserve all distinct detail, do not drop nuance' }, rationale: { type: 'string', description: 'Why these are redundant facets of one fact' }, confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Merge certainty. >=0.7 hard-deletes originals; <0.7 soft-supersedes them + marks review_pending' }, session_id: { type: 'string' } }, required: ['ids', 'merge_text'] } },
  { name: 'memory_resolve_contradiction', description: 'Resolve a contradiction pair (two rows linked as status=contradicted by the detect pass) — the EXPLICIT reasoning step, never silent. Three modes: unlink (false alarm — clear the pair, both active again), uphold (winner_id wins — clear the pair, soft-flag the loser superseded-by winner, reversible), merge (merge_text — the pair are facets of one truth; folds them into one merge row, same rules as memory_merge: high conf hard-deletes, low conf soft-supersedes). Use after memory_search confirms the two rows genuinely conflict and you have read enough context to decide.', handler: h_memory_resolve_contradiction,
    parameters: { type: 'object', properties: { id_a: { type: 'integer', description: 'First member of the contradiction pair' }, id_b: { type: 'integer', description: 'Second member of the contradiction pair' }, mode: { type: 'string', enum: ['unlink', 'uphold', 'merge'], description: 'unlink = false alarm; uphold = winner_id wins (soft-flag loser); merge = fold into merge_text' }, winner_id: { type: 'integer', description: 'Required for mode=uphold; must equal id_a or id_b' }, merge_text: { type: 'string', description: 'Required for mode=merge — canonical truth that supersedes both sides' }, rationale: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Merge-mode certainty. >=0.7 hard-deletes; <0.7 soft-supersedes + review_pending' }, session_id: { type: 'string' } }, required: ['id_a', 'id_b', 'mode'] } },
  { name: 'memory_link', description: 'Author a FREE-FORM typed edge between two memories. The relation label is NOT a fixed enum — invent exactly the relationship your reasoning surfaced (relates_to, supersedes_explains, dual_of, blocks, prerequisites, caused_by, …). Optionally bi-temporal (valid_from/valid_until) + a 0-1 strength. Use to draw semantic links the cone-layer + supersede edges cannot express, WITHOUT mutating either memory text or status — pure graph enrichment. Self-referential edges are rejected.', handler: h_memory_link,
    parameters: { type: 'object', properties: { from_id: { type: 'integer', description: 'Source memory id' }, to_id: { type: 'integer', description: 'Target memory id' }, relation: { type: 'string', description: 'Free-form relationship label you authored — name the link you found, do not pick from a list' }, valid_from: { type: 'string', description: 'ISO timestamp the edge became true (optional)' }, valid_until: { type: 'string', description: 'ISO timestamp the edge stopped being true (optional; leave null for still-valid)' }, strength: { type: 'number', minimum: 0, maximum: 1, default: 1.0, description: 'Confidence in the link' }, reason: { type: 'string', description: 'Why you drew this edge (recorded in edge metadata for audit)' }, metadata: { type: 'object', description: 'Extra free-form edge metadata' } }, required: ['from_id', 'to_id', 'relation'] } },
  { name: 'memory_compact', description: 'REVERSIBLE orphan fallback. Use ONLY after memory_search found NO related memory to enrichment-merge a stale L1/L2 row into (merge is ALWAYS preferred when a neighbor exists). Demotes the row to archived (out of vector retrieval, its edges cascade-invalidate) + stamps a brain2_compact_reason so the matter is auditable. reactivate-on-reference can revive it on a later exact hit, and the row + its embedding survive — recoverable. L0 episode + L3 persona rows are NEVER compactable (cardinal guard). Never use this on a row that belongs to an open contradiction pair — resolve the pair instead.', handler: h_memory_compact,
    parameters: { type: 'object', properties: { id: { type: 'integer', description: 'The orphan L1/L2 memory to compact (must be active or contradicted; not L0/L3)' }, reason: { type: 'string', description: 'Why compact (NOT merge) — i.e. searched, no related memory found, true orphan' } }, required: ['id'] } },
  { name: 'memory_audit_report', description: 'Read-only corpus-shape report Brain 2 reasons from. Returns status totals (active/contradicted/superseded/archived/invalid/merged_rows), the open contradiction pairs AWAITING a memory_resolve_contradiction verdict, the low-confidence merges awaiting review (brain2_review_pending from low-conf memory_merge), the consolidated merge-row count, + a live free-form edge histogram. Use at the start of a reconcile pass to see what tensions to resolve — no mutation.', handler: h_memory_audit_report, parameters: { type: 'object', properties: {} } },
];

// Spec for the agent system prompt: name + description + parameters only (handlers stripped). This is
// the JSON array placed under `# TOOLS AVAILABLE` so Brain 2 sees the menu but never the store wiring.
export const BRAIN2_TOOLS_SPEC = BRAIN2_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

const _byName = new Map(BRAIN2_TOOLS.map(t => [t.name, t]));

// Dispatch one tool call by name. Defensive: unknown tools + handler throws return {ok:false,error}
// never propagate to the agent loop (which must stay alive across turns). The agent loop logs + feeds
// the error JSON back to Brain 2 so it can self-correct on the next turn.
export async function dispatchTool(name, args = {}) {
  const t = _byName.get(name);
  if (!t) return { ok: false, error: `unknown tool: ${name}` };
  try { return await t.handler(args || {}); }
  catch (e) { LOG_DEBUG && console.error(`[Brain2] dispatchTool ${name} throw:`, e.message); return { ok: false, error: e.message }; }
}
