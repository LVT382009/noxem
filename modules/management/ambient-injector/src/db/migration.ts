import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "./database.js";
import { MIGRATIONS } from "./schema.js";
import { logger } from "../logger.js";

interface JsonlMemory {
  id: string;
  title: string;
  description: string;
  fragment: string;
  project: string | null;
  confidence: number;
  source: string;
  created: string;
  lastAccessed: string;
  accessed: number;
  tags: string[];
  associatedWith: string[];
  relations: { id: string; type: string; targetId?: string; sourceId?: string; note?: string; created?: string }[];
  negativeHits: number;
  quality_score: number | null;
  refinement_count: number;
  parent_id: string | null;
  session_id: string | null;
  task_type: string | null;
  positive_feedback: number;
  negative_feedback: number;
  last_refined: string | null;
  type: string;
  related_guides: string[];
  distill_candidate?: boolean;
  embedding?: number[];
}

interface JsonlGuide {
  id: string;
  guide: string;
  category: string;
  description: string;
  usage_count: number;
  last_used: string;
  contexts: string[];
  learnings: string[];
  success_count: number;
  failure_count: number;
  anti_patterns: string[];
  known_pitfalls: string[];
  last_refined: string | null;
  depends_on: string[];
  enables: string[];
  superseded_by: string | null;
  deprecated: boolean;
  source_memories: string[];
  validated_by: string[];
}

interface JsonlSession {
  id: string;
  session_id: string;
  timestamp: string;
  task_type: string;
  technology: string;
  guides_used: string[];
  memories_read: string[];
  memories_created: string[];
  task_outcome: string | null;
  refinement_attempts: number;
  self_critique_count: number;
  initial_approach: string | null;
  final_approach: string | null;
  approach_changed: boolean;
  lessons: string[];
  status: string;
  completed_at?: string;
  project?: string;
  tool_calls?: unknown[];
  memory_count?: number;
}

