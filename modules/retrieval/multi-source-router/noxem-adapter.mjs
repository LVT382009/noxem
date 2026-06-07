/**
 * Multi-Source Router — Noxem adapter
 *
 * Adapts OmniRetrieval's source-catalog + LLM-driven routing into Noxem's
 * SQLite + better-sqlite3 architecture. Provides:
 *
 * 1. Source catalog — static registry of Noxem's internal data sources
 *    (memories, procedures, facets, entities, core_memory, memory_edges)
 * 2. LLM-driven query routing — when no entity+attribute direct hit exists,
 *    prompt Brain 2 to select which sources to query (top-3 candidates)
 * 3. Cross-store native query dispatch — generate per-source queries and
 *    merge results into the RRF fusion
 * 4. HyDE query rewriting — for "conceptual" search intent, generate a
 *    hypothetical answer passage before embedding
 * 5. Evidence re-rank stage — lightweight LLM rerank for high-importance queries
 *
 * Integrates with: memory-server.mjs (search pipeline),
 *   memory-store.mjs (prepared statements + db handle),
 *   embedding-engine.mjs (embed / embedBatch),
 *   advisor-engine.mjs / llm-fetch.mjs (async LLM calls)
 */

import { createHash } from 'node:crypto';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const ROUTE_TIMEOUT_MS = parseInt(process.env.ROUTE_TIMEOUT_MS || '3000');
const HYDE_TIMEOUT_MS = parseInt(process.env.HYDE_TIMEOUT_MS || '4000');
const RERANK_TIMEOUT_MS = parseInt(process.env.RERANK_TIMEOUT_MS || '5000');
const RERANK_MIN_CANDIDATES = parseInt(process.env.RERANK_MIN_CANDIDATES || '10');
const ROUTE_CACHE_TTL_MS = parseInt(process.env.ROUTE_CACHE_TTL_MS || '1800000'); // 30 min

// ── Source catalog: describes every internal data source Noxem can query ──

const SOURCE_CATALOG = [
  {
    id: 'memories',
    label: 'Episodic Memories',
    description: 'FTS5 + vector semantic search over all active memories. Best for general queries about facts, preferences, events, issues, patterns.',
    query_type: 'natural language',
    examples: ['what does the user prefer for editing', 'debugging workflow last week'],
    backend: 'fts5+vector',
  },
  {
    id: 'procedures',
    label: 'Procedures & Workflows',
    description: 'Stored procedures with steps, trigger contexts, and context points. Best for "how to" queries and reuse patterns.',
    query_type: 'action keywords',
    examples: ['how to debug memory leak', 'steps for deploying'],
    backend: 'fts5+like',
  },
  {
    id: 'facets',
    label: 'Entity Facets',
    description: 'Per-entity attribute abstractions linked to memories. Best for queries about a specific entity\'s properties.',
    query_type: 'entity name',
    examples: ['project alpha tech stack', 'user preferences'],
    backend: 'entity_id_lookup',
  },
  {
    id: 'entities',
    label: 'Entity Records',
    description: 'Canonical entity names with mention counts. Used to resolve entity references and find related memories.',
    query_type: 'entity name',
    examples: ['entities related to react', 'known projects'],
    backend: 'name_lookup',
  },
  {
    id: 'core_memory',
    label: 'Core Memory Blocks',
    description: 'Persona-level key-value blocks (user identity, critical facts). Best for identity or high-priority lookups.',
    query_type: 'key name',
    examples: ['user name', 'primary language'],
    backend: 'key_lookup',
  },
  {
    id: 'memory_edges',
    label: 'Memory Graph Edges',
    description: 'Typed relationships between memories (references, implements, supersedes, contradicts). Best for tracing causality or contradiction.',
    query_type: 'relationship traversal',
    examples: ['what contradicts X', 'what derives from Y'],
    backend: 'graph_traversal',
  },
];

// ── Route cache: avoids re-prompting LLM for similar queries ──

const _routeCache = new Map(); // normalizedQuery -> { sources, timestamp }

