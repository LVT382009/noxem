#!/usr/bin/env node
/**
 * Noxem Adapter: Entity Ranker (from Memary)
 *
 * Adapts Memary's entity recency+frequency composite ranking, entity-centric
 * search boost, multi-hop graph expansion, topic shift detection, and
 * eviction-based context assembly into Noxem's ESM+better-sqlite3 architecture.
 *
 * Source reference: Memary EntityKnowledgeStore
 *   - _convert_memory_to_knowledge_memory(): groups by entity, counts frequency, takes max date
 *   - _update_knowledge_memory(): merges counts + updates dates for existing entities
 *
 * Noxem integration points:
 *   - memory-store.mjs: entities table (mention_count, touchEntity, listEntities, getEntity),
 *     _traverseMemoryGraph(), _storeEdge(), db export, prepared-statement patterns
 *   - memory-server.mjs: applyRecencyScore() Weibull scoring, classifyQueryIntent(),
 *     DECAY_BY_TYPE, search pipeline (lines 925-1070)
 *   - advisor-engine.mjs: callRLMWithFallback / llmFetch for async LLM calls
 *   -bundle-search.mjs: hit graph, Dijkstra ranking
 *   - memory-maintenance.mjs: runMaintenance() cron
 *
 * Schema addition: entities.last_mentioned_at (migration v6)
 *   - No new tables; extends existing entities table
 *   - Updated by _touchEntity() calls from storeMemory flow
 */




export function initEntityRanker(db, deps = {}) {
  _db = db;
  _listEntities = deps.listEntities;
  _getEntity = deps.getEntity;
  _touchEntity = deps.touchEntity;
  _traverseMemoryGraph = deps.traverseMemoryGraph;
  _storeEdge = deps.storeEdge;
  _getActiveMemories = deps.getActiveMemories;
  _incrementRecallCounts = deps.incrementRecallCounts;
  _extractEntityAttribute = deps.extractEntityAttribute;
}

// ── Constants ────────────────────────────────────────────────────────

const ENTITY_RANK_HALF_LIFE_DAYS = 30;
const ENTITY_RANK_DEFAULT_LIMIT = 20;
const ENTITY_BOOST_TOP_N = 10;
const ENTITY_BOOST_FACTOR = 0.1;
const TOPIC_SHIFT_BIN_DAYS = 1;
const TOPIC_SHIFT_MULTIPLIER = 2.0;
const EVICTION_KEEP_RECENT_TURNS = 6;
const EVICTION_SUMMARY_TARGET_WORDS = 50;
const GRAPH_EXPANSION_DEPTH = 2;
const GRAPH_EXPANSION_LIMIT = 50;

// ── Migration v6: Add last_mentioned_at to entities ──────────────────

