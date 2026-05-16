import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initVectorIndex, insertVec, insertVecBatch, isVecReady, knnSearch } from './vector-index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Resolve DB path relative to project root (not CWD) — prevents "db not found" when launched from different CWD
const DB_DIR = process.env.MEMORY_DB_DIR || path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(DB_DIR, 'hermes-memory.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const isNewDb = !fs.existsSync(DB_PATH);
const db = new Database(DB_PATH);
if (isNewDb) {
  db.pragma('page_size = 32768'); // Optimal for BLOB/vector I/O — must set before first table
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -64000'); // 64 MiB page cache
db.pragma('mmap_size = 268435456'); // 256 MiB memory-mapped I/O
db.pragma('temp_store = MEMORY');
db.pragma('wal_autocheckpoint = 1000');
db.pragma('journal_size_limit = 67108864'); // 64 MiB WAL cap

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'general',
  text TEXT NOT NULL,
  embedding BLOB,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER REFERENCES memories(id),
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
  USING fts5(text, content='memories', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

  `);

// Covering indexes for search performance
try { db.exec('CREATE INDEX IF NOT EXISTS idx_memories_active_type ON memories(status, type, importance DESC, created_at DESC)'); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active_recent ON memories(status, created_at DESC, importance DESC) WHERE status = 'active'"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active_entity ON memories(entity, status, importance DESC) WHERE status = 'active'"); } catch {}

// Schema migrations — add tracking columns to existing databases
try { db.exec(`ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN last_recalled_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN context_prefix TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN entity TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN attribute TEXT NOT NULL DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN valid_from TEXT`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN valid_until TEXT`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN source_memory_ids TEXT NOT NULL DEFAULT '[]'`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_entity_attr ON memories(entity, attribute)`); } catch {}

  try { db.exec('ALTER TABLE memories ADD COLUMN compression_level INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE memories ADD COLUMN compressed_from INTEGER REFERENCES memories(id)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_memories_compression ON memories(compression_level, status)'); } catch {}

  // memory_raw: stores original text for drill-down from compressed memories
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS memory_raw (
      memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      raw_text TEXT NOT NULL,
      stored_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `) } catch {}


  // Citation log: track which memories influenced LLM responses
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS citation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL REFERENCES memories(id),
      session_id TEXT NOT NULL DEFAULT '',
      cited_at TEXT NOT NULL DEFAULT (datetime('now')),
      context TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_citation_memory ON citation_log(memory_id);
    CREATE INDEX IF NOT EXISTS idx_citation_session ON citation_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_citation_cited ON citation_log(cited_at);
  `) } catch {}


  // Phase 1: Knowledge Graph + Core Memory
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS memory_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL REFERENCES memories(id),
      to_id INTEGER NOT NULL REFERENCES memories(id),
      relation TEXT NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      strength REAL NOT NULL DEFAULT 1.0,
      source_session_id TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_edges_relation ON memory_edges(relation);
    CREATE INDEX IF NOT EXISTS idx_edges_from_relation ON memory_edges(from_id, relation);
  `) } catch {}

  try { db.exec(`
    CREATE TABLE IF NOT EXISTS core_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      char_limit INTEGER NOT NULL DEFAULT 500,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_core_memory_key ON core_memory(key);
  `) } catch {}

// Session-based conversation storage: sessions + session_messages tables
let sessionsTableReady = false;
try { db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL DEFAULT '',
  session_title TEXT NOT NULL DEFAULT '',
  session_summary TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','idle','completed','archived')),
  model_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  last_active_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  completed_at INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, last_active_at);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(last_active_at DESC);
`);
  sessionsTableReady = true;
} catch (e) { console.warn('[Schema] sessions table creation failed:', e.message); }

let sessionMessagesReady = false;
try { db.exec(`
CREATE TABLE IF NOT EXISTS session_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content_type TEXT NOT NULL DEFAULT 'text',
  content_text TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  sequence_num INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id, sequence_num);
CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_session_messages_tool ON session_messages(tool_name) WHERE tool_name IS NOT NULL;
`);
  sessionMessagesReady = true;
} catch (e) { console.warn('[Schema] session_messages table creation failed:', e.message); }

