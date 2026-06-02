/**
 * Research Engine — Brain 2 background research pipeline.
 *
 * v2: Multi-query decomposition — decomposes detected topics into
 * 2-5 sub-queries, parallel DDG search per sub-query, merge results,
 * contradiction checking, and fact synthesis.
 *
 * Pipeline:
 * 1. Topic Detection + Query Decomposition (Brain 2)
 * 2. Parallel DDG Search per sub-query
 * 3. Web Fetch top URLs
 * 4. Fact Extraction (Brain 2)
 * 5. Contradiction Verification
 * 6. Fact Synthesis
 * 7. Memory Storage
 *
 * It never blocks the main request flow — sync_turn returns immediately.
 * Rate limited: max 1 research per 30s per session.
 */

import { searchWeb } from './ddg-search.mjs';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
import { fetchPages, isFetchableUrl, crawlDomain } from './web-fetch.mjs';

const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
const RESEARCH_ENABLED = process.env.RESEARCH_ENABLED !== 'false';
const RESEARCH_MIN_INTERVAL_MS = parseInt(process.env.RESEARCH_MIN_INTERVAL || '30000');
const RESEARCH_MAX_TOPICS_PER_SESSION = 50;
const RESEARCH_MAX_DDQ_RESULTS = 5;
const RESEARCH_CRAWL_MODE = process.env.RESEARCH_CRAWL_MODE === 'true';
const RESEARCH_MAX_FETCH_PAGES = 2;
const RESEARCH_MAX_SUB_QUERIES = parseInt(process.env.RESEARCH_MAX_SUB_QUERIES || '3');

const CURRENT_YEAR = new Date().getFullYear();

// ── Research State ──────────────────────────────────────────

const sessionLastResearch = new Map();
const sessionResearchCount = new Map();
const sessionRunning = new Set();
const recentResearchTopics = new Map();

function canResearch(sessionId) {
  if (!RESEARCH_ENABLED) return false;
  if (sessionRunning.has(sessionId)) return false;
  const lastTime = sessionLastResearch.get(sessionId) || 0;
  if (Date.now() - lastTime < RESEARCH_MIN_INTERVAL_MS) return false;
  const count = sessionResearchCount.get(sessionId) || 0;
  if (count >= RESEARCH_MAX_TOPICS_PER_SESSION) return false;
  return true;
}

export function getRecentResearch(sessionId, maxAgeMs = 300_000) {
  const topics = recentResearchTopics.get(sessionId) || [];
  const now = Date.now();
  return topics.filter(t => now - t.timestamp < maxAgeMs);
}

