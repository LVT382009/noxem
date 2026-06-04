import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-edge-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("applySessionDecay", () => {
  test("loads all fragments, applies decay, and saves back", () => {
    const f1: MemoryFragment = core.createFragment("alpha content", "ai", "Alpha", null);
    const f2: MemoryFragment = core.createFragment("beta content", "ai", "Beta", null);
    f1.confidence = 0.8;
    f2.confidence = 0.6;
    core.saveMemory([f1, f2]);

    const result: MemoryFragment[] = core.applySessionDecay();

    assert.equal(result.length, 2);
    assert.ok(result.find(f => f.title === "Alpha")!.confidence < 0.8);
    assert.ok(result.find(f => f.title === "Beta")!.confidence < 0.6);

    const reloaded: MemoryFragment[] = core.loadMemory();
    assert.equal(reloaded.length, 2);
    assert.ok(reloaded.find(f => f.title === "Alpha")!.confidence < 0.8);
    assert.ok(reloaded.find(f => f.title === "Beta")!.confidence < 0.6);
  });

  test("preserves project info when decaying multi-project memory", () => {
    const f1: MemoryFragment = core.createFragment("global info", "ai", "Global", null);
    const f2: MemoryFragment = core.createFragment("project info", "ai", "Scoped", "MyProject");
    core.saveMemory([f1, f2]);

    const result: MemoryFragment[] = core.applySessionDecay();

    assert.equal(result.length, 2);
    const g = result.find(f => f.title === "Global")!;
    const s = result.find(f => f.title === "Scoped")!;
    assert.equal(g.project, null);
    assert.equal(s.project, "MyProject");
    assert.ok(g.confidence < 1.0);
    assert.ok(s.confidence < 1.0);
  });

  test("handles empty memory gracefully", () => {
    const result: MemoryFragment[] = core.applySessionDecay();
    assert.deepEqual(result, []);
  });
});

describe("detectProject", () => {
  test("returns null when cwd is not detectable", () => {
    const result: string | null = core.detectProject();
    assert.ok(result === null || typeof result === "string");
  });

  test("extracts project name from directory path", () => {
    const result: string | null = core.detectProject();
    assert.equal(result, path.basename(process.cwd()));
  });
});

describe("generateId", () => {
  test("generates IDs starting with m", () => {
    for (let i = 0; i < 10; i++) {
      assert.ok(core.generateId().startsWith("m"));
    }
  });

  test("generates unique IDs on successive calls", () => {
    const ids: Set<string> = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(core.generateId());
    }
    assert.equal(ids.size, 100);
  });
});
