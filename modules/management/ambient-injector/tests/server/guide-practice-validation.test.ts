import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleGuidePractice } from "../../src/server/handlers.js";
import type { Guide } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-gbidir-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  sessions.setSessionsDir(TMPDIR);
  setNotifyChange(() => {});
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  sessions.setSessionsDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedGuide(name: string, category: string, overrides: Record<string, unknown> = {}): Guide {
  const g = guides.createGuide(name, category, "Test guide");
  const merged = { ...g, ...overrides };
  const all = [merged];
  guides.saveGuides(all);
  return merged as Guide;
}

describe("guide_practice session-based validation", () => {
  test("no crash when practicing without active session", async () => {
    const result = await handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      contexts: ["hooks"],
      learnings: ["useCallback prevents re-renders"],
    });

    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("react"));
    assert.ok(result.content[0].text.includes("1x usage"));
  });

  test("response format is correct with usage count and learnings", async () => {
    const result = await handleGuidePractice({
      guide: "typescript",
      category: "language",
      contexts: ["types", "generics"],
      learnings: ["strict mode catches more errors"],
    });

    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes("typescript"));
    assert.ok(text.includes("1x usage"));
    assert.ok(text.includes("1 learnings"));
    assert.ok(text.includes("2 contexts"));
  });

  test("response includes low success rate warning when guide has <40% success", async () => {
    seedGuide("failing-guide", "dev-tool", {
      usage_count: 5,
      success_count: 1,
      failure_count: 3,
    });

    const result = await handleGuidePractice({
      guide: "failing-guide",
      category: "dev-tool",
      learnings: ["something new"],
    });

    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(
      text.includes("success rate") || text.includes("guide_update"),
      `Expected success rate warning but got: ${text}`
    );
  });

  test("response does NOT include SUGGESTED ACTIONS for fresh guide with good success", async () => {
    const result = await handleGuidePractice({
      guide: "fresh-guide",
      category: "web-frontend",
      contexts: ["components"],
      learnings: ["keep components small"],
    });

    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });
});
