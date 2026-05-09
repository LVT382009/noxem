/**
 * Research Engine — Brain 2 background research pipeline.
 *
 * After each sync_turn, this engine runs ASYNCHRONOUSLY:
 * 1. Topic Detection (Qwen3 0.6B) — classify: TECHNICAL or CASUAL
 * 2. Query Generation (Qwen3 0.6B) — craft optimal search query
 * 3. DDG Search — find relevant web results
 * 4. Web Fetch — read top URLs, extract text
 * 5. Fact Extraction (Qwen3 0.6B) — extract 3-5 key facts
 * 6. Memory Storage — store facts as type:learning memories
 *
 * It never blocks the main request flow — sync_turn returns immediately.
 * Rate limited: max 1 research per 30s per session.
 */

import { searchWeb } from './ddg-search.mjs';
import { fetchPages, isFetchableUrl } from './web-fetch.mjs';

const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'onnx-community/Qwen3-0.6B-ONNX';
const RESEARCH_ENABLED = process.env.RESEARCH_ENABLED !== 'false';
const RESEARCH_MIN_INTERVAL_MS = parseInt(process.env.RESEARCH_MIN_INTERVAL || '30000'); // 30s
const RESEARCH_MAX_TOPICS_PER_SESSION = 50; // per session lifetime
const RESEARCH_MAX_DDQ_RESULTS = 5;
const RESEARCH_MAX_FETCH_PAGES = 2;

const CURRENT_YEAR = new Date().getFullYear();

// ── Research State ──────────────────────────────────────────

// Track last research time per session to rate-limit
const sessionLastResearch = new Map();
// Track research topic count per session
const sessionResearchCount = new Map();
// Track currently running research (prevent duplicates)
const sessionRunning = new Set();
// Recent research topics for hint injection
const recentResearchTopics = new Map(); // sessionId → [{ topic, factCount, timestamp }]

/**
 * Check if research is allowed for this session (rate limit).
 */
function canResearch(sessionId) {
  if (!RESEARCH_ENABLED) return false;
  if (sessionRunning.has(sessionId)) return false; // already running

  const lastTime = sessionLastResearch.get(sessionId) || 0;
  if (Date.now() - lastTime < RESEARCH_MIN_INTERVAL_MS) return false;

  const count = sessionResearchCount.get(sessionId) || 0;
  if (count >= RESEARCH_MAX_TOPICS_PER_SESSION) return false;

  return true;
}

/**
 * Get recent research topics for a session (for hint injection).
 */
export function getRecentResearch(sessionId, maxAgeMs = 300_000) {
  const topics = recentResearchTopics.get(sessionId) || [];
  const now = Date.now();
  return topics.filter(t => now - t.timestamp < maxAgeMs);
}

/**
 * Main entry: trigger background research after a sync_turn.
 * Returns immediately — research runs asynchronously.
 *
 * @param {Object} params
 * @param {string} params.sessionId - Current session ID
 * @param {string} params.userMessage - Last user message
 * @param {string} params.assistantResponse - Last assistant response
 * @param {Function} params.storeMemoryFn - Function to store a memory
 * @param {Function} params.embedFn - Function to generate embedding
 * @param {Function} params.isEmbeddingReadyFn - Check if embedding engine is ready
 */
export function triggerResearch({ sessionId, userMessage, assistantResponse, storeMemoryFn, embedFn, isEmbeddingReadyFn }) {
  if (!canResearch(sessionId)) return;

  sessionRunning.add(sessionId);
  sessionLastResearch.set(sessionId, Date.now());

  // Run entirely async — never block the caller
  _runResearch({ sessionId, userMessage, assistantResponse, storeMemoryFn, embedFn, isEmbeddingReadyFn })
    .catch(err => {
      console.error(`[Research] Pipeline error for session ${sessionId}:`, err.message);
    })
    .finally(() => {
      sessionRunning.delete(sessionId);
    });
}

/**
 * Get research pipeline status.
 */
