# Library Mode Implementation Plan

## 1. Overview

Library Mode (`memory_library`) is a maintenance operation where the LLM acts as a librarian over its own memory database. The system collects a comprehensive analytical snapshot of the entire database, presents it as structured context to the LLM, and the LLM decides what organizational actions to take — merging duplicates, deleting noise, distilling patterns into guides, archiving stale entries, re-typing misclassified fragments, and creating missing relations.

**Key principle:** The LLM is the semantic engine. The system provides data and signals; the LLM provides judgment.

**Flow:**
1. LLM calls `memory_library` (or user triggers via `-lib` flag)
2. System collects a full analytical snapshot from SQLite
3. Snapshot is returned as structured text to the LLM
4. LLM analyzes and issues multiple follow-up tool calls (merge, forget, update, distill, relate)
5. Changes are applied via existing MCP tools

---

## 2. Architecture

### Where It Fits

```
src/
  db/
    library-store.ts          ← NEW: snapshot & signal queries
  server/
    tools.ts                  ← MODIFY: add memory_library tool definition
    handlers.ts               ← MODIFY: add handleMemoryLibrary handler
    system-prompt.ts          ← MODIFY: add library mode section to BASE_SYSTEM_PROMPT
    index.ts                  ← MODIFY: (no change needed, handleCallTool already dispatches)
```

### Layering

Library Mode follows the same pattern as existing tools:

```
MCP Tool Definition (tools.ts)
       ↓
Handler (handlers.ts)
       ↓
Store Functions (db/library-store.ts)
       ↓
SQLite via LemmaDB (db/database.ts)
```

The handler calls `library-store.ts` functions to collect the snapshot, formats it, and returns it. The LLM then uses existing tools (`memory_merge`, `memory_forget`, `memory_update`, `guide_distill`, etc.) to execute changes.

---

## 3. Data Snapshot — Structure Returned to LLM

The `memory_library` tool returns a single text block with these sections:

### 3.1 Header

```
== LIBRARY MODE SNAPSHOT ==
Generated: 2026-04-30T12:00:00Z
Total memories: 42 | Total guides: 5 | Total sessions: 18
Database health: HEALTHY (0 issues)
```

### 3.2 Memory Fragment Index

For every memory fragment in the database (all projects, no filtering):

```
== MEMORY FRAGMENTS (42) ==

ID            | Type     | Project  | Conf  | Age(days) | Access | Feedback | Distill | Relations | Title
m3a4b5c6d7e8  | fact     | lemma    | 0.95  | 2         | 8      | +2/-0    | no      | 3         | Lemma Project Architecture
m1f2e3d4c5b6  | pattern  | null     | 0.82  | 15        | 3      | +1/-0    | YES     | 1         | FTS5 Migration Search Fallback
m7a8b9c0d1e2  | lesson   | lemma    | 0.45  | 60        | 0      | +0/-2    | no      | 0         | Old Debugging Approach
...
```

Fields per fragment:
- `ID` — legacy_id (e.g., `m3a4b5c6d7e8`)
- `Type` — fragment type (fact/pattern/lesson/warning/context)
- `Project` — project name or `null` for global
- `Conf` — confidence (0.00–1.00)
- `Age(days)` — days since `created_at`
- `Access` — `access_count`
- `Feedback` — `positive_feedback`/`negative_feedback`
- `Distill` — whether `distill_candidate` flag is set
- `Relations` — count of outgoing relations
- `Title` — fragment title (truncated to 60 chars)

### 3.3 Guide Index

```
== GUIDES (5) ==

Name          | Category  | Usage | Success Rate | Learnings | Deprecated | Source Mems
refactoring   | dev-tool  | 4     | 4/4 (1.00)   | 3         | no         | 0
react         | web-front | 2     | 1/2 (0.50)   | 5         | no         | 1
debugging     | dev-tool  | 0     | 0/0 (N/A)    | 2         | no         | 0
...
```

### 3.4 Relation Graph Summary

