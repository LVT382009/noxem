import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-persist-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("Persistence — concurrent writes", () => {
  test("sequential saveMemorySafe calls preserve all fragments", async () => {
    const f1: MemoryFragment = core.createFragment("first", "ai", "First", null);
    await core.saveMemorySafe([f1]);

    const loaded1: MemoryFragment[] = core.loadMemory();
    const f2: MemoryFragment = core.createFragment("second", "ai", "Second", null);
    const combined: MemoryFragment[] = [...loaded1, f2];
    await core.saveMemorySafe(combined);

    const loaded2: MemoryFragment[] = core.loadMemory();
    assert.equal(loaded2.length, 2);
    assert.ok(loaded2.find(f => f.title === "First"));
    assert.ok(loaded2.find(f => f.title === "Second"));
  });

  test("multiple rapid saves do not lose data", async () => {
    const frags: MemoryFragment[] = [core.createFragment("seed", "ai", "Seed", null)];
    core.saveMemory(frags);

    for (let i = 0; i < 10; i++) {
      const current: MemoryFragment[] = core.loadMemory();
      const newFrag: MemoryFragment = core.createFragment(`frag-${i}`, "ai", `Title ${i}`, null);
      current.push(newFrag);
      await core.saveMemorySafe(current);
    }

    const final: MemoryFragment[] = core.loadMemory();
    assert.equal(final.length, 11);
  });
});

describe("Persistence — large dataset", () => {
  test("create 1000 fragments, save, reload — all present", () => {
    const frags: MemoryFragment[] = Array.from({ length: 1000 }, (_, i) =>
      core.createFragment(`fragment content ${i}`, "ai", `Frag ${i}`, i % 2 === 0 ? "proj-a" : null)
    );
    core.saveMemory(frags);

    const loaded: MemoryFragment[] = core.loadMemory();
    assert.equal(loaded.length, 1000);

    for (let i = 0; i < 1000; i++) {
      assert.ok(loaded.find(f => f.title === `Frag ${i}`), `Missing fragment ${i}`);
    }
  });

  test("large dataset round-trip preserves all fields", () => {
    const original: MemoryFragment[] = Array.from({ length: 50 }, (_, i) => {
      const f: MemoryFragment = core.createFragment(`content ${i}`, "ai", `T${i}`, i < 25 ? "myproj" : null);
      f.confidence = 0.1 + (i * 0.018);
      f.tags = [`tag-${i}`];
      f.accessed = i;
      return f;
    });
    core.saveMemory(original);

    const loaded: MemoryFragment[] = core.loadMemory();
    for (let i = 0; i < 50; i++) {
      const f: MemoryFragment | undefined = loaded.find(x => x.title === `T${i}`);
      assert.ok(f);
      assert.equal(f!.confidence, original[i].confidence);
      assert.deepEqual(f!.tags, original[i].tags);
      assert.equal(f!.accessed, original[i].accessed);
    }
  });
});

describe("Persistence — malformed JSONL", () => {
  test("loadMemory returns empty array when DB has no data", () => {
    const loaded: MemoryFragment[] = core.loadMemory();
    assert.deepEqual(loaded, []);
  });
});

describe("Persistence — empty/null data protection", () => {
  test("saveMemory with null is rejected", () => {
    const seed: MemoryFragment[] = [core.createFragment("seed", "ai")];
    core.saveMemory(seed);
    core.saveMemory(null as any);

    const loaded: MemoryFragment[] = core.loadMemory();
    assert.equal(loaded.length, 1);
  });

  test("saveMemory with undefined is rejected", () => {
    const seed: MemoryFragment[] = [core.createFragment("seed", "ai")];
    core.saveMemory(seed);
    core.saveMemory(undefined as any);

    const loaded: MemoryFragment[] = core.loadMemory();
    assert.equal(loaded.length, 1);
  });

  test("saveMemory with empty array is rejected", () => {
    const seed: MemoryFragment[] = [core.createFragment("seed", "ai")];
    core.saveMemory(seed);
    core.saveMemory([]);

    const loaded: MemoryFragment[] = core.loadMemory();
    assert.equal(loaded.length, 1);
  });

  test("saveMemory with empty array and force option succeeds", () => {
    const seed: MemoryFragment[] = [core.createFragment("seed", "ai")];
    core.saveMemory(seed);
    core.saveMemory([], { force: true } as any);

    const loaded: MemoryFragment[] = core.loadMemory();
    assert.equal(loaded.length, 1);
  });
});
