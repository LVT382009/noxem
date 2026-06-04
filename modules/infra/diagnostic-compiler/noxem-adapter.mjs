/**
 * Noxem Adapter — Diagnostic Compiler
 *
 * Adapts Vercel zerolang compiler-as-AI-interface patterns into Noxem:
 *   - NoxemError class with code, message, expected, actual, repair fields
 *   - Versioned skill system (categorization rules, prompt templates, thresholds)
 *   - Content-hash validation on store (prevents stale-context writes)
 *   - Structured repair plans for maintenance (generate-then-execute)
 *   - Procedure dependency graph (procedure_deps table)
 *
 * Inspired by: github.com/vercel/zerolang (diagnostics, skill system, graphHash, fix --plan)
 * Designed for: Noxem v2.1 (better-sqlite3, ESM, Brain 1/2, SQLite WAL)
 */

import { createHash } from 'node:crypto';

// ══════════════════════════════════════════════════════════
// NoxemError — Structured Diagnostics with Repair Metadata
// ══════════════════════════════════════════════════════════

/**
 * Machine-readable error with stable code, mismatch metadata, and repair hints.
 * Designed after zerolang's diagnostic shape:
 *   { code, message, expected, actual, help, fixSafety, repair }
 */
export class NoxemError extends Error {
  /**
   * @param {object} opts
   * @param {string} opts.code        - Stable diagnostic code (e.g. 'STORE_001')
   * @param {string} opts.message     - Human-readable short summary
   * @param {string} [opts.expected]  - What was expected
   * @param {string} [opts.actual]    - What was received
   * @param {string} [opts.help]      - Concise next action
   * @param {string} [opts.fixSafety] - One of: format-only, behavior-preserving,
   *                                    local-edit, api-changing, requires-human-review
   * @param {object} [opts.repair]    - { id: string, summary: string }
   * @param {object} [opts.related]   - Additional spans or facts
   */
  constructor({ code, message, expected, actual, help, fixSafety, repair, related }) {
    super(message);
    this.name = 'NoxemError';
    this.code = code;
    this.expected = expected || '';
    this.actual = actual || '';
    this.help = help || '';
    this.fixSafety = fixSafety || 'requires-human-review';
    this.repair = repair || { id: 'manual-review', summary: 'Inspect the diagnostic fields and choose a repair manually.' };
    this.related = related || [];
  }

  /** Machine-readable JSON — stable, versioned shape for agents. */
  toJSON() {
    return {
      schemaVersion: 1,
      ok: false,
      diagnostic: {
        severity: 'error',
        code: this.code,
        message: this.message,
        expected: this.expected,
        actual: this.actual,
        help: this.help,
        fixSafety: this.fixSafety,
        repair: this.repair,
        related: this.related,
      },
    };
  }

  /** Human-readable multi-line diagnostic (terminal-safe, no ANSI). */
  toText() {
    const lines = [`error[${this.code}]: ${this.message}`];
    if (this.expected) lines.push(`expected: ${this.expected}`);
    if (this.actual)   lines.push(`actual:   ${this.actual}`);
    if (this.help)     lines.push(`help:     ${this.help}`);
    if (this.repair)   lines.push(`fix:      ${this.repair.summary} (${this.repair.id})`);
    lines.push(`safety:   ${this.fixSafety}`);
    return lines.join('\n');
  }
}

// ── Diagnostic Code Registry ──────────────────────────────

