import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-ftype-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("FragmentType", () => {
  test("createFragment defaults type to fact", () => {
    const frag = core.createFragment("test content", "ai");
    assert.equal(frag.type, "fact");
  });

  test("createFragment accepts type fact", () => {
    const frag = core.createFragment("test content", "ai", null, null, null, "fact");
    assert.equal(frag.type, "fact");
  });

  test("createFragment accepts type pattern", () => {
    const frag = core.createFragment("test content", "ai", null, null, null, "pattern");
    assert.equal(frag.type, "pattern");
  });

  test("createFragment accepts type lesson", () => {
    const frag = core.createFragment("test content", "ai", null, null, null, "lesson");
    assert.equal(frag.type, "lesson");
  });

  test("createFragment accepts type warning", () => {
    const frag = core.createFragment("test content", "ai", null, null, null, "warning");
    assert.equal(frag.type, "warning");
  });

  test("createFragment accepts type context", () => {
    const frag = core.createFragment("test content", "ai", null, null, null, "context");
    assert.equal(frag.type, "context");
  });

  test("createFragment sets related_guides to empty array by default", () => {
    const frag = core.createFragment("test content", "ai");
    assert.deepEqual(frag.related_guides, []);
  });

  test("fragment with type persists through save/load cycle", () => {
    const frag = core.createFragment("typed content", "ai", "Typed", null, null, "pattern");
    core.saveMemory([frag]);
    const loaded = core.loadMemory();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].type, "pattern");
    assert.equal(loaded[0].fragment, "typed content");
  });

  test("fragment with lesson type persists through save/load cycle", () => {
    const frag = core.createFragment("learned something", "ai", "Lesson", null, null, "lesson");
    core.saveMemory([frag]);
    const loaded = core.loadMemory();
    assert.equal(loaded[0].type, "lesson");
  });

  test("fragment type is preserved after boostOnAccess", () => {
    const frag = core.createFragment("test", "ai", null, null, null, "warning");
    const boosted = core.boostOnAccess(frag);
    assert.equal(boosted.type, "warning");
  });

  test("fragment type is preserved after decayConfidence", () => {
    const frag: MemoryFragment = {
      ...core.createFragment("test", "ai", null, null, null, "context"),
      accessed: 0,
    };
    const [decayed] = core.decayConfidence([frag]);
    assert.equal(decayed.type, "context");
  });

  test("backward compat: fragment loaded from SQLite always has type field", () => {
    const frag = core.createFragment("old content", "ai", "Old Fragment");
    core.saveMemory([frag]);

    const loaded = core.loadMemory();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].type, "fact");
  });

  test("backward compat: fragment loaded from SQLite always has related_guides array", () => {
    const frag = core.createFragment("old content", "ai", "Old Fragment");
    core.saveMemory([frag]);

    const loaded = core.loadMemory();
    assert.equal(loaded.length, 1);
    assert.deepEqual(loaded[0].related_guides, []);
  });
});
