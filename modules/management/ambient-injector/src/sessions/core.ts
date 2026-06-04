import os from "os";
import path from "path";
import crypto from "crypto";
import { logger } from "../logger.js";
import type { Session } from "../types.js";
import { getDb, setDataDir } from "../db/database.js";

let SESSIONS_DIR = path.join(os.homedir(), ".lemma");

export function setSessionsDir(dir: string): void {
  SESSIONS_DIR = dir;
  setDataDir(dir);
}

export function generateSessionId(): string {
  return "s" + crypto.randomUUID().replace(/-/g, "").substring(0, 12);
}

export function generateTraceId(): string {
  return "t" + crypto.randomUUID().replace(/-/g, "").substring(0, 12);
}

function rowToSession(
  row: Record<string, unknown>,
  guideIds: string[] = [],
  memoriesRead: string[] = [],
  memoriesCreated: string[] = []
): Session {
  const technologies = typeof row.technologies === "string" ? JSON.parse(row.technologies) : [];
  const lessons = typeof row.lessons === "string" ? JSON.parse(row.lessons) : [];

  return {
    id: row.id as string,
    session_id: row.id as string,
    timestamp: row.started_at as string,
    task_type: (row.task_type as string) ?? "",
    technology: technologies.join(","),
    guides_used: guideIds,
    memories_read: memoriesRead,
    memories_created: memoriesCreated,
    task_outcome: (row.outcome as string) ?? null,
    refinement_attempts: (row.refinement_attempts as number) ?? 0,
    self_critique_count: (row.self_critique_count as number) ?? 0,
    initial_approach: (row.initial_approach as string) ?? null,
    final_approach: (row.final_approach as string) ?? null,
    approach_changed: Boolean(row.approach_changed),
    lessons,
    status: (row.status as "active" | "completed" | "abandoned") ?? "active",
    completed_at: (row.ended_at as string) ?? undefined,
  };
}

export function loadSessions(): Session[] {
  logger.data("sessions.sqlite", "load_start");
  try {
    const db = getDb();

    const rows = db.prepareCached(
      "SELECT * FROM sessions ORDER BY started_at DESC"
    ).all() as Record<string, unknown>[];

    if (rows.length === 0) {
      logger.data("sessions.sqlite", "loaded", { count: 0 });
      return [];
    }

    const ids = rows.map(r => r.id as string);
    const placeholders = ids.map(() => "?").join(",");

    const guideRows = db.prepareCached(
      `SELECT sgu.session_id, g.guide FROM session_guide_usage sgu JOIN guides g ON g.id = sgu.guide_id WHERE sgu.session_id IN (${placeholders})`
    ).all(...ids) as Array<{ session_id: string; guide: string }>;

    const guideMap = new Map<string, string[]>();
    for (const gr of guideRows) {
      const list = guideMap.get(gr.session_id) ?? [];
      list.push(gr.guide);
      guideMap.set(gr.session_id, list);
    }

    const linkRows = db.prepareCached(
      `SELECT sml.session_id, m.legacy_id, sml.interaction_type FROM session_memory_links sml JOIN memories m ON m.id = sml.memory_id WHERE sml.session_id IN (${placeholders})`
    ).all(...ids) as Array<{ session_id: string; legacy_id: string; interaction_type: string }>;

    const readMap = new Map<string, string[]>();
    const createdMap = new Map<string, string[]>();
    for (const lr of linkRows) {
      if (lr.interaction_type === "read") {
        const list = readMap.get(lr.session_id) ?? [];
        list.push(lr.legacy_id);
        readMap.set(lr.session_id, list);
      } else if (lr.interaction_type === "created") {
        const list = createdMap.get(lr.session_id) ?? [];
        list.push(lr.legacy_id);
        createdMap.set(lr.session_id, list);
      }
    }

    const sessions = rows.map(row =>
      rowToSession(
        row,
        guideMap.get(row.id as string) ?? [],
        readMap.get(row.id as string) ?? [],
        createdMap.get(row.id as string) ?? []
      )
    );

    logger.data("sessions.sqlite", "loaded", { count: sessions.length });
    return sessions;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to load sessions from SQLite", msg);
    return [];
  }
}