// FTS5 index on session_messages.content_text for cross-session search
let ftsReady = false;
if (sessionMessagesReady) {
  try { db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(content_text, tokenize="porter unicode61 remove_diacritics 1 tokenchars '_-.@'", content='session_messages', content_rowid='rowid');
  `);
    ftsReady = true;
  } catch (e) { console.warn('[Schema] messages_fts creation failed - cross-session search disabled:', e.message); }
}

// FTS sync triggers for session_messages
if (ftsReady) {
  try { db.exec(`
  CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
    INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
  END;
  CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
  END;
  CREATE TRIGGER IF NOT EXISTS session_messages_au AFTER UPDATE ON session_messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
    INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
  END;
  `) } catch (e) { console.warn('[Schema] FTS triggers creation failed:', e.message); }
}

const SESSION_STORAGE_READY = sessionsTableReady && sessionMessagesReady && ftsReady;
if (!SESSION_STORAGE_READY) {
  console.warn('[Schema] Session storage tables NOT available - session conversations will NOT be saved');
}

// Initialize sqlite-vec for native KNN (optional — falls back to JS cosine)
initVectorIndex(db).catch(() => {});

const insert = db.prepare(
  `INSERT INTO memories (session_id, type, text, embedding, metadata, importance, context_prefix, entity, attribute, valid_from)
  VALUES (@session_id, @type, @text, @embedding, @metadata, @importance, @context_prefix, @entity, @attribute, @valid_from)`
);

const insertTx = db.transaction((items) => {
  const ids = [];
  for (const m of items) {
    const r = insert.run(m);
    ids.push(r.lastInsertRowid);
  }
  return ids;
});

const updateStatus = db.prepare(
  `UPDATE memories SET status = @status, superseded_by = @superseded_by, updated_at = datetime('now') WHERE id = @id`
);

const updateType = db.prepare(
  `UPDATE memories SET type = @type, updated_at = datetime('now') WHERE id = @id`
);

const removeById = db.prepare(`DELETE FROM memories WHERE id = ?`);
const removeByStatus = db.prepare(`DELETE FROM memories WHERE status = 'invalid'`);
const archiveStale = db.prepare(`UPDATE memories SET status = 'archived', updated_at = datetime('now') WHERE status = 'active' AND recall_count = 0 AND created_at < datetime('now', '-90 days')`);

const incrementRecall = db.prepare(
  `UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = datetime('now'), importance = MIN(1.0, importance + 0.01) WHERE id = ?`
);
const incrementRecallTx = db.transaction((ids) => {
  for (const id of ids) incrementRecall.run(id);
});

// Search feedback loop: stronger boost for memories that actually influenced the response
const boostUsedMemory = db.prepare(
  `UPDATE memories SET importance = MIN(1.0, importance + 0.03), metadata = json_set(COALESCE(metadata, '{}'), '$.use_count', COALESCE(json_extract(metadata, '$.use_count'), 0) + 1), updated_at = datetime('now') WHERE id = ? AND status = 'active'`
);
const boostUsedMemoriesTx = db.transaction((ids) => {
  for (const id of ids) boostUsedMemory.run(id);
});

const getById = db.prepare(`SELECT * FROM memories WHERE id = ?`);

const getActive = db.prepare(`SELECT * FROM memories WHERE status = 'active' ORDER BY created_at DESC LIMIT ?`);
const getActiveAll = db.prepare(`SELECT * FROM memories WHERE status = 'active'`);
const getBySession = db.prepare(`SELECT * FROM memories WHERE session_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?`);
const getByType = db.prepare(`SELECT * FROM memories WHERE type = ? AND status = 'active' ORDER BY created_at DESC LIMIT ?`);
const getBySessionBefore = db.prepare(`SELECT * FROM memories WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`);

const countAll = db.prepare(`SELECT status, type, COUNT(*) as count FROM memories GROUP BY status, type`);
const countActive = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE status = 'active'`);
const getSuperseded = db.prepare(`SELECT * FROM memories WHERE status = 'superseded'`);
const getByEntityAttr = db.prepare(`SELECT * FROM memories WHERE entity = ? AND attribute = ? AND status = 'active' ORDER BY created_at DESC`);

const searchFts = db.prepare(`
  SELECT m.id, m.session_id, m.type, m.text, m.status, m.metadata, m.created_at, m.importance, m.recall_count,
         rank as score
  FROM memories_fts f
  JOIN memories m ON m.id = f.rowid
  WHERE memories_fts MATCH @query AND m.status = 'active'
  ORDER BY rank
  LIMIT @limit
`);

const searchRecent = db.prepare(`
  SELECT id, session_id, type, text, status, metadata, created_at, importance, recall_count
  FROM memories
  WHERE status = 'active' AND text LIKE @query
  ORDER BY created_at DESC
  LIMIT @limit
`);

const getActiveWithEmbeddings = db.prepare(
  `SELECT id, type, text, embedding, created_at, importance, recall_count FROM memories WHERE status = 'active' AND embedding IS NOT NULL`
);

const getAllWithEmbeddings = db.prepare(
  `SELECT id, type, text, embedding, status, created_at FROM memories WHERE embedding IS NOT NULL`
);

const getWithoutEmbedding = db.prepare(
  `SELECT id, text FROM memories WHERE embedding IS NULL AND status = 'active' LIMIT ?`
);

const updateEmbedding = db.prepare(
  `UPDATE memories SET embedding = ? WHERE id = ?`
);
// Graph edge prepared statements
const insertEdge = db.prepare('INSERT INTO memory_edges (from_id, to_id, relation, valid_from, valid_until, strength, source_session_id, metadata) VALUES (@from_id, @to_id, @relation, @valid_from, @valid_until, @strength, @source_session_id, @metadata)');
const getEdgesFrom = db.prepare('SELECT * FROM memory_edges WHERE from_id = ? AND (valid_until IS NULL OR valid_until > datetime(\'now\')) ORDER BY strength DESC');
const getEdgesTo = db.prepare('SELECT * FROM memory_edges WHERE to_id = ? AND (valid_until IS NULL OR valid_until > datetime(\'now\')) ORDER BY strength DESC');
const getEdgesByRelation = db.prepare('SELECT * FROM memory_edges WHERE relation = ? AND (valid_until IS NULL OR valid_until > datetime(\'now\')) ORDER BY created_at DESC LIMIT ?');
const invalidateEdge = db.prepare('UPDATE memory_edges SET valid_until = datetime(\'now\') WHERE id = ? AND valid_until IS NULL');
const getEdgeById = db.prepare('SELECT * FROM memory_edges WHERE id = ?');

// Recursive graph traversal: multi-hop from a starting memory
const traverseGraph = db.prepare(`
  WITH RECURSIVE graph_walk(id, from_id, to_id, relation, strength, depth, path) AS (
    SELECT e.id, e.from_id, e.to_id, e.relation, e.strength, 1, '/' || e.from_id || '-' || e.relation || '->' || e.to_id || '/'
    FROM memory_edges e
    WHERE e.from_id = ? AND (e.valid_until IS NULL OR e.valid_until > datetime('now'))
    UNION ALL
    SELECT e.id, e.from_id, e.to_id, e.relation, gw.strength * e.strength, gw.depth + 1, gw.path || e.from_id || '-' || e.relation || '->' || e.to_id || '/'
    FROM memory_edges e
    JOIN graph_walk gw ON e.from_id = gw.to_id
    WHERE gw.depth < ? AND (e.valid_until IS NULL OR e.valid_until > datetime('now')) AND gw.path NOT LIKE '%/' || e.to_id || '/%'
  )
  SELECT * FROM graph_walk ORDER BY depth, strength DESC LIMIT ?
`);

// Core memory prepared statements
const upsertCoreMemory = db.prepare('INSERT INTO core_memory (key, value, description, char_limit) VALUES (@key, @value, @description, @char_limit) ON CONFLICT(key) DO UPDATE SET value = @value, description = @description, char_limit = @char_limit, updated_at = datetime(\'now\')');
const getCoreMemory = db.prepare('SELECT * FROM core_memory WHERE key = ?');
const getAllCoreMemory = db.prepare('SELECT * FROM core_memory ORDER BY key');
const deleteCoreMemory = db.prepare('DELETE FROM core_memory WHERE key = ?');

// Compression prepared statements
const updateCompression = db.prepare('UPDATE memories SET text = @text, compression_level = @level, updated_at = datetime(\'now\') WHERE id = @id');
const insertRaw = db.prepare('INSERT OR REPLACE INTO memory_raw (memory_id, raw_text) VALUES (@memory_id, @raw_text)');
const getRaw = db.prepare('SELECT raw_text FROM memory_raw WHERE memory_id = ?');
const getCompressible = db.prepare('SELECT id, text, type, created_at, compression_level FROM memories WHERE status = \'active\' AND compression_level < ? AND created_at < datetime(\'now\', \'-\' || ? || \' days\') ORDER BY created_at ASC LIMIT ?');


// Citation log prepared statements
const insertCitation = db.prepare('INSERT INTO citation_log (memory_id, session_id, context) VALUES (?, ?, ?)');
const getCitationsByMemory = db.prepare('SELECT COUNT(*) as count FROM citation_log WHERE memory_id = ? AND cited_at > datetime(\'now\', \'-30 days\')');
const getCitationsBySession = db.prepare('SELECT memory_id, COUNT(*) as count FROM citation_log WHERE session_id = ? GROUP BY memory_id ORDER BY count DESC LIMIT ?');



// Convert SQLite BLOB (Node Buffer) to a regular JS array of float32 values
function bufferToFloat32(buf) {
  if (!buf) return null;
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT));
}

