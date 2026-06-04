#!/usr/bin/env node
/**
 * Noxem Adapter: Ambient Injector (from Lemma)
 *
 * Adapts Lemma's tool-description memory injection, guide distillation,
 * memory audit tool, virtual session lifecycle, auto-linking of co-accessed
 * memories, and memory feedback MCP tool into Noxem's ESM+better-sqlite3
 * architecture.
 *
 * Core innovation: 3-layer tool-description injection via tools/list.
 * Memories auto-inject into tool descriptions without any explicit retrieval
 * call. The LLM starts every conversation already possessing key knowledge.
 *
 * Source reference: Lemma
 *   - buildInjectedTools(): 3-layer injection (full content, summary index, active guides)
 *   - promoteToGuide(): distills memory -> guide
 *   - practiceGuide(): tracks usage with contexts/learnings/success/failure
 *   - memory_feedback tool: positive/negative signals, archive on low importance
 *   - tools.ts: memory_audit, session_start/end, memory_library, conflict_scan
 *
 * Noxem integration points:
 *   - mcp-server.mjs: McpServer registerTool() pattern, tools/list response
 *   - memory-store.mjs: storeMemory, storeEdge, searchMemories, db,
 *     incrementRecallCounts, traverseMemoryGraph, touchProcedureUse,
 *     getAllCoreBlocks, getActiveMemories
 *   - memory-server.mjs: lruCache patterns, search pipeline
 *   - advisor-engine.mjs: callRLMWithFallback / llmFetch for async LLM calls
 *   - memory-pipeline.mjs: onMemoryStored, runPipeline
 *   - embedding-engine.mjs: embed, findDuplicates, cosineSimilarity
 *   - entity-ranker/noxem-adapter.mjs: getEntityRanking for ambient ranking
 *
 * Schema additions:
 *   - memory_sessions table (auto-created)
 *   - memory_corecalls table (auto-created)
 *   - memory_feedback_log table (auto-created)
 */

import fs from 'fs';
import path from 'path';

// Dependencies injected via initAmbientInjector(db, deps)
let _db, _storeEdge, _searchMemories, _getActiveMemories,
  _incrementRecallCounts, _traverseMemoryGraph, _getAllCoreBlocks,
  _getMemory, _getEdgesFromMemory, _getEdgesToMemory, _getEntityRanking;

export function initAmbientInjector(db, deps = {}) {
  _db = db;
  _storeEdge = deps.storeEdge;
  _searchMemories = deps.searchMemories;
  _getActiveMemories = deps.getActiveMemories;
  _incrementRecallCounts = deps.incrementRecallCounts;
  _traverseMemoryGraph = deps.traverseMemoryGraph;
  _getAllCoreBlocks = deps.getAllCoreBlocks;
  _getMemory = deps.getMemory;
  _getEdgesFromMemory = deps.getEdgesFromMemory;
  _getEdgesToMemory = deps.getEdgesToMemory;
  _getEntityRanking = deps.getEntityRanking;
  _boot();
}

// ── Constants ────────────────────────────────────────────────────────

const INJECT_FULL_TOP_N = 10;
const INJECT_FULL_TOKEN_BUDGET = 3000;
const INJECT_SUMMARY_TOP_N = 20;
const INJECT_SUMMARY_TOKEN_BUDGET = 1000;
const INJECT_PROCEDURE_TOP_N = 5;
const INJECT_PROCEDURE_TOKEN_BUDGET = 500;
const INJECT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const AGENTS_MD_CACHE_TTL_MS = 5 * 60 * 1000;
const AGENTS_MD_TOKEN_BUDGET = 800;
const GUIDE_DISTILL_MIN_USE_COUNT = 3;
const FEEDBACK_POSITIVE_IMPORTANCE_BOOST = 0.05;
const FEEDBACK_POSITIVE_RECALL_BOOST = 1;
const FEEDBACK_NEGATIVE_IMPORTANCE_DECAY = 0.1;
const FEEDBACK_ARCHIVE_THRESHOLD = 0.1;
const SESSION_AUTO_EXPIRY_MINUTES = 30;
const CORECALL_MIN_COUNT_FOR_EDGE = 3;
const AUDIT_SAMPLE_SIZE = 10;
const AUDIT_STALE_DAYS = 90;
const AUDIT_BM25_DUPE_THRESHOLD = 0.85;
const SESSION_MAX_AUTO_LINKS = 10;

// ── Lazy init ───────────────────────────────────────────────
let _booted = false;
let stmtBoostImportance;
let stmtFindBrokenEdges;
let stmtArchiveMemory;
let stmtCountStale;
let stmtFindStaleMemories;
let stmtFindOrphans;
let stmtIncrementCorecall;
let stmtCountOrphans;
let stmtCloseSession;
let stmtInsertFeedback;
let stmtBoostRecallCount;
let stmtFindInvalidEmbeddings;
let stmtCountActiveMemories;
let stmtUpsertSession;
let stmtGetActiveSession;
let stmtDecayImportance;
let stmtGetCorecallPairs;
let stmtCountBrokenEdges;
let stmtGetSessionMemories;
let stmtGetMemoryImportance;
let stmtExpireSessions;
let stmtCountEdgesBetween;
let stmtInsertCorecallEdge;

