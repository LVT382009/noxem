/**
 * Delta Processor — Noxem Adapter
 *
 * Adapts CocoIndex's incremental/delta-processing patterns into Noxem's
 * better-sqlite3 architecture. Provides six capabilities:
 *
 * 1. Stale embedding detection — text_hash column tracks content at embed time;
 *    detects when text changed since last embed, auto re-embeds.
 * 2. Logic-versioned re-evaluation — stores logic_version hash of
 *    categorizeText + estimateImportance; detects when logic changed, queues
 *    re-evaluation of all active memories.
 * 3. Source lineage tracking — source_type + source_ref columns answer
 *    "why does this memory exist?"
 * 4. Delta-aware sync — /memory/sync only processes the diff, not full input.
 * 5. Embedding model version gate — detects model changes on startup,
 *    schedules full re-embed.
 * 6. Selective cache invalidation on memory mutation — evicts query cache
 *    entries containing a mutated memory ID.
 *
 * All functions are pure exports — Noxem wires them into its lifecycle
 * (startup, store, maintenance, sync) as needed.
 */

import { createHash } from 'node:crypto';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ---------------------------------------------------------------------------
// Schema bootstrap (idempotent)
// ---------------------------------------------------------------------------

const _schemaBootstrapped = new WeakSet();

/**
 * Ensure delta-processor columns and tables exist in the given db.
 * Safe to call repeatedly — uses ADD COLUMN IF NOT EXISTS pattern.
 * @param {import('better-sqlite3').Database} db
 */
export function bootstrapSchema(db) {
  if (_schemaBootstrapped.has(db)) return;
  const col = (table, name, def) => {
    if (!/^[a-zA-Z_]\w*$/.test(name)) throw new Error(`Invalid column: ${name}`);
    if (!/^[a-zA-Z_]\w*$/.test(table)) throw new Error(`Invalid table: ${table}`);
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`); }
    catch (e) { if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e; }
  };

  db.exec(`CREATE TABLE IF NOT EXISTS noxem_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);

  col('memories', 'text_hash', "TEXT NOT NULL DEFAULT ''");
  col('memories', 'source_type', "TEXT NOT NULL DEFAULT 'conversation'");
  col('memories', 'source_ref', "TEXT NOT NULL DEFAULT ''");
  col('memories', 'has_embedding', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_text_hash
    ON memories(text_hash) WHERE text_hash != ''`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_source_type
    ON memories(source_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_has_embedding_stale
    ON memories(has_embedding, status) WHERE has_embedding = 1 AND status = 'active'`);

  // Sync state table: one row per sync_id tracking last-seen content hash
  db.exec(`CREATE TABLE IF NOT EXISTS delta_sync_state (
    sync_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL DEFAULT '',
    last_sync_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _schemaBootstrapped.add(db);
  LOG_DEBUG && console.log('[DeltaProcessor] Schema bootstrapped');
}

// ---------------------------------------------------------------------------
// 1. Stale embedding detection
// ---------------------------------------------------------------------------

/**
 * Compute a 16-char hex hash of the text content (including context_prefix).
 * Matches the plan: sha256(context_prefix + text).substring(0, 16).
 *
 * @param {string} text
 * @param {string} [contextPrefix='']
 * @returns {string} 16-hex-char hash
 */
export function computeTextHash(text, contextPrefix = '') {
  return createHash('sha256')
    .update(contextPrefix + text)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Prepare and return an object with functions for stale-embedding detection.
 * Call once after bootstrapSchema, keep the returned object.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ markEmbedded, scanStale, reembedStale }}
 */
export function initStaleEmbeddingDetector(db) {
  const markHash = db.prepare(
    `UPDATE memories SET text_hash = @text_hash, has_embedding = @has_embedding, updated_at = datetime('now') WHERE id = @id`
  );
  const getStale = db.prepare(`
    SELECT id, text, context_prefix, text_hash
    FROM memories
    WHERE status = 'active'
      AND has_embedding = 1
      AND embedding IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT ?
  `);
  const clearEmbedding = db.prepare(
    `UPDATE memories SET has_embedding = 0, embedding = NULL, updated_at = datetime('now') WHERE id = ?`
  );

  /**
   * Mark a memory as having a current embedding with its text hash.
   * Call after embedding is successfully stored.
   */
  function markEmbedded(id, textHash) {
    markHash.run({ id, text_hash: textHash, has_embedding: 1 });
  }

  /**
   * Scan active memories for stale embeddings (text_hash mismatch).
   * Returns array of { id, text, context_prefix, old_hash, new_hash }.
   */
  function scanStale(limit = 200) {
    const candidates = getStale.all(limit);
    const stale = [];
    for (const m of candidates) {
      const currentHash = computeTextHash(m.text, m.context_prefix || '');
      if (m.text_hash !== currentHash) {
        stale.push({
          id: m.id,
          text: m.text,
          context_prefix: m.context_prefix || '',
          old_hash: m.text_hash,
          new_hash: currentHash,
        });
      }
    }
    return stale;
  }

  /**
   * Re-embed stale memories. Returns { reembedded, failed }.
   * Requires embedFn(id, text, contextPrefix) that returns true on success.
   *
   * @param {Array} staleItems - from scanStale()
   * @param {Function} embedFn - async (id, text, contextPrefix) => boolean
   */
  async function reembedStale(staleItems, embedFn) {
    let reembedded = 0;
    let failed = 0;
    for (const item of staleItems) {
      try {
        const ok = await embedFn(item.id, item.text, item.context_prefix);
        if (ok) {
          markEmbedded(item.id, item.new_hash);
          reembedded++;
        } else {
          failed++;
        }
      } catch (err) {
        LOG_DEBUG && console.error(`[DeltaProcessor] Re-embed failed for #${item.id}:`, err.message);
        failed++;
      }
    }
    return { reembedded, failed };
  }

  return { markEmbedded, scanStale, reembedStale };
}

