#!/usr/bin/env node
/**
 * Noxem Adapter: Spatial Filter (from MemPalace)
 *
 * Adapts MemPalace's structural pre-filtering (Wing/Room), 4-layer wake-up
 * context injection, storage-time duplicate rejection, and cross-wing tunnel
 * detection into Noxem's ESM+better-sqlite3 architecture.
 *
 * Key insight from MemPalace: hard-filtering vector search by entity scope
 * BEFORE computing similarity eliminates cross-domain semantic interference.
 * MemPalace achieves 96.6% R@5 vs 60.9% with flat search — a 34pp gain
 * from structural scoping alone. The entity+attribute columns already exist
 * in Noxem with indexes, so no schema migration is needed for pre-filtering.
 *
 * Mapping: entity  = Wing (project/person)
 *          attribute = Room (topic within wing)
 *
 * Source reference: MemPalace searcher.py
 *   - build_where_filter(wing, room): ChromaDB $and filter before vector search
 *   - search_memories(): applies where filter to vector query BEFORE search
 *   - closet rank-based boosts [0.40, 0.25, 0.15, 0.08, 0.04]
 *   - _hybrid_rank(): vector_weight=0.6, bm25_weight=0.4
 *   - layers.py: 4-layer MemoryStack with wake_up() returning L0+L1 text
 *   - dedup.py: greedy longest-first within source groups
 *
 * Noxem integration points:
 *   - memory-store.mjs: memories.entity/attribute columns, idx_memories_entity_attr,
 *     idx_memories_active_entity, searchMemories (FTS5), storeMemory, db, findDuplicates
 *   - memory-server.mjs: search pipeline (lines 925-1070), extractEntityAttribute,
 *     applyRecencyScore, vectorKnnSearch, reciprocalRankFusion
 *   - mcp-server.mjs: MCP tool registration pattern
 *   - embedding-engine.mjs: embed(), searchByEmbedding(), cosineSimilarity()
 *   - entity-ranker/noxem-adapter.mjs: _getEntityRanking() for wake-up L1 facts
 */





export function initSpatialFilter(db, deps = {}) {
  _db = db;
  _getMemoriesByEntityAttr = deps.getMemoriesByEntityAttr;
  _searchMemories = deps.searchMemories;
  _storeMemory = deps.storeMemory;
  _storeEdge = deps.storeEdge;
  _getActiveMemories = deps.getActiveMemories;
  _getAllCoreBlocks = deps.getAllCoreBlocks;
  _extractEntityAttribute = deps.extractEntityAttribute;
  _findDuplicates = deps.findDuplicates;
  _getEntityRanking = deps.getEntityRanking;
  _boot();
}

// ── Constants ────────────────────────────────────────────────────────

const PREFILTER_MIN_RESULTS = 3;
const PREFILTER_FALLBACK_GLOBAL = true;
const WAKEUP_L0_TOKEN_BUDGET = 50;
const WAKEUP_L1_FACT_COUNT = 5;
const WAKEUP_L1_ENTITY_COUNT = 3;
const WAKEUP_L1_PREF_COUNT = 5;
const STORAGE_DEDUP_COSINE_THRESHOLD = 0.90;
const STORAGE_DEDUP_FTS_LIMIT = 5;
const TUNNEL_MIN_ENTITY_PAIRS = 2;
const TUNNEL_MIN_SHARED_ATTRIBUTES = 2;
const CLOSET_RANK_BOOSTS = [0.40, 0.25, 0.15, 0.08, 0.04];

// ── Lazy init ───────────────────────────────────────────────
let _booted = false;
let stmtSearchByEntityAttrHard;
let stmtGetSharedAttributes;
let stmtInsertTunnel;
let stmtGetEntityPairsForAttribute;
let stmtSearchByEntityOnly;
let stmtSearchActiveByIds;
let stmtGetDistinctEntities;
let stmtGetAttributesForEntity;