export function saveSessions(sessions: Session[], options: { force?: boolean } = {}): void {
  try {
    if ((!sessions || sessions.length === 0) && !options.force) {
      logger.warn("Attempted to save empty sessions array - ABORTED to prevent data loss");
      return;
    }

    logger.data("sessions.sqlite", "save_start", { count: sessions?.length ?? 0, force: options.force });

    const db = getDb();

    const upsertStmt = db.prepareCached(`
      INSERT INTO sessions (
        id, task_type, technologies, initial_approach, final_approach, approach_changed,
        outcome, refinement_attempts, self_critique_count, lessons, status, started_at, ended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_type = excluded.task_type,
        technologies = excluded.technologies,
        initial_approach = excluded.initial_approach,
        final_approach = excluded.final_approach,
        approach_changed = excluded.approach_changed,
        outcome = excluded.outcome,
        refinement_attempts = excluded.refinement_attempts,
        self_critique_count = excluded.self_critique_count,
        lessons = excluded.lessons,
        status = excluded.status,
        ended_at = excluded.ended_at
    `);

    const { db: rawDb } = db;
    const transaction = rawDb.transaction(() => {
      for (const s of sessions) {
        const techArray = s.technology
          ? s.technology.split(",").map(t => t.trim()).filter(Boolean)
          : [];
        const techJson = techArray.length > 0 ? JSON.stringify(techArray) : null;
        const lessonsJson = s.lessons && s.lessons.length > 0 ? JSON.stringify(s.lessons) : null;

        upsertStmt.run(
          s.session_id,
          s.task_type || null,
          techJson,
          s.initial_approach || null,
          s.final_approach || null,
          s.approach_changed ? 1 : 0,
          s.task_outcome || null,
          s.refinement_attempts ?? 0,
          s.self_critique_count ?? 0,
          lessonsJson,
          s.status || "active",
          s.timestamp,
          s.completed_at || null,
        );

        if (s.guides_used && s.guides_used.length > 0) {
          db.prepareCached("DELETE FROM session_guide_usage WHERE session_id = ?").run(s.session_id);
          const insertGuide = db.prepareCached(
            "INSERT OR IGNORE INTO session_guide_usage (session_id, guide_id) VALUES (?, (SELECT id FROM guides WHERE guide = ? COLLATE NOCASE))"
          );
          for (const guideName of s.guides_used) {
            insertGuide.run(s.session_id, guideName);
          }
        }

        const allMemoryIds: { type: string; ids: string[] }[] = [];
        if (s.memories_read && s.memories_read.length > 0) {
          allMemoryIds.push({ type: "read", ids: s.memories_read });
        }
        if (s.memories_created && s.memories_created.length > 0) {
          allMemoryIds.push({ type: "created", ids: s.memories_created });
        }
        if (allMemoryIds.length > 0) {
          db.prepareCached("DELETE FROM session_memory_links WHERE session_id = ?").run(s.session_id);
          const insertLink = db.prepareCached(
            "INSERT OR IGNORE INTO session_memory_links (session_id, memory_id, interaction_type) VALUES (?, (SELECT id FROM memories WHERE legacy_id = ?), ?)"
          );
          for (const entry of allMemoryIds) {
            for (const memId of entry.ids) {
              insertLink.run(s.session_id, memId, entry.type);
            }
          }
        }
      }
    });

    transaction();
    logger.data("sessions.sqlite", "saved", { count: sessions?.length ?? 0 });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to save sessions to SQLite", msg);
    throw error;
  }
}

