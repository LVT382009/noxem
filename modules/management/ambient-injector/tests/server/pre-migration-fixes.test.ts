import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as core from "../../src/memory/index.js";
import * as guides from "../../src/guides/index.js";
import * as sessions from "../../src/sessions/index.js";
import { setNotifyChange, handleMemoryAdd, handleMemoryRelate, handleGuideMerge, handleGuidePractice } from "../../src/server/handlers.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-fixes-"));
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

describe("S-07: deepMerge prototype pollution protection", () => {
  test("blocks __proto__ key in config merge", async () => {
    const { loadConfig, resetConfig, setConfigDir } = await import("../../src/memory/config.js");
    setConfigDir(TMPDIR);
    resetConfig();

    const maliciousConfig = {
      token_budget: { full_content: 9999 },
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } },
    };
    fs.writeFileSync(path.join(TMPDIR, "config.json"), JSON.stringify(maliciousConfig));

    const config = loadConfig();
    assert.equal(config.token_budget.full_content, 9999);
    assert.equal((config as any).polluted, undefined);
    resetConfig();
  });
});

describe("S-02: Critical secret confirm bypass blocking", () => {
  test("redacts OpenAI key even with confirm:true", async () => {
    const result = await handleMemoryAdd({
      fragment: "My API key is sk-proj-abcdefghijklmnopqrstuvwx",
      confirm: true,
    });
    assert.ok(!result.isError);
    const memory = core.loadMemory();
    assert.equal(memory.length, 1);
    assert.ok(memory[0].fragment.includes("[REDACTED"));
    assert.ok(!memory[0].fragment.includes("sk-proj-"));
  });

  test("redacts private key even with confirm:true", async () => {
    const result = await handleMemoryAdd({
      fragment: "Server key: -----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA",
      confirm: true,
    });
    assert.ok(!result.isError);
    const memory = core.loadMemory();
    assert.ok(memory[0].fragment.includes("[REDACTED"));
    assert.ok(!memory[0].fragment.includes("BEGIN RSA PRIVATE KEY"));
  });

  test("redacts secrets without confirm", async () => {
    const result = await handleMemoryAdd({
      fragment: "Token is sk-abcdefghijklmnopqrstuvwxyz123456",
    });
    assert.ok(!result.isError);
    const memory = core.loadMemory();
    assert.ok(memory[0].fragment.includes("[REDACTED"));
    assert.ok(!memory[0].fragment.includes("sk-abcdefghijklmnop"));
  });
});

describe("SIS-05: autoEndSession uses abandoned outcome", () => {
  test("autoEndSession records abandoned not success", async () => {
    const { autoStartSession, autoEndSession, resetSessionState } = await import("../../src/server/handlers.js");
    autoStartSession(null);

    const vs = { duration_tool_calls: 5, technologies: [], memories_created: [], guides_used: [], project: null };
    autoEndSession(vs);

    const allSessions = sessions.loadSessions();
    const completed = allSessions.find(s => s.status === "completed");
    assert.ok(completed);
    assert.equal(completed.task_outcome, "partial");
    resetSessionState();
  });
});

describe("B-02: Reverse relation semantic mapping", () => {
  test("supersedes creates superseded_by reverse", async () => {
    const addA = await handleMemoryAdd({ fragment: "Authentication using JWT tokens with HMAC SHA256 signing" });
    const addB = await handleMemoryAdd({ fragment: "Database connection pooling with PgBouncer configuration" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    const idB = addB.content[0].text.match(/\[([^\]]+)\]/)?.[1];

    await handleMemoryRelate({ sourceId: idB, targetId: idA, type: "supersedes" });

    const memory = core.loadMemory();
    const target = memory.find(f => f.id === idA);
    assert.ok(target);
    const reverseRel = target.relations?.find(r => r.id === idB);
    assert.ok(reverseRel);
    assert.equal(reverseRel.type, "superseded_by");
  });

  test("supports creates supports reverse (symmetric)", async () => {
    const addA = await handleMemoryAdd({ fragment: "React useEffect cleanup prevents memory leaks in components" });
    const addB = await handleMemoryAdd({ fragment: "Kubernetes HPA scaling based on CPU memory utilization metrics" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    const idB = addB.content[0].text.match(/\[([^\]]+)\]/)?.[1];

    await handleMemoryRelate({ sourceId: idA, targetId: idB, type: "supports" });

    const memory = core.loadMemory();
    const target = memory.find(f => f.id === idB);
    assert.ok(target);
    const reverseRel = target.relations?.find(r => r.id === idA);
    assert.ok(reverseRel);
    assert.equal(reverseRel.type, "supports");
  });

  test("contradicts creates contradicts reverse (symmetric)", async () => {
    const addA = await handleMemoryAdd({ fragment: "Monolithic architecture simplifies deployment and debugging" });
    const addB = await handleMemoryAdd({ fragment: "Microservices architecture enables independent team scaling" });
    const idA = addA.content[0].text.match(/\[([^\]]+)\]/)?.[1];
    const idB = addB.content[0].text.match(/\[([^\]]+)\]/)?.[1];

    await handleMemoryRelate({ sourceId: idA, targetId: idB, type: "contradicts" });

    const memory = core.loadMemory();
    const target = memory.find(f => f.id === idB);
    assert.ok(target);
    const reverseRel = target.relations?.find(r => r.id === idA);
    assert.ok(reverseRel);
    assert.equal(reverseRel.type, "contradicts");
  });
});

describe("B-12: guide_merge source_memories and validated_by transfer", () => {
  test("merged guide inherits source_memories from all sources", async () => {
    const mem1 = core.createFragment("React hooks lifecycle management patterns", "ai");
    const mem2 = core.createFragment("Redux state container predictable behavior", "ai");
    core.saveMemory([mem1, mem2]);

    await handleGuidePractice({ guide: "react-hooks", category: "web-frontend", contexts: ["hooks"], learnings: ["useEffect cleanup"] });
    await handleGuidePractice({ guide: "react-state", category: "web-frontend", contexts: ["state"], learnings: ["useState is synchronous"] });

    const allGuides = guides.loadGuides();
    const g1 = allGuides.find(g => g.guide === "react-hooks");
    const g2 = allGuides.find(g => g.guide === "react-state");
    g1!.source_memories = [mem1.id];
    g2!.source_memories = [mem2.id];
    g1!.validated_by = [mem2.id];
    g2!.validated_by = [mem1.id];
    guides.saveGuides(allGuides);

    const result = await handleGuideMerge({
      guides: ["react-hooks", "react-state"],
      guide: "react-combined",
      category: "web-frontend",
    });
    assert.ok(!result.isError);

    const mergedGuides = guides.loadGuides();
    const merged = mergedGuides.find(g => g.guide === "react-combined");
    assert.ok(merged);
    assert.ok(merged.source_memories.includes(mem1.id));
    assert.ok(merged.source_memories.includes(mem2.id));
    assert.ok(merged.validated_by.includes(mem1.id));
    assert.ok(merged.validated_by.includes(mem2.id));
  });
});
