export { getDb, closeDb, setDataDir, LemmaDB } from "./database.js";
export { SCHEMA_V1, MIGRATIONS } from "./schema.js";
export { runMigrations, migrateFromJsonl } from "./migration.js";
export { addMemory, getMemoryById, updateMemory, deleteMemory, searchMemories, addRelation, getRelations, boostConfidence, decayMemories, getMemoryStats, mergeMemories, shouldRunDecay, markDecayRun } from "./memory-store.js";

import { getDb } from "./database.js";
import { runMigrations, migrateFromJsonl } from "./migration.js";
import { logger } from "../logger.js";

export function initDatabase(dbPath?: string): void {
  const db = getDb(dbPath);
  runMigrations(db);

  const migration = migrateFromJsonl(db);
  if (migration.memories > 0 || migration.guides > 0 || migration.sessions > 0) {
    logger.info("JSONL migration completed", migration);
  }

  logger.info("Database initialized");
}
