import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";

import type { Guide } from "../../src/types.js";
import * as guides from "../../src/guides/index.js";

let TMPDIR: string;

beforeEach(() => {
  TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "lemma-guide-fuzzy-"));
  guides.setGuidesDir(TMPDIR);
});

afterEach(() => {
  guides.setGuidesDir(path.join(os.homedir(), ".lemma"));
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

describe("findSimilarGuide", () => {
  test("finds exact match case-insensitively", () => {
    const gs: Guide[] = [guides.createGuide("React", "web-frontend", "desc")];
    const result: Guide | null = guides.findSimilarGuide(gs, "REACT");
    assert.ok(result);
    assert.equal(result!.guide, "react");
  });

  test("finds similar guide: reacct matches react (fuzzy)", () => {
    const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc")];
    const result: Guide | null = guides.findSimilarGuide(gs, "reacct");
    assert.ok(result);
    assert.equal(result!.guide, "react");
  });

  test("finds similar guide: node matches nodejs", () => {
    const gs: Guide[] = [guides.createGuide("nodejs", "web-backend", "desc")];
    const result: Guide | null = guides.findSimilarGuide(gs, "node");
    assert.ok(result);
    assert.equal(result!.guide, "nodejs");
  });

  test("returns null for completely different name", () => {
    const gs: Guide[] = [guides.createGuide("react", "web-frontend", "desc")];
    const result: Guide | null = guides.findSimilarGuide(gs, "quantum-physics-extravaganza");
    assert.equal(result, null);
  });

  test("returns null when guides array is empty", () => {
    const result: Guide | null = guides.findSimilarGuide([], "react");
    assert.equal(result, null);
  });

  test("handles special characters in guide names", () => {
    const gs: Guide[] = [guides.createGuide("@scope/package", "dev-tool", "desc")];
    const result: Guide | null = guides.findSimilarGuide(gs, "@scope/package");
    assert.ok(result);
    assert.equal(result!.guide, "@scope/package");
  });

  test("vuejs matches vue", () => {
    const gs: Guide[] = [guides.createGuide("vuejs", "web-frontend", "desc")];
    const result: Guide | null = guides.findSimilarGuide(gs, "vue");
    assert.ok(result);
    assert.equal(result!.guide, "vuejs");
  });

  test("tailwindcss matches tailwind", () => {
    const gs: Guide[] = [guides.createGuide("tailwindcss", "web-frontend", "desc")];
    const result: Guide | null = guides.findSimilarGuide(gs, "tailwind");
    assert.ok(result);
    assert.equal(result!.guide, "tailwindcss");
  });

  test("returns exact match even when other similar guides exist", () => {
    const gs: Guide[] = [
      guides.createGuide("react", "web-frontend", "desc"),
      guides.createGuide("react-native", "mobile-frontend", "desc"),
    ];
    const result: Guide | null = guides.findSimilarGuide(gs, "react");
    assert.ok(result);
    assert.equal(result!.guide, "react");
  });
});