function _boot() {
  if (_booted) return;
  _db.exec(`
  CREATE TABLE IF NOT EXISTS memory_sessions (
  session_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity TEXT NOT NULL DEFAULT (datetime('now')),
  memory_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  end_summary TEXT DEFAULT ''
  )
  `);
  _db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_status ON memory_sessions(status)');
  _db.exec(`
  CREATE TABLE IF NOT EXISTS memory_corecalls (
  memory_a INTEGER NOT NULL,
  memory_b INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (memory_a, memory_b),
  CHECK (memory_a < memory_b)
  )
  `);
  _db.exec('CREATE INDEX IF NOT EXISTS idx_corecalls_memory_a ON memory_corecalls(memory_a)');
  _db.exec(`
  CREATE TABLE IF NOT EXISTS memory_feedback_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  signal TEXT NOT NULL CHECK(signal IN ('positive', 'negative')),
  importance_before REAL,
  importance_after REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
  `);
  _db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_memory ON memory_feedback_log(memory_id)');
  stmtUpsertSession = _db.prepare(`
  INSERT INTO memory_sessions (session_id, started_at, last_activity, memory_count)
  VALUES (@sid, datetime('now'), datetime('now'), 1)
  ON CONFLICT(session_id) DO UPDATE SET
  last_activity = datetime('now'),
  memory_count = memory_count + 1
  `);
  stmtCloseSession = _db.prepare(`
  UPDATE memory_sessions SET status = 'closed', end_summary = @summary,
  last_activity = datetime('now')
  WHERE session_id = @sid
  `);
  stmtGetActiveSession = _db.prepare(`
  SELECT * FROM memory_sessions WHERE session_id = ? AND status = 'active'
  `);
  stmtExpireSessions = _db.prepare(`
  UPDATE memory_sessions SET status = 'expired'
  WHERE status = 'active'
  AND last_activity < datetime('now', '-${SESSION_AUTO_EXPIRY_MINUTES} minutes')
  `);
  stmtGetSessionMemories = _db.prepare(`
  SELECT id, entity, attribute, type, text FROM memories
  WHERE session_id = ? AND status = 'active' ORDER BY created_at
  `);
  stmtIncrementCorecall = _db.prepare(`
  INSERT INTO memory_corecalls (memory_a, memory_b, count)
  VALUES (@a, @b, 1)
  ON CONFLICT(memory_a, memory_b) DO UPDATE SET count = count + 1
  `);
  stmtGetCorecallPairs = _db.prepare(`
  SELECT memory_a, memory_b, count FROM memory_corecalls
  WHERE count >= ? ORDER BY count DESC LIMIT ?
  `);
  stmtCountEdgesBetween = _db.prepare(`
  SELECT COUNT(*) AS cnt FROM memory_edges
  WHERE from_id = ? AND to_id = ? AND relation = 'related_to'
  AND (valid_until IS NULL OR valid_until > datetime('now'))
  `);
  stmtInsertCorecallEdge = _db.prepare(`
  INSERT INTO memory_edges (from_id, to_id, relation, strength, source_session_id, metadata)
  VALUES (@from_id, @to_id, 'related_to', @strength, 'ambient-injector', '{"source":"corecall_auto"}')
  `);
  stmtBoostImportance = _db.prepare(`
  UPDATE memories SET importance = MIN(1.0, importance + ?), updated_at = datetime('now')
  WHERE id = ? AND status = 'active'
  `);
  stmtDecayImportance = _db.prepare(`
  UPDATE memories SET importance = MAX(0.05, importance - ?), updated_at = datetime('now')
  WHERE id = ? AND status = 'active'
  `);
  stmtGetMemoryImportance = _db.prepare(`
  SELECT importance, status FROM memories WHERE id = ?
  `);
  stmtArchiveMemory = _db.prepare(`
  UPDATE memories SET status = 'archived', updated_at = datetime('now')
  WHERE id = ? AND status = 'active'
  `);
  stmtBoostRecallCount = _db.prepare(`
  UPDATE memories SET recall_count = recall_count + ?, updated_at = datetime('now')
  WHERE id = ? AND status = 'active'
  `);
  stmtInsertFeedback = _db.prepare(`
  INSERT INTO memory_feedback_log (memory_id, signal, importance_before, importance_after)
  VALUES (?, ?, ?, ?)
  `);
  stmtFindOrphans = _db.prepare(`
  SELECT m.id, m.entity FROM memories m
  LEFT JOIN memory_entities me ON m.id = me.memory_id
  WHERE m.entity != '' AND m.status = 'active' AND me.memory_id IS NULL
  LIMIT ?
  `);
  stmtCountOrphans = _db.prepare(`
  SELECT COUNT(*) AS cnt FROM memories m
  LEFT JOIN memory_entities me ON m.id = me.memory_id
  WHERE m.entity != '' AND m.status = 'active' AND me.memory_id IS NULL
  `);
  stmtFindBrokenEdges = _db.prepare(`
  SELECT e.id AS edge_id, e.from_id, e.to_id, e.relation,
  CASE WHEN m1.id IS NULL THEN 'from_missing' ELSE 'to_missing' END AS break_type
  FROM memory_edges e
  LEFT JOIN memories m1 ON e.from_id = m1.id
  LEFT JOIN memories m2 ON e.to_id = m2.id
  WHERE (m1.id IS NULL OR m2.id IS NULL)
  LIMIT ?
  `);
  stmtCountBrokenEdges = _db.prepare(`
  SELECT COUNT(*) AS cnt FROM memory_edges e
  LEFT JOIN memories m1 ON e.from_id = m1.id
  LEFT JOIN memories m2 ON e.to_id = m2.id
  WHERE m1.id IS NULL OR m2.id IS NULL
  `);
  stmtFindStaleMemories = _db.prepare(`
  SELECT id, type, created_at, recall_count FROM memories
  WHERE status = 'active' AND recall_count = 0
  AND created_at < datetime('now', '-${AUDIT_STALE_DAYS} days')
  LIMIT ?
  `);
  stmtCountStale = _db.prepare(`
  SELECT COUNT(*) AS cnt FROM memories
  WHERE status = 'active' AND recall_count = 0
  AND created_at < datetime('now', '-${AUDIT_STALE_DAYS} days')
  `);
  stmtFindInvalidEmbeddings = _db.prepare(`
  SELECT m.id FROM memories m
  LEFT JOIN memory_vecs v ON v.rowid = m.id
  WHERE m.status = 'active'
  AND ((m.embedding IS NULL AND v.rowid IS NOT NULL)
  OR (m.embedding IS NOT NULL AND v.rowid IS NULL))
  LIMIT ?
  `);
  stmtCountActiveMemories = _db.prepare(`
  SELECT COUNT(*) AS cnt FROM memories WHERE status = 'active'
  `);
  let _injectCache = null;
  let _injectCacheTime = 0;
  let _agentsMdCache = { content: null, ts: 0, path: '' };
  _booted = true;
}
// ── 1. Tool-Description Memory Injection ────────────────────────────