export function runMigrations(lemmaDb: LemmaDB): void {
  const { db } = lemmaDb;

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now')) NOT NULL
    )
  `);

  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null } | undefined;
  const currentVersion = row?.v ?? 0;

  const pending = MIGRATIONS.filter(([version]) => version > currentVersion).sort(([a], [b]) => a - b);

  for (const [version, ddl] of pending) {
    const transaction = db.transaction(() => {
      db.exec(ddl);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(version);
    });
    transaction();
    logger.info(`Migration applied`, { version });
  }

  if (pending.length === 0) {
    logger.info("Database schema is up to date");
  }
}

function readJsonlFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n");
}

function parseJsonlLines<T>(lines: string[], label: string): T[] {
  const results: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      logger.warn(`Skipping invalid ${label} line ${i + 1}`);
    }
  }
  return results;
}

function migrateMemories(lemmaDb: LemmaDB, memories: JsonlMemory[]): { count: number; legacyMap: Map<string, number> } {
  const { db } = lemmaDb;
  const legacyMap = new Map<string, number>();

  const insertMemory = lemmaDb.prepareCached(`
    INSERT INTO memories (
      legacy_id, title, fragment, description, type, project, source, confidence,
      context_tags, access_count, last_accessed_at, negative_hits, positive_feedback,
      negative_feedback, quality_score, refinement_count, session_id, task_type,
      distill_candidate, related_guides, associated_with, last_refined, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  const insertVector = lemmaDb.prepareCached(`
    INSERT INTO memory_vectors (rowid, embedding)
    VALUES (?, ?)
  `);

  const insertRelation = lemmaDb.prepareCached(`
    INSERT OR IGNORE INTO relations (source_id, target_id, type, note, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;

  for (const m of memories) {
    try {
      const distillCandidate = m.distill_candidate ? 1 : 0;
      const updatedAt = m.lastAccessed || m.created;

      const result = insertMemory.run(
        m.id,
        m.title,
        m.fragment,
        m.description || null,
        m.type || "fact",
        m.project || null,
        m.source || "ai",
        m.confidence ?? 0.5,
        m.tags ? JSON.stringify(m.tags) : null,
        m.accessed ?? 0,
        m.lastAccessed || null,
        m.negativeHits ?? 0,
        m.positive_feedback ?? 0,
        m.negative_feedback ?? 0,
        m.quality_score ?? null,
        m.refinement_count ?? 0,
        m.session_id || null,
        m.task_type || null,
        distillCandidate,
        m.related_guides ? JSON.stringify(m.related_guides) : null,
        m.associatedWith ? JSON.stringify(m.associatedWith) : null,
        m.last_refined || null,
        m.created || new Date().toISOString(),
        updatedAt,
      );

      const newId = Number(result.lastInsertRowid);
      legacyMap.set(m.id, newId);
      count++;

      if (m.embedding && Array.isArray(m.embedding) && m.embedding.length > 0) {
        try {
          const float32 = new Float32Array(m.embedding);
          insertVector.run(newId, Buffer.from(float32.buffer));
        } catch (vecErr) {
          logger.warn(`Failed to migrate embedding for memory ${m.id}`, { error: String(vecErr) });
        }
      }
    } catch (err) {
      logger.warn(`Failed to migrate memory ${m.id}`, { error: String(err) });
    }
  }

  for (const m of memories) {
    if (!m.relations || !Array.isArray(m.relations)) continue;
    const sourceNewId = legacyMap.get(m.id);
    if (!sourceNewId) continue;

    for (const rel of m.relations) {
      const targetLegacyId = rel.targetId || rel.id;
      if (!targetLegacyId) continue;
      const targetNewId = legacyMap.get(targetLegacyId);
      if (!targetNewId) {
        logger.warn(`Skipping relation from ${m.id} to unresolved target ${targetLegacyId}`);
        continue;
      }

      try {
        insertRelation.run(sourceNewId, targetNewId, rel.type, rel.note || null, rel.created || new Date().toISOString());
      } catch (err) {
        logger.warn(`Failed to migrate relation ${m.id} -> ${targetLegacyId}`, { error: String(err) });
      }
    }
  }

  return { count, legacyMap };
}

function migrateGuides(lemmaDb: LemmaDB, guides: JsonlGuide[]): number {
  const { db } = lemmaDb;

  const insertGuide = lemmaDb.prepareCached(`
    INSERT INTO guides (
      guide, category, description, anti_patterns, pitfalls, deprecated, superseded_by,
      usage_count, success_count, failure_count, last_used_at, depends_on, enables,
      source_memories, validated_by, last_refined, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertContext = lemmaDb.prepareCached(`
    INSERT OR IGNORE INTO guide_contexts (guide_id, context) VALUES (?, ?)
  `);

  const insertLearning = lemmaDb.prepareCached(`
    INSERT OR IGNORE INTO guide_learnings (guide_id, learning) VALUES (?, ?)
  `);

  let count = 0;

  for (const g of guides) {
    try {
      const now = new Date().toISOString();
      const result = insertGuide.run(
        g.guide,
        g.category,
        g.description,
        g.anti_patterns ? JSON.stringify(g.anti_patterns) : null,
        g.known_pitfalls ? JSON.stringify(g.known_pitfalls) : null,
        g.deprecated ? 1 : 0,
        g.superseded_by || null,
        g.usage_count ?? 0,
        g.success_count ?? 0,
        g.failure_count ?? 0,
        g.last_used || null,
        g.depends_on ? JSON.stringify(g.depends_on) : null,
        g.enables ? JSON.stringify(g.enables) : null,
        g.source_memories ? JSON.stringify(g.source_memories) : null,
        g.validated_by ? JSON.stringify(g.validated_by) : null,
        g.last_refined || null,
        g.last_used || now,
        now,
      );

      const guideId = Number(result.lastInsertRowid);

      if (g.contexts && Array.isArray(g.contexts)) {
        for (const ctx of g.contexts) {
          try {
            insertContext.run(guideId, ctx);
          } catch (err) {
            logger.warn(`Failed to insert context for guide ${g.guide}`, { error: String(err) });
          }
        }
      }

      if (g.learnings && Array.isArray(g.learnings)) {
        for (const learning of g.learnings) {
          try {
            insertLearning.run(guideId, learning);
          } catch (err) {
            logger.warn(`Failed to insert learning for guide ${g.guide}`, { error: String(err) });
          }
        }
      }

      count++;
    } catch (err) {
      logger.warn(`Failed to migrate guide ${g.guide}`, { error: String(err) });
    }
  }

  return count;
}

function migrateSessions(lemmaDb: LemmaDB, sessions: JsonlSession[]): number {
  const { db } = lemmaDb;

  const insertSession = lemmaDb.prepareCached(`
    INSERT OR IGNORE INTO sessions (
      id, task_type, technologies, initial_approach, final_approach, approach_changed,
      outcome, lessons, tool_calls, memory_count, status, project, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;

  for (const s of sessions) {
    try {
      const sessionId = s.session_id || s.id;
      const technologies = s.technology ? [s.technology] : [];
      const toolCallCount = Array.isArray(s.tool_calls) ? s.tool_calls.length : 0;
      const memoryCount = s.memory_count ?? ((s.memories_read?.length ?? 0) + (s.memories_created?.length ?? 0));
      const approachChanged = s.approach_changed ? 1 : 0;

      insertSession.run(
        sessionId,
        s.task_type || null,
        technologies.length > 0 ? JSON.stringify(technologies) : null,
        s.initial_approach || null,
        s.final_approach || null,
        approachChanged,
        s.task_outcome || null,
        s.lessons && s.lessons.length > 0 ? JSON.stringify(s.lessons) : null,
        toolCallCount,
        memoryCount,
        s.status || "completed",
        s.project || null,
        s.timestamp || new Date().toISOString(),
        s.completed_at || null,
      );

      count++;
    } catch (err) {
      logger.warn(`Failed to migrate session ${s.id}`, { error: String(err) });
    }
  }

  return count;
}

function renameMigratedFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const bakPath = filePath + ".migrated.bak";
  try {
    fs.renameSync(filePath, bakPath);
    logger.info(`Renamed migrated file`, { from: filePath, to: bakPath });
  } catch (err) {
    logger.warn(`Failed to rename migrated file`, { file: filePath, error: String(err) });
  }
}

export function migrateFromJsonl(
  lemmaDb: LemmaDB,
  dataDir?: string,
): { memories: number; guides: number; sessions: number } {
  const dir = dataDir || path.join(os.homedir(), ".lemma");

  const memoriesPath = path.join(dir, "memory.jsonl");
  const guidesPath = path.join(dir, "guides.jsonl");
  const sessionsPath = path.join(dir, "sessions.jsonl");

  const memoryLines = readJsonlFile(memoriesPath);
  const guideLines = readJsonlFile(guidesPath);
  const sessionLines = readJsonlFile(sessionsPath);

  if (memoryLines.length === 0 && guideLines.length === 0 && sessionLines.length === 0) {
    logger.info("No JSONL data to migrate");
    return { memories: 0, guides: 0, sessions: 0 };
  }

  logger.info("Starting JSONL migration", {
    memories: memoryLines.length,
    guides: guideLines.length,
    sessions: sessionLines.length,
  });

  const memories = parseJsonlLines<JsonlMemory>(memoryLines, "memory");
  const guides = parseJsonlLines<JsonlGuide>(guideLines, "guide");
  const sessions = parseJsonlLines<JsonlSession>(sessionLines, "session");

  const { count: memoryCount } = migrateMemories(lemmaDb, memories);
  const guideCount = migrateGuides(lemmaDb, guides);
  const sessionCount = migrateSessions(lemmaDb, sessions);

  if (memoryCount > 0) renameMigratedFile(memoriesPath);
  if (guideCount > 0) renameMigratedFile(guidesPath);
  if (sessionCount > 0) renameMigratedFile(sessionsPath);

  logger.info("JSONL migration complete", {
    memories: memoryCount,
    guides: guideCount,
    sessions: sessionCount,
  });

  return { memories: memoryCount, guides: guideCount, sessions: sessionCount };
}