const DIAGNOSTIC_CODES = {
  // Store operations
  STORE_001: { message: 'Text exceeds maximum length', expected: 'text <= 10 MB', actual: 'text length exceeds limit', help: 'Split the memory text into smaller chunks', fixSafety: 'behavior-preserving', repair: { id: 'reduce-text-length', summary: 'Split text into smaller chunks and store separately' } },
  STORE_002: { message: 'System prompt content detected', expected: 'factual memory content', actual: 'system instruction or prompt text', help: 'Filter out system-prompt patterns before storing', fixSafety: 'behavior-preserving', repair: { id: 'strip-system-prompt', summary: 'Remove system instruction patterns from text before retry' } },
  STORE_003: { message: 'Storage-time duplicate detected', expected: 'unique content', actual: 'near-duplicate of existing memory', help: 'Use the existing memory ID instead', fixSafety: 'behavior-preserving', repair: { id: 'use-existing-memory', summary: 'Return existing memory ID, skip redundant store' } },
  STORE_004: { message: 'Required field missing', expected: 'text field provided', actual: 'empty or null text', help: 'Provide non-empty text content', fixSafety: 'format-only', repair: { id: 'provide-text', summary: 'Include a non-empty text field in the store request' } },

  // Search operations
  SEARCH_001: { message: 'No results found', expected: 'at least one matching memory', actual: 'empty result set', help: 'Try a broader query or different intent mode', fixSafety: 'behavior-preserving', repair: { id: 'broaden-query', summary: 'Use a more general query or switch to conceptual intent' } },
  SEARCH_002: { message: 'Query too short for meaningful search', expected: 'query with at least 2 characters', actual: 'query is empty or single character', help: 'Provide a longer, more descriptive query', fixSafety: 'format-only', repair: { id: 'expand-query', summary: 'Add more descriptive terms to the search query' } },

  // Conflict/precondition
  CONFLICT_001: { message: 'Stale context: entity state changed since last read', expected: 'current entity hash matches expected_hash', actual: 'entity hash differs — another write occurred', help: 'Re-read the entity state and retry with the new hash', fixSafety: 'requires-human-review', repair: { id: 're-read-and-retry', summary: 'Fetch the current entity state, update your context, then retry the store' } },

  // Pipeline operations
  PIPELINE_001: { message: 'L1 extraction failed', expected: 'successful LLM extraction', actual: 'LLM returned empty or error', help: 'Retry with fewer L0 memories or simpler prompt', fixSafety: 'behavior-preserving', repair: { id: 'retry-extraction', summary: 'Retry L1 extraction with a reduced L0 batch size' } },
  PIPELINE_002: { message: 'Insufficient L0 memories for extraction', expected: 'at least 1 L0 episode memory', actual: 'no L0 memories available', help: 'Store conversation memories first', fixSafety: 'format-only', repair: { id: 'wait-for-memories', summary: 'Wait for L0 memories to accumulate before running pipeline' } },

  // Maintenance operations
  MAINT_001: { message: 'Repair plan contains high-risk operations', expected: 'only safe merges and archives', actual: 'plan includes low-confidence supersessions', help: 'Review the repair plan before executing', fixSafety: 'requires-human-review', repair: { id: 'review-repair-plan', summary: 'Inspect the repair plan, remove risky items, then execute' } },

  // Memory graph
  GRAPH_001: { message: 'Broken edge reference', expected: 'from_id and to_id point to existing memories', actual: 'one or both endpoints are deleted or invalid', help: 'Remove broken edges or re-link to valid memories', fixSafety: 'behavior-preserving', repair: { id: 'cleanup-broken-edges', summary: 'Delete edges whose endpoints no longer exist' } },

  // Procedure
  PROC_001: { message: 'Circular procedure dependency', expected: 'acyclic dependency graph', actual: 'dependency cycle detected', help: 'Remove one edge from the cycle', fixSafety: 'api-changing', repair: { id: 'break-dep-cycle', summary: 'Remove the weakest dependency edge to break the cycle' } },
  PROC_002: { message: 'Procedure dependency not found', expected: 'depends_on_procedure_id references existing procedure', actual: 'referenced procedure does not exist', help: 'Create the missing procedure or remove the dependency', fixSafety: 'behavior-preserving', repair: { id: 'resolve-missing-dep', summary: 'Either create the missing procedure or remove the broken dependency' } },
};

/**
 * Create a NoxemError from a registered diagnostic code.
 * @param {string} code - Diagnostic code (e.g. 'STORE_001')
 * @param {object} [overrides] - Override any field from the registry
 * @returns {NoxemError}
 */
export function createDiagnostic(code, overrides = {}) {
  const registered = DIAGNOSTIC_CODES[code];
  if (!registered) {
    return new NoxemError({
      code: code || 'UNKNOWN',
      message: overrides.message || `Unknown diagnostic code: ${code}`,
      ...overrides,
    });
  }
  return new NoxemError({ code, ...registered, ...overrides });
}

