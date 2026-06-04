import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import * as handlers from "../../src/server/handlers.js";
import type { Guide } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-adv-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  sessions.setSessionsDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  sessions.setSessionsDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedGuide(name: string, category: string, description?: string, overrides: Partial<Guide> = {}): Guide {
  const allGuides = guides.loadGuides();
  const g = guides.createGuide(name, category, description || "desc");
  Object.assign(g, overrides);
  allGuides.push(g);
  guides.saveGuides(allGuides);
  return g;
}

describe("handleGuideCreate — existing similar guide", () => {
  test("when similar guide exists, updates its description instead of creating new", async () => {
    seedGuide("react-hooks", "web-frontend", "Old description");

    const result = await handlers.handleGuideCreate({
      guide: "react-hooks",
      category: "web-frontend",
      description: "Updated manual for hooks",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Updated manual for existing guide"));

    const loaded = guides.loadGuides();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].description, "Updated manual for hooks");
  });

  test("creates new guide when no similar exists", async () => {
    const result = await handlers.handleGuideCreate({
      guide: "rust",
      category: "programming-language",
      description: "Rust ownership and borrowing",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Created new guide"));

    const loaded = guides.loadGuides();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].guide, "rust");
  });

  test("returns error when required params missing", async () => {
    const result = await handlers.handleGuideCreate({
      guide: "react",
      category: "web-frontend",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("required"));
  });
});

describe("handleGuideMerge — auto-merge", () => {
  test("auto-merges contexts from source guides when contexts not provided", async () => {
    seedGuide("a", "dev-tool", "Guide A", { contexts: ["hooks", "state"] });
    seedGuide("b", "dev-tool", "Guide B", { contexts: ["composition", "state"] });

    await handlers.handleGuideMerge({
      guides: ["a", "b"],
      guide: "merged",
      category: "dev-tool",
    });

    const loaded = guides.loadGuides();
    const merged = loaded.find((g: Guide) => g.guide === "merged")!;
    assert.ok(merged);
    assert.deepEqual(merged.contexts.sort(), ["composition", "hooks", "state"]);
  });

  test("auto-merges learnings from source guides when learnings not provided", async () => {
    seedGuide("a", "dev-tool", "Guide A", { learnings: ["learning A"] });
    seedGuide("b", "dev-tool", "Guide B", { learnings: ["learning B"] });

    await handlers.handleGuideMerge({
      guides: ["a", "b"],
      guide: "merged",
      category: "dev-tool",
    });

    const loaded = guides.loadGuides();
    const merged = loaded.find((g: Guide) => g.guide === "merged")!;
    assert.ok(merged);
    assert.deepEqual(merged.learnings.sort(), ["learning A", "learning B"]);
  });

  test("merges anti_patterns from all source guides", async () => {
    seedGuide("a", "dev-tool", "A", { anti_patterns: ["prop drilling"] });
    seedGuide("b", "dev-tool", "B", { anti_patterns: ["mutating props"] });

    await handlers.handleGuideMerge({
      guides: ["a", "b"],
      guide: "merged",
      category: "dev-tool",
    });

    const loaded = guides.loadGuides();
    const merged = loaded.find((g: Guide) => g.guide === "merged")!;
    assert.deepEqual(merged.anti_patterns.sort(), ["mutating props", "prop drilling"]);
  });

  test("merges known_pitfalls from all source guides", async () => {
    seedGuide("a", "dev-tool", "A", { known_pitfalls: ["stale closures"] });
    seedGuide("b", "dev-tool", "B", { known_pitfalls: ["reactivity loss"] });

    await handlers.handleGuideMerge({
      guides: ["a", "b"],
      guide: "merged",
      category: "dev-tool",
    });

    const loaded = guides.loadGuides();
    const merged = loaded.find((g: Guide) => g.guide === "merged")!;
    assert.deepEqual(merged.known_pitfalls.sort(), ["reactivity loss", "stale closures"]);
  });
});

describe("handleGuidePractice — session linking", () => {
  test("tracks guide in active session's guides_used when session exists", async () => {
    await handlers.handleSessionStart({ task_type: "implementation" });

    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      description: "React guide",
    });

    const allSessions = sessions.loadSessions();
    const active = allSessions.find((s: { status: string }) => s.status === "active")!;
    assert.ok(active);
    assert.ok(active.guides_used.includes("react"));
  });

  test("records success outcome correctly (success_count increments)", async () => {
    seedGuide("react", "web-frontend", "React guide");

    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      outcome: "success",
    });

    const loaded = guides.loadGuides();
    assert.equal(loaded[0].success_count, 1);
  });

  test("records failure outcome correctly (failure_count increments)", async () => {
    seedGuide("react", "web-frontend", "React guide");

    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      outcome: "failure",
    });

    const loaded = guides.loadGuides();
    assert.equal(loaded[0].failure_count, 1);
  });
});

describe("practiceGuide — outcome tracking", () => {
  test("increments success_count when outcome is success", () => {
    const gs = [guides.createGuide("react", "web-frontend", "desc")];
    guides.practiceGuide(gs, "react", "web-frontend", "", [], [], "success");
    assert.equal(gs[0].success_count, 1);
    assert.equal(gs[0].failure_count, 0);
  });

  test("increments failure_count when outcome is failure", () => {
    const gs = [guides.createGuide("react", "web-frontend", "desc")];
    guides.practiceGuide(gs, "react", "web-frontend", "", [], [], "failure");
    assert.equal(gs[0].failure_count, 1);
    assert.equal(gs[0].success_count, 0);
  });

  test("does not change counts when outcome is null", () => {
    const gs = [guides.createGuide("react", "web-frontend", "desc")];
    guides.practiceGuide(gs, "react", "web-frontend", "", [], [], null);
    assert.equal(gs[0].success_count, 0);
    assert.equal(gs[0].failure_count, 0);
  });
});

describe("promoteToGuide — context deduplication", () => {
  test("adds context to existing guide without duplicating", () => {
    const gs = [guides.createGuide("react", "web-frontend", "desc", ["hooks"])];
    guides.promoteToGuide(gs, "react", "web-frontend", "new learning", "hooks");
    assert.equal(gs[0].contexts.length, 1);
    assert.deepEqual(gs[0].contexts, ["hooks"]);
  });

  test("adds learning to existing guide without duplicating", () => {
    const gs = [guides.createGuide("react", "web-frontend", "desc", [], ["useCallback is great"])];
    guides.promoteToGuide(gs, "react", "web-frontend", "useCallback is great", "hooks");
    assert.equal(gs[0].learnings.length, 1);
    assert.deepEqual(gs[0].learnings, ["useCallback is great"]);
  });
});
