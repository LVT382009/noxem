/**
 * LLM Wiki Noxem Adapter — Two-step extraction + graph-based retrieval expansion.
 *
 * Adapts LLM Wiki's ingest pipeline and retrieval signals into Noxem's
 * existing SQLite store. Provides:
 *   - Two-step L1 extraction (analyze existing L1 + new L0, then generate)
 *   - 4-signal retrieval expansion (source overlap, edge strength,
 *     shared-entity Jaccard, type affinity)
 *   - Incremental extraction guard (SHA256 hash of L0 text)
 *   - Knowledge gap detection (entities with L1 but no L2, or no edges)
 *   - Cross-link auto-generation (shared-entity related_to edges)
 *
 * Depends on Noxem's memory-store.mjs (db, prepared statements) and
 * llmFetch from llm-fetch.mjs for Brain 2 calls.
 */

// Dependencies injected via initIngestPipeline(db, deps)
let _db, _llmFetch;
let _storeMemory, _getAllActiveMemoriesNoEmbed, _traverseMemoryGraph, _storeEdge;
import { createHash } from 'node:crypto';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '60000');
const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';



export function initIngestPipeline(db, deps = {}) {
  _db = db;
  _llmFetch = deps.llmFetch;
  _storeMemory = deps.storeMemory;
  _getAllActiveMemoriesNoEmbed = deps.getAllActiveMemoriesNoEmbed;
  _traverseMemoryGraph = deps.traverseMemoryGraph;
  _storeEdge = deps.storeEdge;
  _boot();
}

// 4-signal weights from LLM Wiki's graph-relevance.ts
const EXPANSION_WEIGHTS = {
  sourceOverlap: 4.0,   // memories sharing the same entity field
  edgeStrength: 3.0,     // existing typed edges between memories
  sharedEntityJaccard: 1.5, // Jaccard of entity neighbors (Adamic-Adar approx)
  typeAffinity: 1.0,     // same type bonus
};

// Type affinity matrix — mirrors LLM Wiki's TYPE_AFFINITY
const TYPE_AFFINITY = {
  fact:       { fact: 0.8, preference: 1.0, project: 1.2, entity: 1.0, setup: 1.0, goal: 1.0, reasoning: 0.8 },
  preference: { fact: 1.0, preference: 0.8, project: 1.0, entity: 1.0, setup: 1.2, goal: 0.8, reasoning: 0.8 },
  project:    { fact: 1.2, preference: 1.0, project: 0.8, entity: 1.0, setup: 1.0, goal: 1.2, reasoning: 1.0 },
  entity:     { fact: 1.0, preference: 1.0, project: 1.0, entity: 0.8, setup: 1.0, goal: 1.0, reasoning: 1.0 },
  setup:      { fact: 1.0, preference: 1.2, project: 1.0, entity: 1.0, setup: 0.8, goal: 1.0, reasoning: 0.8 },
  goal:       { fact: 1.0, preference: 0.8, project: 1.2, entity: 1.0, setup: 1.0, goal: 0.8, reasoning: 1.0 },
  reasoning:  { fact: 0.8, preference: 0.8, project: 1.0, entity: 1.0, setup: 0.8, goal: 1.0, reasoning: 0.8 },
};

// ── Lazy init ───────────────────────────────────────────────
let _booted = false;
let getActiveL1ByEntity;
let getEntityPairsSharedNoEdge;
let getActiveL0BySession;
let getNeighborsOfMemory;
let getActiveL1BySession;
let getEntitiesWithL1NoL2;
let getEntitiesWithNoEdges;
let getEdgesByMemoryPair;