/**
 * Explain a diagnostic code — returns detailed description + fix instructions.
 * Mirrors zerolang's `zero explain <code>` pattern.
 * @param {string} code - Diagnostic code
 * @returns {{ code: string, message: string, help: string, repair: object, fixSafety: string }}
 */
export function explainDiagnostic(code) {
  const reg = DIAGNOSTIC_CODES[code];
  if (!reg) return { code, message: `Unknown diagnostic code: ${code}`, help: '', repair: null, fixSafety: '' };
  return { code, ...reg };
}

/**
 * List all registered diagnostic codes.
 */
export function listDiagnosticCodes() {
  return Object.entries(DIAGNOSTIC_CODES).map(([code, def]) => ({
    code,
    message: def.message,
    fixSafety: def.fixSafety,
    repairId: def.repair?.id,
  }));
}

// ══════════════════════════════════════════════════════════
// Versioned Skill System
// ══════════════════════════════════════════════════════════

// Current Noxem skill set — versioned with the build
const NOXEM_SKILLS = {
  schemaVersion: 1,
  noxemVersion: '2.1.0',
  skills: {
    categorization: {
      description: 'Memory type categorization rules',
      validTypes: ['fact', 'preference', 'setup', 'project', 'goal', 'entity', 'profile', 'pattern', 'event', 'issue', 'learning', 'request', 'reasoning'],
      rules: [
        'Text containing "prefer", "like", "always use" -> preference',
        'Text containing project names, tech stacks -> project',
        'Text containing steps, how-to, workflow -> pattern',
        'Text containing error, bug, fix, broken -> issue',
        'Default: fact',
      ],
    },
    importance: {
      description: 'Importance estimation thresholds',
      rules: [
        'Core identity memories: 0.9',
        'Explicit preferences: 0.7',
        'Project facts: 0.6',
        'General facts: 0.5',
        'Event / episode: 0.3',
        'Default: 0.5',
      ],
    },
    extraction: {
      description: 'L0->L1 extraction prompt templates',
      mode: 'two-step',
      step1: 'Analyze conversations against existing L1 memories — identify new, duplicate, and contradictory facts',
      step2: 'Generate L1 atoms with source_memory_ids references to originating L0 episodes',
    },
    decay: {
      description: 'Weibull temporal decay parameters',
      halfLifeDays: 30,
      typeMultipliers: {
        fact: 1.0,
        preference: 1.5,
        event: 0.5,
        issue: 0.3,
      },
    },
    dedup: {
      description: 'Duplicate detection rules',
      threshold: 0.92,
      mergeThresholdLow: 0.90,
      mergeSeparator: '\\n---\\n',
      keepLongest: true,
    },
  },
};

let _skillsVersion = null;

/**
 * Compute a stable version hash from the skill definitions.
 * Mirrors zerolang's approach: agents call this at session start
 * to learn current rules, preventing version-mismatch bugs.
 */
export function getSkillsVersion() {
  if (!_skillsVersion) {
    _skillsVersion = createHash('sha256').update(JSON.stringify(NOXEM_SKILLS)).digest('hex').slice(0, 8);
  }
  return _skillsVersion;
}

/**
 * Get the full skill set for the current Noxem version.
 * Agents call this at session start (like `zero skills get language`).
 * @param {string} [skillName] - Return only this skill (null = all)
 */
export function getSkills(skillName = null) {
  if (skillName) {
    const skill = NOXEM_SKILLS.skills[skillName];
    if (!skill) return null;
    return { version: getSkillsVersion(), noxemVersion: NOXEM_SKILLS.noxemVersion, name: skillName, ...skill };
  }
  return { ...NOXEM_SKILLS, version: getSkillsVersion() };
}

/**
 * List available skill names.
 */
export function listSkillNames() {
  return Object.keys(NOXEM_SKILLS.skills).map(name => ({
    name,
    description: NOXEM_SKILLS.skills[name].description,
  }));
}

// ══════════════════════════════════════════════════════════
// Content-Hash Validation on Store
// ══════════════════════════════════════════════════════════

// State
let _db = null;
let _stmts = null;
let _ready = false;

