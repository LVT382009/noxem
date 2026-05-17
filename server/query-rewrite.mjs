import crypto from 'crypto';
import { callLLM } from './advisor-engine.mjs';

const REWRITE_SYSTEM = `You are a query rewriter for a personal memory search engine.
Rewrite the user's search query to be more searchable.
Rules:
- Preserve the EXACT intent. Do not add, remove, or change what the user is looking for.
- Replace vague temporal references: "last week" → "recent", "that one time" → "past occurrence"
- Replace pronouns and references: "that bug" → "bug issue", "the meeting" → "meeting event"
- Add domain-specific terms: "auth" → "authentication authorization", "deploy" → "deployment release"
- Output ONLY the rewritten query string, nothing else.`;

// Rewrite cache — exact match, 10min TTL
const _rewriteCache = new Map();
const REWRITE_CACHE_MAX = 200;
const REWRITE_CACHE_TTL_MS = 10 * 60 * 1000;

function hashQuery(query) {
  const normalized = query.toLowerCase().trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export async function rewriteQuery(query, { timeoutMs = 3000 } = {}) {
  // Check cache
  const cacheKey = hashQuery(query);
  const cached = _rewriteCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < REWRITE_CACHE_TTL_MS) return cached;

  // Call LLM for rewrite
  const messages = [
    { role: 'system', content: REWRITE_SYSTEM },
    { role: 'user', content: `Query: "${query}"\nRewritten:` }
  ];

  try {
    const res = await callLLM(messages, 50, 0.1, timeoutMs);
    const data = await res.json();
    const rewritten = (data?.choices?.[0]?.message?.content || query).trim();

    const result = { rewritten, variants: [], timestamp: Date.now() };

    // Evict oldest if at capacity
    if (_rewriteCache.size >= REWRITE_CACHE_MAX) {
      const oldest = _rewriteCache.keys().next().value;
      _rewriteCache.delete(oldest);
    }
    _rewriteCache.set(cacheKey, result);
    return result;
  } catch {
    // Graceful fallback — return original query on any failure
    return { rewritten: query, variants: [] };
  }
}

export function clearRewriteCache() {
  _rewriteCache.clear();
}
