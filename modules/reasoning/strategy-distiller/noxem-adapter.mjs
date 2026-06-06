/**
 * ReasoningBank Noxem Adapter — Strategy-level memory for AI agents.
 *
 * Adapts ReasoningBank's trajectory distillation into Noxem's existing
 * SQLite store. Provides failure-aware extraction, reasoning retrieval,
 * multi-trajectory contrast, and LLM-as-judge quality gating.
 *
 * Reasoning memories use type='reasoning' and store structured metadata
 * in the existing `metadata` JSON column under key `reasoning_meta`:
 *   { title, description, outcome: 'success'|'failure'|'consolidated',
 *     task_type, key_insight }
 *
 * Depends on Noxem's memory-store.mjs (db, prepared statements) and
 * llmFetch from llm-fetch.mjs for Brain 2 calls.
 */

// Dependencies injected via initStrategyDistiller(db, deps)
let _db, _llmFetch;

const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const EXTRACT_TIMEOUT_MS = parseInt(process.env.EXTRACT_TIMEOUT_MS || '60000');
const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || '';



export function initStrategyDistiller(db, deps = {}) {
  _db = db;
  _llmFetch = deps.llmFetch;
  _boot();
}

// Failure signal keywords detected in L0 episode text
const FAILURE_SIGNALS = [
  'error', 'failed', 'failure', 'retry', 'fix', 'bug', 'crash',
  'exception', 'timeout', 'refused', 'denied', 'incorrect', 'wrong',
  'broken', 'stuck', 'unable', 'cannot', 'does not work', 'not working',
];
const SUCCESS_SIGNALS = [
  'success', 'completed', 'resolved', 'fixed', 'done', 'works now',
  'working', 'solved', 'passed', 'verified',
];

// ── Lazy init ───────────────────────────────────────────────
let _booted = false;
let getReasoningByTextSearch;
let insertReasoning;
let getReasoningByOutcome;
let getReasoningByEntity;

function _boot() {
  if (_booted) return;
  insertReasoning = _db.prepare(`
  INSERT INTO memories (session_id, type, text, embedding, metadata, importance,
  context_prefix, entity, attribute, valid_from, cone_layer)
  VALUES (@session_id, 'reasoning', @text, @embedding, @metadata, @importance,
  @context_prefix, @entity, @attribute, @valid_from, 1)
  `);
  getReasoningByOutcome = _db.prepare(`
  SELECT id, text, metadata, importance, entity, created_at
  FROM memories
  WHERE type = 'reasoning' AND status = 'active'
  AND json_extract(metadata, '$.reasoning_meta.outcome') = ?
  ORDER BY importance DESC, created_at DESC
  LIMIT ?
  `);
  getReasoningByEntity = _db.prepare(`
  SELECT id, text, metadata, importance, entity, created_at
  FROM memories
  WHERE type = 'reasoning' AND status = 'active' AND entity = ?
  ORDER BY importance DESC, created_at DESC
  LIMIT ?
  `);
  getReasoningByTextSearch = _db.prepare(`
  SELECT m.id, m.text, m.metadata, m.importance, m.entity, m.type, m.created_at
  FROM memories_fts f
  JOIN memories m ON m.id = f.rowid
  WHERE memories_fts MATCH @query AND m.type = 'reasoning' AND m.status = 'active'
  ORDER BY rank
  LIMIT @limit
  `);
  _booted = true;
}
// ── Utility ──────────────────────────────────────────────────────────

function ensureEmbeddingBuffer(embedding) {
  if (!embedding) return null;
  if (Buffer.isBuffer(embedding)) return embedding;
  if (embedding instanceof Float32Array) {
    const copy = new Float32Array(embedding);
    return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
  }
  if (Array.isArray(embedding)) {
    return Buffer.from(new Float32Array(embedding).buffer);
  }
  return null;
}

/**
 * Extract a balanced JSON array from LLM output.
 * Handles nested brackets and CRLF line endings.
 */
function extractBalancedArray(text) {
  text = text.replace(/\r/g, '');
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inStr) { escape = !escape; continue; }
    if (ch === '"' && inStr) { if (!escape) { inStr = false; } escape = false; continue; }
    if (ch === '"' && !inStr) { inStr = true; escape = false; continue; }
    escape = false;
    if (inStr) continue;
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth === 0) return text.substring(start, i + 1); }
  }
  return null;
}