// ---------------------------------------------------------------------------
// 2. Logic-versioned re-evaluation
// ---------------------------------------------------------------------------

/**
 * Compute an 8-char hex hash of the categorization + importance logic.
 * This captures the "code version" — if the functions change, the hash changes.
 *
 * @param {string} categorizeSrc - categorizeText function source
 * @param {string} importanceSrc - estimateImportance function source
 * @returns {string} 8-hex-char logic version
 */
export function computeLogicVersion(categorizeSrc, importanceSrc) {
  return createHash('sha256')
    .update(categorizeSrc + importanceSrc)
    .digest('hex')
    .substring(0, 8);
}

/**
 * Prepare and return functions for logic-versioned re-evaluation.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ checkLogicVersion, getActiveForReevaluation, applyReevaluation }}
 */
export function initLogicVersioning(db) {
  const getMeta = db.prepare('SELECT value FROM noxem_meta WHERE key = ?');
  const setMeta = db.prepare('INSERT OR REPLACE INTO noxem_meta (key, value) VALUES (?, ?)');

  const getActiveBrief = db.prepare(`
    SELECT id, text, type, importance
    FROM memories
    WHERE status = 'active'
    ORDER BY updated_at DESC
    LIMIT ?
  `);
  const updateTypeImportance = db.prepare(
    `UPDATE memories SET type = @type, importance = @importance, updated_at = datetime('now') WHERE id = @id`
  );

  /**
   * Check if the logic version has changed since last check.
   * Returns { changed: boolean, currentVersion, storedVersion }.
   * If changed, the caller should queue re-evaluation.
   */
  function checkLogicVersion(categorizeSrc, importanceSrc) {
    const currentVersion = computeLogicVersion(categorizeSrc, importanceSrc);
    const row = getMeta.get('logic_version');
    const storedVersion = row ? row.value : '';
    return {
      changed: storedVersion !== '' && storedVersion !== currentVersion,
      currentVersion,
      storedVersion,
      isFirstRun: storedVersion === '',
    };
  }

  /**
   * Persist the current logic version after re-evaluation completes.
   */
  function persistLogicVersion(version) {
    setMeta.run('logic_version', version);
  }

  /**
   * Get active memories for re-evaluation (id, text, type, importance).
   */
  function getActiveForReevaluation(limit = 5000) {
    return getActiveBrief.all(limit);
  }

  /**
   * Apply a re-evaluated type and/or importance to a memory.
   */
  function applyReevaluation(id, type, importance) {
    updateTypeImportance.run({ id, type, importance });
  }

  return { checkLogicVersion, persistLogicVersion, getActiveForReevaluation, applyReevaluation };
}