export function getResearchStatus() {
  return {
    enabled: RESEARCH_ENABLED,
    min_interval_ms: RESEARCH_MIN_INTERVAL_MS,
    active_sessions: sessionRunning.size,
    total_sessions_tracked: sessionLastResearch.size,
  };
}

// ── Internal Pipeline ──────────────────────────────────────

async function _runResearch({ sessionId, userMessage, assistantResponse, storeMemoryFn, embedFn, isEmbeddingReadyFn }) {
  // Step 1: Topic Detection — decide if this needs research
  const detection = await detectTopic(userMessage, assistantResponse);
  if (!detection.needsResearch || !detection.searchQuery) {
    return; // Casual chat, no research needed
  }

  console.log(`[Research] Topic detected: "${detection.topic}" → query: "${detection.searchQuery}" (session: ${sessionId})`);

  // Step 2: DDG Search
  let searchResults = [];
  try {
    searchResults = await searchWeb(detection.searchQuery, RESEARCH_MAX_DDQ_RESULTS);
  } catch (err) {
    console.error('[Research] DDG search failed:', err.message);
    return;
  }

  if (!searchResults.length) {
    console.log(`[Research] No DDG results for "${detection.searchQuery}"`);
    return;
  }

  // Step 3: Web Fetch top URLs
  const fetchUrls = searchResults
    .filter(r => r.url && isFetchableUrl(r.url))
    .slice(0, RESEARCH_MAX_FETCH_PAGES)
    .map(r => r.url);

  let fetchedPages = [];
  if (fetchUrls.length > 0) {
    try {
      fetchedPages = await fetchPages(fetchUrls);
    } catch (err) {
      console.error('[Research] Web fetch failed:', err.message);
    }
  }

  // Step 4: Extract facts using Qwen3 0.6B
  const facts = await extractFacts(detection.topic, detection.searchQuery, searchResults, fetchedPages);
  if (!facts.length) {
    console.log(`[Research] No facts extracted for "${detection.topic}"`);
    return;
  }

  // Step 5: Store facts as memories
  const storedIds = [];
  for (const fact of facts) {
    let embedding = null;
    if (isEmbeddingReadyFn()) {
      try {
        embedding = new Float32Array(await embedFn(fact.text));
      } catch {}
    }

    const id = storeMemoryFn({
      session_id: sessionId,
      type: 'learning',
      text: fact.text,
      embedding,
      metadata: {
        source: 'web_research',
        extraction_method: 'research_pipeline',
        search_query: detection.searchQuery,
        topic: detection.topic,
        url: fact.sourceUrl || '',
        stored_at: new Date().toISOString(),
      },
      importance: fact.importance || 0.5,
      context_prefix: `Web research about ${detection.topic}`,
      entity: detection.entity || detection.topic.replace(/\s+/g, '_'),
      attribute: 'web_research',
    });
    if (id) storedIds.push(id);
  }

  // Step 6: Track research for hint injection
  const count = sessionResearchCount.get(sessionId) || 0;
  sessionResearchCount.set(sessionId, count + 1);

  const topics = recentResearchTopics.get(sessionId) || [];
  topics.push({ topic: detection.topic, factCount: facts.length, timestamp: Date.now(), query: detection.searchQuery });
  // Keep only last 10 topics per session
  if (topics.length > 10) topics.splice(0, topics.length - 10);
  recentResearchTopics.set(sessionId, topics);

  console.log(`[Research] Stored ${storedIds.length} facts about "${detection.topic}" for session ${sessionId}`);
}

// ── Topic Detection (Qwen3 0.6B) ──────────────────────────────

async function callLLM(messages, maxTokens = 256, temperature = 0.1, timeout = 15_000) {
  try {
    const res = await fetch(LLM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: maxTokens, temperature }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Qwen3 HTTP ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('[Research] Qwen3 call failed:', err.message);
    return '';
  }
}

/**
 * Classify the conversation turn and generate a search query if needed.
 * Uses simple prompting (not formal function calling) for speed and simplicity.
 */
