import type { Guide } from "../types.js";
import { logger } from "../logger.js";

interface SeedGuide {
  guide: string;
  category: string;
  keywords: string[];
  description: string;
  contexts: string[];
  learnings: string[];
  anti_patterns: string[];
  known_pitfalls: string[];
  source_memories?: string[];
}

const SEED_GUIDES: SeedGuide[] = [
  {
    guide: "error-handling",
    category: "dev-tool",
    keywords: ["error", "exception", "try catch", "hata", "crash", "fallback", "retry"],
    contexts: ["error boundaries", "graceful degradation", "retry logic"],
    learnings: [
      "Always wrap external calls (API, DB, filesystem) in try-catch with specific error types",
      "Log the full error object, not just the message — stack traces save debugging hours",
      "Distinguish between recoverable (network timeout) and unrecoverable (syntax error) errors",
      "Never catch and swallow errors silently — at minimum log at warn level",
    ],
    anti_patterns: [
      "Bare catch blocks that silently swallow errors",
      "Returning null/undefined on error without logging — caller can't distinguish null-result from error",
      "Catching Error base class when specific subtypes are available",
      "Throwing strings instead of Error objects — loses stack trace",
    ],
    known_pitfalls: [
      "Async errors in event handlers are uncaught unless wrapped in try-catch",
      "Promise.catch without return swallows the error chain",
      "Error serialization loses stack traces — use error.message + error.stack explicitly",
    ],
    description: `## Error Handling — Resilient Code Patterns

### Mission
Write code that fails gracefully, recovers when possible, and provides actionable debugging information when it can't.

### Protocol
1. **Classify the error first:** Is this recoverable (network, timeout, rate-limit) or fatal (logic bug, bad data, auth)?
2. **Recoverable errors:** Retry with exponential backoff (2^n × base_delay, max 3 attempts). Log each attempt at debug level.
3. **Fatal errors:** Fail fast with a clear message. Include: what failed, why (if known), and what the caller should do.
4. **Boundary errors:** At system boundaries (API routes, CLI entry, event handlers), catch all errors and format for the consumer (HTTP status, exit code, error event).
5. **Never assume happy path:** Every external dependency call gets error handling. Every.

### Error Response Template
\`\`\`
[Context] failed: [specific reason]
Expected: [what should have happened]
Actual: [what happened instead]
Suggestion: [how to fix or work around]
\`\`\`

### Rules
- If a function can fail, its return type must reflect that (Result<T,E>, thrown exception, or null with error log)
- Error messages are for developers, not users — be technical and specific in logs, friendly in UI
- One try-catch per logical operation, not one per file`,
  },
  {
    guide: "debugging",
    category: "dev-tool",
    keywords: ["debug", "debugging", "hata ayıklama", "investigate", "troubleshoot", "root cause", "sos"],
    contexts: ["root cause analysis", "binary search debugging", "reproduction"],
    learnings: [
      "Reproduce the bug first — never debug from assumptions",
      "Binary search the code: halve the suspicious range with each test",
      "Check the logs before adding console.log — the answer is often already there",
      "The bug is almost never where you think it is — follow the data, not your intuition",
      "git bisect is the most underused debugging tool for regression bugs",
    ],
    anti_patterns: [
      "Changing random things until it works — you learn nothing and often introduce new bugs",
      "Debugging in production without a hypothesis — changes become undiagnosable",
      "Ignoring flaky tests — they are real bugs expressing themselves nondeterministically",
      "Adding console.log everywhere instead of using a debugger or structured logging",
    ],
    known_pitfalls: [
      "Heisenbug: adding debug logging changes timing and hides the bug",
      "Caching: the code change worked but stale cache shows the old behavior",
      "Environment difference: works locally, fails in CI — check Node version, env vars, file paths",
    ],
    description: `## Debugging — Systematic Root Cause Analysis

### Mission
Find the exact root cause of a bug in minimum steps, without introducing new bugs.

### Protocol
1. **REPRODUCE:** Get a minimal, reliable reproduction. If you can't reproduce it, you can't verify the fix.
2. **HYPOTHESIZE:** Form a specific hypothesis: "The bug occurs because X returns Y instead of Z at line N."
3. **ISOLATE:** Binary search — comment out half the suspicious code, test, repeat. Or use git bisect for regressions.
4. **VERIFY:** Confirm the hypothesis with a targeted test or log. One change, one observation.
5. **FIX:** Minimal fix that addresses the root cause, not the symptom.
6. **PREVENT:** Add a regression test. If the bug class is general, add a lint rule or type constraint.

### Time Budget
- 15 min: Reproduce + hypothesis
- 30 min: Isolate root cause
- If not found in 30 min: Step back, re-read the error message carefully, check dependencies, ask for help

### Rules
- Never fix a bug you don't fully understand — you'll create two bugs
- The fix should be smaller than the debugging effort — if it's not, you're patching symptoms
- Always add a failing test before the fix — proves the bug exists and prevents regression`,
  },
  {
    guide: "refactoring",
    category: "dev-tool",
    keywords: ["refactor", "refactoring", "yeniden düzenleme", "cleanup", "restructure", "simplify"],
    contexts: ["safe refactoring", "incremental improvement", "code health"],
    learnings: [
      "Refactor in the smallest possible steps — each step must leave the code working",
      "If tests don't exist, write characterization tests BEFORE refactoring — they pin current behavior",
      "Rename → Extract → Simplify — this order minimizes risk",
      "A function that needs a comment to explain what it does should be renamed instead",
      "The best refactoring is deletion — if code isn't used, remove it",
    ],
    anti_patterns: [
      "Rewrite instead of refactor — starting from scratch almost always takes longer than expected",
      "Refactoring without tests — you will break things and not notice",
      "Mixed refactoring + behavior change in one commit — impossible to bisect later",
      "Premature abstraction — DRY applied to code that isn't actually duplicated, just similar-looking",
    ],
    known_pitfalls: [
      "Changing public API signatures breaks consumers you don't know about",
      "Moving code between files breaks import paths across the codebase",
      "Extracting a function changes 'this' context in class methods",
      "Merging similar-but-not-identical code requires careful parameterization",
    ],
    description: `## Refactoring — Safe Incremental Code Improvement

### Mission
Improve code structure without changing behavior. Every step must be safe, verifiable, and reversible.

### Protocol
1. **GREEN:** Ensure all tests pass before starting. If no tests exist, write characterization tests first.
2. **PLAN:** Identify the specific smell (long function, god class, feature envy, etc.) and the ONE refactoring move that addresses it.
3. **EXECUTE:** Apply ONE refactoring technique. Run tests. Commit if green.
4. **REPEAT:** Next smell, next move. Never batch multiple refactorings.

### Refactoring Moves (Ordered by Safety)
1. **Rename** (variable, function, file) — safest, use IDE rename symbol
2. **Extract Function** — identify a coherent block, give it a name
3. **Introduce Parameter** — replace magic values with function parameters
4. **Move Function** — relocate to the module where it belongs
5. **Inline Function** — remove indirection that no longer earns its keep
6. **Replace Conditional with Polymorphism** — for complex switch/if-else chains

### Rules
- ONE refactoring per commit — bisectable history is non-negotiable
- If tests fail after a refactoring step, REVERT immediately — don't fix-forward during refactoring
- Behavior preservation is absolute — any behavior change, intentional or not, disqualifies it as refactoring
- Stop when the code communicates intent clearly — don't refactor for aesthetic perfection`,
  },
  {
    guide: "html-output-strategy",
    category: "content-formatting",
    keywords: ["html", "markdown", "output", "format", "spec", "report", "diagram", "visualization", "görselleştirme", "rapor"],
    contexts: ["format selection", "output quality", "information density", "visual clarity", "document sharing"],
    learnings: [
      "HTML is 2-4x more token-expensive than Markdown — only use when the visual payoff justifies it",
      "Nobody reads 100+ line Markdown specs — HTML with visual structure gets actually reviewed",
      "Self-contained HTML files (no CDN) are shareable via a single link — Markdown requires special viewers",
      "Interactive HTML prototypes (sliders, buttons) enable two-way feedback loops with the LLM",
      "When in doubt, default to Markdown — HTML should be an intentional choice, not the default",
    ],
    anti_patterns: [
      "Generating HTML for every output regardless of complexity — wastes tokens and slows iteration",
      "Using Markdown for 200+ line architectural specs — information density becomes unreadable",
      "Adding JavaScript interactivity to documents meant for passive reading — over-engineering",
      "External CDN dependencies in HTML files — breaks offline and reduces portability",
    ],
    known_pitfalls: [
      "HTML diff noise in version control — use Markdown for git-tracked docs",
      "Over-designing HTML output when the task just needs a quick answer",
      "Forgetting to make HTML responsive — mobile viewing breaks without basic CSS",
    ],
    source_memories: ["seed_html_output_strategy"],
    description: `## HTML vs Markdown Output Strategy — Context-Aware Format Selection

### Mission
Select the optimal output format (HTML or Markdown) based on the task's purpose, audience, and longevity — maximizing readability and impact without wasting tokens.

### Protocol

1. **ASSESS the task:** Before generating output, ask three questions:
   - Will this output be read again later or shared with others? (longevity)
   - Does it benefit from visual structure (tables, diagrams, side-by-side comparisons)? (richness)
   - Is the user going to interact with it or just consume it? (interactivity)

2. **DECIDE the format:**

   | Condition | Format | Reason |
   |---|---|---|
   | Short answer, quick task, code edit | Markdown | Speed, token efficiency |
   | Long spec, plan, architecture doc | HTML | Readability, visual hierarchy |
   | Diagram, flowchart, visualization needed | HTML | SVG, CSS layout |
   | Side-by-side comparison (2+ approaches) | HTML | Grid/column layout |
   | Report shared with team or stakeholders | HTML | Link-sharing, browser-rendered |
   | Interactive prototype or parameter tuning | HTML | Sliders, buttons, live preview |
   | Version-controlled documentation | Markdown | Clean git diffs |
   - When in doubt → Markdown (default safe choice)

3. **EXECUTE with quality:**
   - If HTML: include basic responsive CSS, semantic structure, clean design. Single self-contained file.
   - If Markdown: keep it concise, use headers/tables/code blocks properly.

4. **COMMUNICATE the choice:** If switching to HTML for a non-obvious reason, briefly note why.

### Rules
- NEVER default to HTML for every output — token cost is 2-4x higher
- NEVER use HTML for code edits, quick answers, or chat-style responses
- ALWAYS keep HTML files self-contained (no external CSS/JS CDN links)
- ALWAYS consider the user's implicit intent: "make a plan" → probably HTML, "fix this bug" → Markdown
- If the user explicitly requests a format → honor it, skip the decision framework`,
  },
];