// ---------------------------------------------------------------------------
// 3. Source lineage tracking
// ---------------------------------------------------------------------------

/** Valid source_type values and their display labels. */
export const SOURCE_TYPES = {
  conversation: 'conversation',
  pipeline_l1: 'pipeline_l1',
  pipeline_l2: 'pipeline_l2',
  pipeline_l3: 'pipeline_l3',
  sync: 'sync',
  manual: 'manual',
  research: 'research',
  consolidation: 'consolidation',
  extraction: 'extraction',
};

/**
 * Build a source_ref string for a conversation turn.
 * @param {string} sessionId
 * @param {number} [turnIndex=0]
 * @returns {string}
 */
export function conversationRef(sessionId, turnIndex = 0) {
  return `${sessionId}:${turnIndex}`;
}

/**
 * Build a source_ref string for pipeline extraction.
 * @param {string} layer - 'l1', 'l2', or 'l3'
 * @param {string|number} sourceMemoryId
 * @returns {string}
 */
export function pipelineRef(layer, sourceMemoryId) {
  return `${layer}:${sourceMemoryId}`;
}

/**
 * Build a source_ref string for a sync batch.
 * @param {string} syncBatchId
 * @returns {string}
 */
export function syncRef(syncBatchId) {
  return `batch:${syncBatchId}`;
}

/**
 * Prepare and return functions for source lineage tracking.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ setLineage, getLineage, getLineageBySource }}
 */
export function initSourceLineage(db) {
  const setSource = db.prepare(
    `UPDATE memories SET source_type = @source_type, source_ref = @source_ref, updated_at = datetime('now') WHERE id = @id`
  );
  const getSource = db.prepare(
    `SELECT id, source_type, source_ref FROM memories WHERE id = ?`
  );
  const getBySource = db.prepare(
    `SELECT id, session_id, type, text, source_type, source_ref, created_at
     FROM memories
     WHERE source_type = ? AND source_ref LIKE ?
       AND status = 'active'
     ORDER BY created_at DESC
     LIMIT ?`
  );

  /**
   * Set source lineage on a memory. Call right after storeMemory().
   */
  function setLineage(id, sourceType, sourceRef) {
    if (!SOURCE_TYPES[sourceType]) {
      LOG_DEBUG && console.warn(`[DeltaProcessor] Unknown source_type: ${sourceType}`);
    }
    setSource.run({ id, source_type: sourceType, source_ref: sourceRef });
  }

  /**
   * Get source lineage for a memory.
   * Returns { id, source_type, source_ref } or null.
   */
  function getLineage(id) {
    return getSource.get(id) || null;
  }

  /**
   * Find memories by source type and ref prefix.
   * @param {string} sourceType
   * @param {string} refPrefix - e.g. "session_abc:%" for all turns in a session
   * @param {number} [limit=50]
   */
  function getLineageBySource(sourceType, refPrefix, limit = 50) {
    return getBySource.all(sourceType, refPrefix, limit);
  }

  return { setLineage, getLineage, getLineageBySource };
}

// ---------------------------------------------------------------------------
// 4. Delta-aware sync
// ---------------------------------------------------------------------------

/**
 * Compute a content hash for the sync payload.
 * Used to detect "has anything changed since last sync?"
 *
 * @param {Array<{user_message?: string, assistant_response?: string}>} items
 * @returns {string} 16-hex-char hash
 */
export function computeSyncContentHash(items) {
  // Deterministic serialization: sort by user_message hash for stability
  const parts = items
    .map(i => `${i.user_message || ''}\x00${i.assistant_response || ''}`)
    .sort();
  return createHash('sha256')
    .update(parts.join('\x01'))
    .digest('hex')
    .substring(0, 16);
}

/**
 * Compute the diff between two sync payloads by content identity.
 * Each item is identified by its (user_message, assistant_response) pair.
 *
 * @param {Array} previous - items from last sync
 * @param {Array} current - items from this sync
 * @returns {{ added: Array, removed: Array, unchanged: Array, modified: Array, isNoop: boolean }}
 */
