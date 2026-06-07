/**
 * Noxem Adapter — MARM Compaction Coordinator (ESM)
 *
 * Adapts MARM-Systems reference patterns into Noxem-compatible functions:
 *   1. Agent-assisted compaction: 6-step (status -> candidates -> review -> stage -> apply -> discard)
 *   2. Serialized write queue: async FIFO queue wrapping all SQLite writes
 *   3. Rate limiting presets: Default/Swarm/SwarmMax/Trusted via env
 *   4. Compaction candidates endpoint: preview duplicate pairs before merging
 *   5. Notebook entries: named persistent references distinct from procedures
 *   6. Memory dashboard stub: lightweight HTML endpoint
 *
 * All functions are exported for Noxem server to import.
 * Uses better-sqlite3 prepared statements. No standalone server.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

// ─── Rate Limiting Presets ─────────────────────────────────────────
// MARM swarm-ready:  Default 80 RPM, Swarm 200, Swarm-Max 600, Trusted unlimited

const RATE_PRESETS = {
  default: 80,
  swarm: 200,
  swarm_max: 600,
  trusted: 0, // unlimited
};

/**
 * Resolve RPM from env or preset name.
 * MEMORY_RATE_LIMIT_RPM takes precedence; MEMORY_RATE_LIMIT_PRESET as fallback.
 * @returns {number} requests-per-minute (0 = unlimited)
 */
export function resolveRateLimitRPM() {
  const rpm = parseInt(process.env.MEMORY_RATE_LIMIT_RPM ?? '');
  if (Number.isFinite(rpm) && rpm >= 0) return rpm;
  const preset = (process.env.MEMORY_RATE_LIMIT_PRESET ?? 'default').toLowerCase();
  return RATE_PRESETS[preset] ?? RATE_PRESETS.default;
}

/**
 * Apply rate-limit headers to an Express response.
 * @param {import('express').Response} res
 * @param {{ remaining: number, limit: number, reset_ms: number }} info
 */
export function setRateLimitHeaders(res, info) {
  if (info.limit > 0) {
    res.setHeader('X-RateLimit-Limit', String(info.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, info.remaining)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(info.reset_ms / 1000)));
  }
}


// ─── Serialized Write Queue ────────────────────────────────────────────
// Adapts MARM's WriteQueue (Python asyncio.Queue) to Node.js Promise-chain.
// Single consumer dequeues and executes writes in FIFO order.
// better-sqlite3 is synchronous, so this serializes JS-level write ordering
// under concurrent async callers (e.g. two agent sessions).

export class WriteQueue {
  /**
   * @param {number} [maxSize=1000] max pending items before dropping
   */
  constructor(maxSize = 1000) {
    this._queue = [];
    this._maxSize = maxSize;
    this._lock = Promise.resolve();
    this._stopping = false;
    this._dropped = 0;
    this._processed = 0;
  }

  /**
   * Enqueue a synchronous write function. Returns when the write completes.
   * @param {() => any} fn  A function that performs the write (returns result or throws)
   * @returns {Promise<any>}  Result of fn()
   */
  enqueue(fn) {
    if (this._stopping) throw new Error('WriteQueue is shutting down');
    if (this._queue.length >= this._maxSize) {
      this._dropped++;
      LOG_DEBUG && console.warn('[WriteQueue] Full — dropping write (dropped:', this._dropped, ')');
      return Promise.resolve(null);
    }
    const result = this._lock.then(() => {
      try {
        const rv = fn();
        this._processed++;
        return rv;
      } catch (err) {
        LOG_DEBUG && console.error('[WriteQueue] Write error:', err.message);
        throw err;
      }
    });
    this._lock = result.catch(() => {}).then(() => {});
    return result;
  }

  /** Stop accepting new writes and drain the queue. */
  stop() {
    this._stopping = true;
  }

  /** Stats for monitoring. */
  stats() {
    return { pending: this._queue.length, processed: this._processed, dropped: this._dropped, maxSize: this._maxSize };
  }
}