function prepareContentHashStatements(db) {
  return {
    getEntityHash: db.prepare(
      `SELECT id, entity, attribute, text, importance, updated_at
       FROM memories
       WHERE entity = ? AND attribute != '' AND status = 'active'
       ORDER BY updated_at DESC`
    ),
    getLatestMemoryByEntityAttr: db.prepare(
      `SELECT id, text, updated_at FROM memories
       WHERE entity = ? AND attribute = ? AND status = 'active'
       ORDER BY updated_at DESC LIMIT 1`
    ),
  };
}

/**
 * Compute a content hash for an entity+attribute scope.
 * Represents the current state of memories in that scope.
 * @param {import('better-sqlite3').Database} db
 * @param {string} entity
 * @param {string} attribute
 * @returns {string} 16-char hex hash
 */
export function computeEntityHash(db, entity, attribute = '') {
  const stmt = attribute
    ? db.prepare('SELECT id, text, updated_at FROM memories WHERE entity = ? AND attribute = ? AND status = \'active\' ORDER BY id')
    : db.prepare('SELECT id, text, updated_at FROM memories WHERE entity = ? AND status = \'active\' ORDER BY id');

  const rows = attribute ? stmt.all(entity, attribute) : stmt.all(entity);
  const hashInput = rows.map(r => `${r.id}:${r.text}:${r.updated_at}`).join('|');
  return createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
}

/**
 * Validate that an entity's state hasn't changed since the agent last read it.
 * Directly inspired by zerolang's graphHash precondition on edits.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} entity
 * @param {string} expectedHash - The hash the agent obtained when it last read this entity
 * @param {string} [attribute] - Limit scope to a specific attribute
 * @returns {{ valid: boolean, currentHash: string, expectedHash: string }}
 * @throws {NoxemError} if hashes don't match (CONFLICT_001)
 */
export function validateContentHash(db, entity, expectedHash, attribute = '') {
  const currentHash = computeEntityHash(db, entity, attribute);
  if (currentHash !== expectedHash) {
    throw createDiagnostic('CONFLICT_001', {
      expected: `entity hash = ${expectedHash}`,
      actual: `entity hash = ${currentHash}`,
      related: [{ entity, attribute, currentHash }],
    });
  }
  return { valid: true, currentHash, expectedHash };
}

// ══════════════════════════════════════════════════════════
// Structured Repair Plans for Maintenance
// ══════════════════════════════════════════════════════════

/**
 * Generate a repair plan from duplicate/contradiction/stale candidates
 * WITHOUT executing anything — the agent reads the plan, then decides.
 * Mirrors zerolang's `zero fix --plan --json` pattern.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {number} [options.dupThreshold] - Cosine threshold for duplicates (default 0.92)
 * @param {number} [options.staleDays] - Days without recall to flag as stale (default 90)
 * @param {number} [options.limit] - Max plan items (default 50)
 * @returns {{ planId: string, items: RepairPlanItem[], stats: object }}
 */
