interface ToolProperty {
  type: string;
  description?: string;
  items?: { type: string };
  enum?: string[];
  default?: unknown;
}

interface ToolInputSchema {
  type: string;
  properties: Record<string, ToolProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "session_start",
    description: "Start a traced work session. Records task metadata and returns relevant guides and pre-loaded memories for the task.",
    inputSchema: {
      type: "object",
      properties: {
        task_type: {
          type: "string",
          description: "Type of task: 'debugging', 'implementation', 'refactoring', 'testing', 'research', 'documentation', 'optimization', or 'other'",
        },
        technologies: {
          type: "array",
          items: { type: "string" },
          description: "Technologies involved (e.g., ['react', 'typescript']). Optional.",
        },
        initial_approach: {
          type: "string",
          description: "Your initial plan or approach for this task. Optional.",
        },
      },
      required: ["task_type"],
    },
  },
  {
    name: "session_end",
    description: "End the current traced session. Records outcome, updates guide success/failure tracking, and generates improvement suggestions if patterns are detected.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: ["success", "partial", "failure", "abandoned"],
          description: "How the task turned out",
        },
        final_approach: {
          type: "string",
          description: "What approach actually worked (or didn't). Optional.",
        },
        lessons: {
          type: "array",
          items: { type: "string" },
          description: "What was learned during this session. Optional.",
        },
      },
      required: ["outcome"],
    },
  },
  {
    name: "memory_read",
    description: "Read memory fragments. SUMMARY MODE: Shows title + description only (not full content). Use id parameter to get full detail of a specific fragment. Use all=true to see fragments from all projects.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name to filter (optional, defaults to detected project)",
        },
        query: {
          type: "string",
          description: "Optional semantic search keyword. Supply only if you are looking for specific context.",
        },
        id: {
          type: "string",
          description: "Get FULL DETAIL for a specific fragment ID. Use this after seeing the summary to read the complete content.",
        },
        context: {
          type: "string",
          description: "Optional context tag for this access (e.g., 'debugging', 'refactoring'). Boosts confidence and tags the fragment for future recall.",
        },
        all: {
          type: "boolean",
          description: "If true, show fragments from all projects. Default: false (current project + global only)",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Get full details for multiple fragment IDs at once. Optional.",
        },
        minConfidence: {
          type: "number",
          description: "Minimum confidence threshold (0-1). Only return fragments with confidence >= this value. Optional.",
        },
        afterDate: {
          type: "string",
          description: "ISO date string (e.g., '2026-04-01'). Only return fragments created on or after this date. Optional.",
        },
        beforeDate: {
          type: "string",
          description: "ISO date string (e.g., '2026-04-30'). Only return fragments created on or before this date. Optional.",
        },
      },
    },
  },
  {
    name: "memory_add",
    description:
      "MANDATORY: Call this AFTER completing analysis/research to save findings. Synthesize information into short, reusable fragments.\n\nFRAGMENT SCHEMA — always follow this structure:\n## [Topic Title]\n\n### Context\n[1-2 sentences: what and why it matters]\n\n### [Content Section]\n- [Key fact 1]\n- [Key fact 2]\n\n### Rules (optional, for patterns/warnings)\n- [Absolute constraint]\n\nRULES:\n- ALWAYS store fragments in ENGLISH regardless of conversation language. This ensures search and retrieval works correctly.\n- Title: max 80 chars, start with topic name\n- Fragment: 30-2000 chars, structured markdown, NOT plain prose\n- Every fragment MUST have a ## heading and at least one ### section\n- Type: Choose based on nature:\n  * fact = technical info, API behavior, version details\n  * pattern = repeated solution, best practice, code pattern\n  * lesson = learned from experience, mistake, debugging insight\n  * warning = caution, gotcha, pitfall to avoid\n  * context = environment info, project setup, dependencies\n- Auto-title: If you omit title, first 40 chars of fragment used\n- Auto-description: First sentence extracted from fragment",
    inputSchema: {
      type: "object",
      properties: {
        fragment: {
          type: "string",
          description: "The memory fragment text to store. Follow this format:\n## [Topic Title]\n[1-2 sentences of context: what and why it matters]\n- [Key fact 1]\n- [Key fact 2]\n- [Constraint or note if any]\nKeep fragments between 30-2000 characters. Use structured markdown, not plain prose.",
        },
        title: {
          type: "string",
          description: "Short title for the memory (auto-generated if not provided). Max 80 characters.",
        },
        description: {
          type: "string",
          description: "Short description/summary (auto-generated if not provided). Max 150 characters.",
        },
        project: {
          type: "string",
          description: "Project scope (null = global, string = project-specific). Use current project name for project-specific info.",
          default: null,
        },
        source: {
          type: "string",
          description: "Source of the memory (default: 'ai')",
          default: "ai",
        },
        confirm: {
          type: "boolean",
          description: "Set to true to store fragment as-is even if secrets are detected. Default: false (auto-redacts).",
          default: false,
        },
        type: {
          type: "string",
          enum: ["fact", "pattern", "lesson", "warning", "context"],
          description: "Fragment type. 'fact'=technical info, 'pattern'=repeated solution, 'lesson'=learned from experience, 'warning'=caution/gotcha, 'context'=environment info. Default: 'fact'.",
        },
      },
      required: ["fragment"],
    },
  },
  {
    name: "memory_update",
    description: "Update an existing memory fragment by ID. Can update title, fragment text, confidence, or all.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the fragment to update",
        },
        title: {
          type: "string",
          description: "New title text (optional)",
        },
        fragment: {
          type: "string",
          description: "New fragment text (optional)",
        },
        confidence: {
          type: "number",
          description: "New confidence value 0-1 (optional)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_forget",
    description: "Remove a memory fragment by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the fragment to remove",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_feedback",
    description: "Provide feedback on a memory fragment after use. positive = the memory was useful (boosts confidence), negative = it was not helpful (reduces confidence by -0.1).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The ID of the fragment to give feedback on",
        },
        useful: {
          type: "boolean",
          description: "true if the memory was helpful, false if it was not relevant or incorrect",
        },
      },
      required: ["id", "useful"],
    },
  },
  {
    name: "memory_merge",
    description: "Merge multiple memory fragments into one. You decide the merged content, this tool just executes the merge. Use when you find related/overlapping fragments that should be consolidated.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of fragment IDs to merge (will be deleted after merge)",
        },
        title: {
          type: "string",
          description: "Title for the merged fragment",
        },
        fragment: {
          type: "string",
          description: "The merged content you prepared",
        },
        project: {
          type: "string",
          description: "Project scope (null = global, string = project-specific). Optional.",
          default: null,
        },
      },
      required: ["ids", "title", "fragment"],
    },
  },
  {
    name: "memory_relate",
    description:
      "Create a typed relation between two memory fragments. Bidirectional — reverse relation auto-created.\n\nRELATION TYPES — when to use each:\n- supports: Fragment A reinforces/validates Fragment B\n- contradicts: Fragment A contradicts/invalidates Fragment B\n- supersedes: Fragment A is newer and replaces Fragment B\n- related_to: General connection between fragments\n\nWHEN TO CALL:\n- After memory_add if you know this relates to an existing fragment\n- After memory_update if content changed significantly\n- After discovering two fragments are connected during analysis",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: {
          type: "string",
          description: "ID of the source fragment",
        },
        targetId: {
          type: "string",
          description: "ID of the target fragment",
        },
        type: {
          type: "string",
          enum: ["contradicts", "supersedes", "supports", "related_to"],
          description: "Type of relation",
        },
        note: {
          type: "string",
          description: "Optional note explaining the relation",
        },
      },
      required: ["sourceId", "targetId", "type"],
    },
  },
  {
    name: "memory_stats",
    description: "Get memory store statistics: fragment counts, average confidence, project breakdown, and health metrics.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name to filter stats (optional, defaults to all projects)",
        },
      },
    },
  },
  {
    name: "memory_audit",
    description: "Audit memory store for integrity issues: orphan references, duplicate IDs, confidence anomalies.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "guide_get",
    description: "Get guides with usage statistics. Returns guides sorted by usage count (most used first). Use task parameter to get suggestions based on a task description.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category (web-frontend, web-backend, dev-tool, etc.). Optional.",
        },
        guide: {
          type: "string",
          description: "Get detail for a specific guide name. Optional.",
        },
        task: {
          type: "string",
          description: "Task description to get relevant guide suggestions (e.g., 'react component with hooks', 'nodejs api'). Optional.",
        },
      },
    },
  },
  {
    name: "guide_practice",
    description:
      "MANDATORY: Record guide usage - increments usage count, updates last_used date, and adds contexts/learnings. Call this when you use a guide during work.\n\nTEMPLATE:\n- guide: technology/method name (e.g., \"react\", \"git\", \"seo\")\n- category: web-frontend | web-backend | dev-tool | programming-language | data-storage | ...\n- contexts: WHERE you used it (e.g., [\"hooks\", \"state\", \"effects\"])\n- learnings: WHAT you discovered (e.g., [\"useCallback prevents re-renders\"])\n\nIf guide doesn't exist, it will be auto-created.\nCall this AFTER applying knowledge from a guide or memory fragment.",
    inputSchema: {
      type: "object",
      properties: {
        guide: {
          type: "string",
          description: "Guide name (e.g., 'react', 'python', 'git')",
        },
        category: {
          type: "string",
          description: "Category: web-frontend, web-backend, dev-tool, programming-language, data-storage, etc.",
        },
        description: {
          type: "string",
          description: "Detailed description, manual, or protocols for the guide. Optional.",
        },
        contexts: {
          type: "array",
          items: { type: "string" },
          description: "REQUIRED: Contexts where this guide was used (e.g., ['hooks', 'state']). Provide at least one context or empty array [].",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "REQUIRED: New learnings discovered during use (e.g., ['useCallback prevents re-renders']). Provide at least one learning or empty array [].",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure"],
          description: "Optional outcome when using this guide. Tracks success rate.",
        },
      },
      required: ["guide", "category", "contexts", "learnings"],
    },
  },
  {
    name: "guide_create",
    description: "Definition mode: Create a new guide with a detailed manual, mission, and protocols. Use this to establish a reusable framework for a specific technology or methodology.",
    inputSchema: {
      type: "object",
      properties: {
        guide: {
          type: "string",
          description: "Guide name (e.g., 'X Viral Growth Engine', 'TDD Workflow')",
        },
        category: {
          type: "string",
          description: "Category: web-frontend, web-backend, dev-tool, programming-language, data-storage, etc.",
        },
        description: {
          type: "string",
          description: "The full manual for this guide. Follow this schema:\n\n## [Name] — [Subtitle]\n\n### Mission\n[Single sentence: what to achieve]\n\n### Protocol\n1. **[STEP]:** [action and expected outcome]\n2. **[STEP]:** [action and expected outcome]\n...\n\n### [Optional Section]\n[Relevant tables, templates, or reference data]\n\n### Rules\n- [Absolute rule 1]\n- [Absolute rule 2]\n- [Absolute rule 3]",
        },
        contexts: {
          type: "array",
          items: { type: "string" },
          description: "Initial contexts (optional).",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "Initial learnings (optional).",
        },
      },
      required: ["guide", "category", "description"],
    },
  },
  {
    name: "guide_distill",
    description:
      "Transform a memory fragment (static fact) into a guide's learning (procedural knowledge). Use this when a learned piece of information should become part of a permanent capability.\n\nWHEN TO CALL: After memory_add with type=\"pattern\" or type=\"lesson\". These fragment types represent reusable knowledge that should be promoted to a guide.\n\nTEMPLATE:\n- memory_id: The fragment ID to distill (e.g., \"m2a5d0cde45ce\")\n- guide: Target guide name — use technology name (e.g., \"react\", \"git\")\n- category: Required only if creating a new guide\n\nThe memory and guide will be bidirectionally linked automatically.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "ID of the memory fragment to distill",
        },
        guide: {
          type: "string",
          description: "Target guide name (e.g., 'react', 'git'). If it doesn't exist, it will be created.",
        },
        category: {
          type: "string",
          description: "Category for the guide (required only if creating a new guide).",
        },
      },
      required: ["memory_id", "guide"],
    },
  },
  {
    name: "guide_update",
    description: "Update an existing guide's basic properties (name, category, description).",
    inputSchema: {
      type: "object",
      properties: {
        guide: {
          type: "string",
          description: "Current name of the guide to update",
        },
        new_name: {
          type: "string",
          description: "New name for the guide (optional)",
        },
        category: {
          type: "string",
          description: "New category for the guide (optional)",
        },
        description: {
          type: "string",
          description: "New description/manual for the guide (optional)",
        },
        add_anti_patterns: {
          type: "array",
          items: { type: "string" },
          description: "Add anti-patterns to this guide. Optional.",
        },
        add_pitfalls: {
          type: "array",
          items: { type: "string" },
          description: "Add known pitfalls to this guide. Optional.",
        },
        superseded_by: {
          type: "string",
          description: "Mark this guide as superseded by another guide name. Optional.",
        },
        deprecated: {
          type: "boolean",
          description: "Mark this guide as deprecated. Optional.",
        },
      },
      required: ["guide"],
    },
  },
  {
    name: "guide_forget",
    description: "Remove a guide from the persistent database.",
    inputSchema: {
      type: "object",
      properties: {
        guide: {
          type: "string",
          description: "Name of the guide to remove",
        },
      },
      required: ["guide"],
    },
  },
  {
    name: "guide_merge",
    description: "Merge multiple guides into one. You decide the merged content (description, contexts, learnings). Usage counts are summed. Use when you find overlapping guides that should be consolidated.",
    inputSchema: {
      type: "object",
      properties: {
        guides: {
          type: "array",
          items: { type: "string" },
          description: "Array of guide names to merge (will be deleted after merge)",
        },
        guide: {
          type: "string",
          description: "Name for the merged guide",
        },
        category: {
          type: "string",
          description: "Category for the merged guide",
        },
        description: {
          type: "string",
          description: "Merged description/manual (optional, can be empty)",
        },
        contexts: {
          type: "array",
          items: { type: "string" },
          description: "Merged contexts (optional, will auto-merge from source guides if not provided)",
        },
        learnings: {
          type: "array",
          items: { type: "string" },
          description: "Merged learnings (optional, will auto-merge from source guides if not provided)",
        },
      },
      required: ["guides", "guide", "category"],
    },
  },
  {
    name: "memory_library",
    description: `Library Mode: Analyze and organize your entire memory database. Returns a comprehensive snapshot with all fragments, guides, relations, pre-computed analysis signals (stale, duplicate, orphan detection), and suggested actions. After reviewing the snapshot, use other tools (memory_merge, memory_forget, memory_update, guide_distill, memory_relate) to execute organizational changes.\n\nWHEN TO CALL:\n- Periodically to maintain a clean, well-organized knowledge base\n- When memory feels cluttered or redundant\n- After a long project with many fragments added\n- To find distill candidates that haven't been promoted to guides`,
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter to a specific project. Omit to analyze ALL projects.",
        },
        focus: {
          type: "string",
          enum: ["full", "stale", "duplicates", "orphans", "distill", "guides"],
          description: "Focus area. 'full' = complete snapshot (default). Other values return only relevant sections.",
        },
      },
    },
  },
  {
    name: "session_stats",
    description: "Get virtual session statistics: recent tool usage patterns, technologies encountered, and memory activity.",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of recent sessions to analyze (default 10)",
        },
      },
    },
  },
  {
    name: "conflict_scan",
    description: "Scan memories for contradictions. Detects opposing sentiments, negation conflicts, and contradicting claims across the knowledge base. Returns pairs of conflicting memories with overlap scores.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter to a specific project. Omit to scan all memories.",
        },
      },
    },
  },
  {
    name: "proactive_analysis",
    description: "Run proactive intelligence analysis on the knowledge base. Detects recurring patterns, suggests guide distillation, identifies stale/isolated memories, and recommends cleanup actions. This is the autonomous intelligence layer.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Filter to a specific project. Omit to analyze all.",
        },
      },
    },
  },
  {
    name: "project_analytics",
    description: "Get cross-session analytics for a project. Tracks knowledge growth rate, skill evolution, session outcomes, and overall project health. Shows how the AI's understanding of a project has evolved over time.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project name to analyze. Omit to see all projects overview.",
        },
      },
    },
  },
  {
    name: "semantic_search",
    description: "Search memories using TF-IDF semantic similarity. Finds related memories even when different words are used. Unlike FTS5 keyword search, this understands topic similarity. Use when keyword search fails to find related knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The text to find semantically similar memories for.",
        },
        project: {
          type: "string",
          description: "Filter to a specific project. Omit to search all.",
        },
        topK: {
          type: "number",
          description: "Maximum results to return (default 10, max 30).",
        },
      },
      required: ["query"],
    },
  },
];