function _normalizeForRouteCache(query) {
  return query.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function _getCachedRoute(query) {
  const norm = _normalizeForRouteCache(query);
  const entry = _routeCache.get(norm);
  if (entry && Date.now() - entry.timestamp < ROUTE_CACHE_TTL_MS) {
    return entry.sources;
  }
  if (_routeCache.size > 500) {
    const oldest = _routeCache.keys().next().value;
    _routeCache.delete(oldest);
  }
  return null;
}

function _setCachedRoute(query, sources) {
  const norm = _normalizeForRouteCache(query);
  _routeCache.set(norm, { sources, timestamp: Date.now() });
}

// ── 1. Source catalog accessor ──

export function getSourceCatalog() {
  return SOURCE_CATALOG;
}

// Build the catalog description string used in LLM prompts
function _formatCatalogForPrompt(catalog) {
  return catalog.map(s =>
    ` - ${s.id} [${s.label} | ${s.description} | query type: ${s.query_type} | examples: ${s.examples.map(e => `"${e}"`).join(', ')}]`
  ).join('\n');
}

// ── 2. LLM-driven query routing ──

/**
 * Route a query to the most relevant Noxem data sources.
 * Returns a ranked list of source IDs (up to 3).
 * Falls back to ['memories'] if LLM is unavailable.
 *
 * @param {string} query - Natural language query
 * @param {object} opts
 * @param {Function} opts.llmFetch - Fetch function for LLM calls
 * @param {string} opts.llmUrl - LLM endpoint URL
 * @param {string} opts.llmModel - LLM model name
 * @param {number} [opts.topK=3] - Max source candidates
 * @returns {Promise<string[]>} Ranked list of source IDs
 */
export async function routeToSources(query, { llmFetch, llmUrl, llmModel, topK = 3 }) {
  const cached = _getCachedRoute(query);
  if (cached) {
    LOG_DEBUG && console.log('[Route] Cache hit for:', query.substring(0, 60));
    return cached;
  }

  const system = (
    'You are a query router for a personal memory system. Given a question, ' +
    'decide which internal data sources to query. Some queries benefit from ' +
    `multiple sources — return up to ${topK} source IDs, most likely first. ` +
    'Return fewer if you are confident the answer is in one source.'
  );

  const catalogStr = _formatCatalogForPrompt(SOURCE_CATALOG);
  const prompt = (
    `Available data sources:\n\n${catalogStr}\n\n` +
    `Question: ${query}\n\n` +
    'Respond with JSON: {"sources": [{"id": "source_id"}, ...]}'
  );

  try {
    const res = await llmFetch(llmUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: 128,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`LLM returned ${res.status}`);

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in LLM response');

    const parsed = JSON.parse(jsonMatch[0]);
    const validIds = new Set(SOURCE_CATALOG.map(s => s.id));
    const sources = (parsed.sources || [])
      .map(s => s.id)
      .filter(id => validIds.has(id))
      .slice(0, topK);

    if (sources.length === 0) throw new Error('No valid sources returned');

    _setCachedRoute(query, sources);
    LOG_DEBUG && console.log('[Route] LLM routed to:', sources.join(', '));
    return sources;
  } catch (err) {
    LOG_DEBUG && console.error('[Route] Falling back to memories:', err.message);
    return ['memories'];
  }
}

// ── 3. Cross-store native query dispatch ──

/**
 * Dispatch a query to a specific Noxem data source and return results.
 * Each source gets a tailored query strategy.
 *
 * @param {string} sourceId - Source to query (from SOURCE_CATALOG)
 * @param {string} query - Original user query
 * @param {object} deps - Dependencies
 * @param {object} deps.db - better-sqlite3 database handle
 * @param {Function} deps.searchMemories - FTS5 search function
 * @param {Function} deps.getMemoriesByEntityAttr - Entity+attribute lookup
 * @param {Function} deps.extractEntityAttribute - Entity extraction function
 * @param {number} [limit=15] - Max results per source
 * @returns {Array} Search results scored and normalized
 */
export function dispatchToSource(sourceId, query, deps, limit = 15) {
  const { db, searchMemories, getMemoriesByEntityAttr, extractEntityAttribute } = deps;

  switch (sourceId) {
    case 'memories':
      return dispatchMemories(query, deps, limit);

    case 'procedures':
      return dispatchProcedures(query, db, limit);

    case 'facets':
      return dispatchFacets(query, db, deps, limit);

    case 'entities':
      return dispatchEntities(query, db, limit);

    case 'core_memory':
      return dispatchCoreMemory(query, db, limit);

    case 'memory_edges':
      return dispatchEdges(query, deps, limit);

    default:
      return [];
  }
}

function dispatchMemories(query, deps, limit) {
  const ftsResults = deps.searchMemories({ query, limit });
  return ftsResults.map(r => ({
    ...r,
    _source: 'memories',
    score: r.score || 0.5,
  }));
}

function dispatchProcedures(query, db, limit) {
  // Extract action keywords from query for procedure matching
  const actionKeywords = _extractActionKeywords(query);
  const results = [];

  for (const kw of actionKeywords) {
    const q = `%${kw}%`;
    const rows = db.prepare(`
      SELECT p.id, p.name, p.description, p.trigger_context, p.use_count,
             GROUP_CONCAT(ps.text, ' | ') as steps_summary
      FROM procedures p
      LEFT JOIN procedure_steps ps ON p.id = ps.procedure_id
      WHERE p.name LIKE ? OR p.description LIKE ? OR p.trigger_context LIKE ? OR ps.text LIKE ?
      GROUP BY p.id
      ORDER BY p.use_count DESC
      LIMIT ?
    `).all(q, q, q, q, Math.min(limit, 20));
    for (const r of rows) {
      if (!results.some(x => x.id === r.id)) {
        results.push({
          id: r.id,
          type: 'procedure',
          text: `${r.name}: ${r.description || r.trigger_context}`,
          score: 0.3 + (r.use_count || 0) * 0.05,
          _source: 'procedures',
        });
      }
    }
  }

  return results.slice(0, limit);
}

function dispatchFacets(query, db, deps, limit) {
  const { extractEntityAttribute } = deps;
  const { entity } = extractEntityAttribute(query);
  if (!entity) return [];

  const results = [];
  const ent = db.prepare('SELECT id, canonical_name FROM entities WHERE canonical_name LIKE ? LIMIT 5')
    .all(`%${entity}%`);

  for (const e of ent) {
    const facets = db.prepare('SELECT * FROM facets WHERE entity_id = ? ORDER BY abstraction_level')
      .all(e.id);
    for (const f of facets) {
      results.push({
        id: f.id,
        type: 'facet',
        text: f.text || `${e.canonical_name} facet (${f.attribute})`,
        entity: e.canonical_name,
        score: 0.4,
        _source: 'facets',
      });
    }
  }

  return results.slice(0, limit);
}

function dispatchEntities(query, db, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (terms.length === 0) return [];

  const conditions = terms.map(() => 'canonical_name LIKE ?').join(' OR ');
  const params = terms.map(t => `%${t}%`);

  const rows = db.prepare(
    `SELECT id, canonical_name, entity_type, mention_count FROM entities
     WHERE ${conditions}
     ORDER BY mention_count DESC LIMIT ?`
  ).all(...params, Math.min(limit, 10));

  return rows.map(r => ({
    id: r.id,
    type: 'entity',
    text: `${r.canonical_name} (${r.entity_type}, mentioned ${r.mention_count}x)`,
    entity: r.canonical_name,
    score: 0.3 + Math.min(r.mention_count * 0.05, 0.3),
    _source: 'entities',
  }));
}

function dispatchCoreMemory(query, db, limit) {
  const terms = query.toLowerCase().split(/\s+/);
  const results = [];
  const allBlocks = db.prepare('SELECT * FROM core_memory ORDER BY key').all();

  for (const block of allBlocks) {
    const blockText = `${block.key} ${block.description} ${block.value}`.toLowerCase();
    const matchCount = terms.filter(t => t.length > 2 && blockText.includes(t)).length;
    if (matchCount > 0) {
      results.push({
        id: block.key,
        type: 'core_block',
        text: `${block.key}: ${block.value}`,
        score: 0.5 + matchCount * 0.1,
        _source: 'core_memory',
      });
    }
  }

  return results.slice(0, limit);
}

function dispatchEdges(query, deps, limit) {
  // Search edges by relation keyword match
  const { db } = deps;
  const relationKeywords = {
    references: ['reference', 'mentioned', 'cited', 'linked'],
    implements: ['implement', 'build', 'create', 'code'],
    derives_from: ['derive', 'origin', 'source', 'comes from'],
    contradicts: ['contradict', 'oppose', 'conflict', 'disagree'],
    supersedes: ['supersede', 'replace', 'update', 'newer'],
    clarifies: ['clarify', 'explain', 'detail', 'elaborate'],
    same_entity: ['related', 'same', 'connected'],
  };

  const lowerQuery = query.toLowerCase();
  const matchedRelations = [];

  for (const [relation, keywords] of Object.entries(relationKeywords)) {
    if (keywords.some(kw => lowerQuery.includes(kw))) {
      matchedRelations.push(relation);
    }
  }

  if (matchedRelations.length === 0) return [];

  const results = [];
  for (const rel of matchedRelations) {
    const edges = db.prepare(
      `SELECT me.*, m.text as from_text, m2.text as to_text
       FROM memory_edges me
       LEFT JOIN memories m ON m.id = me.from_id
       LEFT JOIN memories m2 ON m2.id = me.to_id
       WHERE me.relation = ? AND (me.valid_until IS NULL OR me.valid_until > datetime('now'))
       ORDER BY me.strength DESC LIMIT ?`
    ).all(rel, Math.min(limit, 10));

    for (const e of edges) {
      results.push({
        id: e.id,
        type: 'edge',
        text: `${e.from_text?.substring(0, 80) || '?'} -> ${e.relation} -> ${e.to_text?.substring(0, 80) || '?'}`,
        score: e.strength || 0.5,
        _source: 'memory_edges',
      });
    }
  }

  return results.slice(0, limit);
}

function _extractActionKeywords(query) {
  const lower = query.toLowerCase();
  const actionVerbs = [
    'debug', 'fix', 'deploy', 'build', 'test', 'install', 'configure',
    'setup', 'create', 'delete', 'update', 'search', 'analyze', 'run',
    'monitor', 'refactor', 'migrate', 'compress', 'extract', 'review',
  ];
  const found = actionVerbs.filter(v => lower.includes(v));
  // Also extract nouns >4 chars as fallback
  const words = lower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 4);
  return [...new Set([...found, ...words.slice(0, 3)])];
}

