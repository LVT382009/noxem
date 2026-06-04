import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as handlers from "../../src/server/handlers.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-read-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("handleMemoryRead — ids batch", () => {
  test("reads multiple fragments by ID array and returns all details", async () => {
    const f1 = core.createFragment("content a", "ai", "Title A", null);
    const f2 = core.createFragment("content b", "ai", "Title B", null);
    core.saveMemory([f1, f2]);

    const result = await handlers.handleMemoryRead({ ids: [f1.id, f2.id] });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Title A"));
    assert.ok(result.content[0].text.includes("Title B"));
    assert.ok(result.content[0].text.includes("content a"));
    assert.ok(result.content[0].text.includes("content b"));
  });

  test("returns details for found IDs and not-found message for missing ones", async () => {
    const f1 = core.createFragment("found content", "ai", "Found", null);
    core.saveMemory([f1]);

    const result = await handlers.handleMemoryRead({ ids: [f1.id, "m_nonexistent"] });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Found"));
    assert.ok(result.content[0].text.includes("not found"));
  });

  test("handles empty ids array without crashing", async () => {
    const f = core.createFragment("test content", "ai", "Test", null);
    core.saveMemory([f]);

    const result = await handlers.handleMemoryRead({ ids: [] });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Memory Fragments"));
  });
});

describe("handleMemoryRead — all=true", () => {
  test("returns all fragments regardless of project when all=true", async () => {
    const f1 = core.createFragment("global content", "ai", "Global", null);
    const f2 = core.createFragment("proj content", "ai", "Scoped", "OtherProject");
    core.saveMemory([f1, f2]);

    const result = await handlers.handleMemoryRead({ all: true });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Global"));
    assert.ok(result.content[0].text.includes("Scoped"));
  });

  test("returns empty state when no fragments exist", async () => {
    const result = await handlers.handleMemoryRead({ all: true });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("no fragments"));
  });
});

describe("handleMemoryRead — query search", () => {
  test("searches fragments by fuzzy query and returns matching results", async () => {
    const f1 = core.createFragment("react component patterns", "ai", "React", null);
    const f2 = core.createFragment("python data analysis", "ai", "Python", null);
    core.saveMemory([f1, f2]);

    const result = await handlers.handleMemoryRead({ query: "react", all: true });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("React"));
  });

  test("returns empty when no fragments exist to match query", async () => {
    const result = await handlers.handleMemoryRead({ query: "nonexistent_xyz", all: true });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("no fragments"));
  });

  test("combined: query + project filters together", async () => {
    const f1 = core.createFragment("react patterns", "ai", "React A", "projA");
    const f2 = core.createFragment("vue patterns", "ai", "Vue B", "projB");
    const f3 = core.createFragment("react tips", "ai", "React Tips", "projA");
    core.saveMemory([f1, f2, f3]);

    const result = await handlers.handleMemoryRead({ query: "react", project: "projA" });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("React A"));
    assert.ok(!result.content[0].text.includes("Vue B"));
  });
});
