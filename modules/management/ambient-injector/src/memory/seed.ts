import type { MemoryFragment } from "../types.js";
import { logger } from "../logger.js";

const SEED_TAG = "lemma_seed";

interface SeedEntry {
  id: string;
  title: string;
  description: string;
  type: MemoryFragment["type"];
  fragment: string;
  related_guides?: string[];
}

const SEEDS: SeedEntry[] = [
  {
    id: "seed_task_complexity",
    title: "Task Complexity Assessment",
    description: "Evaluate complexity before acting. Simple: execute directly. Complex: plan → evaluate → execute.",
    type: "pattern",
    fragment: `## Task Complexity Assessment

### Context
Every task has a complexity level that determines the required workflow. Choosing the wrong workflow wastes time or introduces risk.

### Pattern

**Simple Tasks** (single-step, single-file, certainty):
- Small change in a single file
- Questions requiring short answers
- Single function add/fix
- Simple search/lookup

→ Execute directly. No planning needed.

**Complex Tasks** (multi-step, multi-file, uncertainty):
- Refactoring across multiple files
- New feature involving multiple components
- Debugging with unclear root cause
- Architectural decisions
- Cross-file dependencies

→ Mandatory 3-Phase Process:
1. **PLAN:** Break into subtasks, define each step, identify dependencies, flag risks
2. **EVALUATE:** Review plan for missing steps, side-effect analysis, cross-file consistency
3. **EXECUTE:** Follow plan in order, verify after each step, update plan on failure

### Rules
- NEVER start writing code directly on complex tasks — present the plan first
- When unsure, treat as complex — the overhead of planning is always less than the cost of rework
- A task that touches >2 files is complex by definition`,
  },
  {
    id: "seed_prompt_engineering",
    title: "Prompt Engineering Principles",
    description: "System prompt structure, XML tag usage, anti-hallucination, parallel agent design, verbosity control.",
    type: "fact",
    fragment: `## Prompt Engineering Principles

### Context
Prompt structure directly affects LLM output quality. Small structural changes produce disproportionate quality differences.

### 4-Section Prompt Template
1. **IDENTITY** — Who, domain expertise, scoring/output scale
2. **INSTRUCTIONS** — Rules, output format, coverage directive, grounding rule
3. **EXAMPLES** — 1-2 input/output pairs (more effective than negative instructions)
4. **CONTEXT** — Data, additional information

### XML Tag Usage
- Semantic XML tags for section separation: \`<identity>\`, \`<instructions>\`, \`<examples>\`
- Claude is fine-tuned to prioritize content within XML tags
- OpenAI also recommends markdown + XML combination

### Anti-Hallucination
- Add "Base your analysis ONLY on the provided data" instruction
- Require confidence score (0.0-1.0) on every output
- Evidence field: require direct quotes from source data
- "If uncertain, note uncertainty rather than guessing"
- Use structured output API (JSON schema) when available

### Parallel Agent Rules
- Every agent prompt must be fully self-contained (no cross-dependencies)
- Fan-out: Launch multiple agents simultaneously for independent tasks
- Generation pass and scoring/evaluation pass must be separate phases
- Do not spawn a subagent for work completable in a single response

### Verbosity Control
- Positive examples > negative instructions (show "do this" not "don't do that")
- Calibrate verbosity to complexity — short answers for simple questions
- No over-formatting: avoid unnecessary bold, headers, lists`,
  },
  {
    id: "seed_clean_code_modern",
    title: "Modern Clean Code (Agentic Era)",
    description: "Updated clean code for AI-assisted dev. SRP as context isolation, pragmatic DRY, LOB, type safety.",
    type: "fact",
    fragment: `## Modern Clean Code (Agentic Era)

### Context
AI-assisted development changes which code quality principles matter most. Traditional clean code advice must be updated for agentic workflows.

### Architectural Principles
- **SRP as Context Isolation:** Modules must stay within 4k-10k token windows for AI reasoning accuracy
- **Pragmatic DRY:** A little repetition > complex deep-dependency abstractions that confuse AI agents
- **Locality of Behavior (LOB):** Feature-grouping over role-grouping for faster context retrieval
- **Naming as Metadata:** Explicit, unambiguous naming is the primary signal for AI logic correlation

### Type Safety
- TypeScript/Rust strict type systems reduce AI hallucination rates by ~40% in refactoring
- Runtime validation (Zod, io-ts) mandatory at API boundaries
- Avoid any/unknown, define explicit types

### Structural Rules
- Functions should do one thing, stay under 50 lines
- Files over 300 lines should be considered for splitting
- Import depth maximum 3 levels
- Circular dependencies forbidden

### AI-Assisted Development Caveats
- AI-generated code produces 48% more duplicate blocks — be intentional
- Code churn increases from 3.1% to 5.7% with AI adoption — don't neglect refactoring
- AI tends to copy-paste instead of refactor — always check cross-file impact`,
  },
  {
    id: "seed_html_output_strategy",
    title: "HTML vs Markdown Output Strategy",
    description: "Context-aware format selection: use HTML for complex specs/diagrams/reports, Markdown for quick answers/code edits. Default: Markdown.",
    type: "pattern",
    related_guides: ["html-output-strategy"],
    fragment: `## HTML vs Markdown Output Strategy — Context-Aware Format Selection

### Context
LLMs default to Markdown output, but HTML is significantly more effective for certain task types. This decision framework selects the optimal format based on task purpose, audience, and longevity — maximizing readability without wasting tokens.

### Decision Framework

**Use HTML when:**
- Long spec, plan, or architecture document (>100 lines of structured content)
- Diagram, flowchart, or visualization needed (SVG support)
- Side-by-side comparison of 2+ approaches (grid/column layout)
- Report or document shared with team/stakeholders (link-shareable, browser-rendered)
- Interactive prototype with sliders, buttons, or live preview
- The user will revisit this output later as reference

**Use Markdown when:**
- Quick answers, chat-style responses, code edits
- Task lists, meeting notes, short summaries
- Version-controlled docs (README, CHANGELOG) — clean git diffs
- Rapid iteration / drafting phase
- Token efficiency matters (HTML costs 2-4x more tokens)

**Default: Markdown** — safe choice when uncertain.

### Rules
- NEVER default to HTML for every output — token cost is 2-4x higher
- NEVER use HTML for code edits, quick answers, or chat-style responses
- ALWAYS keep HTML files self-contained (no external CDN dependencies)
- If the user explicitly requests a format, honor it — skip the framework
- When switching to HTML, briefly note why (e.g., "HTML format for visual comparison")

### Anti-patterns
- Generating HTML for a 10-line summary (token waste)
- Using Markdown for a 200-line architectural spec (nobody reads dense Markdown)
- Adding interactivity when the user just wants to read (over-engineering)`,
  },
];

export function seedMemory(memory: MemoryFragment[]): { seeded: number; skipped: number } {
  const existingIds = new Set(memory.map(f => f.id));
  let seeded = 0;
  let skipped = 0;

  for (const seed of SEEDS) {
    if (existingIds.has(seed.id)) {
      skipped++;
      continue;
    }

    const now = new Date();
    const fragment: MemoryFragment = {
      id: seed.id,
      title: seed.title,
      description: seed.description,
      fragment: seed.fragment,
      project: null,
      confidence: 1.0,
      source: "ai",
      created: now.toISOString().split("T")[0] ?? "",
      lastAccessed: now.toISOString(),
      accessed: 0,
      tags: [SEED_TAG],
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
      type: seed.type,
      related_guides: seed.related_guides || [],
    };

    memory.push(fragment);
    seeded++;
    existingIds.add(seed.id);
  }

  if (seeded > 0) {
    logger.info(`Seeded ${seeded} new built-in entries (${skipped} already existed)`);
  }

  return { seeded, skipped };
}

export function getSeedCount(): number {
  return SEEDS.length;
}

export function getSeedIds(): string[] {
  return SEEDS.map(s => s.id);
}
