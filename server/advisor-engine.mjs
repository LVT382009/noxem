const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
/**
 * Advisor Engine — Brain 2 advisor for drift detection + context recovery.
 *
 * v2: RLM bridge integration — decomposes tasks into sub-calls for
 * deeper analysis with full memory corpus visibility.
 * Falls back to single-shot LLM calls when RLM is unavailable.
 *
 * DDG web search has been moved to research-engine.mjs.
 * This module focuses on:
 * - Pre-compression context preservation
 * - Task drift detection
 * - Session-end memory extraction
 * - Advice and guidance
 */
import { callRLMWithFallback, getRLMStatus, shutdownRLM } from './rlm-bridge.mjs';
import { llmFetch } from './llm-fetch.mjs';
import { LLM_URL, LLM_MODEL } from './llm-config.mjs';
const CONTEXT_WINDOW = parseInt(process.env.NOXEM_CONTEXT_WINDOW ?? '8192');
const ADVISOR_ENABLED = process.env.ADVISOR_ENABLED !== 'false';
// Balanced-array extraction. The LLM returns a JSON array of memories, but model output often
// wraps it in prose ("Here are the memories:\n[...]"). The old extractors used two different
// regexes: :\d greedy /\[[\s\S]*\]/ over-grabs from the first '[' to the LAST ']' (wrong if any
// prose/bracket follows the array) and :\d lazy /\[[\s\S]*?\]/ stops at the first ']' — which a
// ']' inside a memory string literal ("see array[0]", "[id=42]") trips early, silently truncating
// the array so JSON.parse either fails or drops everything after that ']' (silent chunk loss). Walk
// bracket depth honoring string literals + backslash escapes instead; returns null when no balanced
// array exists so the caller can fall through to its empty-result branch.
function extractFirstJsonArray(s) {
  if (!s) return null;
  const start = s.indexOf('[');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null; // unbalanced — no parseable array
}
function callLLM(messages, maxTokens = 1024, temperature = 0.3) {
  return llmFetch(LLM_URL, {
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
    }, { timeoutMs: 30_000, enforceSizeLimit: true });
}

/**
 * E2 J3 consolidate-synth — synthesize ONE canonical facet text for a near-duplicate cluster,
 * REPLACING the literal `texts.join(' | ')` the old consolidateMemories used.
 *
 * High-stakes: this runs inside the maintenance cron's content-merge path (called by BOTH
 * consolidateMemories AND consolidateSemantically). The caller REQUIRES a clean (degraded===false)
 * synth before it will merge a CONTENT cluster — on any miss (LLM off / qwenproxy WAF / timeout /
 * bad shape) it returns degraded:true and the caller performs NO merge (today's behavior preserved
 * = zero data loss). Trivial-intent clusters are merged by the caller even when degraded
 * (interchangeable greetings).
 *
 * Since Option C (LLM-at-cleanup-only) this gate is the SOLE content-fold authority. STEP 1 now
 * judges merge-safety first and emits exactly DEGRADED for a cluster of DISTINCT facts (different
 * attributes/entities) — a cross-attribute guard detectContradiction (same-attribute only) cannot
 * make. The caller skips the merge on degraded (reason 'distinct'), so distinct facts are never
 * folded into one (the silent-loss vector closed at the CRON).
 *
 * Never throws (cron hot path). Returns {text, degraded, reason}.
 *   - text   : canonical sentence (string|null)
 *   - degraded: true when no LLM, LLM failed, OR the cluster is distinct facts → caller must NOT
 *     merge content clusters
 *   - reason  : short diagnostic for logs (too-few / http / empty / bad-shape / distinct / timeout)
 */