/**
 * Build the 3-layer ambient context for injection into MCP tool descriptions.
 *
 * Layer 1 (full content): Top 10 memories by composite ranking (entity rank *
 * recency * recall count), full text, up to 3000 tokens.
 *
 * Layer 2 (summary index): Next 20 memories as one-line summaries,
 * up to 1000 tokens.
 *
 * Layer 3 (procedure index): Top 5 procedures by use_count, name +
 * trigger_context, up to 500 tokens.
 *
 * Adapted from Lemma's buildInjectedTools() which creates tool definitions
 * with memory content injected into the memory_read tool description.
 *
 * @param {boolean} [forceRefresh=false] - Force cache bypass
 * @returns {{ toolName: string, toolDescription: string, layers: object, token_estimate: number }}
 */
export function buildAmbientInjection(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _injectCache && (now - _injectCacheTime) < INJECT_CACHE_TTL_MS) {
    return _injectCache;
  }

  const memories = _getActiveMemories(200);
  const rankedEntities = _getEntityRanking(20);
  const entityRankMap = new Map();
  for (let i = 0; i < rankedEntities.length; i++) {
    // Higher rank = higher weight (20-i gives rank 0 -> 20, rank 19 -> 1)
    entityRankMap.set(rankedEntities[i].canonical_name.toLowerCase(), 20 - i);
  }

  // Score each memory using entity ranking + recency + recall count + importance
  const scored = memories.map(m => {
    const entityWeight = entityRankMap.get((m.entity || '').toLowerCase()) || 1;
    const recencyWeight = m.created_at
      ? Math.exp(-(Date.now() - new Date(m.created_at).getTime()) / (30 * 24 * 60 * 60 * 1000))
      : 0.5;
    const recallWeight = 1 + (m.recall_count || 0) * 0.2;
    const importanceWeight = m.importance || 0.5;
    const compositeScore = entityWeight * recencyWeight * recallWeight * importanceWeight;
    return { ...m, _inject_score: compositeScore };
  });

  scored.sort((a, b) => b._inject_score - a._inject_score);

  // --- Layer 1: Full content ---
  const fullContentFrags = [];
  let fullTokenCount = 0;
  for (const m of scored.slice(0, INJECT_FULL_TOP_N * 2)) {
    if (fullContentFrags.length >= INJECT_FULL_TOP_N) break;
    const text = m.summary || m.text;
    const prefix = m.context_prefix || `[${m.type}]`;
    const entry = `[${m.id}] ${prefix} ${text} (importance=${(m.importance || 0).toFixed(2)}, recalled=${m.recall_count || 0})`;
    const tokens = Math.ceil(entry.length / 4);
    if (fullTokenCount + tokens > INJECT_FULL_TOKEN_BUDGET) break;
    fullContentFrags.push(entry);
    fullTokenCount += tokens;
  }

  // --- Layer 2: Summary index ---
  const summaryFrags = [];
  let summaryTokenCount = 0;
  const summaryStart = fullContentFrags.length;
  for (const m of scored.slice(summaryStart, summaryStart + INJECT_SUMMARY_TOP_N * 2)) {
    if (summaryFrags.length >= INJECT_SUMMARY_TOP_N) break;
    const text = m.summary || m.text;
    const oneLiner = text.length > 80 ? text.slice(0, 77) + '...' : text;
    const prefix = m.context_prefix || `[${m.type}]`;
    const entry = `[${m.id}] ${prefix} ${oneLiner} (${(m.importance || 0).toFixed(2)})`;
    const tokens = Math.ceil(entry.length / 4);
    if (summaryTokenCount + tokens > INJECT_SUMMARY_TOKEN_BUDGET) break;
    summaryFrags.push(entry);
    summaryTokenCount += tokens;
  }

  // --- Layer 3: Procedure index ---
  const procedures = listAllProcedures(INJECT_PROCEDURE_TOP_N * 2);
  const procedureFrags = [];
  let procTokenCount = 0;
  for (const p of procedures) {
    if (procedureFrags.length >= INJECT_PROCEDURE_TOP_N) break;
    const entry = `[proc:${p.id}] ${p.name}${p.trigger_context ? ' -- trigger: ' + p.trigger_context : ''} (used ${p.use_count || 0}x)`;
    const tokens = Math.ceil(entry.length / 4);
    if (procTokenCount + tokens > INJECT_PROCEDURE_TOKEN_BUDGET) break;
    procedureFrags.push(entry);
    procTokenCount += tokens;
  }

  // Compose tool description
  const sections = [];
  if (fullContentFrags.length > 0) {
    sections.push('== FULL MEMORY CONTENT ==\n' + fullContentFrags.join('\n'));
  }
  if (summaryFrags.length > 0) {
    sections.push('== MEMORY INDEX (use memory_search to retrieve) ==\n' + summaryFrags.join('\n'));
  }
  if (procedureFrags.length > 0) {
    sections.push('== ACTIVE PROCEDURES ==\n' + procedureFrags.join('\n'));
  }

  if (sections.length === 0) {
    sections.push('No memories yet. Store memories to populate this context.');
  }

  const toolDescription = 'Auto-injected memory context from the Noxem memory system. You already know these facts without calling any tool.\n\n'
    + sections.join('\n\n')
    + '\n\n---\nCall memory_search for retrieval, memory_store to persist knowledge.';

  const totalTokens = fullTokenCount + summaryTokenCount + procTokenCount;

  const result = {
    toolName: 'ambient_context',
    toolDescription,
    layers: {
      full_content: fullContentFrags,
      summary_index: summaryFrags,
      procedure_index: procedureFrags,
    },
    token_estimate: totalTokens,
  };

  _injectCache = result;
  _injectCacheTime = now;
  return result;
}

/**
 * Invalidate the injection cache (call after memory store/feedback/edge changes).
 */
export function invalidateInjectionCache() {
  _injectCache = null;
  _injectCacheTime = 0;
}

