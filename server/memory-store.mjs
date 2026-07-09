import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initVectorIndex, insertVec, insertVecBatch, isVecReady, knnSearch, knnSearchHybrid, deleteVec, getVectorBackend, addToTurboVec, removeFromTurboVec, pruneVectors, getActiveVectorIds } from './vector-index.mjs';

// E13: current embedding model id, registered once at boot by memory-server after
// initEmbeddingEngine resolves (so this module never imports transformers.js / embedding-engine).
// storeMemory + updateMemoryEmbedding stamp it onto rows when they write an embedding; the
// KNN search path compares it against each hit's stored model id and drops cross-model rows
// (cosine across different embedding spaces is meaningless — silent recall corruption).
let _currentEmbeddingModelId = null;
export function setEmbeddingModelId(id) { _currentEmbeddingModelId = id || null; }
export function getCurrentEmbeddingModelId() { return _currentEmbeddingModelId; }
// E13: embedding-drift helper for the searchByEmbedding/bundle-search live paths. Cosine across
// DIFFERENT embedding spaces is meaningless — cross-model rows must be filtered out before they
// reach similarity ranking. NULL model id (pre-E13 legacy rows) is treated compatible.
export function isForeignEmbeddingModel(mem) {
  return !!(mem && mem.embedding_model_id && _currentEmbeddingModelId && mem.embedding_model_id !== _currentEmbeddingModelId);
}

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Resolve DB path relative to project root (not CWD) — prevents "db not found" when launched from different CWD
const DB_DIR = process.env.MEMORY_DB_DIR || path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(DB_DIR, 'hermes-memory.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
// BUG-4 fix: Set page_size unconditionally — SQLite ignores it if tables already exist, safe to always set
db.pragma('page_size = 32768'); // Optimal for BLOB/vector I/O — must set before first table
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

export const DB_VERSION = 9;

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
	},
	6: () => {
		// E13: embedding-drift defense. Record the embedding model id used for each row so a
		// search can detect rows embedded under a DIFFERENT model (e.g. 384->768 swap, or a model
		// swap) whose cosine distances are NOT comparable to the query vector — returning them as
		// if valid would silently corrupt recall. Existing rows backfill to NULL == "unknown /
		// pre-E13" (treated as compatible with the current model so this migration is non-breaking;
		// only rows embedded AFTER this change carry an explicit model id).
		addColumn('memories', 'embedding_model_id', 'TEXT');
	},
	7: () => {
		// E7: archive index + reactivation-on-reference. archiveStaleMemories() flips L1/L2 rows to
		// 'archived' (lost from retrieval). Without an index, a later reference re-inserts a silent
		// duplicate. The archive index keeps a small hot-set pointer so the query path can scan
		// archived rows cheaply and reactivate an exact match instead of duplicating it. Only L1/L2
		// are ever archived (E6 cardinal guard), so this table is L1/L2-only by construction.
		db.exec(`CREATE TABLE IF NOT EXISTS memory_archive_index (
  archived_id INTEGER PRIMARY KEY,
  archived_at TEXT NOT NULL,
  cone_layer INTEGER NOT NULL,
  entity TEXT,
  attribute TEXT,
  FOREIGN KEY (archived_id) REFERENCES memories(id) ON DELETE CASCADE
)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_archive_cone_layer ON memory_archive_index(cone_layer, archived_at DESC)`);
	},
	// v8 (E2): semantic-intent merge. classifyIntent() tags each stored memory's speech-act intent
	// (greeting/acknowledgment/.../state_change) into intent_type so the maintenance cron can cluster
	// trivial function-word rows (greetings share ~zero lexical tokens → cosine 0.20-0.45, below both
	// the 0.92 dedup and 0.75 consolidate bars → never merge → unbounded useless growth). NULL = untagged
	// → consolidated by the existing entity+cosine path only. Non-breaking: additive column.
	8: () => {
		addColumn('memories', 'intent_type', 'TEXT');
		db.exec(`CREATE INDEX IF NOT EXISTS idx_intent_cluster ON memories(intent_type, entity, status)`);
	},
	// v9: E10 keyset (seek) pagination — covering composite indexes so the seek predicate
	// (session_id/type, status='active', created_at DESC, id DESC) resolves WITHOUT the COUNT(*)
	// total + the OFFSET/LIMIT slice that the S-#54 regression flagged. Additive (IF NOT EXISTS),
	// zero data migration — the queries are unchanged, only the seek gets a real index path.
	9: () => {
		db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_session_active_time ON memories(session_id, status, created_at DESC, id DESC)`);
		db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_type_active_time ON memories(type, status, created_at DESC, id DESC)`);
	},
};// E16: pending-migration runner. HARD-STOP on first failure — a partial-schema DB must NEVER
// silently serve requests. Previously the loop logged + `break`ed, leaving the server running on
// a half-migrated schema (silent corruption risk): a v9 that throws would still serve reads on
// a schema missing v9's column. Now any failure re-throws so the module top-level rejects and the
// Node process exits non-zero BEFORE the HTTP server boots. The regression test drives this REAL
// hard-stop logic through makeMigrationRunner against a throwaway DB + poisoned migration map —
// no production schema is mutated.
export function makeMigrationRunner(dbArg, migrationsArg, dbVersionArg, opts = {}) {
	const quiet = !!opts.silent;
	return function runMigrations() {
		const currentVersion = dbArg.pragma('user_version', { simple: true });
		for (let v = currentVersion + 1; v <= dbVersionArg; v++) {
			const migrate = dbArg.transaction(() => {
				if (!migrationsArg[v]) throw new Error(`Unknown migration version: ${v}`);
				migrationsArg[v]();
				dbArg.pragma(`user_version = ${v}`);
			});
			try {
				migrate();
				if (!quiet) console.log(`[Schema] Migration v${v} applied (user_version=${v})`);
			} catch (err) {
				if (!quiet) {
					console.error(`[Schema] Migration v${v} FAILED (hard-stop): ${err.message}`);
					console.error('[Schema] Aborting startup — refusing to serve on a partial schema.');
				}
				throw err;
			}
		}
	};
}

