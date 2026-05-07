import { searchWeb, formatSearchResults } from './ddg-search.mjs';

const GEMMA_URL = process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const GEMMA_MODEL = process.env.GEMMA_MODEL || 'onnx-community/gemma-4-E2B-it-ONNX';
const ADVISOR_ENABLED = process.env.ADVISOR_ENABLED !== 'false';
const ENABLE_WEB_SEARCH = process.env.ADVISOR_WEB_SEARCH !== 'false';

function callGemma(messages, maxTokens = 1024, temperature = 0.3) {
  return fetch(GEMMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GEMMA_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
    signal: AbortSignal.timeout(30000),
  });
}

// Pre-compression advisor: analyze conversation before compaction
// Gemma 4 reviews the conversation and extracts what must survive
export async function analyzeBeforeCompress(conversationHistory, sessionMemories) {
  if (!ADVISOR_ENABLED) return fallbackCompressAnalysis(conversationHistory, sessionMemories);

  const recentTurns = (conversationHistory || []).slice(-10);
  const convoText = recentTurns.map(t =>
    `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, 1000)}`
  ).join('\n\n');

  const memorySummary = (sessionMemories || []).slice(-10).map(m =>
    `[${m.type}] ${m.text}`
  ).join('\n');

  let webContext = '';
  if (ENABLE_WEB_SEARCH) {
    try {
      const searchResults = await searchWeb(
        `latest information about: ${recentTurns[recentTurns.length - 1]?.content?.substring(0, 100) || ''}`,
        3
      );
      webContext = formatSearchResults(searchResults);
    } catch (err) {
      console.error('Advisor web search failed (compress):', err.message);
    }
  }

  const messages = [
    {
      role: 'system',
      content: `You are a second-brain AI advisor for a coding agent called Hermes. Your job is to:

1. Review the conversation below and identify CRITICAL context that must survive context compaction
2. Detect any "task drift" — the agent forgetting important task parameters (e.g. building in wrong OS/environment, using wrong tools)
3. Warn about anything the agent might have forgotten or gotten wrong
4. Extract specific facts, preferences, and decisions made during this conversation
5. If web search results are available, incorporate them to correct or enhance the agent's knowledge

Your output must be in this format:
CRITICAL_CONTEXT: (what must survive)
TASK_DRIFT_WARNINGS: (warnings if any)
KEY_FACTS: (factual memories to extract)
ADVICE: (advice for the agent)

Stay factual and concise. Only flag real issues, not hypothetical ones.`,
    },
    {
      role: 'user',
      content: `Session memories:\n${memorySummary || 'None yet'}\n\nRecent conversation:\n${convoText}\n\n${webContext ? `Web search results:\n${webContext}\n\n` : ''}Analyze for compaction survival:`,
    },
  ];

  try {
    const res = await callGemma(messages, 1024, 0.2);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || fallbackCompressAnalysis(conversationHistory, sessionMemories);
  } catch (err) {
    console.error('Compress analysis error:', err.message);
    return fallbackCompressAnalysis(conversationHistory, sessionMemories);
  }
}

// Proactive advisor: called periodically during long tasks
// Checks task context, warns about drift, provides guidance
export async function getAdvice({ userMessage, conversationHistory, activeMemories, currentTaskContext }) {
  if (!ADVISOR_ENABLED) return fallbackAdvice();

  const taskSummary = currentTaskContext
    ? `Current task: ${currentTaskContext.substring(0, 500)}`
    : '';

  const memoryBlock = (activeMemories || []).slice(-15).map(m =>
    `[${m.type}] ${m.text}`
  ).join('\n');

  const recentTurns = (conversationHistory || []).slice(-6).map(t =>
    `${t.role?.toUpperCase() || 'USER'}: ${(t.content || '').substring(0, 500)}`
  ).join('\n');

  let webContext = '';
  if (ENABLE_WEB_SEARCH) {
    try {
      const query = userMessage ? userMessage.substring(0, 150) : 'latest technology news';
      const searchResults = await searchWeb(query, 3);
      webContext = formatSearchResults(searchResults);
    } catch (err) {
      console.error('Advisor web search failed (advice):', err.message);
    }
  }

  const messages = [
    {
      role: 'system',
      content: `You are a second-brain AI advisor for a coding agent called Hermes. Your responsibilities:

1. TASK MONITORING — Track what the user is building and flag if Hermes drifts from user's intended setup (wrong OS, wrong directory, wrong tools)
2. MEMORY ENHANCEMENT — If Hermes seems confused or has forgotten something from earlier in the conversation, remind it using the stored memories
3. CONTEXT RECOVERY — After context compaction, help Hermes recover critical information
4. WEB-AUGMENTED — Use web search results to keep advice current and accurate

Respond concisely. If everything looks fine, say "All good — no issues detected." Only flag real problems.`,
    },
    {
      role: 'user',
      content: `Current memories:\n${memoryBlock || 'None stored yet'}\n${taskSummary}\n\nRecent conversation:\n${recentTurns || 'Starting new conversation'}\n\nUser says: ${(userMessage || '').substring(0, 500)}\n\n${webContext ? `Web search results:\n${webContext}\n\n` : ''}Provide advice:`,
    },
  ];

  try {
    const res = await callGemma(messages, 800, 0.2);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || fallbackAdvice();
  } catch (err) {
    console.error('Advisor error:', err.message);
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
    const res = await callGemma(messages, 1024, 0.1);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '[]';
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];
    const memories = JSON.parse(jsonMatch[0]);
    return Array.isArray(memories) ? memories.filter(m => m.text && m.type) : [];
  } catch (err) {
    console.error('Session end analysis error:', err.message);
    return [];
  }
}

// Fallback: rule-based analysis when Gemma 4 is unavailable
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
  const techs = ['python', 'node', 'rust', 'react', 'docker', 'sqlite', 'express', 'gemma', 'hermes'];
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
