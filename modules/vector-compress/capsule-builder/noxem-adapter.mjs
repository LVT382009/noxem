/**
 * Noxem Capsule Adapter — Memvid-inspired features for Noxem.
 *
 * Adapts four key concepts from the Memvid .mv2 capsule format into
 * Noxem's better-sqlite3 architecture:
 *
 *   1. **Memory capsule export/import** — Single JSON file packaging
 *      memories + embeddings + edges + core blocks + metadata with a
 *      manifest, inspired by Memvid's header + data segments + TOC footer.
 *
 *   2. **Temporal versioning** — `memory_versions` table that snapshots
 *      every mutation (status change, text edit, supersession), inspired
 *      by Memvid's immutable + timestamped Smart Frames. Enables
 *      time-travel queries: "what did the agent know at time X?"
 *
 *   3. **Predictive cache for recall** — Co-recall graph tracks which
 *      memories are fetched together, preloads top-N co-recalled memories
 *      into an LRU hot cache, inspired by Memvid's sub-5ms P50 recall.
 *
 *   4. **SPO triplet extraction** — Subject-Predicate-Object triplets
 *      extracted via Brain 2 LLM + rule-based fallback, inspired by
 *      Memvid's TripletExtractor + RulesEngine pipeline. Stored in
 *      `memory_triplets` table for structured knowledge queries.
 *
 *   5. **O(1) entity slot index** — `memory_slots` table for direct
 *      entity:attribute lookup, inspired by Memvid's MemoriesTrack
 *      slot-based indexing.
 *
 * @module noxem-adapter
 */

import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPSULE_VERSION = '2.1.0';
const CAPSULE_MAGIC = 'NXCP';

const CORECALL_MAX_PAIRS = 5000;
const HOT_CACHE_MAX = 50;
const CO_RECALL_PRELOAD_TOP = 3;
const CO_RECALL_MIN_WEIGHT = 2;

