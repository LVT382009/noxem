import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { Guide } from "../../src/types.js";
import * as guides from "../../src/guides/index.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-detail-fmt-"));
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function makeGuide(overrides: Partial<Guide> = {}): Guide {
  return {
    id: "g1234",
    guide: "react",
    category: "web-frontend",
    description: "",
    usage_count: 5,
    last_used: "2026-04-19",
    contexts: [],
    learnings: [],
    success_count: 0,
    failure_count: 0,
    anti_patterns: [],
    known_pitfalls: [],
    last_refined: null,
    depends_on: [],
    enables: [],
    superseded_by: null,
    deprecated: false,
    auto_usage_count: 0,
    source_memories: [],
    validated_by: [],
    ...overrides,
  };
}

describe("formatGuideDetail", () => {
  test("formats basic guide with name, category, usage_count, last_used", () => {
    const g: Guide = makeGuide();
    const out: string = guides.formatGuideDetail(g);
    assert.ok(out.includes("=== GUIDE: react ==="));
    assert.ok(out.includes("Category: web-frontend"));
    assert.ok(out.includes("Usage Count: 5"));
    assert.ok(out.includes("Last Used: 2026-04-19"));
  });

  test("includes description section when present", () => {
    const g: Guide = makeGuide({ description: "React patterns guide" });
    const out: string = guides.formatGuideDetail(g);
    assert.ok(out.includes("=== DESCRIPTION / PROTOCOLS ==="));
    assert.ok(out.includes("React patterns guide"));
  });

  test("omits description section when empty", () => {
    const g: Guide = makeGuide({ description: "" });
    const out: string = guides.formatGuideDetail(g);
    assert.ok(!out.includes("=== DESCRIPTION / PROTOCOLS ==="));
  });

  test("includes contexts list", () => {
    const g: Guide = makeGuide({ contexts: ["hooks", "state"] });
    const out: string = guides.formatGuideDetail(g);
    assert.ok(out.includes("Contexts: hooks, state"));
  });

  test("includes learnings list", () => {
    const g: Guide = makeGuide({ learnings: ["useCallback prevents re-renders", "useMemo for expensive ops"] });
    const out: string = guides.formatGuideDetail(g);
    assert.ok(out.includes("Learnings:"));
    assert.ok(out.includes("  - useCallback prevents re-renders"));
    assert.ok(out.includes("  - useMemo for expensive ops"));
  });

  test("includes success rate when totalAttempts > 0", () => {
    const g: Guide = makeGuide({ success_count: 3, failure_count: 1 });
    const out: string = guides.formatGuideDetail(g);
    assert.ok(out.includes("Success Rate: 0.75 (3/4)"));
  });

  test("omits success rate when no attempts", () => {
    const g: Guide = makeGuide({ success_count: 0, failure_count: 0 });
    const out: string = guides.formatGuideDetail(g);
    assert.ok(!out.includes("Success Rate"));
  });

  test("includes anti_patterns, known_pitfalls, depends_on, superseded_by, deprecated when present", () => {
    const g: Guide = makeGuide({
      anti_patterns: ["prop drilling"],
      known_pitfalls: ["stale closures"],
      depends_on: ["javascript"],
      superseded_by: "react-19",
      deprecated: true,
    });
    const out: string = guides.formatGuideDetail(g);
    assert.ok(out.includes("Anti-patterns:"));
    assert.ok(out.includes("  - prop drilling"));
    assert.ok(out.includes("Known Pitfalls:"));
    assert.ok(out.includes("  - stale closures"));
    assert.ok(out.includes("Depends on: javascript"));
    assert.ok(out.includes("Superseded by: react-19"));
  });

  test("omits all optional sections when not present", () => {
    const g: Guide = makeGuide();
    const out: string = guides.formatGuideDetail(g);
    assert.ok(!out.includes("DESCRIPTION / PROTOCOLS"));
    assert.ok(!out.includes("Contexts:"));
    assert.ok(!out.includes("Learnings:"));
    assert.ok(!out.includes("Success Rate"));
    assert.ok(!out.includes("Anti-patterns"));
    assert.ok(!out.includes("Known Pitfalls"));
    assert.ok(!out.includes("Depends on:"));
    assert.ok(!out.includes("Superseded by:"));
  });
});

describe("getGuidesByCategory", () => {
  test("returns only guides matching category", () => {
    const gs: Guide[] = [
      makeGuide({ guide: "react", category: "web-frontend" }),
      makeGuide({ guide: "docker", category: "infra-devops" }),
      makeGuide({ guide: "vue", category: "web-frontend" }),
    ];
    const result: Guide[] = guides.getGuidesByCategory(gs, "web-frontend");
    assert.equal(result.length, 2);
    assert.ok(result.every((g: Guide) => g.category === "web-frontend"));
  });

  test("returns empty array for non-existent category", () => {
    const gs: Guide[] = [makeGuide({ category: "web-frontend" })];
    const result: Guide[] = guides.getGuidesByCategory(gs, "mobile-frontend");
    assert.equal(result.length, 0);
  });

  test("is case-insensitive", () => {
    const gs: Guide[] = [makeGuide({ category: "web-frontend" })];
    const result: Guide[] = guides.getGuidesByCategory(gs, "WEB-FRONTEND");
    assert.equal(result.length, 1);
  });
});

describe("getTopGuides", () => {
  test("returns guides sorted by usage_count descending", () => {
    const gs: Guide[] = [
      makeGuide({ guide: "low", usage_count: 2 }),
      makeGuide({ guide: "high", usage_count: 20 }),
      makeGuide({ guide: "mid", usage_count: 10 }),
    ];
    const result: Guide[] = guides.getTopGuides(gs);
    assert.equal(result[0].guide, "high");
    assert.equal(result[1].guide, "mid");
    assert.equal(result[2].guide, "low");
  });

  test("respects limit parameter", () => {
    const gs: Guide[] = [
      makeGuide({ guide: "a", usage_count: 5 }),
      makeGuide({ guide: "b", usage_count: 4 }),
      makeGuide({ guide: "c", usage_count: 3 }),
    ];
    const result: Guide[] = guides.getTopGuides(gs, 2);
    assert.equal(result.length, 2);
  });

  test("returns all guides when limit exceeds count", () => {
    const gs: Guide[] = [
      makeGuide({ guide: "a", usage_count: 1 }),
      makeGuide({ guide: "b", usage_count: 2 }),
    ];
    const result: Guide[] = guides.getTopGuides(gs, 100);
    assert.equal(result.length, 2);
  });
});