export function runPendingMigrations() {
	return makeMigrationRunner(db, migrations, DB_VERSION)();
}

runPendingMigrations();



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

// BUG-5 fix: Rebuild FTS after migrations to ensure content table consistency
try { db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')"); } catch (e) { /* FTS table may not exist yet */ }

initVectorIndex(db).catch(e => { LOG_DEBUG && console.error('[Schema] sqlite-vec init failed:', e.message); });

const insert = db.prepare(
	`INSERT INTO memories (session_id, type, text, embedding, metadata, importance, context_prefix, entity, attribute, valid_from, summary, cone_layer, embedding_model_id, intent_type)
	 VALUES (@session_id, @type, @text, @embedding, @metadata, @importance, @context_prefix, @entity, @attribute, @valid_from, @summary, @cone_layer, @embedding_model_id, @intent_type)`
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
const removeByStatus = db.prepare(`DELETE FROM memories WHERE status = 'invalid' AND cone_layer IN (1,2)`); // E6 cardinal guard — never bulk-delete L0/L3
// archiveStale bulk UPDATE removed — archiveStaleMemories() now does per-row archive + pruneVectors (E1).

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
const getActiveAllNoEmbed = db.prepare(`SELECT id, session_id, type, text, metadata, importance, context_prefix, entity, attribute, valid_from, valid_until, recall_count, cone_layer, intent_type, created_at FROM memories WHERE status = 'active'`);

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
  `SELECT id, session_id, type, text, embedding, metadata, context_prefix, entity, attribute, valid_until, cone_layer, intent_type, embedding_model_id, created_at, importance, recall_count, status FROM memories WHERE status = 'active' AND embedding IS NOT NULL`
);

const getAllWithEmbeddings = db.prepare(
  `SELECT id, type, text, embedding, status, created_at FROM memories WHERE embedding IS NOT NULL`
);

const getWithoutEmbedding = db.prepare(
  `SELECT id, text, context_prefix FROM memories WHERE embedding IS NULL AND status = 'active' LIMIT ?`
);

// E13: re-embed stamps the CURRENT model id so a freshly (re-)embedded row is tagged for the
// drift filter. Rows embedded before E13 carry NULL model id (treated as compatible).
const updateEmbedding = db.prepare(
  `UPDATE memories SET embedding = ?, embedding_model_id = ? WHERE id = ?`
);
// Graph edge prepared statements
const insertEdge = db.prepare('INSERT INTO memory_edges (from_id, to_id, relation, valid_from, valid_until, strength, source_session_id, metadata) VALUES (@from_id, @to_id, @relation, @valid_from, @valid_until, @strength, @source_session_id, @metadata)');
const getEdgesFrom = db.prepare('SELECT * FROM memory_edges WHERE from_id = ? AND (valid_until IS NULL OR valid_until > datetime(\'now\')) ORDER BY strength DESC');
const getEdgesTo = db.prepare('SELECT * FROM memory_edges WHERE to_id = ? AND (valid_until IS NULL OR valid_until > datetime(\'now\')) ORDER BY strength DESC');
const getEdgesByRelation = db.prepare('SELECT * FROM memory_edges WHERE relation = ? AND (valid_until IS NULL OR valid_until > datetime(\'now\')) ORDER BY created_at DESC LIMIT ?');
const invalidateEdge = db.prepare('UPDATE memory_edges SET valid_until = datetime(\'now\') WHERE id = ? AND valid_until IS NULL');
const getEdgeById = db.prepare('SELECT * FROM memory_edges WHERE id = ?');
// E9: when a memory leaves active circulation, cascade-invalidate ALL of its touching edges in the
// same transaction-flip so the graph's bi-temporal end-validity stays consistent with the memory's.
// (pre-E9 the edges stayed valid_until IS NULL → a later asOf traversal wrongly re-surfaced them.)
const cascadeInvalidateEdges = db.prepare('UPDATE memory_edges SET valid_until = datetime(\'now\') WHERE (from_id = ? OR to_id = ?) AND valid_until IS NULL');
// E9: bi-temporal asOf variants — mirror the now-path edge queries but parameterize the cutoff as
// datetime(?) (SQLite normalizes the bound ISO8601 → the same "YYYY-MM-DD HH:MM:SS" space-format that
// valid_until is stored in, so the string comparison stays correct across callers). Deliberately
// mirrors the now-path's valid_until-ONLY filter (no valid_from predicate): adding valid_from would
// hit a latent format mismatch — valid_from is stored JS-ISO ("...T..Z") vs valid_until SQLite-space
// ("YYYY-MM-DD HH:MM:SS") — which is out of E9's narrow scope and is NOT introduced here.
const getEdgesByRelationAsOf = db.prepare('SELECT * FROM memory_edges WHERE relation = ? AND (valid_until IS NULL OR valid_until > datetime(?)) ORDER BY created_at DESC LIMIT ?');
const traverseGraphAsOf = db.prepare(`
  WITH RECURSIVE graph_walk(id, from_id, to_id, relation, strength, depth, path) AS (
    SELECT e.id, e.from_id, e.to_id, e.relation, e.strength, 1, '|' || e.from_id || '-' || e.relation || '->' || e.to_id || '|'
    FROM memory_edges e
    WHERE e.from_id = ? AND (e.valid_until IS NULL OR e.valid_until > datetime(?))
    UNION ALL
    SELECT e.id, e.from_id, e.to_id, e.relation, gw.strength * e.strength, gw.depth + 1, gw.path || e.from_id || '-' || e.relation || '->' || e.to_id || '|'
    FROM memory_edges e
    JOIN graph_walk gw ON e.from_id = gw.to_id
    WHERE gw.depth < ? AND (e.valid_until IS NULL OR e.valid_until > datetime(?)) AND gw.path NOT LIKE '%|' || e.to_id || '|%'
  )
  SELECT * FROM graph_walk ORDER BY depth, strength DESC LIMIT ?
`);
const traverseGraphIncomingAsOf = db.prepare(`
  WITH RECURSIVE graph_walk(id, from_id, to_id, relation, strength, depth, path) AS (
    SELECT e.id, e.from_id, e.to_id, e.relation, e.strength, 1, '|' || e.to_id || '-' || e.relation || '->' || e.from_id || '|'
    FROM memory_edges e
    WHERE e.to_id = ? AND (e.valid_until IS NULL OR e.valid_until > datetime(?))
    UNION ALL
    SELECT e.id, e.from_id, e.to_id, e.relation, gw.strength * e.strength, gw.depth + 1, gw.path || e.to_id || '-' || e.relation || '->' || e.from_id || '|'
    FROM memory_edges e
    JOIN graph_walk gw ON e.to_id = gw.from_id
    WHERE gw.depth < ? AND (e.valid_until IS NULL OR e.valid_until > datetime(?)) AND gw.path NOT LIKE '%|' || e.from_id || '|%'
  )
  SELECT * FROM graph_walk ORDER BY depth, strength DESC LIMIT ?
`);

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
  // BUG-11 fix: copy data to avoid shared ArrayBuffer mutation
	if (embedding instanceof Float32Array) { const copy = new Float32Array(embedding); return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength); }
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

