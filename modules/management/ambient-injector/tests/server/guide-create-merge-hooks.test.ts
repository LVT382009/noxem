import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleGuideCreate, handleGuideMerge } from "../../src/server/handlers.js";
import type { Guide } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-gbidir-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  sessions.setSessionsDir(TMPDIR);
  setNotifyChange(() => {});
  guideAccumulator = [];
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  sessions.setSessionsDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

let guideAccumulator: Guide[] = [];

function seedGuide(name: string, category: string, overrides: Record<string, unknown> = {}): Guide {
  const g = guides.createGuide(name, category, "Test guide");
  const merged = { ...g, ...overrides };
  guideAccumulator.push(merged as Guide);
  guides.saveGuides(guideAccumulator);
  return merged as Guide;
}

describe("guide_create response hooks", () => {
  test("new guide creation response confirms guide was created", async () => {
    const result = await handleGuideCreate({
      guide: "my-new-guide",
      category: "dev-tool",
      description: "A guide for testing hooks",
    });

    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes("Created new guide"));
    assert.ok(text.includes("my-new-guide"));
    assert.ok(text.includes("dev-tool"));
  });

  test("updating existing guide does NOT include SUGGESTED ACTIONS", async () => {
    seedGuide("existing-guide", "web-frontend");

    const result = await handleGuideCreate({
      guide: "existing-guide",
      category: "web-frontend",
      description: "Updated description",
    });

    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Updated"));
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });
});

describe("guide_merge response hooks", () => {
  test("response includes SUGGESTED ACTIONS when merged guides have anti_patterns", async () => {
    seedGuide("guide-a", "dev-tool", { anti_patterns: ["god object", "callback hell"] });
    seedGuide("guide-b", "dev-tool", { anti_patterns: ["prop drilling"] });

    const allGuides = guides.loadGuides();
    assert.equal(allGuides.length, 2);

    const result = await handleGuideMerge({
      guides: ["guide-a", "guide-b"],
      guide: "merged-guide",
      category: "dev-tool",
    });

    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes("SUGGESTED ACTIONS"));
    assert.ok(text.includes("Anti-patterns inherited: 3"));
  });

  test("response includes SUGGESTED ACTIONS when merged guides have source_memories", async () => {
    seedGuide("guide-x", "data-storage", { source_memories: ["m001", "m002"] });
    seedGuide("guide-y", "data-storage", { source_memories: ["m003"] });

    const result = await handleGuideMerge({
      guides: ["guide-x", "guide-y"],
      guide: "merged-storage",
      category: "data-storage",
    });

    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes("SUGGESTED ACTIONS"));
    assert.ok(text.includes("Source memories linked: 3"));
  });

  test("response does NOT include SUGGESTED ACTIONS when merged guides have no special properties", async () => {
    seedGuide("plain-a", "web-backend");
    seedGuide("plain-b", "web-backend");

    const result = await handleGuideMerge({
      guides: ["plain-a", "plain-b"],
      guide: "merged-plain",
      category: "web-backend",
    });

    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });
});
