import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import { setNotifyChange, handleMemoryLibrary } from "../../src/server/handlers.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-lib-handler-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  setNotifyChange(() => {});
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("handleMemoryLibrary", () => {
  test("returns empty snapshot for empty DB", async () => {
    const result = await handleMemoryLibrary();
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("LIBRARY MODE SNAPSHOT"));
    assert.ok(result.content[0].text.includes("Total memories: 0"));
  });

  test("returns full snapshot by default with data", async () => {
    const frag = core.createFragment("Full snapshot test content", "ai", "Full", null);
    core.saveMemory([frag]);

    const result = await handleMemoryLibrary();
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("LIBRARY MODE SNAPSHOT"));
    assert.ok(result.content[0].text.includes("MEMORY FRAGMENTS"));
    assert.ok(result.content[0].text.includes("RELATIONS"));
    assert.ok(result.content[0].text.includes("ANALYSIS SIGNALS"));
  });

  test("includes all section headers in full mode", async () => {
    const frag = core.createFragment("Test fragment for library", "ai", "Lib", "proj1");
    core.saveMemory([frag]);

    const result = await handleMemoryLibrary({ focus: "full" });
    const text = result.content[0].text;
    assert.ok(text.includes("MEMORY FRAGMENTS"));
    assert.ok(text.includes("RELATIONS"));
    assert.ok(text.includes("ANALYSIS SIGNALS"));
    assert.ok(text.includes("SESSION ACTIVITY"));
  });

  test("includes fragments after adding memories", async () => {
    const frag = core.createFragment("Unique library test content alpha", "ai", "Alpha", "libtest");
    core.saveMemory([frag]);

    const result = await handleMemoryLibrary();
    assert.ok(result.content[0].text.includes("libtest"));
  });

  test("includes guides after creating them", async () => {
    const allGuides = guides.loadGuides();
    guides.practiceGuide(allGuides, "testguide", "dev-tool", "Test guide desc", ["testing"], ["guides work"]);
    guides.saveGuides(allGuides);

    const result = await handleMemoryLibrary({ focus: "guides" });
    assert.ok(result.content[0].text.includes("testguide"));
  });

  test("includes SUGGESTED ACTIONS when issues detected", async () => {
    const frag = core.createFragment("Distillable pattern fragment", "ai", "Distillable", null);
    frag.type = "pattern";
    core.saveMemory([frag]);

    const loaded = core.loadMemory();
    const target = loaded.find(f => f.title === "Distillable")!;
    target.distill_candidate = true;
    core.saveMemory(loaded);

    const result = await handleMemoryLibrary({ focus: "full" });
    const text = result.content[0].text;
    assert.ok(text.includes("SUGGESTED ACTIONS") || text.includes("DISTILL") || text.includes("distill"));
  });

  test("respects focus=stale parameter", async () => {
    const result = await handleMemoryLibrary({ focus: "stale" });
    assert.ok(result.content[0].text.includes("Stale Fragments"));
    assert.ok(!result.content[0].text.includes("MEMORY FRAGMENTS"));
  });

  test("respects focus=duplicates parameter", async () => {
    const result = await handleMemoryLibrary({ focus: "duplicates" });
    assert.ok(result.content[0].text.includes("Similarity Candidates"));
    assert.ok(!result.content[0].text.includes("MEMORY FRAGMENTS"));
  });

  test("respects focus=guides parameter", async () => {
    const result = await handleMemoryLibrary({ focus: "guides" });
    assert.ok(!result.content[0].text.includes("MEMORY FRAGMENTS"));
    assert.ok(!result.content[0].text.includes("RELATIONS"));
  });

  test("filters by project when specified", async () => {
    const fragA = core.createFragment("Project A content", "ai", "A", "projA");
    const fragB = core.createFragment("Project B content", "ai", "B", "projB");
    core.saveMemory([fragA, fragB]);

    const result = await handleMemoryLibrary({ project: "projA" });
    const text = result.content[0].text;
    assert.ok(text.includes("projA"));
  });

  test("result is not an error", async () => {
    const result = await handleMemoryLibrary();
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
  });

  test("includes GENERATED timestamp", async () => {
    const result = await handleMemoryLibrary();
    assert.ok(result.content[0].text.includes("Generated:"));
    const match = result.content[0].text.match(/Generated: (\d{4}-\d{2}-\d{2})/);
    assert.ok(match);
  });

  test("snapshot includes health status", async () => {
    const result = await handleMemoryLibrary();
    const text = result.content[0].text;
    assert.ok(text.includes("Database health:"));
    assert.ok(text.includes("HEALTHY") || text.includes("NEEDS ATTENTION"));
  });
});