/**
 * Build the MCP tool definition object for ambient_context injection.
 * This tool exists to carry injected memories in its description field
 * via tools/list. It does nothing when called -- the content is in the
 * description, not the response.
 *
 * @param {boolean} [forceRefresh=false] - Force refresh the ambient context cache
 * @returns {{ name: string, description: string, inputSchema: object }}
 */
export function buildAmbientContextToolDef(forceRefresh = false) {
  const injection = buildAmbientInjection(forceRefresh);
  return {
    name: 'ambient_context',
    description: injection.toolDescription,
    inputSchema: {
      type: 'object',
      properties: {
        _placeholder: {
          type: 'string',
          description: 'This tool carries ambient context in its description. No input needed.',
        },
      },
    },
  };
}

/**
 * Build the AGENTS.md injection section for the ambient context.
 * Reads the AGENTS.md file from the specified directory and returns
 * a truncated version suitable for injection.
 *
 * @param {string} [projectDir=process.cwd()] - Directory to look for AGENTS.md
 * @returns {{ section: string, found: boolean }}
 */
export function buildAgentsMdInjection(projectDir = process.cwd()) {
  const now = Date.now();
  const searchPaths = [
    path.join(projectDir, 'AGENTS.md'),
    path.join(projectDir, 'CLAUDE.md'),
  ];

  // Check cache
  if (_agentsMdCache.content && _agentsMdCache.path && (now - _agentsMdCache.ts) < AGENTS_MD_CACHE_TTL_MS) {
    for (const p of searchPaths) {
      if (_agentsMdCache.path === p && _agentsMdCache.found) {
        return { section: `== PROJECT CONTEXT (from ${path.basename(p)}) ==\n${_agentsMdCache.content}`, found: true };
      }
    }
  }

  for (const p of searchPaths) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8');
        if (content && content.trim().length > 0) {
          const maxChars = AGENTS_MD_TOKEN_BUDGET * 4;
          const truncated = content.length > maxChars ? content.slice(0, maxChars) + '\n...' : content;
          _agentsMdCache = { content: truncated, ts: now, path: p, found: true };
          return { section: `== PROJECT CONTEXT (from ${path.basename(p)}) ==\n${truncated}`, found: true };
        }
      }
    } catch { /* file not readable, try next */ }
  }

  _agentsMdCache = { content: null, ts: now, path: '', found: false };
  return { section: '', found: false };
}

/**
 * Invalidate the AGENTS.md cache (call on SIGHUP or manual refresh).
 */
export function invalidateAgentsMdCache() {
  _agentsMdCache = { content: null, ts: 0, path: '', found: false };
}

/**
 * Build a combined ambient context with optional AGENTS.md prepended.
 * This is the main entry point for MCP tools/list response injection.
 *
 * @param {string} [projectDir=process.cwd()] - Directory to search for AGENTS.md
 * @param {boolean} [forceRefresh=false] - Force cache refresh
 * @returns {{ toolName: string, toolDescription: string, token_estimate: number }}
 */
export function buildCombinedAmbientContext(projectDir = process.cwd(), forceRefresh = false) {
  const injection = buildAmbientInjection(forceRefresh);
  const agentsMd = buildAgentsMdInjection(projectDir);

  if (agentsMd.section) {
    const combined = agentsMd.section + '\n\n' + injection.toolDescription;
    return {
      toolName: injection.toolName,
      toolDescription: combined,
      token_estimate: injection.token_estimate + Math.ceil(agentsMd.section.length / 4),
    };
  }

  return injection;
}

// ── 2. Guide Distillation from Procedures ────────────────────────────

/**
 * Distill a procedure into a "guide" -- a generalized operational pattern
 * extracted from accumulated usage. Triggered when a procedure has been
 * used 3+ times.
 *
 * Adapted from Lemma's promoteToGuide() which distills memory -> guide.
 *
 * Uses Brain 2 (Noxem's advisor-engine pattern with llmFetch) to generalize
 * the procedure steps into reusable guidance with pitfalls. Creates a NEW
 * procedure of type='guide' and links it to the original via memory_edges.
 *
 * @param {number} procedureId - Procedure to distill
 * @param {Function} llmFetchFn - Noxem's llmFetch function from llm-fetch.mjs
 * @returns {{ guide_id: number|null, distilled: boolean, reason: string }}
 */