function _boot() {
  if (_booted) return;
  getActiveL0BySession = _db.prepare(`
  SELECT id, text, type, entity, created_at
  FROM memories
  WHERE session_id = ? AND (cone_layer = 0 OR cone_layer IS NULL) AND status = 'active'
  ORDER BY created_at DESC
  LIMIT ?
  `);
  getActiveL1BySession = _db.prepare(`
  SELECT id, text, type, entity, attribute, importance, metadata, created_at
  FROM memories
  WHERE session_id = ? AND cone_layer = 1 AND status = 'active'
  ORDER BY created_at DESC
  LIMIT ?
  `);
  getActiveL1ByEntity = _db.prepare(`
  SELECT id, text, type, entity, attribute, importance
  FROM memories
  WHERE entity = ? AND cone_layer = 1 AND status = 'active'
  ORDER BY importance DESC
  LIMIT ?
  `);
  getEntitiesWithL1NoL2 = _db.prepare(`
  SELECT m.entity, COUNT(*) as l1_count
  FROM memories m
  WHERE m.cone_layer = 1 AND m.status = 'active' AND m.entity != ''
  AND NOT EXISTS (
  SELECT 1 FROM memories m2
  WHERE m2.entity = m.entity AND m2.cone_layer = 2 AND m2.status = 'active'
  )
  GROUP BY m.entity
  ORDER BY l1_count DESC
  LIMIT ?
  `);
  getEntitiesWithNoEdges = _db.prepare(`
  SELECT m.entity, COUNT(*) as mem_count
  FROM memories m
  WHERE m.status = 'active' AND m.entity != ''
  AND NOT EXISTS (
  SELECT 1 FROM memory_entities me
  JOIN memory_edges e ON (e.from_id = me.memory_id OR e.to_id = me.memory_id)
  WHERE me.entity_id = (
  SELECT e2.id FROM entities e2 WHERE e2.canonical_name = m.entity
  )
  AND (e.valid_until IS NULL OR e.valid_until > datetime('now'))
  )
  GROUP BY m.entity
  ORDER BY mem_count DESC
  LIMIT ?
  `);
  getEntityPairsSharedNoEdge = _db.prepare(`
  SELECT m1.entity as entity_a, m2.entity as entity_b, COUNT(*) as shared_count
  FROM memories m1
  JOIN memories m2 ON m1.entity != m2.entity AND m1.entity != '' AND m2.entity != ''
  JOIN memory_entities me1 ON me1.memory_id = m1.id
  JOIN memory_entities me2 ON me2.memory_id = m2.id
  WHERE me1.entity_id = me2.entity_id
  AND m1.status = 'active' AND m2.status = 'active'
  AND m1.id < m2.id
  AND NOT EXISTS (
  SELECT 1 FROM memory_edges e
  WHERE (e.from_id = m1.id AND e.to_id = m2.id)
  OR (e.from_id = m2.id AND e.to_id = m1.id)
  AND (e.valid_until IS NULL OR e.valid_until > datetime('now'))
  )
  GROUP BY m1.entity, m2.entity
  HAVING shared_count >= ?
  ORDER BY shared_count DESC
  LIMIT ?
  `);
  getEdgesByMemoryPair = _db.prepare(`
  SELECT id, strength, relation
  FROM memory_edges
  WHERE ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
  AND (valid_until IS NULL OR valid_until > datetime('now'))
  `);
  getNeighborsOfMemory = _db.prepare(`
  SELECT me.entity_id, e.canonical_name
  FROM memory_entities me
  JOIN entities e ON e.id = me.entity_id
  WHERE me.memory_id = ?
  `);
  _booted = true;
}
// ── Incremental extraction guard ─────────────────────────────────────

const sessionL0HashCache = new Map(); // sessionId -> { hash, lastL0Count }

/**
 * Compute SHA256 hash of concatenated L0 episode texts for a session.
 * Used to skip extraction when nothing has changed since last run.
 *
 * @param {string} sessionId
 * @returns {{ hash: string, count: number }}
 */
export function computeL0Hash(sessionId) {
  const episodes = getActiveL0BySession.all(sessionId, 30);
  const combined = episodes.map(m => m.text).join('\n');
  const hash = createHash('sha256').update(combined).digest('hex').substring(0, 16);
  return { hash, count: episodes.length };
}

/**
 * Check if L0 content has changed since the last extraction.
 * Returns true if extraction should proceed, false if skip.
 *
 * @param {string} sessionId
 * @returns {boolean} true = extraction needed, false = skip
 */
export function shouldExtractL1(sessionId) {
  const current = computeL0Hash(sessionId);
  const cached = sessionL0HashCache.get(sessionId);

  if (cached && cached.hash === current.hash && cached.lastL0Count === current.count) {
    LOG_DEBUG && console.log(`[IngestPipeline] L0 hash unchanged for session ${sessionId}, skipping extraction`);
    return false;
  }

  // Update cache — will be saved on successful extraction
  sessionL0HashCache.set(sessionId, { hash: current.hash, lastL0Count: current.count });
  return true;
}