export function computeSyncDiff(previous, current) {
  const keyOf = (item) => {
    const u = (item.user_message || '').trim();
    const a = (item.assistant_response || '').trim();
    // Use hash if messages are long to keep key manageable
    if (u.length + a.length > 256) {
      return createHash('sha256').update(u + '\x00' + a).digest('hex').substring(0, 16);
    }
    return u + '\x00' + a;
  };

  const prevMap = new Map();
  for (const p of previous) prevMap.set(keyOf(p), p);
  const currMap = new Map();
  for (const c of current) currMap.set(keyOf(c), c);

  const added = [];
  const removed = [];
  const unchanged = [];
  const modified = [];

  for (const [key, item] of currMap) {
    if (!prevMap.has(key)) {
      added.push(item);
    } else {
      const prev = prevMap.get(key);
      const prevHash = createHash('sha256')
        .update((prev.user_message || '') + (prev.assistant_response || ''))
        .digest('hex').substring(0, 16);
      const currHash = createHash('sha256')
        .update((item.user_message || '') + (item.assistant_response || ''))
        .digest('hex').substring(0, 16);
      if (prevHash === currHash) {
        unchanged.push(item);
      } else {
        modified.push(item);
      }
    }
  }

  for (const [key, item] of prevMap) {
    if (!currMap.has(key)) {
      removed.push(item);
    }
  }

  return {
    added,
    removed,
    unchanged,
    modified,
    isNoop: added.length === 0 && removed.length === 0 && modified.length === 0,
  };
}

/**
 * Prepare and return functions for delta-aware sync state tracking.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ getSyncState, saveSyncState, shouldSkipSync }}
 */
export function initDeltaSync(db) {
  const getSync = db.prepare('SELECT content_hash, last_sync_at FROM delta_sync_state WHERE sync_id = ?');
  const saveSync = db.prepare(
    `INSERT OR REPLACE INTO delta_sync_state (sync_id, content_hash, last_sync_at) VALUES (?, ?, datetime('now'))`
  );

  /**
   * Get the stored sync state for a given sync_id.
   * Returns { content_hash, last_sync_at } or null.
   */
  function getSyncState(syncId) {
    return getSync.get(syncId) || null;
  }

  /**
   * Save the current content hash for a sync_id.
   */
  function saveSyncState(syncId, contentHash) {
    saveSync.run(syncId, contentHash);
  }

  /**
   * Check whether a sync should be skipped entirely (content unchanged).
   * Returns { skip: boolean, storedHash: string|null, newHash: string }.
   */
  function shouldSkipSync(syncId, items) {
    const newHash = computeSyncContentHash(items);
    const state = getSyncState(syncId);
    if (state && state.content_hash === newHash) {
      return { skip: true, storedHash: state.content_hash, newHash };
    }
    return { skip: false, storedHash: state?.content_hash || null, newHash };
  }

  return { getSyncState, saveSyncState, shouldSkipSync };
}

// ---------------------------------------------------------------------------
// 5. Embedding model version gate
// ---------------------------------------------------------------------------

/**
 * Compute a model version fingerprint from model configuration.
 * If the model, dimension, or dtype changes, the fingerprint changes.
 *
 * @param {string} modelId - e.g. 'onnx-community/embeddinggemma-300m-ONNX'
 * @param {number} embedDim - e.g. 256
 * @param {string} dtype - e.g. 'q8'
 * @returns {string} 8-hex-char model version
 */
export function computeModelVersion(modelId, embedDim, dtype) {
  return createHash('sha256')
    .update(`${modelId}\x00${embedDim}\x00${dtype}`)
    .digest('hex')
    .substring(0, 8);
}

/**
 * Prepare and return functions for embedding model version gating.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ checkModelVersion, persistModelVersion }}
 */
export function initModelVersionGate(db) {
  const getMeta = db.prepare('SELECT value FROM noxem_meta WHERE key = ?');
  const setMeta = db.prepare('INSERT OR REPLACE INTO noxem_meta (key, value) VALUES (?, ?)');

  /**
   * Check if the embedding model has changed since last startup.
   * Returns { changed: boolean, currentVersion, storedVersion, needsFullReembed }.
   *
   * If changed and there are existing embeddings, needsFullReembed is true.
   */
  function checkModelVersion(modelId, embedDim, dtype, hasExistingEmbeddings) {
    const currentVersion = computeModelVersion(modelId, embedDim, dtype);
    const row = getMeta.get('model_version');
    const storedVersion = row ? row.value : '';

    if (storedVersion === '') {
      // First run — just persist
      return { changed: false, currentVersion, storedVersion, needsFullReembed: false, isFirstRun: true };
    }

    const changed = storedVersion !== currentVersion;
    return {
      changed,
      currentVersion,
      storedVersion,
      needsFullReembed: changed && hasExistingEmbeddings,
      isFirstRun: false,
    };
  }

  /**
   * Persist the current model version after check or after full re-embed.
   */
  function persistModelVersion(version) {
    setMeta.run('model_version', version);
  }

  return { checkModelVersion, persistModelVersion };
}

