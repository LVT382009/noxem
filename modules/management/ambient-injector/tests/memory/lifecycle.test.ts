import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as handlers from "../../src/server/handlers.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-lifecycle-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedMemory(): MemoryFragment {
  const frags: MemoryFragment[] = [core.createFragment("react hooks pattern", "ai", "React Hooks", "testproj")];
  core.saveMemory(frags);
  return frags[0];
}

describe("Learning System Lifecycle", () => {
  test("fragment gains strength through repeated use", () => {
    let frag: MemoryFragment = { ...core.createFragment("useful pattern", "ai"), confidence: 0.5, accessed: 0 };

    let boosted: MemoryFragment = core.boostOnAccess(frag, "debugging");
    boosted = core.boostOnAccess(boosted, "refactoring");
    boosted = core.boostOnAccess(boosted, "debugging");

    assert.ok(Math.abs(boosted.confidence - (0.5 + 0.015 * 3)) < 0.001);
    assert.deepEqual(boosted.tags, ["debugging", "refactoring"]);
    assert.equal(boosted.accessed, 3);
  });

  test("negative feedback does not affect decay rate", () => {
    const good: MemoryFragment = { ...core.createFragment("good", "ai"), confidence: 0.8, accessed: 0, negativeHits: 0 };
    const bad: MemoryFragment = { ...core.createFragment("bad", "ai"), confidence: 0.8, accessed: 0, negativeHits: 3 };

    const [decayedGood]: MemoryFragment[] = core.decayConfidence([good]);
    const [decayedBad]: MemoryFragment[] = core.decayConfidence([bad]);

    assert.equal(decayedGood.confidence, decayedBad.confidence,
      "negativeHits should not affect decay rate");
  });

  test("boost + decay equilibrium: frequent use sustains confidence", () => {
    let frag: MemoryFragment = { ...core.createFragment("popular", "ai"), confidence: 1.0, accessed: 0 };

    for (let i = 0; i < 10; i++) {
      frag = core.boostOnAccess(frag, "daily-use");
      frag = core.decayConfidence([frag])[0];
    }

    assert.ok(frag.confidence >= 0.99,
      `Frequently used fragment should stay strong (shield), got ${frag.confidence}`);
    assert.deepEqual(frag.tags, ["daily-use"]);
  });

  test("unused fragment decays slowly", () => {
    let frag: MemoryFragment = { ...core.createFragment("forgotten", "ai"), confidence: 1.0, accessed: 0 };

    for (let i = 0; i < 30; i++) {
      frag = core.decayConfidence([frag])[0];
    }

    assert.ok(frag.confidence < 0.95,
      `Unused fragment should decay slowly, got ${frag.confidence}`);
    assert.ok(frag.confidence > 0.9,
      `Decay rate should be slow (0.002/session), got ${frag.confidence}`);
  });

  test("associations track co-accessed fragments", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("error handling", "ai"),
      core.createFragment("try-catch pattern", "ai"),
      core.createFragment("logging", "ai"),
    ];

    core.trackAssociations(frags, frags[0].id, [frags[1].id, frags[2].id]);
    core.trackAssociations(frags, frags[1].id, [frags[0].id, frags[2].id]);

    assert.ok(frags[0].associatedWith.length >= 2);
    assert.ok(frags[1].associatedWith.length >= 2);
    assert.ok(frags[2].associatedWith.includes(frags[0].id));
  });

  test("full lifecycle: add → read (boost) → feedback → decay", async () => {
    seedMemory();
    let loaded: MemoryFragment[] = core.loadMemory();
    const fragId: string = loaded[0].id;

    await handlers.handleMemoryRead({ id: fragId, context: "bugfix" });

    loaded = core.loadMemory();
    let frag: MemoryFragment | undefined = loaded.find(f => f.id === fragId);
    assert.ok(frag!.tags.includes("bugfix"));

    await handlers.handleMemoryFeedback({ id: fragId, useful: true });

    loaded = core.loadMemory();
    frag = loaded.find(f => f.id === fragId);
    const decayed: MemoryFragment = core.decayConfidence([frag!])[0];

    assert.ok(decayed.confidence > 0.8,
      `Confidence should remain high after boost, got ${decayed.confidence}`);
  });
});
