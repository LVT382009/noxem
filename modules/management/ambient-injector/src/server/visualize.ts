import http from "http";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import { initDatabase, getDb } from "../db/index.js";
import * as memoryStore from "../db/memory-store.js";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "visualizer.html");
const DEFAULT_PORT = 3456;

function getHTML(): string {
  return fs.readFileSync(HTML_PATH, "utf-8");
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function openBrowser(url: string): void {
  let cmd: string;
  if (process.platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (process.platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}" 2>/dev/null || true`;
  }
  exec(cmd, (err) => {
    if (err) {
      console.error(`[Lemma Visualizer] Could not open browser: ${err.message}`);
      console.error(`[Lemma Visualizer] Open manually: ${url}`);
    }
  });
}

function resolveNumericId(db: ReturnType<typeof getDb>, legacyId: string): number | null {
  const row = db
    .prepareCached("SELECT id FROM memories WHERE legacy_id = ?")
    .get(legacyId) as { id: number } | undefined;
  return row?.id ?? null;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: ReturnType<typeof getDb>,
  html: string,
): Promise<void> {
  const url = new URL(req.url || "/", `http://localhost`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/api/health") {
    jsonResponse(res, { status: "ok" });
    return;
  }

  if (url.pathname === "/api/data" && req.method === "GET") {
    const fragments = memoryStore.searchMemories(db, "", { all: true, topK: 100000 });
    jsonResponse(res, fragments);
    return;
  }

  if (url.pathname === "/api/stats" && req.method === "GET") {
    const stats = memoryStore.getMemoryStats(db);
    const relationCount = (
      db.prepareCached("SELECT COUNT(*) as c FROM relations").get() as { c: number }
    ).c;
    const projects = (
      db.prepareCached(
        "SELECT DISTINCT COALESCE(project, '(global)') as p FROM memories"
      ).all() as { p: string }[]
    ).map((r) => r.p);
    jsonResponse(res, {
      total: stats.total,
      projects,
      relations: relationCount,
      avgConfidence: stats.avg_confidence,
    });
    return;
  }

  if (url.pathname.startsWith("/api/fragments/") && req.method === "PATCH") {
    const legacyId = url.pathname.replace("/api/fragments/", "");
    const body = JSON.parse(await parseBody(req));
    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.fragment !== undefined) updates.fragment = body.fragment;
    if (body.confidence !== undefined) updates.confidence = Number(body.confidence);
    if (body.type !== undefined) updates.type = body.type;
    if (body.project !== undefined) updates.project = body.project || null;
    const ok = memoryStore.updateMemory(db, legacyId, updates);
    jsonResponse(res, ok ? { ok: true } : { ok: false, error: "Not found" }, ok ? 200 : 404);
    return;
  }

  if (url.pathname.startsWith("/api/fragments/") && req.method === "DELETE") {
    const legacyId = decodeURIComponent(url.pathname.replace("/api/fragments/", ""));
    const ok = memoryStore.deleteMemory(db, legacyId);
    jsonResponse(res, ok ? { ok: true } : { ok: false, error: "Not found" }, ok ? 200 : 404);
    return;
  }

  if (url.pathname === "/api/relations" && req.method === "POST") {
    const body = JSON.parse(await parseBody(req));
    const sourceLegacy = body.source as string;
    const targetLegacy = body.target as string;
    const type = body.type as string;

    const sourceId = resolveNumericId(db, sourceLegacy);
    const targetId = resolveNumericId(db, targetLegacy);

    if (!sourceId || !targetId) {
      jsonResponse(res, { ok: false, error: "Source or target not found" }, 404);
      return;
    }

    const ok = memoryStore.addRelation(db, sourceId, targetId, type, body.note);
    jsonResponse(res, ok ? { ok: true } : { ok: false, error: "Failed" });
    return;
  }

  if (url.pathname === "/api/relations" && req.method === "DELETE") {
    const body = JSON.parse(await parseBody(req));
    const sourceLegacy = body.source as string;
    const targetLegacy = body.target as string;
    const type = body.type as string;

    const sourceId = resolveNumericId(db, sourceLegacy);
    const targetId = resolveNumericId(db, targetLegacy);

    if (!sourceId || !targetId) {
      jsonResponse(res, { ok: false, error: "Not found" }, 404);
      return;
    }

    const result = db
      .prepareCached(
        "DELETE FROM relations WHERE source_id = ? AND target_id = ? AND type = ?"
      )
      .run(sourceId, targetId, type);

    const reverseResult = db
      .prepareCached(
        "DELETE FROM relations WHERE source_id = ? AND target_id = ?"
      )
      .run(targetId, sourceId);

    const deleted = result.changes + reverseResult.changes;
    jsonResponse(res, { ok: deleted > 0, deleted });
    return;
  }

  if (url.pathname === "/api/export" && req.method === "GET") {
    const fragments = memoryStore.searchMemories(db, "", { all: true, topK: 100000 });
    const lines = fragments.map((f) => JSON.stringify(f)).join("\n");
    res.writeHead(200, {
      "Content-Type": "application/x-jsonlines",
      "Content-Disposition": "attachment; filename=memory-export.jsonl",
    });
    res.end(lines);
    return;
  }

  jsonResponse(res, { error: "Not found" }, 404);
}

export function startVisualizeServer(portArg?: number): Promise<void> {
  initDatabase();
  const db = getDb();
  const html = getHTML();
  const port = portArg || DEFAULT_PORT;

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res, db, html).catch((err) => {
        logger.error("Visualizer request error", (err as Error).message);
        jsonResponse(res, { error: "Internal server error" }, 500);
      });
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[Lemma Visualizer] Port ${port} is already in use.`);
        console.error(`[Lemma Visualizer] Try: lemma --visualize --port ${port + 1}`);
        process.exit(1);
      } else {
        console.error(`[Lemma Visualizer] Server error: ${err.message}`);
        process.exit(1);
      }
    });

    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.error(``);
      console.error(`  ┌──────────────────────────────────────────┐`);
      console.error(`  │  Lemma Memory Visualizer                  │`);
      console.error(`  │  ${url.padEnd(42)}│`);
      console.error(`  │  Press Ctrl+C to stop                     │`);
      console.error(`  └──────────────────────────────────────────┘`);
      console.error(``);
      openBrowser(url);
      resolve();
    });

    const shutdown = () => {
      console.error(`\n[Lemma Visualizer] Shutting down...`);
      server.close();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}