export async function synthesizeConsolidation(cluster, { temperature = 0.4, timeoutMs = 40_000, maxTokens = 256 } = {}) {
  try {
    const texts = (Array.isArray(cluster) ? cluster : []).map(m => (m?.text ?? '').trim()).filter(Boolean);
    if (texts.length < 2) return { text: texts[0] || null, degraded: true, reason: 'too-few' };
    const messages = [
      {
        role: 'system',
        content: 'consolidate-synth gate (E2 J3): STEP 1 - judge whether the N memories below are NEAR-DUPLICATES (the same single fact restated/rephrased) or DISTINCT facts (different attributes, entities, or topics). If they are DISTINCT facts (NOT near-duplicates), output exactly DEGRADED and nothing else. STEP 2 - only if they are near-duplicates, condense them into ONE canonical facet sentence preserving every distinct fact, dropping pure duplicates, inventing nothing not present. Output ONLY the single sentence - no quotes, no JSON, no preamble, no numbering.',
      },
      { role: 'user', content: texts.map((t, i) => `${i + 1}. ${t}`).join('\n') },
    ];
    const res = await llmFetch(LLM_URL, {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: maxTokens, temperature }),
    }, { timeoutMs, enforceSizeLimit: true });
    if (!res.ok) return { text: null, degraded: true, reason: `http ${res.status}` };
    const data = await res.json().catch(() => null);
    const content = (data?.choices?.[0]?.message?.content || '').trim();
    if (!content) return { text: null, degraded: true, reason: 'empty' };
    // strip surrounding quotes/backticks a model may add
    const text = content.replace(/^["'`]+|["'`.,;\s]+$/g, '').trim();
    // Merge-safety gate (Risk 1 closure): the model judged the cluster DISTINCT facts (different
    // attributes), not near-duplicates -> do NOT merge. detectContradiction (memory-maintenance:353)
    // only checks SAME-attribute contradictions; this gate catches the cross-attribute distinct-fact
    // case it misses, which would otherwise be a silent loss (distinct facts folded into one). The
    // caller skips the merge on degraded, same as a too-few/http-fail/empty/bad-shape miss.
    if (text.toUpperCase() === 'DEGRADED') return { text: null, degraded: true, reason: 'distinct' };
    if (!text || text.length < 3 || text.length > 2000) return { text: null, degraded: true, reason: 'bad-shape' };
    return { text, degraded: false };
  } catch (e) {
    return { text: null, degraded: true, reason: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'error') };
  }
}