/**
 * Mark that extraction completed for a session (updates cache count).
 *
 * @param {string} sessionId
 */
export function markExtractionComplete(sessionId) {
  const cached = sessionL0HashCache.get(sessionId);
  if (cached) {
    cached.lastL0Count = computeL0Hash(sessionId).count;
  }
}

// ── Two-step L1 extraction ───────────────────────────────────────────

/**
 * Call Brain 2 with a prompt and return the response content.
 */
async function callBrain2(messages, maxTokens = 1024) {
  const res = await _llmFetch(LLM_URL, {
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Brain 2 HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Extract a balanced JSON array from LLM output.
 */
function extractBalancedArray(text) {
  text = text.replace(/\r/g, '');
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inStr) { escape = !escape; continue; }
    if (ch === '"' && inStr) { if (!escape) { inStr = false; } escape = false; continue; }
    if (ch === '"' && !inStr) { inStr = true; escape = false; continue; }
    escape = false;
    if (inStr) continue;
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth === 0) return text.substring(start, i + 1); }
  }
  return null;
}

/**
 * Two-step L1 extraction: Step 1 (Analysis) reads existing L1 + new L0,
 * Step 2 (Generation) produces L1 atoms with source tracing.
 *
 * This prevents duplicate extraction and improves quality by grounding
 * new extraction in existing knowledge.
 *
 * @param {string} sessionId - Session to extract from
 * @param {Object} [opts]
 * @param {Function} [opts.embedFn] - Async function to embed text -> Float32Array
 * @param {Function} [opts.storeFn] - Function to store a memory, defaults to memory-store.storeMemory
 * @returns {Promise<Object>} { extracted: number, new: number, updated: number, skipped: number }
 */
