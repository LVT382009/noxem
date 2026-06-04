import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkAfterMemoryAdd,
  checkAfterGuidePractice,
  checkAfterMemoryRead,
  runFullAnalysis,
  formatSuggestions,
} from "../../src/intelligence/proactive.js";
import type { MemoryFragment } from "../../src/types.js";
import type { Guide } from "../../src/types.js";
import type { ProactiveSuggestion } from "../../src/intelligence/types.js";

function makeFragment(id: string, text: string, type: MemoryFragment["type"] = "fact", project: string | null = null): MemoryFragment {
  return {
    id,
    title: text.slice(0, 30),
    description: "",
    fragment: text,
    project,
    confidence: 0.8,
    source: "ai",
    created: "2026-04-15",
    lastAccessed: "",
    accessed: 0,
    tags: [],
    associatedWith: [],
    relations: [],
    negativeHits: 0,
    quality_score: null,
    refinement_count: 0,
    parent_id: null,
    child_ids: [],
    session_id: null,
    task_type: null,
    outcome: null,
    positive_feedback: 0,
    negative_feedback: 0,
    last_refined: null,
    type,
    related_guides: [],
  };
}

function makeGuide(name: string, opts: Partial<Guide> = {}): Guide {
  return {
    id: "1",
    guide: name,
    category: "dev-tool",
    description: "",
    usage_count: 1,
    last_used: "2026-04-15",
    contexts: [],
    learnings: [],
    success_count: 0,
    failure_count: 0,
    auto_usage_count: 0,
    anti_patterns: [],
    known_pitfalls: [],
    last_refined: null,
    depends_on: [],
    enables: [],
    superseded_by: null,
    deprecated: false,
    source_memories: [],
    validated_by: [],
    ...opts,
  };
}

describe("checkAfterMemoryAdd", () => {
  test("returns empty for first few memories", () => {
    const frag = makeFragment("m1", "Use React hooks for state management");
    const result = checkAfterMemoryAdd(frag, [], []);
    assert.equal(result.length, 0);
  });

  test("suggests distillation for recurring patterns", () => {
    const newFrag = makeFragment("m5", "Use useCallback to prevent unnecessary re-renders in React components", "pattern");
    const existing = [
      makeFragment("m1", "Use useCallback to prevent unnecessary re-renders in React components"),
      makeFragment("m2", "Use useCallback to prevent unnecessary re-renders in React components"),
      makeFragment("m3", "Use useCallback to prevent unnecessary re-renders in React components"),
      makeFragment("m4", "Use useCallback to prevent unnecessary re-renders in React components"),
    ];
    const result = checkAfterMemoryAdd(newFrag, existing, []);
    const distill = result.find(s => s.type === "distill");
    assert.ok(distill, "Should suggest distillation");
  });

  test("suggests distill review when candidates accumulate", () => {
    const frag = makeFragment("m1", "Test");
    const existing = [
      makeFragment("m2", "A", "pattern"),
      makeFragment("m3", "B", "pattern"),
      makeFragment("m4", "C", "pattern"),
    ].map(f => ({ ...f, distill_candidate: true }));
    const result = checkAfterMemoryAdd(frag, existing, []);
    const review = result.find(s => s.type === "distill" && s.message.includes("distill candidate"));
    assert.ok(review);
  });
});

