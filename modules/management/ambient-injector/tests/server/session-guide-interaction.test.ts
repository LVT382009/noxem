import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import * as handlers from "../../src/server/handlers.js";
import { resetSessionState } from "../../src/server/handlers.js";
import type { Guide, Session, MemoryFragment } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-test-"));
  core.setMemoryDir(TMPDIR);
  guides.setGuidesDir(TMPDIR);
  sessions.setSessionsDir(TMPDIR);
});

afterEach(() => {
  resetSessionState();
  core.setMemoryDir(path.join(os.homedir(), ".lemma"));
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  sessions.setSessionsDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

function seedGuide(name: string, category: string, description?: string, overrides: Partial<Guide> = {}): Guide {
  const allGuides = guides.loadGuides();
  const g = guides.createGuide(name, category, description || "desc");
  Object.assign(g, overrides);
  allGuides.push(g);
  guides.saveGuides(allGuides);
  return g;
}

describe("Session start — abandon existing", () => {
  test("starting a new session abandons the existing active session", async () => {
    await handlers.handleSessionStart({ task_type: "implementation" });
    const firstSessions: Session[] = sessions.loadSessions();
    const firstId = firstSessions[0].session_id;

    await handlers.handleSessionStart({ task_type: "debugging" });
    const loaded: Session[] = sessions.loadSessions();

    assert.equal(loaded.length, 2);
    const first = loaded.find((s: Session) => s.session_id === firstId)!;
    const second = loaded.find((s: Session) => s.session_id !== firstId)!;
    assert.equal(first.status, "abandoned");
    assert.equal(first.task_outcome, "abandoned");
    assert.equal(second.status, "active");
    assert.equal(second.task_type, "debugging");

    await handlers.handleSessionEnd({ outcome: "abandoned" });
  });

  test("new session after abandon gets correct task_type and technologies", async () => {
    await handlers.handleSessionStart({ task_type: "research" });
    await handlers.handleSessionStart({
      task_type: "implementation",
      technologies: ["react", "typescript"],
    });

    const loaded: Session[] = sessions.loadSessions();
    const active = loaded.find((s: Session) => s.status === "active")!;
    assert.equal(active.task_type, "implementation");
    assert.equal(active.technology, "react,typescript");

    await handlers.handleSessionEnd({ outcome: "success" });
  });
});

describe("Session end — guide success rate tracking", () => {
  test("success outcome increments guide success_count", async () => {
    seedGuide("react", "web-frontend", "React guide");

    await handlers.handleSessionStart({ task_type: "implementation" });
    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      contexts: ["hooks"],
      learnings: ["useEffect cleanup"],
    });
    await handlers.handleSessionEnd({ outcome: "success" });

    const allGuides: Guide[] = guides.loadGuides();
    const g = allGuides.find((g: Guide) => g.guide === "react")!;
    assert.equal(g.success_count, 1);
    assert.equal(g.failure_count, 0);
  });

  test("failure outcome increments guide failure_count", async () => {
    seedGuide("react", "web-frontend", "React guide");

    await handlers.handleSessionStart({ task_type: "debugging" });
    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      contexts: ["hooks"],
      learnings: ["stale closures"],
    });
    await handlers.handleSessionEnd({ outcome: "failure" });

    const allGuides: Guide[] = guides.loadGuides();
    const g = allGuides.find((g: Guide) => g.guide === "react")!;
    assert.equal(g.success_count, 0);
    assert.equal(g.failure_count, 1);
  });

  test("no guides_used means no guide stats change", async () => {
    seedGuide("python", "programming-language", "Python guide");

    await handlers.handleSessionStart({ task_type: "research" });
    await handlers.handleSessionEnd({ outcome: "success" });

    const allGuides: Guide[] = guides.loadGuides();
    const g = allGuides.find((g: Guide) => g.guide === "python")!;
    assert.equal(g.success_count, 0);
    assert.equal(g.failure_count, 0);
  });
});

describe("Session end — improvement suggestions", () => {
  test("generates improvement suggestion when guide success rate drops below 0.4", async () => {
    seedGuide("react", "web-frontend", "React guide", {
      success_count: 1,
      failure_count: 2,
    });

    await handlers.handleSessionStart({ task_type: "implementation" });
    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      contexts: ["hooks"],
      learnings: [],
    });
    const result = await handlers.handleSessionEnd({ outcome: "failure" });

    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes("IMPROVEMENT SUGGESTIONS"));
    assert.ok(result.content[0].text.includes("success rate"));
    assert.ok(result.content[0].text.includes("react"));
  });

  test("no improvement suggestion when guide success rate is above 0.4", async () => {
    seedGuide("react", "web-frontend", "React guide", {
      success_count: 2,
      failure_count: 1,
    });

    await handlers.handleSessionStart({ task_type: "implementation" });
    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      contexts: ["hooks"],
      learnings: [],
    });
    const result = await handlers.handleSessionEnd({ outcome: "failure" });

    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("IMPROVEMENT SUGGESTIONS"));
  });

  test("works correctly with no prior guide history", async () => {
    seedGuide("react", "web-frontend", "React guide");

    await handlers.handleSessionStart({ task_type: "implementation" });
    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      contexts: ["hooks"],
      learnings: [],
    });
    const result = await handlers.handleSessionEnd({ outcome: "failure" });

    assert.ok(!result.isError);
    assert.ok(!result.content[0].text.includes("IMPROVEMENT SUGGESTIONS"));

    const allGuides: Guide[] = guides.loadGuides();
    const g = allGuides.find((g: Guide) => g.guide === "react")!;
    assert.equal(g.failure_count, 1);
    assert.equal(g.success_count, 0);
  });
});