// Ensure embedding is a Node Buffer for SQLite BLOB binding
// Accepts Buffer, Float32Array, ArrayBuffer, or plain array
function ensureEmbeddingBuffer(embedding) {
  if (!embedding) return null;
  if (Buffer.isBuffer(embedding)) return embedding;
  if (embedding instanceof Float32Array) return Buffer.from(embedding.buffer);
  if (embedding instanceof ArrayBuffer) return Buffer.from(embedding);
  if (Array.isArray(embedding)) return Buffer.from(new Float32Array(embedding).buffer);
  return null;
}

export function storeMemory({ session_id, type, text, embedding = null, metadata = {}, importance = 0.5, context_prefix = '', entity = '', attribute = '', valid_from = null }) {
  embedding = ensureEmbeddingBuffer(embedding);
  const result = insert.run({
    session_id: session_id || '',
    type: type || 'general',
    text: text,
    embedding: embedding,
    metadata: JSON.stringify(metadata),
    importance,
    context_prefix,
    entity,
    attribute,
    valid_from: valid_from || new Date().toISOString(),
  });
  const id = result.lastInsertRowid;
  // Update vector index if embedding provided
  if (embedding) {
    try {
      const vec = bufferToFloat32(embedding);
      insertVec(db, id, vec);
    } catch {}
  }
  return id;
}

