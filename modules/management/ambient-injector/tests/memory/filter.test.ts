import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterFragments, createFragment } from "../../src/memory/core.js";

function makeFragment(overrides: { created?: string; confidence?: number; project?: string | null } = {}): any {
  const frag = createFragment("Test fragment content for filtering", "ai");
  return { ...frag, ...overrides };
}

describe("filterFragments", () => {
  it("returns all fragments when no filters provided", () => {
    const fragments = [
      makeFragment({ confidence: 0.9 }),
      makeFragment({ confidence: 0.3 }),
      makeFragment({ confidence: 0.1 }),
    ];
    const result = filterFragments(fragments);
    assert.equal(result.length, 3);
  });

  it("filters by minConfidence", () => {
    const fragments = [
      makeFragment({ confidence: 0.9 }),
      makeFragment({ confidence: 0.5 }),
      makeFragment({ confidence: 0.1 }),
    ];
    const result = filterFragments(fragments, { minConfidence: 0.5 });
    assert.equal(result.length, 2);
    assert.ok(result.every(f => f.confidence >= 0.5));
  });

  it("filters by minConfidence boundary", () => {
    const fragments = [
      makeFragment({ confidence: 0.5 }),
    ];
    const result = filterFragments(fragments, { minConfidence: 0.5 });
    assert.equal(result.length, 1);
  });

  it("filters by afterDate", () => {
    const fragments = [
      makeFragment({ created: "2026-01-15" }),
      makeFragment({ created: "2026-03-15" }),
      makeFragment({ created: "2026-04-15" }),
    ];
    const result = filterFragments(fragments, { afterDate: "2026-03-01" });
    assert.equal(result.length, 2);
  });

  it("filters by beforeDate", () => {
    const fragments = [
      makeFragment({ created: "2026-01-15" }),
      makeFragment({ created: "2026-03-15" }),
      makeFragment({ created: "2026-04-15" }),
    ];
    const result = filterFragments(fragments, { beforeDate: "2026-03-31" });
    assert.equal(result.length, 2);
  });

  it("combines afterDate and beforeDate", () => {
    const fragments = [
      makeFragment({ created: "2026-01-15" }),
      makeFragment({ created: "2026-02-15" }),
      makeFragment({ created: "2026-03-15" }),
      makeFragment({ created: "2026-04-15" }),
    ];
    const result = filterFragments(fragments, { afterDate: "2026-02-01", beforeDate: "2026-03-31" });
    assert.equal(result.length, 2);
  });

  it("combines minConfidence and date filters", () => {
    const fragments = [
      makeFragment({ confidence: 0.9, created: "2026-04-01" }),
      makeFragment({ confidence: 0.3, created: "2026-04-15" }),
      makeFragment({ confidence: 0.8, created: "2026-01-01" }),
    ];
    const result = filterFragments(fragments, { minConfidence: 0.5, afterDate: "2026-03-01" });
    assert.equal(result.length, 1);
    assert.ok(result[0].confidence >= 0.5);
  });

  it("returns empty when no fragments match filters", () => {
    const fragments = [
      makeFragment({ confidence: 0.1, created: "2026-01-01" }),
    ];
    const result = filterFragments(fragments, { minConfidence: 0.5, afterDate: "2026-06-01" });
    assert.equal(result.length, 0);
  });

  it("handles empty fragments array", () => {
    const result = filterFragments([], { minConfidence: 0.5 });
    assert.equal(result.length, 0);
  });

  it("ignores invalid date strings gracefully", () => {
    const fragments = [
      makeFragment({ created: "2026-04-15" }),
    ];
    const result = filterFragments(fragments, { afterDate: "not-a-date" });
    assert.equal(result.length, 1);
  });

  it("handles undefined filter options", () => {
    const fragments = [
      makeFragment({ confidence: 0.9 }),
    ];
    const result = filterFragments(fragments, { minConfidence: undefined, afterDate: undefined });
    assert.equal(result.length, 1);
  });
});
