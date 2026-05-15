/**
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
 * Advisor Engine — Brain 2 advisor for drift detection + context recovery.
 *
 * DDG web search has been moved to research-engine.mjs.
 * This module focuses on:
 * - Pre-compression context preservation
 * - Task drift detection
 * - Session-end memory extraction
 * - Advice and guidance
 *
 * If research memories exist for the session, they are available
 * via memory_search — the advisor doesn't need to do web searches itself.
 */

const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const ADVISOR_ENABLED = process.env.ADVISOR_ENABLED !== 'false';

// Cross-session search functions — set by memory-server.mjs at startup to avoid circular imports
let _searchCrossSession = null;
let _getRecentSessionMsgs = null;
let _getSessionById = null;

export function setCrossSessionFns({ searchCrossSessionMessages, getRecentSessionMessages, getSession }) {
  _searchCrossSession = searchCrossSessionMessages;
  _getRecentSessionMsgs = getRecentSessionMessages;
  _getSessionById = getSession;
}

// Token budget for cross-session context injection (2-4K tokens)
const CROSS_SESSION_TOKEN_BUDGET = parseInt(process.env.CROSS_SESSION_TOKEN_BUDGET || '2000');

function callLLM(messages, maxTokens = 1024, temperature = 0.3) {
  return fetch(LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
// Qwen3 reviews the conversation and extracts what must survive
export async function analyzeBeforeCompress(conversationHistory, sessionMemories) {
  if (!ADVISOR_ENABLED) return fallbackCompressAnalysis(conversationHistory, sessionMemories);

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

// Proactive advisor: called when advice is explicitly requested
// Checks task context, warns about drift, provides guidance
export async function getAdvice({ userMessage, conversationHistory, activeMemories, currentTaskContext, session_id }) {
  if (!ADVISOR_ENABLED) return fallbackAdvice();

  const taskSummary = currentTaskContext
    ? `Current task: ${currentTaskContext.substring(0, 500)}`
    : '';

  const memoryBlock = (activeMemories || []).slice(-15).map(m =>
    `[${m.type}] ${m.text}`
  ).join('\n');

  // ─── Cross-session context injection ───
  let crossSessionContext = '';
  if (_searchCrossSession && userMessage?.trim()) {
    try {
      const crossResults = _searchCrossSession({
        query: userMessage.trim(),
        exclude_session_id: session_id || '',
        limit: 10,
      });

      if (crossResults.length > 0) {
        // Inject previous session summaries first, then top-K messages within token budget
        const summaries = [];
        const messages = [];
        const seenSessions = new Set();

        for (const r of crossResults) {
          // Check for session summary
          if (_getSessionById && !seenSessions.has(r.session_id)) {
            seenSessions.add(r.session_id);
            const s = _getSessionById(r.session_id);
            if (s?.session_summary && s.session_summary !== '{}') {
              try {
                const summary = typeof s.session_summary === 'string' ? JSON.parse(s.session_summary) : s.session_summary;
                if (summary.request || summary.completed) {
                  summaries.push(`[Session: ${s.session_title || r.session_id}] Request: ${summary.request || ''} | Completed: ${summary.completed || ''} | Next: ${summary.next_steps || ''}`);
                }
              } catch {}
            }
          }
          messages.push(`[${r.role}@${r.session_title || r.session_id?.substring(0,8)}]: ${(r.content_text || '').substring(0, 200)}`);
        }

        const parts = [];
        if (summaries.length) parts.push('Previous session summaries:\n' + summaries.join('\n'));
        if (messages.length) parts.push('Relevant messages from other sessions:\n' + messages.join('\n'));

        // Trim to token budget (~4 chars/token)
        let combined = parts.join('\n\n');
        const maxChars = CROSS_SESSION_TOKEN_BUDGET * 4;
        if (combined.length > maxChars) combined = combined.substring(0, maxChars) + '...';
        crossSessionContext = combined;
      }
    } catch (err) {
      LOG_DEBUG && console.error('[Advisor] Cross-session search error:', err.message);
    }
  }

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
4. CROSS-SESSION CONTINUITY — If relevant context from previous sessions is provided, use it to maintain continuity and avoid re-doing work

Note: Web research is handled separately by the research pipeline. Research memories (type: learning) are available in the session memories above.

Respond concisely. If everything looks fine, say "All good — no issues detected." Only flag real problems.`,
    },
    {
      role: 'user',
      content: `Current memories:\n${memoryBlock || 'None stored yet'}\n${taskSummary}\n${crossSessionContext ? '\nCross-session context:\n' + crossSessionContext : ''}\n\nRecent conversation:\n${recentTurns || 'Starting new conversation'}\n\nUser says: ${(userMessage || '').substring(0, 500)}\n\nProvide advice:`,
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

// Session end analysis: extract final memories, summarize
export async function analyzeSessionEnd(conversationHistory, allSessionMemories) {
  if (!ADVISOR_ENABLED) return [];

  const convoText = (conversationHistory || []).slice(-20).map(t =>
    `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, 300)}`
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

// Generate a structured session summary for cross-session injection
// Returns { request, investigated, completed, next_steps }
export async function generateAdvisorSessionSummary(conversationHistory, sessionMemories) {
  if (!ADVISOR_ENABLED) {
    return buildRuleBasedSummary(conversationHistory, sessionMemories);
  }

  const convoText = (conversationHistory || []).slice(-20).map(t =>
    `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, 300)}`
  ).join('\n');

  const memText = (sessionMemories || []).slice(0, 15).map(m =>
    `[${m.type}] ${m.text}`
  ).join('\n');

  const messages = [
    {
      role: 'system',
      content: `Summarize this coding session into a structured JSON object with these fields:
- request: What the user originally asked for (1 sentence)
- investigated: What was explored/debugged (comma-separated, max 200 chars)
- completed: What was actually accomplished (comma-separated, max 200 chars)
- next_steps: What remains to be done next session (1-2 sentences)

Return ONLY the JSON object, no markdown fences.`,
    },
    {
      role: 'user',
      content: `Session memories:\n${memText || 'None'}\n\nConversation:\n${convoText}\n\nGenerate session summary:`,
    },
  ];

  try {
    const res = await callLLM(messages, 300, 0.1);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content || content.startsWith('[LLM un')) return buildRuleBasedSummary(conversationHistory, sessionMemories);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return buildRuleBasedSummary(conversationHistory, sessionMemories);
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    LOG_DEBUG && console.error('Session summary error:', err.message);
    return buildRuleBasedSummary(conversationHistory, sessionMemories);
  }
}

// Rule-based fallback for session summary
function buildRuleBasedSummary(conversationHistory, sessionMemories) {
  const userMsgs = (conversationHistory || []).filter(t => t.role === 'user').map(t => (t.content || '').substring(0, 200));
  const facts = (sessionMemories || []).slice(0, 10).map(m => m.text);
  return {
    request: userMsgs[0] || '',
    investigated: '',
    completed: facts.join('; ').substring(0, 500),
    next_steps: '',
  };
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