describe("Full session lifecycle with guides", () => {
  test("start → practice guide → add memory → end: all data recorded correctly", async () => {
    await handlers.handleSessionStart({
      task_type: "implementation",
      technologies: ["react"],
    });
    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      contexts: ["hooks"],
      learnings: ["useEffect cleanup"],
    });
    const memResult = await handlers.handleMemoryAdd({
      fragment: "React hooks require cleanup on unmount",
      title: "Hooks Cleanup",
    });
    await handlers.handleSessionEnd({
      outcome: "success",
      lessons: ["Keep components small"],
    });

    const loadedSessions: Session[] = sessions.loadSessions();
    const session = loadedSessions[0];
    assert.equal(session.status, "completed");
    assert.equal(session.task_outcome, "success");
    assert.deepEqual(session.guides_used, ["react"]);
    assert.equal(session.memories_created.length, 1);
    assert.deepEqual(session.lessons, ["Keep components small"]);

    const allGuides: Guide[] = guides.loadGuides();
    const guide = allGuides.find((g: Guide) => g.guide === "react")!;
    assert.equal(guide.success_count, 1);

    const memIdMatch = memResult.content[0].text.match(/\[([^\]]+)\]/);
    assert.ok(memIdMatch);
    const memory: MemoryFragment[] = core.loadMemory();
    const frag = memory.find((f: MemoryFragment) => f.id === memIdMatch[1])!;
    assert.equal(frag.session_id, session.session_id);
  });

  test("practice multiple guides → end with failure: all guides get failure_count", async () => {
    await handlers.handleSessionStart({ task_type: "implementation" });
    await handlers.handleGuidePractice({
      guide: "react",
      category: "web-frontend",
      contexts: ["hooks"],
      learnings: [],
    });
    await handlers.handleGuidePractice({
      guide: "typescript",
      category: "programming-language",
      contexts: ["types"],
      learnings: [],
    });
    await handlers.handleSessionEnd({ outcome: "failure" });

    const allGuides: Guide[] = guides.loadGuides();
    const reactGuide = allGuides.find((g: Guide) => g.guide === "react")!;
    const tsGuide = allGuides.find((g: Guide) => g.guide === "typescript")!;
    assert.equal(reactGuide.failure_count, 1);
    assert.equal(tsGuide.failure_count, 1);

    const loadedSessions: Session[] = sessions.loadSessions();
    assert.ok(loadedSessions[0].guides_used.includes("react"));
    assert.ok(loadedSessions[0].guides_used.includes("typescript"));
  });
});

describe("handleMemoryAdd — session linking", () => {
  test("active session links memory fragment to session", async () => {
    await handlers.handleSessionStart({ task_type: "implementation" });
    const result = await handlers.handleMemoryAdd({
      fragment: "Test fragment content",
      title: "Test Memory",
    });
    assert.ok(!result.isError);

    const memIdMatch = result.content[0].text.match(/\[([^\]]+)\]/);
    assert.ok(memIdMatch);
    const fragId = memIdMatch[1];

    const memory: MemoryFragment[] = core.loadMemory();
    const frag = memory.find((f: MemoryFragment) => f.id === fragId)!;
    assert.ok(frag.session_id);
    assert.equal(frag.task_type, "implementation");

    const loadedSessions: Session[] = sessions.loadSessions();
    const session = loadedSessions[0];
    assert.ok(session.memories_created.includes(fragId));

    await handlers.handleSessionEnd({ outcome: "success" });
  });

  test("no active session: memory_add works without session linking", async () => {
    const result = await handlers.handleMemoryAdd({
      fragment: "Standalone fragment",
      title: "No Session",
    });
    assert.ok(!result.isError);

    const memIdMatch = result.content[0].text.match(/\[([^\]]+)\]/);
    assert.ok(memIdMatch);
    const fragId = memIdMatch[1];

    const memory: MemoryFragment[] = core.loadMemory();
    const frag = memory.find((f: MemoryFragment) => f.id === fragId)!;
    assert.equal(frag.session_id, null);
    assert.equal(frag.task_type, null);
  });
});