// Pre-compression advisor: analyze conversation before compaction
export async function analyzeBeforeCompress(conversationHistory, sessionMemories, { structured = false } = {}) {
  if (!ADVISOR_ENABLED) return fallbackCompressAnalysis(conversationHistory, sessionMemories);
  const { data, source, metadata } = await callRLMWithFallback({
    task: 'pre_compress_analysis',
    context: { conversationHistory, sessionMemories },
    fallbackFn: () => _singleShotCompress(conversationHistory, sessionMemories),
    timeout: 45_000,
  });
  LOG_DEBUG && console.log(`[Advisor] analyzeBeforeCompress: source=${source}, calls=${metadata.calls}`);
  // If RLM returned structured data, format it
  if (source === 'rlm' && typeof data === 'object' && !Array.isArray(data)) {
    if (structured) return data; // Return raw structured object
    const lines = [];
    if (data.critical_context?.length) lines.push(`CRITICAL_CONTEXT:\n${data.critical_context.map(c => `- ${c}`).join('\n')}`);
    if (data.task_drift_warnings?.length) lines.push(`TASK_DRIFT_WARNINGS:\n${data.task_drift_warnings.map(w => `- ${w}`).join('\n')}`);
    if (data.key_facts?.length) lines.push(`KEY_FACTS:\n${data.key_facts.map(f => `- ${typeof f === 'string' ? f : f.text || JSON.stringify(f)}`).join('\n')}`);
    if (data.advice) lines.push(`ADVICE: ${data.advice}`);
    return lines.length > 0 ? lines.join('\n\n') : 'CRITICAL_CONTEXT: No critical context detected.\nADVICE: Proceed normally.';
  }
  // Fallback: data is the raw text string from single-shot
  if (structured) {
    // Parse text into structured format
    return { critical_context: [], task_drift_warnings: [], key_facts: [], advice: typeof data === 'string' ? data : '' };
  }
  return data;
}
// Proactive advisor: called when advice is explicitly requested
export async function getAdvice({ userMessage, conversationHistory, activeMemories, currentTaskContext, structured = false }) {
  if (!ADVISOR_ENABLED) return fallbackAdvice();
  const { data, source, metadata } = await callRLMWithFallback({
    task: 'advice',
    context: { userMessage, conversationHistory, activeMemories, currentTaskContext },
    fallbackFn: () => _singleShotAdvice({ userMessage, conversationHistory, activeMemories, currentTaskContext }),
    timeout: 30_000,
  });
  LOG_DEBUG && console.log(`[Advisor] getAdvice: source=${source}, calls=${metadata.calls}`);
  // If RLM returned structured data, format it
  if (source === 'rlm' && typeof data === 'object' && !Array.isArray(data)) {
    if (structured) return data; // Return raw structured object
    if (!data.drift_detected && data.advice_text === 'All good — no issues detected.') {
      return data.advice_text;
    }
    const parts = [];
    if (data.drift_detected) parts.push(`DRIFT DETECTED (${data.severity || 'medium'}): ${data.drift_details?.join('; ') || 'See warnings above'}`);
    if (data.relevant_memories?.length) parts.push(`Relevant memories: ${data.relevant_memories.join('; ')}`);
    if (data.advice_text) parts.push(data.advice_text);
    return parts.length > 0 ? parts.join('\n\n') : 'All good — no issues detected.';
  }
  // Fallback: data is raw text from single-shot
  if (structured) {
    return { drift_detected: false, drift_details: [], relevant_memories: [], advice_text: typeof data === 'string' ? data : '', severity: 'none' };
  }
  return data;
}
// Session end analysis: extract final memories, summarize
export async function analyzeSessionEnd(conversationHistory, allSessionMemories) {
  if (!ADVISOR_ENABLED) return [];
  const { data, source, metadata } = await callRLMWithFallback({
    task: 'session_end_analysis',
    context: { conversationHistory, allSessionMemories },
    fallbackFn: () => _singleShotSessionEnd(conversationHistory),
    timeout: 45_000,
  });
  LOG_DEBUG && console.log(`[Advisor] analyzeSessionEnd: source=${source}, calls=${metadata.calls}`);
  // If RLM returned structured data
  if (source === 'rlm' && typeof data === 'object' && data.memories) {
    return data.memories.filter(m => m.text && m.type);
  }
  // Fallback: data is the raw array from single-shot
  return data;
}
// ── Single-shot LLM calls (kept as fallbacks) ──────────────
async function _singleShotCompress(conversationHistory, sessionMemories) {
  const recentTurns = (conversationHistory || []).slice(-30);
  const convoText = recentTurns.map(t =>
    `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, 3000)}`
  ).join('\n\n');
  const memorySummary = (sessionMemories || []).slice(-25).map(m =>
    `[${m.type}] ${m.text}`
  ).join('\n');
  const messages = [
    {
      role: 'system',
      content: `You are a second-brain AI advisor for a coding agent called Hermes. Your job is to:
1. Review the conversation below and identify CRITICAL context that must survive context compaction
2. Detect any "task drift" — the agent forgetting important task parameters (e.g. building in wrong OS/environment, using wrong tools)
3. Warn about anything the agent might have forgotten or gotten wrong
4. Extract specific facts, preferences, and decisions made during this conversation
Note: Web research is handled by a separate research pipeline. Research memories (type: learning) may already be in the session memories above.
Your output must be in this format:
CRITICAL_CONTEXT: (what must survive)
TASK_DRIFT_WARNINGS: (warnings if any)
KEY_FACTS: (factual memories to extract)
ADVICE: (advice for the agent)
Stay factual and concise. Only flag real issues, not hypothetical ones.`,
    },
    {
      role: 'user',
      content: `Session memories:\n${memorySummary || 'None yet'}\n\nRecent conversation:\n${convoText}\n\nAnalyze for compaction survival:`,
    },
  ];
  try {
    const res = await callLLM(messages, 1024, 0.2);
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text().catch(() => '')).substring(0, 200)}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || fallbackCompressAnalysis(conversationHistory, sessionMemories);
  } catch (err) {
    LOG_DEBUG && console.error('Compress analysis error:', err.message);
    return fallbackCompressAnalysis(conversationHistory, sessionMemories);
  }
}
async function _singleShotAdvice({ userMessage, conversationHistory, activeMemories, currentTaskContext }) {
  const taskSummary = currentTaskContext
    ? `Current task: ${currentTaskContext.substring(0, 500)}`
    : '';
  const memoryBlock = (activeMemories || []).slice(-25).map(m =>
    `[${m.type}] ${m.text}`
  ).join('\n');
  const recentTurns = (conversationHistory || []).slice(-15).map(t =>
    `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, 1500)}`
  ).join('\n');
  const messages = [
    {
      role: 'system',
      content: `You are a second-brain AI advisor for a coding agent called Hermes. Your responsibilities:
1. TASK MONITORING — Track what the user is building and flag if Hermes drifts from user's intended setup (wrong OS, wrong directory, wrong tools)
2. MEMORY ENHANCEMENT — If Hermes seems confused or has forgotten something from earlier in the conversation, remind it using the stored memories
3. CONTEXT RECOVERY — After context compaction, help Hermes recover critical information
Note: Web research is handled separately by the research pipeline. Research memories (type: learning) are available in the session memories above.
Respond concisely. If everything looks fine, say "All good — no issues detected." Only flag real problems.`,
    },
    {
      role: 'user',
      content: `Current memories:\n${memoryBlock || 'None stored yet'}\n${taskSummary}\n\nRecent conversation:\n${recentTurns || 'Starting new conversation'}\n\nUser says: ${(userMessage || '').substring(0, 500)}\n\nProvide advice:`,
    },
  ];
  try {
    const res = await callLLM(messages, 800, 0.2);
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text().catch(() => '')).substring(0, 200)}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || fallbackAdvice();
  } catch (err) {
    LOG_DEBUG && console.error('Advisor error:', err.message);
    return fallbackAdvice();
  }
}
async function _singleShotSessionEnd(conversationHistory) {
  // v2: Process entire session history in chunks, then merge
  const fullHistory = conversationHistory || [];
  const CHUNK_SIZE = 10;
  const allMemories = [];
  // Fallback for short sessions: process in one call
  if (fullHistory.length <= 20) {
    const convoText = fullHistory.map(t =>
      `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, Math.max(200, Math.min(Math.floor(CONTEXT_WINDOW * 0.18), 32000)))}`
    ).join('\n\n');
    const messages = [
      {
        role: 'system',
        content: `Extract factual memories from this conversation. Return ONLY a JSON array. Each memory: {"text": "...", "type": "fact|preference|project|goal|pattern|entity|event|issue|setup|learning|profile"}
Rules:
- Extract only non-obvious, durable facts
- Omit greetings, small talk, trivial confirmations
- Include user preferences, project details, technical setup, goals
- Include patterns (how user works) and entities (tools, people, services mentioned)`,
      },
      { role: 'user', content: `Conversation:\n${convoText}\n\nExtract memories:` },
    ];
    try {
      const res = await callLLM(messages, 1024, 0.1);
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text().catch(() => '')).substring(0, 200)}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content || content.startsWith('[LLM un')) return [];
      const jsonArr = extractFirstJsonArray(content);
      if (!jsonArr) return [];
      const memories = JSON.parse(jsonArr);
      return Array.isArray(memories) ? memories.filter(m => m.text && m.type) : [];
    } catch (err) {
      LOG_DEBUG && console.error('Session end analysis error:', err.message);
      return [];
    }
  }
  // Long sessions: chunk and extract per segment, then dedup
  const chunks = [];
  for (let i = 0; i < fullHistory.length; i += CHUNK_SIZE) {
    chunks.push(fullHistory.slice(i, i + CHUNK_SIZE));
  }
  // BUG-17: Process chunks in parallel with concurrency limit (3 concurrent LLM calls).
  // No silent cap — the old `.slice(0, 10)` dropped every chunk past the 100th turn with no
  // signal, so a long session's tail was never extracted. CONCURRENCY_LIMIT below bounds the
  // concurrent LLM calls; the total count is log-visible so a runaway session is seen, not hidden.
  if (LOG_DEBUG && chunks.length > 0) console.log(`[advisor] session-end extracting ${chunks.length} chunk(s) (CHUNK_SIZE=${CHUNK_SIZE})`);
  const chunkTasks = chunks.map(chunk => async () => {
    const chunkText = chunk.map(t =>
      `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, Math.max(200, Math.min(Math.floor(CONTEXT_WINDOW * 0.18), 32000)))}`
    ).join('\n\n');
    const messages = [
      {
        role: 'system',
        content: `Extract factual memories from this conversation chunk. Return ONLY a JSON array: [{"text": "...", "type": "fact|preference|project|goal|pattern|entity|event|issue|setup|learning|profile"}]
Rules: Extract only non-obvious, durable facts. Omit greetings, small talk.`,
      },
      { role: 'user', content: `Chunk:\n${chunkText}\n\nExtract memories:` },
    ];
    try {
      const res = await callLLM(messages, 1024, 0.1);
      if (!res.ok) { LOG_DEBUG && console.error(`LLM HTTP ${res.status} for session-end chunk`); return []; }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) return [];
      const jsonArr = extractFirstJsonArray(content);
      if (!jsonArr) return [];
      const chunkMems = JSON.parse(jsonArr);
      return Array.isArray(chunkMems) ? chunkMems.filter(m => m.text && m.type) : [];
    } catch (err) {
      LOG_DEBUG && console.error('Chunk extraction error:', err.message);
      return [];
    }
  });
  const CONCURRENCY_LIMIT = 3;
  const executing = new Set();
  const results = [];
  for (const task of chunkTasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p);
    results.push(p);
    if (executing.size >= CONCURRENCY_LIMIT) await Promise.race(executing);
  }
  const allChunkResults = await Promise.all(results);
  for (const r of allChunkResults) {
    if (Array.isArray(r)) allMemories.push(...r);
  }
  // Simple dedup by text prefix
  const seen = new Set();
  return allMemories.filter(m => {
    const key = m.text.toLowerCase().substring(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
// Fallback: rule-based analysis when LLM is unavailable
function fallbackCompressAnalysis(conversationHistory, sessionMemories) {
  const turnText = (conversationHistory || []).map(t => (t.content || '')).join(' ').toLowerCase();
  const lines = [];
  // Detect OS/platform mentions
  if (/wsl|ubuntu|linux/i.test(turnText)) lines.push('- Working in WSL/Linux environment confirmed');
  if (/windows|native|powershell/i.test(turnText)) lines.push('- Working in Windows environment');
  if (/wsl.*windows|windows.*wsl/i.test(turnText)) lines.push('- Cross-platform: WSL + Windows both referenced');
  // Detect project names
  const projMatch = turnText.match(/(?:building|working on|creating) (\w[\w\s-]{1,30}?)(?:\.|,|!|$)/gi);
  if (projMatch) {
    for (const p of projMatch) {
      lines.push(`- Project: ${p}`);
    }
  }
  // Detect key tools/tech
  const techs = ['python', 'node', 'rust', 'react', 'docker', 'sqlite', 'express', 'llm', 'hermes'];
  for (const t of techs) {
    if (turnText.includes(t)) lines.push(`- Uses: ${t}`);
  }
  return lines.length > 0
    ? `CRITICAL_CONTEXT:\n${lines.join('\n')}\n\nKEY_FACTS:\n${lines.join('\n')}\n\nADVICE: Continue based on the preserved context above.`
    : 'CRITICAL_CONTEXT: No critical context detected.\nADVICE: Proceed normally.';
}
function fallbackAdvice() {
  return 'All good — no issues detected.';
}
export { getRLMStatus, shutdownRLM };