```
== RELATIONS (28 total) ==

Type          | Count
supports      | 8
related_to    | 15
supersedes    | 2
contradicts   | 1
superseded_by | 2

Isolated fragments (0 relations): 12
Hub fragments (5+ relations): 2
  - m3a4b5c6d7e8 (8 relations): Lemma Project Architecture
  - m5eed4a8159c (6 relations): Lemma Logic Bugs
```

### 3.5 Pre-computed Analysis Signals

```
== ANALYSIS SIGNALS ==

Confidence Distribution:
  [0.0-0.2]: 3  ██████
  [0.2-0.4]: 5  ██████████
  [0.4-0.6]: 8  ████████████████
  [0.6-0.8]: 12 ██████████████████████████
  [0.8-1.0]: 14 ████████████████████████████████

Age Distribution:
  < 7 days:   8   ████████████████
  7-30 days:  15  █████████████████████████████████
  30-90 days: 12  ████████████████████████
  > 90 days:  7   ██████████████

Stale Fragments (0 access, > 30 days old, confidence < 0.5): 5
  - m7a8b9c0d1e2 (age: 60d, conf: 0.45): Old Debugging Approach
  - ...

Similarity Candidates (word overlap >= 0.4 between pairs): 3 pairs
  - m3a4b5c6d7e8 <-> m5eed4a8159c (overlap: 0.52)
  - ...

Distill Candidates (flagged but not yet distilled): 4
  - m1f2e3d4c5b6: FTS5 Migration Search Fallback
  - ...

Low-performing Guides (usage >= 3, success rate < 0.4): 1
  - debugging: 0/3 success rate

Project Distribution:
  lemma: 25
  null (global): 12
  other-project: 5

Type Distribution:
  fact: 18 | pattern: 8 | lesson: 7 | warning: 4 | context: 5

Orphan Detection:
  Orphan relations (target deleted): 0
  Dangling guide links (memory deleted): 1
    - guide "react" references deleted memory m000dead0000
```

### 3.6 Session Activity Summary

```
== SESSION ACTIVITY ==

Recent sessions (last 30 days): 12
Outcomes: success: 8, partial: 2, failure: 1, abandoned: 1
Most accessed memories (last 30 days): m3a4b5c6d7e8 (6x), m1f2e3d4c5b6 (4x)
Never-accessed memories: 7
```

### 3.7 Recommended Actions

```
== SUGGESTED ACTIONS ==

HIGH PRIORITY:
1. STALE: 5 fragments have 0 access, >30 days old, confidence < 0.5 — consider memory_forget or memory_update
2. DISTILL: 4 fragments flagged as distill_candidate — use guide_distill to promote them
3. DUPLICATE: 3 pairs of similar fragments detected — consider memory_merge

MEDIUM PRIORITY:
4. RETYPE: Check if any fragments are misclassified (e.g., lessons stored as facts)
5. RELATE: 12 isolated fragments — check for missing semantic connections
6. GUIDE_CLEANUP: 1 guide has low success rate — consider guide_update or guide_forget
7. ORPHAN: 1 dangling guide-memory link — clean up with guide_update

LOW PRIORITY:
8. ARCHIVE: Fragments >90 days old with low confidence could be forgotten
9. REBALANCE: Confidence distribution is healthy — no major action needed
```

---

## 4. Pre-computed Signals — Complete List

These are computed by SQL queries in `library-store.ts`:

| Signal | SQL Source | Description |
|--------|-----------|-------------|
| **Confidence Distribution** | `SELECT CASE WHEN confidence BETWEEN 0 AND 0.2 THEN ...` | Histogram of confidence in 0.2 buckets |
| **Age Distribution** | `SELECT CASE WHEN julianday('now') - julianday(created_at) < 7 THEN ...` | Histogram of fragment ages |
| **Stale Fragments** | `WHERE access_count = 0 AND julianday('now') - julianday(created_at) > 30 AND confidence < 0.5` | Likely candidates for deletion |
| **Similarity Candidates** | FTS5 pairwise or word overlap in TypeScript | Pairs with high content overlap |
| **Distill Candidates** | `WHERE distill_candidate = 1` | Flagged but not yet distilled |
| **Low-performing Guides** | `WHERE usage_count >= 3 AND (success_count * 1.0 / usage_count) < 0.4` | Guides that fail often |
| **Isolated Fragments** | `LEFT JOIN relations ... WHERE relations.id IS NULL` | Fragments with 0 relations |
| **Hub Fragments** | `GROUP BY source_id HAVING COUNT(*) >= 5` | Highly connected fragments |
| **Orphan Relations** | `LEFT JOIN memories ... WHERE memories.id IS NULL` | Relations pointing to deleted fragments |
| **Dangling Guide Links** | `LEFT JOIN memories ON legacy_id IN (related_guides JSON)` | Guide references to deleted memories |
| **Never-accessed Memories** | `WHERE access_count = 0` | Never read since creation |
| **Most-accessed Memories** | `ORDER BY access_count DESC LIMIT 10` | Top accessed in last 30 days |
| **Type Distribution** | `SELECT type, COUNT(*) FROM memories GROUP BY type` | Count per fragment type |
| **Project Distribution** | `SELECT project, COUNT(*) FROM memories GROUP BY project` | Count per project |
| **Relation Type Distribution** | `SELECT type, COUNT(*) FROM relations GROUP BY type` | Count per relation type |
| **Session Outcomes** | `SELECT outcome, COUNT(*) FROM sessions GROUP BY outcome` | Recent session outcomes |
| **Deprecated Guides** | `WHERE deprecated = 1` | Guides marked deprecated |
| **Superseded Fragments** | `WHERE id IN (SELECT target_id FROM relations WHERE type = 'superseded_by')` | Fragments superseded by newer ones |

---

## 5. New MCP Tool — `memory_library` Definition

```typescript
{
  name: "memory_library",
  description: `Library Mode: Analyze and organize your entire memory database. Returns a comprehensive snapshot with all fragments, guides, relations, pre-computed analysis signals (stale, duplicate, orphan detection), and suggested actions. After reviewing the snapshot, use other tools (memory_merge, memory_forget, memory_update, guide_distill, memory_relate) to execute organizational changes.\n\nWHEN TO CALL:\n- Periodically to maintain a clean, well-organized knowledge base\n- When memory feels cluttered or redundant\n- After a long project with many fragments added\n- To find distill candidates that haven't been promoted to guides`,
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Filter to a specific project. Omit to analyze ALL projects. Default: null (all).",
        default: null,
      },
      focus: {
        type: "string",
        enum: ["full", "stale", "duplicates", "orphans", "distill", "guides"],
        description: "Focus area for analysis. 'full' = complete snapshot (default). Other values filter to only relevant sections.",
        default: "full",
      },
    },
  },
}
```

### Handler Args Interface

```typescript
interface MemoryLibraryArgs {
  project?: string | null;
  focus?: "full" | "stale" | "duplicates" | "orphans" | "distill" | "guides";
}
```

---

## 6. Implementation Steps — Ordered

### Step 1: Create `src/db/library-store.ts` (NEW FILE)

This is the core data collection module. All queries run against the SQLite database.

```typescript
// src/db/library-store.ts

import type { LemmaDB } from "./database.js";

export interface LibrarySnapshot {
  generated_at: string;
  total_memories: number;
  total_guides: number;
  total_sessions: number;
  health_status: string;
  fragments: FragmentSummary[];
  guides: GuideSummary[];
  relations: RelationSummary;
  signals: AnalysisSignals;
  session_activity: SessionActivity;
  suggestions: string[];
}

export interface FragmentSummary {
  id: string;
  title: string;
  type: string;
  project: string | null;
  confidence: number;
  age_days: number;
  access_count: number;
  positive_feedback: number;
  negative_feedback: number;
  distill_candidate: boolean;
  relation_count: number;
  fragment_preview: string; // first 80 chars
}

export interface GuideSummary {
  name: string;
  category: string;
  usage_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number | null;
  learning_count: number;
  deprecated: boolean;
  source_memory_count: number;
}

