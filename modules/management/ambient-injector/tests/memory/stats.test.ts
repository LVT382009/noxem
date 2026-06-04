import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import type { MemoryFragment, MemoryStats } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-stats-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("calculateStats — fragment count", () => {
  test("returns correct total count", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("a", "ai"),
      core.createFragment("b", "user"),
      core.createFragment("c", "ai"),
    ];
    const stats: MemoryStats = core.calculateStats(frags);
    assert.equal(stats.total, 3);
  });

  test("counts only filtered project fragments when project given", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("global a", "ai", "GA", null),
      core.createFragment("proj b", "ai", "PB", "myproj"),
      core.createFragment("proj c", "ai", "PC", "myproj"),
      core.createFragment("other d", "ai", "OD", "otherproj"),
    ];
    const stats: MemoryStats = core.calculateStats(frags, "myproj");
    assert.equal(stats.total, 3);
  });
});

describe("calculateStats — average confidence", () => {
  test("returns correct average confidence", () => {
    const frags: MemoryFragment[] = [
      { ...core.createFragment("a", "ai"), confidence: 0.5 },
      { ...core.createFragment("b", "ai"), confidence: 1.0 },
    ];
    const stats: MemoryStats = core.calculateStats(frags);
    assert.equal(stats.avg_confidence, 0.75);
  });

  test("rounds to 2 decimal places", () => {
    const frags: MemoryFragment[] = [
      { ...core.createFragment("a", "ai"), confidence: 0.33 },
      { ...core.createFragment("b", "ai"), confidence: 0.66 },
      { ...core.createFragment("c", "ai"), confidence: 1.0 },
    ];
    const stats: MemoryStats = core.calculateStats(frags);
    assert.equal(stats.avg_confidence, 0.66);
  });
});

describe("calculateStats — project breakdown", () => {
  test("returns correct counts per project", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("g1", "ai", "G1", null),
      core.createFragment("g2", "ai", "G2", null),
      core.createFragment("p1", "ai", "P1", "alpha"),
      core.createFragment("p2", "ai", "P2", "beta"),
      core.createFragment("p3", "ai", "P3", "alpha"),
    ];
    const stats: MemoryStats = core.calculateStats(frags);
    assert.equal(stats.by_project["global"], 2);
    assert.equal(stats.by_project["alpha"], 2);
    assert.equal(stats.by_project["beta"], 1);
  });

  test("returns correct source breakdown", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("a", "ai"),
      core.createFragment("b", "user"),
      core.createFragment("c", "ai"),
    ];
    const stats: MemoryStats = core.calculateStats(frags);
    assert.equal(stats.by_source["ai"], 2);
    assert.equal(stats.by_source["user"], 1);
  });
});

describe("calculateStats — confidence thresholds", () => {
  test("counts high confidence fragments (>0.8)", () => {
    const frags: MemoryFragment[] = [
      { ...core.createFragment("a", "ai"), confidence: 0.9 },
      { ...core.createFragment("b", "ai"), confidence: 1.0 },
      { ...core.createFragment("c", "ai"), confidence: 0.5 },
    ];
    const stats: MemoryStats = core.calculateStats(frags);
    assert.equal(stats.high_confidence, 2);
  });

  test("counts low confidence fragments (<0.3)", () => {
    const frags: MemoryFragment[] = [
      { ...core.createFragment("a", "ai"), confidence: 0.1 },
      { ...core.createFragment("b", "ai"), confidence: 0.2 },
      { ...core.createFragment("c", "ai"), confidence: 0.6 },
    ];
    const stats: MemoryStats = core.calculateStats(frags);
    assert.equal(stats.low_confidence, 2);
  });

  test("boundary values: 0.8 is NOT high, 0.3 is NOT low", () => {
    const frags: MemoryFragment[] = [
      { ...core.createFragment("a", "ai"), confidence: 0.8 },
      { ...core.createFragment("b", "ai"), confidence: 0.3 },
    ];
    const stats: MemoryStats = core.calculateStats(frags);
    assert.equal(stats.high_confidence, 0);
    assert.equal(stats.low_confidence, 0);
  });
});

describe("calculateStats — empty memory", () => {
  test("returns zeroed stats for empty array", () => {
    const stats: MemoryStats = core.calculateStats([]);
    assert.equal(stats.total, 0);
    assert.equal(stats.avg_confidence, 0);
    assert.equal(stats.low_confidence, 0);
    assert.equal(stats.high_confidence, 0);
    assert.deepEqual(stats.by_source, {});
    assert.deepEqual(stats.by_project, {});
  });
});

describe("formatStats", () => {
  test("formats stats with fragments", () => {
    const stats: MemoryStats = {
      total: 10,
      avg_confidence: 0.75,
      by_source: { ai: 7, user: 3 },
      by_project: { global: 4, myproj: 6 },
      low_confidence: 1,
      high_confidence: 8,
    };
    const output: string = core.formatStats(stats);
    assert.ok(output.includes("Memory Stats"));
    assert.ok(output.includes("Total: 10 fragments"));
    assert.ok(output.includes("Avg confidence: 0.75"));
    assert.ok(output.includes("High confidence (>0.8): 8"));
    assert.ok(output.includes("Low (<0.3): 1"));
    assert.ok(output.includes("ai: 7"));
    assert.ok(output.includes("user: 3"));
    assert.ok(output.includes("global: 4"));
    assert.ok(output.includes("myproj: 6"));
  });

  test("formats stats for empty memory", () => {
    const stats: MemoryStats = {
      total: 0,
      avg_confidence: 0,
      by_source: {},
      by_project: {},
      low_confidence: 0,
      high_confidence: 0,
    };
    const output: string = core.formatStats(stats);
    assert.ok(output.includes("Total: 0 fragments"));
    assert.ok(!output.includes("High confidence"));
  });
});