export function seedGuides(guides: Guide[]): { seeded: number; skipped: number } {
  const existingNames = new Set(guides.map(g => g.guide.toLowerCase()));
  let seeded = 0;
  let skipped = 0;

  for (const seed of SEED_GUIDES) {
    if (existingNames.has(seed.guide.toLowerCase())) {
      skipped++;
      continue;
    }

    const now = new Date();
    const guide: Guide = {
      id: "gs_" + seed.guide.toLowerCase().replace(/[^a-z0-9]/g, "_"),
      guide: seed.guide.toLowerCase(),
      category: seed.category,
      description: seed.description,
      usage_count: 0,
      auto_usage_count: 0,
      last_used: now.toISOString(),
      contexts: seed.contexts,
      learnings: seed.learnings,
      success_count: 0,
      failure_count: 0,
      anti_patterns: seed.anti_patterns,
      known_pitfalls: seed.known_pitfalls,
      last_refined: null,
      depends_on: [],
      enables: [],
      superseded_by: null,
      deprecated: false,
      source_memories: seed.source_memories || [],
      validated_by: [],
    };

    guides.push(guide);
    seeded++;
    existingNames.add(seed.guide.toLowerCase());
  }

  if (seeded > 0) {
    logger.info(`Seeded ${seeded} new guide entries (${skipped} already existed)`);
  }

  return { seeded, skipped };
}

export function getGuideSeedCount(): number {
  return SEED_GUIDES.length;
}