// ---------------------------------------------------------------------------
// 6. Selective cache invalidation on memory mutation
// ---------------------------------------------------------------------------

/**
 * Invalidate query cache entries that contain a specific memory ID
 * in their resultIds list. This is more precise than invalidating by
 * entity+attribute overlap.
 *
 * Designed to be called from memory-server.mjs where _queryCache lives.
 * This function receives the cache Map directly rather than importing it,
 * keeping the adapter decoupled from the server's internal state.
 *
 * @param {Map} queryCache - the _queryCache Map from memory-server
 * @param {Map} queryCacheNorm - the _queryCacheNorm Map from memory-server
 * @param {number} memoryId - the memory ID that was mutated
 * @returns {number} number of cache entries evicted
 */
export function invalidateCacheByMemoryId(queryCache, queryCacheNorm, memoryId) {
  let evicted = 0;
  const keysToDelete = [];

  for (const [cacheKey, entry] of queryCache) {
    if (entry.resultIds && entry.resultIds.includes(memoryId)) {
      keysToDelete.push(cacheKey);
      if (entry.queryNorm) queryCacheNorm.delete(entry.queryNorm);
    }
  }

  for (const key of keysToDelete) {
    queryCache.delete(key);
    evicted++;
  }

  if (evicted > 0 && LOG_DEBUG) {
    console.log(`[DeltaProcessor] Cache invalidation: evicted ${evicted} entries containing memory #${memoryId}`);
  }

  return evicted;
}

/**
 * Batch cache invalidation for multiple memory IDs.
 *
 * @param {Map} queryCache
 * @param {Map} queryCacheNorm
 * @param {number[]} memoryIds
 * @returns {number} total evicted entries
 */
export function invalidateCacheByMemoryIds(queryCache, queryCacheNorm, memoryIds) {
  const idSet = new Set(memoryIds);
  let evicted = 0;
  const keysToDelete = [];

  for (const [cacheKey, entry] of queryCache) {
    if (entry.resultIds && entry.resultIds.some(id => idSet.has(id))) {
      keysToDelete.push(cacheKey);
      if (entry.queryNorm) queryCacheNorm.delete(entry.queryNorm);
    }
  }

  for (const key of keysToDelete) {
    queryCache.delete(key);
    evicted++;
  }

  if (evicted > 0 && LOG_DEBUG) {
    console.log(`[DeltaProcessor] Batch cache invalidation: evicted ${evicted} entries for ${memoryIds.length} memory IDs`);
  }

  return evicted;
}

// ---------------------------------------------------------------------------
// Convenience: full startup check
// ---------------------------------------------------------------------------

/**
 * Run all startup-time checks for the delta processor.
 * Call once during server initialization, after embedding engine is ready.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.categorizeSrc - categorizeText.toString()
 * @param {string} opts.importanceSrc - estimateImportance.toString()
 * @param {string} opts.modelId - embedding model ID
 * @param {number} opts.embedDim - embedding dimension
 * @param {string} opts.dtype - embedding dtype
 * @param {boolean} opts.hasExistingEmbeddings - whether DB has any embedded memories
 * @returns {{ logicChanged, modelChanged, logicVersion, modelVersion, staleCount }}
 */