describe("checkAfterGuidePractice", () => {
  test("warns about low success rate", () => {
    const guide = makeGuide("failing-guide", {
      usage_count: 5,
      success_count: 1,
      failure_count: 4,
    });
    const result = checkAfterGuidePractice(guide, [guide]);
    const refine = result.find(s => s.type === "refine" && s.priority === "high");
    assert.ok(refine);
    assert.ok(refine.message.includes("success rate"));
  });

  test("suggests description for well-used guide without one", () => {
    const guide = makeGuide("bare-guide", {
      usage_count: 4,
      description: "",
    });
    const result = checkAfterGuidePractice(guide, [guide]);
    const desc = result.find(s => s.type === "refine" && s.message.includes("no description"));
    assert.ok(desc);
  });

  test("suggests merge for guides with shared contexts", () => {
    const guide1 = makeGuide("react-hooks", {
      category: "web-frontend",
      contexts: ["hooks", "state", "effects"],
      usage_count: 5,
    });
    const guide2 = makeGuide("react-state", {
      category: "web-frontend",
      contexts: ["hooks", "state", "redux"],
      usage_count: 4,
    });
    const result = checkAfterGuidePractice(guide1, [guide1, guide2]);
    const merge = result.find(s => s.type === "merge");
    assert.ok(merge, "Should suggest merge for shared-context guides");
    assert.ok(merge.message.includes("react-hooks"));
  });

  test("returns empty for healthy guide", () => {
    const guide = makeGuide("healthy-guide", {
      usage_count: 1,
      description: "A good guide",
      success_count: 1,
      failure_count: 0,
    });
    const result = checkAfterGuidePractice(guide, [guide]);
    assert.equal(result.length, 0);
  });
});

describe("checkAfterMemoryRead", () => {
  test("suggests relations for co-read unreferenced fragments", () => {
    const frags = [
      makeFragment("m1", "React state"),
      makeFragment("m2", "Vue state"),
      makeFragment("m3", "Angular state"),
    ];
    const all = [...frags];
    const result = checkAfterMemoryRead(frags, all);
    const relate = result.find(s => s.type === "relate");
    assert.ok(relate);
  });

  test("warns about low confidence reads", () => {
    const frags = [
      { ...makeFragment("m1", "Low conf"), confidence: 0.2 },
      { ...makeFragment("m2", "Also low"), confidence: 0.15 },
    ];
    const result = checkAfterMemoryRead(frags, frags);
    const archive = result.find(s => s.type === "archive" && s.message.includes("low confidence"));
    assert.ok(archive);
  });
});

describe("runFullAnalysis", () => {
  test("flags stale memories", () => {
    const fragments = Array.from({ length: 15 }, (_, i) => ({
      ...makeFragment(`m${i}`, `Fragment ${i}`),
      confidence: 0.1,
    }));
    const result = runFullAnalysis(fragments, []);
    const archive = result.find(s => s.type === "archive" && s.message.includes("very low confidence"));
    assert.ok(archive);
  });

  test("flags deprecated guides", () => {
    const fragments = [makeFragment("m1", "Test")];
    const guides = [
      makeGuide("old-thing", { deprecated: true }),
    ];
    const result = runFullAnalysis(fragments, guides);
    const dep = result.find(s => s.type === "archive" && s.message.includes("deprecated"));
    assert.ok(dep);
    assert.ok(dep.message.includes("old-thing"));
  });

  test("flags isolated memories", () => {
    const fragments = Array.from({ length: 10 }, (_, i) => makeFragment(`m${i}`, `Memory ${i}`, "fact"));
    const result = runFullAnalysis(fragments, []);
    const relate = result.find(s => s.type === "relate" && s.message.includes("isolated"));
    assert.ok(relate);
  });
});

describe("formatSuggestions", () => {
  test("returns empty string for no suggestions", () => {
    assert.equal(formatSuggestions([]), "");
  });

  test("formats all priority levels", () => {
    const suggestions: ProactiveSuggestion[] = [
      { type: "conflict", priority: "high", message: "Critical issue" },
      { type: "distill", priority: "medium", message: "Medium issue" },
      { type: "archive", priority: "low", message: "Low priority" },
    ];
    const formatted = formatSuggestions(suggestions);
    assert.ok(formatted.includes("Critical issue"));
    assert.ok(formatted.includes("Medium issue"));
    assert.ok(formatted.includes("Low priority"));
    assert.ok(formatted.includes("[!]"));
    assert.ok(formatted.includes("[*]"));
    assert.ok(formatted.includes("[ ]"));
  });
});
