import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { LemmaDB } from "../../src/db/database.js";
import { runMigrations } from "../../src/db/migration.js";
import {
  getProjectAnalytics,
  getAllProjectsAnalytics,
  formatProjectProgress,
} from "../../src/intelligence/session-analytics.js";
import { addMemory } from "../../src/db/memory-store.js";

let TMPDIR: string;
let db: LemmaDB;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-analytics-"));
  db = new LemmaDB(path.join(TMPDIR, "test.db"));
  runMigrations(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function addTestMemory(legacyId: string, project: string, confidence = 0.8, title = "Test") {
  db.prepareCached(
    `INSERT INTO memories (legacy_id, title, fragment, description, type, project, source, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(legacyId, title, `Content for ${legacyId}`, `Desc ${legacyId}`, "fact", project, "ai", confidence);
}

describe("getProjectAnalytics", () => {
  test("returns zeroed analytics for empty project", () => {
    const result = getProjectAnalytics(db, "nonexistent");
    assert.equal(result.project, "nonexistent");
    assert.equal(result.total_sessions, 0);
    assert.equal(result.total_memories, 0);
    assert.equal(result.total_guides, 0);
  });

  test("counts memories from DB", () => {
    for (let i = 0; i < 5; i++) {
      addTestMemory(`mem_${i}`, "test-project");
    }
    const result = getProjectAnalytics(db, "test-project");
    assert.equal(result.total_memories, 5);
    assert.ok(result.health_score > 0);
    assert.ok(result.health_score <= 1);
  });

  test("counts sessions from DB", () => {
    db.prepareCached(
      `INSERT INTO sessions (id, task_type, outcome, technologies, project, started_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run("s1", "implementation", "success", "[]", "myproject");
    db.prepareCached(
      `INSERT INTO sessions (id, task_type, outcome, technologies, project, started_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run("s2", "debugging", "success", "[]", "myproject");
    db.prepareCached(
      `INSERT INTO sessions (id, task_type, outcome, technologies, project, started_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run("s3", "implementation", "failure", "[]", "myproject");

    const result = getProjectAnalytics(db, "myproject");
    assert.equal(result.total_sessions, 3);
  });

  test("calculates health score between 0 and 1", () => {
    addTestMemory("m1", "p1", 0.9, "Important");

    db.prepareCached(
      `INSERT INTO sessions (id, task_type, outcome, technologies, project, started_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run("s1", "implementation", "success", "[]", "p1");

    const result = getProjectAnalytics(db, "p1");
    assert.ok(result.health_score > 0);
    assert.ok(result.health_score <= 1);
  });

  test("includes recent insights", () => {
    addTestMemory("m1", "insight-test", 0.9, "Important finding");

    const result = getProjectAnalytics(db, "insight-test");
    assert.ok(result.recent_insights.length > 0);
  });
});

describe("getAllProjectsAnalytics", () => {
  test("returns empty when no data", () => {
    const result = getAllProjectsAnalytics(db);
    assert.ok(Array.isArray(result));
  });

  test("returns per-project analytics", () => {
    addTestMemory("m1", "proj-a", 0.5, "Proj A");
    addTestMemory("m2", "proj-b", 0.5, "Proj B");

    const result = getAllProjectsAnalytics(db);
    assert.ok(result.length >= 2);
    const projects = result.map(r => r.project);
    assert.ok(projects.includes("proj-a"));
    assert.ok(projects.includes("proj-b"));
  });
});

describe("formatProjectProgress", () => {
  test("formats progress with all fields", () => {
    const progress = {
      project: "test-project",
      total_sessions: 10,
      total_memories: 25,
      total_guides: 5,
      knowledge_growth_rate: 1.5,
      skill_coverage: [
        { category: "web-frontend", count: 15, trend: "growing" as const },
        { category: "web-backend", count: 8, trend: "stable" as const },
        { category: "testing", count: 2, trend: "declining" as const },
      ],
      recent_insights: ["Completed implementation task", "Recent: Some finding"],
      health_score: 0.75,
    };
    const formatted = formatProjectProgress(progress);
    assert.ok(formatted.includes("test-project"));
    assert.ok(formatted.includes("75%"));
    assert.ok(formatted.includes("1.5x"));
    assert.ok(formatted.includes("web-frontend"));
    assert.ok(formatted.includes("↑"));
    assert.ok(formatted.includes("↓"));
    assert.ok(formatted.includes("→"));
  });
});