export function createSession(taskType: string, technologies: string[] = []): Session {
  logger.flow("session_create", "start", { taskType, technologies });
  const sessionId = generateSessionId();
  const now = new Date().toISOString();

  const session: Session = {
    id: sessionId,
    session_id: sessionId,
    timestamp: now,
    task_type: taskType,
    technology: technologies.join(","),
    guides_used: [],
    memories_read: [],
    memories_created: [],
    task_outcome: null,
    refinement_attempts: 0,
    self_critique_count: 0,
    initial_approach: null,
    final_approach: null,
    approach_changed: false,
    lessons: [],
    status: "active",
  };

  try {
    const db = getDb();
    const techJson = technologies.length > 0 ? JSON.stringify(technologies) : null;
    db.prepareCached(
      `INSERT INTO sessions (id, task_type, technologies, status, started_at)
       VALUES (?, ?, ?, 'active', ?)`
    ).run(sessionId, taskType, techJson, now);
    logger.flow("session_create", "created", { sessionId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to persist new session to SQLite", msg);
  }

  return session;
}

export function findSession(sessions: Session[], sessionId: string): Session | null {
  const result = sessions.find(s => s.session_id === sessionId) || null;
  logger.flow("session_find", "by_id", { sessionId, found: !!result });
  return result;
}

export function findActiveSession(sessions: Session[]): Session | null {
  const result = sessions.find(s => s.status === "active") || null;
  logger.flow("session_find", "active", { found: !!result });
  return result;
}

export function endSession(session: Session, outcome: string, finalApproach: string | null = null, lessons: string[] = []): Session {
  logger.flow("session_end", "start", { sessionId: session.session_id, outcome });
  session.status = "completed";
  session.task_outcome = outcome;
  session.final_approach = finalApproach;
  session.lessons = lessons;
  session.completed_at = new Date().toISOString();

  try {
    const db = getDb();
    const lessonsJson = lessons.length > 0 ? JSON.stringify(lessons) : null;
    db.prepareCached(
      `UPDATE sessions SET status = 'completed', outcome = ?, final_approach = ?, lessons = ?, ended_at = ? WHERE id = ?`
    ).run(outcome, finalApproach ?? null, lessonsJson, session.completed_at, session.session_id);
    logger.flow("session_end", "complete", { sessionId: session.session_id, outcome });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("Failed to update session in SQLite", msg);
  }

  return session;
}

export function getRecentSessions(sessions: Session[], limit: number = 10): Session[] {
  return [...sessions]
    .filter(s => s.status === "completed")
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

export function getSessionsByTechnology(sessions: Session[], technology: string): Session[] {
  const lower = technology.toLowerCase();
  return sessions.filter(s =>
    s.technology && s.technology.toLowerCase().includes(lower)
  );
}

export function calculateSuccessRate(sessions: Session[]): number | null {
  const completed = sessions.filter(s => s.status === "completed" && s.task_outcome);
  if (completed.length === 0) return null;
  const successes = completed.filter(s => s.task_outcome === "success").length;
  return successes / completed.length;
}

export function formatSessionDetail(session: Session | null): string {
  if (!session) return "Session not found.";

  let detail = `=== SESSION DETAIL ===\n`;
  detail += `Session ID: ${session.session_id}\n`;
  detail += `Trace ID: ${session.id}\n`;
  detail += `Status: ${session.status}\n`;
  detail += `Task Type: ${session.task_type || "unknown"}\n`;
  detail += `Technology: ${session.technology || "none"}\n`;
  detail += `Started: ${session.timestamp}\n`;
  if (session.completed_at) {
    detail += `Completed: ${session.completed_at}\n`;
  }
  if (session.task_outcome) {
    detail += `Outcome: ${session.task_outcome}\n`;
  }
  if (session.guides_used && session.guides_used.length > 0) {
    detail += `Guides Used: ${session.guides_used.join(", ")}\n`;
  }
  if (session.memories_read && session.memories_read.length > 0) {
    detail += `Memories Read: ${session.memories_read.length}\n`;
  }
  if (session.memories_created && session.memories_created.length > 0) {
    detail += `Memories Created: ${session.memories_created.length}\n`;
  }
  if (session.lessons && session.lessons.length > 0) {
    detail += `Lessons:\n`;
    for (const l of session.lessons) {
      detail += `  - ${l}\n`;
    }
  }
  if (session.final_approach) {
    detail += `Final Approach: ${session.final_approach}\n`;
  }
  detail += `====================`;
  return detail;
}