export async function distillGuide(procedureId, llmFetchFn) {
  const procRow = _db.prepare('SELECT * FROM procedures WHERE id = ?').get(procedureId);
  if (!procRow) return { guide_id: null, distilled: false, reason: 'Procedure not found' };

  if ((procRow.use_count || 0) < GUIDE_DISTILL_MIN_USE_COUNT) {
    return { guide_id: null, distilled: false, reason: `Use count ${procRow.use_count} < ${GUIDE_DISTILL_MIN_USE_COUNT}` };
  }

  // Check if already distilled by checking for a distilled_from edge pointing to this procedure
  const existingGuide = _db.prepare(`
    SELECT e.from_id FROM memory_edges e
    JOIN procedures p ON p.id = e.from_id
    WHERE e.to_id = ? AND e.relation = 'distilled_from' AND p.type = 'guide'
    LIMIT 1
  `).get(procedureId);

  if (existingGuide) {
    return { guide_id: existingGuide.from_id, distilled: true, reason: 'Guide already exists' };
  }

  const steps = _db.prepare('SELECT * FROM procedure_steps WHERE procedure_id = ? ORDER BY step_order').all(procedureId);
  const contextPoints = _db.prepare('SELECT * FROM procedure_context_points WHERE procedure_id = ?').all(procedureId);

  const stepsText = steps.map((s, i) => `${i + 1}. [${s.step_type}] ${s.text}`).join('\n');
  const contextText = contextPoints.map(c => `${c.context_type}: ${c.context_value}`).join('\n');

  const prompt = `You are distilling a repeated procedure into a reusable guide. Based on ${procRow.use_count} uses, generalize these steps into an operational guide with common pitfalls.

Procedure: ${procRow.name}
Description: ${procRow.description || 'N/A'}
Trigger: ${procRow.trigger_context || 'N/A'}

Steps:
${stepsText || '(none)'}

Context:
${contextText || 'None'}

Return a JSON object with:
- "guide_name": short name for the guide
- "guide_description": one-line description
- "guide_steps": array of {step, pitfall} objects
- "when_to_use": when this guide applies

JSON only, no explanation.`;

  try {
    const llmUrl = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
    const llmModel = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';

    const response = await llmFetchFn(llmUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return { guide_id: null, distilled: false, reason: `LLM error: ${response.status}` };

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { guide_id: null, distilled: false, reason: 'No JSON in LLM response' };

    const guideData = JSON.parse(jsonMatch[0]);

    // Store as a new guide-type procedure (NOT overwriting the original)
    const guideId = _db.transaction(() => {
      const insertProc = _db.prepare(
        'INSERT INTO procedures (name, description, trigger_context, session_id) VALUES (?, ?, ?, ?)'
      );
      const result = insertProc.run(
        guideData.guide_name || `Guide: ${procRow.name}`,
        guideData.guide_description || '',
        guideData.when_to_use || procRow.trigger_context || '',
        procRow.session_id || ''
      );
      const gId = Number(result.lastInsertRowid);

      // Insert guide steps with pitfalls
      const insertStep = _db.prepare(
        'INSERT INTO procedure_steps (procedure_id, step_order, text, step_type, expected_outcome, step_context) VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (let i = 0; i < (guideData.guide_steps || []).length; i++) {
        const gs = guideData.guide_steps[i];
        insertStep.run(gId, i, gs.step || '', 'action', gs.pitfall || '', '');
      }

      // Link guide to original procedure (guide -> source)
      _storeEdge({
        from_id: gId, to_id: procedureId, relation: 'distilled_from',
        strength: 1.0, source_session_id: 'ambient-injector',
        metadata: { source: 'guide_distillation' },
        valid_from: null, valid_until: null,
      });

      return gId;
    })();

    invalidateInjectionCache();
    return { guide_id: guideId, distilled: true, reason: 'Guide created successfully' };
  } catch (err) {
    return { guide_id: null, distilled: false, reason: `LLM call failed: ${err.message}` };
  }
}

/**
 * Batch-distill all procedures eligible for guide promotion.
 *
 * @param {Function} llmFetchFn - Noxem's llmFetch function
 * @returns {{ distilled: number, total_eligible: number, errors: string[] }}
 */
export async function distillAllEligible(llmFetchFn) {
  const eligible = _db.prepare(`
    SELECT p.id FROM procedures p
    LEFT JOIN memory_edges e ON e.from_id = p.id AND e.relation = 'distilled_from'
    WHERE p.use_count >= ? AND e.id IS NULL
    ORDER BY p.use_count DESC
  `).all(GUIDE_DISTILL_MIN_USE_COUNT);

  let distilled = 0;
  const errors = [];

  for (const candidate of eligible) {
    const result = await distillGuide(candidate.id, llmFetchFn);
    if (result.distilled) distilled++;
    else if (result.reason !== 'Guide already exists') errors.push(`proc ${candidate.id}: ${result.reason}`);
  }

  return { distilled, total_eligible: eligible.length, errors };
}

// ── 3. Memory Audit Tool ────────────────────────────────────────────

/**
 * Run comprehensive memory audit checks:
 *   (a) Orphaned memories: entity set but no memory_entities link
 *   (b) Broken edge references: from_id/to_id pointing to deleted memories
 *   (c) FTS5 BM25 duplicate detection: near-duplicate text pairs
 *   (d) Stale memories: active but recall_count=0 and age > 90 days
 *   (e) Invalid embeddings: embedding BLOB vs sqlite-vec rowid mismatch
 *
 * Adapted from Lemma's memory_audit tool.
 *
 * @returns {{ orphans: object, broken_edges: object, duplicates: object,
 *            stale: object, invalid_embeddings: object, healthy: boolean,
 *            total_checked: number, checked_at: string }}
 */
export function runMemoryAudit() {
  const report = {
    total_checked: 0,
    orphaned_memories: { count: 0, sample_ids: [] },
    broken_edges: { count: 0, sample_ids: [] },
    duplicate_pairs: { count: 0, sample_pairs: [] },
    stale_memories: { count: 0, sample_ids: [] },
    invalid_embeddings: { count: 0, sample_ids: [] },
    healthy: false,
    checked_at: new Date().toISOString(),
  };

  // Total active memories
  try {
    report.total_checked = stmtCountActiveMemories.get()?.cnt || 0;
  } catch { report.total_checked = -1; }

  // (a) Orphaned memories
  try {
    report.orphaned_memories.count = stmtCountOrphans.get()?.cnt || 0;
    report.orphaned_memories.sample_ids = stmtFindOrphans.all(AUDIT_SAMPLE_SIZE)
      .map(o => ({ id: o.id, entity: o.entity }));
  } catch (e) {
    report.orphaned_memories.error = e.message;
  }

  // (b) Broken edge references
  try {
    report.broken_edges.count = stmtCountBrokenEdges.get()?.cnt || 0;
    report.broken_edges.sample_ids = stmtFindBrokenEdges.all(AUDIT_SAMPLE_SIZE)
      .map(b => ({ edge_id: b.edge_id, from_id: b.from_id, to_id: b.to_id, break_type: b.break_type }));
  } catch (e) {
    report.broken_edges.error = e.message;
  }

  // (c) FTS5-based duplicate detection
  try {
    const dupPairs = _findBM25Duplicates();
    report.duplicate_pairs.count = dupPairs.length;
    report.duplicate_pairs.sample_pairs = dupPairs.slice(0, AUDIT_SAMPLE_SIZE);
  } catch (e) {
    report.duplicate_pairs.error = e.message;
  }

  // (d) Stale memories
  try {
    report.stale_memories.count = stmtCountStale.get()?.cnt || 0;
    report.stale_memories.sample_ids = stmtFindStaleMemories.all(AUDIT_SAMPLE_SIZE)
      .map(s => s.id);
  } catch (e) {
    report.stale_memories.error = e.message;
  }

  // (e) Invalid embeddings
  try {
    const invalid = stmtFindInvalidEmbeddings.all(AUDIT_SAMPLE_SIZE);
    report.invalid_embeddings.count = invalid.length;
    report.invalid_embeddings.sample_ids = invalid.map(i => i.id);
  } catch (e) {
    report.invalid_embeddings.error = e.message;
  }

  report.healthy = (
    report.orphaned_memories.count === 0 &&
    report.broken_edges.count === 0 &&
    report.duplicate_pairs.count === 0 &&
    report.stale_memories.count === 0 &&
    report.invalid_embeddings.count === 0
  );

  return report;
}

/**
 * Format audit report as human-readable text (for MCP tool output).
 *
 * @param {object} report - Output from runMemoryAudit()
 * @returns {string} Formatted report
 */
export function formatAuditReport(report) {
  let output = '== MEMORY AUDIT REPORT ==\n';
  output += `Total active memories checked: ${report.total_checked}\n`;
  output += `Overall status: ${report.healthy ? 'HEALTHY' : 'ISSUES FOUND'}\n\n`;

  if (report.orphaned_memories.count > 0) {
    output += `ORPHANED MEMORIES (entity set but no memory_entities link): ${report.orphaned_memories.count}\n`;
    for (const s of report.orphaned_memories.sample_ids) {
      output += `  ! Memory ${s.id} (entity: "${s.entity}")\n`;
    }
    output += '\n';
  }

  if (report.broken_edges.count > 0) {
    output += `BROKEN EDGES (reference deleted memories): ${report.broken_edges.count}\n`;
    for (const s of report.broken_edges.sample_ids) {
      output += `  ! Edge ${s.edge_id}: ${s.from_id} -> ${s.to_id} (${s.break_type})\n`;
    }
    output += '\n';
  }

  if (report.duplicate_pairs.count > 0) {
    output += `DUPLICATE PAIRS (word overlap > ${AUDIT_BM25_DUPE_THRESHOLD}): ${report.duplicate_pairs.count}\n`;
    for (const p of report.duplicate_pairs.sample_pairs) {
      output += `  ! Memory ${p.memory_a} <-> ${p.memory_b} (similarity: ${p.score.toFixed(3)})\n`;
    }
    output += '\n';
  }

  if (report.stale_memories.count > 0) {
    output += `STALE MEMORIES (active, 0 recalls, >${AUDIT_STALE_DAYS}d old): ${report.stale_memories.count}\n`;
    for (const id of report.stale_memories.sample_ids) {
      output += `  ! Memory ${id}\n`;
    }
    output += '\n';
  }

  if (report.invalid_embeddings.count > 0) {
    output += `INVALID EMBEDDINGS (embedding/vec mismatch): ${report.invalid_embeddings.count}\n`;
    for (const id of report.invalid_embeddings.sample_ids) {
      output += `  ! Memory ${id}\n`;
    }
    output += '\n';
  }

  if (report.healthy) {
    output += 'All clear -- no issues found.\n';
  }

  output += '========================';
  return output;
}

/**
 * Find duplicate memory pairs using FTS5 BM25 scoring.
 * Queries recent active memories against FTS5 and checks for
 * high word-overlap matches.
 */
function _findBM25Duplicates() {
  const results = [];
  const idsChecked = new Set();

  const memories = _db.prepare(`
    SELECT id, text FROM memories
    WHERE status = 'active' AND length(text) > 20
    ORDER BY created_at DESC LIMIT 200
  `).all();

  for (const mem of memories) {
    if (idsChecked.has(mem.id)) continue;

    // Build FTS5 query from significant words in the memory text
    const ftsQuery = mem.text
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2)
      .slice(0, 20)
      .join(' OR ');

    if (!ftsQuery || ftsQuery.length < 3) continue;

    try {
      const hits = _db.prepare(`
        SELECT rowid FROM memories_fts
        WHERE memories_fts MATCH ?
        ORDER BY rank LIMIT 5
      `).all(ftsQuery);

      for (const hit of hits) {
        if (hit.rowid === mem.id) continue;
        if (idsChecked.has(hit.rowid)) continue;

        const otherRow = _db.prepare('SELECT text FROM memories WHERE id = ?').get(hit.rowid);
        if (!otherRow) continue;

        const simScore = _wordOverlapSimilarity(mem.text, otherRow.text);
        if (simScore >= AUDIT_BM25_DUPE_THRESHOLD) {
          results.push({
            memory_a: Math.min(mem.id, hit.rowid),
            memory_b: Math.max(mem.id, hit.rowid),
            score: simScore,
          });
          idsChecked.add(mem.id);
          idsChecked.add(hit.rowid);
        }
      }
    } catch { /* FTS5 query syntax issues -- skip */ }
  }

  return results;
}