export interface RelationSummary {
  total: number;
  by_type: Record<string, number>;
  isolated_fragment_ids: string[];
  hub_fragments: Array<{ id: string; title: string; count: number }>;
  orphan_relation_count: number;
}

export interface AnalysisSignals {
  confidence_distribution: Record<string, number>;
  age_distribution: Record<string, number>;
  stale_fragments: Array<{ id: string; title: string; age_days: number; confidence: number }>;
  similarity_candidates: Array<{ id_a: string; id_b: string; title_a: string; title_b: string; overlap: number }>;
  distill_candidates: Array<{ id: string; title: string; type: string }>;
  low_performing_guides: Array<{ name: string; success_rate: number; usage: number }>;
  type_distribution: Record<string, number>;
  project_distribution: Record<string, number>;
  deprecated_guides: string[];
  superseded_fragments: string[];
  dangling_guide_links: Array<{ guide: string; memory_id: string }>;
  never_accessed_count: number;
}

export interface SessionActivity {
  recent_count: number;
  outcomes: Record<string, number>;
  most_accessed: Array<{ id: string; title: string; count: number }>;
  never_accessed_count: number;
}

export function collectLibrarySnapshot(
  db: LemmaDB,
  options?: { project?: string | null; focus?: string }
): LibrarySnapshot;

export function collectFragmentSummaries(
  db: LemmaDB,
  projectFilter?: string | null
): FragmentSummary[];

export function collectGuideSummaries(db: LemmaDB): GuideSummary[];

export function collectRelationSummary(db: LemmaDB): RelationSummary;

export function collectAnalysisSignals(
  db: LemmaDB,
  projectFilter?: string | null
): AnalysisSignals;

export function collectSessionActivity(db: LemmaDB): SessionActivity;

export function findSimilarPairs(
  fragments: FragmentSummary[],
  threshold?: number
): Array<{ id_a: string; id_b: string; title_a: string; title_b: string; overlap: number }>;

export function generateSuggestions(snapshot: LibrarySnapshot): string[];
```

#### Key SQL Queries (inside `library-store.ts`):

**Fragment Summaries:**
```sql
SELECT
  m.legacy_id as id,
  m.title,
  m.type,
  m.project,
  m.confidence,
  CAST(julianday('now') - julianday(m.created_at) AS INTEGER) as age_days,
  m.access_count,
  m.positive_feedback,
  m.negative_feedback,
  m.distill_candidate,
  COALESCE(rel.rel_count, 0) as relation_count,
  SUBSTR(m.fragment, 1, 80) as fragment_preview
FROM memories m
LEFT JOIN (SELECT source_id, COUNT(*) as rel_count FROM relations GROUP BY source_id) rel
  ON rel.source_id = m.id
[WHERE m.project = ? -- if project filter]
ORDER BY m.confidence DESC
```

**Confidence Distribution:**
```sql
SELECT
  CASE
    WHEN confidence < 0.2 THEN '0.0-0.2'
    WHEN confidence < 0.4 THEN '0.2-0.4'
    WHEN confidence < 0.6 THEN '0.4-0.6'
    WHEN confidence < 0.8 THEN '0.6-0.8'
    ELSE '0.8-1.0'
  END as bucket,
  COUNT(*) as count
FROM memories
GROUP BY bucket
ORDER BY bucket
```

**Stale Fragments:**
```sql
SELECT legacy_id, title,
  CAST(julianday('now') - julianday(created_at) AS INTEGER) as age_days,
  confidence
FROM memories
WHERE access_count = 0
  AND julianday('now') - julianday(created_at) > 30
  AND confidence < 0.5
