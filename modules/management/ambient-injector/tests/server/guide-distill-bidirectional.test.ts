import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleGuideDistill } from "../../src/server/handlers.js";
import type { MemoryFragment } from "../../src/types.js";

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

function seedMemory(text: string, project: string | null = null): MemoryFragment {
  const frags = [core.createFragment(text, "ai", null, project)];
  core.saveMemory(frags);
  return frags[0];
}

describe("guide_distill bidirectional links", () => {
  test("after distill, guide.source_memories contains the memory ID", async () => {
    const frag = seedMemory("React hooks should use useCallback for memoization");
    await handleGuideDistill({ memory_id: frag.id, guide: "react" });

    const allGuides = guides.loadGuides();
    const g = allGuides.find(x => x.guide === "react");
    assert.ok(g);
    assert.ok(g.source_memories.includes(frag.id));
  });

  test("after distill, memory.related_guides contains the guide name", async () => {
    const frag = seedMemory("React hooks should use useCallback for memoization");
    await handleGuideDistill({ memory_id: frag.id, guide: "react" });

    const allMemory = core.loadMemory();
    const m = allMemory.find(f => f.id === frag.id);
    assert.ok(m);
    assert.ok(m.related_guides.includes("react"));
  });

  test("distilling same memory twice does not duplicate in source_memories", async () => {
    const frag = seedMemory("React hooks should use useCallback for memoization");
    await handleGuideDistill({ memory_id: frag.id, guide: "react" });
    await handleGuideDistill({ memory_id: frag.id, guide: "react" });

    const allGuides = guides.loadGuides();
    const g = allGuides.find(x => x.guide === "react");
    assert.ok(g);
    const count = g.source_memories.filter((id: string) => id === frag.id).length;
    assert.equal(count, 1);
  });

  test("distilling same memory twice does not duplicate in related_guides", async () => {
    const frag = seedMemory("React hooks should use useCallback for memoization");
    await handleGuideDistill({ memory_id: frag.id, guide: "react" });
    await handleGuideDistill({ memory_id: frag.id, guide: "react" });

    const allMemory = core.loadMemory();
    const m = allMemory.find(f => f.id === frag.id);
    assert.ok(m);
    const count = m.related_guides.filter((g: string) => g === "react").length;
    assert.equal(count, 1);
  });

  test("response confirms distillation with related memories present", async () => {
    const frag1 = core.createFragment("React hooks should use useCallback for memoization", "ai", null, null);
    const frag2 = core.createFragment("React useCallback memoization pattern for performance", "ai", null, null);
    core.saveMemory([frag1, frag2]);
    const result = await handleGuideDistill({ memory_id: frag1.id, guide: "react" });

    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("Successfully distilled"));
    assert.ok(result.content[0].text.includes(frag1.id));
  });

  test("response does NOT include SUGGESTED ACTIONS when no related memories", async () => {
    const frag = seedMemory("A completely unique observation about quantum entanglement in deep space");
    const result = await handleGuideDistill({ memory_id: frag.id, guide: "quantum" });

    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("SUGGESTED ACTIONS"));
  });
});
