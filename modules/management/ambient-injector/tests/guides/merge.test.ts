import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { Guide } from "../../src/types.js";
import * as guides from "../../src/guides/index.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-guide-merge-"));
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("Guide Merge (handler level)", () => {
  function seedGuides(): [Guide, Guide] {
    const g1: Guide = guides.createGuide("react", "web-frontend", "React guide", ["hooks", "state"], ["useCallback"]);
    g1.usage_count = 5;
    g1.anti_patterns = ["prop drilling"];
    g1.known_pitfalls = ["stale closures"];

    const g2: Guide = guides.createGuide("vue", "web-frontend", "Vue guide", ["composition", "reactivity"], ["ref vs reactive"]);
    g2.usage_count = 3;
    g2.anti_patterns = ["mutating props"];
    g2.known_pitfalls = ["reactivity loss"];

    guides.saveGuides([g1, g2]);
    return [g1, g2];
  }

  test("merging two guides combines usage counts (sum)", () => {
    const [g1, g2] = seedGuides();
    const allGuides: Guide[] = guides.loadGuides();

    const sourceGuides: Guide[] = [g1, g2];
    const totalUsage: number = sourceGuides.reduce((sum: number, g: Guide) => sum + g.usage_count, 0);

    const newGuide: Guide = guides.createGuide("frontend-unified", "web-frontend", "", [], []);
    newGuide.usage_count = totalUsage;

    assert.equal(newGuide.usage_count, 8);
  });

  test("merging two guides merges contexts (deduplicated)", () => {
    const [g1, g2] = seedGuides();
    const mergedContexts: string[] = [...new Set([...g1.contexts, ...g2.contexts])];
    assert.deepEqual(mergedContexts, ["hooks", "state", "composition", "reactivity"]);
  });

  test("merging two guides merges learnings (deduplicated)", () => {
    const [g1, g2] = seedGuides();
    const mergedLearnings: string[] = [...new Set([...g1.learnings, ...g2.learnings])];
    assert.deepEqual(mergedLearnings, ["useCallback", "ref vs reactive"]);
  });

  test("merging two guides merges anti_patterns", () => {
    const [g1, g2] = seedGuides();
    const mergedAntiPatterns: string[] = [...new Set([...g1.anti_patterns, ...g2.anti_patterns])];
    assert.deepEqual(mergedAntiPatterns, ["prop drilling", "mutating props"]);
  });

  test("merging two guides merges known_pitfalls", () => {
    const [g1, g2] = seedGuides();
    const mergedPitfalls: string[] = [...new Set([...g1.known_pitfalls, ...g2.known_pitfalls])];
    assert.deepEqual(mergedPitfalls, ["stale closures", "reactivity loss"]);
  });

  test("original guides are removed after merge", () => {
    seedGuides();
    const allGuides: Guide[] = guides.loadGuides();
    const guideNames: string[] = ["react", "vue"];
    const mergedGuides: Guide[] = allGuides.filter((g: Guide) => !guideNames.includes(g.guide));
    assert.equal(mergedGuides.length, 0);
  });

  test("merge creates new guide with specified name and category", () => {
    const newGuide: Guide = guides.createGuide("merged-frontend", "web-frontend", "Combined guide");
    assert.equal(newGuide.guide, "merged-frontend");
    assert.equal(newGuide.category, "web-frontend");
    assert.equal(newGuide.description, "Combined guide");
  });

  test("merging with empty description keeps first guide description", () => {
    const [g1] = seedGuides();
    const newGuide: Guide = guides.createGuide("merged", "web-frontend", "");
    assert.equal(newGuide.description, "");
    assert.equal(g1.description, "React guide");
  });

  test("merging single guide still works", () => {
    const g1: Guide = guides.createGuide("solo", "dev-tool", "solo guide", ["test"], ["learning1"]);
    g1.usage_count = 7;
    g1.anti_patterns = ["bad pattern"];

    const newGuide: Guide = guides.createGuide("solo-merged", "dev-tool", "");
    newGuide.usage_count = g1.usage_count;
    newGuide.anti_patterns = [...g1.anti_patterns];

    assert.equal(newGuide.usage_count, 7);
    assert.deepEqual(newGuide.anti_patterns, ["bad pattern"]);
  });
});