ORDER BY confidence ASC
```

**Similarity Candidates (FTS5 approach):**
For each fragment, run FTS5 search against all others. This is expensive for large databases, so we use a TypeScript word-overlap approach instead (O(n²) but bounded to fragments with shared project scope). See `findSimilarPairs()`.

**Isolated Fragments:**
```sql
SELECT m.legacy_id
FROM memories m
LEFT JOIN relations r ON r.source_id = m.id
WHERE r.id IS NULL
```

**Hub Fragments:**
```sql
SELECT m.legacy_id, m.title, COUNT(r.id) as rel_count
FROM memories m
JOIN relations r ON r.source_id = m.id
GROUP BY m.id
HAVING rel_count >= 5
ORDER BY rel_count DESC
```

**Low-performing Guides:**
```sql
SELECT guide, success_count, failure_count, usage_count,
  CASE WHEN usage_count > 0 THEN CAST(success_count AS REAL) / usage_count ELSE NULL END as success_rate
FROM guides
WHERE usage_count >= 3 AND deprecated = 0
ORDER BY success_rate ASC
```

**Dangling Guide Links (TypeScript):**
Load all guides, parse their `source_memories` and `validated_by` JSON arrays, check each legacy_id exists in `memories`.

### Step 2: Add Tool Definition to `src/server/tools.ts` (MODIFY)

Add the `memory_library` tool definition to the `TOOLS` array:

```typescript
// Add to TOOLS array in tools.ts
{
  name: "memory_library",
  description: `Library Mode: Analyze and organize your entire memory database. Returns a comprehensive snapshot with all fragments, guides, relations, pre-computed analysis signals (stale, duplicate, orphan detection), and suggested actions. After reviewing the snapshot, use other tools (memory_merge, memory_forget, memory_update, guide_distill, memory_relate) to execute organizational changes.\n\nWHEN TO CALL:\n- Periodically to maintain a clean, well-organized knowledge base\n- When memory feels cluttered or redundant\n- After a long project with many fragments added\n- To find distill candidates that haven't been promoted to guides`,
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Filter to a specific project. Omit to analyze ALL projects. Default: null (all).",
      },
      focus: {
        type: "string",
        enum: ["full", "stale", "duplicates", "orphans", "distill", "guides"],
        description: "Focus area. 'full' = complete snapshot (default). Other values return only relevant sections for targeted maintenance.",
      },
    },
  },
},
```

### Step 3: Add Handler to `src/server/handlers.ts` (MODIFY)

Add args interface and handler function:

```typescript
// Add interface near other interfaces (around line 135)
interface MemoryLibraryArgs {
  project?: string | null;
  focus?: "full" | "stale" | "duplicates" | "orphans" | "distill" | "guides";
}

// Add handler function (before handleCallTool, around line 1578)
export async function handleMemoryLibrary(args?: MemoryLibraryArgs): Promise<ToolResult> {
  const project = args?.project ?? null;
  const focus = args?.focus ?? "full";

  logger.flow("memory_library", "start", { project, focus });

  // Get DB instance from memory core module
  const db = core.getDbInstance();

  const snapshot = collectLibrarySnapshot(db, { project, focus });

  const formatted = formatLibrarySnapshot(snapshot, focus);

  logger.flow("memory_library", "complete", {
    total_memories: snapshot.total_memories,
    total_guides: snapshot.total_guides,
    suggestions: snapshot.suggestions.length,
  });

  return {
    content: [{ type: "text", text: formatted }],
  };
}
```

Add `case "memory_library"` to the `handleCallTool` switch statement:

```typescript
case "memory_library": {
  const result = await handleMemoryLibrary(args as MemoryLibraryArgs);
  logger.response(name, !!result.isError, Date.now() - startTime);
  return result;
}
```

Also need to expose `getDbInstance()` from memory core — either:
- Option A: Export `getDbInstance` from `src/memory/core.ts` and `src/memory/index.ts`
- Option B: Create a new helper in `src/db/index.ts` that returns the DB

**Chosen: Option A** — add `getDbInstance` export from `src/memory/index.ts`.

### Step 4: Add Formatting Function

Add a `formatLibrarySnapshot` function to `src/db/library-store.ts`:

```typescript
export function formatLibrarySnapshot(snapshot: LibrarySnapshot, focus: string): string;
```

This function takes the snapshot data and produces the human-readable text format described in Section 3.

When `focus !== "full"`, only include relevant sections:
- `stale` → only header + stale fragments section
- `duplicates` → only header + similarity candidates section
- `orphans` → only header + orphan detection + relation summary
- `distill` → only header + distill candidates section
- `guides` → only header + guide index + low-performing guides

### Step 5: Update `src/memory/index.ts` and `src/memory/core.ts` (MODIFY)

Export `getDbInstance`:

```typescript
// In src/memory/index.ts, add:
export { getDbInstance } from "./core.js";
```

The function already exists as a private function in `core.ts`. Just add `export` keyword.

### Step 6: Update System Prompt (MODIFY `src/server/system-prompt.ts`)

Add a library mode section to `BASE_SYSTEM_PROMPT` inside `<knowledge_to_skill_pipeline>`:

```
<library_mode>
Periodic Maintenance — call memory_library to analyze your knowledge base health:
- Find and merge duplicate or overlapping fragments
- Delete stale/obsolete memories (low confidence, never accessed, old)
- Promote distill candidates to guides (guide_distill)
- Create missing relations between related fragments (memory_relate)
- Retype misclassified fragments (memory_update)
- Archive or update deprecated guides