export function triggerResearch({ sessionId, userMessage, assistantResponse, storeMemoryFn, embedFn, isEmbeddingReadyFn }) {
  if (!canResearch(sessionId)) return;
  sessionRunning.add(sessionId);
  sessionLastResearch.set(sessionId, Date.now());
  _runResearch({ sessionId, userMessage, assistantResponse, storeMemoryFn, embedFn, isEmbeddingReadyFn })
    .catch(err => { LOG_DEBUG && console.error(`[Research] Pipeline error for session ${sessionId}:`, err.message); })
    .finally(() => { sessionRunning.delete(sessionId); });
}

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
  // Step 1: Topic Detection + Multi-query Decomposition
  const detection = await detectTopic(userMessage, assistantResponse);
  if (!detection.needsResearch) return;

  LOG_DEBUG && console.log(`[Research] Topic: "${detection.topic}" → ${detection.subQueries.length} sub-queries (session: ${sessionId})`);

  // Step 2: Parallel DDG Search per sub-query
  const allSearchResults = [];
  const searchPromises = detection.subQueries.slice(0, RESEARCH_MAX_SUB_QUERIES).map(q =>
    searchWeb(q, RESEARCH_MAX_DDQ_RESULTS).catch(err => {
      LOG_DEBUG && console.error(`[Research] DDG search failed for "${q}":`, err.message);
      return [];
    })
  );
  const searchResultsPerQuery = await Promise.all(searchPromises);

  // Merge and dedup results by URL
  const seenUrls = new Set();
  for (const results of searchResultsPerQuery) {
    for (const r of results) {
      if (r.url && !seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        allSearchResults.push(r);
      }
    }
  }

  if (!allSearchResults.length) {
    LOG_DEBUG && console.log(`[Research] No DDG results for "${detection.topic}"`);
    return;
  }

  // Step 3: Web Fetch top URLs
  const fetchUrls = allSearchResults
    .filter(r => r.url && isFetchableUrl(r.url))
    .slice(0, RESEARCH_MAX_FETCH_PAGES)
    .map(r => r.url);

  let fetchedPages = [];
  if (fetchUrls.length > 0) {
    try { fetchedPages = await fetchPages(fetchUrls); } catch (err) {
      LOG_DEBUG && console.error('[Research] Web fetch failed:', err.message);
    }
  }

  // v2: Crawl mode — if enabled, crawl top result domains for more content
  if (RESEARCH_CRAWL_MODE && fetchedPages.length > 0) {
    const crawledUrls = new Set(fetchUrls);
    const topDomains = [...new Set(
      fetchedPages.slice(0, 2).map(p => { try { return new URL(p.url).origin; } catch { return null; } }).filter(Boolean)
    )];
    for (const domain of topDomains) {
      try {
        const crawlResults = await crawlDomain(domain, { maxDepth: 2, maxPages: 3, sameDomainOnly: true });
        for (const cr of crawlResults) {
          if (!crawledUrls.has(cr.url)) {
            fetchedPages.push(cr);
            crawledUrls.add(cr.url);
          }
        }
      } catch (err) {
        LOG_DEBUG && console.error('[Research] Crawl failed for', domain, err.message);
      }
    }
  }

  // Step 4: Extract facts
  const facts = await extractFacts(detection.topic, detection.searchQuery, allSearchResults, fetchedPages);
  if (!facts.length) {
    LOG_DEBUG && console.log(`[Research] No facts extracted for "${detection.topic}"`);
    return;
  }

  // Step 5: Contradiction check (v2)
  const verifiedFacts = await verifyFacts(facts, allSearchResults);

  // Step 6: Synthesize (v2) — produce coherent summary
  const synthesized = await synthesizeFacts(detection.topic, verifiedFacts);
  const finalFacts = synthesized || verifiedFacts;

  // Step 7: Store facts as memories
  const storedIds = [];
  for (const fact of finalFacts) {
    let embedding = null;
    if (isEmbeddingReadyFn()) {
      try { embedding = new Float32Array(await embedFn(fact.text)); } catch {}
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
        sub_queries: detection.subQueries.slice(0, 3),
        topic: detection.topic,
        url: fact.sourceUrl || '',
        verified: fact.verified !== false,
        stored_at: new Date().toISOString(),
      },
      importance: fact.importance || 0.5,
      context_prefix: `Web research about ${detection.topic}`,
      entity: detection.entity || detection.topic.replace(/\s+/g, '_'),
      attribute: 'web_research',
    });
    if (id) storedIds.push(id);
  }

  // Step 8: Track research
  const count = sessionResearchCount.get(sessionId) || 0;
  sessionResearchCount.set(sessionId, count + 1);
  const topics = recentResearchTopics.get(sessionId) || [];
  topics.push({ topic: detection.topic, factCount: finalFacts.length, timestamp: Date.now(), query: detection.searchQuery });
  if (topics.length > 10) topics.splice(0, topics.length - 10);
  recentResearchTopics.set(sessionId, topics);

  LOG_DEBUG && console.log(`[Research] Stored ${storedIds.length} facts about "${detection.topic}" (from ${detection.subQueries.length} sub-queries, session ${sessionId})`);
}

// ── LLM Call ──────────────────────────────────────────────

