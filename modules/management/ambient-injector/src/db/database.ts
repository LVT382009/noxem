import path from "path";
import os from "os";
import fs from "fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { logger } from "../logger.js";
import { runMigrations } from "./migration.js";

const DEFAULT_DB_PATH = path.join(os.homedir(), ".lemma", "lemma.db");

export class LemmaDB {
  private static readonly MAX_CACHE_SIZE = 200;
  readonly db: Database.Database;
  private stmtCache: Map<string, Database.Statement> = new Map();

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    sqliteVec.load(this.db);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("cache_size = -64000");
    this.db.pragma("temp_store = MEMORY");

    logger.info("Database opened", { path: dbPath });
  }

  prepareCached(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      if (this.stmtCache.size >= LemmaDB.MAX_CACHE_SIZE) {
        const keys = [...this.stmtCache.keys()].slice(0, 50);
        for (const k of keys) this.stmtCache.delete(k);
      }
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  close(): void {
    this.stmtCache.clear();
    this.db.close();
    logger.info("Database closed");
  }
}

let _instance: LemmaDB | null = null;
let _currentPath: string | null = null;
let _dataDir: string | null = null;

export function setDataDir(dir: string): void {
  _dataDir = dir;
  if (_instance) {
    try { _instance.close(); } catch {}
    _instance = null;
    _currentPath = null;
  }
}

export function getDb(dbPath?: string): LemmaDB {
  const resolvedPath = dbPath ?? (_dataDir ? path.join(_dataDir, "lemma.db") : DEFAULT_DB_PATH);
  if (!_instance || _currentPath !== resolvedPath) {
    if (_instance) {
      try { _instance.close(); } catch {}
    }
    _instance = new LemmaDB(resolvedPath);
    _currentPath = resolvedPath;
    runMigrations(_instance);
  }
  return _instance;
}

export function closeDb(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
    _currentPath = null;
  }
}