export async function twoStepExtractL1(sessionId, opts = {}) {
  if (!shouldExtractL1(sessionId)) {
    return { extracted: 0, new: 0, updated: 0, skipped: 1 };
  }

  // Fetch existing L1 and new L0 memories
  const l0Mems = getActiveL0BySession.all(sessionId, 20);
  const l1Mems = getActiveL1BySession.all(sessionId, 30);

  if (l0Mems.length < 1) return { extracted: 0, new: 0, updated: 0, skipped: 0 };

  // ── Step 1: Analysis ──────────────────────────────────────────────
  const l0Text = l0Mems.map(m => `[${m.type}] ${m.text}`).join('\n');
  const l1Text = l1Mems.length > 0
    ? l1Mems.map(m => `[${m.type}|${m.entity}] ${m.text}`).join('\n')
    : '(no existing L1 memories)';

  const analysisResponse = await callBrain2([
    {
      role: 'system',
      content: `Analyze these new conversation memories against existing extracted facts. Identify:
1. NEW facts not yet in the existing list
2. UPDATED facts that contradict or refine existing ones
3. ALREADY KNOWN facts that are already captured

Return a JSON array of analysis items: [{"action":"new|update|known","text":"the fact","entity":"...","attribute":"...","type":"fact|preference|setup|project|goal|entity","source_ids":[1,2],"old_text":"(if update, the existing text being updated)"}]. Max 10 items.`,
    },
    {
      role: 'user',
      content: `EXISTING L1 FACTS:\n${l1Text}\n\nNEW CONVERSATION MEMORIES (with IDs):\n${l0Mems.map(m => `[id=${m.id}] [${m.type}] ${m.text}`).join('\n')}`,
    },
  ]);

  const analysisArrayStr = extractBalancedArray(analysisResponse);
  if (!analysisArrayStr) {
    LOG_DEBUG && console.warn('[IngestPipeline] Step 1 analysis returned no JSON array');
    return { extracted: 0, new: 0, updated: 0, skipped: 0 };
  }

  let analysisItems;
  try { analysisItems = JSON.parse(analysisArrayStr); } catch {
    return { extracted: 0, new: 0, updated: 0, skipped: 0 };
  }
  if (!Array.isArray(analysisItems)) return { extracted: 0, new: 0, updated: 0, skipped: 0 };

  // ── Step 2: Generation with source tracing ────────────────────────
  const newItems = analysisItems.filter(item => item.action === 'new' || item.action === 'update');
  const knownCount = analysisItems.filter(item => item.action === 'known').length;

  if (newItems.length === 0) {
    LOG_DEBUG && console.log(`[IngestPipeline] Step 2: no new facts to generate (${knownCount} already known)`);
    markExtractionComplete(sessionId);
    return { extracted: analysisItems.length, new: 0, updated: 0, skipped: 0 };
  }

  // Generate L1 atoms with source tracing
  const generateResponse = await callBrain2([
    {
      role: 'system',
      content: `Generate structured L1 memory atoms from these analysis items. Each atom must include source_memory_ids referencing the L0 episode IDs it was derived from. Return ONLY a JSON array: [{"text":"...","type":"fact|preference|setup|project|goal|entity","entity":"...","attribute":"...","source_memory_ids":[1,2]}]. Max 10 items.`,
    },
    {
      role: 'user',
      content: JSON.stringify(newItems.slice(0, 10)),
    },
  ]);

  const genArrayStr = extractBalancedArray(generateResponse);
  if (!genArrayStr) {
    LOG_DEBUG && console.warn('[IngestPipeline] Step 2 generation returned no JSON array');
    return { extracted: analysisItems.length, new: 0, updated: 0, skipped: 0 };
  }

  let generatedAtoms;
  try { generatedAtoms = JSON.parse(genArrayStr); } catch {
    return { extracted: analysisItems.length, new: 0, updated: 0, skipped: 0 };
  }
  if (!Array.isArray(generatedAtoms)) return { extracted: analysisItems.length, new: 0, updated: 0, skipped: 0 };

  // Store the generated L1 atoms
  const embedFn = opts.embedFn || null;
  const storeFn = opts.storeFn || null;

  let newCount = 0;
  let updatedCount = 0;

  for (const atom of generatedAtoms.slice(0, 10)) {
    if (!atom.text || !atom.type) continue;

    let embedding = null;
    if (embedFn) {
      try { embedding = await embedFn(atom.text); } catch { /* embedding failure is non-critical */ }
    }

    const sourceIds = Array.isArray(atom.source_memory_ids) ? atom.source_memory_ids : [];

    if (storeFn) {
      // Use caller-provided store function
      storeFn({
        text: atom.text,
        type: atom.type,
        session_id: sessionId,
        entity: atom.entity || '',
        attribute: atom.attribute || '',
        cone_layer: 1,
        embedding,
        metadata: { source_memory_ids: sourceIds },
      });
    } else {
      // Direct store via injected dep
      if (_storeMemory) {
        try {
          _storeMemory({
            text: atom.text,
            type: atom.type,
            session_id: sessionId,
            entity: atom.entity || '',
            attribute: atom.attribute || '',
            cone_layer: 1,
            embedding,
            metadata: { source_memory_ids: sourceIds },
          });
        } catch (e) {
          LOG_DEBUG && console.error('[IngestPipeline] Store failed:', e.message);
          continue;
        }
      }
    }

    // Determine if this was new or an update
    const matchingAnalysis = analysisItems.find(a => a.text && atom.text.includes(a.text.substring(0, 30)));
    if (matchingAnalysis && matchingAnalysis.action === 'update') {
      updatedCount++;
    } else {
      newCount++;
    }
  }

  markExtractionComplete(sessionId);
  LOG_DEBUG && console.log(`[IngestPipeline] Two-step extraction: ${newCount} new, ${updatedCount} updated, ${knownCount} known, ${analysisItems.length} total analyzed`);
  return { extracted: analysisItems.length, new: newCount, updated: updatedCount, skipped: 0 };
}

// ── 4-signal retrieval expansion ─────────────────────────────────────

/**
 * Calculate 4-signal relevance score between two memories.
 * Mirrors LLM Wiki's calculateRelevance with Noxem's data model.
 *
 * Signal 1: Source overlap (weight 4.0) — memories sharing the same entity
 * Signal 2: Edge strength (weight 3.0) — existing typed edges
 * Signal 3: Shared-entity Jaccard (weight 1.5) — overlap of entity neighbors
 * Signal 4: Type affinity (weight 1.0) — same type bonus
 *
 * @param {Object} memA - { id, entity, type } of memory A
 * @param {Object} memB - { id, entity, type } of memory B
 * @returns {number} Relevance score (0+)
 */
