import express from 'express';
import cors from 'cors';
import { initEmbeddingEngine, isEmbeddingReady, getEmbeddingError, embed, embedBatch, searchByEmbedding, mmrRerank, categorizeText, estimateImportance, extractEntityAttribute, generateContextPrefix } from './embedding-engine.mjs';
import { isVecReady } from './vector-index.mjs';
import {
  storeMemory, storeMemories, searchMemories, getMemory, getActiveMemories,
  getAllActiveMemories, getSessionMemories, getMemoriesByType,
  getActiveWithEmbedding, getMemoryStats, updateMemoryStatus, updateMemoryType,
  deleteMemory, deleteInvalid, incrementRecallCounts, archiveStaleMemories, vectorKnnSearch,
  getMemoriesWithoutEmbedding, updateMemoryEmbedding, addVecsToIndex, close,
  getMemoriesByEntityAttr, db,
} from './memory-store.mjs';
import { analyzeBeforeCompress, getAdvice, analyzeSessionEnd } from './advisor-engine.mjs';
import { searchWeb, formatSearchResults } from './ddg-search.mjs';
import { runMaintenance, startMaintenanceCron, stopMaintenanceCron } from './memory-maintenance.mjs';

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:* http://127.0.0.1:*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));

// Simple sliding-window rate limiter (in-memory, per-IP)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120');
const rateLimitBuckets = new Map();
function rateLimiter(req, res, next) {
  if (RATE_LIMIT_MAX <= 0) return next();
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_LIMIT_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateLimitBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after_ms: RATE_LIMIT_WINDOW_MS - (now - bucket.start) });
  }
  next();
}
// Periodic cleanup of stale rate limit buckets
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, bucket] of rateLimitBuckets) {
    if (bucket.start < cutoff) rateLimitBuckets.delete(ip);
  }
}, 120_000);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    if (process.env.LOG_LEVEL !== 'silent') {
      console.log(`[${level}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

app.use(rateLimiter);

const PORT = process.env.MEMORY_PORT || 3001;
const ENABLE_EMBEDDING = process.env.ENABLE_EMBEDDING !== 'false';
const ENABLE_ADVISOR = process.env.ENABLE_ADVISOR !== 'false';
const ENABLE_MAINTENANCE = process.env.ENABLE_MAINTENANCE !== 'false';
const DECAY_HALF_LIFE_DAYS = parseFloat(process.env.MEMORY_DECAY_HALF_LIFE || '30');

// Type-specific decay half-lives (days) — profile never decays, events decay fast
const DECAY_BY_TYPE = {
  profile: Infinity,   // Identity — never decay
  preference: 180,     // Preferences change slowly (6 months)
  setup: 120,          // Tech stack changes quarterly
  project: 60,         // Project context changes monthly
  goal: 45,            // Goals shift frequently
  fact: 30,            // Generic facts
  learning: 45,        // Learning persists
  pattern: 60,         // Habits are stable
  entity: 90,          // Entities are relatively stable
  issue: 14,           // Issues get resolved
  event: 7,            // Events are time-sensitive
  request: 3,          // Requests are ephemeral
  general: 30,         // Default
};

function getEffectiveHalfLife(type, importance, recallCount) {
  const baseHalfLife = DECAY_BY_TYPE[type] ?? DECAY_HALF_LIFE_DAYS;
  if (baseHalfLife === Infinity) return Infinity;
  const importanceMod = 0.5 + importance;  // 0.5-1.5x multiplier
  const recallMod = 1 + 0.3 * recallCount; // SRS: each recall extends 30%
  return baseHalfLife * importanceMod * recallMod;
}

// ─── Startup ─────────────────────────────────────────────────────
let startupComplete = false;
const serverStartTime = Date.now();

async function startup() {
  if (ENABLE_EMBEDDING) {
    await initEmbeddingEngine();
    // Warm up: compute a dummy embedding to avoid cold-start latency
    if (isEmbeddingReady()) {
      try {
        await embed('warmup');
        console.log('Embedding engine warmed up');
      } catch (err) {
        console.error('Embedding warm-up failed:', err.message);
      }
    }
  }
  if (ENABLE_MAINTENANCE) startMaintenanceCron();
  startupComplete = true;
  console.log('Memory server fully initialized');
}

startup().catch(err => {
  console.error('Startup error:', err);
  startupComplete = true; // Allow server to function without embeddings
});

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const stats = getMemoryStats();
  let gemma4Ok = false;
  try {
    const r = await fetch(`${process.env.GEMMA_URL || 'http://127.0.0.1:8000'}/v1/models`, { signal: AbortSignal.timeout(2000) });
    gemma4Ok = r.ok;
  } catch {}
  res.json({
    ok: true,
    version: '2.1.0',
    uptime_seconds: Math.round((Date.now() - serverStartTime) / 1000),
    embedding: isEmbeddingReady(),
    embedding_error: getEmbeddingError()?.message || null,
    vector_index: isVecReady(),
    advisor: ENABLE_ADVISOR,
    gemma4: gemma4Ok,
    maintenance: ENABLE_MAINTENANCE,
    mode: 'hybrid-ai',
    memory: {
      active: stats.active,
      total_by_status: stats.breakdown,
    },
  });
});

app.get('/ready', (_req, res) => {
  if (startupComplete) return res.json({ ok: true });
  res.status(503).json({ ok: false, message: 'still starting up' });
});

// ─── Scoring Utilities ───────────────────────────────────────────

// Normalize FTS5 rank to 0-1 similarity-like score (higher = better)
function normalizeFtsScore(results) {
  if (!results.length) return results;
  // FTS5 rank is negative bm25 (lower = more relevant)
  // Flip sign so higher = better, then min-max normalize to [0.3, 1.0]
  const maxRank = Math.max(...results.map(r => -r.score));
  const minRank = Math.min(...results.map(r => -r.score));
  return results.map(r => {
    const flipped = -r.score;
    const normalized = maxRank === minRank
      ? 1.0
      : 0.3 + 0.7 * (flipped - minRank) / (maxRank - minRank);
    return { ...r, score: Math.round(normalized * 1000) / 1000 };
  });
}

// Recency + importance + spaced-repetition weighted scoring
// Formula: final_score = similarity * (0.4 + 0.25 * recency_weight + 0.2 * importance + 0.15 * reinforcement)
// recency_weight = 0.5 ** (age_days / effective_half_life) — type-specific half-lives
// effective_half_life = type_base * (0.5 + importance) * (1 + 0.3 * recall_count)
// reinforcement = 1 - e^(-recall_count / 3) — exponential approach to 1.0
function applyRecencyScore(results) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  return results.map(r => {
    const ts = r.created_at ? new Date(r.created_at).getTime() : now;
    const createdAt = Number.isFinite(ts) ? ts : now;
    const ageMs = Math.max(0, now - createdAt);
    const recallCount = r.recall_count ?? 0;
    const importance = r.importance ?? 0.5;
    const type = r.type || 'general';
    const halfLifeDays = getEffectiveHalfLife(type, importance, recallCount);
    if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
      // Invalid half-life — treat as no decay
      return { ...r, score: r.score };
    }
    if (halfLifeDays === Infinity) {
      // Profile/identity memories never decay — recency always 1.0
      const reinforcement = 1 - Math.exp(-recallCount / 3);
      const boosted = r.score * (0.4 + 0.25 + 0.2 * importance + 0.15 * reinforcement);
      return { ...r, score: Math.round(boosted * 1000) / 1000 };
    }
    const halfLifeMs = halfLifeDays * dayMs;
    const recencyWeight = Math.pow(0.5, ageMs / halfLifeMs);
    // Exponential reinforcement curve: asymptotically approaches 1.0
    // At 1 recall: 0.28, at 3: 0.63, at 6: 0.86, at 10: 0.96
    const reinforcement = 1 - Math.exp(-recallCount / 3);
    const boosted = r.score * (0.4 + 0.25 * recencyWeight + 0.2 * importance + 0.15 * reinforcement);
    return { ...r, score: Math.round(boosted * 1000) / 1000 };
  });
}

// Reciprocal Rank Fusion: merge multiple ranked lists by position
// RRF score = sum(1 / (k + rank)) across all lists. k=60 is standard.
function reciprocalRankFusion(lists, k = 60) {
  const scores = new Map(); // id -> { rrf_score, data }
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = item.id;
      const existing = scores.get(id);
      const contribution = 1 / (k + rank + 1); // 0-indexed rank
      if (existing) {
        existing.rrf_score += contribution;
        // Keep the richer data object (prefer first seen with embedding score)
      } else {
        scores.set(id, { rrf_score: contribution, data: item });
      }
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .map(entry => ({ ...entry.data, score: Math.round(entry.rrf_score * 1000) / 1000 }));
}

// ─── Memory CRUD ─────────────────────────────────────────────────

const VALID_TYPES = ['general', 'fact', 'preference', 'profile', 'project', 'goal', 'pattern', 'entity', 'event', 'issue', 'setup', 'learning', 'request'];

app.post('/memory/store', async (req, res) => {
  try {
    const { text, session_id, type, metadata } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required (non-empty string)' });
    if (text.length > 10000) return res.status(400).json({ error: 'text too long (max 10000 chars)' });
    if (type && !VALID_TYPES.includes(type)) return res.status(400).json({ error: `invalid type: ${type}. Valid: ${VALID_TYPES.join(', ')}` });

    const catType = type || categorizeText(text);
    const trimmed = text.trim();
    const { entity, attribute } = extractEntityAttribute(trimmed);
    const contextPrefix = generateContextPrefix(trimmed, catType, session_id);
    let embedding = null;

    if (isEmbeddingReady()) {
      try {
        // Contextual enrichment: prepend context prefix for better retrieval
        const embedText = contextPrefix ? `${contextPrefix} ${trimmed}` : trimmed;
        const vec = await embed(embedText);
        embedding = new Float32Array(vec);
      } catch { /* proceed without embedding */ }
    }

    const id = storeMemory({
      session_id: session_id || '',
      type: catType,
      text: trimmed,
      embedding,
      metadata: { ...(metadata || {}), source: metadata?.source || "api", extraction_method: metadata?.extraction_method || "store_api", origin_session_id: session_id || "", stored_at: new Date().toISOString() },
      importance: estimateImportance(trimmed, catType),
      context_prefix: contextPrefix,
      entity,
      attribute,
    });

    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/store-batch', async (req, res) => {
  try {
    const { memories } = req.body;
    if (!memories?.length) return res.status(400).json({ error: 'memories array required' });

    const enrichedMemories = memories.map(m => {
      const catType = m.type || categorizeText(m.text);
      const trimmed = m.text.trim();
      const { entity, attribute } = extractEntityAttribute(trimmed);
      const contextPrefix = generateContextPrefix(trimmed, catType, m.session_id);
      return { ...m, catType, trimmed, entity, attribute, contextPrefix };
    });

    let embeddings = null;
    if (isEmbeddingReady()) {
      try {
        const embedTexts = enrichedMemories.map(m => m.contextPrefix ? m.contextPrefix + " " + m.trimmed : m.trimmed);
        embeddings = await embedBatch(embedTexts);
      } catch { /* proceed */ }
    }

    const items = enrichedMemories.map((m, i) => ({
      session_id: m.session_id || '',
      type: m.catType,
      text: m.trimmed,
      embedding: embeddings ? new Float32Array(embeddings[i]) : null,
      metadata: { ...(m.metadata || {}), source: m.metadata?.source || "api", extraction_method: m.metadata?.extraction_method || "store_batch_api" },
      importance: estimateImportance(m.trimmed, m.catType),
      context_prefix: m.contextPrefix,
      entity: m.entity,
      attribute: m.attribute,
    }));

    const ids = storeMemories(items);
    res.json({ ok: true, ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/memory/search", async (req, res) => {
  let searchResults = [];
  try {
    const { q, session_id, limit, method, expand } = req.query;
    if (!q?.trim()) return res.status(400).json({ error: "query required" });
    if (q.length > 1000) return res.status(400).json({ error: "query too long (max 1000 chars)" });
    const limitNum = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
    let searchMethod = "fts";
    const isShortQuery = expand !== "false" && q.trim().split(/\s+/).length < 6;

    // Multi-query expansion for vague queries
    let queries = [q.trim()];
    if (isShortQuery && ENABLE_ADVISOR) {
      try {
        const expQ = q.trim().replace(/"/g, "");
        const prompt = "Generate 2 alternative ways to phrase this search query for a personal memory store. Return ONLY a JSON array of 2 strings. Query: " + expQ;
        const expandRes = await fetch(process.env.GEMMA_URL || "http://127.0.0.1:8000/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gemma4", messages: [{ role: "user", content: prompt }], max_tokens: 100, temperature: 0.3 }),
          signal: AbortSignal.timeout(3000),
        });
        if (expandRes.ok) {
          const expandData = await expandRes.json();
          const content = expandData.choices?.[0]?.message?.content || "";
          const match = content.match(/\[.*?\]/s);
          if (match) {
            const alternates = JSON.parse(match[0]);
            if (Array.isArray(alternates)) queries = [q.trim(), ...alternates.slice(0, 2)];
          }
        }
      } catch { /* expansion is optional */ }
    }

    // Embedding search (primary) - try KNN first, fall back to JS cosine
    if ((!method || method === "hybrid" || method === "embedding") && isEmbeddingReady()) {
      try {
        const queryVecs = await Promise.all(queries.map(qq => embed(qq, "query")));
        const qVec = queryVecs[0];
        let embeddingResults = null;

        if (queryVecs.length > 1) {
          // Multi-query: search each variant, merge via RRF
          const allEmbRes = [];
          for (const vec of queryVecs) {
            const knnHits = vectorKnnSearch(vec, limitNum * 3);
            if (knnHits && knnHits.length > 0) { allEmbRes.push(applyRecencyScore(knnHits)); }
            else {
              const cands = searchByEmbedding(vec, getAllActiveMemories(), limitNum * 3);
              allEmbRes.push(applyRecencyScore(mmrRerank(vec, cands, limitNum * 2, 0.7)));
            }
          }
          embeddingResults = allEmbRes.length > 1 ? reciprocalRankFusion(allEmbRes) : allEmbRes[0];
          searchMethod = "multi-query";
        } else {
          const knnHits = vectorKnnSearch(qVec, limitNum * 3);
          if (knnHits && knnHits.length > 0) { embeddingResults = applyRecencyScore(knnHits); searchMethod = "knn"; }
          else {
            const cands = searchByEmbedding(qVec, getAllActiveMemories(), limitNum * 3);
            embeddingResults = applyRecencyScore(mmrRerank(qVec, cands, limitNum * 2, 0.7));
          }
        }

        if (embeddingResults && embeddingResults.length > 0 && method === "embedding") {
          searchResults = embeddingResults.slice(0, limitNum);
          searchMethod = "embedding";
        } else if ((method === "hybrid" || !method) && embeddingResults && embeddingResults.length > 0) {
          const allFts = queries.map(qq => applyRecencyScore(normalizeFtsScore(searchMemories({ query: qq, limit: limitNum * 3 }))));
          const ftsResults = allFts.length > 1 ? reciprocalRankFusion(allFts) : allFts[0];
          searchResults = reciprocalRankFusion([embeddingResults, ftsResults]).slice(0, limitNum);
          searchMethod = "hybrid" + (queries.length > 1 ? "+expanded" : "");
        }
      } catch { /* fall through to FTS */ }
    }

    // FTS fallback
    if (!searchResults.length) {
      if (queries.length > 1) {
        const allFts = queries.map(qq => applyRecencyScore(normalizeFtsScore(searchMemories({ query: qq, limit: limitNum }))));
        searchResults = reciprocalRankFusion(allFts).slice(0, limitNum);
        searchMethod = "fts+expanded";
      } else {
        searchResults = applyRecencyScore(normalizeFtsScore(searchMemories({ query: q, limit: limitNum })));
      }
    }

    // Apply session filter to all search methods
    if (session_id) searchResults = searchResults.filter(r => r.session_id === session_id);

    // Track recall counts for returned results
    try {
      const ids = searchResults.map(r => r.id).filter(Boolean);
      if (ids.length) incrementRecallCounts(ids);
    } catch {}

    res.json({ ok: true, method: searchMethod, queries: queries.length > 1 ? queries : undefined, results: searchResults });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/stats', (_req, res) => {
  res.json(getMemoryStats());
});

// Release endpoint: curated context for LLM injection
// Selects top memories by importance×recency, deduplicates by entity+attribute,
// and returns formatted text ready for LLM context
app.get('/memory/release', async (req, res) => {
  try {
    const tokenBudget = Math.min(Math.max(parseInt(req.query.tokens) || 2000, 100), 8000);
    const sessionId = req.query.session_id || '';

    let memories = getAllActiveMemories();
    if (sessionId) memories = memories.filter(m => m.session_id === sessionId);

    // Score and rank by composite: recency × importance
    const scored = applyRecencyScore(
      memories.map(m => ({
        ...m,
        score: m.importance ?? 0.5,
      }))
    ).sort((a, b) => b.score - a.score);

    // Deduplicate: keep only the highest-scored memory per entity+attribute pair
    const seen = new Set();
    const deduped = scored.filter(m => {
      const key = m.entity && m.attribute ? `${m.entity}::${m.attribute}` : null;
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Build formatted text within token budget (rough: 1 token ≈ 4 chars)
    const charBudget = tokenBudget * 4;
    const lines = [];
    let chars = 0;
    for (const m of deduped) {
      const prefix = m.context_prefix ? `[${m.context_prefix}] ` : '';
      const line = `- (${m.type}) ${prefix}${m.text}`;
      if (chars + line.length > charBudget) break;
      lines.push(line);
      chars += line.length;
    }

    res.json({
      ok: true,
      memories: lines.length,
      total_candidates: scored.length,
      token_budget: tokenBudget,
      text: lines.join('\n'),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/session/:sessionId', (req, res) => {
  try {
    const { limit, offset } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
    const offsetNum = Math.max(parseInt(offset) || 0, 0);
    const all = getSessionMemories(req.params.sessionId, limitNum + offsetNum);
    res.json({ results: all.slice(offsetNum, offsetNum + limitNum), total: all.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/type/:type', (req, res) => {
  try {
    const { limit, offset } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
    const offsetNum = Math.max(parseInt(offset) || 0, 0);
    const all = getMemoriesByType(req.params.type, limitNum + offsetNum);
    res.json({ results: all.slice(offsetNum, offsetNum + limitNum), total: all.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Export / Import ────────────────────────────────────────────

app.get('/memory/export', (_req, res) => {
  try {
    const memories = getAllActiveMemories();
    const stats = getMemoryStats();
    res.json({ ok: true, version: '2.1.0', exported_at: new Date().toISOString(), stats, memories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/import', async (req, res) => {
  try {
    const { memories } = req.body;
    if (!memories?.length) return res.status(400).json({ error: 'memories array required' });
    if (memories.length > 1000) return res.status(400).json({ error: 'batch too large (max 1000)' });

    const imported = [];
    for (const m of memories) {
      if (!m.text || typeof m.text !== 'string') continue;
      const embedding = m.embedding ? new Float32Array(m.embedding) : null;
      const id = storeMemory({
        session_id: m.session_id || '',
        type: VALID_TYPES.includes(m.type) ? m.type : 'fact',
        text: m.text,
        embedding,
        metadata: { ...(m.metadata || {}), source: 'import', imported_at: new Date().toISOString() },
        importance: m.importance ?? 0.5,
        context_prefix: m.context_prefix || '',
        entity: m.entity || '',
        attribute: m.attribute || '',
        valid_from: m.valid_from || new Date().toISOString(),
      });
      imported.push(id);
    }
    res.json({ ok: true, imported: imported.length, ids: imported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:id', (req, res) => {
  try {
  const mem = getMemory(parseInt(req.params.id));
  if (!mem) return res.status(404).json({ error: 'not found' });
  res.json(mem);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/memory/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const mem = getMemory(id);
    if (!mem) return res.status(404).json({ error: 'not found' });
    deleteMemory(id);
    res.json({ ok: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Provenance & Lineage ──────────────────────────────────────

app.post('/memory/supersede', (req, res) => {
  try {
    const old_id = parseInt(req.body.old_id);
  const new_id = parseInt(req.body.new_id);
  const { reason } = req.body;
    if (!old_id || !new_id) return res.status(400).json({ error: 'old_id and new_id required' });

    const oldMem = getMemory(old_id);
    if (!oldMem) return res.status(404).json({ error: `memory ${old_id} not found` });

    // Mark old as superseded by new
updateMemoryStatus(old_id, 'superseded', new_id);

// Bi-temporal: set valid_until on old, valid_from on new
const now = new Date().toISOString();
const setValidUntil = db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?');
setValidUntil.run(now, old_id);
const setValidFrom = db.prepare('UPDATE memories SET valid_from = ? WHERE id = ? AND valid_from IS NULL');
setValidFrom.run(now, new_id);

// Add provenance to new memory metadata
const newMem = getMemory(new_id);
if (newMem) {
  const oldMeta = JSON.parse(oldMem.metadata || '{}');
  const newMeta = JSON.parse(newMem.metadata || '{}');
  newMeta.supersedes = old_id;
  newMeta.supersede_reason = reason || 'contradiction';
  newMeta.derived_from = [...(oldMeta.derived_from || []), old_id];
  // Track source memory IDs for provenance graph
  let sourceIds = [];
  try { sourceIds = JSON.parse(newMem.source_memory_ids || '[]'); } catch {}
  if (!sourceIds.includes(old_id)) sourceIds.push(old_id);
  const updateMeta = db.prepare('UPDATE memories SET metadata = ?, source_memory_ids = ? WHERE id = ?');
  updateMeta.run(JSON.stringify(newMeta), JSON.stringify(sourceIds), new_id);
}

res.json({ ok: true, old_id, new_id, status: 'superseded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:id/lineage', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const lineage = [];
    let current = getMemory(id);
    while (current) {
      const meta = JSON.parse(current.metadata || '{}');
      lineage.push({
        id: current.id,
        text: current.text,
        type: current.type,
        status: current.status,
        created_at: current.created_at,
        valid_from: current.valid_from,
        valid_until: current.valid_until,
        source: meta.source,
        extraction_method: meta.extraction_method,
        origin_session_id: meta.origin_session_id,
        derived_from: meta.derived_from || [],
        supersedes: meta.supersedes || null,
      });
      if (current.superseded_by) {
        current = getMemory(current.superseded_by);
      } else {
        break;
      }
    }
    res.json({ ok: true, lineage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Contradiction Detection ────────────────────────────────────

app.post('/memory/contradiction-check', (req, res) => {
try {
  const { entity, attribute, text } = req.body;
  if (!entity || !attribute) return res.status(400).json({ error: 'entity and attribute required' });

  const existing = getMemoriesByEntityAttr(entity, attribute);
  if (!existing.length) return res.json({ ok: true, conflicts: [] });

  // Check if any existing memories with same entity+attribute might contradict the new one
  const conflicts = existing.filter(m => {
    // Simple heuristic: same entity+attribute = potential conflict
    // More precise check: compare the "value" part
    const lower = m.text.toLowerCase();
    const newLower = (text || '').toLowerCase();
    // If both express preferences, check if values differ
    const prefVerbs = /(?:prefer|like|love|hate|dislike|use|using|favor|choose)\s+(\S+)/i;
    const existingMatch = lower.match(prefVerbs);
    const newMatch = newLower.match(prefVerbs);
    if (existingMatch && newMatch && existingMatch[1] !== newMatch[1]) {
      return true; // Different values for same entity+attribute
    }
    return false;
  });

  res.json({ ok: true, conflicts: conflicts.map(m => ({ id: m.id, text: m.text, type: m.type, created_at: m.created_at })) });
} catch (err) {
  res.status(500).json({ error: err.message });
}
});

// ─── Sync Turn (called by provider.sync_turn) ──────────────────

// Skip short/greeting messages that aren't worth storing
const SKIP_PATTERNS = [
  /^(ok|okay|sure|yes|no|got it|thanks|thank you|done|continue|go ahead|please|yep|yeah|nope|cool|great|good|fine|right|correct|agreed)$/i,
  /^(hi|hello|hey|good morning|good afternoon|good evening|bye|goodbye|see you)$/i,
  /^\s*.{0,4}\s*$/, // Very short messages (<5 chars: "ok", "yes", etc.)
];

// Patterns that always bypass skip (even if they match a skip pattern) —
// these signal important self-disclosure or preferences
const FORCE_SAVE_PATTERNS = [
  /\b(my name is|i'm called|call me)\b/i,
  /\b(i prefer|i like|i love|i hate|i dislike|i use|i'm using)\b/i,
  /\b(my secret|my password|my phrase|my key)\b/i,
  /\b(i work on|i'm working on|my project)\b/i,
  /\b(remember this|don't forget|write this down|save this)\b/i,
  /\b(my goal|my plan|i want to|i need to)\b/i,
];

function shouldSkipMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Force-save: important self-disclosure always stored
  if (FORCE_SAVE_PATTERNS.some(p => p.test(trimmed))) return false;
  return SKIP_PATTERNS.some(p => p.test(trimmed));
}

app.post('/memory/sync', async (req, res) => {
  try {
    const { user_message, assistant_response, session_id } = req.body;
    if (!user_message && !assistant_response) {
      return res.status(400).json({ error: 'user_message or assistant_response required' });
    }

    const memories = [];
    const now = new Date().toISOString();

    // Store user message — skip trivial/greeting messages
    if (user_message?.trim() && !shouldSkipMessage(user_message)) {
      const type = categorizeText(user_message);
      const userText = user_message.trim().substring(0, 500);
      const { entity: userEntity, attribute: userAttr } = extractEntityAttribute(userText);
      const userPrefix = generateContextPrefix(userText, type, session_id);
      let embedding = null;
      if (isEmbeddingReady()) {
        try {
          const embedText = userPrefix ? userPrefix + " " + userText : userText;
          embedding = new Float32Array(await embed(embedText));
        } catch {}
      }
      memories.push({ session_id, type, text: userText, embedding, metadata: { source: "user", extraction_method: "sync", origin_session_id: session_id, timestamp: now }, importance: estimateImportance(userText, type), context_prefix: userPrefix, entity: userEntity, attribute: userAttr });
    }

    // Store assistant response — skip very short responses
      if (assistant_response?.trim() && !shouldSkipMessage(assistant_response)) {
      const asstText = assistant_response.trim().substring(0, 500);
      const { entity: asstEntity, attribute: asstAttr } = extractEntityAttribute(asstText);
      const asstPrefix = generateContextPrefix(asstText, "fact", session_id);
      let embedding = null;
      if (isEmbeddingReady()) {
        try {
          const embedText = asstPrefix ? asstPrefix + " " + asstText : asstText;
          embedding = new Float32Array(await embed(embedText));
        } catch {}
      }
      memories.push({ session_id, type: "fact", text: asstText, embedding, metadata: { source: "assistant", extraction_method: "sync", origin_session_id: session_id, timestamp: now }, importance: estimateImportance(asstText, "fact"), context_prefix: asstPrefix, entity: asstEntity, attribute: asstAttr });
    }

    const ids = memories.length > 0 ? storeMemories(memories) : [];
    res.json({ ok: true, stored: ids.length, ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Advisor ─────────────────────────────────────────────────────

app.post('/memory/advisor/compress', async (req, res) => {
  try {
    const { conversation_history, session_memories } = req.body;
    if (!ENABLE_ADVISOR) {
      return res.json({ ok: true, mode: 'disabled', advice: 'Advisor disabled. Set ADVISOR_ENABLED=true' });
    }
    const analysis = await analyzeBeforeCompress(conversation_history || [], session_memories || []);
    res.json({ ok: true, mode: 'gemma4', analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/advisor/advice', async (req, res) => {
  try {
    const { user_message, conversation_history, active_memories, task_context } = req.body;
    if (!ENABLE_ADVISOR) {
      return res.json({ ok: true, mode: 'disabled', advice: 'Advisor disabled.' });
    }
    const advice = await getAdvice({
      userMessage: user_message || '',
      conversationHistory: conversation_history || [],
      activeMemories: active_memories || [],
      currentTaskContext: task_context || '',
    });
    res.json({ ok: true, mode: 'gemma4', advice });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/session/end', async (req, res) => {
  try {
    const { conversation_history, session_id } = req.body;

    // AI extraction
    let newMemories = [];
    if (ENABLE_ADVISOR) {
      const sessionMems = getSessionMemories(session_id);
      newMemories = await analyzeSessionEnd(conversation_history || [], sessionMems);
    }

    // Store extracted memories
    const ids = [];
    if (newMemories.length > 0) {
      for (const m of newMemories) {
        let embedding = null;
        if (isEmbeddingReady()) {
          try { embedding = new Float32Array(await embed(m.text)); } catch {}
        }
        const id = storeMemory({ session_id, type: m.type, text: m.text, embedding, importance: estimateImportance(m.text, m.type) });
        ids.push(id);
      }
    }

    res.json({ ok: true, extracted: newMemories.length, stored_ids: ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Web Search ───────────────────────────────────────────────────

app.get('/search/web', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q?.trim()) return res.status(400).json({ error: 'query "q" required' });

    const results = await searchWeb(q);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Re-embed ────────────────────────────────────────────────────

app.post('/memory/reembed', async (req, res) => {
  try {
    if (!isEmbeddingReady()) {
      return res.status(503).json({ error: 'Embedding engine not ready' });
    }
    const limit = req.body?.limit || 100;
    const missing = getMemoriesWithoutEmbedding(limit);
    if (!missing.length) {
      return res.json({ ok: true, reembedded: 0, message: 'no memories missing embeddings' });
    }

    const texts = missing.map(m => m.text);
    const embeddings = await embedBatch(texts);
    const ids = missing.map(m => m.id);

    for (let i = 0; i < ids.length; i++) {
      const vec = new Float32Array(embeddings[i]);
      updateMemoryEmbedding(ids[i], vec);
    }
    addVecsToIndex(ids, embeddings);

    res.json({ ok: true, reembedded: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Extract ─────────────────────────────────────────────────────

app.post('/memory/extract', async (req, res) => {
  try {
    const { user_message, assistant_response, session_id } = req.body;
    if (!user_message && !assistant_response) {
      return res.status(400).json({ error: 'user_message or assistant_response required' });
    }

    let memories = [];
    if (ENABLE_ADVISOR) {
      const { extractMemories } = await import('./memory-extract.mjs');
      memories = await extractMemories({ userMessage: user_message, assistantResponse: assistant_response });
    }

    // Fallback to simple rule-based extraction
    if (!memories.length) {
      const { extractMemoriesSimple } = await import('./memory-extract.mjs');
      memories = extractMemoriesSimple({ userMessage: user_message, assistantResponse: assistant_response });
    }

    // Store extracted memories
    const ids = [];
    for (const m of memories) {
      let embedding = null;
      if (isEmbeddingReady()) {
        try { embedding = new Float32Array(await embed(m.text)); } catch {}
      }
      const id = storeMemory({ session_id, type: m.type, text: m.text, embedding, importance: estimateImportance(m.text, m.type) });
      ids.push(id);
    }

    res.json({ ok: true, extracted: memories.length, stored_ids: ids, memories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Maintenance ─────────────────────────────────────────────────

app.post('/memory/maintenance/run', async (req, res) => {
  try {
    const results = await runMaintenance();
    res.json({ ok: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/maintenance/stop', (_req, res) => {
  stopMaintenanceCron();
  res.json({ ok: true });
});

// Purge low-importance old memories
const AUTO_PURGE_DAYS = parseInt(process.env.AUTO_PURGE_DAYS || '365');
app.post('/memory/purge', (_req, res) => {
  try {
    const before = getMemoryStats();
    const purgeStmt = db.prepare(
      `DELETE FROM memories WHERE importance < 0.3 AND recall_count = 0 AND created_at < datetime('now', '-' || ? || ' days') AND status = 'active'`
    );
    const result = purgeStmt.run(AUTO_PURGE_DAYS);
    const after = getMemoryStats();
    res.json({ ok: true, purged: result.changes, before: before.active, after: after.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─── Start ────────────────────────────────────────────────────────
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`━━━━ Hermes AI Memory Server v2 ━━━━`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Embedding: ${ENABLE_EMBEDDING ? 'EmbeddingGemma 300M (q8, 256d)' : 'DISABLED'}`);
  console.log(`  Vector Index: ${isVecReady() ? 'sqlite-vec KNN' : 'JS cosine fallback'}`);
  console.log(`  Advisor: ${ENABLE_ADVISOR ? 'Gemma 4' : 'DISABLED'}`);
  console.log(`  Web Search: ${ENABLE_ADVISOR && process.env.ADVISOR_WEB_SEARCH !== 'false' ? 'DDG' : 'DISABLED'}`);
  console.log(`  Maintenance: ${ENABLE_MAINTENANCE ? 'ON (5min)' : 'DISABLED'}`);
  console.log(`  Decay half-life: ${DECAY_HALF_LIFE_DAYS} days`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  if (_errorLogInterval) clearInterval(_errorLogInterval);
  stopMaintenanceCron();
  server.close(() => {
    close(); // close SQLite
    console.log('Memory server stopped.');
    process.exit(0);
  });
  // Force exit after 5s if connections don't close
  setTimeout(() => {
    console.log('Forcing exit after timeout.');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors gracefully — debounce non-fatal errors like gemma4-server
const _errorCounts = new Map();
let _errorLogInterval = null;
function _startErrorLogger() {
  if (_errorLogInterval) return;
  _errorLogInterval = setInterval(() => {
    for (const [msg, count] of _errorCounts) {
      if (count > 1) {
        console.error(`Uncaught exception (non-fatal, ${count}x): ${msg}`);
      }
      _errorCounts.delete(msg);
    }
  }, 5000).unref();
}

const FATAL_ERROR_PATTERNS = [/EADDRINUSE/, /ENOMEM/, /heap out of memory/, /SQLITE_CORRUPT/];
process.on('uncaughtException', (err) => {
  const msg = err.message || String(err);
  const isFatal = FATAL_ERROR_PATTERNS.some(p => p.test(msg));
  if (isFatal) {
    console.error('Fatal uncaught exception:', msg);
    shutdown('FATAL_EXCEPTION');
    return;
  }
  // Non-fatal: debounce and count
  const count = (_errorCounts.get(msg) || 0) + 1;
  _errorCounts.set(msg, count);
  if (count === 1) {
    console.error(`Uncaught exception (non-fatal): ${msg}`);
    _startErrorLogger();
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('Unhandled rejection:', msg);
});