function _wordOverlapSimilarity(textA, textB) {
  const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}

// ── 4. Virtual Session Lifecycle ─────────────────────────────────────

/**
 * Track and manage virtual session lifecycle.
 * Sessions auto-expire after 30 minutes of inactivity (checked in maintenance).
 * On session close, auto-link memories that share entity/topic.
 *
 * @param {string} sessionId - Session to track
 * @param {'open'|'close'|'touch'} action - Session action
 * @param {object} [options]
 * @param {string} [options.summary] - End-of-session summary (for 'close')
 * @returns {{ session_id: string, status: string, memory_count: number, links_created: number, suggestions: string[] }}
 */
export function manageSession(sessionId, action, options = {}) {
  if (!sessionId) return { session_id: '', status: 'error', memory_count: 0, links_created: 0, suggestions: [] };

  if (action === 'open' || action === 'touch') {
    stmtUpsertSession.run({ sid: sessionId });
    const session = stmtGetActiveSession.get(sessionId);
    return {
      session_id: sessionId,
      status: session?.status || 'active',
      memory_count: session?.memory_count || 0,
      links_created: 0,
      suggestions: [],
    };
  }

  if (action === 'close') {
    // Find topic overlaps within session and create edges
    const mems = stmtGetSessionMemories.all(sessionId);
    let linksCreated = 0;

    // Link memories sharing the same entity
    const byEntity = new Map();
    for (const m of mems) {
      if (!m.entity) continue;
      if (!byEntity.has(m.entity)) byEntity.set(m.entity, []);
      byEntity.get(m.entity).push(m.id);
    }

    for (const [entity, ids] of byEntity) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length - 1 && linksCreated < SESSION_MAX_AUTO_LINKS; i++) {
        const a = Math.min(ids[i], ids[i + 1]);
        const b = Math.max(ids[i], ids[i + 1]);
        const existingCount = stmtCountEdgesBetween.get(a, b)?.cnt || 0;
        if (existingCount === 0) {
          stmtInsertCorecallEdge.run({
            from_id: a, to_id: b,
            strength: 0.7,
          });
          linksCreated++;
        }
      }
    }

    // Link memories sharing the same attribute (cross-entity connections)
    const byAttribute = new Map();
    for (const m of mems) {
      if (!m.attribute) continue;
      if (!byAttribute.has(m.attribute)) byAttribute.set(m.attribute, []);
      byAttribute.get(m.attribute).push(m.id);
    }

    for (const [attr, ids] of byAttribute) {
      if (ids.length < 2) continue;
      for (let i = 0; i < ids.length - 1 && linksCreated < SESSION_MAX_AUTO_LINKS; i++) {
        const a = Math.min(ids[i], ids[i + 1]);
        const b = Math.max(ids[i], ids[i + 1]);
        const existingCount = stmtCountEdgesBetween.get(a, b)?.cnt || 0;
        if (existingCount === 0) {
          stmtInsertCorecallEdge.run({
            from_id: a, to_id: b,
            strength: 0.5,
          });
          linksCreated++;
        }
      }
    }

    stmtCloseSession.run({ sid: sessionId, summary: options.summary || '' });

    // Suggest procedure distillation for frequently discussed topics
    const suggestions = [];
    for (const [entity, ids] of byEntity) {
      if (ids.length >= 3) {
        suggestions.push(`You discussed "${entity}" ${ids.length} times -- consider distilling a procedure?`);
      }
    }

    return {
      session_id: sessionId,
      status: 'closed',
      memory_count: mems.length,
      links_created: linksCreated,
      suggestions: suggestions.slice(0, 3),
    };
  }

  return { session_id: sessionId, status: 'unknown_action', memory_count: 0, links_created: 0, suggestions: [] };
}

