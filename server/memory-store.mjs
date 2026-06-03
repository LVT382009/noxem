import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initVectorIndex, insertVec, insertVecBatch, isVecReady, knnSearch, knnSearchHybrid, deleteVec, getVectorBackend, addToTurboVec, removeFromTurboVec } from './vector-index.mjs';

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

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

// v2: Schema migration framework using PRAGMA user_version
// Each migration runs in a transaction and bumps user_version on success.
// Fresh installs get CREATE TABLE IF NOT EXISTS (above) + all migrations.
// Existing DBs run only the migrations they haven't seen yet.

const DB_VERSION = 5;

function addColumn(table, column, def) {
	if (!/^[a-zA-Z_]\w*$/.test(column)) throw new Error(`Invalid column name: ${column}`);
	if (!/^[a-zA-Z_]\w*$/.test(table)) throw new Error(`Invalid table name: ${table}`);
	try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`); } catch (e) {
		if (!e.message.includes('duplicate column') && !e.message.includes('already exists')) throw e;
	}
}

const migrations = {
	1: () => {
		// v1: Add tracking, compression, and covering index columns
		addColumn('memories', 'recall_count', 'INTEGER NOT NULL DEFAULT 0');
		addColumn('memories', 'last_recalled_at', 'TEXT');
		addColumn('memories', 'importance', 'REAL NOT NULL DEFAULT 0.5');
		addColumn('memories', 'context_prefix', "TEXT NOT NULL DEFAULT ''");
		addColumn('memories', 'entity', "TEXT NOT NULL DEFAULT ''");
		addColumn('memories', 'attribute', "TEXT NOT NULL DEFAULT ''");
		addColumn('memories', 'valid_from', 'TEXT');
		addColumn('memories', 'valid_until', 'TEXT');
		addColumn('memories', 'source_memory_ids', "TEXT NOT NULL DEFAULT '[]'");
		db.exec('CREATE INDEX IF NOT EXISTS idx_memories_entity_attr ON memories(entity, attribute)');

		addColumn('memories', 'compression_level', 'INTEGER NOT NULL DEFAULT 0');
		addColumn('memories', 'compressed_from', 'INTEGER REFERENCES memories(id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_memories_compression ON memories(compression_level, status)');

		db.exec('CREATE INDEX IF NOT EXISTS idx_memories_active_type ON memories(status, type, importance DESC, created_at DESC)');
		db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active_recent ON memories(status, created_at DESC, importance DESC) WHERE status = 'active'");
		db.exec("CREATE INDEX IF NOT EXISTS idx_memories_active_entity ON memories(entity, status, importance DESC) WHERE status = 'active'");

		db.exec(`CREATE TABLE IF NOT EXISTS memory_raw (
			memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
			raw_text TEXT NOT NULL,
			stored_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		db.exec(`CREATE TABLE IF NOT EXISTS citation_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memory_id INTEGER NOT NULL REFERENCES memories(id),
			session_id TEXT NOT NULL DEFAULT '',
			cited_at TEXT NOT NULL DEFAULT (datetime('now')),
			context TEXT NOT NULL DEFAULT ''
		)`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_citation_memory ON citation_log(memory_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_citation_session ON citation_log(session_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_citation_cited ON citation_log(cited_at)');

		db.exec(`CREATE TABLE IF NOT EXISTS memory_edges (
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
		)`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_edges_from ON memory_edges(from_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_edges_to ON memory_edges(to_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_edges_relation ON memory_edges(relation)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_edges_from_relation ON memory_edges(from_id, relation)');

		db.exec(`CREATE TABLE IF NOT EXISTS core_memory (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key TEXT NOT NULL UNIQUE,
			value TEXT NOT NULL DEFAULT '',
			description TEXT NOT NULL DEFAULT '',
			char_limit INTEGER NOT NULL DEFAULT 500,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_core_memory_key ON core_memory(key)');
	},

	2: () => {
		// v2: Cone graph tables (entities, facets, facet_points, memory_entities)
		db.exec(`CREATE TABLE IF NOT EXISTS entities (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			canonical_name TEXT NOT NULL UNIQUE,
			entity_type TEXT NOT NULL DEFAULT 'generic',
			normalized_name TEXT NOT NULL DEFAULT '',
			mention_count INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type)');

		db.exec(`CREATE TABLE IF NOT EXISTS facets (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			attribute TEXT NOT NULL DEFAULT '',
			abstraction_level INTEGER NOT NULL DEFAULT 1,
			text TEXT NOT NULL DEFAULT '',
			embedding BLOB,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_facets_entity ON facets(entity_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_facets_level ON facets(abstraction_level)');

		db.exec(`CREATE TABLE IF NOT EXISTS facet_points (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			facet_id INTEGER NOT NULL REFERENCES facets(id) ON DELETE CASCADE,
			text TEXT NOT NULL DEFAULT '',
			embedding BLOB,
			point_type TEXT NOT NULL DEFAULT 'detail',
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		)`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_facet_points_facet ON facet_points(facet_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_facet_points_type ON facet_points(point_type)');

		db.exec(`CREATE TABLE IF NOT EXISTS memory_entities (
			memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
			entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
			role TEXT NOT NULL DEFAULT 'subject',
			PRIMARY KEY (memory_id, entity_id)
		)`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id)');
		
		// Backfill entities from existing memories.entity column
		const existingEntities = db.prepare(
			"SELECT entity, COUNT(*) as cnt FROM memories WHERE entity != '' AND status = 'active' GROUP BY entity"
		).all();
		const insertEntity = db.prepare(
			"INSERT OR IGNORE INTO entities (canonical_name, entity_type, normalized_name, mention_count) VALUES (?, 'generic', ?, ?)"
		);
		const linkMemory = db.prepare(
			"INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, 'subject')"
		);
		const getEntityId = db.prepare("SELECT id FROM entities WHERE canonical_name = ?");
		for (const row of existingEntities) {
			insertEntity.run(row.entity, row.entity.toLowerCase(), row.cnt);
			const eId = getEntityId.get(row.entity);
			if (eId) {
				const mems = db.prepare(
					"SELECT id FROM memories WHERE entity = ? AND status = 'active'"
				).all(row.entity);
				for (const m of mems) linkMemory.run(m.id, eId.id);
			}
		}
	},

	3: () => {
		// v3: Add cone_layer, scene_name, priority, summary, parent_facet_id, entity_id to memories
		addColumn('memories', 'cone_layer', 'INTEGER NOT NULL DEFAULT 0');
		addColumn('memories', 'scene_name', "TEXT NOT NULL DEFAULT ''");
		addColumn('memories', 'priority', 'REAL NOT NULL DEFAULT 0.5');
		addColumn('memories', 'summary', 'TEXT');
		addColumn('memories', 'parent_facet_id', 'INTEGER REFERENCES facets(id)');
		addColumn('memories', 'entity_id', 'INTEGER REFERENCES entities(id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_memories_cone_layer ON memories(cone_layer)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_memories_scene_name ON memories(scene_name)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_memories_entity_id ON memories(entity_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_memories_priority ON memories(priority)');

		// v3: Add from_type, to_type, confidence to memory_edges
		addColumn('memory_edges', 'from_type', "TEXT NOT NULL DEFAULT 'episode'");
		addColumn('memory_edges', 'to_type', "TEXT NOT NULL DEFAULT 'episode'");
		addColumn('memory_edges', 'confidence', 'REAL NOT NULL DEFAULT 1.0');
		db.exec('CREATE INDEX IF NOT EXISTS idx_edges_from_type ON memory_edges(from_type)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_edges_to_type ON memory_edges(to_type)');
	},

	4: () => {
		// v4: Expand FTS5 to index text, context_prefix, entity_name (from entity), scene_name
		// Drop existing FTS table and triggers, recreate with expanded columns
		try { db.exec('DROP TABLE IF EXISTS memories_fts'); } catch (e) { LOG_DEBUG && console.error('[Schema] Drop FTS:', e.message); }
		try { db.exec('DROP TRIGGER IF EXISTS memories_ai'); } catch (e) {}
		try { db.exec('DROP TRIGGER IF EXISTS memories_ad'); } catch (e) {}
		try { db.exec('DROP TRIGGER IF EXISTS memories_au'); } catch (e) {}

		db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
			USING fts5(text, context_prefix, entity, scene_name, content='memories', content_rowid='id')`);

		db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
			INSERT INTO memories_fts(rowid, text, context_prefix, entity, scene_name)
			VALUES (new.id, new.text, new.context_prefix, new.entity, new.scene_name);
		END`);

		db.exec(`CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, text, context_prefix, entity, scene_name)
			VALUES ('delete', old.id, old.text, old.context_prefix, old.entity, old.scene_name);
		END`);

		db.exec(`CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
			INSERT INTO memories_fts(memories_fts, rowid, text, context_prefix, entity, scene_name)
			VALUES ('delete', old.id, old.text, old.context_prefix, old.entity, old.scene_name);
			INSERT INTO memories_fts(rowid, text, context_prefix, entity, scene_name)
			VALUES (new.id, new.text, new.context_prefix, new.entity, new.scene_name);
		END`);

		// Rebuild FTS index from existing memories
		db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
	},
	5: () => {
		db.exec(`CREATE TABLE IF NOT EXISTS procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      trigger_context TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      use_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      session_id TEXT DEFAULT ''
    )`);
		db.exec(`CREATE TABLE IF NOT EXISTS procedure_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      step_type TEXT DEFAULT 'action',
      expected_outcome TEXT DEFAULT '',
      step_context TEXT DEFAULT ''
    )`);
		db.exec(`CREATE TABLE IF NOT EXISTS procedure_context_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
      context_type TEXT NOT NULL,
      context_value TEXT NOT NULL,
      source_memory_id INTEGER
    )`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_procedures_name ON procedures(name)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_procedure_steps_procedure ON procedure_steps(procedure_id)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_procedure_context_procedure ON procedure_context_points(procedure_id)');
	}

};// Run pending migrations
const currentVersion = db.pragma('user_version', { simple: true });
for (let v = currentVersion + 1; v <= DB_VERSION; v++) {
	const migrate = db.transaction(() => {
		if (!migrations[v]) throw new Error(`Unknown migration version: ${v}`);
		migrations[v]();
		db.pragma(`user_version = ${v}`);
	});
	try {
		migrate();
		LOG_DEBUG && console.log(`[Schema] Migration v${v} applied (user_version=${v})`);
	} catch (err) {
		console.error(`[Schema] Migration v${v} FAILED: ${err.message}`);
		break;
	}
}



// Procedural Memory Operations
const insertProcedure = db.prepare('INSERT INTO procedures (name, description, trigger_context, session_id) VALUES (?, ?, ?, ?)');
const insertStep = db.prepare('INSERT INTO procedure_steps (procedure_id, step_order, text, step_type, expected_outcome, step_context) VALUES (?, ?, ?, ?, ?, ?)');
const insertContextPoint = db.prepare('INSERT INTO procedure_context_points (procedure_id, context_type, context_value, source_memory_id) VALUES (?, ?, ?, ?)');
const getProcedureById = db.prepare('SELECT * FROM procedures WHERE id = ?');
const getProcedureSteps = db.prepare('SELECT * FROM procedure_steps WHERE procedure_id = ? ORDER BY step_order');
const getProcedureContextPoints = db.prepare('SELECT * FROM procedure_context_points WHERE procedure_id = ?');
const listProcedures = db.prepare('SELECT * FROM procedures ORDER BY use_count DESC, updated_at DESC LIMIT ?');
const touchProcedure = db.prepare("UPDATE procedures SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id = ?");
const deleteProcedure = db.prepare('DELETE FROM procedures WHERE id = ?');

export function storeProcedure({ name, description = '', trigger_context = '', session_id = '', steps = [], context_points = [] }) {
	return db.transaction(() => {
		const procId = Number(insertProcedure.run(name, description, trigger_context, session_id).lastInsertRowid);
		for (let i = 0; i < steps.length; i++) {
			const s = steps[i];
			insertStep.run(procId, i, s.text || '', s.step_type || 'action', s.expected_outcome || '', s.step_context || '');
		}
		for (const cp of context_points) {
			insertContextPoint.run(procId, cp.context_type || '', cp.context_value || '', cp.source_memory_id || null);
		}
		return procId;
	})();
}

export function getProcedure(id) {
  const proc = getProcedureById.get(id);
  if (!proc) return null;
  proc.steps = getProcedureSteps.all(id);
  proc.context_points = getProcedureContextPoints.all(id);
  return proc;
}

export function listAllProcedures(limit = 50) {
  return listProcedures.all(Math.min(limit, 200));
}

export function touchProcedureUse(id) { touchProcedure.run(id); }

export function deleteProcedureById(id) { return deleteProcedure.run(id).changes; }

export function searchProcedures(query, limit = 10) {
  const q = `%${query.replace(/[%_]/g, '\\$&')}%`;
  return db.prepare(`
    SELECT p.*, GROUP_CONCAT(ps.text, ' | ') as steps_summary
    FROM procedures p
    LEFT JOIN procedure_steps ps ON p.id = ps.procedure_id
    WHERE p.name LIKE ? OR p.description LIKE ? OR p.trigger_context LIKE ?
    GROUP BY p.id
    ORDER BY p.use_count DESC
    LIMIT ?
  `).all(q, q, q, Math.min(limit, 50));
}

initVectorIndex(db).catch(e => { LOG_DEBUG && console.error('[Schema] sqlite-vec init failed:', e.message); });

const insert = db.prepare(
	`INSERT INTO memories (session_id, type, text, embedding, metadata, importance, context_prefix, entity, attribute, valid_from, summary, cone_layer)
	 VALUES (@session_id, @type, @text, @embedding, @metadata, @importance, @context_prefix, @entity, @attribute, @valid_from, @summary, @cone_layer)`
);

const insertTx = db.transaction((items) => {
  const ids = [];
  for (const m of items) {
    const r = insert.run(m);
    ids.push(Number(r.lastInsertRowid));
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
const getActiveAllNoEmbed = db.prepare(`SELECT id, session_id, type, text, metadata, importance, context_prefix, entity, attribute, valid_from, valid_until, recall_count, created_at FROM memories WHERE status = 'active'`);

const countAll = db.prepare(`SELECT status, type, COUNT(*) as count FROM memories GROUP BY status, type`);
const countActive = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE status = 'active'`);
const countBySession = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE session_id = ? AND status = 'active'`);
const countByType = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE type = ? AND status = 'active'`);
const getSuperseded = db.prepare(`SELECT * FROM memories WHERE status = 'superseded'`);
const getByEntityAttr = db.prepare(`SELECT * FROM memories WHERE entity = ? AND attribute = ? AND status = 'active' ORDER BY created_at DESC`);
const getTopActiveScored = db.prepare(`SELECT id, session_id, type, text, importance, recall_count, created_at FROM memories WHERE status = 'active' ORDER BY importance DESC, recall_count DESC, created_at DESC LIMIT ?`);

const searchFts = db.prepare(`
SELECT m.id, m.session_id, m.type, m.text, m.status, m.metadata, m.created_at, m.importance, m.recall_count, m.summary, f.rank AS score
  FROM memories_fts f
  JOIN memories m ON m.id = f.rowid
  WHERE memories_fts MATCH @query AND m.status = 'active'
  ORDER BY rank
  LIMIT @limit
`);

const searchRecent = db.prepare(`
SELECT id, session_id, type, text, status, metadata, created_at, importance, recall_count, summary FROM memories
  WHERE status = 'active' AND text LIKE @query ESCAPE '\'
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
  `SELECT id, text, context_prefix FROM memories WHERE embedding IS NULL AND status = 'active' LIMIT ?`
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
    SELECT e.id, e.from_id, e.to_id, e.relation, e.strength, 1, '|' || e.from_id || '-' || e.relation || '->' || e.to_id || '|'
    FROM memory_edges e
    WHERE e.from_id = ? AND (e.valid_until IS NULL OR e.valid_until > datetime('now'))
    UNION ALL
    SELECT e.id, e.from_id, e.to_id, e.relation, gw.strength * e.strength, gw.depth + 1, gw.path || e.from_id || '-' || e.relation || '->' || e.to_id || '|'
    FROM memory_edges e
    JOIN graph_walk gw ON e.from_id = gw.to_id
    WHERE gw.depth < ? AND (e.valid_until IS NULL OR e.valid_until > datetime('now')) AND gw.path NOT LIKE '%|' || e.to_id || '|%'
  )
  SELECT * FROM graph_walk ORDER BY depth, strength DESC LIMIT ?
`);

// Recursive graph traversal: multi-hop from a starting memory (incoming edges)
const traverseGraphIncoming = db.prepare(`
WITH RECURSIVE graph_walk(id, from_id, to_id, relation, strength, depth, path) AS (
  SELECT e.id, e.from_id, e.to_id, e.relation, e.strength, 1, '|' || e.to_id || '-' || e.relation || '->' || e.from_id || '|'
  FROM memory_edges e
  WHERE e.to_id = ? AND (e.valid_until IS NULL OR e.valid_until > datetime('now'))
  UNION ALL
  SELECT e.id, e.from_id, e.to_id, e.relation, gw.strength * e.strength, gw.depth + 1, gw.path || e.to_id || '-' || e.relation || '->' || e.from_id || '|'
  FROM memory_edges e
  JOIN graph_walk gw ON e.to_id = gw.from_id
  WHERE gw.depth < ? AND (e.valid_until IS NULL OR e.valid_until > datetime('now')) AND gw.path NOT LIKE '%|' || e.from_id || '|%'
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
  if (buf.byteLength % 4 !== 0) throw new Error(`[bufferToFloat32] misaligned buffer: ${buf.byteLength} bytes is not a multiple of 4`);
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / Float32Array.BYTES_PER_ELEMENT)));
}

// Ensure embedding is a Node Buffer for SQLite BLOB binding
// Accepts Buffer, Float32Array, ArrayBuffer, or plain array
function ensureEmbeddingBuffer(embedding) {
  if (!embedding) return null;
  if (Buffer.isBuffer(embedding)) return embedding;
  if (embedding instanceof Float32Array) return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  if (embedding instanceof ArrayBuffer) return Buffer.from(embedding);
  if (Array.isArray(embedding)) {
    if (embedding.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
      console.warn('[ensureEmbeddingBuffer] Array contains non-finite values, filtering');
      embedding = embedding.map(v => (typeof v === 'number' && Number.isFinite(v)) ? v : 0);
    }
    return Buffer.from(new Float32Array(embedding).buffer);
  }
  return null;
}

export function storeMemory({ session_id, type, text, embedding = null, metadata = {}, importance = 0.5, context_prefix = '', entity = '', attribute = '', valid_from = null, summary = null, cone_layer = 0 }) {
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
 summary: summary || null,
 cone_layer,
 });
  // Update vector index if embedding provided
  if (embedding) {
    try {
      const vec = bufferToFloat32(embedding);
      insertVec(db, Number(result.lastInsertRowid), vec);
      const tb = getVectorBackend();
      if (tb === 'turbovec' || tb === 'hybrid') {
        addToTurboVec([Number(result.lastInsertRowid)], [vec]).catch(e => LOG_DEBUG && console.error('[StoreMemory] TurboVec add failed:', e.message));
      }
    } catch (e) { LOG_DEBUG && console.error('[StoreMemory] Vec insert failed:', e.message); }
  }
  return Number(result.lastInsertRowid);
}

export function storeMemories(items) {
  const now = new Date().toISOString();
  const prepared = items.map(m => ({
    session_id: m.session_id || '',
    type: m.type || 'general',
    text: m.text,
    embedding: ensureEmbeddingBuffer(m.embedding) || null,
    metadata: JSON.stringify(m.metadata || {}),
    importance: m.importance ?? 0.5,
    context_prefix: m.context_prefix || '',
    entity: m.entity || '',
    attribute: m.attribute || '',
    valid_from: m.valid_from || now,
    summary: m.summary || null,
    cone_layer: m.cone_layer ?? 0,
  }));
  const ids = insertTx(prepared);
  // Update vector index for batch
  if (isVecReady()) {
    for (let i = 0; i < ids.length; i++) {
      if (prepared[i].embedding) {
                    const vec = bufferToFloat32(prepared[i].embedding);
                    try { insertVec(db, ids[i], vec); } catch (e) { LOG_DEBUG && console.error('[StoreMemories] Vec insert failed for', ids[i], e.message); }
                    const tb = getVectorBackend();
                    if ((tb === 'turbovec' || tb === 'hybrid')) {
                        addToTurboVec([ids[i]], [vec]).catch(e => LOG_DEBUG && console.error('[StoreMemories] TurboVec add failed:', e.message));
                    }
      }
    }
  }
  return ids;
}

export function updateMemoryStatus(id, status, supersededBy = null) {
  updateStatus.run({ id, status, superseded_by: supersededBy });
}

export function updateMemoryType(id, type) {
  updateType.run({ id, type });
}

export function deleteMemory(id) {
	removeById.run(id);
	const tb = getVectorBackend();
	if (tb === 'turbovec' || tb === 'hybrid') removeFromTurboVec(id).catch(() => {});
	deleteVec(db, id);
}

export function deleteInvalid() {
	const invalidRows = db.prepare("SELECT id FROM memories WHERE status = 'invalid'").all();
	for (const row of invalidRows) {
		removeById.run(row.id);
		const tb = getVectorBackend();
		if (tb === 'turbovec' || tb === 'hybrid') removeFromTurboVec(row.id).catch(() => {});
		deleteVec(db, row.id);
	}
	return invalidRows.length;
}

export function searchMemories({ query, limit = 10 }) {
  if (!query || !query.trim()) return [];
  const limitNum = Math.min(Math.max(1, limit), 50);
  try {
    // Strip FTS5 special syntax: column: prefix, operators (AND, OR, NOT, NEAR), quotes
    let sanitized = query
      .replace(/(?:\w+:)/g, '')           // strip column: prefixes
      .replace(/\b(?:AND|OR|NOT|NEAR)\b/gi, '') // strip FTS5 operators
      .replace(/['"*^$]/g, '')            // strip quotes and FTS5 modifiers
      .replace(/[^\w\s]/g, ' ')           // strip remaining non-word chars
      .replace(/\s+/g, ' ')               // collapse whitespace
      .trim();
    if (!sanitized) return searchRecent.all({ query: `%${query.replace(/[%_]/g, '\\$&')}%`, limit: limitNum });
    return searchFts.all({ query: sanitized, limit: limitNum });
  } catch (e) {
    LOG_DEBUG && console.error('[SearchMemories] FTS error, falling back to LIKE:', e.message);
    return searchRecent.all({ query: `%${query.replace(/[%_]/g, '\\$&')}%`, limit: limitNum });
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


export function getAllActiveMemoriesNoEmbed() {
  return getActiveAllNoEmbed.all();
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

export function getSessionMemoryCount(sessionId) {
  return countBySession.get(sessionId).count;
}

export function getTypeMemoryCount(type) {
  return countByType.get(type).count;
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
  const tb = getVectorBackend();
  if (tb === 'turbovec' || tb === 'hybrid') {
    const turboIds = [];
    const turboVecs = [];
    for (let i = 0; i < ids.length; i++) {
      if (!embeddings[i]) continue;
      let vec;
      if (Buffer.isBuffer(embeddings[i])) {
        vec = bufferToFloat32(embeddings[i]);
      } else if (embeddings[i] instanceof Float32Array) {
        vec = Array.from(embeddings[i]);
      } else if (Array.isArray(embeddings[i])) {
        vec = embeddings[i];
      } else {
        continue;
      }
      turboIds.push(ids[i]);
      turboVecs.push(vec);
    }
    if (turboIds.length > 0) {
      addToTurboVec(turboIds, turboVecs).catch(e => LOG_DEBUG && console.error('[addVecsToIndex] TurboVec batch add failed:', e.message));
    }
  }
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

export async function vectorKnnSearchAsync(queryEmbedding, topK = 5) {
    if (!isVecReady()) return null;
    const backend = getVectorBackend();
    const hits = (backend === 'turbovec' || backend === 'hybrid')
        ? await knnSearchHybrid(db, queryEmbedding, topK)
        : knnSearch(db, queryEmbedding, topK);
    if (!hits) return null;
    return hits.map(h => {
        const mem = getById.get(h.id);
        if (!mem || mem.status !== 'active') return null;
        return {
            id: mem.id, text: mem.text, type: mem.type,
            session_id: mem.session_id, importance: mem.importance,
            recall_count: mem.recall_count, created_at: mem.created_at,
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
  return Number(insertEdge.run({ from_id, to_id, relation, valid_from: valid_from || new Date().toISOString(), valid_until, strength, source_session_id, metadata: JSON.stringify(metadata) }).lastInsertRowid);
}

export function getEdgesFromMemory(memoryId) { return getEdgesFrom.all(memoryId); }
export function getEdgesToMemory(memoryId) { return getEdgesTo.all(memoryId); }
export function getEdgesByRel(relation, limit = 50) { return getEdgesByRelation.all(relation, Math.min(limit, 200)); }
export function invalidateEdgeById(edgeId) { return invalidateEdge.run(edgeId).changes; }
export function getEdge(edgeId) { return getEdgeById.get(edgeId); }
export function traverseMemoryGraph(fromId, maxDepth = 3, limit = 20, direction = 'both', relation = '') {
  let rows;
  if (direction === 'incoming') {
    rows = traverseGraphIncoming.all(fromId, maxDepth, limit);
  } else if (direction === 'outgoing') {
    rows = traverseGraph.all(fromId, maxDepth, limit);
  } else {
    // both: combine outgoing and incoming, dedup by edge id
    const outRows = traverseGraph.all(fromId, maxDepth, limit);
    const inRows = traverseGraphIncoming.all(fromId, maxDepth, limit);
    const seen = new Set();
    rows = [];
    for (const r of [...outRows, ...inRows]) {
      if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    }
    rows.sort((a, b) => a.depth - b.depth || b.strength - a.strength);
    rows = rows.slice(0, limit);
  }
  if (relation) {
    rows = rows.filter(r => r.relation === relation);
  }
  return rows;
}

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
  try { insertCitation.run(memoryId, sessionId || '', context.substring(0, 200)); } catch (e) { LOG_DEBUG && console.error('[LogCitation] Failed:', e.message); }
}
export function getRecentCitationCount(memoryId) {
  return getCitationsByMemory.get(memoryId)?.count || 0;
}
export function getSessionCitations(sessionId, limit = 20) {
  return getCitationsBySession.all(sessionId || '', Math.min(limit, 100));
}



// ── Cone graph accessor functions ──────────────────────────────────
const getEntityByName = db.prepare("SELECT * FROM entities WHERE canonical_name = ?");
const insertEntity = db.prepare(
	"INSERT OR IGNORE INTO entities (canonical_name, entity_type, normalized_name, mention_count) VALUES (@canonical_name, @entity_type, @normalized_name, @mention_count)"
);
const getEntityById = db.prepare("SELECT * FROM entities WHERE id = ?");
const getAllEntities = db.prepare("SELECT * FROM entities ORDER BY mention_count DESC LIMIT ?");
const incrementEntityMention = db.prepare(
	"UPDATE entities SET mention_count = mention_count + 1, updated_at = datetime('now') WHERE canonical_name = ?"
);

const insertFacetStmt = db.prepare(
	"INSERT INTO facets (entity_id, attribute, abstraction_level, text, embedding) VALUES (@entity_id, @attribute, @abstraction_level, @text, @embedding)"
);
const getFacetsByEntity = db.prepare("SELECT * FROM facets WHERE entity_id = ? ORDER BY abstraction_level");
const getFacetById = db.prepare("SELECT * FROM facets WHERE id = ?");

const insertFacetPoint = db.prepare(
	"INSERT INTO facet_points (facet_id, text, embedding, point_type) VALUES (@facet_id, @text, @embedding, @point_type)"
);
const getFacetPointsByFacet = db.prepare("SELECT * FROM facet_points WHERE facet_id = ?");

const linkMemoryEntity = db.prepare(
	"INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)"
);
const getMemoriesByEntity = db.prepare(
	"SELECT m.* FROM memories m JOIN memory_entities me ON m.id = me.memory_id WHERE me.entity_id = ? AND m.status = 'active' ORDER BY m.importance DESC LIMIT ?"
);
const getEntitiesByMemory = db.prepare(
	"SELECT e.* FROM entities e JOIN memory_entities me ON e.id = me.entity_id WHERE me.memory_id = ?"
);

export function upsertEntity({ canonical_name, entity_type = 'generic', mention_count = 1 }) {
	insertEntity.run({ canonical_name, entity_type, normalized_name: canonical_name.toLowerCase(), mention_count });
	return getEntityByName.get(canonical_name);
}

export function getEntity(nameOrId) {
	if (typeof nameOrId === 'string') return getEntityByName.get(nameOrId);
	return getEntityById.get(nameOrId);
}

export function listEntities(limit = 100) { return getAllEntities.all(limit); }

export function touchEntity(canonicalName) { return incrementEntityMention.run(canonicalName).changes; }

export function addFacet({ entity_id, attribute, abstraction_level = 1, text = '', embedding = null }) {
	return insertFacetStmt.run({ entity_id, attribute, abstraction_level, text, embedding: embedding ? ensureEmbeddingBuffer(embedding) : null });
}

export function getFacets(entityId) { return getFacetsByEntity.all(entityId); }

export function addFacetPoint({ facet_id, text = '', embedding = null, point_type = 'detail' }) {
	return insertFacetPoint.run({ facet_id, text, embedding: embedding ? ensureEmbeddingBuffer(embedding) : null, point_type });
}

export function getFacetPoints(facetId) { return getFacetPointsByFacet.all(facetId); }

export function linkMemoryToEntity(memoryId, entityId, role = 'subject') {
	return linkMemoryEntity.run(memoryId, entityId, role);
}

export function getMemoriesForEntity(entityId, limit = 20) { return getMemoriesByEntity.all(entityId, limit); }

export function getEntitiesForMemory(memoryId) { return getEntitiesByMemory.all(memoryId); }

export { db };

export function close() {
  db.close();
}