export function runStartupChecks({ db, categorizeSrc, importanceSrc, modelId, embedDim, dtype, hasExistingEmbeddings }) {
  bootstrapSchema(db);

  const logic = initLogicVersioning(db);
  const model = initModelVersionGate(db);
  const stale = initStaleEmbeddingDetector(db);

  const logicCheck = logic.checkLogicVersion(categorizeSrc, importanceSrc);
  const modelCheck = model.checkModelVersion(modelId, embedDim, dtype, hasExistingEmbeddings);
  const staleItems = stale.scanStale(500);

  // Persist current versions on first run
  if (logicCheck.isFirstRun) {
    logic.persistLogicVersion(logicCheck.currentVersion);
    LOG_DEBUG && console.log(`[DeltaProcessor] First run — persisted logic_version=${logicCheck.currentVersion}`);
  }
  if (modelCheck.isFirstRun) {
    model.persistModelVersion(modelCheck.currentVersion);
    LOG_DEBUG && console.log(`[DeltaProcessor] First run — persisted model_version=${modelCheck.currentVersion}`);
  }

  if (logicCheck.changed) {
    LOG_DEBUG && console.warn(
      `[DeltaProcessor] Logic version changed: ${logicCheck.storedVersion} -> ${logicCheck.currentVersion}. ` +
      `Re-evaluation of all active memories is required.`
    );
  }

  if (modelCheck.changed) {
    LOG_DEBUG && console.warn(
      `[DeltaProcessor] Embedding model version changed: ${modelCheck.storedVersion} -> ${modelCheck.currentVersion}. ` +
      `Full re-embed of all memories is required.`
    );
  }

  if (staleItems.length > 0) {
    LOG_DEBUG && console.warn(
      `[DeltaProcessor] Found ${staleItems.length} memories with stale embeddings (text changed since last embed).`
    );
  }

  return {
    logicChanged: logicCheck.changed,
    modelChanged: modelCheck.needsFullReembed,
    logicVersion: logicCheck.currentVersion,
    modelVersion: modelCheck.currentVersion,
    staleCount: staleItems.length,
    staleItems,
    // Callbacks for the caller to invoke after completing re-evaluation/re-embed
    markLogicUpdated: () => logic.persistLogicVersion(logicCheck.currentVersion),
    markModelUpdated: () => model.persistModelVersion(modelCheck.currentVersion),
  };
}

// ---------------------------------------------------------------------------
// Convenience: maintenance-time stale embedding scan + re-embed
// ---------------------------------------------------------------------------

/**
 * Run the stale embedding scan as part of periodic maintenance.
 * Delegates actual re-embedding to the provided embedFn.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {Function} opts.embedFn - async (id, text, contextPrefix) => boolean
 *   Should: embed the text, call updateMemoryEmbedding(id, vec),
 *   insertVec(db, id, vec), and optionally addToTurboVec.
 * @param {number} [opts.limit=200]
 * @returns {Promise<{ scanned, stale, reembedded, failed }>}
 */
export async function runStaleEmbeddingMaintenance({ db, embedFn, limit = 200 }) {
  bootstrapSchema(db);
  const detector = initStaleEmbeddingDetector(db);
  const staleItems = detector.scanStale(limit);

  if (staleItems.length === 0) {
    return { scanned: limit, stale: 0, reembedded: 0, failed: 0 };
  }

  LOG_DEBUG && console.log(`[DeltaProcessor] Maintenance: ${staleItems.length} stale embeddings detected`);
  const result = await detector.reembedStale(staleItems, embedFn);
  return { scanned: limit, stale: staleItems.length, ...result };
}

// ---------------------------------------------------------------------------
// Convenience: logic re-evaluation runner
// ---------------------------------------------------------------------------

/**
 * Re-evaluate all active memories against the current categorize/estimate
 * logic. Called when logic version changes.
 *
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {Function} opts.categorizeFn - (text: string) => string
 * @param {Function} opts.estimateFn - (text: string, type: string) => number
 * @param {number} [opts.limit=5000]
 * @returns {{ evaluated, changed, unchanged }}
 */
export function runLogicReevaluation({ db, categorizeFn, estimateFn, limit = 5000 }) {
  bootstrapSchema(db);
  const logic = initLogicVersioning(db);
  const memories = logic.getActiveForReevaluation(limit);

  let changed = 0;
  let unchanged = 0;

  for (const m of memories) {
    const newType = categorizeFn(m.text);
    const newImportance = estimateFn(m.text, newType);

    if (newType !== m.type || Math.abs(newImportance - m.importance) > 0.01) {
      logic.applyReevaluation(m.id, newType, newImportance);
      changed++;
    } else {
      unchanged++;
    }
  }

  LOG_DEBUG && console.log(
    `[DeltaProcessor] Logic re-evaluation: ${changed} changed, ${unchanged} unchanged out of ${memories.length}`
  );

  return { evaluated: memories.length, changed, unchanged };
}