/**
 * Get session status and metadata.
 *
 * @param {string} sessionId
 * @returns {object|null} Session record or null
 */
export function getSession(sessionId) {
  return stmtGetActiveSession.get(sessionId);
}

/**
 * Expire sessions that have been inactive for longer than the auto-expiry
 * threshold. Should be called during maintenance.
 *
 * @returns {number} Number of expired sessions
 */
export function expireInactiveSessions() {
  return stmtExpireSessions.run().changes;
}

/**
 * Track session activity (called from storeMemory wrapper).
 *
 * @param {string} sessionId
 */
export function trackSessionActivity(sessionId) {
  if (!sessionId) return;
  try { stmtUpsertSession.run({ sid: sessionId }); } catch { /* ignore */ }
}

// ── 5. Auto-Linking of Co-Accessed Memories ──────────────────────────

/**
 * Track co-recall: when multiple memories are recalled in the same
 * search batch, record them as co-recalled pairs. When a pair has
 * been co-recalled 3+ times, auto-create a related_to edge (done
 * in createCorecallEdges() during maintenance).
 *
 * @param {number[]} recalledIds - IDs of memories recalled in one batch
 */
export function trackCoRecall(recalledIds) {
  if (!recalledIds || recalledIds.length < 2) return;

  // Record all pairs (order-independent: memory_a < memory_b)
  const sorted = [...recalledIds].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      try {
        stmtIncrementCorecall.run({ a: sorted[i], b: sorted[j] });
      } catch { /* ignore constraint errors */ }
    }
  }
}

/**
 * Check co-recall pairs and auto-create related_to edges for pairs
 * that exceed the minimum count threshold. Run during maintenance.
 *
 * @returns {number} Number of new edges created
 */
export function createCorecallEdges() {
  const pairs = stmtGetCorecallPairs.all(CORECALL_MIN_COUNT_FOR_EDGE, 100);
  let edgesCreated = 0;

  for (const pair of pairs) {
    const existing = stmtCountEdgesBetween.get(pair.memory_a, pair.memory_b)?.cnt || 0;
    if (existing > 0) continue;

    const strength = Math.min(1.0, 0.3 + pair.count * 0.1);
    stmtInsertCorecallEdge.run({
      from_id: pair.memory_a,
      to_id: pair.memory_b,
      strength: Math.round(strength * 100) / 100,
    });
    edgesCreated++;
  }

  return edgesCreated;
}

// ── 6. Memory Feedback MCP Tool ──────────────────────────────────────

/**
 * Process memory feedback from the LLM. Positive signals boost recall
 * count and importance; negative signals decay importance. If importance
 * drops below the archive threshold after negative feedback, auto-archive.
 *
 * Adapted from Lemma's memory_feedback endpoint.
 *
 * @param {number} memoryId - Memory receiving feedback
 * @param {'positive'|'negative'} signal - Feedback signal
 * @returns {{ ok: boolean, memory_id: number, signal: string,
 *            importance_before: number, importance_after: number, archived: boolean }}
 */
