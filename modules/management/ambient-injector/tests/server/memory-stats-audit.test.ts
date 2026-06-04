import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as handlers from "../../src/server/handlers.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-test-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedFragments(): MemoryFragment[] {
  const frags = [
    core.createFragment("global knowledge", "ai", "Global", null),
    core.createFragment("project info alpha", "ai", "Alpha", "Alpha"),
    core.createFragment("project info beta", "user", "Beta", "Beta"),
  ];
  frags[1].confidence = 0.9;
  frags[2].confidence = 0.4;
  core.saveMemory(frags);
  return frags;
}

describe("handleMemoryStats", () => {
  test("returns fragment count", async () => {
    seedFragments();
    const result = await handlers.handleMemoryStats({});
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Total: 3"));
  });

  test("returns average confidence", async () => {
    seedFragments();
    const result = await handlers.handleMemoryStats({});
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes("Avg confidence"));
  });

  test("returns project breakdown", async () => {
    seedFragments();
    const result = await handlers.handleMemoryStats({});
    const text = result.content[0].text;
    assert.ok(text.includes("Alpha"));
    assert.ok(text.includes("Beta"));
    assert.ok(text.includes("global"));
  });

  test("returns empty state when no fragments", async () => {
    const result = await handlers.handleMemoryStats({});
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Total: 0"));
  });
});

describe("handleMemoryAudit", () => {
  test("returns clean report when no issues", async () => {
    seedFragments();
    const result = await handlers.handleMemoryAudit({});
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("no issues found") || result.content[0].text.includes("Issues: 0"));
  });

  test("detects orphan references", async () => {
    const frag = core.createFragment("test with orphan", "ai", "Orphan", null);
    frag.associatedWith = ["m_nonexistent_123"];
    core.saveMemory([frag]);

    const result = await handlers.handleMemoryAudit({});
    const text = result.content[0].text;
    assert.ok(
      text.includes("non-existent") || text.includes("orphan") || text.includes("Issues:"),
      `Expected orphan detection in: ${text}`
    );
  });

  test("detects duplicate IDs", async () => {
    const frag1 = core.createFragment("first", "ai", "First", null);
    const frag2: MemoryFragment = { ...frag1, fragment: "duplicate" };
    core.saveMemory([frag1, frag2]);

    const result = await handlers.handleMemoryAudit({});
    const text = result.content[0].text;
    assert.ok(
      text.includes("Duplicate") || text.includes("Issues:"),
      `Expected duplicate detection in: ${text}`
    );
  });

  test("detects confidence anomalies", async () => {
    const frag = core.createFragment("anomaly", "ai", "Bad", null);
    frag.confidence = 5.0;
    const result = core.auditMemory([frag]);
    const text = core.formatAuditReport(result);
    assert.ok(
      text.includes("invalid confidence") || text.includes("Issues:"),
      `Expected confidence anomaly detection in: ${text}`
    );
  });
});
