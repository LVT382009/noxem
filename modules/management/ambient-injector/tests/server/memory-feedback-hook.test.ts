import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleMemoryFeedback } from "../../src/server/handlers.js";
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

describe("memory_feedback response hooks", () => {
  test("positive feedback records confidence boost", async () => {
    const frag = seedFragment("A useful programming tip about caching strategies");
    const result = await handleMemoryFeedback({
      id: frag.id,
      useful: true,
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Confidence boosted"));
  });

  test("negative feedback records confidence reduction", async () => {
    const frag = seedFragment("An outdated piece of information about old technology");
    const result = await handleMemoryFeedback({
      id: frag.id,
      useful: false,
    });
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Confidence reduced"));
  });
});