async function detectTopic(userMessage, assistantResponse) {
  const result = { needsResearch: false, topic: '', searchQuery: '', entity: '' };

  // Quick regex pre-filter: skip obvious non-technical messages
  const combined = `${userMessage || ''} ${assistantResponse || ''}`.substring(0, 2000);
  if (skipNonTechnical(combined)) return result;

  // If Qwen3 0.6B is unavailable, use regex-based fallback
  // Topic detection needs more time — use 30s timeout
  const llmResponse = await callLLM([
    {
      role: 'system',
      content: `You are a topic classifier for an AI coding agent's memory system.
Given the latest user message and assistant response, determine if this conversation turn involves a TECHNICAL topic that would benefit from web research.

Technical topics include:
- Building/creating/installing software, apps, or systems
- Using specific tools, frameworks, languages, or APIs
- Debugging errors, fixing issues, or resolving problems
- Configuration, setup, or deployment questions
- Requests for how-to or best practices

NOT technical (skip research):
- Casual chat, greetings, confirmations
- Opinions without technical content
- Meta-questions about the agent itself
- Simple lookups of already-known information
- Mentions of bugs/errors in passing (not actively debugging)
- Questions about AI tools or agents themselves

Respond in this EXACT format:
TOPIC: [the technical topic in 2-5 words, or "NONE"]
QUERY: [a web search query to find useful info, or "NONE"]
ENTITY: [a short entity name like "android_apk" or "react_hooks", or "NONE"]

Examples:
User: "Build me an APK"
→ TOPIC: Android APK building
→ QUERY: how to build Android APK from source 2026
→ ENTITY: android_apk

User: "ok thanks"
→ TOPIC: NONE
→ QUERY: NONE
→ ENTITY: NONE`,
    },
    {
      role: 'user',
      content: `User: ${(userMessage || '').substring(0, 500)}\nAssistant: ${(assistantResponse || '').substring(0, 500)}`,
    },
  ], 150, 0.1, 15_000); // 15s timeout for topic detection

  if (!llmResponse) {
    // Fallback: regex-based detection
    return regexTopicDetection(combined);
  }

  // Parse Qwen3 0.6B's response
  const topicMatch = llmResponse.match(/TOPIC:\s*(.+)/i);
  const queryMatch = llmResponse.match(/QUERY:\s*(.+)/i);
  const entityMatch = llmResponse.match(/ENTITY:\s*(.+)/i);

  const topic = topicMatch?.[1]?.trim() || '';
  const query = queryMatch?.[1]?.trim() || '';
  const entity = entityMatch?.[1]?.trim() || '';

  if (topic && topic.toUpperCase() !== 'NONE' && query && query.toUpperCase() !== 'NONE') {
    result.needsResearch = true;
    result.topic = topic;
    result.searchQuery = query;
    result.entity = entity && entity.toUpperCase() !== 'NONE' ? entity : topic.replace(/\s+/g, '_').toLowerCase();
  }

  return result;
}

/**
 * Quick regex pre-filter to skip obvious non-technical messages.
 * Avoids Qwen3 0.6B call for trivial cases.
 */