export function processMemoryFeedback(memoryId, signal) {
  if (signal !== 'positive' && signal !== 'negative') {
    return { ok: false, memory_id: memoryId, signal, importance_before: 0, importance_after: 0, archived: false, reason: `Invalid signal: "${signal}"` };
  }

  const mem = stmtGetMemoryImportance.get(memoryId);
  if (!mem) {
    return { ok: false, memory_id: memoryId, signal, importance_before: 0, importance_after: 0, archived: false, reason: 'Memory not found' };
  }
  if (mem.status !== 'active') {
    return { ok: false, memory_id: memoryId, signal, importance_before: mem.importance, importance_after: mem.importance, archived: mem.status === 'archived', reason: `Memory is ${mem.status}` };
  }

  const importanceBefore = mem.importance || 0.5;
  let importanceAfter = importanceBefore;
  let archived = false;

  if (signal === 'positive') {
    stmtBoostRecallCount.run(FEEDBACK_POSITIVE_RECALL_BOOST, memoryId);
    stmtBoostImportance.run(FEEDBACK_POSITIVE_IMPORTANCE_BOOST, memoryId);
    importanceAfter = Math.min(1.0, importanceBefore + FEEDBACK_POSITIVE_IMPORTANCE_BOOST);
  } else {
    stmtDecayImportance.run(FEEDBACK_NEGATIVE_IMPORTANCE_DECAY, memoryId);
    importanceAfter = Math.max(0.05, importanceBefore - FEEDBACK_NEGATIVE_IMPORTANCE_DECAY);

    if (importanceAfter < FEEDBACK_ARCHIVE_THRESHOLD) {
      stmtArchiveMemory.run(memoryId);
      archived = true;
    }
  }

  stmtInsertFeedback.run(memoryId, signal, importanceBefore, importanceAfter);
  invalidateInjectionCache();

  return {
    ok: true,
    memory_id: memoryId,
    signal,
    importance_before: Math.round(importanceBefore * 1000) / 1000,
    importance_after: Math.round(importanceAfter * 1000) / 1000,
    archived,
  };
}

/**
 * Get feedback statistics for a memory.
 *
 * @param {number} memoryId
 * @returns {{ positive: number, negative: number }}
 */
export function getMemoryFeedbackStats(memoryId) {
  try {
    const stats = _db.prepare(`
      SELECT
        SUM(CASE WHEN signal = 'positive' THEN 1 ELSE 0 END) AS positive,
        SUM(CASE WHEN signal = 'negative' THEN 1 ELSE 0 END) AS negative
      FROM memory_feedback_log WHERE memory_id = ?
    `).get(memoryId);
    return { positive: stats.positive || 0, negative: stats.negative || 0 };
  } catch {
    return { positive: 0, negative: 0 };
  }
}

// ── Integration Helpers ──────────────────────────────────────────────

/**
 * Wrapper for storeMemory that also tracks session lifecycle,
 * co-recall, and invalidates ambient cache.
 *
 * @param {object} params - Same params as Noxem's storeMemory
 * @returns {number} The stored memory ID
 */
export function storeMemoryWithAmbient(params) {
  const id = storeMemory(params);
  trackSessionActivity(params.session_id || 'default');
  invalidateInjectionCache();
  return id;
}

/**
 * Wrapper for incrementRecallCounts that also tracks co-recall pairs.
 *
 * @param {number[]} ids - Memory IDs being recalled
 */
export function recallWithAmbient(ids) {
  _incrementRecallCounts(ids);
  trackCoRecall(ids);
}

/**
 * Run all ambient-injector maintenance tasks.
 * Call from Noxem's maintenance loop.
 *
 * @returns {{ expired_sessions: number, co_recall_links: number, audit_issues: number }}
 */
export function runAmbientMaintenance() {
  const summary = {
    expired_sessions: expireInactiveSessions(),
    co_recall_links: createCorecallEdges(),
    audit_issues: 0,
  };

  // Lightweight audit: count critical issues only
  try {
    const audit = runMemoryAudit();
    summary.audit_issues = (
      audit.orphaned_memories.count +
      audit.broken_edges.count +
      audit.invalid_embeddings.count
    );
  } catch { /* maintenance should never throw */ }

  return summary;
}

/**
 * Build all MCP tool definitions for the ambient-injector module.
 * Returns an array of tool objects compatible with Noxem's
 * mcp-server.mjs registerTool() pattern.
 *
 * Tools:
 *   - ambient_context: 3-layer memory injection (automatic at tools/list)
 *   - memory_audit: structural integrity checks
 *   - memory_feedback: positive/negative quality signals
 *   - session_manage: virtual session lifecycle
 *
 * @returns {Array<{name: string, description: string, inputSchema: object, handler: Function}>}
 */
export function buildAmbientInjectorTools() {
  return [
    {
      name: 'ambient_context',
      description: 'Pre-loaded ambient memory context. Contains key memories, summaries, and procedures auto-injected at session start. No explicit retrieval needed.',
      inputSchema: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Force refresh the ambient context cache' },
        },
      },
      handler: async ({ refresh = false }) => {
        const data = buildAmbientInjection(refresh);
        return { content: [{ type: 'text', text: data.toolDescription }] };
      },
    },
    {
      name: 'memory_audit',
      description: 'Run memory integrity audit. Checks for orphaned memories, broken edges, duplicates, stale entries, and invalid embeddings.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      handler: async () => {
        const report = runMemoryAudit();
        return { content: [{ type: 'text', text: formatAuditReport(report) }] };
      },
    },
    {
      name: 'memory_feedback',
      description: 'Signal whether a memory was helpful or not. Positive signals boost the memory; repeated negative signals auto-archive it.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'ID of the memory receiving feedback' },
          signal: { type: 'string', enum: ['positive', 'negative'], description: 'Feedback signal' },
        },
        required: ['memory_id', 'signal'],
      },
      handler: async ({ memory_id, signal }) => {
        const result = processMemoryFeedback(memory_id, signal);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    },
    {
      name: 'session_manage',
      description: 'Manage virtual session lifecycle. Open/touch sessions on activity, close with auto-linking of related memories and distillation suggestions.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session ID' },
          action: { type: 'string', enum: ['open', 'touch', 'close'], description: 'Session action' },
          summary: { type: 'string', description: 'End-of-session summary (for close action)' },
        },
        required: ['session_id', 'action'],
      },
      handler: async ({ session_id, action, summary = '' }) => {
        const result = manageSession(session_id, action, { summary });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      },
    },
  ];
}