// ── 4. HyDE query rewriting ──

/**
 * Generate a hypothetical document embedding (HyDE) for the query.
 * Prompts Brain 2 to write a brief answer as if it had the information,
 * then the answer is embedded alongside the original query for richer
 * semantic matching in vector search.
 *
 * Returns null if LLM is unavailable or query is too short for HyDE
 * (OmniRetrieval's insight: short keyword queries get worse with HyDE).
 *
 * @param {string} query - Original search query
 * @param {object} opts
 * @param {Function} opts.llmFetch - Fetch function for LLM calls
 * @param {string} opts.llmUrl - LLM endpoint URL
 * @param {string} opts.llmModel - LLM model name
 * @returns {Promise<string|null>} Hypothetical passage, or null
 */
export async function generateHyDE(query, { llmFetch, llmUrl, llmModel }) {
  // OmniRetrieval insight: HyDE hurts short keyword queries
  if (query.trim().split(/\s+/).length <= 3) {
    return null;
  }

  const system = (
    'You are a search query optimizer for a dense retriever in a personal memory system. ' +
    'Given the user query, write a brief hypothetical passage that would be relevant evidence ' +
    'for the query, written in the register and style of stored personal memories. ' +
    'The passage will be embedded and matched against real memories, so favor concrete, ' +
    'in-domain content over generic phrasing. ' +
    'Begin with the user query verbatim, then write the hypothetical passage on the next line. ' +
    'Output only the query followed by the passage -- no preamble, no labels.'
  );

  try {
    const res = await llmFetch(llmUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Question: ${query}` },
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(HYDE_TIMEOUT_MS),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    if (!content || content.length < query.length) return null;

    LOG_DEBUG && console.log('[HyDE] Generated passage of', content.length, 'chars');
    return content;
  } catch (err) {
    LOG_DEBUG && console.error('[HyDE] Failed:', err.message);
    return null;
  }
}

// ── 5. Evidence re-rank stage ──

/**
 * Re-rank search candidates using an LLM evidence selection step.
 * OmniRetrieval's evidence selection recovers from wrong source routing
 * 67-75% of the time by having the LLM judge which results truly answer
 * the question.
 *
 * Only invoked for high-importance queries (expand=true or limit > 20).
 *
 * @param {string} query - Original search query
 * @param {Array} candidates - Top-N search results to re-rank (max 20)
 * @param {object} opts
 * @param {Function} opts.llmFetch - Fetch function for LLM calls
 * @param {string} opts.llmUrl - LLM endpoint URL
 * @param {string} opts.llmModel - LLM model name
 * @returns {Promise<Array>} Filtered and re-ordered results
 */
export async function evidenceRerank(query, candidates, { llmFetch, llmUrl, llmModel }) {
  if (!candidates || candidates.length < RERANK_MIN_CANDIDATES) {
    return candidates;
  }

  const topN = candidates.slice(0, 20);
  const blocks = topN.map((r, i) => {
    const text = (r.text || r.summary || '').substring(0, 150);
    const src = r._source || r.type || 'unknown';
    return `[${i}] ${src} | score=${(r.score || 0).toFixed(3)} | ${text}`;
  });

  const system = (
    'You are a result selector for a personal memory search system. ' +
    'Pick the candidate indices whose result best answers the question. ' +
    'Return only truly relevant results, filtering out false positives.'
  );

  const prompt = (
    `Question: ${query}\n\n` +
    `Candidates (each prefixed with integer index):\n\n` +
    blocks.join('\n') +
    '\n\nRespond with JSON: {"selected": [0, 2, 5]} -- array of relevant indices'
  );

  try {
    const res = await llmFetch(llmUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: 128,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });

    if (!res.ok) return candidates;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return candidates;

    const parsed = JSON.parse(jsonMatch[0]);
    const selectedIndices = (parsed.selected || [])
      .filter(i => Number.isInteger(i) && i >= 0 && i < topN.length);

    if (selectedIndices.length === 0) return candidates;

    const selected = selectedIndices.map(i => topN[i]).filter(Boolean);
    // Add back non-selected that were below top-20
    const remainder = candidates.slice(20);
    LOG_DEBUG && console.log(`[Rerank] Selected ${selected.length}/${topN.length} from ${candidates.length} total`);
    return [...selected, ...remainder];
  } catch (err) {
    LOG_DEBUG && console.error('[Rerank] Failed, returning original order:', err.message);
    return candidates;
  }
}

// ── 6. Multi-source dispatch orchestration ──

/**
 * Execute a full multi-source search: route -> dispatch -> merge.
 *
 * @param {string} query - Natural language query
 * @param {object} deps - Dependencies (db, searchMemories, etc.)
 * @param {object} llmOpts - LLM call options
 * @param {number} [limit=10] - Final result limit
 * @returns {Promise<{results: Array, sources_queried: string[]}>}
 */
export async function multiSourceSearch(query, deps, llmOpts, limit = 10) {
  const { reciprocalRankFusion } = deps;

  // Step 1: Route to sources
  const sourceIds = await routeToSources(query, llmOpts);

  // Step 2: Dispatch to each source in parallel
  const allResults = sourceIds.map(sid => dispatchToSource(sid, query, deps, limit * 2));
  const nonEmpty = allResults.filter(r => r.length > 0);

  if (nonEmpty.length === 0) {
    return { results: [], sources_queried: sourceIds };
  }

  // Step 3: Merge via RRF (if available) or simple dedup
  let merged;
  if (reciprocalRankFusion && nonEmpty.length > 1) {
    merged = reciprocalRankFusion(nonEmpty, 60);
  } else {
    // Simple dedup merge: flatten, dedup by id, sort by score desc
    const seen = new Set();
    merged = [];
    for (const list of nonEmpty) {
      for (const r of list) {
        const key = `${r._source || ''}:${r.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(r);
        }
      }
    }
    merged.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  return {
    results: merged.slice(0, limit),
    sources_queried: sourceIds,
  };
}

export default {
  getSourceCatalog,
  routeToSources,
  dispatchToSource,
  generateHyDE,
  evidenceRerank,
  multiSourceSearch,
};