export function calculateRelevance(memA, memB) {
  if (memA.id === memB.id) return 0;

  // Signal 1: Source overlap — same entity (weight 4.0)
  let sourceOverlapScore = 0;
  if (memA.entity && memB.entity && memA.entity === memB.entity) {
    sourceOverlapScore = EXPANSION_WEIGHTS.sourceOverlap;
  }

  // Signal 2: Edge strength — existing edges (weight 3.0)
  let edgeStrengthScore = 0;
  try {
    const edge = getEdgesByMemoryPair.get(memA.id, memB.id, memB.id, memA.id);
    if (edge) {
      edgeStrengthScore = (edge.strength || 0.5) * EXPANSION_WEIGHTS.edgeStrength;
    }
  } catch { /* no edge data */ }

  // Signal 3: Shared-entity Jaccard / Adamic-Adar approx (weight 1.5)
  let sharedEntityScore = 0;
  try {
    const neighborsA = getNeighborsOfMemory.all(memA.id);
    const neighborsB = getNeighborsOfMemory.all(memB.id);
    const setA = new Set(neighborsA.map(n => n.entity_id));
    const setB = new Set(neighborsB.map(n => n.entity_id));
    let intersection = 0;
    for (const id of setA) {
      if (setB.has(id)) intersection++;
    }
    if (intersection > 0) {
      const union = setA.size + setB.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;
      sharedEntityScore = jaccard * EXPANSION_WEIGHTS.sharedEntityJaccard;
    }
  } catch { /* no entity data */ }

  // Signal 4: Type affinity (weight 1.0)
  let typeAffinityScore = 0;
  const affinityMap = TYPE_AFFINITY[memA.type];
  if (affinityMap) {
    typeAffinityScore = (affinityMap[memB.type] ?? 0.5) * EXPANSION_WEIGHTS.typeAffinity;
  } else {
    typeAffinityScore = memA.type === memB.type ? 1.0 * EXPANSION_WEIGHTS.typeAffinity : 0.5 * EXPANSION_WEIGHTS.typeAffinity;
  }

  return sourceOverlapScore + edgeStrengthScore + sharedEntityScore + typeAffinityScore;
}

/**
 * Expand a set of hit memory IDs using 4-signal graph expansion.
 * For each hit, score all candidate neighbors and add the top-scoring
 * ones to the result set. Used after initial vector/FTS search to
 * catch structurally-related memories that vector search misses.
 *
 * @param {number[]} hitIds - IDs of initial search hits
 * @param {Object} [opts]
 * @param {number} [opts.maxExpand] - Max new memories to add (default 10)
 * @param {number} [opts.minRelevance] - Minimum relevance to include (default 0.5)
 * @returns {Promise<Array>} Expanded hit objects: [{ id, relevance, signals }]
 */
export async function expandWithGraphSignals(hitIds, opts = {}) {
  const maxExpand = opts.maxExpand || 10;
  const minRelevance = opts.minRelevance || 0.5;

  if (!hitIds || hitIds.length === 0) return [];

  // Fetch all active memories for candidate pool (no embeddings for perf)
  if (!_getAllActiveMemoriesNoEmbed) return [];
  const allMems = _getAllActiveMemoriesNoEmbed();
  const memById = new Map(allMems.map(m => [m.id, m]));
  const hitSet = new Set(hitIds);

  // Collect hits with their basic info
  const hits = [];
  for (const id of hitIds) {
    const mem = memById.get(id);
    if (mem) hits.push(mem);
  }

  // For each hit, find candidate neighbors and score them
  const candidateScores = new Map(); // candidateId -> { totalRelevance, signals, sourceHitId }

  for (const hit of hits) {
    // Get graph neighbors of this hit
    if (!_traverseMemoryGraph) continue;
    const edges = _traverseMemoryGraph(hit.id, 1, 20);

    // Score each neighbor that is not already a hit
    for (const edge of edges) {
      const neighborId = edge.to_id !== hit.id ? edge.to_id : edge.from_id;
      if (hitSet.has(neighborId)) continue;

      const neighbor = memById.get(neighborId);
      if (!neighbor || neighbor.status !== 'active') continue;

      const relevance = calculateRelevance(
        { id: hit.id, entity: hit.entity, type: hit.type },
        { id: neighbor.id, entity: neighbor.entity, type: neighbor.type },
      );

      if (relevance >= minRelevance) {
        const existing = candidateScores.get(neighborId);
        if (!existing || relevance > existing.totalRelevance) {
          candidateScores.set(neighborId, {
            totalRelevance: relevance,
            signals: {
              sourceOverlap: hit.entity && neighbor.entity && hit.entity === neighbor.entity,
              edgeStrength: edge.strength || 0.5,
              edgeRelation: edge.relation,
            },
            sourceHitId: hit.id,
          });
        }
      }
    }
  }

  // Sort candidates by relevance and take top-N
  const expanded = [];
  const sortedCandidates = [...candidateScores.entries()]
    .sort((a, b) => b[1].totalRelevance - a[1].totalRelevance);

  for (const [id, scoreData] of sortedCandidates) {
    if (expanded.length >= maxExpand) break;
    const mem = memById.get(id);
    if (!mem) continue;

    expanded.push({
      id,
      text: mem.text?.substring(0, 200) || '',
      type: mem.type,
      entity: mem.entity,
      relevance: scoreData.totalRelevance,
      signals: scoreData.signals,
      sourceHitId: scoreData.sourceHitId,
    });
  }

  LOG_DEBUG && console.log(`[IngestPipeline] Graph expansion: ${hitIds.length} hits -> ${expanded.length} additional memories`);
  return expanded;
}

