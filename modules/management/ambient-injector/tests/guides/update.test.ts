import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { Guide } from "../../src/types.js";
import * as guides from "../../src/guides/index.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-guide-update-"));
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("updateGuide", () => {
  function seedGuide(): Guide {
    const g: Guide = guides.createGuide("react", "web-frontend", "React library guide");
    return g;
  }

  test("updates guide name (normalized to lowercase)", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { guide: "ReactJS" });
    assert.equal(updated!.guide, "reactjs");
  });

  test("updates category (normalized to lowercase)", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { category: "WEB-FRONTEND" });
    assert.equal(updated!.category, "web-frontend");
  });

  test("updates description", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { description: "New description" });
    assert.equal(updated!.description, "New description");
  });

  test("adds anti_patterns (appends to existing)", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { add_anti_patterns: ["prop drilling", "nested ternaries"] });
    assert.deepEqual(updated!.anti_patterns, ["prop drilling", "nested ternaries"]);
  });

  test("adds pitfalls (appends to existing)", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { add_pitfalls: ["stale closures"] });
    assert.deepEqual(updated!.known_pitfalls, ["stale closures"]);
  });

  test("sets superseded_by field", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { superseded_by: "nextjs" });
    assert.equal(updated!.superseded_by, "nextjs");
  });

  test("marks guide as deprecated", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "react", { deprecated: true });
    assert.equal(updated!.deprecated, true);
  });

  test("returns null for non-existent guide", () => {
    const gs: Guide[] = [seedGuide()];
    const result: Guide | null = guides.updateGuide(gs, "nonexistent", { description: "x" });
    assert.equal(result, null);
  });

  test("multiple updates accumulate (anti_patterns don't overwrite)", () => {
    const gs: Guide[] = [seedGuide()];
    guides.updateGuide(gs, "react", { add_anti_patterns: ["first"] });
    const updated: Guide | null = guides.updateGuide(gs, "react", { add_anti_patterns: ["second"] });
    assert.deepEqual(updated!.anti_patterns, ["first", "second"]);
  });

  test("multiple updates accumulate (pitfalls don't overwrite)", () => {
    const gs: Guide[] = [seedGuide()];
    guides.updateGuide(gs, "react", { add_pitfalls: ["pitfall-a"] });
    const updated: Guide | null = guides.updateGuide(gs, "react", { add_pitfalls: ["pitfall-b"] });
    assert.deepEqual(updated!.known_pitfalls, ["pitfall-a", "pitfall-b"]);
  });

  test("deprecated=false does not change already deprecated guide", () => {
    const gs: Guide[] = [seedGuide()];
    guides.updateGuide(gs, "react", { deprecated: true });
    const updated: Guide | null = guides.updateGuide(gs, "react", { deprecated: false });
    assert.equal(updated!.deprecated, true);
  });

  test("finds guide case-insensitively for update", () => {
    const gs: Guide[] = [seedGuide()];
    const updated: Guide | null = guides.updateGuide(gs, "REACT", { description: "found case-insensitive" });
    assert.ok(updated);
    assert.equal(updated!.description, "found case-insensitive");
  });
});
