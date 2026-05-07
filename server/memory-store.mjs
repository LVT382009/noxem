import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initVectorIndex, insertVec, insertVecBatch, isVecReady, knnSearch } from './vector-index.mjs';

const DB_DIR = process.env.MEMORY_DB_DIR || './data';
const DB_PATH = path.join(DB_DIR, 'hermes-memory.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

// Schema migrations — add recall tracking columns to existing databases
try { db.exec(`ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN last_recalled_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5`); } catch {}

// Initialize sqlite-vec for native KNN (optional — falls back to JS cosine)
initVectorIndex(db).catch(() => {});

const insert = db.prepare(
  `INSERT INTO memories (session_id, type, text, embedding, metadata)
   VALUES (@session_id, @type, @text, @embedding, @metadata)`
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
  `UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = datetime('now') WHERE id = ?`
);
const incrementRecallTx = db.transaction((ids) => {
  for (const id of ids) incrementRecall.run(id);
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

const searchFts = db.prepare(`
  SELECT m.id, m.session_id, m.type, m.text, m.status, m.metadata, m.created_at,
         rank as score
  FROM memories_fts f
  JOIN memories m ON m.id = f.rowid
  WHERE memories_fts MATCH @query AND m.status = 'active'
  ORDER BY rank
  LIMIT @limit
`);

const searchRecent = db.prepare(`
  SELECT id, session_id, type, text, status, metadata, created_at
  FROM memories
  WHERE status = 'active' AND text LIKE @query
  ORDER BY created_at DESC
  LIMIT @limit
`);

const getActiveWithEmbeddings = db.prepare(
  `SELECT id, type, text, embedding, created_at FROM memories WHERE status = 'active' AND embedding IS NOT NULL`
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

// Convert SQLite BLOB (Node Buffer) to a regular JS array of float32 values
function bufferToFloat32(buf) {
  if (!buf) return null;
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT));
}

export function storeMemory({ session_id, type, text, embedding = null, metadata = {} }) {
  const result = insert.run({
    session_id: session_id || '',
    type: type || 'general',
    text: text,
    embedding: embedding,
    metadata: JSON.stringify(metadata),
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
  const prepared = items.map(m => ({
    session_id: m.session_id || '',
    type: m.type || 'general',
    text: m.text,
    embedding: m.embedding || null,
    metadata: JSON.stringify(m.metadata || {}),
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

export function archiveStaleMemories() {
  const result = archiveStale.run();
  return result.changes;
}

export function getMemoriesWithoutEmbedding(limit = 100) {
  return getWithoutEmbedding.all(Math.min(limit, 500));
}

export function updateMemoryEmbedding(id, embedding) {
  updateEmbedding.run(embedding, id);
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
      created_at: mem.created_at,
      score: h.score,
    };
  }).filter(Boolean);
}

export { db };

export function close() {
  db.close();
}