// ── Knowledge gap detection ──────────────────────────────────────────

/**
 * Detect knowledge gaps in the memory store.
 * 1. Entities with L1 memories but no L2 scene (synthesis gap)
 * 2. Entities with memories but no edges to other entities (isolation gap)
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit] - Max gaps to return per category (default 20)
 * @returns {Object} { synthesis_gaps: [...], isolation_gaps: [...] }
 */
export function detectKnowledgeGaps(opts = {}) {
  const limit = opts.limit || 20;

  const synthesisGaps = getEntitiesWithL1NoL2.all(limit).map(row => ({
    entity: row.entity,
    l1_count: row.l1_count,
    gap_type: 'synthesis',
    description: `Entity "${row.entity}" has ${row.l1_count} L1 facts but no L2 scene summary`,
  }));

  const isolationGaps = getEntitiesWithNoEdges.all(limit).map(row => ({
    entity: row.entity,
    mem_count: row.mem_count,
    gap_type: 'isolation',
    description: `Entity "${row.entity}" has ${row.mem_count} memories but no graph edges`,
  }));

  LOG_DEBUG && console.log(`[IngestPipeline] Knowledge gaps: ${synthesisGaps.length} synthesis, ${isolationGaps.length} isolation`);
  return { synthesis_gaps: synthesisGaps, isolation_gaps: isolationGaps };
}

// ── Cross-link auto-generation ───────────────────────────────────────

/**
 * Auto-generate related_to edges between memories that share entities
 * but have no direct edge. This builds associative structure that
 * single-session extraction misses.
 *
 * @param {Object} [opts]
 * @param {number} [opts.minShared] - Minimum shared entities to create edge (default 2)
 * @param {number} [opts.limit] - Max edges to create (default 50)
 * @param {string} [opts.sourceSessionId] - Session ID for created edges (default 'maintenance')
 * @returns {Promise<Array>} Created edges: [{ from_id, to_id, shared_count }]
 */
export async function autoGenerateCrossLinks(opts = {}) {
  const minShared = opts.minShared || 2;
  const limit = opts.limit || 50;
  const sourceSessionId = opts.sourceSessionId || 'maintenance';

  if (!_storeEdge) return [];

  const pairs = getEntityPairsSharedNoEdge.all(minShared, limit);
  const created = [];

  for (const pair of pairs) {
    try {
      const edgeId = _storeEdge({
        from_id: pair.entity_a_id || pair.entity_a,
        to_id: pair.entity_b_id || pair.entity_b,
        relation: 'related_to',
        strength: Math.min(0.3 + pair.shared_count * 0.1, 0.9),
        source_session_id: sourceSessionId,
        metadata: { auto_generated: true, shared_entity_count: pair.shared_count },
      });
      created.push({
        from_entity: pair.entity_a,
        to_entity: pair.entity_b,
        shared_count: pair.shared_count,
        edge_id: edgeId,
      });
    } catch (e) {
      // Self-referential or duplicate edge — skip
      LOG_DEBUG && console.warn('[IngestPipeline] Cross-link creation failed:', e.message);
    }
  }

  LOG_DEBUG && console.log(`[IngestPipeline] Cross-link auto-generation: ${created.length} edges created`);
  return created;
}

