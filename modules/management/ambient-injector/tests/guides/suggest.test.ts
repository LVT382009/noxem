import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { Guide, SuggestResult, GuideSuggestion } from "../../src/types.js";
import * as guides from "../../src/guides/index.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-guide-suggest-"));
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("suggestGuides", () => {
  test("returns suggestions from TASK_GUIDE_MAP for react component query", () => {
    const result: SuggestResult = guides.suggestGuides("react component", []);
    assert.ok(result.suggested.length > 0);
    const names: string[] = result.suggested.map((s: GuideSuggestion) => s.guide);
    assert.ok(names.includes("react"));
  });

  test("returns suggestions from tracked guides via Fuse.js fuzzy search", () => {
    const gs: Guide[] = [guides.createGuide("custom-react-guide", "web-frontend", "desc", ["hooks"], ["useReducer pattern"])];
    const result: SuggestResult = guides.suggestGuides("hooks useReducer", gs);
    const trackedNames: string[] = result.relevant.map((s: GuideSuggestion) => s.guide);
    assert.ok(trackedNames.includes("custom-react-guide"));
  });

  test("token-based fallback catches tracked guides Fuse misses", () => {
    const gs: Guide[] = [guides.createGuide("custom-unique-name-xyz", "dev-tool", "does something unique", ["specialcontext"], [])];
    const result: SuggestResult = guides.suggestGuides("specialcontext", gs);
    const trackedNames: string[] = result.relevant.map((s: GuideSuggestion) => s.guide);
    assert.ok(trackedNames.includes("custom-unique-name-xyz"));
  });

  test("returns empty for completely unrelated query with no tracked guides", () => {
    const result: SuggestResult = guides.suggestGuides("quantum physics", []);
    assert.equal(result.suggested.length, 0);
    assert.equal(result.relevant.length, 0);
    assert.equal(result.missing.length, 0);
  });

  test("handles empty string query gracefully", () => {
    const result: SuggestResult = guides.suggestGuides("", []);
    assert.ok(result);
    assert.ok(Array.isArray(result.suggested));
    assert.ok(Array.isArray(result.relevant));
    assert.ok(Array.isArray(result.missing));
  });

  test("relevant and missing arrays are correctly separated", () => {
    const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc")];
    const result: SuggestResult = guides.suggestGuides("react", gs);
    for (const r of result.relevant) {
      assert.equal(r.tracked, true);
    }
    for (const m of result.missing) {
      assert.equal(m.tracked, false);
    }
  });

  test("deduplicates: same guide does not appear twice in suggestions", () => {
    const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc", ["component"], ["hooks"])];
    const result: SuggestResult = guides.suggestGuides("react component", gs);
    const names: string[] = result.suggested.map((s: GuideSuggestion) => s.guide);
    const uniqueNames: Set<string> = new Set(names);
    assert.equal(names.length, uniqueNames.size);
  });
});

describe("formatSuggestions", () => {
  test("shows tracked guides with checkmark", () => {
    const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc", [], ["useCallback"])];
    const result: SuggestResult = guides.suggestGuides("react", gs);
    const output: string = guides.formatSuggestions(result);
    assert.ok(output.includes("✓"));
    assert.ok(output.includes("react"));
  });

  test("shows missing guides with plus sign", () => {
    const result: SuggestResult = guides.suggestGuides("react component", []);
    if (result.missing.length > 0) {
      const output: string = guides.formatSuggestions(result);
      assert.ok(output.includes("+"));
    }
  });

  test("shows no-relevant message when no suggestions found", () => {
    const result: SuggestResult = guides.suggestGuides("quantum physics", []);
    const output: string = guides.formatSuggestions(result);
    assert.ok(output.includes("No relevant guides found"));
  });

  test("includes summary line", () => {
    const result: SuggestResult = guides.suggestGuides("react", []);
    const output: string = guides.formatSuggestions(result);
    assert.ok(output.includes(result.summary));
  });
});