export function storeMemory({ session_id, type, text, embedding = null, metadata = {}, importance = 0.5, context_prefix = '', entity = '', attribute = '', valid_from = null, summary = null, cone_layer = 0, intent_type = null }) {
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
    valid_from: valid_from ?? new Date().toISOString(),
 summary: summary ?? null,
 cone_layer,
 intent_type: intent_type ?? null,
 // E13: stamp the embedding model id only when an embedding is written, so the KNN drift
 // filter can later drop rows embedded under a different model. NULL when no embedding.
 embedding_model_id: embedding ? _currentEmbeddingModelId : null,
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
    valid_from: m.valid_from ?? now,
    summary: m.summary ?? null,
    cone_layer: m.cone_layer ?? 0,
    intent_type: m.intent_type ?? null,
    embedding_model_id: m.embedding ? _currentEmbeddingModelId : null, // E13 drift stamp
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
  // E1: prune the dead memory's vector from BOTH backends in the SAME transaction as the
  // status flip so superseded/archived/invalid vectors never linger in the KNN index
  // (stale-vector bleed root cause). 'active' (reactivation) does NOT prune — E7 re-inserts.
  if (status === 'active') { updateStatus.run({ id, status, superseded_by: supersededBy }); return; }
  const tx = db.transaction(() => {
    updateStatus.run({ id, status, superseded_by: supersededBy });
    // E9: bi-temporal edge cascade — when a memory leaves active circulation (superseded/archived/
    // invalid) its touching edges stop being current AT THE SAME MOMENT, so a later asOf traversal
    // can't re-surface edges anchored to a defunct memory. Same tx as the status flip + vector prune
    // so the graph, the KNN index, and the memory row move atomically.
    cascadeInvalidateEdges.run(id, id);
    pruneVectors(db, id);
  });
  tx();
}