function skipNonTechnical(text) {
  const lower = text.toLowerCase().trim();

  // Skip very short messages
  if (lower.length < 10) return true;

  // Skip common non-technical conversational patterns
  const nonTechnical = /^(ok|okay|sure|yes|no|got it|thanks|thank you|done|continue|go ahead|please|yep|yeah|nope|cool|great|good|fine|right|correct|agreed|hi|hello|hey|bye|goodbye|see you|what\??|hmm|oh|wow)[\s!.?]*$/i;
  if (nonTechnical.test(lower)) return true;

  // Skip informational/retrieval questions that don't need research
  const infoPatterns = [
    /\bwhat\b[\s']s?\s+(is|are)\b/i,            // "what is X", "what's X", "what are X"
    /\btell\s+me\s+about\b/i,                     // "tell me about X"
    /\bexplain\b/i,                                // "explain X"
    /\bdescribe\b/i,                               // "describe X"
    /\bwho\b[\s']s?\s+(is|are)\b/i,               // "who is X", "who's X", "who are X"
    /\bdefine\b/i,                                 // "define X"
    /\bmeaning\s+of\b/i,                          // "meaning of X"
  ];
  for (const p of infoPatterns) {
    if (p.test(lower)) return true;
  }

  // Skip meta-questions about AI agents/tools
  const metaPatterns = [
    /\bclaude\s*code\b/i,
    /\bhermes\s*(agent|memory|plugin)?\b/i,
    /\bwhat\b[\s']s?\s+hermes\b/i,
    /\bnoxem\b/i,
    /\bqwen3?\b/i,
    /\bopenai\b/i,
    /\bai\s+(agent|tool|assistant|model)\b/i,
  ];
  for (const p of metaPatterns) {
    if (p.test(lower)) return true;
  }

  // Skip very short queries that are just names (single-word-ish)
  const wordsOnly = lower.replace(/[^a-z0-9\s]/g, '').trim();
  if (wordsOnly.split(/\s+/).length <= 2 && wordsOnly.length < 15) return true;

  return false;
}

/**
 * Fallback regex-based topic detection when Qwen3 0.6B is unavailable.
 * Conservative: only triggers for active BUILD/INSTALL/FIX tasks, not passive mentions.
 */
function regexTopicDetection(text) {
  const result = { needsResearch: false, topic: '', searchQuery: '', entity: '' };

  // Negative patterns — topics that should NEVER trigger research
  const negativePatterns = [
    /\bwhat\b[\s']s?\s+(is|are)\s/i,        // "what is X" — just asking for info
    /\btell\s+me\s+about\b/i,               // "tell me about X"
    /\bwho\b[\s']s?\s+(is|are)\s/i,         // "who is X"
    /\bexplain\b/i,                          // "explain X"
    /\bdescribe\b/i,                         // "describe X"
    /\bdefine\b/i,                           // "define X"
    /\bmeaning\s+of\b/i,                    // "meaning of X"
    /\bclaude\s*code\b/i,                    // AI tool mentions
    /\bhermes\b/i,                           // agent mention
    /\bnoxem\b/i,                            // agent mention
    /\bai\s+(agent|tool|assistant)\b/i,      // AI agent discussion
    /\bmentioned\b.*\b(bug|error|issue)\b/i, // "mentioned a bug" — passive reference
    /\btalked?\s+about\b/i,                  // "talked about X" — passive
    /\bheard\s+about\b/i,                    // "heard about X" — passive
    /\bsaid\s+.*\b(bug|error|crash)\b/i,     // "said there was a bug" — passive
  ];
  for (const neg of negativePatterns) {
    if (neg.test(text)) return result;
  }

  // Positive patterns that SHOULD trigger research — must be active task intent
  const techPatterns = [
    // Build/create intent — user wants to make something
    {
      pattern: /\b(build\s+me|create\s+(?:a\s+|an\s+)?|make\s+(?:me\s+)?(?:a\s+|an\s+)?)\s*(\w[\w.-]{1,20}(?:\s+[\w.-]{1,15}){0,2})/i,
      type: 'build',
    },
    // Install/setup intent
    {
      pattern: /\b(install|set\s+up|setup|configure)\s+(?:a\s+|an\s+|the\s+)?(\w[\w.-]{1,20}(?:\s+[\w.-]{1,15}){0,2})/i,
      type: 'build',
    },
    // How-to questions — the user is asking how to DO something
    {
      pattern: /\bhow\s+(?:do\s+i|to|can\s+i)\s+(\w[\w.-]{1,15}(?:\s+[\w.-]{1,15}){0,3})/i,
      type: 'howto',
    },
    // Fix/debug intent — user is actively trying to resolve an issue
    {
      pattern: /\b(fix|debug|resolve|solve|troubleshoot)\s+(?:the\s+|a\s+|this\s+)?(\w[\w.-]{1,20}(?:\s+[\w.-]{1,15}){0,2})/i,
      type: 'fix',
    },
    // Error patterns — requires actual error signal (error/exception + context)
    {
      pattern: /\b(?:error|exception|traceback|panic)\s*(?::|—|–|-)\s*["']?(\w[\w.-]{1,20}(?:\s+[\w.-]{1,15}){0,2})/i,
      type: 'error',
    },
    // Specific error codes or messages
    {
      pattern: /\b(?:error|errno|exit\s+code)\s+([\w#]{2,15})/i,
      type: 'error',
    },
  ];

  for (const { pattern, type } of techPatterns) {
    const match = text.match(pattern);
    if (match) {
      const topicText = (match[2] || match[1] || '').trim();
      if (!topicText || topicText.length < 3) continue;

      result.needsResearch = true;
      result.topic = topicText;

      // Craft query based on pattern type — no blind "how to" prepending
      switch (type) {
        case 'build':
          result.searchQuery = `how to build ${topicText} ${CURRENT_YEAR}`;
          break;
        case 'howto':
          result.searchQuery = `${topicText} ${CURRENT_YEAR}`;
          break;
        case 'fix':
          result.searchQuery = `how to fix ${topicText} ${CURRENT_YEAR}`;
          break;
        case 'error':
          result.searchQuery = `${topicText} fix`;
          break;
        default:
          result.searchQuery = `${topicText} ${CURRENT_YEAR}`;
      }

      result.entity = topicText.replace(/\s+/g, '_').toLowerCase().substring(0, 30);
      break;
    }
  }

  return result;
}

// ── Fact Extraction (Qwen3 0.6B) ──────────────────────────────

/**
 * Extract key facts from search results and fetched page content.
 */
async function extractFacts(topic, searchQuery, searchResults, fetchedPages) {
  const searchContext = searchResults.map((r, i) =>
    `[${i + 1}] ${r.title || 'Untitled'}${r.snippet ? ': ' + r.snippet : ''}${r.url ? ' (' + r.url + ')' : ''}`
  ).join('\n');

  const pageContext = fetchedPages.map(p =>
    `[Page: ${p.title || p.url}]\n${p.text.substring(0, 1500)}`
  ).join('\n\n');

  if (!searchContext && !pageContext) return [];

  const prompt = pageContext
    ? `Based on the web search results and page content below about "${topic}", extract 3-5 key factual statements.
Each fact should be a complete, self-contained sentence that would be useful for a coding agent.
Focus on: requirements, steps, commands, best practices, common pitfalls.

Return ONLY a JSON array of objects: [{"text": "...", "importance": 0.5, "sourceUrl": "..."}]
importance: 0.3-0.8 (higher = more useful for practical work)
sourceUrl: the URL this fact came from

Search results:
${searchContext}

Page content:
${pageContext}`
    : `Based on the web search results below about "${topic}", extract 2-3 key factual statements.
Each fact should be a complete, self-contained sentence useful for a coding agent.

Return ONLY a JSON array: [{"text": "...", "importance": 0.5, "sourceUrl": "..."}]

Search results:
${searchContext}`;

  const response = await callLLM([
    { role: 'system', content: 'You extract factual knowledge from web search results. Return only valid JSON arrays. Be concise and accurate.' },
    { role: 'user', content: prompt },
  ], 512, 0.1);

  if (!response) return [];

  try {
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];
    const facts = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(facts)) return [];
    return facts
      .filter(f => f.text && typeof f.text === 'string' && f.text.trim().length > 10)
      .map(f => ({
        text: f.text.trim().substring(0, 500),
        importance: Math.min(0.8, Math.max(0.3, parseFloat(f.importance) || 0.5)),
        sourceUrl: (f.sourceUrl || '').substring(0, 500),
      }));
  } catch {
    return [];
  }
}

// ── Periodic Cleanup ───────────────────────────────────────

// Clean up stale session tracking every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sid, lastTime] of sessionLastResearch) {
    if (now - lastTime > 3_600_000) { // 1 hour idle
      sessionLastResearch.delete(sid);
      sessionResearchCount.delete(sid);
      recentResearchTopics.delete(sid);
    }
  }
}, 300_000).unref();