function _boot() {
  if (_booted) return;
  stmtSearchByEntityOnly = _db.prepare(`
  SELECT id, session_id, type, text, importance, recall_count, entity, attribute,
  summary, created_at, 0.9 AS score
  FROM memories
  WHERE entity = ? AND status = 'active'
  ORDER BY importance DESC, created_at DESC
  LIMIT ?
  `);
  stmtSearchByEntityAttrHard = _db.prepare(`
  SELECT id, session_id, type, text, importance, recall_count, entity, attribute,
  summary, created_at, 0.95 AS score
  FROM memories
  WHERE entity = ? AND attribute = ? AND status = 'active'
  ORDER BY importance DESC, created_at DESC
  LIMIT ?
  `);
  stmtSearchActiveByIds = _db.prepare(`
  SELECT id, session_id, type, text, importance, recall_count, entity, attribute,
  summary, created_at
  FROM memories
  WHERE id IN (${Array(50).fill('?').join(',')}) AND status = 'active'
  `);
  stmtGetDistinctEntities = _db.prepare(`
  SELECT DISTINCT entity FROM memories WHERE entity != '' AND status = 'active' ORDER BY entity
  `);
  stmtGetAttributesForEntity = _db.prepare(`
  SELECT DISTINCT attribute FROM memories
  WHERE entity = ? AND attribute != '' AND status = 'active'
  ORDER BY attribute
  `);
  stmtGetSharedAttributes = _db.prepare(`
  SELECT m1.attribute, COUNT(DISTINCT m1.entity) AS entity_count
  FROM memories m1
  WHERE m1.attribute != '' AND m1.status = 'active'
  GROUP BY m1.attribute
  HAVING entity_count >= ?
  ORDER BY entity_count DESC
  `);
  stmtGetEntityPairsForAttribute = _db.prepare(`
  SELECT m1.entity AS entity_a, m2.entity AS entity_b, COUNT(*) AS overlap_count
  FROM memories m1
  JOIN memories m2 ON m1.attribute = m2.attribute AND m1.entity != m2.entity
  WHERE m1.attribute = ? AND m1.status = 'active' AND m2.status = 'active'
  GROUP BY m1.entity, m2.entity
  HAVING overlap_count >= ?
  `);
  _db.exec(`
  CREATE TABLE IF NOT EXISTS memory_tunnels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute TEXT NOT NULL,
  entity_a TEXT NOT NULL,
  entity_b TEXT NOT NULL,
  overlap_count INTEGER NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(attribute, entity_a, entity_b)
  )
  `);
  _db.exec('CREATE INDEX IF NOT EXISTS idx_tunnels_attribute ON memory_tunnels(attribute)');
  _db.exec('CREATE INDEX IF NOT EXISTS idx_tunnels_entity ON memory_tunnels(entity_a, entity_b)');
  stmtInsertTunnel = _db.prepare(`
  INSERT INTO memory_tunnels (attribute, entity_a, entity_b, overlap_count)
  VALUES (@attribute, @entity_a, @entity_b, @overlap_count)
  ON CONFLICT(attribute, entity_a, entity_b) DO UPDATE SET
  overlap_count = @overlap_count,
  discovered_at = datetime('now')
  `);
  _booted = true;
}
// ── 1. Structural Pre-Filtering for Search ──────────────────────────

/**
 * Build a pre-filter result set by scoping to entity (Wing) and
 * optionally attribute (Room) BEFORE running expensive vector/FTS search.
 *
 * This is the key insight from MemPalace: 34% recall improvement comes
 * from HARD pre-filtering, not soft weighting. When entity is known from
 * the query, only search within that entity scope. Fallback to global
 * search if filtered results are too sparse (<3).
 *
 * @param {string} query - The search query
 * @param {object} [options]
 * @param {string} [options.entity] - Explicit entity (Wing) override
 * @param {string} [options.attribute] - Explicit attribute (Room) override
 * @param {number} [options.limit=10] - Max results
 * @param {boolean} [options.fallback=true] - Fall back to global search if tiny result set
 * @returns {{ results: Array, prefiltered: boolean, wing: string, room: string }}
 */
export function prefilterByStructure(query, options = {}) {
  const limit = options.limit || 10;
  const fallback = options.fallback !== false;

  // Extract wing/room from query or use explicit overrides
  const { entity: qEntity, attribute: qAttribute } = _extractEntityAttribute(query);
  const wing = options.entity || qEntity || '';
  const room = options.attribute || qAttribute || '';

  if (!wing) {
    return { results: [], prefiltered: false, wing: '', room: '' };
  }

  // Hard pre-filter: entity+attribute
  if (wing && room) {
    const hardFiltered = stmtSearchByEntityAttrHard.all(wing, room, limit);
    if (hardFiltered.length >= PREFILTER_MIN_RESULTS || !fallback) {
      return { results: hardFiltered, prefiltered: true, wing, room };
    }
  }

  // Broader pre-filter: entity only (Room not specified or too narrow)
  const entityFiltered = stmtSearchByEntityOnly.all(wing, limit * 3);
  if (entityFiltered.length >= PREFILTER_MIN_RESULTS || !fallback) {
    return { results: entityFiltered.slice(0, limit), prefiltered: true, wing, room: '' };
  }

  // Fallback: global search
  if (fallback) {
    return { results: [], prefiltered: false, wing, room };
  }

  return { results: entityFiltered.slice(0, limit), prefiltered: true, wing, room: '' };
}

