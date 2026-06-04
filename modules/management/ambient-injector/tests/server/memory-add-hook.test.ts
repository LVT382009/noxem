import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleMemoryAdd } from "../../src/server/handlers.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-mhook-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  sessions.setSessionsDir(TMPDIR);
  setNotifyChange(() => {});
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  sessions.setSessionsDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedFragment(text: string, project: string | null = null): MemoryFragment {
  const frags = [core.createFragment(text, "ai", null, project)];
  core.saveMemory(frags);
  return frags[0];
}

describe("memory_add response hooks", () => {
  test("includes AUTO-LINKED when topic overlaps exist", async () => {
    seedFragment("React hooks pattern for state management", null);
    const result = await handleMemoryAdd({
      fragment: "React hooks cleanup for useEffect",
      project: null,
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("AUTO-LINKED"));
  });

  test("includes SUGGESTED ACTIONS for pattern type suggesting guide_distill", async () => {
    const result = await handleMemoryAdd({
      fragment: "Always use useCallback for memoization in React components",
      type: "pattern",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("SUGGESTED ACTIONS"));
    assert.ok(result.content[0].text.includes("guide_distill"));
  });

  test("includes SUGGESTED ACTIONS for lesson type suggesting guide_distill", async () => {
    const result = await handleMemoryAdd({
      fragment: "Never mutate state directly in Redux reducers always return new state",
      type: "lesson",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("SUGGESTED ACTIONS"));
    assert.ok(result.content[0].text.includes("guide_distill"));
  });

  test("does NOT include SUGGESTED ACTIONS when no overlaps and type is fact and no session reads", async () => {
    const result = await handleMemoryAdd({
      fragment: "The sky is blue on clear days due to Rayleigh scattering",
      type: "fact",
    });
    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });

  test("includes type in created fragment", async () => {
    await handleMemoryAdd({
      fragment: "Be careful with pointer arithmetic in unsafe blocks",
      type: "warning",
    });
    const loaded = core.loadMemory();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].type, "warning");
  });

  test("defaults type to fact when not provided", async () => {
    await handleMemoryAdd({
      fragment: "Some generic fact about programming languages",
    });
    const loaded = core.loadMemory();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].type, "fact");
  });

  test("invalid type falls back to fact", async () => {
    await handleMemoryAdd({
      fragment: "Another piece of knowledge about databases",
      type: "invalid_type",
    });
    const loaded = core.loadMemory();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].type, "fact");
  });
});