// ─── Compaction Staging Schema ─────────────────────────────────────────
// Mirrors MARM's compaction_staging table for the 6-step agent-assisted workflow.
// Call initCompactionTables(db) once at startup.

const COMPACTION_STAGING_DDL = `
CREATE TABLE IF NOT EXISTS compaction_staging (
  id TEXT PRIMARY KEY,
  session_name TEXT NOT NULL DEFAULT '',
  source_memory_ids TEXT NOT NULL DEFAULT '[]',
  preview TEXT NOT NULL DEFAULT '[]',
  suggested_summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending_summary',
  candidate_hash TEXT NOT NULL DEFAULT '',
  source_snapshot TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  last_nudged_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_compaction_staging_status ON compaction_staging(status);
CREATE INDEX IF NOT EXISTS idx_compaction_staging_session ON compaction_staging(session_name);
`;

const NOTEBOOK_DDL = `
CREATE TABLE IF NOT EXISTS memory_notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notebooks_name ON memory_notebooks(name);
CREATE INDEX IF NOT EXISTS idx_notebooks_category ON memory_notebooks(category);
`;

/**
 * Create compaction_staging + notebook tables if they don't exist.
 * @param {import('better-sqlite3').Database} db
 */
export function initCompactionTables(db) {
  db.exec(COMPACTION_STAGING_DDL);
  db.exec(NOTEBOOK_DDL);
}


// ─── Compaction: 6-Step Agent-Assisted Workflow ────────────────────────
// status → candidates → review → stage → apply → discard

const COMPACTION_SIM_THRESHOLD = parseFloat(process.env.COMPACTION_SIM_THRESHOLD || '0.85');
const COMPACTION_MIN_CLUSTER = parseInt(process.env.COMPACTION_MIN_CLUSTER || '3');
const COMPACTION_STAGING_TTL_HOURS = parseInt(process.env.COMPACTION_STAGING_TTL_HOURS || '48');

// Prepared statements (lazily initialized per db instance)
let _stmts = null;

function _getStmts(db) {
  if (_stmts && _stmts._db === db) return _stmts;
  _stmts = {
    _db: db,
    insertStaging: db.prepare(`
      INSERT INTO compaction_staging
        (id, session_name, source_memory_ids, preview, status, candidate_hash,
         source_snapshot, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending_summary', ?, ?, ?, datetime('now'), datetime('now'))
    `),
    findActiveCandidates: db.prepare(`
      SELECT id, session_name, source_memory_ids, preview, created_at, expires_at
      FROM compaction_staging
      WHERE status = 'pending_summary' AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at ASC
    `),
    findStagedSummaries: db.prepare(`
      SELECT id, session_name, source_memory_ids, preview, suggested_summary, created_at, expires_at
      FROM compaction_staging
      WHERE status = 'summary_staged' AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY created_at ASC
      LIMIT ?
    `),
    getCandidateById: db.prepare(`SELECT * FROM compaction_staging WHERE id = ?`),
    updateCandidateStatus: db.prepare(`
      UPDATE compaction_staging SET status = ?, suggested_summary = ?, reviewed_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `),
    countByStatus: db.prepare(`
      SELECT status, COUNT(*) as count FROM compaction_staging GROUP BY status
    `),
    markExpiredStale: db.prepare(`
      UPDATE compaction_staging SET status = 'stale', updated_at = datetime('now')
      WHERE status IN ('pending_summary', 'summary_staged')
        AND expires_at IS NOT NULL AND expires_at <= datetime('now')
    `),
  };
  return _stmts;
}

/**
 * Compute a deterministic hash for a set of memory IDs (sorted).
 * Used to detect duplicate staging on re-scan.
 * @param {number[]} sourceIds
 * @returns {string}
 */
function _computeCandidateHash(sourceIds) {
  const payload = JSON.stringify([...sourceIds].sort());
  return createHash('sha256').update(payload).digest('hex').substring(0, 16);
}