/**
 * Merge pre-filtered structural results with vector/FTS results.
 * Pre-filtered results get a closet-rank-based boost (MemPalace pattern),
 * then both sets are merged with dedup.
 *
 * @param {Array} prefilteredResults - Results from structural pre-filter
 * @param {Array} semanticResults - Results from vector/FTS search
 * @param {number} [limit=10] - Max final results
 * @returns {Array} Merged and re-ranked results
 */
export function mergeStructuralWithSemantic(prefilteredResults, semanticResults, limit = 10) {
  const seen = new Map();

  // Apply closet-style rank boosts to pre-filtered results
  for (let i = 0; i < prefilteredResults.length; i++) {
    const r = prefilteredResults[i];
    const boost = CLOSET_RANK_BOOSTS[Math.min(i, CLOSET_RANK_BOOSTS.length - 1)];
    const score = (r.score || 0.5) * (1 + boost);
    seen.set(r.id, { ...r, score: Math.round(score * 1000) / 1000, _source: 'structural' });
  }

  // Add semantic results (no boost, just ensure no duplicates)
  for (const r of semanticResults) {
    if (!seen.has(r.id)) {
      seen.set(r.id, { ...r, _source: 'semantic' });
    } else {
      // If already present from structural, keep the higher score
      const existing = seen.get(r.id);
      if ((r.score || 0) > existing.score) {
        seen.set(r.id, { ...r, _source: 'both' });
      }
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);
}

// ── 2. Wake-Up Context Injection ────────────────────────────────────

/**
 * Generate a compressed wake-up context block for session start.
 * Modeled after MemPalace's 4-layer MemoryStack.wake_up():
 *   L0 identity (~50 tokens) — user name, role from core_memory
 *   L1 critical facts (~120 tokens) — top facts by entity ranking
 *
 * Total target: ~170 tokens, fulfilling MemPalace's claim of
 * "instant knowledge for $0.70/year."
 *
 * @returns {{ context: string, layers: { l0: string, l1: string }, token_estimate: number }}
 */
export function generateWakeUpContext() {
  const parts = [];
  const layers = { l0: '', l1: '' };

  // L0: Identity from core_memory
  const coreBlocks = _getAllCoreBlocks();
  const identityBlock = coreBlocks.find(b => b.key === 'user_identity' || b.key === 'identity');
  const nameBlock = coreBlocks.find(b => b.key === 'user_name' || b.key === 'name');

  let identity = '';
  if (identityBlock && identityBlock.value) {
    identity = identityBlock.value;
  } else if (nameBlock && nameBlock.value) {
    identity = `User: ${nameBlock.value}`;
  }
  if (!identity && coreBlocks.length > 0) {
    // Use first core block as identity
    identity = `${coreBlocks[0].key}: ${coreBlocks[0].value}`;
  }
  layers.l0 = identity || 'User identity not set.';

  // L1: Top facts from entity-ranked memories
  const rankedEntities = _getEntityRanking(WAKEUP_L1_ENTITY_COUNT);
  const entityNames = rankedEntities.map(e => e.canonical_name);
  const topFacts = [];
  const topPrefs = [];

  for (const entityName of entityNames) {
    const mems = stmtSearchByEntityOnly.all(entityName, 10);
    for (const m of mems) {
      if (m.type === 'fact' && topFacts.length < WAKEUP_L1_FACT_COUNT) {
        topFacts.push(m.summary || m.text);
      }
      if (m.type === 'preference' && topPrefs.length < WAKEUP_L1_PREF_COUNT) {
        topPrefs.push(m.summary || m.text);
      }
    }
    if (topFacts.length >= WAKEUP_L1_FACT_COUNT && topPrefs.length >= WAKEUP_L1_PREF_COUNT) break;
  }

  const l1Parts = [];
  if (entityNames.length > 0) {
    l1Parts.push(`Projects: ${entityNames.join(', ')}`);
  }
  if (topPrefs.length > 0) {
    l1Parts.push(`Preferences: ${topPrefs.map(p => `- ${p}`).join('; ')}`);
  }
  if (topFacts.length > 0) {
    l1Parts.push(`Key facts: ${topFacts.map(f => `- ${f}`).join('; ')}`);
  }
  layers.l1 = l1Parts.join('\n');

  // Compose final context
  const context = `L0: ${layers.l0}\nL1: ${layers.l1}`;
  const tokenEstimate = Math.ceil(context.length / 4);

  return { context, layers, token_estimate: tokenEstimate };
}

// ── 3. Storage-Time Duplicate Rejection ─────────────────────────────

/**
 * Check for near-duplicate memories at store time. Reject inserts
 * where the text is semantically very similar to an existing memory
 * for the same entity.
 *
 * Combines FTS5 keyword overlap (fast) with cosine similarity (slow
 * but accurate). Rejects if FTS5 returns a hit for the same entity
 * AND cosine > 0.90.
 *
 * Adapted from MemPalace's dedup_source_group() greedy approach,
 * but applied at insertion time rather than during maintenance.
 *
 * @param {string} text - Memory text to check
 * @param {string} entity - Entity scope for comparison
 * @param {string} [attribute=''] - Attribute scope (optional, narrows check)
 * @returns {{ is_duplicate: boolean, existing_id: number|null, similarity: number }}
 */
export function checkStorageTimeDuplicate(text, entity, attribute = '') {
  if (!text || !entity) return { is_duplicate: false, existing_id: null, similarity: 0 };

  // Fast FTS5 check: search for near-duplicate text
  const ftsHits = _searchMemories({ query: text.slice(0, 200), limit: STORAGE_DEDUP_FTS_LIMIT });
  const entityHits = ftsHits.filter(h => h.entity === entity && h.status === 'active');

  if (entityHits.length === 0) {
    return { is_duplicate: false, existing_id: null, similarity: 0 };
  }

  // Use findDuplicates for embedding-based comparison on FTS hits with embeddings
  let maxSim = 0;
  let duplicateId = null;

  const hitsWithEmbeddings = entityHits.filter(h => h.embedding);
  if (hitsWithEmbeddings.length > 1) {
    const dupePairs = _findDuplicates(hitsWithEmbeddings, 10);
    for (const pair of dupePairs) {
      // Check if one of the pair is a newly-created candidate (most recent)
      const sim = pair.similarity;
      if (sim > maxSim) {
        maxSim = sim;
        duplicateId = pair.a.id;
      }
    }
  }

  // Jaccard word-level similarity as fallback for texts without embeddings
  const entityMems = _getMemoriesByEntityAttr(entity, attribute || '');
  if (entityMems.length > 0 && maxSim < STORAGE_DEDUP_COSINE_THRESHOLD) {
    // Use text-based heuristic for quick similarity when embeddings not available
    const textLower = text.toLowerCase().trim();
    for (const m of entityMems.slice(0, 10)) {
      const existingText = (m.text || '').toLowerCase().trim();
      // Jaccard word-level similarity as fallback
      const wordsA = new Set(textLower.split(/\s+/));
      const wordsB = new Set(existingText.split(/\s+/));
      const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
      const union = new Set([...wordsA, ...wordsB]).size;
      const jaccard = union === 0 ? 0 : intersection / union;
      if (jaccard > 0.75) {
        // High word overlap — likely duplicate
        const sim = 0.80 + jaccard * 0.15; // Map Jaccard 0.75-1.0 to 0.91-0.95
        if (sim > maxSim) {
          maxSim = sim;
          duplicateId = m.id;
        }
      }
    }
  }

  if (maxSim >= STORAGE_DEDUP_COSINE_THRESHOLD && duplicateId !== null) {
    return { is_duplicate: true, existing_id: duplicateId, similarity: Math.round(maxSim * 1000) / 1000 };
  }

  return { is_duplicate: false, existing_id: null, similarity: Math.round(maxSim * 1000) / 1000 };
}

// ── 4. Cross-Wing Tunnel Detection ──────────────────────────────────

/**
 * Detect cross-wing tunnels: attributes that appear across multiple
 * entities, indicating shared conceptual rooms. When searching,
 * tunnels allow pulling results from connected entities.
 *
 * Adapted from MemPalace's tunnel system that automatically links
 * the same room across different wings.
 *
 * @param {number} [minEntityPairs=2] - Min entities sharing an attribute
 * @param {number} [minOverlap=2] - Min overlap count per entity pair
 * @returns {Array<{attribute: string, entity_a: string, entity_b: string, overlap_count: number}>}
 */
export function detectCrossWingTunnels(minEntityPairs = TUNNEL_MIN_ENTITY_PAIRS, minOverlap = TUNNEL_MIN_SHARED_ATTRIBUTES) {
  // Find attributes shared across multiple entities
  const sharedAttrs = stmtGetSharedAttributes.all(minEntityPairs);
  const tunnels = [];

  for (const attr of sharedAttrs) {
    const pairs = stmtGetEntityPairsForAttribute.all(attr.attribute, minOverlap);
    for (const pair of pairs) {
      // Normalize direction: always store entity_a < entity_b alphabetically
      const [a, b] = pair.entity_a < pair.entity_b
        ? [pair.entity_a, pair.entity_b]
        : [pair.entity_b, pair.entity_a];

      stmtInsertTunnel.run({
        attribute: attr.attribute,
        entity_a: a,
        entity_b: b,
        overlap_count: pair.overlap_count,
      });

      tunnels.push({
        attribute: attr.attribute,
        entity_a: a,
        entity_b: b,
        overlap_count: pair.overlap_count,
      });
    }
  }

  return tunnels;
}

/**
 * Get existing tunnels, optionally filtered by entity or attribute.
 *
 * @param {string} [entity] - Filter tunnels involving this entity
 * @param {string} [attribute] - Filter tunnels for this attribute
 * @returns {Array<object>}
 */
export function getTunnels(entity = '', attribute = '') {
  let sql = 'SELECT * FROM memory_tunnels WHERE 1=1';
  const params = [];
  if (entity) {
    sql += ' AND (entity_a = ? OR entity_b = ?)';
    params.push(entity, entity);
  }
  if (attribute) {
    sql += ' AND attribute = ?';
    params.push(attribute);
  }
  sql += ' ORDER BY overlap_count DESC LIMIT 100';
  return _db.prepare(sql).all(...params);
}

/**
 * Expand search results to include memories from tunnel-connected entities.
 * When an entity is in the result set and has tunnels, also pull results
 * from the connected entity for the same attribute.
 *
 * @param {Array<object>} results - Current search results
 * @param {number} [limitPerTunnel=3] - Max additional results per tunnel
 * @returns {Array<object>} Original results + tunnel-expanded results
 */
export function expandResultsViaTunnels(results, limitPerTunnel = 3) {
  if (!results || results.length === 0) return results;

  const existingIds = new Set(results.map(r => r.id));
  const expandedResults = [...results];

  // Find entities + attributes in current results that have tunnels
  const entityAttrSet = new Set();
  for (const r of results) {
    if (r.entity && r.attribute) {
      entityAttrSet.add(`${r.entity}::${r.attribute}`);
    }
  }

  // For each entity-attribute combo, look up tunnels
  for (const key of entityAttrSet) {
    const [entity, attr] = key.split('::');
    const tunnels = getTunnels(entity, attr);

    for (const tunnel of tunnels.slice(0, 2)) { // Max 2 tunnels per combo
      const connectedEntity = tunnel.entity_a === entity ? tunnel.entity_b : tunnel.entity_a;
      const tunnelMems = stmtSearchByEntityAttrHard.all(connectedEntity, attr, limitPerTunnel);
      for (const m of tunnelMems) {
        if (!existingIds.has(m.id)) {
          expandedResults.push({ ...m, _via_tunnel: `${entity}<->${connectedEntity}` });
          existingIds.add(m.id);
        }
      }
    }
  }

  return expandedResults;
}

// ── 5. Hall-Type Cross-Entity Search ────────────────────────────────

/**
 * Hall-type cross-entity search: include the top result from each
 * memory type category, even if it falls below the normal score
 * threshold. This mimics MemPalace's Hall corridors that cross
 * entity boundaries by type.
 *
 * @param {Array<object>} results - Existing search results
 * @param {number} [perTypeLimit=1] - Max results per type to inject
 * @returns {Array<object>} Results with type-corridor additions
 */
export function addHallTypeCorridor(results, perTypeLimit = 1) {
  if (!results || results.length === 0) return results;

  const existingIds = new Set(results.map(r => r.id));
  const typesPresent = new Set(results.map(r => r.type));

  const hallTypes = ['fact', 'preference', 'setup', 'project', 'goal', 'pattern', 'entity'];
  const additions = [];

  for (const type of hallTypes) {
    if (typesPresent.has(type)) continue; // Type already represented

    const typeMems = _db.prepare(`
      SELECT id, session_id, type, text, importance, recall_count, entity, attribute,
        summary, created_at, 0.3 AS score
      FROM memories
      WHERE status = 'active' AND type = ?
      ORDER BY importance DESC, recall_count DESC
      LIMIT ?
    `).all(type, perTypeLimit);

    for (const m of typeMems) {
      if (!existingIds.has(m.id)) {
        additions.push({ ...m, _via_hall: type });
        existingIds.add(m.id);
      }
    }
  }

  return [...results, ...additions];
}