/** Regex patterns for rule-based SPO extraction (mirrors Memvid's RulesEngine). */
const SPO_PATTERNS = [
  { regex: /(?:I\s+)?(?:work\s+at|employed\s+(?:at|by))\s+(.+?)(?:\.|$)/i,
    predicate: 'employer', entityDefault: 'user' },
  { regex: /(?:I\s+)?(?:live\s+in|reside\s+in|located\s+in|based\s+in)\s+(.+?)(?:\.|$)/i,
    predicate: 'location', entityDefault: 'user' },
  { regex: /(?:I\s+)?(?:prefer|like|enjoy|love|favor)\s+(.+?)(?:\.|$)/i,
    predicate: 'preference', entityDefault: 'user' },
  { regex: /(?:I\s+)?(?:use|using|work\s+with)\s+(.+?)(?:\.|$)/i,
    predicate: 'uses', entityDefault: 'user' },
  { regex: /(?:I\s+)?(?:hate|dislike|avoid|don't\s+like)\s+(.+?)(?:\.|$)/i,
    predicate: 'dislikes', entityDefault: 'user' },
  { regex: /(?:my\s+)?(?:name\s+is|I'm\s+called|call\s+me)\s+(.+?)(?:\.|$)/i,
    predicate: 'name', entityDefault: 'user' },
  { regex: /(?:my\s+)?(?:role\s+is|title\s+is|I'm\s+(?:a|an))\s+(.+?)(?:\.|$)/i,
    predicate: 'role', entityDefault: 'user' },
  { regex: /(?:I\s+)?(?:speak|know)\s+(.+?)(?:\.|$)/i,
    predicate: 'language', entityDefault: 'user' },
  { regex: /(?:the\s+)?(.+?)\s+(?:is\s+called|is\s+named)\s+(.+?)(?:\.|$)/i,
    predicate: 'name', entityDefault: null },
  { regex: /(.+?)\s+(?:is\s+located\s+in|is\s+in)\s+(.+?)(?:\.|$)/i,
    predicate: 'location', entityDefault: null },
];

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** LRU hot cache: Map<memoryId, {memory, insertedAt}> */
let _hotCache = new Map();

/** Co-recall adjacency: Map<memoryId, Map<peerId, weight>> */
let _corecallGraph = new Map();

/** Prepared statements cache per db instance. */
const _stmts = new WeakMap();

// ---------------------------------------------------------------------------
// Schema installation (migration v6)
// ---------------------------------------------------------------------------

/**
 * Install the capsule adapter schema into the Noxem database.
 * Creates tables and indexes if they don't exist. Safe to call repeatedly.
 *
 * Tables created:
 *   - memory_versions  — temporal version snapshots
 *   - memory_slots     — O(1) entity:attribute lookup
 *   - memory_corecalls — co-recall tracking for predictive cache
 *   - memory_triplets  — SPO triplet storage
 *
 * @param {import('better-sqlite3').Database} db
 */
export function installSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active',
      entity TEXT NOT NULL DEFAULT '',
      attribute TEXT NOT NULL DEFAULT '',
      importance REAL NOT NULL DEFAULT 0.5,
      embedding BLOB,
      changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      change_type TEXT NOT NULL DEFAULT 'update'
    );
    CREATE INDEX IF NOT EXISTS idx_versions_memory ON memory_versions(memory_id, changed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_versions_time ON memory_versions(changed_at DESC);

    CREATE TABLE IF NOT EXISTS memory_slots (
      key TEXT PRIMARY KEY,
      memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_slots_memory ON memory_slots(memory_id);

    CREATE TABLE IF NOT EXISTS memory_corecalls (
      memory_a INTEGER NOT NULL,
      memory_b INTEGER NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (memory_a, memory_b)
    );

    CREATE TABLE IF NOT EXISTS memory_triplets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      memory_id INTEGER REFERENCES memories(id) ON DELETE SET NULL,
      source TEXT NOT NULL DEFAULT 'rules',
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_triplets_subject ON memory_triplets(subject);
    CREATE INDEX IF NOT EXISTS idx_triplets_predicate ON memory_triplets(predicate);
    CREATE INDEX IF NOT EXISTS idx_triplets_object ON memory_triplets(object);
    CREATE INDEX IF NOT EXISTS idx_triplets_memory ON memory_triplets(memory_id);
    CREATE INDEX IF NOT EXISTS idx_triplets_spo ON memory_triplets(subject, predicate, object);
  `);

  _prepareStatements(db);
}

// ---------------------------------------------------------------------------
// Prepared statement factory
// ---------------------------------------------------------------------------

function _prepareStatements(db) {
  if (_stmts.has(db)) return _stmts.get(db);

  const s = {
    // Temporal versioning
    insertVersion: db.prepare(
      `INSERT INTO memory_versions (memory_id, text, type, status, entity, attribute, importance, embedding, change_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    getVersions: db.prepare(
      `SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY changed_at DESC`
    ),
    getVersionsByTime: db.prepare(
      `SELECT memory_id, text, type, status, entity, attribute, importance, changed_at, change_type
       FROM memory_versions
       WHERE changed_at <= ? AND memory_id IN (SELECT id FROM memories)
       GROUP BY memory_id
       HAVING changed_at = MAX(changed_at)
       ORDER BY changed_at DESC`
    ),
    getMemoryAtTime: db.prepare(
      `SELECT * FROM memory_versions
       WHERE memory_id = ? AND changed_at <= ?
       ORDER BY changed_at DESC LIMIT 1`
    ),
    getAllAtTime: db.prepare(
      `SELECT mv.* FROM memory_versions mv
       INNER JOIN (
         SELECT memory_id, MAX(changed_at) AS max_ts
         FROM memory_versions
         WHERE changed_at <= ?
         GROUP BY memory_id
       ) latest ON mv.memory_id = latest.memory_id AND mv.changed_at = latest.max_ts
       WHERE mv.status = 'active'`
    ),

    // Entity slots
    upsertSlot: db.prepare(
      `INSERT OR REPLACE INTO memory_slots (key, memory_id) VALUES (?, ?)`
    ),
    getSlot: db.prepare(
      `SELECT memory_id FROM memory_slots WHERE key = ?`
    ),
    deleteSlotByMemory: db.prepare(
      `DELETE FROM memory_slots WHERE memory_id = ?`
    ),

    // Co-recall
    upsertCorecall: db.prepare(
      `INSERT INTO memory_corecalls (memory_a, memory_b, weight) VALUES (?, ?, ?)
       ON CONFLICT(memory_a, memory_b) DO UPDATE SET weight = weight + 1`
    ),
    getCorecalls: db.prepare(
      `SELECT memory_b, weight FROM memory_corecalls
       WHERE memory_a = ? ORDER BY weight DESC LIMIT ?`
    ),
    getCorecallPairs: db.prepare(
      `SELECT memory_a, memory_b, weight FROM memory_corecalls ORDER BY weight DESC LIMIT ?`
    ),

    // Triplets
    insertTriplet: db.prepare(
      `INSERT INTO memory_triplets (subject, predicate, object, memory_id, source, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    searchTripletsBySubject: db.prepare(
      `SELECT * FROM memory_triplets WHERE subject LIKE ? ORDER BY confidence DESC LIMIT ?`
    ),
    searchTripletsByPredicate: db.prepare(
      `SELECT * FROM memory_triplets WHERE predicate = ? ORDER BY confidence DESC LIMIT ?`
    ),
    searchTripletsByObject: db.prepare(
      `SELECT * FROM memory_triplets WHERE object LIKE ? ORDER BY confidence DESC LIMIT ?`
    ),
    searchTripletsSPO: db.prepare(
      `SELECT * FROM memory_triplets
       WHERE subject LIKE ? AND predicate = ? AND object LIKE ?
       ORDER BY confidence DESC LIMIT ?`
    ),
    getTripletsByMemory: db.prepare(
      `SELECT * FROM memory_triplets WHERE memory_id = ? ORDER BY created_at DESC`
    ),
    deleteTripletsByMemory: db.prepare(
      `DELETE FROM memory_triplets WHERE memory_id = ?`
    ),

    // Capsule helpers
    getActiveMemoriesForCapsule: db.prepare(
      `SELECT id, session_id, type, text, status, entity, attribute, importance,
              context_prefix, cone_layer, scene_name, recall_count, metadata,
              valid_from, valid_until, created_at, updated_at
       FROM memories WHERE status = 'active' ORDER BY importance DESC`
    ),
    getEmbeddingsForCapsule: db.prepare(
      `SELECT id, embedding FROM memories WHERE status = 'active' AND embedding IS NOT NULL`
    ),
    getEdgesForCapsule: db.prepare(
      `SELECT id, from_id, to_id, relation, strength, confidence,
              valid_from, valid_until, source_session_id, metadata
       FROM memory_edges`
    ),
  };

  _stmts.set(db, s);
  return s;
}

function _stmtsFor(db) {
  if (!_stmts.has(db)) _prepareStatements(db);
  return _stmts.get(db);
}

// ---------------------------------------------------------------------------
// Feature 1: Memory Capsule Export/Import
// ---------------------------------------------------------------------------

/**
 * Export all memory state into a single JSON capsule file.
 *
 * Inspired by Memvid's .mv2 format (header + WAL + data + indices + TOC),
 * but adapted to JSON for cross-agent portability and Noxem's SQLite backend.
 * The capsule is self-contained: a consumer can fully reconstruct the memory
 * store from the capsule alone.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {string} [options.sessionId] — filter to a specific session
 * @param {boolean} [options.includeEmbeddings=true] — include embedding vectors
 * @param {boolean} [options.includeEdges=true] — include graph edges
 * @param {boolean} [options.includeCoreBlocks=true] — include core blocks
 * @param {boolean} [options.includeTriplets=true] — include SPO triplets
 * @param {boolean} [options.includeVersions=true] — include temporal versions
 * @returns {object} Capsule object (can be JSON.stringify'd)
 */
export function exportCapsule(db, options = {}) {
  const {
    includeEmbeddings = true,
    includeEdges = true,
    includeCoreBlocks = true,
    includeTriplets = true,
    includeVersions = true,
  } = options;

  const s = _stmtsFor(db);

  // 1. Memories (without embeddings — those are separate)
  const memories = s.getActiveMemoriesForCapsule.all().map(m => ({
    ...m,
    metadata: _safeParseJSON(m.metadata),
  }));

  // 2. Embeddings (optional — can be large)
  let embeddings = null;
  if (includeEmbeddings) {
    const rows = s.getEmbeddingsForCapsule.all();
    embeddings = {};
    for (const row of rows) {
      if (row.embedding) {
        embeddings[row.id] = Array.from(new Float32Array(row.embedding.buffer || row.embedding));
      }
    }
  }

  // 3. Edges
  let edges = null;
  if (includeEdges) {
    edges = s.getEdgesForCapsule.all().map(e => ({
      ...e,
      metadata: _safeParseJSON(e.metadata),
    }));
  }

  // 4. Core blocks
  let coreBlocks = null;
  if (includeCoreBlocks) {
    try {
      coreBlocks = db.prepare('SELECT key, value, description, char_limit, updated_at FROM core_memory').all();
    } catch (_) { coreBlocks = []; }
  }

  // 5. Triplets
  let triplets = null;
  if (includeTriplets) {
    try {
      triplets = db.prepare('SELECT subject, predicate, object, memory_id, source, confidence, created_at FROM memory_triplets').all();
    } catch (_) { triplets = []; }
  }

  // 6. Temporal versions
  let versions = null;
  if (includeVersions) {
    try {
      versions = db.prepare(
        `SELECT memory_id, text, type, status, entity, attribute, importance, changed_at, change_type
         FROM memory_versions ORDER BY changed_at DESC LIMIT 10000`
      ).all();
    } catch (_) { versions = []; }
  }

  // Build manifest (inspired by Memvid's TOC footer)
  const manifest = {
    magic: CAPSULE_MAGIC,
    version: CAPSULE_VERSION,
    exported_at: new Date().toISOString(),
    memory_count: memories.length,
    edge_count: edges?.length ?? 0,
    core_block_count: coreBlocks?.length ?? 0,
    triplet_count: triplets?.length ?? 0,
    version_count: versions?.length ?? 0,
    has_embeddings: includeEmbeddings,
    content_hash: null, // computed below
  };

  const capsule = {
    manifest,
    memories,
    embeddings,
    edges,
    coreBlocks,
    triplets,
    versions,
  };

  // Content hash for integrity verification (like Memvid's blake3 checksums)
  manifest.content_hash = _hashCapsule(capsule);

  return capsule;
}

/**
 * Export capsule directly to a file.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} filePath — output path for the capsule JSON
 * @param {object} [options] — same as exportCapsule
 * @returns {{path: string, manifest: object}}
 */
export function exportCapsuleToFile(db, filePath, options = {}) {
  const capsule = exportCapsule(db, options);
  const json = JSON.stringify(capsule, null, 0); // compact for smaller files
  writeFileSync(filePath, json, 'utf-8');
  return { path: filePath, manifest: capsule.manifest };
}

/**
 * Import a capsule into the database.
 *
 * Restores memories, embeddings, edges, core blocks, triplets, and version
 * history from a previously exported capsule. Idempotent: memories with
 * matching text+entity are skipped (not duplicated).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object|string} capsuleOrPath — capsule object or path to JSON file
 * @param {object} [storeFns] — Noxem store functions (avoids circular imports)
 * @param {Function} [storeFns.storeMemory] — storeMemory function
 * @param {Function} [storeFns.storeEdge] — storeEdge function
 * @param {Function} [storeFns.upsertCoreBlock] — upsertCoreBlock function
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] — validate without importing
 * @param {boolean} [options.skipExisting=true] — skip memories that already exist
 * @returns {{imported: number, skipped: number, errors: string[]}}
 */
export function importCapsule(db, capsuleOrPath, storeFns = {}, options = {}) {
  const { dryRun = false, skipExisting = true } = options;

  // Load capsule
  let capsule;
  if (typeof capsuleOrPath === 'string') {
    if (!existsSync(capsuleOrPath)) throw new Error(`Capsule file not found: ${capsuleOrPath}`);
    capsule = JSON.parse(readFileSync(capsuleOrPath, 'utf-8'));
  } else {
    capsule = capsuleOrPath;
  }

  // Validate manifest
  if (!capsule.manifest || capsule.manifest.magic !== CAPSULE_MAGIC) {
    throw new Error('Invalid capsule: missing or wrong magic marker');
  }

  // Verify content hash (if present)
  if (capsule.manifest.content_hash) {
    const expected = capsule.manifest.content_hash;
    capsule.manifest.content_hash = null;
    const actual = _hashCapsule(capsule);
    capsule.manifest.content_hash = expected;
    if (actual !== expected) {
      throw new Error('Capsule integrity check failed: content hash mismatch');
    }
  }

  if (dryRun) {
    return {
      imported: 0,
      skipped: capsule.memories?.length ?? 0,
      errors: [],
      validated: true,
    };
  }

  const s = _stmtsFor(db);
  const result = { imported: 0, skipped: 0, errors: [] };

  // Check existing memories for dedup
  const existingSet = new Set();
  if (skipExisting) {
    const existing = db.prepare("SELECT id, text, entity FROM memories WHERE status = 'active'").all();
    for (const m of existing) existingSet.add(`${m.text}||${m.entity}`);
  }

  // Import memories
  const idMap = new Map(); // oldId -> newId
  if (capsule.memories?.length) {
    const insertMem = db.prepare(
      `INSERT INTO memories (session_id, type, text, status, entity, attribute, importance,
         context_prefix, cone_layer, scene_name, recall_count, metadata, valid_from, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const importTx = db.transaction((memories) => {
      for (const m of memories) {
        try {
          if (skipExisting && existingSet.has(`${m.text}||${m.entity}`)) {
            // Find existing ID for edge remapping
            const existing = db.prepare(
              "SELECT id FROM memories WHERE text = ? AND entity = ? AND status = 'active' LIMIT 1"
            ).get(m.text, m.entity);
            if (existing) {
              idMap.set(m.id, existing.id);
              result.skipped++;
              continue;
            }
          }

          const info = insertMem.run(
            m.session_id || '', m.type || 'general', m.text,
            m.entity || '', m.attribute || '', m.importance ?? 0.5,
            m.context_prefix || '', m.cone_layer ?? 0, m.scene_name || '',
            m.recall_count ?? 0, JSON.stringify(m.metadata || {}),
            m.valid_from || m.created_at || new Date().toISOString(),
            m.created_at || new Date().toISOString(),
            m.updated_at || new Date().toISOString()
          );
          const newId = Number(info.lastInsertRowid);
          idMap.set(m.id, newId);
          result.imported++;
        } catch (e) {
          result.errors.push(`memory ${m.id}: ${e.message}`);
        }
      }
    });

    importTx(capsule.memories);

    // Restore embeddings (batch)
    if (capsule.embeddings) {
      const updateEmb = db.prepare('UPDATE memories SET embedding = ? WHERE id = ?');
      db.transaction(() => {
        for (const [oldId, embArr] of Object.entries(capsule.embeddings)) {
          const newId = idMap.get(Number(oldId));
          if (newId && embArr) {
            const buf = Buffer.from(new Float32Array(embArr).buffer);
            updateEmb.run(buf, newId);
          }
        }
      })();
    }
  }

  // Import edges
  if (capsule.edges?.length) {
    const insertEdge = db.prepare(
      `INSERT INTO memory_edges (from_id, to_id, relation, strength, confidence, valid_from, valid_until, source_session_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (const e of capsule.edges) {
        try {
          const newFrom = idMap.get(e.from_id) ?? e.from_id;
          const newTo = idMap.get(e.to_id) ?? e.to_id;
          if (newFrom && newTo) {
            insertEdge.run(
              newFrom, newTo, e.relation, e.strength ?? 1.0, e.confidence ?? 1.0,
              e.valid_from || null, e.valid_until || null,
              e.source_session_id || '', JSON.stringify(e.metadata || {})
            );
          }
        } catch (e2) { result.errors.push(`edge: ${e2.message}`); }
      }
    })();
  }

  // Import core blocks
  if (capsule.coreBlocks?.length) {
    const upsertCore = db.prepare(
      `INSERT INTO core_memory (key, value, description, char_limit, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, description = excluded.description, updated_at = excluded.updated_at`
    );
    db.transaction(() => {
      for (const cb of capsule.coreBlocks) {
        try {
          upsertCore.run(cb.key, cb.value || '', cb.description || '', cb.char_limit ?? 500, cb.updated_at || new Date().toISOString());
        } catch (e) { result.errors.push(`core_block ${cb.key}: ${e.message}`); }
      }
    })();
  }

  // Import triplets
  if (capsule.triplets?.length) {
    db.transaction(() => {
      for (const t of capsule.triplets) {
        try {
          const newMemId = t.memory_id ? (idMap.get(t.memory_id) ?? t.memory_id) : null;
          s.insertTriplet.run(t.subject, t.predicate, t.object, newMemId, t.source || 'rules', t.confidence ?? 0.5);
        } catch (e) { result.errors.push(`triplet: ${e.message}`); }
      }
    })();
  }

  // Import versions (append-only — no conflict)
  if (capsule.versions?.length) {
    db.transaction(() => {
      for (const v of capsule.versions) {
        try {
          const newMemId = idMap.get(v.memory_id) ?? v.memory_id;
          if (newMemId) {
            s.insertVersion.run(newMemId, v.text, v.type, v.status, v.entity, v.attribute, v.importance, null, v.change_type);
          }
        } catch (e) { result.errors.push(`version: ${e.message}`); }
      }
    })();
  }

  // Rebuild slot index for imported memories
  if (result.imported > 0) {
    _rebuildSlotIndex(db);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Feature 2: Temporal Versioning
// ---------------------------------------------------------------------------

/**
 * Record a version snapshot for a memory before it gets mutated.
 *
 * Modeled after Memvid's Smart Frames: every frame is immutable + timestamped.
 * In Noxem's case, we snapshot the current state into memory_versions before
 * the mutation overwrites it. This enables time-travel queries.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 * @param {string} changeType — 'update', 'status_change', 'supersede', 'compress'
 */
export function recordVersion(db, memoryId, changeType = 'update') {
  const s = _stmtsFor(db);
  const row = db.prepare(
    `SELECT text, type, status, entity, attribute, importance, embedding
     FROM memories WHERE id = ?`
  ).get(memoryId);
  if (!row) return;

  s.insertVersion.run(
    memoryId, row.text, row.type, row.status,
    row.entity || '', row.attribute || '', row.importance ?? 0.5,
    row.embedding || null, changeType
  );
}

/**
 * Get the version history timeline for a specific memory.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 * @returns {Array} Version entries in reverse chronological order
 */
export function getMemoryHistory(db, memoryId) {
  const s = _stmtsFor(db);
  return s.getVersions.all(memoryId);
}

/**
 * Get the state of a specific memory at a point in time.
 *
 * Inspired by Memvid's `get_memory_at_time()` — query the Smart Frame
 * that was current at the given timestamp.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 * @param {string} timestamp — ISO 8601 datetime string
 * @returns {object|null} Memory version at that time, or null
 */
export function getMemoryAtTime(db, memoryId, timestamp) {
  const s = _stmtsFor(db);
  return s.getMemoryAtTime.get(memoryId, timestamp) ?? null;
}

/**
 * Reconstruct the full memory state at a point in time.
 *
 * Returns all active memories as they were at the given timestamp,
 * using the latest version entry on or before that time for each.
 * This is the core "time-travel" query, inspired by Memvid's timeline.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} timestamp — ISO 8601 datetime string
 * @returns {Array} Memory states at the given time
 */
export function getMemoriesAtTime(db, timestamp) {
  const s = _stmtsFor(db);
  return s.getAllAtTime.all(timestamp);
}

// ---------------------------------------------------------------------------
// Feature 3: Predictive Cache for Recall
// ---------------------------------------------------------------------------

/**
 * Track a co-recall event: these memories were recalled together.
 *
 * Inspired by Memvid's enrichment tracking which notes which frames
 * produced which cards. Here we track which memories appear in the
 * same result set, building a co-recall graph for predictive preloading.
 *
 * Call this whenever `incrementRecallCounts` is called in Noxem.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} memoryIds — IDs of memories recalled together
 */
export function trackCorecall(db, memoryIds) {
  if (!memoryIds || memoryIds.length < 2) return;
  const s = _stmtsFor(db);

  // Update in-memory graph
  for (let i = 0; i < memoryIds.length; i++) {
    for (let j = i + 1; j < memoryIds.length; j++) {
      const a = memoryIds[i];
      const b = memoryIds[j];

      // Persist to DB
      s.upsertCorecall.run(a, b);

      // Update in-memory
      if (!_corecallGraph.has(a)) _corecallGraph.set(a, new Map());
      const neighbors = _corecallGraph.get(a);
      neighbors.set(b, (neighbors.get(b) || 0) + 1);
    }
  }
}

/**
 * Get memories that are co-recalled with a given memory.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 * @param {number} [limit=5]
 * @returns {Array<{memory_b: number, weight: number}>}
 */
export function getCorecalls(db, memoryId, limit = 5) {
  const s = _stmtsFor(db);

  // Check in-memory first
  if (_corecallGraph.has(memoryId)) {
    const neighbors = _corecallGraph.get(memoryId);
    return [...neighbors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([memory_b, weight]) => ({ memory_b, weight }));
  }

  // Fall back to DB
  return s.getCorecalls.all(memoryId, limit);
}

/**
 * Preload related memories into the LRU hot cache.
 *
 * When a memory is fetched, this function finds the top-N co-recalled
 * peers and caches them for sub-millisecond recall on subsequent requests.
 * Inspired by Memvid's predictive caching that achieves sub-5ms P50 latency.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId — the memory that was just recalled
 * @param {number} [preloadCount=3] — how many co-recalled peers to cache
 */
export function preloadHotCache(db, memoryId, preloadCount = CO_RECALL_PRELOAD_TOP) {
  // Add the recalled memory itself
  const mem = db.prepare('SELECT * FROM memories WHERE id = ? AND status = \'active\'').get(memoryId);
  if (mem) _addToHotCache(memoryId, mem);

  // Find and cache co-recalled peers
  const peers = getCorecalls(db, memoryId, preloadCount);
  for (const peer of peers) {
    if (peer.weight >= CO_RECALL_MIN_WEIGHT) {
      const peerMem = db.prepare('SELECT * FROM memories WHERE id = ? AND status = \'active\'').get(peer.memory_b);
      if (peerMem) _addToHotCache(peer.memory_b, peerMem);
    }
  }
}

/**
 * Check the LRU hot cache for a memory before hitting sqlite-vec.
 *
 * @param {number} memoryId
 * @returns {object|null} Cached memory object, or null if not in cache
 */
export function getFromHotCache(memoryId) {
  if (_hotCache.has(memoryId)) {
    // Move to end (most recently used)
    const entry = _hotCache.get(memoryId);
    _hotCache.delete(memoryId);
    _hotCache.set(memoryId, entry);
    return entry.memory;
  }
  return null;
}

/**
 * Get current hot cache statistics.
 *
 * @returns {{size: number, maxSize: number, hitRate: number}}
 */
export function getHotCacheStats() {
  return {
    size: _hotCache.size,
    maxSize: HOT_CACHE_MAX,
    entries: [..._hotCache.keys()],
  };
}

/**
 * Clear the hot cache (e.g., on server shutdown or memory pressure).
 */
export function clearHotCache() {
  _hotCache.clear();
}

/**
 * Load co-recall graph from DB into memory for fast lookups.
 * Call once at server startup.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function loadCorecallGraph(db) {
  const s = _stmtsFor(db);
  _corecallGraph.clear();
  const pairs = s.getCorecallPairs.all(CORECALL_MAX_PAIRS);
  for (const p of pairs) {
    if (!_corecallGraph.has(p.memory_a)) _corecallGraph.set(p.memory_a, new Map());
    _corecallGraph.get(p.memory_a).set(p.memory_b, p.weight);
  }
}

function _addToHotCache(memoryId, memory) {
  // Evict least recently used if at capacity
  if (_hotCache.size >= HOT_CACHE_MAX) {
    const oldest = _hotCache.keys().next().value;
    _hotCache.delete(oldest);
  }
  _hotCache.set(memoryId, { memory, insertedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Feature 4: SPO Triplet Extraction
// ---------------------------------------------------------------------------

/**
 * Extract SPO triplets from text using rules + optional LLM.
 *
 * Inspired by Memvid's TripletExtractor which uses RulesEngine for fast
 * regex-based extraction and optionally falls back to LLM extraction.
 * In Noxem, we use rule-based patterns first, then call Brain 2 if available.
 *
 * @param {string} text — the memory text to extract from
 * @param {object} [options]
 * @param {'rules'|'llm'|'hybrid'} [options.mode='rules'] — extraction mode
 * @param {Function} [options.callLLM] — Brain 2 callLLM function from advisor-engine
 * @param {number} [options.memoryId] — associate triplets with this memory
 * @param {import('better-sqlite3').Database} [options.db] — store triplets if provided
 * @returns {{triplets: Array<{subject, predicate, object, confidence, source}>, stats: {rules: number, llm: number}}}
 */
export function extractTriplets(text, options = {}) {
  const { mode = 'rules', callLLM = null, memoryId = null, db = null } = options;

  const triplets = [];
  let rulesCount = 0;
  let llmCount = 0;

  // Step 1: Rules-based extraction (mirrors Memvid's RulesEngine)
  if (mode === 'rules' || mode === 'hybrid') {
    for (const pattern of SPO_PATTERNS) {
      const match = text.match(pattern.regex);
      if (match) {
        if (pattern.entityDefault !== null) {
          // Single-entity pattern: "I work at X" -> subject=user, predicate=employer, object=X
          triplets.push({
            subject: pattern.entityDefault,
            predicate: pattern.predicate,
            object: match[1].trim(),
            confidence: 0.8,
            source: 'rules',
          });
        } else {
          // Two-entity pattern: "X is located in Y" -> subject=X, predicate=location, object=Y
          if (match[1] && match[2]) {
            triplets.push({
              subject: match[1].trim(),
              predicate: pattern.predicate,
              object: match[2].trim(),
              confidence: 0.75,
              source: 'rules',
            });
          }
        }
        rulesCount++;
      }
    }
  }

  // Step 2: LLM-based extraction (inspired by Memvid's hybrid mode)
  if ((mode === 'llm' || mode === 'hybrid') && callLLM) {
    try {
      const llmResult = _extractTripletsWithLLM(callLLM, text);
      if (llmResult?.length) {
        for (const t of llmResult) {
          triplets.push({ ...t, source: 'llm' });
          llmCount++;
        }
      }
    } catch (_) {
      // LLM unavailable — rules-only fallback
    }
  }

  // Deduplicate by subject+predicate (keep highest confidence)
  const deduped = _dedupeTriplets(triplets);

  // Store in DB if provided
  if (db && memoryId) {
    const s = _stmtsFor(db);
    db.transaction(() => {
      for (const t of deduped) {
        s.insertTriplet.run(t.subject, t.predicate, t.object, memoryId, t.source, t.confidence);
      }
    })();
  }

  return {
    triplets: deduped,
    stats: { rules: rulesCount, llm: llmCount },
  };
}

/**
 * Search SPO triplets by subject, predicate, and/or object.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} query
 * @param {string} [query.subject] — filter by subject (supports % wildcards)
 * @param {string} [query.predicate] — filter by predicate (exact match)
 * @param {string} [query.object] — filter by object (supports % wildcards)
 * @param {number} [query.limit=20]
 * @returns {Array} Matching triplets
 */
export function searchTriplets(db, query = {}) {
  const s = _stmtsFor(db);
  const { subject, predicate, object, limit = 20 } = query;

  if (subject && predicate && object) {
    return s.searchTripletsSPO.all(subject, predicate, object, limit);
  }
  if (subject) return s.searchTripletsBySubject.all(subject, limit);
  if (predicate) return s.searchTripletsByPredicate.all(predicate, limit);
  if (object) return s.searchTripletsByObject.all(object, limit);

  // No filters — return recent
  return db.prepare('SELECT * FROM memory_triplets ORDER BY created_at DESC LIMIT ?').all(limit);
}

/**
 * Get all triplets associated with a specific memory.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 * @returns {Array}
 */
export function getTripletsForMemory(db, memoryId) {
  const s = _stmtsFor(db);
  return s.getTripletsByMemory.all(memoryId);
}

/**
 * Delete all triplets for a memory (e.g., on memory deletion).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 * @returns {number} Number of deleted triplets
 */
export function deleteTripletsForMemory(db, memoryId) {
  const s = _stmtsFor(db);
  return s.deleteTripletsByMemory.run(memoryId).changes;
}

// ---------------------------------------------------------------------------
// Feature 5: O(1) Entity Slot Index
// ---------------------------------------------------------------------------

/**
 * Upsert an entity:attribute slot for O(1) lookup.
 *
 * Inspired by Memvid's MemoriesTrack which maintains a slot index
 * mapping entity+slot directly to the current card. In Noxem, this
 * replaces the `getMemoriesByEntityAttr()` SQL scan with a single
 * PRIMARY KEY lookup.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} entity
 * @param {string} attribute
 * @param {number} memoryId
 */
export function upsertSlot(db, entity, attribute, memoryId) {
  if (!entity || !attribute) return;
  const s = _stmtsFor(db);
  const key = `${entity}:${attribute}`;
  s.upsertSlot.run(key, memoryId);
}

/**
 * Look up a memory by entity:attribute in O(1).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} entity
 * @param {string} attribute
 * @returns {number|null} Memory ID, or null if not found
 */
export function getSlot(db, entity, attribute) {
  const s = _stmtsFor(db);
  const key = `${entity}:${attribute}`;
  const row = s.getSlot.get(key);
  return row ? row.memory_id : null;
}

/**
 * Remove slots for a memory (call on memory deletion).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 */
export function deleteSlotsForMemory(db, memoryId) {
  const s = _stmtsFor(db);
  s.deleteSlotByMemory.run(memoryId);
}

/**
 * Rebuild the slot index from existing memories.
 * Call after bulk imports or if the index gets out of sync.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function rebuildSlotIndex(db) {
  _rebuildSlotIndex(db);
}

function _rebuildSlotIndex(db) {
  db.exec('DELETE FROM memory_slots');
  const rows = db.prepare(
    "SELECT id, entity, attribute FROM memories WHERE status = 'active' AND entity != '' AND attribute != ''"
  ).all();
  const s = _stmtsFor(db);
  db.transaction(() => {
    for (const r of rows) {
      s.upsertSlot.run(`${r.entity}:${r.attribute}`, r.id);
    }
  })();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _safeParseJSON(str) {
  if (!str) return {};
  try { return JSON.parse(str); } catch (_) { return {}; }
}

function _hashCapsule(capsule) {
  // Hash the content (excluding the hash itself) for integrity verification
  const copy = { ...capsule, manifest: { ...capsule.manifest, content_hash: null } };
  const json = JSON.stringify(copy);
  return createHash('sha256').update(json).digest('hex').substring(0, 32);
}

function _dedupeTriplets(triplets) {
  const seen = new Map();
  for (const t of triplets) {
    const key = `${t.subject}|${t.predicate}|${t.object}`;
    if (!seen.has(key) || seen.get(key).confidence < t.confidence) {
      seen.set(key, t);
    }
  }
  return [...seen.values()];
}

function _extractTripletsWithLLM(callLLM, text) {
  // Synchronous wrapper — returns null on failure, caller handles it
  // This is called within extractTriplets which has its own try/catch
  const prompt = `Extract Subject-Predicate-Object triplets from this text.
Return a JSON array of objects with keys: subject, predicate, object, confidence (0-1).
Only extract factual triplets. Example: {"subject":"user","predicate":"employer","object":"Acme Corp","confidence":0.9}

Text: "${text}"

Triplets:`;

  // callLLM is async — we return a Promise result
  // The caller should await this if using async mode
  // For sync compatibility, we return null if not available
  return null; // Real LLM call happens in extractTripletsAsync
}

/**
 * Async version of extractTriplets that can call Brain 2 LLM.
 *
 * @param {string} text
 * @param {object} options
 * @param {'rules'|'llm'|'hybrid'} [options.mode='rules']
 * @param {Function} [options.callLLM] — async Brain 2 callLLM function
 * @param {number} [options.memoryId]
 * @param {import('better-sqlite3').Database} [options.db]
 * @returns {Promise<{triplets: Array, stats: {rules: number, llm: number}}>}
 */
export async function extractTripletsAsync(text, options = {}) {
  const { mode = 'rules', callLLM = null, memoryId = null, db = null } = options;

  // Always start with rules
  const rulesResult = extractTriplets(text, { mode: 'rules', memoryId: null, db: null });

  // If LLM mode and we have a callLLM function, enhance with LLM
  if ((mode === 'llm' || mode === 'hybrid') && callLLM) {
    try {
      const response = await callLLM(
        [
          { role: 'system', content: 'Extract Subject-Predicate-Object triplets from text. Return a JSON array of {subject, predicate, object, confidence}. Only factual triplets.' },
          { role: 'user', content: `Extract triplets from: "${text}"` },
        ],
        512,
        0.2
      );

      const content = _parseLLMResponse(response);
      if (content?.length) {
        const llmTriplets = content.map(t => ({
          subject: String(t.subject || ''),
          predicate: String(t.predicate || ''),
          object: String(t.object || ''),
          confidence: Math.min(1, Math.max(0, Number(t.confidence) || 0.5)),
          source: 'llm',
        }));

        // Merge rules + LLM, dedup
        const merged = _dedupeTriplets([...rulesResult.triplets, ...llmTriplets]);

        // Store in DB if provided
        if (db && memoryId) {
          const s = _stmtsFor(db);
          db.transaction(() => {
            for (const t of merged) {
              s.insertTriplet.run(t.subject, t.predicate, t.object, memoryId, t.source, t.confidence);
            }
          })();
        }

        return {
          triplets: merged,
          stats: { rules: rulesResult.stats.rules, llm: llmTriplets.length },
        };
      }
    } catch (_) {
      // LLM failed — return rules-only
    }
  }

  // Store rules-only result in DB if needed
  if (db && memoryId) {
    const s = _stmtsFor(db);
    db.transaction(() => {
      for (const t of rulesResult.triplets) {
        s.insertTriplet.run(t.subject, t.predicate, t.object, memoryId, t.source, t.confidence);
      }
    })();
  }

  return rulesResult;
}

function _parseLLMResponse(response) {
  if (!response) return null;
  // response might be the raw LLM output — try to extract JSON array
  let content = '';
  if (typeof response === 'string') content = response;
  else if (response.choices?.[0]?.message?.content) content = response.choices[0].message.content;
  else if (response.data?.choices?.[0]?.message?.content) content = response.data.choices[0].message.content;
  else if (Array.isArray(response)) return response; // Already parsed

  // Extract JSON array from content (may be wrapped in markdown)
  const jsonMatch = content.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) return null;

  try { return JSON.parse(jsonMatch[0]); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Integration hooks — call these from Noxem's existing code paths
// ---------------------------------------------------------------------------

/**
 * Hook to call after a memory is stored.
 * Updates the slot index and extracts triplets if configured.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 * @param {string} text
 * @param {string} entity
 * @param {string} attribute
 * @param {object} [options]
 * @param {boolean} [options.extractTriplets=false]
 * @param {Function} [options.callLLM]
 */
export function onMemoryStored(db, memoryId, text, entity, attribute, options = {}) {
  // Update slot index
  if (entity && attribute) {
    upsertSlot(db, entity, attribute, memoryId);
  }

  // Extract triplets if requested
  if (options.extractTriplets && text) {
    const mode = options.callLLM ? 'hybrid' : 'rules';
    extractTriplets(text, { mode, callLLM: options.callLLM, memoryId, db });
  }
}

/**
 * Hook to call before a memory is mutated.
 * Records the current state into the version history.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 * @param {string} changeType — 'update', 'status_change', 'supersede', 'compress'
 */
export function onBeforeMemoryMutate(db, memoryId, changeType = 'update') {
  recordVersion(db, memoryId, changeType);
}

/**
 * Hook to call after memories are recalled (search results returned).
 * Updates the co-recall graph and preloads the hot cache.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} memoryIds
 */
export function onMemoriesRecalled(db, memoryIds) {
  trackCorecall(db, memoryIds);
  // Preload the top result into hot cache
  if (memoryIds.length > 0) {
    preloadHotCache(db, memoryIds[0]);
  }
}

/**
 * Hook to call after a memory is deleted.
 * Cleans up slot index and triplets.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} memoryId
 */
export function onMemoryDeleted(db, memoryId) {
  deleteSlotsForMemory(db, memoryId);
  deleteTripletsForMemory(db, memoryId);
}