/**
 * Alternative cross-link strategy: find memory pairs (not entity pairs)
 * that share the same entity field but have no edge between them.
 * Simpler and more reliable than the entity_id-based query.
 *
 * @param {Object} [opts]
 * @param {number} [opts.minSharedEntity] - Minimum shared entities to link (default 2)
 * @param {number} [opts.limit] - Max edges to create (default 50)
 * @param {string} [opts.sourceSessionId] - Session ID for created edges
 * @returns {Promise<Array>} Created edges
 */
export async function autoLinkMemoriesBySharedEntity(opts = {}) {
  const minSharedEntity = opts.minSharedEntity || 2;
  const limit = opts.limit || 50;
  const sourceSessionId = opts.sourceSessionId || 'maintenance';

  if (!_storeEdge || !_getAllActiveMemoriesNoEmbed) return [];

  // Group active memories by entity
  const allMems = _getAllActiveMemoriesNoEmbed();
  const memsByEntity = new Map();
  for (const mem of allMems) {
    if (!mem.entity) continue;
    if (!memsByEntity.has(mem.entity)) memsByEntity.set(mem.entity, []);
    memsByEntity.get(mem.entity).push(mem);
  }

  // For each entity with 2+ memories, check if they have shared entities
  // and no edge between them
  const created = [];
  const seen = new Set();

  for (const [entity, mems] of memsByEntity) {
    if (mems.length < minSharedEntity) continue;
    if (created.length >= limit) break;

    // Pair memories within this entity group
    for (let i = 0; i < mems.length && created.length < limit; i++) {
      for (let j = i + 1; j < mems.length && created.length < limit; j++) {
        const key = `${mems[i].id}-${mems[j].id}`;
        if (seen.has(key)) continue;

        // Check if edge already exists
        const existingEdge = getEdgesByMemoryPair.get(mems[i].id, mems[j].id, mems[j].id, mems[i].id);
        if (existingEdge) { seen.add(key); continue; }

        try {
          const edgeId = _storeEdge({
            from_id: mems[i].id,
            to_id: mems[j].id,
            relation: 'related_to',
            strength: 0.3,
            source_session_id: sourceSessionId,
            metadata: { auto_generated: true, shared_entity: entity },
          });
          created.push({
            from_id: mems[i].id,
            to_id: mems[j].id,
            shared_entity: entity,
            edge_id: edgeId,
          });
          seen.add(key);
        } catch { /* skip invalid pairs */ }
      }
    }
  }

  LOG_DEBUG && console.log(`[IngestPipeline] Memory cross-links: ${created.length} edges created from ${memsByEntity.size} entity groups`);
  return created;
}

// ── Status / debugging ───────────────────────────────────────────────

/**
 * Get ingest pipeline status.
 */
export function getIngestStatus() {
  const l0 = _db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE (cone_layer = 0 OR cone_layer IS NULL) AND status = 'active'").get()?.cnt || 0;
  const l1 = _db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE cone_layer = 1 AND status = 'active'").get()?.cnt || 0;
  const l2 = _db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE cone_layer = 2 AND status = 'active'").get()?.cnt || 0;
  const l1WithSources = _db.prepare("SELECT COUNT(*) as cnt FROM memories WHERE cone_layer = 1 AND status = 'active' AND json_array_length(json_extract(metadata, '$.source_memory_ids')) > 0").get()?.cnt || 0;

  return {
    l0_total: l0,
    l1_total: l1,
    l2_total: l2,
    l1_with_source_tracing: l1WithSources,
    expansion_weights: EXPANSION_WEIGHTS,
    hash_cache_size: sessionL0HashCache.size,
  };
}

export default {
  // Incremental extraction guard
  computeL0Hash,
  shouldExtractL1,
  markExtractionComplete,
  // Two-step extraction
  twoStepExtractL1,
  // 4-signal retrieval expansion
  calculateRelevance,
  expandWithGraphSignals,
  // Knowledge gap detection
  detectKnowledgeGaps,
  // Cross-link auto-generation
  autoGenerateCrossLinks,
  autoLinkMemoriesBySharedEntity,
  // Status
  getIngestStatus,
};
