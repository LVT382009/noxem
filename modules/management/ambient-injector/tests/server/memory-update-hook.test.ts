import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleMemoryUpdate } from "../../src/server/handlers.js";
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

function seedFragment(text: string): MemoryFragment {
  const frags = [core.createFragment(text, "ai", null, null)];
  core.saveMemory(frags);
  return frags[0];
}

describe("memory_update response hooks", () => {
  test("includes orphan cleanup message when fragment content is updated", async () => {
    const frag = seedFragment("Original content about something important");
    const result = await handleMemoryUpdate({
      id: frag.id,
      fragment: "Updated content about something different and new",
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Orphan relations cleaned up"));
  });

  test("does NOT include SUGGESTED ACTIONS when only title is updated", async () => {
    const frag = seedFragment("Some content that stays the same throughout");
    const result = await handleMemoryUpdate({
      id: frag.id,
      title: "New Title Only",
    });
    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });

  test("does NOT include SUGGESTED ACTIONS when only confidence is updated", async () => {
    const frag = seedFragment("Another piece of content unchanged here");
    const result = await handleMemoryUpdate({
      id: frag.id,
      confidence: 0.5,
    });
    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });
});