export function storeMemories(items) {
  const now = new Date().toISOString();
  const prepared = items.map(m => ({
    session_id: m.session_id || '',
    type: m.type || 'general',
    text: m.text,
    embedding: m.embedding || null,
    metadata: JSON.stringify(m.metadata || {}),
    importance: m.importance ?? 0.5,
    context_prefix: m.context_prefix || '',
    entity: m.entity || '',
    attribute: m.attribute || '',
    valid_from: m.valid_from || now,
  }));
  return insertTx(prepared);
}

export function updateMemoryStatus(id, status, supersededBy = null) {
  updateStatus.run({ id, status, superseded_by: supersededBy });
}

export function updateMemoryType(id, type) {
  updateType.run({ id, type });
}

export function deleteMemory(id) {
  removeById.run(id);
  try { deleteVec(db, id); } catch {} // clean vector index
}

export function deleteInvalid() {
  const result = removeByStatus.run();
  return result.changes;
}

export function searchMemories({ query, limit = 10 }) {
  if (!query || !query.trim()) return [];
  const limitNum = Math.min(Math.max(1, limit), 50);
  try {
    const sanitized = query.replace(/['"]/g, '').replace(/[^\w\s]/g, ' ').trim();
    if (!sanitized) return searchRecent.all({ query: `%${query}%`, limit: limitNum });
    return searchFts.all({ query: sanitized, limit: limitNum });
  } catch {
    return searchRecent.all({ query: `%${query}%`, limit: limitNum });
  }
}

export function getMemory(id) {
  return getById.get(id);
}

export function getActiveMemories(limit = 50) {
  return getActive.all(Math.min(limit, 500));
}

export function getAllActiveMemories() {
  return getActiveAll.all().map(m => ({ ...m, embedding: bufferToFloat32(m.embedding) }));
}

export function getSessionMemories(sessionId, limit = 50) {
  return getBySession.all(sessionId, Math.min(limit, 200));
}

export function getMemoriesByType(type, limit = 50) {
  return getByType.all(type, Math.min(limit, 200));
}

export function getSessionMemoriesBefore(sessionId, beforeDate, limit = 50) {
  return getBySessionBefore.all(sessionId, beforeDate, Math.min(limit, 200));
}

export function getActiveWithEmbedding() {
  return getActiveWithEmbeddings.all().map(m => ({ ...m, embedding: bufferToFloat32(m.embedding) }));
}

export function getAllWithEmbedding() {
  return getAllWithEmbeddings.all().map(m => ({ ...m, embedding: bufferToFloat32(m.embedding) }));
}

export function getMemoryStats() {
  const counts = countAll.all();
  const active = countActive.get();
  return { active: active.count, breakdown: counts };
}

export function getSupersededMemories() {
  return getSuperseded.all();
}

export function incrementRecallCounts(ids) {
  if (!ids?.length) return;
  incrementRecallTx(ids);
}

export function boostUsedMemories(ids) {
  if (!ids?.length) return 0;
  boostUsedMemoriesTx(ids);
  return ids.length;
}

export function archiveStaleMemories() {
  const result = archiveStale.run();
  return result.changes;
}

export function getMemoriesWithoutEmbedding(limit = 100) {
  return getWithoutEmbedding.all(Math.min(limit, 500));
}

export function updateMemoryEmbedding(id, embedding) {
  updateEmbedding.run(ensureEmbeddingBuffer(embedding), id);
}

export function addVecsToIndex(ids, embeddings) {
  insertVecBatch(db, ids, embeddings);
}

export function vectorKnnSearch(queryEmbedding, topK = 5) {
  if (!isVecReady()) return null;
  const hits = knnSearch(db, queryEmbedding, topK);
  if (!hits) return null;
  // Enrich with memory data
  return hits.map(h => {
    const mem = getById.get(h.id);
    if (!mem || mem.status !== 'active') return null;
    return {
      id: mem.id,
      text: mem.text,
      type: mem.type,
      session_id: mem.session_id,
      importance: mem.importance,
      recall_count: mem.recall_count,
      created_at: mem.created_at,
      score: h.score,
    };
  }).filter(Boolean);
}

export function getTopActiveMemories(limit = 50) { return getTopActiveScored.all(Math.min(limit, 200)); }

export function getMemoriesByEntityAttr(entity, attribute) {
  if (!entity || !attribute) return [];
  return getByEntityAttr.all(entity, attribute);
}


// Graph edge operations
export function storeEdge({ from_id, to_id, relation, valid_from = null, valid_until = null, strength = 1.0, source_session_id = '', metadata = {} }) {
  return insertEdge.run({ from_id, to_id, relation, valid_from: valid_from || new Date().toISOString(), valid_until, strength, source_session_id, metadata: JSON.stringify(metadata) }).lastInsertRowid;
}

export function getEdgesFromMemory(memoryId) { return getEdgesFrom.all(memoryId); }
export function getEdgesToMemory(memoryId) { return getEdgesTo.all(memoryId); }
export function getEdgesByRel(relation, limit = 50) { return getEdgesByRelation.all(relation, Math.min(limit, 200)); }
export function invalidateEdgeById(edgeId) { return invalidateEdge.run(edgeId).changes; }
export function getEdge(edgeId) { return getEdgeById.get(edgeId); }
export function traverseMemoryGraph(fromId, maxDepth = 3, limit = 20) { return traverseGraph.all(fromId, maxDepth, limit); }

// Core memory operations
export function upsertCoreBlock({ key, value, description = '', char_limit = 500 }) {
  const truncated = value.length > char_limit ? value.substring(0, char_limit) : value;
  upsertCoreMemory.run({ key, value: truncated, description, char_limit });
  return getCoreMemory.get(key);
}
export function getCoreBlock(key) { return getCoreMemory.get(key); }
export function getAllCoreBlocks() { return getAllCoreMemory.all(); }
export function deleteCoreBlock(key) { return deleteCoreMemory.run(key).changes; }

// Compression operations
export function compressMemory(id, newText, level) {
  // Store raw text before first compression
  const mem = getById.get(id);
  if (mem && mem.compression_level === 0) {
    insertRaw.run({ memory_id: id, raw_text: mem.text });
  }
  updateCompression.run({ id, text: newText, level });
}
export function getRawText(memoryId) {
  const raw = getRaw.get(memoryId);
  return raw ? raw.raw_text : null;
}
export function getCompressibleMemories(maxLevel, olderThanDays, limit = 50) {
  return getCompressible.all(maxLevel, olderThanDays, Math.min(limit, 200));
}


// Citation operations
export function logCitation(memoryId, sessionId, context = '') {
  try { insertCitation.run(memoryId, sessionId || '', context.substring(0, 200)); } catch {}
}
export function getRecentCitationCount(memoryId) {
  return getCitationsByMemory.get(memoryId)?.count || 0;
}
export function getSessionCitations(sessionId, limit = 20) {
  return getCitationsBySession.all(sessionId || '', Math.min(limit, 100));
}


// Session prepared statements
// Session prepared statements (guarded by SESSION_STORAGE_READY)
if (SESSION_STORAGE_READY) {
  const upsertSession = db.prepare(`
    INSERT INTO sessions (session_id, project_path, model_name, last_active_at)
    VALUES (@session_id, @project_path, @model_name, @last_active_at)
    ON CONFLICT(session_id) DO UPDATE SET
      last_active_at = @last_active_at,
      project_path = CASE WHEN @project_path != '' THEN @project_path ELSE sessions.project_path END,
      model_name = CASE WHEN @model_name != '' THEN @model_name ELSE sessions.model_name END
  `);
  const getSessionById = db.prepare('SELECT * FROM sessions WHERE session_id = ?');
  const updateSessionStatus = db.prepare('UPDATE sessions SET status = @status, completed_at = @completed_at WHERE session_id = @session_id');
  const updateSessionSummary = db.prepare('UPDATE sessions SET session_summary = @session_summary WHERE session_id = @session_id');
  const updateSessionHeartbeat = db.prepare('UPDATE sessions SET last_active_at = @last_active_at WHERE session_id = @session_id AND status = \'active\'');
  const listSessionsByStatus = db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY last_active_at DESC LIMIT ?');
  const listAllSessions = db.prepare('SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT ? OFFSET ?');

  // Session message prepared statements
  const insertSessionMessage = db.prepare(`
    INSERT INTO session_messages (message_id, session_id, role, content_type, content_text, tool_calls, tool_call_id, tool_name, timestamp, sequence_num, token_count)
    VALUES (@message_id, @session_id, @role, @content_type, @content_text, @tool_calls, @tool_call_id, @tool_name, @timestamp, @sequence_num, @token_count)
  `);
  const getMessagesBySession = db.prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY sequence_num ASC LIMIT ? OFFSET ?');
  const getMessagesBySessionDesc = db.prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY sequence_num DESC LIMIT ?');
  const countMessagesBySession = db.prepare('SELECT COUNT(*) as count, MAX(timestamp) as last_msg_at, MIN(timestamp) as first_msg_at FROM session_messages WHERE session_id = ?');
  const deleteMessagesBySession = db.prepare('DELETE FROM session_messages WHERE session_id = ?');
  const getNextSequenceNum = db.prepare('SELECT COALESCE(MAX(sequence_num), 0) + 1 as next_seq FROM session_messages WHERE session_id = ?');

  // Cross-session FTS search prepared statements
  const searchMessagesFts = db.prepare(`
    SELECT m.message_id, m.session_id, m.role, m.content_type, m.content_text, m.tool_calls, m.tool_name, m.timestamp, m.sequence_num,
      s.session_title, s.status as session_status,
      f.rank as fts_rank
    FROM messages_fts f
    JOIN session_messages m ON m.rowid = f.rowid
    JOIN sessions s ON m.session_id = s.session_id
    WHERE messages_fts MATCH @query
      AND (m.session_id != @exclude_session_id OR @exclude_session_id = '')
      AND s.status != 'archived'
    ORDER BY f.rank
    LIMIT @limit
  `);
  const searchMessagesFtsAll = db.prepare(`
    SELECT m.message_id, m.session_id, m.role, m.content_type, m.content_text, m.tool_calls, m.tool_name, m.timestamp, m.sequence_num,
      s.session_title, s.status as session_status,
      f.rank as fts_rank
    FROM messages_fts f
    JOIN session_messages m ON m.rowid = f.rowid
    JOIN sessions s ON m.session_id = s.session_id
    WHERE messages_fts MATCH @query
      AND s.status != 'archived'
    ORDER BY f.rank
    LIMIT @limit
  `);

  // Stale session detection
  const getStaleSessions = db.prepare(`
    SELECT session_id, last_active_at FROM sessions
    WHERE status = 'active' AND last_active_at < (? - @threshold_ms)
  `);
  const archiveOldSessions = db.prepare(`
    DELETE FROM sessions WHERE status = 'archived' AND completed_at < (? - @retention_ms)
  `);

} else {
  const upsertSession = { run: () => {} };
  const getSessionById = { get: () => null };
  const updateSessionStatus = { run: () => {} };
  const updateSessionSummary = { run: () => {} };
  const updateSessionHeartbeat = { run: () => {} };
  const listSessionsByStatus = { all: () => [] };
  const listAllSessions = { all: () => [] };
  const insertSessionMessage = { run: () => {} };
  const getMessagesBySession = { all: () => [] };
  const getMessagesBySessionDesc = { all: () => [] };
  const countMessagesBySession = { get: () => ({ count: 0, last_msg_at: null, first_msg_at: null }) };
  const deleteMessagesBySession = { run: () => {} };
  const getNextSequenceNum = { get: () => ({ next_seq: 1 }) };
  const searchMessagesFts = { all: () => [] };
  const searchMessagesFtsAll = { all: () => [] };
  const getStaleSessions = { all: () => [] };
  const archiveOldSessions = { run: () => ({ changes: 0 }) };
}

// ─── Session operation exports ──────────────────────────────────

export function upsertSessionRecord({ session_id, project_path = '', model_name = '' }) {
  if (!session_id) return;
  const now = Date.now();
  upsertSession.run({ session_id, project_path, model_name, last_active_at: now });
  return getSessionById.get(session_id);
}

export function getSession(sessionId) {
  return getSessionById.get(sessionId);
}

export function updateSessionStatusById(sessionId, status, completedAt = null) {
  updateSessionStatus.run({
    session_id: sessionId,
    status,
    completed_at: completedAt || (status === 'completed' || status === 'archived' ? Date.now() : null),
  });
}

export function updateSessionSummaryById(sessionId, summary) {
  updateSessionSummary.run({ session_id: sessionId, session_summary: typeof summary === 'string' ? summary : JSON.stringify(summary) });
}

export function heartbeatSession(sessionId) {
  if (!sessionId) return;
  updateSessionHeartbeat.run({ last_active_at: Date.now() });
}

export function listSessions(status = null, limit = 50, offset = 0) {
  if (status) return listSessionsByStatus.all(status, Math.min(limit, 200));
  return listAllSessions.all(Math.min(limit, 200), offset);
}

export function storeSessionMessage({ session_id, role, content_type = 'text', content_text = '', tool_calls = null, tool_call_id = null, tool_name = null, token_count = null }) {
  if (!session_id) return null;
  const { next_seq } = getNextSequenceNum.get(session_id);
  const message_id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  insertSessionMessage.run({
    message_id,
    session_id,
    role,
    content_type,
    content_text,
    tool_calls: tool_calls ? (typeof tool_calls === 'string' ? tool_calls : JSON.stringify(tool_calls)) : null,
    tool_call_id,
    tool_name,
    timestamp: Date.now(),
    sequence_num: next_seq,
    token_count,
  });
  // Update session heartbeat
  heartbeatSession(session_id);
  return message_id;
}

export function getSessionMessages(sessionId, limit = 50, offset = 0) {
  return getMessagesBySession.all(sessionId, Math.min(limit, 500), offset);
}

export function getRecentSessionMessages(sessionId, limit = 20) {
  return getMessagesBySessionDesc.all(sessionId, Math.min(limit, 200));
}

export function getSessionMessageStats(sessionId) {
  return countMessagesBySession.get(sessionId);
}

export function searchCrossSessionMessages({ query, exclude_session_id = '', limit = 20 }) {
  if (!query || !query.trim()) return [];
  try {
    const sanitized = query.replace(/['"]/g, '').replace(/[^\w\s]/g, ' ').trim();
    if (!sanitized) return [];
    if (exclude_session_id) {
      return searchMessagesFts.all({ query: sanitized, exclude_session_id, limit: Math.min(limit, 50) });
    }
    return searchMessagesFtsAll.all({ query: sanitized, limit: Math.min(limit, 50) });
  } catch {
    return [];
  }
}

export function getStaleSessionsList(thresholdMs = 1800000) {
  return getStaleSessions.all(Date.now(), { threshold_ms: thresholdMs });
}

export function purgeArchivedSessions(retentionMs = 7776000000) {
  return archiveOldSessions.run(Date.now(), { retention_ms: retentionMs }).changes;
}

export { db };

export function close() {
  db.close();
}
