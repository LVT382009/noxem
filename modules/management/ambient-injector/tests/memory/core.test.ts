import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-core-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("Memory Core", () => {
  describe("createFragment", () => {
    test("creates a fragment with all required fields", () => {
      const frag: MemoryFragment = core.createFragment("hello world", "ai", "Test", "myproj");
      assert.equal(frag.confidence, 1.0);
      assert.equal(frag.source, "ai");
      assert.equal(frag.project, "myproj");
      assert.equal(frag.title, "Test");
      assert.equal(frag.accessed, 0);
      assert.deepEqual(frag.tags, []);
      assert.deepEqual(frag.associatedWith, []);
      assert.equal(frag.negativeHits, 0);
      assert.ok(frag.id.startsWith("m"));
      assert.ok(frag.created);
      assert.ok(frag.lastAccessed);
    });

    test("auto-generates title when not provided", () => {
      const frag: MemoryFragment = core.createFragment("short text", "ai");
      assert.equal(frag.title, "short text");
    });

    test("truncates title for long fragments", () => {
      const long = "a".repeat(60);
      const frag: MemoryFragment = core.createFragment(long, "ai");
      assert.ok(frag.title.length <= 43);
    });

    test("creates global fragment when project is null", () => {
      const frag: MemoryFragment = core.createFragment("global info", "user", "Title", null);
      assert.equal(frag.project, null);
    });
  });

  describe("loadMemory / saveMemory", () => {
    test("returns empty array when no file exists", () => {
      assert.deepEqual(core.loadMemory(), []);
    });

    test("persists fragments to disk as JSONL", () => {
      const frags: MemoryFragment[] = [core.createFragment("test", "ai")];
      core.saveMemory(frags);
      const loaded: MemoryFragment[] = core.loadMemory();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].fragment, "test");
    });

    test("refuses to save empty array (safety check)", () => {
      const frags: MemoryFragment[] = [core.createFragment("seed", "ai")];
      core.saveMemory(frags);

      core.saveMemory([]);

      const loaded: MemoryFragment[] = core.loadMemory();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].fragment, "seed");
    });
  });

  describe("filterByProject", () => {
    test("filters by project scope (case-insensitive)", () => {
      const frags: MemoryFragment[] = [
        core.createFragment("global", "ai", "G", null),
        core.createFragment("proj-a", "ai", "A", "Alpha"),
        core.createFragment("proj-b", "ai", "B", "beta"),
      ];
      assert.equal(core.filterByProject(frags, "alpha").length, 2);
      assert.equal(core.filterByProject(frags, "ALPHA").length, 2);
      assert.equal(core.filterByProject(frags, null).length, 1);
    });

    test("treats empty string as null (global)", () => {
      const frags: MemoryFragment[] = [
        core.createFragment("g", "ai", "G", null),
        core.createFragment("p", "ai", "P", "proj"),
      ];
      assert.equal(core.filterByProject(frags, "").length, 1);
      assert.equal(core.filterByProject(frags, "   ").length, 1);
    });
  });

  describe("findSimilarFragment", () => {
    test("finds similar fragment above threshold", async () => {
      const frags: MemoryFragment[] = [core.createFragment("react hooks use state management patterns", "ai", "React", "proj")];
      core.saveMemory(frags);
      const match: MemoryFragment | null = await core.findSimilarFragment(frags, "react hooks use state patterns", "proj", 0.3);
      assert.ok(match);
      assert.equal(match!.title, "React");
    });

    test("returns null when no similar fragment exists", async () => {
      const frags: MemoryFragment[] = [core.createFragment("python asyncio", "ai", "Py", "proj")];
      const match: MemoryFragment | null = await core.findSimilarFragment(frags, "react components", "proj");
      assert.equal(match, null);
    });
  });

  describe("decayConfidence", () => {
    test("reduces confidence for unused fragments (accessed=0)", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), accessed: 0 };
      const [decayed]: MemoryFragment[] = core.decayConfidence([frag]);
      assert.ok(decayed.confidence < frag.confidence);
      assert.ok(Math.abs(decayed.confidence - (frag.confidence - 0.002)) < 0.001);
    });

    test("does not decay fragments with accessed > 0 (shield)", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), confidence: 0.8, accessed: 3 };
      const [decayed]: MemoryFragment[] = core.decayConfidence([frag]);
      assert.equal(decayed.confidence, 0.8, "accessed>0 fragments should not decay");
    });

    test("resets accessed counter after decay", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), accessed: 5 };
      const [decayed]: MemoryFragment[] = core.decayConfidence([frag]);
      assert.equal(decayed.accessed, 0);
    });

    test("never removes fragments, only reduces confidence", () => {
      const frags: MemoryFragment[] = [core.createFragment("a", "ai"), core.createFragment("b", "ai")];
      const decayed: MemoryFragment[] = core.decayConfidence(frags);
      assert.equal(decayed.length, 2);
    });

    test("confidence never goes below 0", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), confidence: 0.01, accessed: 0 };
      const [decayed]: MemoryFragment[] = core.decayConfidence([frag]);
      assert.ok(decayed.confidence >= 0);
    });

    test("negative hits do not affect decay rate", () => {
      const normal: MemoryFragment = { ...core.createFragment("normal", "ai"), accessed: 0, negativeHits: 0 };
      const hated: MemoryFragment = { ...core.createFragment("hated", "ai"), accessed: 0, negativeHits: 5 };

      const [decayedNormal]: MemoryFragment[] = core.decayConfidence([normal]);
      const [decayedHated]: MemoryFragment[] = core.decayConfidence([hated]);

      assert.equal(decayedNormal.confidence, decayedHated.confidence,
        "negativeHits should not affect decay rate");
    });

    test("resets negativeHits after decay", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), accessed: 0, negativeHits: 3 };
      const [decayed]: MemoryFragment[] = core.decayConfidence([frag]);
      assert.equal(decayed.negativeHits, 0);
    });
  });

  describe("boostOnAccess", () => {
    test("increases confidence by 0.015", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), confidence: 0.5 };
      const boosted: MemoryFragment = core.boostOnAccess(frag);
      assert.ok(Math.abs(boosted.confidence - 0.515) < 0.001);
    });

    test("never exceeds 1.0", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), confidence: 0.99 };
      const boosted: MemoryFragment = core.boostOnAccess(frag);
      assert.equal(boosted.confidence, 1.0);
    });

    test("adds context tag", () => {
      const frag: MemoryFragment = core.createFragment("test", "ai");
      const boosted: MemoryFragment = core.boostOnAccess(frag, "debugging");
      assert.deepEqual(boosted.tags, ["debugging"]);
    });

    test("does not duplicate tags", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), tags: ["debugging"] };
      const boosted: MemoryFragment = core.boostOnAccess(frag, "debugging");
      assert.deepEqual(boosted.tags, ["debugging"]);
    });

    test("normalizes tag to lowercase", () => {
      const frag: MemoryFragment = core.createFragment("test", "ai");
      const boosted: MemoryFragment = core.boostOnAccess(frag, "DEBUGGING");
      assert.deepEqual(boosted.tags, ["debugging"]);
    });

    test("increments accessed counter", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), accessed: 2 };
      const boosted: MemoryFragment = core.boostOnAccess(frag);
      assert.equal(boosted.accessed, 3);
    });

    test("works without context (no tag added)", () => {
      const frag: MemoryFragment = core.createFragment("test", "ai");
      const boosted: MemoryFragment = core.boostOnAccess(frag);
      assert.deepEqual(boosted.tags, []);
    });
  });

  describe("recordNegativeHit", () => {
    test("decreases confidence by 0.02", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), confidence: 0.8 };
      const penalized: MemoryFragment = core.recordNegativeHit(frag);
      assert.ok(Math.abs(penalized.confidence - 0.78) < 0.001);
    });

    test("never goes below 0", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), confidence: 0.01 };
      const penalized: MemoryFragment = core.recordNegativeHit(frag);
      assert.equal(penalized.confidence, 0);
    });

    test("increments negativeHits", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), negativeHits: 1 };
      const penalized: MemoryFragment = core.recordNegativeHit(frag);
      assert.equal(penalized.negativeHits, 2);
    });
  });

  describe("trackAssociations", () => {
    test("creates bidirectional associations", () => {
      const frags: MemoryFragment[] = [
        core.createFragment("a", "ai"),
        core.createFragment("b", "ai"),
      ];
      core.trackAssociations(frags, frags[0].id, [frags[1].id]);
      assert.ok(frags[0].associatedWith.includes(frags[1].id));
      assert.ok(frags[1].associatedWith.includes(frags[0].id));
    });

    test("does not associate with self", () => {
      const frag: MemoryFragment = core.createFragment("solo", "ai");
      core.trackAssociations([frag], frag.id, [frag.id]);
      assert.equal(frag.associatedWith.length, 0);
    });

    test("does not duplicate associations", () => {
      const frags: MemoryFragment[] = [
        core.createFragment("a", "ai"),
        core.createFragment("b", "ai"),
      ];
      core.trackAssociations(frags, frags[0].id, [frags[1].id]);
      core.trackAssociations(frags, frags[0].id, [frags[1].id]);
      assert.equal(frags[0].associatedWith.length, 1);
    });

    test("handles empty sessionIds gracefully", () => {
      const frag: MemoryFragment = core.createFragment("solo", "ai");
      core.trackAssociations([frag], frag.id, []);
      assert.equal(frag.associatedWith.length, 0);
    });

    test("handles non-existent IDs gracefully", () => {
      const frag: MemoryFragment = core.createFragment("solo", "ai");
      core.trackAssociations([frag], frag.id, ["nonexistent"]);
      assert.equal(frag.associatedWith.length, 1);
    });
  });

  describe("searchAndSortFragments", () => {
    test("sorts by confidence when no query", async () => {
      const frags: MemoryFragment[] = [
        { ...core.createFragment("low", "ai"), confidence: 0.3 },
        { ...core.createFragment("high", "ai"), confidence: 0.9 },
      ];
      const sorted: MemoryFragment[] = await core.searchAndSortFragments(frags, null, 10);
      assert.equal(sorted[0].confidence, 0.9);
    });

    test("respects topK limit", async () => {
      const frags: MemoryFragment[] = Array.from({ length: 50 }, (_, i) =>
        core.createFragment(`frag-${i}`, "ai")
      );
      const sorted: MemoryFragment[] = await core.searchAndSortFragments(frags, null, 10);
      assert.equal(sorted.length, 10);
    });

    test("fuzzy search returns relevant results", async () => {
      const frags: MemoryFragment[] = [
        core.createFragment("react component patterns", "ai"),
        core.createFragment("python data analysis", "ai"),
      ];
      const results: MemoryFragment[] = await core.searchAndSortFragments(frags, "react", 10);
      assert.ok(results.length >= 1);
      assert.ok(results[0].fragment.includes("react"));
    });

    test("updates lastAccessed on returned fragments", async () => {
      const frag: MemoryFragment = core.createFragment("test", "ai");
      const oldAccessed = frag.lastAccessed;
      const results: MemoryFragment[] = await core.searchAndSortFragments([frag], null, 10);
      assert.ok(results[0].lastAccessed >= oldAccessed);
    });
  });

  describe("formatMemoryForLLM", () => {
    test("shows empty state when no fragments", () => {
      const output: string = core.formatMemoryForLLM([]);
      assert.ok(output.includes("no fragments"));
    });

    test("shows title and description", () => {
      const frag: MemoryFragment = core.createFragment("test content", "ai", "My Title", null);
      const output: string = core.formatMemoryForLLM([frag]);
      assert.ok(output.includes("My Title"));
      assert.ok(output.includes("test content"));
    });

    test("shows project scope tag", () => {
      const frag: MemoryFragment = core.createFragment("test", "ai", "T", "myproj");
      const output: string = core.formatMemoryForLLM([frag]);
      assert.ok(output.includes("[myproj]"));
    });

    test("shows global scope when no project", () => {
      const frag: MemoryFragment = core.createFragment("test", "ai", "T", null);
      const output: string = core.formatMemoryForLLM([frag]);
      assert.ok(output.includes("[global]"));
    });
  });

  describe("formatMemoryDetail", () => {
    test("returns not-found message for null", () => {
      assert.equal(core.formatMemoryDetail(null), "Fragment not found.");
    });

    test("includes tags when present", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), tags: ["debugging", "react"] };
      const output: string = core.formatMemoryDetail(frag);
      assert.ok(output.includes("Tags: debugging, react"));
    });

    test("includes associations when present", () => {
      const frag: MemoryFragment = { ...core.createFragment("test", "ai"), associatedWith: ["mabc123"] };
      const output: string = core.formatMemoryDetail(frag);
      assert.ok(output.includes("Related: mabc123"));
    });

    test("omits tags line when empty", () => {
      const frag: MemoryFragment = core.createFragment("test", "ai");
      const output: string = core.formatMemoryDetail(frag);
      assert.ok(!output.includes("Tags:"));
    });
  });
});