/**
 * Detect outcome from L0 episode text.
 * Returns 'failure', 'success', or 'unknown'.
 */
function detectOutcome(text) {
  const lower = text.toLowerCase();
  let failureScore = 0;
  let successScore = 0;
  for (const sig of FAILURE_SIGNALS) {
    if (lower.includes(sig)) failureScore++;
  }
  for (const sig of SUCCESS_SIGNALS) {
    if (lower.includes(sig)) successScore++;
  }
  if (failureScore > successScore && failureScore >= 1) return 'failure';
  if (successScore > failureScore && successScore >= 1) return 'success';
  return 'unknown';
}

/**
 * Call Brain 2 (LLM) with a prompt and return the response content.
 */
async function callBrain2(messages, maxTokens = 1024) {
  const res = await _llmFetch(LLM_URL, {
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Brain 2 HTTP ${res.status}: ${res.statusText}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ── Core API ─────────────────────────────────────────────────────────

/**
 * Store a reasoning memory.
 *
 * @param {Object} opts
 * @param {string} opts.text - The reasoning content (strategy, anti-pattern, etc.)
 * @param {string} opts.session_id - Session ID
 * @param {Object} opts.reasoning_meta - { title, description, outcome, task_type, key_insight }
 * @param {Float32Array|Buffer|null} opts.embedding - Pre-computed embedding, or null
 * @param {string} opts.entity - Entity name (e.g., task type or project)
 * @param {number} [opts.importance] - Importance score (0-1), default 0.7
 * @returns {number} The new memory ID
 */
export async function storeReasoningMemory({
  text, session_id = '', reasoning_meta = {},
  embedding = null, entity = '', importance = 0.7,
}) {
  const metadata = { reasoning_meta };
  const result = insertReasoning.run({
    session_id,
    text,
    embedding: ensureEmbeddingBuffer(embedding),
    metadata: JSON.stringify(metadata),
    importance,
    context_prefix: `Reasoning, ${reasoning_meta.outcome || 'unknown'}:`,
    entity,
    attribute: reasoning_meta.task_type || 'strategy',
    valid_from: new Date().toISOString(),
  });
  const id = Number(result.lastInsertRowid);

  // Update vector index if embedding provided
  if (embedding) {
    try {
      const { insertVec, isVecReady } = await import('../../server/vector-index.mjs');
      if (isVecReady()) {
        const vec = Array.isArray(embedding) ? embedding : Array.from(new Float32Array(ensureEmbeddingBuffer(embedding)));
        insertVec(db, id, vec);
      }
    } catch (e) { LOG_DEBUG && console.error('[ReasoningBank] Vec insert failed:', e.message); }
  }

  LOG_DEBUG && console.log(`[ReasoningBank] Stored reasoning #${id}: ${reasoning_meta.outcome} / ${reasoning_meta.title || '(untitled)'}`);
  return id;
}

/**
 * Extract reasoning memories from a task trajectory.
 * Detects success/failure outcome and uses Brain 2 to distill lessons.
 *
 * @param {string} trajectory - The task steps/actions/observations
 * @param {string} query - The original task or question
 * @param {string} sessionId - Session ID for the new memories
 * @param {Object} [opts] - Optional overrides
 * @param {string} [opts.forceOutcome] - Override auto-detected outcome ('success'|'failure')
 * @param {string} [opts.entity] - Entity to tag on the reasoning memory
 * @returns {Promise<Array>} Array of stored reasoning memory IDs
 */
export async function extractReasoningFromTrace(trajectory, query, sessionId, opts = {}) {
  const outcome = opts.forceOutcome || detectOutcome(trajectory);

  const systemPrompt = outcome === 'failure'
    ? `The following trajectory FAILED to address the query. Analyze the failure and distill the lessons learned into reasoning memories. Each memory should have a title, a short description, and content describing the pitfall and how to avoid it. Return ONLY a JSON array: [{"title":"...","description":"...","content":"...","task_type":"...","key_insight":"..."}]. Max 5 items.`
    : outcome === 'success'
      ? `The following trajectory SUCCESSFULLY addressed the query. Distill the key reasoning steps and strategies into reusable memories. Each memory should have a title, a short description, and content. Return ONLY a JSON array: [{"title":"...","description":"...","content":"...","task_type":"...","key_insight":"..."}]. Max 5 items.`
      : `Analyze the following trajectory and extract reusable reasoning patterns — what worked, what did not, and key insights. Return ONLY a JSON array: [{"title":"...","description":"...","content":"...","task_type":"...","key_insight":"...","outcome":"success|failure|unknown"}]. Max 5 items.`;

  const userPrompt = `Query: ${query}\n\nTrajectory:\n${trajectory.substring(0, 4000)}`;

  try {
    const content = await callBrain2([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    const arrayStr = extractBalancedArray(content);
    if (!arrayStr) {
      LOG_DEBUG && console.warn('[ReasoningBank] No JSON array in distillation response');
      return [];
    }

    let items;
    try { items = JSON.parse(arrayStr); } catch { return []; }
    if (!Array.isArray(items)) return [];

    // LLM-as-judge quality gate
    const judgedItems = await judgeReasoningQuality(items);

    const ids = [];
    for (const item of judgedItems.slice(0, 5)) {
      if (!item.title || !item.content) continue;
      const itemOutcome = item.outcome || outcome;
      const id = storeReasoningMemory({
        text: item.content.substring(0, 500),
        session_id: sessionId,
        reasoning_meta: {
          title: item.title.substring(0, 100),
          description: (item.description || '').substring(0, 200),
          outcome: itemOutcome,
          task_type: item.task_type || 'general',
          key_insight: (item.key_insight || '').substring(0, 200),
        },
        entity: opts.entity || item.task_type || '',
        importance: item._quality_score ? item._quality_score * 0.5 + 0.3 : 0.7,
      });
      ids.push(id);
    }

    LOG_DEBUG && console.log(`[ReasoningBank] Distilled ${ids.length} reasoning memories (outcome=${outcome})`);
    return ids;
  } catch (err) {
    LOG_DEBUG && console.error('[ReasoningBank] Extraction error:', err.message);
    return [];
  }
}

/**
 * LLM-as-judge quality gate.
 * Rates each reasoning item on quality (1-5) and generalizability.
 * Items scoring < 3 get degraded importance.
 *
 * @param {Array} items - Distilled reasoning items
 * @returns {Promise<Array>} Items with _quality_score appended (0.0-1.0)
 */
export async function judgeReasoningQuality(items) {
  if (items.length === 0) return items;

  const itemsJson = JSON.stringify(items.map(({ title, description, content }) => ({
    title, description, content: content.substring(0, 200),
  })));

  try {
    const content = await callBrain2([
      {
        role: 'system',
        content: 'Rate the quality of each reasoning memory on a 1-5 scale. Consider: Is the insight generalizable? Is it actionable? Is it specific enough to be useful? Return ONLY a JSON array of numbers, one per item, in order.',
      },
      { role: 'user', content: itemsJson },
    ], 256);

    const arrayStr = extractBalancedArray(content);
    if (arrayStr) {
      try {
        const scores = JSON.parse(arrayStr);
        if (Array.isArray(scores)) {
          return items.map((item, i) => {
            const raw = typeof scores[i] === 'number' ? scores[i] : 3;
            const normalized = Math.max(0, Math.min(1, raw / 5));
            return { ...item, _quality_score: normalized };
          });
        }
      } catch { /* fall through to default scores */ }
    }
  } catch (err) {
    LOG_DEBUG && console.warn('[ReasoningBank] Judge call failed, using default scores:', err.message);
  }

  // Default: all items get score 0.6 (moderate quality)
  return items.map(item => ({ ...item, _quality_score: 0.6 }));
}

/**
 * Retrieve reasoning memories relevant to a task description.
 * Used at task start to inject "how to approach this" context.
 *
 * @param {string} taskDescription - The new task description
 * @param {Object} [opts]
 * @param {string} [opts.task_type] - Filter by task type
 * @param {number} [opts.limit] - Max memories per outcome (default 3)
 * @returns {Promise<Object>} { success: [...], failure: [...], consolidated: [...] }
 */
export async function reasoningRecall(taskDescription, opts = {}) {
  const limit = opts.limit || 3;
  const results = { success: [], failure: [], consolidated: [] };

  // FTS5 search for reasoning memories matching the task
  let ftsHits = [];
  try {
    let sanitized = taskDescription
      .replace(/(?:\w+:)/g, '')
      .replace(/\b(?:AND|OR|NOT|NEAR)\b/gi, '')
      .replace(/['"*^$]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (sanitized) {
      ftsHits = getReasoningByTextSearch.all({ query: sanitized, limit: limit * 3 });
    }
  } catch (e) {
    LOG_DEBUG && console.warn('[ReasoningBank] FTS search error:', e.message);
  }

  // Also search by entity/task_type if provided
  let entityHits = [];
  if (opts.task_type) {
    entityHits = getReasoningByEntity.all(opts.task_type, limit * 2);
  }

  // Deduplicate and categorize by outcome
  const seen = new Set();
  const allHits = [...ftsHits, ...entityHits];
  for (const hit of allHits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);

    let meta = {};
    try {
      const parsed = JSON.parse(hit.metadata || '{}');
      meta = parsed.reasoning_meta || {};
    } catch { /* use default empty meta */ }

    const entry = {
      id: hit.id,
      text: hit.text,
      title: meta.title || '',
      key_insight: meta.key_insight || '',
      importance: hit.importance,
      entity: hit.entity,
    };

    const outcome = meta.outcome || 'unknown';
    if (outcome === 'success' && results.success.length < limit) {
      results.success.push(entry);
    } else if (outcome === 'failure' && results.failure.length < limit) {
      results.failure.push(entry);
    } else if (outcome === 'consolidated' && results.consolidated.length < limit) {
      results.consolidated.push(entry);
    }
  }

  // Increment recall counts for retrieved memories
  try {
    const { incrementRecallCounts } = await import('../../server/memory-store.mjs');
    const allIds = [
      ...results.success.map(r => r.id),
      ...results.failure.map(r => r.id),
      ...results.consolidated.map(r => r.id),
    ];
    if (allIds.length > 0) incrementRecallCounts(allIds);
  } catch { /* non-critical */ }

  return results;
}

/**
 * Format reasoning context for injection into an LLM prompt.
 * Produces a concise block of success strategies + failure anti-patterns.
 *
 * @param {Object} recalled - Output from reasoningRecall()
 * @returns {string} Formatted reasoning context block
 */
export function formatReasoningContext(recalled) {
  const lines = [];

  if (recalled.success.length > 0) {
    lines.push('Similar tasks that SUCCEEDED:');
    for (const s of recalled.success) {
      lines.push(`- ${s.title || 'Strategy'}: ${s.key_insight || s.text.substring(0, 100)}`);
    }
  }

  if (recalled.failure.length > 0) {
    lines.push('Similar tasks that FAILED (avoid these patterns):');
    for (const f of recalled.failure) {
      lines.push(`- ${f.title || 'Pitfall'}: ${f.key_insight || f.text.substring(0, 100)}`);
    }
  }

  if (recalled.consolidated.length > 0) {
    lines.push('Consolidated best practices:');
    for (const c of recalled.consolidated) {
      lines.push(`- ${c.title || 'Best practice'}: ${c.key_insight || c.text.substring(0, 100)}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '';
}

/**
 * Multi-trajectory contrast: compare success and failure reasoning
 * memories for the same entity/task_type, produce a consolidated
 * best-practice summary via Brain 2.
 *
 * @param {string} entity - Entity or task type to contrast
 * @param {Object} [opts]
 * @param {number} [opts.limit] - Max memories per outcome to contrast (default 5)
 * @returns {Promise<number|null>} ID of the consolidated reasoning memory, or null
 */
export async function contrastTrajectories(entity, opts = {}) {
  const limit = opts.limit || 5;

  const successes = getReasoningByOutcome.all('success', limit)
    .filter(m => !entity || m.entity === entity);
  const failures = getReasoningByOutcome.all('failure', limit)
    .filter(m => !entity || m.entity === entity);

  if (successes.length === 0 || failures.length === 0) {
    LOG_DEBUG && console.log('[ReasoningBank] contrastTrajectories: need both success and failure memories');
    return null;
  }

  const successText = successes.map(m => `- [success] ${m.text}`).join('\n');
  const failureText = failures.map(m => `- [failure] ${m.text}`).join('\n');

  try {
    const content = await callBrain2([
      {
        role: 'system',
        content: 'Compare these successful and failed reasoning memories for the same task type. Extract a consolidated best-practice summary: what works, what does not, and the key insight. Return a single JSON object: {"title":"...","description":"...","content":"...","key_insight":"..."}.',
      },
      {
        role: 'user',
        content: `Successful strategies:\n${successText}\n\nFailed approaches:\n${failureText}`,
      },
    ]);

    const jsonStr = content.match(/\{[\s\S]*?\}/);
    if (!jsonStr) return null;

    let consolidated;
    try { consolidated = JSON.parse(jsonStr[0]); } catch { return null; }
    if (!consolidated.title || !consolidated.content) return null;

    const id = storeReasoningMemory({
      text: consolidated.content.substring(0, 500),
      session_id: 'reasoning_contrast',
      reasoning_meta: {
        title: consolidated.title,
        description: (consolidated.description || '').substring(0, 200),
        outcome: 'consolidated',
        task_type: entity || 'general',
        key_insight: (consolidated.key_insight || '').substring(0, 200),
      },
      entity: entity || '',
      importance: 0.85,
    });

    // Create edges from consolidated to source memories
    try {
      const { storeEdge } = await import('../../server/memory-store.mjs');
      for (const s of successes.slice(0, 3)) {
        storeEdge({ from_id: id, to_id: s.id, relation: 'contrasts_with', strength: 0.6, source_session_id: 'reasoning_contrast' });
      }
      for (const f of failures.slice(0, 3)) {
        storeEdge({ from_id: id, to_id: f.id, relation: 'contrasts_with', strength: 0.6, source_session_id: 'reasoning_contrast' });
      }
    } catch { /* non-critical */ }

    LOG_DEBUG && console.log(`[ReasoningBank] Contrasted ${successes.length} success + ${failures.length} failure -> consolidated #${id}`);
    return id;
  } catch (err) {
    LOG_DEBUG && console.error('[ReasoningBank] Contrast error:', err.message);
    return null;
  }
}

/**
 * Failure-aware extraction hook for the pipeline.
 * Call after L0 memory store to detect failures and extract reasoning.
 *
 * @param {string} text - L0 episode text
 * @param {string} sessionId - Session ID
 * @returns {Promise<Array>} Array of reasoning memory IDs (empty if no failure detected)
 */
export async function onFailureAwareExtract(text, sessionId) {
  const outcome = detectOutcome(text);
  if (outcome !== 'failure') return [];

  LOG_DEBUG && console.log('[ReasoningBank] Failure detected in L0 episode, extracting reasoning');

  const content = await callBrain2([
    {
      role: 'system',
      content: 'This task attempt failed. Analyze what went wrong and extract actionable anti-patterns. What should be done differently next time? Return ONLY a JSON array: [{"title":"...","description":"...","content":"...","task_type":"...","key_insight":"..."}]. Max 3 items.',
    },
    { role: 'user', content: text.substring(0, 3000) },
  ]);

  const arrayStr = extractBalancedArray(content);
  if (!arrayStr) return [];

  let items;
  try { items = JSON.parse(arrayStr); } catch { return []; }
  if (!Array.isArray(items)) return [];

  const judgedItems = await judgeReasoningQuality(items);

  const ids = [];
  for (const item of judgedItems.slice(0, 3)) {
    if (!item.title || !item.content) continue;
    const id = storeReasoningMemory({
      text: item.content.substring(0, 500),
      session_id: sessionId,
      reasoning_meta: {
        title: item.title.substring(0, 100),
        description: (item.description || '').substring(0, 200),
        outcome: 'failure',
        task_type: item.task_type || 'general',
        key_insight: (item.key_insight || '').substring(0, 200),
      },
      importance: item._quality_score ? item._quality_score * 0.5 + 0.3 : 0.6,
    });
    ids.push(id);
  }

  return ids;
}

/**
 * Get reasoning memory statistics.
 *
 * @returns {Object} Counts by outcome type
 */
export function getReasoningStats() {
  const stats = { success: 0, failure: 0, consolidated: 0, unknown: 0, total: 0 };
  const rows = _db.prepare(`
    SELECT json_extract(metadata, '$.reasoning_meta.outcome') as outcome, COUNT(*) as cnt
    FROM memories
    WHERE type = 'reasoning' AND status = 'active'
    GROUP BY outcome
  `).all();

  for (const row of rows) {
    const outcome = row.outcome || 'unknown';
    stats[outcome] = (stats[outcome] || 0) + row.cnt;
    stats.total += row.cnt;
  }

  return stats;
}

export default {
  storeReasoningMemory,
  extractReasoningFromTrace,
  judgeReasoningQuality,
  reasoningRecall,
  formatReasoningContext,
  contrastTrajectories,
  onFailureAwareExtract,
  getReasoningStats,
};
