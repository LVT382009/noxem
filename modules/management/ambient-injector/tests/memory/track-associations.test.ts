import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-tassoc-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("trackAssociations", () => {
  test("creates bidirectional links between fragments", () => {
    const a = core.createFragment("alpha", "ai");
    const b = core.createFragment("beta", "ai");
    const frags: MemoryFragment[] = [a, b];

    core.trackAssociations(frags, a.id, [b.id]);

    assert.deepEqual(a.associatedWith, [b.id]);
    assert.deepEqual(b.associatedWith, [a.id]);
  });

  test("with empty sessionIds does nothing", () => {
    const frag = core.createFragment("solo", "ai");
    const originalAssoc = [...frag.associatedWith];

    core.trackAssociations([frag], frag.id, []);

    assert.deepEqual(frag.associatedWith, originalAssoc);
  });

  test("with non-existent targetId is ignored", () => {
    const frag = core.createFragment("real", "ai");
    const frags: MemoryFragment[] = [frag];

    core.trackAssociations(frags, frag.id, ["m_ghost000000"]);

    assert.deepEqual(frag.associatedWith, ["m_ghost000000"]);
  });

  test("does not duplicate existing associations", () => {
    const a = core.createFragment("alpha", "ai");
    const b = core.createFragment("beta", "ai");
    const frags: MemoryFragment[] = [a, b];

    core.trackAssociations(frags, a.id, [b.id]);
    core.trackAssociations(frags, a.id, [b.id]);

    assert.equal(a.associatedWith.length, 1);
    assert.equal(b.associatedWith.length, 1);
  });

  test("does not self-associate", () => {
    const frag = core.createFragment("self", "ai");
    const frags: MemoryFragment[] = [frag];

    core.trackAssociations(frags, frag.id, [frag.id]);

    assert.deepEqual(frag.associatedWith, []);
  });

  test("multiple associations in sequence work correctly", () => {
    const a = core.createFragment("alpha", "ai");
    const b = core.createFragment("beta", "ai");
    const c = core.createFragment("gamma", "ai");
    const frags: MemoryFragment[] = [a, b, c];

    core.trackAssociations(frags, a.id, [b.id]);
    core.trackAssociations(frags, a.id, [c.id]);

    assert.equal(a.associatedWith.length, 2);
    assert.ok(a.associatedWith.includes(b.id));
    assert.ok(a.associatedWith.includes(c.id));
    assert.ok(b.associatedWith.includes(a.id));
    assert.ok(c.associatedWith.includes(a.id));
  });

  test("bidirectional link with three-way association", () => {
    const a = core.createFragment("alpha", "ai");
    const b = core.createFragment("beta", "ai");
    const c = core.createFragment("gamma", "ai");
    const frags: MemoryFragment[] = [a, b, c];

    core.trackAssociations(frags, a.id, [b.id, c.id]);

    assert.ok(a.associatedWith.includes(b.id));
    assert.ok(a.associatedWith.includes(c.id));
    assert.ok(b.associatedWith.includes(a.id));
    assert.ok(c.associatedWith.includes(a.id));
    assert.equal(b.associatedWith.length, 1);
    assert.equal(c.associatedWith.length, 1);
  });

  test("associations persist through save/load cycle", () => {
    const a = core.createFragment("alpha", "ai");
    const b = core.createFragment("beta", "ai");
    const frags: MemoryFragment[] = [a, b];

    core.trackAssociations(frags, a.id, [b.id]);
    core.saveMemory(frags);
    const loaded = core.loadMemory();

    const loadedA = loaded.find(f => f.id === a.id);
    const loadedB = loaded.find(f => f.id === b.id);
    assert.ok(loadedA);
    assert.ok(loadedB);
    assert.ok(loadedA!.associatedWith.includes(b.id));
    assert.ok(loadedB!.associatedWith.includes(a.id));
  });
});