export function generateRepairPlan(db, options = {}) {
  const dupThreshold = options.dupThreshold ?? parseFloat(process.env.DUP_THRESHOLD || '0.92');
  const staleDays = options.staleDays ?? 90;
  const limit = Math.min(options.limit ?? 50, 200);

  const items = [];

  // 1. Entity-attribute contradictions (same entity::attribute, different values)
  const contradictions = db.prepare(`
    SELECT m1.id AS older_id, m1.text AS older_text, m1.entity, m1.attribute,
           m2.id AS newer_id, m2.text AS newer_text,
           m2.created_at AS newer_date
    FROM memories m1
    JOIN memories m2 ON m1.entity = m2.entity
                    AND m1.attribute = m2.attribute
                    AND m1.id < m2.id
    WHERE m1.status = 'active' AND m2.status = 'active'
      AND m1.entity != '' AND m1.attribute != ''
    ORDER BY m1.entity, m1.attribute, m2.created_at DESC
    LIMIT ?
  `).all(limit);

  for (const c of contradictions) {
    items.push({
      operation: 'supersede',
      memory_a: c.older_id,
      memory_b: c.newer_id,
      reason: `same entity::attribute (${c.entity}::${c.attribute}), newer supersedes older`,
      confidence: 0.85,
      fixSafety: 'behavior-preserving',
      entity: c.entity,
      attribute: c.attribute,
    });
  }

  // 2. Stale memories (active but never recalled, older than staleDays)
  const stale = db.prepare(`
    SELECT id, type, entity, text, created_at, recall_count
    FROM memories
    WHERE status = 'active'
      AND recall_count = 0
      AND created_at < datetime('now', ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(`-${staleDays} days`, limit);

  for (const s of stale) {
    items.push({
      operation: 'archive',
      memory_a: s.id,
      memory_b: null,
      reason: `stale: recall_count=0, age > ${staleDays}d, type=${s.type}`,
      confidence: 0.7,
      fixSafety: 'behavior-preserving',
      entity: s.entity,
    });
  }

  // 3. Broken edges (reference deleted/invalid memories)
  const brokenEdges = db.prepare(`
    SELECT e.id AS edge_id, e.from_id, e.to_id, e.relation,
           CASE WHEN f.id IS NULL THEN 1 ELSE 0 END AS from_broken,
           CASE WHEN t.id IS NULL THEN 1 ELSE 0 END AS to_broken
    FROM memory_edges e
    LEFT JOIN memories f ON e.from_id = f.id
    LEFT JOIN memories t ON e.to_id = t.id
    WHERE f.id IS NULL OR t.id IS NULL
    LIMIT ?
  `).all(limit);

  for (const be of brokenEdges) {
    items.push({
      operation: 'delete_edge',
      memory_a: be.from_id,
      memory_b: be.to_id,
      edge_id: be.edge_id,
      relation: be.relation,
      reason: `broken edge: ${be.from_broken ? 'from_id' : 'to_id'} references non-existent memory`,
      confidence: 1.0,
      fixSafety: 'behavior-preserving',
    });
  }

  // 4. Orphaned entity links (memory_entities pointing to deleted memories)
  const orphans = db.prepare(`
    SELECT me.memory_id, me.entity_id
    FROM memory_entities me
    LEFT JOIN memories m ON me.memory_id = m.id
    WHERE m.id IS NULL
    LIMIT ?
  `).all(limit);

  for (const o of orphans) {
    items.push({
      operation: 'delete_orphan_link',
      memory_a: o.memory_id,
      memory_b: null,
      entity_id: o.entity_id,
      reason: 'memory_entities link references non-existent memory',
      confidence: 1.0,
      fixSafety: 'format-only',
    });
  }

  const planId = createHash('sha256')
    .update(JSON.stringify(items) + Date.now())
    .digest('hex').slice(0, 12);

  const stats = {
    total: items.length,
    contradictions: contradictions.length,
    stale: stale.length,
    brokenEdges: brokenEdges.length,
    orphans: orphans.length,
    dupThreshold,
    staleDays,
  };

  return { planId, items, stats };
}

/**
 * Execute a previously generated repair plan.
 * Each item is applied in a transaction.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {RepairPlanItem[]} items - Items from generateRepairPlan()
 * @param {object} [options]
 * @param {number} [options.maxFixSafety] - Max risk level to auto-apply (default: behavior-preserving)
 * @param {boolean} [options.dryRun] - If true, validate but don't write (default: false)
 * @returns {{ applied: number, skipped: number, errors: string[] }}
 */
export function executeRepairPlan(db, items, options = {}) {
  const safetyOrder = ['format-only', 'behavior-preserving', 'local-edit', 'api-changing', 'requires-human-review'];
  const maxSafetyIdx = safetyOrder.indexOf(options.maxFixSafety || 'behavior-preserving');
  const dryRun = options.dryRun ?? false;

  let applied = 0;
  let skipped = 0;
  const errors = [];

  const updateStatus = db.prepare("UPDATE memories SET status = ?, superseded_by = ?, updated_at = datetime('now') WHERE id = ?");
  const archiveStale = db.prepare("UPDATE memories SET status = 'archived', updated_at = datetime('now') WHERE id = ?");
  const deleteEdge = db.prepare('DELETE FROM memory_edges WHERE id = ?');
  const deleteOrphanLink = db.prepare('DELETE FROM memory_entities WHERE memory_id = ? AND entity_id = ?');

  for (const item of items) {
    // Safety gate
    const itemSafetyIdx = safetyOrder.indexOf(item.fixSafety);
    if (itemSafetyIdx > maxSafetyIdx) {
      skipped++;
      continue;
    }

    if (dryRun) { applied++; continue; }

    try {
      db.transaction(() => {
        switch (item.operation) {
          case 'supersede':
            updateStatus.run('superseded', item.memory_b, item.memory_a);
            break;
          case 'archive':
            archiveStale.run(item.memory_a);
            break;
          case 'delete_edge':
            if (item.edge_id) deleteEdge.run(item.edge_id);
            break;
          case 'delete_orphan_link':
            if (item.memory_a && item.entity_id) deleteOrphanLink.run(item.memory_a, item.entity_id);
            break;
          default:
            errors.push(`Unknown operation: ${item.operation}`);
        }
      })();
      applied++;
    } catch (e) {
      errors.push(`${item.operation} on ${item.memory_a}: ${e.message}`);
    }
  }

  return { applied, skipped, errors };
}

// ══════════════════════════════════════════════════════════
// Procedure Dependency Graph
// ══════════════════════════════════════════════════════════

/**
 * Initialize the procedure_deps table and prepared statements.
 * Must be called once at startup.
 * @param {import('better-sqlite3').Database} db
 */
export function initProcedureDeps(db) {
  _db = db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS procedure_deps (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id         INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
      depends_on_procedure_id INTEGER NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
      dep_type             TEXT    NOT NULL DEFAULT 'references',
      created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(procedure_id, depends_on_procedure_id)
    );

    CREATE INDEX IF NOT EXISTS idx_proc_deps_from ON procedure_deps(procedure_id);
    CREATE INDEX IF NOT EXISTS idx_proc_deps_to   ON procedure_deps(depends_on_procedure_id);
    CREATE INDEX IF NOT EXISTS idx_proc_deps_type ON procedure_deps(dep_type);
  `);

  _stmts = {
    addDep:       db.prepare('INSERT OR IGNORE INTO procedure_deps (procedure_id, depends_on_procedure_id, dep_type) VALUES (?, ?, ?)'),
    removeDep:    db.prepare('DELETE FROM procedure_deps WHERE procedure_id = ? AND depends_on_procedure_id = ?'),
    getDeps:      db.prepare('SELECT pd.*, p.name AS depends_on_name FROM procedure_deps pd JOIN procedures p ON pd.depends_on_procedure_id = p.id WHERE pd.procedure_id = ?'),
    getDependents:db.prepare('SELECT pd.*, p.name AS procedure_name FROM procedure_deps pd JOIN procedures p ON pd.procedure_id = p.id WHERE pd.depends_on_procedure_id = ?'),
    getDepGraph:  db.prepare('SELECT procedure_id, depends_on_procedure_id, dep_type FROM procedure_deps'),
  };

  _ready = true;
}