function _ensureColumn(table, column, def) {
  if (!/^[a-zA-Z_]\w*$/.test(column)) throw new Error(`Invalid column name: ${column}`);
  try { _db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`); }
  catch (e) { if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e; }
}

function runEntityRankerMigration() {
  _ensureColumn('entities', 'last_mentioned_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
  _db.exec('CREATE INDEX IF NOT EXISTS idx_entities_last_mentioned ON entities(last_mentioned_at DESC)');
}

// Auto-run migration on import
try { runEntityRankerMigration(); } catch (e) { console.error('[EntityRanker] Migration failed:', e.message); }

// ── Prepared statements ──────────────────────────────────────────────

const stmtGetRankedEntities = _db.prepare(`
  SELECT id, canonical_name, entity_type, mention_count, last_mentioned_at,
    mention_count * exp(-(julianday('now') - julianday(last_mentioned_at)) / @half_life) AS composite_score
  FROM entities
  WHERE mention_count > 0
  ORDER BY composite_score DESC
  LIMIT @limit
`);

const stmtUpdateLastMentioned = _db.prepare(
  "UPDATE entities SET last_mentioned_at = datetime('now'), mention_count = mention_count + 1 WHERE canonical_name = ?"
);

const stmtGetEntityMentionsByDay = _db.prepare(`
  SELECT entity, DATE(created_at) AS day, COUNT(*) AS count
  FROM memories
  WHERE status = 'active' AND entity != ''
  GROUP BY entity, day
  ORDER BY entity, day
`);

const stmtGetMemoriesByEntityRanked = _db.prepare(`
  SELECT m.id, m.type, m.text, m.importance, m.recall_count, m.created_at,
    m.entity, m.attribute, m.summary
  FROM memories m
  WHERE m.status = 'active' AND m.entity = ?
  ORDER BY m.importance DESC, m.recall_count DESC, m.created_at DESC
  LIMIT ?
`);

const stmtUpsertEntityWithTimestamp = _db.prepare(`
  INSERT INTO entities (canonical_name, entity_type, normalized_name, mention_count, last_mentioned_at)
  VALUES (@name, @type, @norm, 1, datetime('now'))
  ON CONFLICT(canonical_name) DO UPDATE SET
    mention_count = mention_count + 1,
    last_mentioned_at = datetime('now'),
    updated_at = datetime('now')
`);

// ── 1. Entity Recency+Frequency Composite Ranking ───────────────────

/**
 * Compute composite entity ranking: frequency * recency_weight.
 * recency_weight = exp(-age_days / half_life)  (exponential decay)
 *
 * Adapted from Memary's EntityKnowledgeStore._convert_memory_to_knowledge_memory()
 * which groups by entity, counts frequency, and uses max date for recency.
 * Noxem uses mention_count * exponential_decay instead of simple count * max_date.
 *
 * @param {number} [limit=20] - Max entities to return
 * @param {number} [halfLifeDays=30] - Decay half-life in days
 * @returns {Array<{id: number, canonical_name: string, entity_type: string,
 *           mention_count: number, last_mentioned_at: string, composite_score: number}>}
 */
export function getEntityRanking(limit = ENTITY_RANK_DEFAULT_LIMIT, halfLifeDays = ENTITY_RANK_HALF_LIFE_DAYS) {
  return stmtGetRankedEntities.all({ limit: Math.min(limit, 200), half_life: halfLifeDays });
}

/**
 * Touch an entity: increment mention_count and update last_mentioned_at.
 * Replaces the simple _touchEntity() to also track recency.
 *
 * @param {string} canonicalName - Entity name to touch
 * @returns {number} Number of rows changed
 */
export function touchEntityWithRecency(canonicalName) {
  return stmtUpdateLastMentioned.run(canonicalName).changes;
}

/**
 * Upsert an entity with both mention tracking and last_mentioned_at.
 * Used when extracting entities from new memories.
 *
 * @param {object} params
 * @param {string} params.name - Canonical name
 * @param {string} [params.type='generic'] - Entity type
 * @returns {object} The upserted entity row
 */
export function upsertEntityWithRecency({ name, type = 'generic' }) {
  stmtUpsertEntityWithTimestamp.run({ name, type, norm: name.toLowerCase() });
  return _getEntity(name);
}

// ── 2. Entity-Centric Search Boost ──────────────────────────────────

/**
 * Apply entity-centric boost to search results.
 * After Weibull scoring in applyRecencyScore(), multiply the score of
 * results whose entity ranks in the top-N by a boost factor.
 *
 * Boost formula: score *= (1 + 0.1 * entity_rank_inverted)
 *   where entity_rank_inverted = (1 - rank_position / topN)
 *   so rank 1 gets +10%, rank N gets ~+1%
 *
 * This is applied as a post-processing step, not embedded in the Weibull
 * decay function, to keep concerns separated.
 *
 * @param {Array<object>} results - Search results with .entity and .score fields
 * @param {number} [topN=10] - Number of top-ranked entities to use
 * @returns {Array<object>} Results with boosted scores, re-sorted by score
 */
export function applyEntityBoost(results, topN = ENTITY_BOOST_TOP_N) {
  if (!results || results.length === 0) return results;

  const rankedEntities = getEntityRanking(topN);
  const entityRankMap = new Map();
  for (let i = 0; i < rankedEntities.length; i++) {
    entityRankMap.set(rankedEntities[i].canonical_name.toLowerCase(), i);
  }

  return results.map(r => {
    const entity = (r.entity || '').toLowerCase();
    if (!entity || !entityRankMap.has(entity)) return r;
    const rankPos = entityRankMap.get(entity);
    const rankInverted = 1 - (rankPos / topN);
    const boost = 1 + ENTITY_BOOST_FACTOR * rankInverted;
    return { ...r, score: Math.round((r.score || 0) * boost * 1000) / 1000 };
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

// ── 3. Multi-Hop Graph Expansion ────────────────────────────────────

/**
 * Expand a search hit graph by traversing the entity graph at depth 2.
 * Extracts key entities from the query, then for each entity, finds all
 * memories connected via memory_edges and adds them to the result set.
 *
 * Adapted from Memary's multi-hop KG reasoning: extract key entities,
 * build depth-2 subgraph, combine with direct hits.
 *
 * @param {string} query - The search query to extract entities from
 * @param {Set<number>} existingIds - IDs already in the hit graph (to avoid duplicates)
 * @param {number} [depth=2] - Graph traversal depth
 * @param {number} [limit=50] - Max neighbors to collect
 * @returns {Array<object>} Additional memory neighbors discovered via graph traversal
 */
export function expandHitGraphByEntities(query, existingIds, depth = GRAPH_EXPANSION_DEPTH, limit = GRAPH_EXPANSION_LIMIT) {
  if (!query || !existingIds) return [];

  const { entity: qEntity } = _extractEntityAttribute(query);
  const seedIds = new Set(existingIds);

  // If query has an entity, find all memories for that entity as additional seeds
  if (qEntity) {
    const entityMemories = stmtGetMemoriesByEntityRanked.all(qEntity, 20);
    for (const m of entityMemories) {
      seedIds.add(m.id);
    }
  }

  // Traverse graph from each seed, collecting neighbors
  const discovered = new Map(); // id -> { ...row, _hop_source }
  for (const seedId of seedIds) {
    try {
      const neighbors = _traverseMemoryGraph(seedId, depth, limit);
      for (const n of (neighbors || [])) {
        if (!existingIds.has(n.to_id) && !discovered.has(n.to_id)) {
          discovered.set(n.to_id, {
            id: n.to_id,
            relation: n.relation,
            strength: n.strength,
            depth: n.depth,
            _hop_source: seedId,
          });
        }
      }
    } catch { /* traversal may fail for disconnected nodes */ }
  }

  return Array.from(discovered.values());
}

// ── 4. Topic Shift Detection ────────────────────────────────────────

/**
 * Detect topic shifts by comparing entity mention frequency across
 * consecutive time bins (daily). An entity whose frequency changes
 * by >2x between bins is flagged as a "shift."
 *
 * Adapted from Memary's Memory Stream timeline analysis.
 *
 * @param {number} [binDays=1] - Size of each time bin in days
 * @param {number} [shiftMultiplier=2.0] - Frequency change ratio to flag as shift
 * @returns {Array<{entity: string, day: string, count: number, prev_count: number,
 *           ratio: number, direction: 'rising'|'declining'}>}
 */
export function detectTopicShifts(binDays = TOPIC_SHIFT_BIN_DAYS, shiftMultiplier = TOPIC_SHIFT_MULTIPLIER) {
  const rows = stmtGetEntityMentionsByDay.all();
  if (rows.length === 0) return [];

  const byEntity = new Map();
  for (const row of rows) {
    if (!byEntity.has(row.entity)) byEntity.set(row.entity, []);
    byEntity.get(row.entity).push({ day: row.day, count: row.count });
  }

  const shifts = [];
  for (const [entity, bins] of byEntity) {
    // Sort by day ascending
    bins.sort((a, b) => a.day.localeCompare(b.day));
    for (let i = 1; i < bins.length; i++) {
      const prev = bins[i - 1].count;
      const curr = bins[i].count;
      if (prev === 0 && curr === 0) continue;

      const ratio = prev === 0 ? Infinity : curr / prev;
      if (ratio >= shiftMultiplier || (prev > 0 && ratio <= 1 / shiftMultiplier)) {
        shifts.push({
          entity,
          day: bins[i].day,
          count: curr,
          prev_count: prev,
          ratio: Math.round(ratio * 100) / 100,
          direction: ratio >= shiftMultiplier ? 'rising' : 'declining',
        });
      }
    }
  }

  return shifts.sort((a, b) => b.ratio - a.ratio);
}

// ── 5. Eviction-Based Context Assembly ──────────────────────────────

/**
 * Assemble a context window from conversation history using a sliding
 * eviction model: keep the last N turns verbatim, replace older turns
 * with a ~50-word summary per block.
 *
 * Adapted from Memary's context window assembly (entity rank + eviction).
 * This preserves recent detail while compressing older context, matching
 * how human working memory prioritizes recent information.
 *
 * @param {Array<{role: string, content: string}>} history - Conversation turns
 * @param {number} [tokenBudget=2000] - Approximate token budget (1 token ~ 4 chars)
 * @param {number} [keepRecent=6] - Number of recent turns to keep verbatim
 * @returns {{ context: string, evicted_count: number, kept_count: number }}
 */
export function assembleEvictionContext(history, tokenBudget = 2000, keepRecent = EVICTION_KEEP_RECENT_TURNS) {
  if (!history || history.length === 0) return { context: '', evicted_count: 0, kept_count: 0 };

  const charBudget = tokenBudget * 4;
  const recentTurns = history.slice(-keepRecent);
  const olderTurns = history.slice(0, -keepRecent);

  // Compress older turns into summary blocks
  const summaries = [];
  const blockSize = 4; // Group older turns in blocks of 4
  for (let i = 0; i < olderTurns.length; i += blockSize) {
    const block = olderTurns.slice(i, i + blockSize);
    const roles = [...new Set(block.map(t => t.role))];
    const firstLine = block[0]?.content?.slice(0, 60) || '';
    const summary = `[${roles.join('/')}] ${firstLine}... +${block.length - 1} turns`;
    summaries.push(summary);
  }

  const summaryText = summaries.join('\n');
  const recentText = recentTurns.map(t => `${t.role}: ${t.content}`).join('\n');
  const fullContext = olderTurns.length > 0
    ? `--- Earlier context (summarized) ---\n${summaryText}\n--- Recent turns ---\n${recentText}`
    : recentText;

  // Trim to budget if needed, prioritizing recent turns
  if (fullContext.length > charBudget) {
    const recentChars = recentText.length;
    const budgetForSummary = Math.max(0, charBudget - recentChars);
    const trimmedSummary = summaryText.slice(0, budgetForSummary);
    return {
      context: `--- Earlier context (summarized) ---\n${trimmedSummary}\n--- Recent turns ---\n${recentText}`,
      evicted_count: olderTurns.length,
      kept_count: recentTurns.length,
    };
  }

  return {
    context: fullContext,
    evicted_count: olderTurns.length,
    kept_count: recentTurns.length,
  };
}

// ── 6. Memory Stream Endpoint Data ──────────────────────────────────

/**
 * Return a chronological log of entity mentions with timestamps,
 * mimicking Memary's Memory Stream. This data can power a stream
 * endpoint or dashboard visualization.
 *
 * @param {string} [entityFilter] - Optional entity name to filter by
 * @param {number} [limit=100] - Max entries to return
 * @returns {Array<{entity: string, text: string, type: string, created_at: string, importance: number}>}
 */
export function getMemoryStream(entityFilter = '', limit = 100) {
  const safeLimit = Math.min(limit, 500);
  if (entityFilter) {
    return _db.prepare(`
      SELECT entity, text, type, created_at, importance
      FROM memories
      WHERE status = 'active' AND entity = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(entityFilter, safeLimit);
  }
  return _db.prepare(`
    SELECT entity, text, type, created_at, importance
    FROM memories
    WHERE status = 'active' AND entity != ''
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit);
}