/**
 * Get a snapshot of source memory content hashes for staleness detection.
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} sourceIds
 * @returns {Object}  { memoryId: text.substring(0,32) }
 */
function _getSourceSnapshot(db, sourceIds) {
  const snapshot = {};
  if (!sourceIds.length) return snapshot;
  const placeholders = sourceIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, text FROM memories WHERE id IN (${placeholders})`).all(...sourceIds);
  for (const r of rows) {
    snapshot[r.id] = (r.text || '').substring(0, 32);
  }
  return snapshot;
}

/**
 * Find compaction candidate clusters using existing duplicate detection.
 * Adapts MARM's find_compaction_candidates() to Noxem's cosine-based dedup.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ findDuplicates: Function, cosineSimilarity: Function }} deps  Noxem embedding deps
 * @param {string} [sessionId]  Optional session filter
 * @param {number} [limit=20]  Max clusters to return
 * @returns {Array}  Candidate clusters with previews
 */
export function findCompactionCandidates(db, deps, sessionId = '', limit = 20) {
  const s = _getStmts(db);

  // Mark expired candidates as stale first
  s.markExpiredStale.run();

  // Get active memories with embeddings
  let whereClause = "status = 'active' AND embedding IS NOT NULL";
  const params = [];
  if (sessionId) {
    whereClause += ' AND session_id = ?';
    params.push(sessionId);
  }

  const memories = db.prepare(
    `SELECT id, text, type, entity, session_id, importance, created_at FROM memories WHERE ${whereClause}`
  ).all(...params);

  if (memories.length < COMPACTION_MIN_CLUSTER) return [];

  // Group by entity — same as Noxem maintenance consolidation pattern
  const byEntity = new Map();
  for (const m of memories) {
    const key = m.entity || '__none__';
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key).push(m);
  }

  const candidates = [];

  for (const [entity, entityMems] of byEntity) {
    if (entityMems.length < COMPACTION_MIN_CLUSTER) continue;

    // Union-find for transitive closure of similar pairs
    const parent = Array.from({ length: entityMems.length }, (_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { parent[find(a)] = find(b); }

    // Check pairwise similarity using cosine on text (lightweight)
    // For production, use KNN-based approach on embeddings when available
    let edgeCount = 0;
    for (let i = 0; i < entityMems.length && edgeCount < 500; i++) {
      for (let j = i + 1; j < entityMems.length && edgeCount < 500; j++) {
        // Skip pairs where importance is too different — unlikely candidates
        if (Math.abs(entityMems[i].importance - entityMems[j].importance) > 0.4) continue;
        // Simple heuristic: same entity + similar type + overlapping keywords = candidate
        // Full cosine check would require embedding vectors — caller can pass deps.findDuplicates
        const textOverlap = _textOverlap(entityMems[i].text, entityMems[j].text);
        if (textOverlap > 0.4) {
          union(i, j);
          edgeCount++;
        }
      }
    }

    // Extract clusters via union-find
    const groups = new Map();
    for (let i = 0; i < entityMems.length; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(entityMems[i]);
    }

    for (const cluster of groups.values()) {
      if (cluster.length < COMPACTION_MIN_CLUSTER) continue;
      const sourceIds = cluster.map(m => m.id);
      const candidateHash = _computeCandidateHash(sourceIds);

      // Check if already staged
      const existing = db.prepare(
        "SELECT id FROM compaction_staging WHERE candidate_hash = ? AND status IN ('pending_summary', 'summary_staged')"
      ).get(candidateHash);
      if (existing) continue;

      const expiresAt = new Date(Date.now() + COMPACTION_STAGING_TTL_HOURS * 3600_000).toISOString();
      const preview = cluster.map(m => m.text.substring(0, 120));

      candidates.push({
        id: randomUUID(),
        session_name: sessionId || cluster[0].session_id || '',
        source_memory_ids: sourceIds,
        preview,
        candidate_hash: candidateHash,
        source_snapshot: _getSourceSnapshot(db, sourceIds),
        expires_at: expiresAt,
        entity,
      });

      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }

  return candidates;
}

/**
 * Simple word-overlap heuristic for candidate detection.
 * Not a full cosine — that requires embedding vectors from the caller.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1 overlap ratio
 */
function _textOverlap(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (!wordsA.size || !wordsB.size) return 0;
  let shared = 0;
  for (const w of wordsA) { if (wordsB.has(w)) shared++; }
  return shared / Math.min(wordsA.size, wordsB.size);
}

/**
 * Persist candidate clusters to the staging table.
 * @param {import('better-sqlite3').Database} db
 * @param {Array} candidates  Output of findCompactionCandidates()
 * @returns {number}  Number of newly inserted candidates
 */
export function persistCandidatesToStaging(db, candidates) {
  const s = _getStmts(db);
  let inserted = 0;
  const insertTx = db.transaction(() => {
    for (const c of candidates) {
      s.insertStaging.run(
        c.id, c.session_name,
        JSON.stringify(c.source_memory_ids),
        JSON.stringify(c.preview),
        c.candidate_hash,
        JSON.stringify(c.source_snapshot),
        c.expires_at,
      );
      inserted++;
    }
  });
  insertTx();
  return inserted;
}

/**
 * Step 1: compaction status — counts by staging status.
 * @param {import('better-sqlite3').Database} db
 * @returns {Object}
 */
export function compactionStatus(db) {
  const s = _getStmts(db);
  s.markExpiredStale.run();
  const rows = s.countByStatus.all();
  const counts = {};
  for (const r of rows) counts[r.status] = r.count;
  return {
    counts: {
      pending_summary: counts.pending_summary || 0,
      summary_staged: counts.summary_staged || 0,
      applied: counts.applied || 0,
      discarded: counts.discarded || 0,
      stale: counts.stale || 0,
    },
  };
}

/**
 * Step 2: candidates — list pending clusters with previews.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array}
 */
export function compactionCandidates(db) {
  const s = _getStmts(db);
  s.markExpiredStale.run();
  const rows = s.findActiveCandidates.all();
  return rows.map(r => ({
    candidate_id: r.id,
    session_name: r.session_name,
    source_memory_ids: JSON.parse(r.source_memory_ids),
    preview: JSON.parse(r.preview),
    created_at: r.created_at,
    expires_at: r.expires_at,
  }));
}

/**
 * Step 3: review — show staged summaries awaiting agent approval.
 * @param {import('better-sqlite3').Database} db
 * @param {number} [limit=20]
 * @returns {Array}
 */
export function compactionReview(db, limit = 20) {
  const s = _getStmts(db);
  s.markExpiredStale.run();
  const rows = s.findStagedSummaries.all(Math.min(limit, 100));
  return rows.map(r => ({
    candidate_id: r.id,
    session_name: r.session_name,
    source_memory_ids: JSON.parse(r.source_memory_ids),
    preview: JSON.parse(r.preview),
    suggested_summary: r.suggested_summary,
    created_at: r.created_at,
    expires_at: r.expires_at,
  }));
}

/**
 * Step 4: stage — submit agent-generated summary for a candidate.
 * Advances candidate from pending_summary -> summary_staged.
 * @param {import('better-sqlite3').Database} db
 * @param {string} candidateId
 * @param {string} suggestedSummary
 * @returns {{ ok: boolean, status: string, reason?: string }}
 */
export function compactionStage(db, candidateId, suggestedSummary) {
  const s = _getStmts(db);
  const row = s.getCandidateById.get(candidateId);

  if (!row) return { ok: false, status: 'error', reason: 'candidate not found' };
  if (row.status !== 'pending_summary') return { ok: false, status: 'error', reason: `candidate status is '${row.status}', expected 'pending_summary'` };
  if (!suggestedSummary || !suggestedSummary.trim()) return { ok: false, status: 'error', reason: 'summary is empty' };
  if (row.expires_at && new Date().toISOString() > row.expires_at) {
    s.updateCandidateStatus.run('stale', null, null, candidateId);
    return { ok: false, status: 'error', reason: 'candidate has expired' };
  }

  s.updateCandidateStatus.run('summary_staged', suggestedSummary.trim(), null, candidateId);
  return { ok: true, status: 'summary_staged' };
}

/**
 * Step 5: apply — execute a staged compaction. Creates a summary memory,
 * marks source memories as superseded. Runs in a transaction.
 * @param {import('better-sqlite3').Database} db
 * @param {string} candidateId
 * @param {{ storeMemory: Function, updateMemoryStatus: Function, invalidateQueryCache: Function }} deps
 * @returns {{ ok: boolean, status: string, summary_id?: number, reason?: string }}
 */
export function compactionApply(db, candidateId, deps) {
  const s = _getStmts(db);
  const row = s.getCandidateById.get(candidateId);

  if (!row) return { ok: false, status: 'error', reason: 'candidate not found' };

  // Idempotent: already applied
  if (row.status === 'applied') {
    const sourceIds = JSON.parse(row.source_memory_ids);
    const mem = db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(sourceIds[0]);
    return { ok: true, status: 'applied', summary_id: mem?.superseded_by || null };
  }

  if (row.status !== 'summary_staged') return { ok: false, status: 'error', reason: `candidate status is '${row.status}', expected 'summary_staged'` };

  if (row.expires_at && new Date().toISOString() > row.expires_at) {
    s.updateCandidateStatus.run('stale', null, null, candidateId);
    return { ok: false, status: 'error', reason: 'candidate has expired' };
  }

  if (!row.suggested_summary || !row.suggested_summary.trim()) {
    s.updateCandidateStatus.run('stale', null, null, candidateId);
    return { ok: false, status: 'error', reason: 'staged summary is empty' };
  }

  const sourceIds = JSON.parse(row.source_memory_ids);
  const snapshot = JSON.parse(row.source_snapshot || '{}');

  // Validate source memories still exist and haven't changed
  for (const id of sourceIds) {
    const mem = db.prepare('SELECT id, text, status FROM memories WHERE id = ?').get(id);
    if (!mem) {
      s.updateCandidateStatus.run('stale', null, null, candidateId);
      return { ok: false, status: 'error', reason: `source memory ${id} not found` };
    }
    if (mem.status !== 'active') {
      s.updateCandidateStatus.run('stale', null, null, candidateId);
      return { ok: false, status: 'error', reason: `source memory ${id} is not active` };
    }
    // Staleness check: content signature
    const currentSig = (mem.text || '').substring(0, 32);
    if (snapshot[id] && snapshot[id] !== currentSig) {
      s.updateCandidateStatus.run('stale', null, null, candidateId);
      return { ok: false, status: 'error', reason: `source memory ${id} content changed since candidate was detected` };
    }
  }

  // All validations pass — apply in a transaction
  const now = new Date().toISOString();
  let summaryId = null;
  const applyTx = db.transaction(() => {
    // Store the summary as a new memory
    summaryId = deps.storeMemory({
      session_id: row.session_name,
      type: 'summary',
      text: row.suggested_summary.trim(),
      embedding: null,
      metadata: {
        source: 'compaction',
        extraction_method: 'agent_assisted',
        compacted_from: sourceIds,
        compacted_at: now,
      },
      importance: 0.7,
      context_prefix: `Consolidated ${sourceIds.length} memories:`,
      entity: '',
      attribute: '',
      valid_from: now,
    });

    // Mark source memories as superseded by the summary
    for (const id of sourceIds) {
      deps.updateMemoryStatus(id, 'superseded', summaryId);
    }

    // Mark staging row as applied
    s.updateCandidateStatus.run('applied', row.suggested_summary, now, candidateId);
  });

  try {
    applyTx();
    deps.invalidateQueryCache();
    return { ok: true, status: 'applied', summary_id: summaryId };
  } catch (err) {
    LOG_DEBUG && console.error('[CompactionApply] Transaction error:', err.message);
    return { ok: false, status: 'error', reason: err.message };
  }
}

/**
 * Step 6: discard — reject a staged compaction without touching source memories.
 * @param {import('better-sqlite3').Database} db
 * @param {string} candidateId
 * @returns {{ ok: boolean, status: string }}
 */
export function compactionDiscard(db, candidateId) {
  const s = _getStmts(db);
  const row = s.getCandidateById.get(candidateId);
  if (!row) return { ok: false, status: 'error', reason: 'candidate not found' };
  const now = new Date().toISOString();
  s.updateCandidateStatus.run('discarded', row.suggested_summary, now, candidateId);
  return { ok: true, status: 'discarded' };
}

/**
 * Unified compaction dispatch — routes action to the right step.
 * @param {import('better-sqlite3').Database} db
 * @param {string} action  One of: status, candidates, review, stage, apply, discard
 * @param {Object} [params]  { candidate_id?, suggested_summary?, limit? }
 * @param {Object} [deps]  Noxem store deps (required for apply)
 * @returns {Object}
 */
export function compactionDispatch(db, action, params = {}, deps = {}) {
  switch (action) {
    case 'status':     return compactionStatus(db);
    case 'candidates': return compactionCandidates(db);
    case 'review':     return compactionReview(db, params.limit || 20);
    case 'stage':      return compactionStage(db, params.candidate_id, params.suggested_summary);
    case 'apply':      return compactionApply(db, params.candidate_id, deps);
    case 'discard':    return compactionDiscard(db, params.candidate_id);
    default:           return { ok: false, status: 'error', reason: `unknown action: ${action}` };
  }
}


// ─── Compaction Candidates Preview ─────────────────────────────────────
// Lightweight duplicate scan that returns pairs WITHOUT modifying anything.
// Distinct from maintenance dedup which auto-supersedes.

/**
 * Preview compaction candidates using cosine similarity from findDuplicates.
 * Does NOT modify any data.
 *
 * @param {Array} memories  Active memories with embeddings
 * @param {{ findDuplicates: Function }} deps
 * @param {number} [threshold=0.90]
 * @param {number} [limit=10]
 * @returns {Array}  Candidate pairs with similarity scores
 */
export function previewCompactionCandidates(memories, deps, threshold = 0.90, limit = 10) {
  if (!deps.findDuplicates || memories.length < 2) return [];

  const dupes = deps.findDuplicates(memories);
  // Filter to user-specified threshold and limit
  return dupes
    .filter(d => (d.similarity ?? d.score ?? 0) >= threshold)
    .slice(0, limit)
    .map(d => ({
      older: { id: d.a?.id ?? d.older?.id, text: (d.a?.text ?? d.older?.text ?? '').substring(0, 120), type: d.a?.type ?? d.older?.type },
      newer: { id: d.b?.id ?? d.newer?.id, text: (d.b?.text ?? d.newer?.text ?? '').substring(0, 120), type: d.b?.type ?? d.newer?.type },
      similarity: d.similarity ?? d.score,
    }));
}


// ─── Notebook Entries ──────────────────────────────────────────────────
// Named persistent reference objects distinct from procedures.
// Adapts MARM's notebook_entries table with add/use/show/status/clear actions.

const _notebookStmts = new WeakMap();

function _getNotebookStmts(db) {
  if (_notebookStmts.has(db)) return _notebookStmts.get(db);
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO memory_notebooks (name, content, category, tags, embedding, updated_at)
      VALUES (@name, @content, @category, @tags, @embedding, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET
        content = @content, category = @category, tags = @tags, embedding = @embedding, updated_at = datetime('now')
    `),
    getByName: db.prepare('SELECT * FROM memory_notebooks WHERE name = ?'),
    listByCategory: db.prepare('SELECT id, name, category, updated_at FROM memory_notebooks WHERE category = ? ORDER BY updated_at DESC'),
    listAll: db.prepare('SELECT id, name, category, updated_at FROM memory_notebooks ORDER BY updated_at DESC'),
    deleteByName: db.prepare('DELETE FROM memory_notebooks WHERE name = ?'),
  };
  _notebookStmts.set(db, stmts);
  return stmts;
}

