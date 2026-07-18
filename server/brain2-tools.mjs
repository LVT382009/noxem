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

import { embed, searchByEmbedding, estimateImportance, generateContextPrefix, extractEntityAttribute } from './embedding-engine.mjs';
import {
  storeMemory, getMemory, getMemoriesByEntityAttr, getSessionMemories, getMemoryStats,
  getActiveWithEmbedding, editMemoryText, setImportance, flagSupersededBy, appendAnnotation,
  updateMemoryEmbedding, addVecsToIndex,
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
