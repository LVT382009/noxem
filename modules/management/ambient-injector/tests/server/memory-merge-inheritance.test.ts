import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleMemoryMerge, handleMemoryRelate } from "../../src/server/handlers.js";
import type { MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-mrginh-"));
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

function seedFragment(text: string, overrides: Record<string, unknown> = {}): MemoryFragment {
  const frag = core.createFragment(text, "ai");
  const merged = { ...frag, ...overrides };
  return merged as MemoryFragment;
}

describe("handleMemoryMerge — relation and connection inheritance", () => {
  test("merged fragment inherits relations from source fragments", async () => {
    const m1 = seedFragment("fragment one");
    const m2 = seedFragment("fragment two");
    const m3 = seedFragment("fragment three");
    core.saveMemory([m1, m2, m3]);

    await handleMemoryRelate({ sourceId: m1.id, targetId: m3.id, type: "supports" });

    const result = await handleMemoryMerge({
      ids: [m1.id, m2.id],
      title: "Merged",
      fragment: "combined content",
    });

    assert.equal(result.isError, undefined);

    const memory = core.loadMemory();
    const merged = memory.find(f => f.id !== m3.id);
    assert.ok(merged);
    const hasRelation = merged.relations.some(r => r.id === m3.id && r.type === "supports");
    assert.equal(hasRelation, true);
  });

  test("merged fragment inherits related_guides from source fragments", async () => {
    const m1 = seedFragment("fragment one", { related_guides: ["react"] });
    const m2 = seedFragment("fragment two", { related_guides: ["typescript"] });
    core.saveMemory([m1, m2]);

    const result = await handleMemoryMerge({
      ids: [m1.id, m2.id],
      title: "Merged Guides",
      fragment: "combined",
    });

    assert.equal(result.isError, undefined);

    const memory = core.loadMemory();
    const merged = memory.find(f => f.title === "Merged Guides");
    assert.ok(merged);
    assert.deepEqual(merged.related_guides.sort(), ["react", "typescript"]);
  });

  test("other fragments' associatedWith updated from old IDs to new ID", async () => {
    const m1 = seedFragment("fragment one");
    const m2 = seedFragment("fragment two");
    const m3 = seedFragment("fragment three", { associatedWith: [m1.id] });
    core.saveMemory([m1, m2, m3]);

    const result = await handleMemoryMerge({
      ids: [m1.id, m2.id],
      title: "Merged Assoc",
      fragment: "combined",
    });

    assert.equal(result.isError, undefined);

    const memory = core.loadMemory();
    const m3Updated = memory.find(f => f.id === m3.id);
    assert.ok(m3Updated);

    const merged = memory.find(f => f.title === "Merged Assoc");
    assert.ok(merged);

    assert.ok(m3Updated.associatedWith.includes(merged.id), "m3.associatedWith should contain the new merged ID");
    assert.equal(m3Updated.associatedWith.includes(m1.id), false, "m3.associatedWith should not contain old m1 ID");
  });

  test("other fragments' relations updated from old IDs to new ID", async () => {
    const m1 = seedFragment("fragment one");
    const m2 = seedFragment("fragment two");
    const m3 = seedFragment("fragment three");
    core.saveMemory([m1, m2, m3]);

    await handleMemoryRelate({ sourceId: m3.id, targetId: m1.id, type: "supports" });

    const result = await handleMemoryMerge({
      ids: [m1.id, m2.id],
      title: "Merged Rel",
      fragment: "combined",
    });

    assert.equal(result.isError, undefined);

    const memory = core.loadMemory();
    const m3Updated = memory.find(f => f.id === m3.id);
    assert.ok(m3Updated);

    const merged = memory.find(f => f.title === "Merged Rel");
    assert.ok(merged);

    const relationToMerged = m3Updated.relations.some(r => r.id === merged.id);
    assert.equal(relationToMerged, true, "m3.relations should point to the new merged ID");

    const relationToOld = m3Updated.relations.some(r => r.id === m1.id);
    assert.equal(relationToOld, false, "m3.relations should not point to old m1 ID");
  });

  test("guide source_memories updated from old IDs to new ID", async () => {
    const m1 = seedFragment("fragment one");
    const m2 = seedFragment("fragment two");
    core.saveMemory([m1, m2]);

    const guide = guides.createGuide("test-guide", "dev-tool", "A test guide");
    guide.source_memories = [m1.id];
    guides.saveGuides([guide]);

    await handleMemoryMerge({
      ids: [m1.id, m2.id],
      title: "Merged Source",
      fragment: "combined",
    });

    const allGuides = guides.loadGuides();
    const updatedGuide = allGuides.find(g => g.guide === "test-guide");
    assert.ok(updatedGuide);

    const memory = core.loadMemory();
    const merged = memory.find(f => f.title === "Merged Source");
    assert.ok(merged);

    assert.ok(updatedGuide.source_memories.includes(merged.id), "guide.source_memories should contain the new merged ID");
    assert.equal(updatedGuide.source_memories.includes(m1.id), false, "guide.source_memories should not contain old m1 ID");
  });

  test("guide validated_by updated and deduplicated from old IDs to new ID", async () => {
    const m1 = seedFragment("fragment one");
    const m2 = seedFragment("fragment two");
    core.saveMemory([m1, m2]);

    const guide = guides.createGuide("validated-guide", "dev-tool", "A validated guide");
    guide.validated_by = [m1.id, m2.id];
    guides.saveGuides([guide]);

    await handleMemoryMerge({
      ids: [m1.id, m2.id],
      title: "Merged Valid",
      fragment: "combined",
    });

    const allGuides = guides.loadGuides();
    const updatedGuide = allGuides.find(g => g.guide === "validated-guide");
    assert.ok(updatedGuide);

    const memory = core.loadMemory();
    const merged = memory.find(f => f.title === "Merged Valid");
    assert.ok(merged);

    assert.deepEqual(updatedGuide.validated_by, [merged.id], "guide.validated_by should contain exactly one entry with the new merged ID (deduplicated)");
  });

  test("response includes INHERITED CONNECTIONS block when relations or guides inherited", async () => {
    const m1 = seedFragment("fragment one");
    const m2 = seedFragment("fragment two");
    const m3 = seedFragment("fragment three");
    core.saveMemory([m1, m2, m3]);

    await handleMemoryRelate({ sourceId: m1.id, targetId: m3.id, type: "supports" });

    const result = await handleMemoryMerge({
      ids: [m1.id, m2.id],
      title: "Merged Inherit",
      fragment: "combined",
    });

    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.includes("INHERITED CONNECTIONS"), "response should include INHERITED CONNECTIONS block");
    assert.ok(result.content[0].text.includes("supports"), "response should mention the inherited relation type");
  });

  test("no duplicate relations when two source fragments both relate to same target", async () => {
    const m1 = seedFragment("fragment one");
    const m2 = seedFragment("fragment two");
    const m3 = seedFragment("fragment three");
    core.saveMemory([m1, m2, m3]);

    await handleMemoryRelate({ sourceId: m1.id, targetId: m3.id, type: "supports" });
    await handleMemoryRelate({ sourceId: m2.id, targetId: m3.id, type: "supports" });

    const result = await handleMemoryMerge({
      ids: [m1.id, m2.id],
      title: "Merged Dedup",
      fragment: "combined",
    });

    assert.equal(result.isError, undefined);

    const memory = core.loadMemory();
    const merged = memory.find(f => f.title === "Merged Dedup");
    assert.ok(merged);

    const supportsToM3 = merged.relations.filter(r => r.id === m3.id && r.type === "supports");
    assert.equal(supportsToM3.length, 1, "should have exactly one supports relation to m3, not duplicated");
  });
});