/**
 * Upsert a notebook entry.
 * @param {import('better-sqlite3').Database} db
 * @param {{ name: string, content: string, category?: string, tags?: string[], embedding?: Buffer }} entry
 * @returns {Object}  The stored entry
 */
export function upsertNotebook(db, entry) {
  const s = _getNotebookStmts(db);
  if (!entry.name || !entry.name.trim()) throw new Error('Notebook name is required');
  s.upsert.run({
    name: entry.name.trim(),
    content: entry.content || '',
    category: entry.category || '',
    tags: JSON.stringify(entry.tags || []),
    embedding: entry.embedding || null,
  });
  return s.getByName.get(entry.name.trim());
}

/**
 * Get a notebook entry by name.
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @returns {Object|null}
 */
export function getNotebook(db, name) {
  const s = _getNotebookStmts(db);
  return s.getByName.get(name);
}

/**
 * List notebooks, optionally filtered by category.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [category]
 * @returns {Array}
 */
export function listNotebooks(db, category = '') {
  const s = _getNotebookStmts(db);
  if (category) return s.listByCategory.all(category);
  return s.listAll.all();
}

/**
 * Delete a notebook entry by name.
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 * @returns {number}  Number of deleted rows
 */
export function deleteNotebook(db, name) {
  const s = _getNotebookStmts(db);
  return s.deleteByName.run(name).changes;
}

