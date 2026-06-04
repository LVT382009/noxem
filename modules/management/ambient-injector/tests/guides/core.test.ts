import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { Guide, SuggestResult } from "../../src/types.js";
import * as guides from "../../src/guides/index.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-guide-core-"));
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("Guides Core", () => {
  describe("createGuide", () => {
    test("creates guide with required fields", () => {
      const g: Guide = guides.createGuide("react", "web-frontend", "React library");
      assert.ok(g.id.startsWith("g"));
      assert.equal(g.guide, "react");
      assert.equal(g.category, "web-frontend");
      assert.equal(g.usage_count, 1);
      assert.deepEqual(g.contexts, []);
      assert.deepEqual(g.learnings, []);
    });

    test("normalizes name and category to lowercase", () => {
      const g: Guide = guides.createGuide("React", "WEB-FRONTEND", "desc");
      assert.equal(g.guide, "react");
      assert.equal(g.category, "web-frontend");
    });
  });

  describe("loadGuides / saveGuides", () => {
    test("returns empty array when no file", () => {
      assert.deepEqual(guides.loadGuides(), []);
    });

    test("persists and loads guides", () => {
      const gs: Guide[] = [guides.createGuide("react", "web-frontend", "React guide")];
      guides.saveGuides(gs);
      const loaded: Guide[] = guides.loadGuides();
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].guide, "react");
    });

    test("refuses to save empty array", () => {
      const gs: Guide[] = [guides.createGuide("seed", "dev-tool", "desc")];
      guides.saveGuides(gs);
      guides.saveGuides([]);
      assert.equal(guides.loadGuides().length, 1);
    });
  });

  describe("findGuide", () => {
    test("finds guide case-insensitively", () => {
      const gs: Guide[] = [guides.createGuide("React", "web-frontend", "desc")];
      assert.ok(guides.findGuide(gs, "react"));
      assert.ok(guides.findGuide(gs, "REACT"));
    });

    test("returns null for non-existent guide", () => {
      assert.equal(guides.findGuide([], "nothing"), null);
    });
  });

  describe("practiceGuide", () => {
    test("increments usage count for existing guide", () => {
      const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc")];
      guides.practiceGuide(gs, "react", "web-frontend", "", ["hooks"], ["useCallback"]);
      assert.equal(gs[0].usage_count, 2);
      assert.deepEqual(gs[0].contexts, ["hooks"]);
      assert.deepEqual(gs[0].learnings, ["useCallback"]);
    });

    test("creates new guide if not found", () => {
      const gs: Guide[] = [];
      guides.practiceGuide(gs, "python", "programming-language", "Python guide", ["scripts"], ["list comprehension"]);
      assert.equal(gs.length, 1);
      assert.equal(gs[0].guide, "python");
    });
  });

  describe("deleteGuide", () => {
    test("removes guide by name", () => {
      const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc")];
      const result: boolean = guides.deleteGuide(gs, "react");
      assert.equal(result, true);
      assert.equal(gs.length, 0);
    });

    test("returns false for non-existent guide", () => {
      const result: boolean = guides.deleteGuide([], "nothing");
      assert.equal(result, false);
    });
  });

  describe("promoteToGuide", () => {
    test("creates new guide from memory", () => {
      const gs: Guide[] = [];
      guides.promoteToGuide(gs, "react", "web-frontend", "use hooks", "component");
      assert.equal(gs.length, 1);
      assert.deepEqual(gs[0].learnings, ["use hooks"]);
    });

    test("adds learning to existing guide", () => {
      const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc")];
      guides.promoteToGuide(gs, "react", "web-frontend", "useReducer pattern", "state");
      assert.ok(gs[0].learnings.includes("useReducer pattern"));
      assert.equal(gs[0].usage_count, 2);
    });
  });

  describe("suggestGuides", () => {
    test("returns suggestions for a task", () => {
      const result: SuggestResult = guides.suggestGuides("react", []);
      assert.ok(result.summary.includes("relevant"));
      assert.ok(result.suggested.length > 0);
    });

    test("finds tracked guides", () => {
      const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc", ["hooks", "state"])];
      const result: SuggestResult = guides.suggestGuides("react", gs);
      assert.ok(result.relevant.length > 0);
    });
  });

  describe("formatGuidesForLLM", () => {
    test("shows empty state", () => {
      const output: string = guides.formatGuidesForLLM([]);
      assert.ok(output.includes("no guides tracked"));
    });

    test("shows guide details", () => {
      const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc", ["hooks"], ["useCallback"])];
      const output: string = guides.formatGuidesForLLM(gs);
      assert.ok(output.includes("react"));
      assert.ok(output.includes("1 learnings"));
    });
  });
});
