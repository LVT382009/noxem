import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleMemoryRead } from "../../src/server/handlers.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-mhook-"));
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

function seedFragments(texts: string[]): MemoryFragment[] {
  const frags = texts.map(t => core.createFragment(t, "ai", null, null));
  core.saveMemory(frags);
  return frags;
}

describe("memory_read response hooks", () => {
  test("includes Auto-linked when search returns multiple fragments", async () => {
    seedFragments([
      "React hooks useState pattern for local state",
      "React hooks useEffect cleanup on unmount",
      "React hooks useRef for mutable references",
    ]);
    const result = await handleMemoryRead({ query: "React hooks" });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Auto-linked"));
  });

  test("does NOT include SUGGESTED ACTIONS when single fragment returned by ID", async () => {
    const [frag] = seedFragments(["A single unique fragment about quantum computing"]);
    const result = await handleMemoryRead({ id: frag.id });
    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });

  test("does NOT include SUGGESTED ACTIONS when multiple fragments read via batch ids", async () => {
    const frags = seedFragments([
      "First fragment about alpha particle physics",
      "Second fragment about beta decay processes",
    ]);
    const result = await handleMemoryRead({ ids: [frags[0].id, frags[1].id] });
    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });

  test("populates associatedWith after reading multiple fragments via search", async () => {
    seedFragments([
      "React component lifecycle methods overview",
      "React component mounting and unmounting phases",
      "React component rendering optimization techniques",
    ]);
    await handleMemoryRead({ query: "React component" });
    const loaded = core.loadMemory();
    const withAssoc = loaded.filter(f => f.associatedWith.length > 0);
    assert.ok(withAssoc.length >= 2);
  });
});