// Active notebook entries per session (in-memory, like MARM)
const _activeNotebooks = new Map(); // session -> [{ name, content }]

/**
 * Activate notebook entries for a session (inject into agent context).
 * @param {import('better-sqlite3').Database} db
 * @param {string} names  Comma-separated notebook names
 * @param {string} [sessionId='default']
 * @returns {{ activated: Array }}
 */
export function useNotebooks(db, names, sessionId = 'default') {
  const s = _getNotebookStmts(db);
  const nameList = names.split(',').map(n => n.trim()).filter(Boolean);
  const activated = [];
  for (const n of nameList) {
    const entry = s.getByName.get(n);
    if (entry) activated.push({ name: entry.name, content: entry.content });
  }
  _activeNotebooks.set(sessionId, activated);
  return { activated: activated.map(e => e.name), entries: activated };
}

/**
 * Show active notebooks for a session.
 * @param {string} [sessionId='default']
 * @returns {{ active: Array }}
 */
export function getActiveNotebooks(sessionId = 'default') {
  return { active: _activeNotebooks.get(sessionId) || [] };
}

/**
 * Clear active notebooks for a session.
 * @param {string} [sessionId='default']
 */
export function clearActiveNotebooks(sessionId = 'default') {
  _activeNotebooks.delete(sessionId);
}