// E2 A-MEM evolve helper. Master report §3 scenario A step 5: non-contradicting fresh context is
// APPENDED to an existing anchor IN PLACE (UPDATE, no supersede of the anchor) — the folded-away
// non-anchors are superseded-as-audit by the caller. Mutates the anchor's metadata only:
//   metadata.evolved_context  = array of folded texts (the appended context)
//   metadata.evolved_from_ids = audit lineage of folded row ids
//   metadata.canonical        = optional J3-synthed canonical sentence (content clusters only)
//   metadata.synthesized      = true when canonical was set
//   importance                = anchor.importance + importanceBump (capped [0,1]; trivial=0 bump)
// Pure metadata UPDATE — never re-embeds/re-indexes, so the anchor keeps its indexed embedding +
// original text (A-MEM "append in place", not replace — zero retrieval churn, zero silent loss).
export function appendEvolvedContext(anchorId, extras, { canonical = null, importanceBump = 0 } = {}) {
  if (!anchorId) return false;
  const row = getById.get(anchorId);
  if (!row) return false;
  let meta = {};
  try { meta = row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : {}; } catch { meta = {}; }
  const arr = Array.isArray(extras) ? extras : [];
  const texts = arr.map(e => (typeof e === 'string' ? e : e?.text)).filter(t => t);
  const ids = arr.map(e => (typeof e === 'string' ? null : (e?.id != null ? String(e.id) : ''))).filter(Boolean);
  if (texts.length === 0) return false;
  meta.evolved_context = Array.isArray(meta.evolved_context) ? [...meta.evolved_context, ...texts] : texts;
  meta.evolved_from_ids = Array.isArray(meta.evolved_from_ids) ? [...meta.evolved_from_ids, ...ids] : ids;
  if (canonical && typeof canonical === 'string') { meta.canonical = canonical; meta.synthesized = true; }
  meta.updated_at = new Date().toISOString();
  const imp = Math.min(1.0, Math.max(0, Number(row.importance || 0) + Number(importanceBump || 0)));
  db.prepare('UPDATE memories SET metadata = ?, importance = ? WHERE id = ?').run(JSON.stringify(meta), imp, anchorId);
  return true;
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
	// E6 cardinal guard: NEVER physically delete L0 (raw episode audit/oracle) or L3 (persona).
	// Only L1 (facet) / L2 (scene) are hard-cap-eligible. This auto-maintenance path is the
	// strongest cardinal-risk vector — without this guard an L0/L3 that updateMemoryStatus()
	// flipped to 'invalid' (via dedup/contradiction/supersede) would be physically deleted,
	// violating the master report §6 cardinal rule. Filtering at the SQL source keeps the
	// vec-cleanup loop below operating only on rows we actually delete (L1/L2).
	const invalidRows = db.prepare("SELECT id FROM memories WHERE status = 'invalid' AND cone_layer IN (1,2)").all();
	const ids = invalidRows.map(r => r.id);
	// BUG-2 fix: wrap DELETE loop in transaction for atomicity
	db.transaction(() => { for (const id of ids) removeById.run(id); })();
	// Vector index cleanup post-commit (non-transactional by nature)
	for (const id of ids) {
		const tb = getVectorBackend();
		if (tb === 'turbovec' || tb === 'hybrid') removeFromTurboVec(id).catch(() => {});
		deleteVec(db, id);
	}
	return ids.length;
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
      .replace(/[^\p{L}\p{N}\s]/gu, ' ') // BUG-15 fix: Unicode-aware — preserves CJK and accented
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

const _getMemByIdsCache = new Map();
export function getMemoriesByIds(ids) {
  if (!ids || ids.length === 0) return [];
  let stmt = _getMemByIdsCache.get(ids.length);
  if (!stmt) {
    const placeholders = ids.map(() => '?').join(',');
    stmt = db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`);
    _getMemByIdsCache.set(ids.length, stmt);
  }
  return stmt.all(...ids);
}

export function getActiveMemories(limit = 50) {
  return getActive.all(Math.min(limit, 500));
}

export function getAllActiveMemories() {
  return getActiveAll.all().map(m => ({ ...m, embedding: bufferToFloat32(m.embedding) }));
}

// E15: cheap per-id embedding lookup sized to the KNN hit set (≈ topK), so the native-KNN search path
// can drive REAL MMR diversity (candidate-candidate cosine) WITHOUT loading ALL active embeddings on
// every /memory/search (the E5/E10/E14 perf goals fight exactly that full-load). Returns a Map keyed
// by String(id) → decoded JS-array (same shape getAllActiveMemories yields) so cosineSimilarity
// consumes it unaltered. getById must SELECT * (including the embedding BLOB).
export function getEmbeddingsById(ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  for (const id of ids) {
    const m = getById.get(id);
    if (m && m.embedding) out.set(String(m.id), bufferToFloat32(m.embedding));
  }
  return out;
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
  return countBySession.get(sessionId)?.count ?? 0;
}

export function getTypeMemoryCount(type) {
  return countByType.get(type)?.count ?? 0;
}

// ─── E10 keyset (seek) pagination ─────────────────────────────────────────────
// Replaces the per-page OFFSET/LIMIT slice + the COUNT(*) total (the S-#54 regression: every page
// request paid a COUNT(*) over status='active' AND a fetch of limit+offset rows just to discard
// the first `offset` of them). Ordered (created_at DESC, id DESC) with a composite tiebreak so
// rows sharing a created_at timestamp are never skipped across pages. Fetches limit+1 to derive a
// `hasMore` flag; `nextCursor` is base64url(`created_at|id`) of the last row, passed back as the
// `cursor` query param for the next page. `total` is intentionally NULL — never computed. Backward
// compatible shape: a client reading `.total` gets null (graceful) and may switch to `hasMore`.
const KEYSET_LIMIT_CAP = 500;
const getSessionPageFirst = db.prepare(`SELECT * FROM memories WHERE session_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT ?`);
const getSessionPageSeek = db.prepare(`SELECT * FROM memories WHERE session_id = ? AND status = 'active' AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`);
const getTypePageFirst = db.prepare(`SELECT * FROM memories WHERE type = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT ?`);
const getTypePageSeek = db.prepare(`SELECT * FROM memories WHERE type = ? AND status = 'active' AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`);

const encodeCursor = (createdAt, id) => Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
const decodeCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = parts[0];
    const id = parseInt(parts[1], 10);
    if (!createdAt || Number.isNaN(id)) return null;
    return { createdAt, id };
  } catch { return null; }
};

function _keysetPage(firstStmt, seekStmt, keyArg, cursor, limit) {
  const lim = Math.min(Math.max(parseInt(limit) || 50, 1), KEYSET_LIMIT_CAP);
  const fetch = lim + 1;
  const rows = cursor
    ? seekStmt.all(keyArg, cursor.createdAt, cursor.createdAt, cursor.id, fetch)
    : firstStmt.all(keyArg, fetch);
  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.created_at, last.id) : null;
  return { results: page, hasMore, nextCursor, total: null };
}

export function getSessionMemoriesPage(sessionId, { cursor, limit } = {}) {
  return _keysetPage(getSessionPageFirst, getSessionPageSeek, sessionId, decodeCursor(cursor), limit);
}

export function getMemoriesByTypePage(type, { cursor, limit } = {}) {
  return _keysetPage(getTypePageFirst, getTypePageSeek, type, decodeCursor(cursor), limit);
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
  // E1: archive must prune vectors same-tx too (the old bulk archiveStale UPDATE left archived
  // memories' vectors in memory_vecs → KNN returned dead rows). Per-row so we can pruneVec.
  const tx = db.transaction(() => {
    // E6: tier-aware archive — only L1/L2 are demotable to 'archived'. cone_layer: 0=L0 raw
    // episode (oracle/audit), 1=L1 facet, 2=L2 scene, 3=L3 persona. Archiving removes a row
    // from retrieval (E7) so archiving L0/L3 there would lose oracle/persona rows — cardinal
    // violation. Gate to cone_layer IN (1,2): L0 + L3 survive archive forever.
    const rows = db.prepare(`SELECT id, cone_layer, entity, attribute FROM memories WHERE status = 'active' AND recall_count = 0 AND created_at < datetime('now', '-90 days') AND cone_layer IN (1,2)`).all();
    if (rows.length === 0) return 0;
    const archiveOne = db.prepare("UPDATE memories SET status = 'archived', updated_at = datetime('now') WHERE id = ?");
    const insArchive = db.prepare("INSERT OR IGNORE INTO memory_archive_index (archived_id, archived_at, cone_layer, entity, attribute) VALUES (?, datetime('now'), ?, ?, ?)");
    for (const r of rows) {
      archiveOne.run(r.id);
      pruneVectors(db, r.id);
      // E7: index the archived row so the query path can reactivate an exact reference later
      // instead of letting a re-store create a silent duplicate. L1/L2-only by the SELECT gate.
      insArchive.run(r.id, r.cone_layer ?? 0, r.entity ?? null, r.attribute ?? null);
    }
    return rows.length;
  });
  try { return tx(); } catch (e) { LOG_DEBUG && console.error('[Store] archiveStaleMemories error:', e.message); return 0; }
}

// === E5: bounded active set ===
// When the active-memory count exceeds ACTIVE_SET_MAX, demote the surplus of LOWEST-value L1/L2
// facets to 'archived' (mirroring archiveStaleMemories: status flip + vector prune + archive_index
// insert, so reactivation-on-reference / E7 can revive them on a later reference). Teir-aware — ONLY
// cone_layer IN (1,2) facets are demotable: L0 raw episodes (oracle/audit) and L3 persona are
// CARDINAL and survive the bound forever (E6). Value rank: importance ASC, then recall_count ASC,
// then created_at ASC (oldest first) — the least-recalled, lowest-importance, oldest facets leave
// the hot retrieval set first. Gate: ENABLE_ACTIVE_SET_BOUND (default on).
export function enforceActiveSetBound({ maxActive = null } = {}) {
  const cap = parseInt(maxActive != null ? maxActive : (process.env.ACTIVE_SET_MAX ?? '40000'), 10);
  if (!cap || cap <= 0) return { gated: false, activeCount: -1, demoted: 0, reason: 'ACTIVE_SET_MAX disabled' };
  const activeCount = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'").get().n;
  if (activeCount <= cap) return { gated: false, activeCount, demoted: 0 };
  // Only L1/L2 are demotable. If the entire surplus is cardinal L0/L3 we report honestly rather than
  // violate the E6 guard — the bound is a soft target that never overrides cardinality.
  const surplus = activeCount - cap;
  const rows = db.prepare(
    `SELECT id, cone_layer, entity, attribute FROM memories
     WHERE status = 'active' AND cone_layer IN (1,2)
     ORDER BY importance ASC, recall_count ASC, created_at ASC
     LIMIT ?`
  ).all(surplus);
  if (!rows.length) {
    return { gated: true, activeCount, demoted: 0, surplus, reason: 'no demotable L1/L2 — surplus is cardinal L0/L3 (E6 guard)' };
  }
  const archiveOne = db.prepare("UPDATE memories SET status = 'archived', updated_at = datetime('now') WHERE id = ?");
  const insArchive = db.prepare("INSERT OR IGNORE INTO memory_archive_index (archived_id, archived_at, cone_layer, entity, attribute) VALUES (?, datetime('now'), ?, ?, ?)");
  const tx = db.transaction(() => {
    let demoted = 0;
    for (const r of rows) {
      archiveOne.run(r.id);
      pruneVectors(db, r.id);
      insArchive.run(r.id, r.cone_layer ?? 0, r.entity ?? null, r.attribute ?? null);
      demoted++;
    }
    return demoted;
  });
  try {
    const demoted = tx();
    const remaining = activeCount - demoted;
    LOG_DEBUG && console.log(`[Store] E5 bounded active set: ${activeCount} active > cap ${cap}; demoted ${demoted} L1/L2 facets (surplus ${surplus}, remaining ${remaining})`);
    return { gated: true, activeCount, demoted, surplus, remaining, capped: remaining <= cap };
  } catch (e) {
    LOG_DEBUG && console.error('[Store] enforceActiveSetBound error:', e.message);
    return { gated: true, activeCount, demoted: 0, error: e.message };
  }
}

// === E7: reactivation-on-reference (archive index hot-set) ===
// Scan the bounded archive hot set for L1/L2 rows whose stored embedding survives archive
// (pruneVectors only drops the vec0 row, not the memories.embedding BLOB). Returns rows with
// embedding as Float32 so reactivation-engine can rank them via searchByEmbedding without re-reading.
const archiveIndexScanStmt = db.prepare(
  `SELECT m.id, m.text, m.entity, m.attribute, m.importance, m.embedding, m.embedding_model_id, m.status, m.created_at, ai.cone_layer, ai.archived_at
   FROM memory_archive_index ai JOIN memories m ON m.id = ai.archived_id
   WHERE ai.cone_layer IN (1,2) ORDER BY ai.archived_at DESC LIMIT 500`
);
export function getArchivedCandidates(_coneLayers, _limit = 500) {
  return archiveIndexScanStmt.all().map(m => ({ ...m, embedding: bufferToFloat32(m.embedding) }));
}

// E7: flip an archived row back to active on query-reference. Recovers it from the archive so a
// later store doesn't re-insert a silent duplicate. recall_count++, importance +0.1, last_recalled_at
// refresh, vector re-inserted into memory_vecs (+ TurboVec) from the stored BLOB, archive_index entry
// removed. L1/L2 only by archive_index construction (E6 cardinal: L0/L3 never archived → never here).
const reactivateOneStmt = db.prepare(
  `UPDATE memories SET status = 'active', recall_count = recall_count + 1, last_recalled_at = datetime('now'),
   importance = MIN(1.0, importance + 0.1), updated_at = datetime('now') WHERE id = ? AND status = 'archived'`
);
const deleteArchiveIndexStmt = db.prepare(`DELETE FROM memory_archive_index WHERE archived_id = ?`);
export function reactivateMemory(id) {
  const row = getById.get(id);
  if (!row || row.status !== 'archived') return null;
  try {
    db.transaction(() => {
      const r = reactivateOneStmt.run(id);
      if (r.changes > 0) deleteArchiveIndexStmt.run(id);
    })();
  } catch (e) { LOG_DEBUG && console.error('[E7] reactivate tx error:', e.message); return null; }
  const after = getById.get(id);
  if (!after || after.status !== 'active') return null;
  // Re-insert vector (outside tx — TurboVec add is HTTP). The stored embedding BLOB survives archive.
  const embRow = db.prepare('SELECT embedding FROM memories WHERE id = ?').get(id);
  if (embRow?.embedding) {
    try { addVecsToIndex([id], [bufferToFloat32(embRow.embedding)]); } catch (e) { LOG_DEBUG && console.error('[E7] vec re-insert error:', e.message); }
  }
  return after;
}

export function getMemoriesWithoutEmbedding(limit = 100) {
  return getWithoutEmbedding.all(Math.min(limit, 500));
}

export function updateMemoryEmbedding(id, embedding) {
  updateEmbedding.run(ensureEmbeddingBuffer(embedding), _currentEmbeddingModelId, id);
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
    // E13: embedding-drift guard — cosine across DIFFERENT embedding spaces is meaningless.
    // Drop rows whose stored embedding_model_id differs from the current live model. NULL
    // model id (pre-E13 legacy rows) is treated compatible. Mirrors vectorKnnSearchAsync.
    if (mem.embedding_model_id && _currentEmbeddingModelId && mem.embedding_model_id !== _currentEmbeddingModelId) return null;
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
    // E1b: thread the active-ID allowlist into TurboVec/hybrid KNN so the native kernel
    // SIMD-filters dead (superseded/archived/invalid) vectors at the block level instead of
    // post-hoc .filter(Boolean) after they already consumed topK budget (bleed root cause #2).
    const allowlist = (backend === 'turbovec' || backend === 'hybrid') ? getActiveVectorIds(db) : null;
    const hits = (backend === 'turbovec' || backend === 'hybrid')
        ? await knnSearchHybrid(db, queryEmbedding, topK, allowlist)
        : knnSearch(db, queryEmbedding, topK);
    if (!hits) return null;
    return hits.map(h => {
        const mem = getById.get(h.id);
        if (!mem || mem.status !== 'active') return null;
        // E13: embedding-drift guard — drop rows whose stored embedding_model_id differs from
        // the current model. Cosine across different embedding spaces is meaningless; returning
        // such rows as hits would silently corrupt recall (a 384->768 swap halves it). NULL model
        // id = pre-E13 legacy row → treated compatible (re-embed cron re-stamps over time).
        if (mem.embedding_model_id && _currentEmbeddingModelId && mem.embedding_model_id !== _currentEmbeddingModelId) return null;
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
	if (from_id === to_id) throw new Error('Self-referential edge not allowed');
  return Number(insertEdge.run({ from_id, to_id, relation, valid_from: valid_from ?? new Date().toISOString(), valid_until, strength, source_session_id, metadata: JSON.stringify(metadata) }).lastInsertRowid);
}

export function getEdgesFromMemory(memoryId) { return getEdgesFrom.all(memoryId); }
export function getEdgesToMemory(memoryId) { return getEdgesTo.all(memoryId); }
export function getEdgesByRel(relation, limit = 50, asOf = null) {
  const cap = Math.min(limit, 200);
  // E9: asOf supplied → time-filter edges live at asOf (valid_until NULL OR > datetime(asOf)).
  // datetime(?) normalizes the bound ISO to the space-format valid_until is stored in; passing a
  // non-null non-IS O is the caller's contract (endpoint validates). null → existing "now" query.
  return asOf ? getEdgesByRelationAsOf.all(relation, asOf, cap) : getEdgesByRelation.all(relation, cap);
}
export function invalidateEdgeById(edgeId) { return invalidateEdge.run(edgeId).changes; }
export function getEdge(edgeId) { return getEdgeById.get(edgeId); }
export function traverseMemoryGraph(fromId, maxDepth = 3, limit = 20, direction = 'both', relation = '', asOf = null) {
  let rows;
  if (direction === 'incoming') {
    rows = asOf ? traverseGraphIncomingAsOf.all(fromId, asOf, maxDepth, asOf, limit) : traverseGraphIncoming.all(fromId, maxDepth, limit);
  } else if (direction === 'outgoing') {
    rows = asOf ? traverseGraphAsOf.all(fromId, asOf, maxDepth, asOf, limit) : traverseGraph.all(fromId, maxDepth, limit);
  } else {
    // both: combine outgoing and incoming, dedup by edge id
    const outRows = asOf ? traverseGraphAsOf.all(fromId, asOf, maxDepth, asOf, limit) : traverseGraph.all(fromId, maxDepth, limit);
    const inRows = asOf ? traverseGraphIncomingAsOf.all(fromId, asOf, maxDepth, asOf, limit) : traverseGraphIncoming.all(fromId, maxDepth, limit);
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
  // BUG-12 fix: Unicode-safe truncation by code points, + warning on truncation
	const truncated = value.length > char_limit ? (() => { console.warn(`[upsertCoreBlock] Value for key '${key}' truncated from ${value.length} to ${char_limit} chars`); return [...value].slice(0, char_limit).join(''); })() : value;
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
  const days = Math.max(1, Math.floor(olderThanDays)); // BUG-16 fix: validate integer
  return getCompressible.all(maxLevel, days, Math.min(limit, 200));
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

// BUG-19 fix: Graceful DB close on process shutdown signals
process.on('SIGTERM', () => { close(); process.exit(0); });
process.on('SIGINT', () => { close(); process.exit(0); });
