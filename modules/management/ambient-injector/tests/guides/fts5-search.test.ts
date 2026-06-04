import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import * as guides from "../../src/guides/index.js";
import type { Guide } from "../../src/types.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-guide-fts5-"));
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("FTS5 Guide Search", () => {
  test("FTS5 guide search by description finds guide", () => {
    const gs: Guide[] = [
      guides.createGuide("react", "web-frontend", "React library for building user interfaces with components"),
      guides.createGuide("python", "programming-language", "Python programming language for data science"),
    ];
    guides.saveGuides(gs);

    const result = guides.suggestGuides("React component patterns", gs);
    assert.ok(result.suggested.length >= 1);
    assert.ok(result.suggested.some(s => s.guide === "react"));
  });

  test("FTS5 guide prefix search finds guide", () => {
    const gs: Guide[] = [
      guides.createGuide("tailwindcss", "web-frontend", "Tailwind CSS utility-first framework"),
      guides.createGuide("react", "web-frontend", "React library"),
    ];
    guides.saveGuides(gs);

    const result = guides.suggestGuides("tailwind", gs);
    assert.ok(result.suggested.length >= 1);
    assert.ok(result.suggested.some(s => s.guide === "tailwindcss"));
  });

  test("FTS5 guide search for nonexistent returns empty tracked", () => {
    const gs: Guide[] = [
      guides.createGuide("react", "web-frontend", "React library"),
    ];
    guides.saveGuides(gs);

    const result = guides.suggestGuides("quantum physics", gs);
    assert.equal(result.relevant.length, 0);
  });

  test("findSimilarGuide matches exact name case-insensitively", () => {
    const gs: Guide[] = [guides.createGuide("React", "web-frontend", "desc")];
    const result = guides.findSimilarGuide(gs, "REACT");
    assert.ok(result);
    assert.equal(result!.guide, "react");
  });

  test("findSimilarGuide matches via Levenshtein for typos", () => {
    const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc")];
    const result = guides.findSimilarGuide(gs, "reacct");
    assert.ok(result);
    assert.equal(result!.guide, "react");
  });

  test("findSimilarGuide matches substring: node matches nodejs", () => {
    const gs: Guide[] = [guides.createGuide("nodejs", "web-backend", "desc")];
    const result = guides.findSimilarGuide(gs, "node");
    assert.ok(result);
    assert.equal(result!.guide, "nodejs");
  });

  test("findSimilarGuide returns null for completely different name", () => {
    const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc")];
    const result = guides.findSimilarGuide(gs, "quantum-physics-extravaganza");
    assert.equal(result, null);
  });

  test("findSimilarGuide returns null for empty guides", () => {
    const result = guides.findSimilarGuide([], "react");
    assert.equal(result, null);
  });

  test("suggestGuides finds tracked guide via FTS5", () => {
    const gs: Guide[] = [
      guides.createGuide("react", "web-frontend", "React hooks and components", ["hooks", "state"], ["useCallback prevents re-renders"]),
    ];
    guides.saveGuides(gs);

    const result = guides.suggestGuides("React hooks state management", gs);
    assert.ok(result.relevant.length >= 1);
    assert.ok(result.relevant.some(s => s.guide === "react"));
  });

  test("suggestGuides returns suggestions for untracked technologies", () => {
    const result = guides.suggestGuides("react", []);
    assert.ok(result.suggested.length >= 1);
    assert.ok(result.summary.includes("relevant"));
  });
});