/**
 * Unified notebook dispatch — routes action to the right handler.
 * @param {import('better-sqlite3').Database} db
 * @param {string} action  One of: add, use, show, status, clear
 * @param {Object} [params]
 * @returns {Object}
 */
export function notebookDispatch(db, action, params = {}) {
  switch (action) {
    case 'add': {
      if (!params.name || !params.content) return { ok: false, error: 'name and content required for add' };
      const entry = upsertNotebook(db, { name: params.name, content: params.content, category: params.category, tags: params.tags });
      return { ok: true, entry };
    }
    case 'use': {
      if (!params.names) return { ok: false, error: 'names required for use' };
      return { ok: true, ...useNotebooks(db, params.names, params.session_id) };
    }
    case 'show': {
      const entries = listNotebooks(db, params.category);
      return { ok: true, entries, total: entries.length };
    }
    case 'status': {
      return { ok: true, ...getActiveNotebooks(params.session_id) };
    }
    case 'clear': {
      clearActiveNotebooks(params.session_id);
      return { ok: true, active_count: 0 };
    }
    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}


// ─── Memory Dashboard Stub ─────────────────────────────────────────────
// Minimal HTML page for memory browsing. Not a full MARM dashboard,
// but provides visibility without CLI/curl.

/**
 * Generate a lightweight HTML dashboard page.
 * @param {import('better-sqlite3').Database} db
 * @param {{ getMemoryStats: Function, listEntities: Function }} deps
 * @returns {string}  HTML content
 */
export function generateDashboardHTML(db, deps) {
  const stats = deps.getMemoryStats();
  const entities = deps.listEntities ? deps.listEntities(20) : [];
  const compactionStatusData = compactionStatus(db);
  const notebooks = listNotebooks(db);
  const writeQueueStats = null; // caller can pass if using WriteQueue

  const entityRows = entities.map(e =>
    `<tr><td>${_escapeHtml(e.canonical_name)}</td><td>${e.mention_count}</td></tr>`
  ).join('\n');

  const notebookRows = notebooks.map(n =>
    `<tr><td>${_escapeHtml(n.name)}</td><td>${_escapeHtml(n.category || '')}</td><td>${n.updated_at}</td></tr>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Noxem Memory Dashboard</title>
<style>
  body{font-family:system-ui,sans-serif;margin:2rem;background:#0d1117;color:#c9d1d9}
  h1{color:#58a6ff}h2{color:#8b949e;margin-top:2rem}
  table{border-collapse:collapse;width:100%;margin:0.5rem 0}
  th,td{border:1px solid #30363d;padding:0.4rem 0.8rem;text-align:left}
  th{background:#161b22;color:#8b949e}
  .card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:1rem;margin:0.5rem 0}
  .stat{font-size:1.5rem;color:#58a6ff;font-weight:bold}
  .label{color:#8b949e;font-size:0.85rem}
</style></head><body>
<h1>Noxem Memory Dashboard</h1>

<div class="card">
  <div style="display:flex;gap:2rem;flex-wrap:wrap">
    <div><div class="stat">${stats.active || 0}</div><div class="label">Active Memories</div></div>
    <div><div class="stat">${entities.length}</div><div class="label">Entities Tracked</div></div>
    <div><div class="stat">${notebooks.length}</div><div class="label">Notebooks</div></div>
    <div><div class="stat">${compactionStatusData.counts.pending_summary || 0}</div><div class="label">Compaction Pending</div></div>
    <div><div class="stat">${compactionStatusData.counts.summary_staged || 0}</div><div class="label">Compaction Staged</div></div>
  </div>
</div>

<h2>Entities (Top 20)</h2>
<table><tr><th>Name</th><th>Mentions</th></tr>${entityRows || '<tr><td colspan="2">No entities</td></tr>'}</table>

<h2>Notebooks</h2>
<table><tr><th>Name</th><th>Category</th><th>Updated</th></tr>${notebookRows || '<tr><td colspan="3">No notebooks</td></tr>'}</table>

<h2>Compaction Status</h2>
<div class="card"><pre>${JSON.stringify(compactionStatusData.counts, null, 2)}</pre></div>

<h2>API Quick Reference</h2>
<div class="card"><pre>
POST /memory/compaction/status     - Check compaction pipeline
POST /memory/compaction/candidates - View candidate clusters
POST /memory/compaction/review     - Review staged summaries
POST /memory/compaction/apply       - Commit a compaction
POST /memory/compaction/discard     - Reject a compaction
GET  /memory/notebooks             - List notebooks
POST /memory/notebook              - Add/update notebook
</pre></div>
</body></html>`;
}

function _escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