When to run: After completing a major task, when memory feels cluttered, or periodically (e.g., weekly).
</library_mode>
```

### Step 7: No Change to `src/server/index.ts`

The `handleCallTool` switch statement dispatches to handlers. We only need to add a new case to the switch, which is in `handlers.ts`. The `index.ts` imports `handleCallTool` and delegates all tool routing to it. No change needed in `index.ts`.

### Step 8: Add `-lib` CLI Flag Support (MODIFY `src/server/index.ts`)

If the `-lib` flag is passed, automatically call `handleMemoryLibrary` at startup and output the result, then exit.

```typescript
// At the bottom of index.ts, before the startServer() call:
const libFlagIndex = process.argv.indexOf('-lib');
if (libFlagIndex !== -1) {
  // Run library mode in standalone mode
  initLogger();
  const db = core.getDbInstance();
  const snapshot = collectLibrarySnapshot(db);
  const formatted = formatLibrarySnapshot(snapshot, "full");
  console.log(formatted);
  process.exit(0);
}
```

Actually, since the MCP server communicates over stdio, the `-lib` flag is better handled as follows:
- When `-lib` is passed, the server starts normally but injects a library mode hint into the system prompt
- The LLM client sees the hint and calls `memory_library` on its own

**Revised approach:** Add `-lib` flag to `src/server/index.ts` that triggers an automatic `memory_library` call hint in the system prompt instructions. The actual execution is still done by the LLM calling the tool.

---

## 7. What Already Exists — Reusable Components

| Component | Location | What It Provides |
|-----------|----------|------------------|
| `getMemoryStats()` | `src/db/memory-store.ts:489` | Total, avg confidence, by source, by project, low/high confidence counts |
| `searchMemories()` | `src/db/memory-store.ts:236` | FTS5 search with project/type/confidence/date filters |
| `getRelations()` | `src/db/memory-store.ts:432` | Relations for a specific memory |
| `mergeMemories()` | `src/db/memory-store.ts:529` | Transactional merge with relation inheritance |
| `deleteMemory()` | `src/db/memory-store.ts:223` | Single memory deletion with CASCADE |
| `updateMemory()` | `src/db/memory-store.ts:155` | Partial update of memory fields |
| `decayMemories()` | `src/db/memory-store.ts:473` | Confidence decay for unaccessed memories |
| `listGuides()` | `src/db/guide-store.ts:111` | List guides with category filter |
| `mergeGuides()` | `src/db/guide-store.ts:326` | Guide merge with usage/learning consolidation |
| `findSimilarGuide()` | `src/db/guide-store.ts:533` | FTS5 similar guide detection |
| `getSessionStats()` | `src/db/session-store.ts:186` | Total, by outcome, avg duration, recent sessions |
| `auditMemory()` | `src/memory/core.ts:1043` | In-memory audit for orphan refs, duplicate IDs, confidence anomalies |
| `calculateStats()` | `src/memory/core.ts:994` | In-memory stats calculation |
| `LemmaDB` class | `src/db/database.ts:10` | WAL mode, prepared statement cache, sqlite-vec loaded |
| `rowToFragment()` | `src/memory/core.ts:576` | DB row → MemoryFragment mapping |
| `findSimilarFragment()` | `src/memory/core.ts:102` | Vector/FTS5/word-overlap similarity detection |
| `findTopicOverlaps()` | `src/memory/core.ts:238` | Topic overlap detection between fragments |
| `wordOverlapScore()` | `src/memory/core.ts:227` | Jaccard-like word overlap between two texts |
| Schema tables | `src/db/schema.ts` | All 14+ tables, indexes, FTS5, triggers |

---

## 8. What's Missing — New Code Needed

| Need | Solution | File |
|------|----------|------|
| **DB-level fragment summary query** | New SQL query returning all fragments with computed fields (age_days, relation_count) | `src/db/library-store.ts` |
| **Confidence/age distribution** | New SQL histogram queries | `src/db/library-store.ts` |
| **Stale fragment detection** | New SQL query (0 access, >30 days, <0.5 confidence) | `src/db/library-store.ts` |
| **Similarity candidate pairs** | TypeScript function using word overlap on fragment summaries | `src/db/library-store.ts` |
| **Isolated fragment detection** | New SQL query (LEFT JOIN relations) | `src/db/library-store.ts` |
| **Hub fragment detection** | New SQL query (GROUP BY HAVING >= 5) | `src/db/library-store.ts` |
| **Low-performing guide detection** | New SQL query (usage >= 3, success_rate < 0.4) | `src/db/library-store.ts` |
| **Dangling guide link detection** | TypeScript function checking guide source_memories against memories table | `src/db/library-store.ts` |
| **Snapshot aggregation function** | Orchestrates all queries into LibrarySnapshot | `src/db/library-store.ts` |
| **Formatting function** | Converts LibrarySnapshot → human-readable text | `src/db/library-store.ts` |
| **Suggestion generator** | Rule-based suggestion engine from signals | `src/db/library-store.ts` |
| **MCP tool definition** | `memory_library` in TOOLS array | `src/server/tools.ts` |
| **Handler function** | `handleMemoryLibrary` + args interface + switch case | `src/server/handlers.ts` |
| **DB instance exposure** | Export `getDbInstance` from core | `src/memory/core.ts`, `src/memory/index.ts` |
| **System prompt section** | `<library_mode>` documentation | `src/server/system-prompt.ts` |

---

## 9. Test Strategy

### 9.1 Unit Tests: `tests/db/library-store.test.ts`

Test each function independently with an in-memory or temp SQLite database:

```
describe("library-store", () => {
  // Setup: create temp DB, run migrations, seed test data

  test("collectFragmentSummaries returns all fragments with computed fields")
  test("collectFragmentSummaries filters by project")
  test("collectGuideSummaries includes success rate calculation")
  test("collectRelationSummary identifies isolated fragments")
  test("collectRelationSummary identifies hub fragments")
  test("collectRelationSummary detects orphan relations")
  test("collectAnalysisSignals computes confidence distribution")
  test("collectAnalysisSignals computes age distribution")
  test("collectAnalysisSignals identifies stale fragments")
  test("collectAnalysisSignals identifies distill candidates")
  test("collectAnalysisSignals identifies low-performing guides")
  test("findSimilarPairs detects high-overlap fragment pairs")
  test("findSimilarPairs ignores low-overlap pairs")
  test("generateSuggestions returns correct priority order")
  test("formatLibrarySnapshot produces valid text output")
  test("formatLibrarySnapshot respects focus filter")
  test("collectLibrarySnapshot with empty database returns valid structure")
  test("collectLibrarySnapshot with single fragment returns valid structure")
})
```

### 9.2 Integration Tests: `tests/server/library-handler.test.ts`

Test the handler through the MCP tool interface:

```
describe("memory_library handler", () => {
  test("returns full snapshot by default")
  test("returns filtered snapshot for stale focus")
  test("returns filtered snapshot for duplicates focus")
  test("returns filtered snapshot for orphans focus")
  test("returns filtered snapshot for distill focus")
  test("returns filtered snapshot for guides focus")
  test("filters by project when specified")
  test("includes all section headers in full mode")
  test("suggestions match detected issues")
})
```

### 9.3 Edge Cases to Test

- Empty database (0 memories, 0 guides)
- Single fragment (no relations, no overlaps)
- All fragments in one project
- All fragments global
- All guides deprecated
- Circular relations (A→B→C→A)
- Very long fragment text (truncation)
- Special characters in titles
- Database with only stale fragments
- Database with only high-confidence fragments

---

## 10. Risk Assessment

### 10.1 Performance Risk: Large Databases

**Risk:** The similarity candidate detection (`findSimilarPairs`) is O(n²) on fragment text. For 500+ fragments this could be slow.

**Mitigation:**
- Use FTS5 for initial filtering instead of pairwise comparison
- Only compare fragments within the same project scope
- Set a hard limit: skip similarity detection if fragment count > 200
- Use a `topK` parameter to limit pairs returned

### 10.2 Data Safety: Read-Only Operation

**Risk:** Library mode should NEVER modify data directly. It's a read-only analysis tool.

**Mitigation:**
- `collectLibrarySnapshot` uses only SELECT queries
- No write operations in `library-store.ts`
- All modifications happen through existing tools (merge, forget, update)
- Handler only returns data, never mutates

### 10.3 Token Budget

**Risk:** The full snapshot could be very large for databases with 100+ fragments.

**Mitigation:**
- Fragment table shows summary fields only (no full fragment text)
- Fragment preview truncated to 80 chars
- Title truncated to 60 chars
- Similarity pairs limited to top 20
- Focus mode allows targeted analysis to reduce output size
- Add token estimation and truncate if needed (follow existing pattern in `system-prompt.ts`)

### 10.4 Backward Compatibility

**Risk:** Adding a new tool could break existing MCP clients.

**Mitigation:**
- New tool is purely additive (no existing tools modified)
- `handleCallTool` default case returns "Unknown tool" for unrecognized tools (already exists)
- System prompt addition is informational only
- `-lib` flag is opt-in, default behavior unchanged

### 10.5 Stale Snapshot

**Risk:** The snapshot represents a point-in-time view. If the LLM takes too long to act, data may have changed.

**Mitigation:**
- Snapshot includes `generated_at` timestamp
- This is inherent to the design (the LLM acts based on what it sees)
- Acceptable risk — same pattern as `memory_stats` and `memory_audit`

---

## 11. File Change Summary

| File | Action | Lines Changed (est.) |
|------|--------|---------------------|
| `src/db/library-store.ts` | **CREATE** | ~350 lines |
| `src/server/tools.ts` | MODIFY | +30 lines |
| `src/server/handlers.ts` | MODIFY | +40 lines |
| `src/server/system-prompt.ts` | MODIFY | +15 lines |
| `src/memory/core.ts` | MODIFY | +1 line (export keyword) |
| `src/memory/index.ts` | MODIFY | +1 line |
| `tests/db/library-store.test.ts` | **CREATE** | ~200 lines |
| `tests/server/library-handler.test.ts` | **CREATE** | ~100 lines |

**Total new code:** ~550 lines
**Total modified code:** ~90 lines
**Total test code:** ~300 lines

---

## 12. Implementation Order

1. **Export `getDbInstance`** from `src/memory/core.ts` and `src/memory/index.ts` (1 line each)
2. **Create `src/db/library-store.ts`** with all types, queries, formatting, and suggestion generation
3. **Add `memory_library` tool definition** to `src/server/tools.ts`
4. **Add handler** (`handleMemoryLibrary` + switch case) to `src/server/handlers.ts`
5. **Add `<library_mode>` section** to `BASE_SYSTEM_PROMPT` in `src/server/system-prompt.ts`
6. **Write tests** for `library-store.ts` functions
7. **Write integration tests** for the handler
8. **Run full test suite** to verify no regressions
9. **Manual test** with a populated database
