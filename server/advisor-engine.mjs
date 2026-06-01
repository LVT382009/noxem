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

const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const ADVISOR_ENABLED = process.env.ADVISOR_ENABLED !== 'false';

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
    signal: AbortSignal.timeout(30000),
  });
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
  const recentTurns = (conversationHistory || []).slice(-10);
  const convoText = recentTurns.map(t =>
    `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, 1000)}`
  ).join('\n\n');

  const memorySummary = (sessionMemories || []).slice(-10).map(m =>
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

  const memoryBlock = (activeMemories || []).slice(-15).map(m =>
    `[${m.type}] ${m.text}`
  ).join('\n');

  const recentTurns = (conversationHistory || []).slice(-6).map(t =>
    `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, 500)}`
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
      `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, Math.min(Math.floor(CONTEXT_WINDOW * 0.18), 32000))}`
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
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content || content.startsWith('[LLM un')) return [];
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const memories = JSON.parse(jsonMatch[0]);
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

  for (const chunk of chunks.slice(0, 10)) {
    const chunkText = chunk.map(t =>
      `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, Math.min(Math.floor(CONTEXT_WINDOW * 0.18), 32000))}`
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
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) continue;
      const jsonMatch = content.match(/\[[\s\S]*?\]/);
      if (!jsonMatch) continue;
      const chunkMems = JSON.parse(jsonMatch[0]);
      if (Array.isArray(chunkMems)) allMemories.push(...chunkMems.filter(m => m.text && m.type));
    } catch (err) {
      LOG_DEBUG && console.error('Chunk extraction error:', err.message);
    }
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
  const techs = ['python', 'node', 'rust', 'react', 'docker', 'sqlite', 'express', 'qwen3', 'hermes'];
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
