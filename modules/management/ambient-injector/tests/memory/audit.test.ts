import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import type { MemoryFragment, AuditResult } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-audit-"));
  core.setMemoryDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("auditMemory — orphan references", () => {
  test("detects orphan association reference", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("A", "ai"),
      core.createFragment("B", "ai"),
    ];
    frags[0].associatedWith = ["nonexistent_id"];

    const result: AuditResult = core.auditMemory(frags);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(i => i.includes("nonexistent_id")));
  });

  test("no issues when associations are valid", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("A", "ai"),
      core.createFragment("B", "ai"),
    ];
    frags[0].associatedWith = [frags[1].id];
    frags[1].associatedWith = [frags[0].id];

    const result: AuditResult = core.auditMemory(frags);
    assert.equal(result.issues_found, 0);
  });
});

describe("auditMemory — duplicate IDs", () => {
  test("detects duplicate IDs across fragments", () => {
    const f1: MemoryFragment = core.createFragment("first", "ai");
    const f2: MemoryFragment = core.createFragment("second", "ai");
    f2.id = f1.id;

    const result: AuditResult = core.auditMemory([f1, f2]);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(i => i.includes("Duplicate IDs")));
  });

  test("no duplicate issue when all IDs are unique", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("a", "ai"),
      core.createFragment("b", "ai"),
      core.createFragment("c", "ai"),
    ];
    const result: AuditResult = core.auditMemory(frags);
    assert.ok(!result.issues.some(i => i.includes("Duplicate")));
  });
});

describe("auditMemory — confidence anomalies", () => {
  test("detects confidence above 1.0", () => {
    const f: MemoryFragment = core.createFragment("test", "ai");
    f.confidence = 1.5;
    const result: AuditResult = core.auditMemory([f]);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(i => i.includes("invalid confidence")));
  });

  test("detects negative confidence", () => {
    const f: MemoryFragment = core.createFragment("test", "ai");
    f.confidence = -0.5;
    const result: AuditResult = core.auditMemory([f]);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(i => i.includes("invalid confidence")));
  });

  test("detects non-numeric confidence", () => {
    const f: MemoryFragment = core.createFragment("test", "ai");
    (f as any).confidence = "high";
    const result: AuditResult = core.auditMemory([f]);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(i => i.includes("invalid confidence")));
  });

  test("no issues with valid confidence 0 to 1", () => {
    const frags: MemoryFragment[] = [
      { ...core.createFragment("a", "ai"), confidence: 0 },
      { ...core.createFragment("b", "ai"), confidence: 0.5 },
      { ...core.createFragment("c", "ai"), confidence: 1.0 },
    ];
    const result: AuditResult = core.auditMemory(frags);
    assert.ok(!result.issues.some(i => i.includes("confidence")));
  });
});

describe("auditMemory — missing required fields", () => {
  test("detects missing fragment text", () => {
    const f: MemoryFragment = core.createFragment("temp", "ai");
    delete (f as any).fragment;
    const result: AuditResult = core.auditMemory([f]);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(i => i.includes("missing or invalid fragment text")));
  });

  test("detects empty string fragment text", () => {
    const f: MemoryFragment = core.createFragment("temp", "ai");
    f.fragment = "";
    const result: AuditResult = core.auditMemory([f]);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(i => i.includes("missing or invalid fragment text")));
  });

  test("detects non-string fragment text", () => {
    const f: MemoryFragment = core.createFragment("temp", "ai");
    (f as any).fragment = 42;
    const result: AuditResult = core.auditMemory([f]);
    assert.equal(result.healthy, false);
    assert.ok(result.issues.some(i => i.includes("missing or invalid fragment text")));
  });
});

describe("auditMemory — clean report", () => {
  test("returns healthy report with no issues", () => {
    const frags: MemoryFragment[] = [
      core.createFragment("valid a", "ai"),
      core.createFragment("valid b", "user"),
    ];
    const result: AuditResult = core.auditMemory(frags);
    assert.equal(result.total_fragments, 2);
    assert.equal(result.issues_found, 0);
    assert.equal(result.issues.length, 0);
    assert.equal(result.healthy, true);
  });

  test("empty array returns healthy", () => {
    const result: AuditResult = core.auditMemory([]);
    assert.equal(result.total_fragments, 0);
    assert.equal(result.healthy, true);
  });
});

describe("formatAuditReport", () => {
  test("formats clean report", () => {
    const result: AuditResult = { total_fragments: 5, issues_found: 0, issues: [], healthy: true };
    const output: string = core.formatAuditReport(result);
    assert.ok(output.includes("Memory Audit"));
    assert.ok(output.includes("Total fragments: 5"));
    assert.ok(output.includes("Issues: 0"));
    assert.ok(output.includes("All clear"));
  });

  test("formats report with issues", () => {
    const result: AuditResult = {
      total_fragments: 3,
      issues_found: 2,
      issues: ["Fragment [m1] has invalid confidence: 1.5", "Duplicate IDs found: m1"],
      healthy: false,
    };
    const output: string = core.formatAuditReport(result);
    assert.ok(output.includes("Issues: 2"));
    assert.ok(output.includes("! Fragment [m1] has invalid confidence: 1.5"));
    assert.ok(output.includes("! Duplicate IDs found: m1"));
    assert.ok(!output.includes("All clear"));
  });

  test("formats empty memory report", () => {
    const result: AuditResult = { total_fragments: 0, issues_found: 0, issues: [], healthy: true };
    const output: string = core.formatAuditReport(result);
    assert.ok(output.includes("Total fragments: 0"));
    assert.ok(output.includes("All clear"));
  });
});