async function callLLM(messages, maxTokens = 256, temperature = 0.1, timeout = 15_000) {
  try {
    const res = await llmFetch(LLM_URL, {
      method: 'POST',
      body: JSON.stringify({ model: LLM_MODEL, messages, max_tokens: maxTokens, temperature }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Qwen3 HTTP ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    LOG_DEBUG && console.error('[Research] Brain-2 call failed:', err.message);
    return '';
  }
}

// ── Topic Detection + Decomposition (v2) ──────────────────

async function detectTopic(userMessage, assistantResponse) {
  const result = { needsResearch: false, topic: '', searchQuery: '', subQueries: [], entity: '' };

  const combined = `${userMessage || ''} ${assistantResponse || ''}`.substring(0, 2000);
  if (skipNonTechnical(combined)) return result;

  // Use Brain 2 for topic detection + decomposition in one call
  const llmResponse = await callLLM([
    {
      role: 'system',
      content: `You are a research query planner for an AI coding agent's memory system.
Given the latest user message and assistant response, determine if this involves a TECHNICAL topic needing web research.

Technical topics: building/installing software, using tools/frameworks/APIs, debugging errors, configuration/deployment, how-to questions.
NOT technical: casual chat, greetings, confirmations, meta-questions about AI agents, passive mentions.

Respond in EXACT format:
TOPIC: [2-5 word topic, or NONE]
QUERIES: [JSON array of 2-3 search queries, each targeting a different aspect. Example: ["how to build X 2026", "X best practices", "X common errors"]]
ENTITY: [short entity name, or NONE]

Example:
User: "Build me an APK"
→ TOPIC: Android APK building
→ QUERIES: ["how to build Android APK from source 2026", "Android APK signing requirements 2026", "Android APK common build errors"]
→ ENTITY: android_apk`,
    },
    {
      role: 'user',
      content: `User: ${(userMessage || '').substring(0, 500)}\nAssistant: ${(assistantResponse || '').substring(0, 500)}`,
    },
  ], 200, 0.1, 15_000);

  if (!llmResponse) return regexTopicDetection(combined);

  const topicMatch = llmResponse.match(/TOPIC:\s*(.+)/i);
  const queriesMatch = llmResponse.match(/QUERIES:\s*(\[[\s\S]*?\])/i);
  const entityMatch = llmResponse.match(/ENTITY:\s*(.+)/i);

  const topic = topicMatch?.[1]?.trim() || '';
  const entity = entityMatch?.[1]?.trim() || '';

  if (!topic || topic.toUpperCase() === 'NONE') return result;

  // Parse sub-queries
  let subQueries = [];
  if (queriesMatch) {
    try {
      subQueries = JSON.parse(queriesMatch[1]);
      if (!Array.isArray(subQueries)) subQueries = [];
    } catch { subQueries = []; }
  }

  // Fallback: generate sub-queries from topic
  if (!subQueries.length) {
    const q = `how to ${topic.toLowerCase()} ${CURRENT_YEAR}`;
    subQueries = [q, `${topic} best practices ${CURRENT_YEAR}`, `${topic} common errors`];
  }

  // Limit sub-queries
  subQueries = subQueries.slice(0, RESEARCH_MAX_SUB_QUERIES);

  result.needsResearch = true;
  result.topic = topic;
  result.searchQuery = subQueries[0]; // Primary query for backward compat
  result.subQueries = subQueries;
  result.entity = entity && entity.toUpperCase() !== 'NONE' ? entity : topic.replace(/\s+/g, '_').toLowerCase();

  return result;
}

// ── Contradiction Verification (v2) ────────────────────────

async function verifyFacts(facts, searchResults) {
  if (facts.length < 2) return facts;

  const factsText = facts.map((f, i) => `[${i}] ${f.text}`).join('\n');
  const result = await callLLM([
    {
      role: 'system',
      content: `Check these extracted facts for contradictions. If two facts contradict each other, mark one as unverified.
Return ONLY a JSON array of indices that should be REMOVED (contradicted by other facts).
If no contradictions, return [].
Example: [2, 4] means facts at index 2 and 4 are contradicted.`,
    },
    { role: 'user', content: `Facts:\n${factsText}\n\nContradicted indices:` },
  ], 64, 0.1, 10_000);

  if (!result) return facts;

  try {
    const match = result.match(/\[[\s\S]*?\]/);
    if (!match) return facts;
    const removeIndices = new Set(JSON.parse(match[0]));
    return facts.filter((_, i) => !removeIndices.has(i));
  } catch {
    return facts;
  }
}

// ── Fact Synthesis (v2) ───────────────────────────────────

async function synthesizeFacts(topic, facts) {
  if (facts.length <= 1) return facts;

  const factsText = facts.map(f => `- ${f.text}`).join('\n');
  const result = await callLLM([
    {
      role: 'system',
      content: `Synthesize these research facts about "${topic}" into a coherent summary.
Return ONLY a JSON array: [{"text": "synthesized fact combining related points", "importance": 0.5, "sourceUrl": ""}]
Merge related facts. Keep distinct facts separate. Limit to 3-5 synthesized facts.`,
    },
    { role: 'user', content: `Facts about ${topic}:\n${factsText}\n\nSynthesized facts:` },
  ], 512, 0.1, 15_000);

  if (!result) return facts;

  try {
    const match = result.match(/\[[\s\S]*?\]/);
    if (!match) return facts;
    const synthesized = JSON.parse(match[0]);
    if (!Array.isArray(synthesized) || !synthesized.length) return facts;
    return synthesized
      .filter(f => f.text && typeof f.text === 'string' && f.text.trim().length > 10)
      .map(f => ({
        text: f.text.trim().substring(0, 500),
        importance: Math.min(0.8, Math.max(0.3, parseFloat(f.importance) || 0.5)),
        sourceUrl: (f.sourceUrl || '').substring(0, 500),
        verified: true,
      }));
  } catch {
    return facts;
  }
}

// ── Skip / Regex Fallbacks ────────────────────────────────

function skipNonTechnical(text) {
  const lower = text.toLowerCase().trim();
  if (lower.length < 10) return true;
  const nonTechnical = /^(ok|okay|sure|yes|no|got it|thanks|thank you|done|continue|go ahead|please|yep|yeah|nope|cool|great|good|fine|right|correct|agreed|hi|hello|hey|bye|goodbye|see you|what\??|hmm|oh|wow)[\s!.?]*$/i;
  if (nonTechnical.test(lower)) return true;
  const infoPatterns = [/\bwhat\b[\s']s?\s+(is|are)\b/i, /\btell\s+me\s+about\b/i, /\bexplain\b/i, /\bdescribe\b/i, /\bwho\b[\s']s?\s+(is|are)\b/i, /\bdefine\b/i, /\bmeaning\s+of\b/i];
  for (const p of infoPatterns) { if (p.test(lower)) return true; }
  const metaPatterns = [/\bclaude\s*code\b/i, /\bhermes\s*(agent|memory|plugin)?\b/i, /\bwhat\b[\s']s?\s+hermes\b/i, /\bnoxem\b/i, /\bqwen3?\b/i, /\bopenai\b/i, /\bai\s+(agent|tool|assistant|model)\b/i];
  for (const p of metaPatterns) { if (p.test(lower)) return true; }
  const wordsOnly = lower.replace(/[^a-z0-9\s]/g, '').trim();
  if (wordsOnly.split(/\s+/).length <= 2 && wordsOnly.length < 15) return true;
  return false;
}

function regexTopicDetection(text) {
  const result = { needsResearch: false, topic: '', searchQuery: '', subQueries: [], entity: '' };
  const negativePatterns = [/\bwhat\b[\s']s?\s+(is|are)\s/i, /\btell\s+me\s+about\b/i, /\bwho\b[\s']s?\s+(is|are)\s/i, /\bexplain\b/i, /\bdescribe\b/i, /\bdefine\b/i, /\bmeaning\s+of\b/i, /\bclaude\s*code\b/i, /\bhermes\b/i, /\bnoxem\b/i, /\bai\s+(agent|tool|assistant)\b/i, /\bmentioned\b.*\b(bug|error|issue)\b/i, /\btalked?\s+about\b/i, /\bheard\s+about\b/i, /\bsaid\s+.*\b(bug|error|crash)\b/i];
  for (const neg of negativePatterns) { if (neg.test(text)) return result; }

  const techPatterns = [
    { pattern: /\b(build\s+me|create\s+(?:a\s+|an\s+)?|make\s+(?:me\s+)?(?:a\s+|an\s+)?)\s*(\w[\w.-]{1,20}(?:\s+[\w.-]{1,15}){0,2})/i, type: 'build' },
    { pattern: /\b(install|set\s+up|setup|configure)\s+(?:a\s+|an\s+|the\s+)?(\w[\w.-]{1,20}(?:\s+[\w.-]{1,15}){0,2})/i, type: 'build' },
    { pattern: /\bhow\s+(?:do\s+i|to|can\s+i)\s+(\w[\w.-]{1,15}(?:\s+[\w.-]{1,15}){0,3})/i, type: 'howto' },
    { pattern: /\b(fix|debug|resolve|solve|troubleshoot)\s+(?:the\s+|a\s+|this\s+)?(\w[\w.-]{1,20}(?:\s+[\w.-]{1,15}){0,2})/i, type: 'fix' },
    { pattern: /\b(?:error|exception|traceback|panic)\s*(?::|—|–|-)\s*["']?(\w[\w.-]{1,20}(?:\s+[\w.-]{1,15}){0,2})/i, type: 'error' },
    { pattern: /\b(?:error|errno|exit\s+code)\s+([\w#]{2,15})/i, type: 'error' },
  ];

  for (const { pattern, type } of techPatterns) {
    const match = text.match(pattern);
    if (match) {
      const topicText = (match[2] || match[1] || '').trim();
      if (!topicText || topicText.length < 3) continue;
      result.needsResearch = true;
      result.topic = topicText;
      result.entity = topicText.replace(/\s+/g, '_').toLowerCase().substring(0, 30);

      switch (type) {
        case 'build':
          result.searchQuery = `how to build ${topicText} ${CURRENT_YEAR}`;
          result.subQueries = [`how to build ${topicText} ${CURRENT_YEAR}`, `${topicText} best practices ${CURRENT_YEAR}`, `${topicText} common errors`];
          break;
        case 'howto':
          result.searchQuery = `${topicText} ${CURRENT_YEAR}`;
          result.subQueries = [`${topicText} ${CURRENT_YEAR}`, `${topicText} tutorial`, `${topicText} troubleshooting`];
          break;
        case 'fix':
          result.searchQuery = `how to fix ${topicText} ${CURRENT_YEAR}`;
          result.subQueries = [`how to fix ${topicText} ${CURRENT_YEAR}`, `${topicText} root cause`, `${topicText} workaround`];
          break;
        case 'error':
          result.searchQuery = `${topicText} fix`;
          result.subQueries = [`${topicText} fix`, `${topicText} error solution`, `${topicText} stack overflow`];
          break;
        default:
          result.searchQuery = `${topicText} ${CURRENT_YEAR}`;
          result.subQueries = [`${topicText} ${CURRENT_YEAR}`];
      }
      break;
    }
  }
  return result;
}

// ── Fact Extraction ───────────────────────────────────────

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

setInterval(() => {
  const now = Date.now();
  for (const [sid, lastTime] of sessionLastResearch) {
    if (now - lastTime > 3_600_000) {
      sessionLastResearch.delete(sid);
      sessionResearchCount.delete(sid);
      recentResearchTopics.delete(sid);
    }
  }
}, 300_000).unref();