export function isProcedureDepsReady() { return _ready; }

/**
 * Add a dependency between two procedures.
 * @param {number} procedureId
 * @param {number} dependsOnId
 * @param {string} [depType] - 'references' | 'requires' | 'extends' | 'contrasts'
 */
export function addProcedureDep(procedureId, dependsOnId, depType = 'references') {
  if (!_stmts) throw new Error('Procedure deps not initialized — call initProcedureDeps first');

  if (procedureId === dependsOnId) {
    throw createDiagnostic('PROC_001', {
      expected: 'acyclic dependency graph (no self-references)',
      actual: `procedure ${procedureId} depends on itself`,
    });
  }

  // Cycle detection: if dependsOn already depends (transitively) on procedureId, adding this edge creates a cycle
  if (wouldCreateCycle(procedureId, dependsOnId)) {
    throw createDiagnostic('PROC_001', {
      expected: 'acyclic dependency graph',
      actual: `adding dep ${procedureId}->${dependsOnId} creates a cycle`,
    });
  }

  _stmts.addDep.run(procedureId, dependsOnId, depType);
  return { ok: true, procedure_id: procedureId, depends_on: dependsOnId, dep_type: depType };
}

/**
 * Check if adding an edge from -> to would create a cycle.
 * DFS from `to` looking for `from`.
 */
