import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as handlers from "../../src/server/handlers.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-merge-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("handleMemoryMerge — validation", () => {
  test("returns error when ids has fewer than 2 elements", async () => {
    const result = await handlers.handleMemoryMerge({ ids: ["m123"], title: "T", fragment: "F" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("at least 2"));
  });

  test("returns error when title is missing", async () => {
    const f1 = core.createFragment("a", "ai", "A", null);
    const f2 = core.createFragment("b", "ai", "B", null);
    core.saveMemory([f1, f2]);

    const result = await handlers.handleMemoryMerge({ ids: [f1.id, f2.id], fragment: "merged" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("title"));
  });

  test("returns error when fragment is missing", async () => {
    const f1 = core.createFragment("a", "ai", "A", null);
    const f2 = core.createFragment("b", "ai", "B", null);
    core.saveMemory([f1, f2]);

    const result = await handlers.handleMemoryMerge({ ids: [f1.id, f2.id], title: "Merged" });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("fragment"));
  });

  test("handles partial not-found IDs gracefully", async () => {
    const f1 = core.createFragment("a", "ai", "A", null);
    core.saveMemory([f1]);

    const result = await handlers.handleMemoryMerge({
      ids: [f1.id, "m_nonexistent"],
      title: "Merged",
      fragment: "combined",
    });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes("not found"));
  });
});