function wouldCreateCycle(fromId, toId) {
  const visited = new Set();
  const stack = [toId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === fromId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    // Find what `current` depends on
    const deps = _stmts.getDeps.all(current);
    for (const dep of deps) {
      stack.push(dep.depends_on_procedure_id);
    }
  }

  return false;
}

/**
 * Remove a dependency edge.
 */
export function removeProcedureDep(procedureId, dependsOnId) {
  if (!_stmts) throw new Error('Procedure deps not initialized');
  const changes = _stmts.removeDep.run(procedureId, dependsOnId).changes;
  return { ok: changes > 0, removed: changes };
}

/**
 * Get all dependencies (what this procedure depends on).
 */
export function getProcedureDependencies(procedureId) {
  if (!_stmts) throw new Error('Procedure deps not initialized');
  return _stmts.getDeps.all(procedureId);
}

/**
 * Get all dependents (what depends on this procedure).
 */
export function getProcedureDependents(procedureId) {
  if (!_stmts) throw new Error('Procedure deps not initialized');
  return _stmts.getDependents.all(procedureId);
}

/**
 * Get the full procedure dependency graph.
 * @returns {{ nodes: number[], edges: { from: number, to: number, type: string }[] }}
 */
export function getProcedureDependencyGraph() {
  if (!_stmts) throw new Error('Procedure deps not initialized');

  const edges = _stmts.getDepGraph.all();
  const nodeSet = new Set();
  const edgeList = [];

  for (const e of edges) {
    nodeSet.add(e.procedure_id);
    nodeSet.add(e.depends_on_procedure_id);
    edgeList.push({ from: e.procedure_id, to: e.depends_on_procedure_id, type: e.dep_type });
  }

  return { nodes: [...nodeSet], edges: edgeList };
}

/**
 * Extract procedure dependencies from procedure step text.
 * Heuristic: if a step references a known procedure name, create a dep edge.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} procedureId - The procedure to analyze
 * @returns {{ added: number, deps: object[] }}
 */
export function extractProcedureDepsFromSteps(db, procedureId) {
  if (!_stmts) throw new Error('Procedure deps not initialized');

  // Get procedure steps
  const steps = db.prepare('SELECT text FROM procedure_steps WHERE procedure_id = ? ORDER BY step_order').all(procedureId);
  if (!steps.length) return { added: 0, deps: [] };

  // Get all known procedure names (id -> name, name -> id)
  const allProcs = db.prepare('SELECT id, name FROM procedures WHERE id != ?').all(procedureId);
  const nameToId = new Map(allProcs.map(p => [p.name.toLowerCase(), p.id]));

  const added = [];
  for (const step of steps) {
    const text = step.text.toLowerCase();
    for (const [name, id] of nameToId) {
      // Simple heuristic: procedure name appears in step text
      if (text.includes(name) || text.includes(`procedure ${name}`)) {
        try {
          addProcedureDep(procedureId, id, 'references');
          added.push({ depends_on: id, name, dep_type: 'references' });
        } catch (_) {
          // Already exists or would create cycle — skip
        }
      }
    }
  }

  return { added: added.length, deps: added };
}

// ══════════════════════════════════════════════════════════
// Init + Stats
// ══════════════════════════════════════════════════════════

/**
 * Initialize the diagnostic compiler adapter.
 * Sets up procedure_deps table and content-hash statements.
 * @param {import('better-sqlite3').Database} db
 */
export function initDiagnosticAdapter(db) {
  initProcedureDeps(db);
  prepareContentHashStatements(db);
  return { ok: true, skillsVersion: getSkillsVersion(), diagnosticsCount: Object.keys(DIAGNOSTIC_CODES).length };
}

/**
 * Get adapter stats.
 */
export function getDiagnosticAdapterStats() {
  let depCount = 0;
  try {
    if (_db) depCount = _db.prepare('SELECT COUNT(*) AS c FROM procedure_deps').get().c;
  } catch (_) { /* table may not exist yet */ }

  return {
    ready: _ready,
    skillsVersion: getSkillsVersion(),
    skillsCount: Object.keys(NOXEM_SKILLS.skills).length,
    diagnosticsCount: Object.keys(DIAGNOSTIC_CODES).length,
    procedureDeps: depCount,
  };
}
