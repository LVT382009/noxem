import express from 'express';
import cors from 'cors';
import { initEmbeddingEngine, isEmbeddingReady, getEmbeddingError, embed, embedBatch, searchByEmbedding, mmrRerank, categorizeText, estimateImportance, extractEntityAttribute, generateContextPrefix, findDuplicates, cosineSimilarity } from './embedding-engine.mjs';
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);

import { isVecReady, checkTurboVecHealth, isTurboVecHealthy, getVectorBackend } from './vector-index.mjs';
import { llmFetch } from './llm-fetch.mjs';
import {
  storeMemory, storeMemories, searchMemories, getMemory, getActiveMemories,
  getAllActiveMemories, getAllActiveMemoriesNoEmbed, getSessionMemories, getMemoriesByType, getSessionMemoryCount, getTypeMemoryCount,
  getActiveWithEmbedding, getMemoryStats, updateMemoryStatus, updateMemoryType,
  deleteMemory, deleteInvalid, incrementRecallCounts, boostUsedMemories, archiveStaleMemories, vectorKnnSearch,
  getMemoriesWithoutEmbedding, updateMemoryEmbedding, addVecsToIndex, close,
  getMemoriesByEntityAttr, db,
  storeEdge, getEdgesFromMemory, getEdgesToMemory, getEdgesByRel, invalidateEdgeById, getEdge, traverseMemoryGraph,
  upsertCoreBlock, getCoreBlock, getAllCoreBlocks, deleteCoreBlock,
  logCitation, getRecentCitationCount, getSessionCitations,
  compressMemory, getRawText, getCompressibleMemories,
 upsertEntity, getEntity, listEntities, touchEntity,
 addFacet, getFacets, addFacetPoint, getFacetPoints,
 linkMemoryToEntity, getMemoriesForEntity, getEntitiesForMemory,
} from './memory-store.mjs';
import { analyzeBeforeCompress, getAdvice, analyzeSessionEnd, getRLMStatus, shutdownRLM } from './advisor-engine.mjs';
import { searchWeb, formatSearchResults } from './ddg-search.mjs';
import { checkServoFetchLiveness, crawlDomain } from './web-fetch.mjs';
import { triggerResearch, getRecentResearch, getResearchStatus } from './research-engine.mjs';
import { runMaintenance, startMaintenanceCron, stopMaintenanceCron } from './memory-maintenance.mjs';
import { onMemoryStored, runPipeline, getPipelineStatus } from './memory-pipeline.mjs';
import { bundleSearch } from './bundle-search.mjs';
import { storeProcedure, getProcedure, listAllProcedures, searchProcedures, deleteProcedureById, touchProcedureUse } from './memory-store.mjs';

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN || true, // Allow all origins in dev; set CORS_ORIGIN for prod
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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
const RATE_LIMIT_MAX_BUCKETS = 10_000;
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS * 2;
  for (const [ip, bucket] of rateLimitBuckets) {
    if (bucket.start < cutoff) rateLimitBuckets.delete(ip);
  }
  // Evict oldest entries if map exceeds max size
  if (rateLimitBuckets.size > RATE_LIMIT_MAX_BUCKETS) {
    const entries = [...rateLimitBuckets.entries()].sort((a, b) => a[1].start - b[1].start);
    const toRemove = rateLimitBuckets.size - RATE_LIMIT_MAX_BUCKETS;
    for (let i = 0; i < toRemove; i++) rateLimitBuckets.delete(entries[i][0]);
  }
}, 120_000);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    if (process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL)) {
      console.log(`[${level}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

app.use(rateLimiter);

// Optional API key authentication — enable by setting MEMORY_API_KEY env var
const MEMORY_API_KEY = process.env.MEMORY_API_KEY || '';
if (MEMORY_API_KEY) {
  const EXEMPT_PATHS = ['/health', '/ready'];
  app.use((req, res, next) => {
    if (EXEMPT_PATHS.some(p => req.path === p)) return next();
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : req.query.api_key || '';
    if (token !== MEMORY_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
    }
    next();
  });
  LOG_DEBUG && console.log('API key authentication: ENABLED');
}

const PORT = process.env.MEMORY_PORT || 3001;
const ENABLE_EMBEDDING = process.env.ENABLE_EMBEDDING !== 'false';
const ENABLE_ADVISOR = process.env.ENABLE_ADVISOR !== 'false' && process.env.BRAIN2_ENABLED !== '0';
const ENABLE_MAINTENANCE = process.env.ENABLE_MAINTENANCE !== 'false';
const ENABLE_RESEARCH = process.env.ENABLE_RESEARCH !== 'false' && process.env.BRAIN2_ENABLED !== '0';
const DECAY_HALF_LIFE_DAYS = parseFloat(process.env.MEMORY_DECAY_HALF_LIFE || '30');

// Weibull decay: w = exp(-(age/eta)^k) — steeper initial drop then long tail
// eta = scale (days), k = shape (1=exponential, >1=accelerating aging, <1=rapid then slow)
const DECAY_BY_TYPE = {
  profile:   { eta: Infinity, k: 1 },
  preference:{ eta: 180, k: 1.2 },
  setup:     { eta: 120, k: 1.3 },
  project:   { eta: 60,  k: 1.4 },
  goal:      { eta: 45,  k: 1.5 },
  fact:      { eta: 30,  k: 1.0 },
  learning:  { eta: 45,  k: 1.1 },
  pattern:   { eta: 60,  k: 1.2 },
  entity:    { eta: 90,  k: 1.1 },
  issue:     { eta: 14,  k: 2.0 },
  event:     { eta: 7,   k: 2.5 },
  request:   { eta: 3,   k: 3.0 },
  general:   { eta: 30,  k: 1.0 },
};

// Get effective Weibull parameters with importance + recall + use-count adjustments
function getDecayParams(type, importance, recallCount, useCount) {
  const base = DECAY_BY_TYPE[type] || DECAY_BY_TYPE.general;
  if (base.eta === Infinity) return { eta: Infinity, k: 1 };
  // SRS: each recall extends effective eta by 30%
  const recallMod = 1 + 0.3 * (recallCount || 0);
  // Feedback loop: memories that were actually used (not just retrieved) get 50% more extension per use
  const useMod = 1 + 0.5 * (useCount || 0);
  const importanceMod = 0.5 + (importance || 0.5); // 0.5-1.5x multiplier
  // Cap total extension at 10x base eta to prevent unbounded growth
  const totalMod = Math.min(importanceMod * recallMod * useMod, 10);
  return { eta: base.eta * totalMod, k: base.k };
}

// ─── Startup ─────────────────────────────────────────────────────
let startupComplete = false;
const serverStartTime = Date.now();

async function startup() {
  // Start maintenance immediately — doesn't need embedding
  if (ENABLE_MAINTENANCE) startMaintenanceCron();
  startupComplete = true;
  LOG_DEBUG && console.log('Memory server ready (FTS search available)');

  // Load embedding engine in background — server already functional with FTS-only
  if (ENABLE_EMBEDDING) {
  initEmbeddingEngine().then(() => {
    if (isEmbeddingReady()) {
      embed('warmup').then(() => {
        if (LOG_DEBUG) console.log('Brain-1 warmed up');
        // Backfill memories stored before embedding was ready
        const missing = getMemoriesWithoutEmbedding(500);
        if (missing.length) {
          LOG_DEBUG && console.log(`[EmbedQueue] Backfilling ${missing.length} memories with missing embeddings`);
          for (const m of missing) enqueueEmbedding(m.id, m.text, m.context_prefix);
        }
      })
      .catch(err => LOG_DEBUG && console.error('Brain-1 warm-up failed:', err.message));
    }
    }).catch(err => {
      LOG_DEBUG && console.error('Brain-1 startup error:', err.message);
    });
  }
}

startup().catch(err => {
  console.error('Startup error:', err);
  startupComplete = true; // Allow server to function without embeddings
});


// ─── Background Embedding Queue ────────────────────────────────────
// Queues memories for async embedding — store/sync return instantly
const _embedQueue = [];
const EMBED_QUEUE_MAX = 1000;
let _embedLock = Promise.resolve(); // C-1: promise-chain mutex replaces boolean flag

function processEmbedQueue() {
  _embedLock = _embedLock.then(async () => {
    while (_embedQueue.length > 0) {
      const batch = _embedQueue.splice(0, 10);
      if (!isEmbeddingReady()) {
        for (const item of batch) {
          item._retries = (item._retries || 0) + 1;
          if (item._retries <= 3) {
            _embedQueue.unshift(item);
          } else {
            LOG_DEBUG && console.warn('[EmbedQueue] Dropping item after 3 retries:', item.id);
          }
        }
        // C-2: keep processing=true (lock held), just wait then retry
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      try {
        const texts = batch.map(item => {
          const prefix = item.contextPrefix ? item.contextPrefix + ' ' : '';
          return prefix + item.text;
        });
        const embeddings = await embedBatch(texts);
        for (let i = 0; i < batch.length; i++) {
          try {
            const vec = new Float32Array(embeddings[i]);
            updateMemoryEmbedding(batch[i].id, vec);
            addVecsToIndex([batch[i].id], [embeddings[i]]);
          } catch {}
        }
      } catch (err) {
        LOG_DEBUG && console.error('[EmbedQueue] Batch error:', err.message);
            // Requeue items on batch failure (max 3 retries)
            for (const item of batch) {
                item._retries = (item._retries || 0) + 1;
                if (item._retries <= 3) {
                    _embedQueue.unshift(item);
                } else {
                    LOG_DEBUG && console.warn('[EmbedQueue] Dropping item after 3 batch failures:', item.id);
                }
            }
            await new Promise(r => setTimeout(r, 2000));
      }
    }
 invalidateQueryCache();
  }).catch(err => {
    LOG_DEBUG && console.error('[EmbedQueue] Queue processor error:', err.message);
  });
}

function enqueueEmbedding(id, text, contextPrefix) {
  if (_embedQueue.length >= EMBED_QUEUE_MAX) {
    LOG_DEBUG && console.warn('[EmbedQueue] Queue full, dropping embedding for', id);
    return false;
  }
  _embedQueue.push({ id, text, contextPrefix });
  processEmbedQueue();
  return true;
}


// ─── Semantic Query Cache (Multi-Tier) ─────────────────────────
// Tier 1: Exact normalized query match — O(1) via hash map
//   Lowercase, strip punctuation, remove stop words, sort words (<=5 words)
//   Catches rephrasings like "user name" → "name of user"
// Tier 2: High-confidence embedding match — cosine >= 0.92
//   Catches semantic paraphrases like "what is the user called" → "user name"
//
// Invalidation: selective — on store, only invalidate entries whose
// entity+attribute overlaps with the new memory. TTL-based expiry
// as fallback. LRU eviction at capacity.
const _queryCache = new Map(); // key → { queryVec, queryNorm, keywords, results, resultIds, timestamp, resultEntities }
const _queryCacheNorm = new Map(); // normalizedQuery → cache key (Tier 1 fast path)
const QUERY_CACHE_MAX = 500;
const QUERY_CACHE_TTL_MS = parseInt(process.env.QUERY_CACHE_TTL_MIN || '120') * 60 * 1000; // 2h default (personal memory is stable)
const QUERY_CACHE_TIER2_THRESHOLD = 0.92; // Tier 2: high-confidence embedding match
let _cacheHits = 0;
let _cacheMisses = 0;
let _cacheTier1Hits = 0;
let _cacheTier2Hits = 0;

// ─── Query Normalization (inline, no import overhead) ──────────────
const _STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'need','to','of','in','for','on','with','at','by','from','as','into','through',
  'during','before','after','above','below','between','out','off','over','under',
  'again','then','once','here','there','when','where','why','how','all','each',
  'every','both','few','more','most','other','some','such','no','nor','not',
  'only','own','same','so','than','too','very','just','because','but','and','or',
  'if','while','about','up','what','which','who','whom','this','that','these',
  'those','i','me','my','myself','we','our','you','your','he','him','his','she',
  'her','it','its','they','them','their','am','get','got','make','made','go',
  'gone','come','came','take','took','see','saw','know','knew','think','thought',
  'say','said','tell','told','give','gave','find','found','want','wanted','like',
  'liked','use','used','work','worked','call','called','try','tried','ask','asked',
  'put','mean','meant','become','became','leave','left','let','keep','kept',
  'begin','began','seem','seemed','help','helped','show','showed','hear','heard',
  'play','played','run','ran','move','moved','live','lived','believe','believed',
  'hold','held','bring','brought','happen','happened','write','wrote','provide',
  'provided','sit','sat','stand','stood','lose','lost','pay','paid','meet','met',
  'include','included','continue','continued','set','learn','learned','change',
  'changed','lead','led','understand','understood','watch','watched','follow',
  'followed','stop','stopped','create','created','speak','spoke','read','allow',
  'allowed','add','added','spend','spent','grow','grew','open','opened','walk',
  'walked','win','won','offer','offered','remember','remembered','consider',
  'considered','appear','appeared','buy','bought','wait','waited','serve',
  'served','die','died','send','sent','expect','expected','build','built','stay',
  'stayed','fall','fell','cut','reach','reached','kill','killed','remain',
  'remained','suggest','suggested','raise','raised','pass','passed','sell','sold',
  'require','required','report','reported','decide','decided','also','well',
  'back','even','still','way','much','many','thing','things',
]);

// Core synonyms — NOT domain-specific (avoid overfitting like ai→key, server→express)
const _SYNONYMS = {
  called:'name', named:'name', username:'name',
  job:'work', employment:'work', employer:'work', works:'work', working:'work', company:'work', office:'work', career:'work', profession:'work',
  mail:'email', 'e-mail':'email', inbox:'email',
  location:'place', city:'place', country:'place',
  cost:'price', expensive:'price', euros:'price', dollars:'price', salary:'price', income:'price', wage:'price',
  pet:'animal', bird:'animal',
  diagnosis:'health', symptom:'health', treatment:'health',
  framework:'project', website:'project', app:'project', application:'project',
  provider:'service', engine:'service', tool:'service',
  speech:'voice', transcription:'voice', transcribe:'voice',
  commute:'travel', subway:'travel', metro:'travel', transport:'travel',
  hobby:'interest', hobbies:'interest', curiosity:'interest',
  studied:'education', school:'education', university:'education', college:'education',
  girlfriend:'partner', boyfriend:'partner', dating:'partner',
  prefer:'preference', prefers:'preference',
  temperature:'weather', forecast:'weather',
  credentials:'key', token:'key',
};

function _extractKeywords(query) {
  const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/);
  const kw = [];
  for (const w of words) {
    if (!_STOP_WORDS.has(w) && w.length > 0) kw.push(_SYNONYMS[w] || w);
  }
  return kw;
}

function _normalizeQuery(query) {
  const words = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/);
  const norm = [];
  for (const w of words) {
    if (!_STOP_WORDS.has(w) && w.length > 0) norm.push(_SYNONYMS[w] || w);
  }
  if (norm.length <= 5) norm.sort();
  return norm.join(' ');
}

function hashVec(vec) {
  if (!vec || vec.length === 0) return 0;
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(vec.length / 32));
  for (let i = 0; i < vec.length; i += step) {
    const q = Math.round(vec[i] * 10000) & 0xFF;
    h ^= q;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function _keywordJaccard(kwA, kwB) {
  if (kwA.length === 0 || kwB.length === 0) return 0;
  const setA = new Set(kwA), setB = new Set(kwB);
  let inter = 0;
  for (const item of setA) { if (setB.has(item)) inter++; }
  return inter / (setA.size + setB.size - inter);
}

function findCachedResult(queryVec, rawQuery) {
  if (!queryVec || !isEmbeddingReady()) return null;
  const now = Date.now();
  const queryNorm = _normalizeQuery(rawQuery);
  const queryKw = _extractKeywords(rawQuery);

  // Tier 1: Exact normalized match — O(1) lookup
  const normKey = _queryCacheNorm.get(queryNorm);
  if (normKey) {
    const entry = _queryCache.get(normKey);
    if (entry && now - entry.timestamp <= QUERY_CACHE_TTL_MS) {
      _cacheHits++; _cacheTier1Hits++;
      return { results: entry.results, similarity: 1.0, tier: 1 };
    }
    if (entry) { // expired
      _queryCache.delete(normKey);
      _queryCacheNorm.delete(entry.queryNorm);
    }
  }

  // Tier 2: High-confidence embedding match (cosine >= 0.92)
  let bestMatch = null, bestSim = 0;
  for (const [key, entry] of _queryCache) {
    if (now - entry.timestamp > QUERY_CACHE_TTL_MS) {
      _queryCache.delete(key);
      _queryCacheNorm.delete(entry.queryNorm);
      continue;
    }
    const embSim = cosineSimilarity(queryVec, entry.queryVec);
    if (embSim >= QUERY_CACHE_TIER2_THRESHOLD && embSim > bestSim) {
      // Keyword guard: reject if zero overlap (unrelated queries with high cosine)
      const kwSim = _keywordJaccard(queryKw, entry.keywords);
      if (kwSim > 0 || queryNorm === entry.queryNorm) {
        bestSim = embSim;
        bestMatch = entry;
      }
    }
  }

  if (bestMatch) {
    _cacheHits++; _cacheTier2Hits++;
    return { results: bestMatch.results, similarity: bestSim, tier: 2 };
  }

  _cacheMisses++;
  return null;
}

function addToQueryCache(queryVec, results, rawQuery) {
  if (!queryVec || results.length === 0) return;
  const queryNorm = _normalizeQuery(rawQuery);
  const keywords = _extractKeywords(rawQuery);
  const resultIds = results.slice(0, 10).map(r => r.id).filter(Boolean);
  const resultEntities = new Set();
  for (const r of results.slice(0, 5)) {
    if (r.entity) resultEntities.add(`${r.entity}::${r.attribute || ''}`);
  }

  if (_queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = _queryCache.keys().next().value;
    const oldEntry = _queryCache.get(oldest);
    if (oldEntry) _queryCacheNorm.delete(oldEntry.queryNorm);
    _queryCache.delete(oldest);
  }

  const key = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  _queryCache.set(key, {
    queryVec: Array.from(queryVec), queryNorm, keywords, results,
    resultIds, timestamp: Date.now(),
    resultEntities: [...resultEntities],
  });
  _queryCacheNorm.set(queryNorm, key);
}

// Selective invalidation: only clear entries whose results could be affected
function invalidateQueryCacheForEntity(entity, attribute) {
  if (!entity) { _queryCache.clear(); _queryCacheNorm.clear(); return; }
  const key = `${entity}::${attribute || ''}`;
  let removed = 0;
  for (const [cacheKey, entry] of _queryCache) {
    if (entry.resultEntities?.some(e => e.startsWith(`${entity}::`))) {
      _queryCache.delete(cacheKey);
      _queryCacheNorm.delete(entry.queryNorm);
      removed++;
    }
  }
  // Also remove any expired entries
  const now = Date.now();
  for (const [cacheKey, entry] of _queryCache) {
    if (now - entry.timestamp > QUERY_CACHE_TTL_MS) {
      _queryCache.delete(cacheKey);
      _queryCacheNorm.delete(entry.queryNorm);
      removed++;
    }
  }
  if (removed > 0) LOG_DEBUG && console.log(`[Cache] Selective invalidation: removed ${removed} entries for ${key}`);
}

// Full invalidation — used only for purge/batch operations
function invalidateQueryCache() {
  _queryCache.clear();
  _queryCacheNorm.clear();
}


// ── Graph Edge Extraction ──────────────────────────────────────────
// Rule-based extraction (works without Brain 2) + LLM-assisted when available

const EDGE_PATTERNS = [
  // "I use/prefer X" → (user, uses/prefers, X memory)
  { re: /(?:i |user )?(?:use|using|prefer|like|love|hate|dislike)\s+(\S.+?)(?:\s+(?:for|when|because|over|instead|than|to|and|$))/i, relation: 'uses' },
  // "I work on X" → (user, works_on, X memory)
  { re: /(?:i |user )?(?:work(?:ing)? on|build(?:ing)?|creat(?:ing)?|develop(?:ing)?)\s+(\S.+?)(?:\s+(?:with|using|for|called|named|and|$))/i, relation: 'works_on' },
  // "X belongs to Y" → (X memory, belongs_to, Y memory)
  { re: /(.+?)\s+(?:belongs to|part of|component of|member of)\s+(.+)/i, relation: 'belongs_to' },
  // "X causes Y" → (X memory, causes, Y memory)
  { re: /(.+?)\s+(?:causes?|leads? to|results? in|triggers?)\s+(.+)/i, relation: 'causes' },
  // "X related to Y" → (X memory, related_to, Y memory)
  { re: /(.+?)\s+(?:is related to|connect(?:ed|s) to|linked to|associated with)\s+(.+)/i, relation: 'related_to' },
];

async function extractAndStoreEdges(fromMemoryId, text, sessionId) {
  try {
    const fromMem = getMemory(fromMemoryId);
    if (!fromMem || !fromMem.entity) return; // Need entity to find related memories

    // Rule-based: extract relations from the text
    for (const pattern of EDGE_PATTERNS) {
      const match = text.match(pattern.re);
      if (match) {
        // S-#46: Use last capture group (for 2-group patterns, match[2] is the object/destination)
      const objectText = (match[match.length - 1] || '').trim().replace(/[.!?,;]+$/, '');
        if (!objectText || objectText.length < 2) continue;

        // Find existing memory matching the object
        const candidates = searchMemories({ query: objectText, limit: 3 });
        if (candidates.length > 0) {
          const toId = candidates[0].id;
          if (toId !== fromMemoryId) {
            storeEdge({
              from_id: fromMemoryId,
              to_id: toId,
              relation: pattern.relation,
              source_session_id: sessionId || '',
            });
          }
        }
      }
    }

    // Entity-based edges: connect memories with same entity
    if (fromMem.entity) {
      const relatedMems = getMemoriesByEntityAttr(fromMem.entity, fromMem.attribute || '');
      for (const rm of relatedMems) {
        if (rm.id !== fromMemoryId) {
          storeEdge({
            from_id: fromMemoryId,
            to_id: rm.id,
            relation: 'same_entity',
            strength: 0.5,
            source_session_id: sessionId || '',
          });
        }
      }
    }

 // v2: Upsert entity into cone graph and link memory
 if (fromMem.entity) {
 const ent = upsertEntity({ canonical_name: fromMem.entity, entity_type: fromMem.type || "generic" });
 if (ent) {
 touchEntity(fromMem.entity);
 linkMemoryToEntity(fromMemoryId, ent.id, "subject");
 }
 }

 // v2: LLM-assisted edge extraction (cost-guarded: importance > 0.6)
 if (ENABLE_ADVISOR && fromMem.importance > 0.6) {
 try {
const recentMems = (getSessionMemories(fromMem.session_id) || []).slice(-8).map(m => `[${m.type}] ${m.text}`).join('\n');
 const llmUrl = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
 const llmModel = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';
 const llmRes = await fetch(llmUrl, {
 method: 'POST',
 headers: {},
 body: JSON.stringify({
 model: llmModel,
 messages: [
 { role: 'system', content: 'Extract relationships between the entity and other entities. Return JSON array: [{"relation":"implements|references|derives_from|clarifies","target":"entity name"}]. Max 3 relations. Empty array if none.' },
{ role: 'user', content: `Entity: ${fromMem.entity}\nContext: ${text.substring(0, 500)}\nRecent memories:\n${recentMems.substring(0, 1000)}` },
 ],
 max_tokens: 256,
 temperature: 0.1,
 }),
 signal: AbortSignal.timeout(15000),
 });
 if (llmRes.ok) {
 const llmData = await llmRes.json();
 const content = llmData.choices?.[0]?.message?.content || '';
 const jsonMatch = content.match(/\[.*\]/s);
 if (jsonMatch) {
 const relations = JSON.parse(jsonMatch[0]);
 for (const rel of relations.slice(0, 3)) {
 if (!rel.relation || !rel.target) continue;
 const cands = searchMemories({ query: rel.target, limit: 2 });
 if (cands.length > 0 && cands[0].id !== fromMemoryId) {
 storeEdge({ from_id: fromMemoryId, to_id: cands[0].id, relation: rel.relation, source_session_id: sessionId || '', confidence: 0.7 });
 }
 }
 }
 }
 } catch (llmErr) {
 LOG_DEBUG && console.error('[EdgeExtract] LLM edge error:', llmErr.message);
 }
 }
  } catch (err) {
    LOG_DEBUG && console.error('[EdgeExtract] Error:', err.message);
  }
}


// ── Rule-based text compression ───────────────────────────────────
// Level 0 = raw, Level 1 = key phrases, Level 2 = one-line, Level 3 = keyword
function ruleBasedCompress(text, targetLevel) {
  if (targetLevel <= 0) return text;
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length === 0) return text;

  if (targetLevel === 1) {
    // Level 1: Keep first 2 sentences, drop filler words
    const kept = sentences.slice(0, 2).map(s => {
      return s.replace(/\b(basically|actually|honestly|literally|just|really|very|quite)\b/gi, '').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    return kept.join('. ') + '.';
  }

  if (targetLevel === 2) {
    // Level 2: One-line summary — first sentence, trimmed
    const first = sentences[0].replace(/\b(basically|actually|honestly|literally|just|really|very|quite)\b/gi, '').replace(/\s+/g, ' ').trim();
    return first.length > 100 ? first.substring(0, 97) + '...' : first + '.';
  }

  if (targetLevel >= 3) {
    // Level 3: Keywords only — extract nouns/verbs
    const words = text.split(/\s+/)
      .filter(w => w.length > 3 && !/^(the|this|that|with|from|have|been|will|would|could|should|about|which|their|there|other|some|than|into|also|just|more|most|only|very|when|what|your|they|were|being|does|done|made|many|much|such|then|them|these|those|each|over|also|after|before|between|both|under|again|further|once|here|there|where|why|how|all|any|both|each|few|more|most|other|some|such|than|too|very)$/i.test(w))
      .slice(0, 8);
    return words.join(' ');
  }

  return text;
}

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const stats = getMemoryStats();
  let llmOk = false;
  try {
    const r = await fetch(`${process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000'}/v1/models`, { signal: AbortSignal.timeout(2000) });
    llmOk = r.ok;
  } catch {}
  res.json({
    ok: true,
    version: '2.1.0',
    uptime_seconds: Math.round((Date.now() - serverStartTime) / 1000),
    embedding: isEmbeddingReady(),
    embedding_error: getEmbeddingError()?.message || null,
    vector_index: isVecReady(),
  turbovec: isTurboVecHealthy(),
  vector_backend: getVectorBackend(),
    advisor: ENABLE_ADVISOR,
      core_memory_blocks: getAllCoreBlocks().length,
      query_cache: { size: _queryCache.size, max: QUERY_CACHE_MAX, ttl_ms: QUERY_CACHE_TTL_MS, hits: _cacheHits, misses: _cacheMisses, tier1_hits: _cacheTier1Hits, tier2_hits: _cacheTier2Hits, hit_rate: _cacheHits + _cacheMisses > 0 ? Math.round(_cacheHits / (_cacheHits + _cacheMisses) * 100) : 0 },
    llm: llmOk,
    maintenance: ENABLE_MAINTENANCE,
    research: ENABLE_RESEARCH,
    mode: 'hybrid',
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

// Weibull decay scoring: w = exp(-(age/eta)^k)
// Type-specific (eta, k) params with importance + recall adjustments
// Formula: final_score = similarity * (0.4 + 0.25 * recency_weight + 0.2 * importance + 0.15 * reinforcement)
// reinforcement = 1 - e^(-recall_count / 3) — spaced repetition asymptote
function applyRecencyScore(results) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  return results.map(r => {
    const ts = r.created_at ? new Date(r.created_at).getTime() : now;
    const createdAt = Number.isFinite(ts) ? ts : 0; // 0 = oldest, not newest, for invalid dates
    const ageMs = Math.max(0, now - createdAt);
    const ageDays = ageMs / dayMs;
    const recallCount = r.recall_count ?? 0;
    const importance = r.importance ?? 0.5;
    const type = r.type || 'general';
    const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : (r.metadata || {});
      const useCount = meta.use_count ?? 0;
      const { eta, k } = getDecayParams(type, importance, recallCount, useCount);
    if (eta === Infinity) {
      // Profile/identity memories never decay
      const reinforcement = 1 - Math.exp(-recallCount / 3);
      const boosted = r.score * (0.4 + 0.25 + 0.2 * importance + 0.15 * reinforcement);
      return { ...r, score: Math.round(boosted * 1000) / 1000 };
    }
    if (!Number.isFinite(eta) || eta <= 0) {
      return { ...r, score: r.score };
    }
    // Weibull decay: exp(-(age/eta)^k)
    const recencyWeight = Math.exp(-Math.pow(ageDays / eta, k));
    const reinforcement = 1 - Math.exp(-recallCount / 3);
    const boosted = r.score * (0.4 + 0.25 * recencyWeight + 0.2 * importance + 0.15 * reinforcement);
    return { ...r, score: Math.round(boosted * 1000) / 1000 };
  });
}

// Query intent classifier for adaptive search weighting
// Returns { fts_weight, vec_weight } based on query characteristics
// Exact identifiers → high FTS weight; conceptual/vague → high vector weight
function classifyQueryIntent(query) {
  const q = query.trim();
  // Identifier-like queries: exact names, paths, code tokens, camelCase, snake_case
  const isIdentifier = /^[a-z_][a-z0-9_]*(?:[A-Z][a-z0-9_]*)+$/.test(q) // camelCase
    || /^[a-z][a-z0-9_]+_[a-z0-9_]+$/.test(q) // snake_case
    || /^[\w.\/-]+\.(py|js|ts|tsx|jsx|mjs|yaml|json|md)$/.test(q) // file paths
    || /^(def |class |function |import |from |const |let |var )/.test(q) // code keywords
    || /^[\w.-]+@[\w.-]+$/.test(q) // emails
    || /^[0-9a-f]{8,}$/i.test(q); // hex IDs
  if (isIdentifier) return { fts_weight: 0.85, vec_weight: 0.15, intent: 'identifier' };

  // Exact match signals: quoted strings, specific names, technical terms
  const hasExactSignals = /["'`]/.test(q) // quoted strings
    || /(GET|POST|PUT|DELETE|PATCH|API|URL|HTTP|CSS|HTML|SQL|JSON|YAML)/i.test(q)
    || /(error|exception|stack|trace|debug|crash|fail|broken)/i.test(q)
    || /(fix|bug|issue|ticket|PR|commit|merge|branch)/i.test(q);
  if (hasExactSignals) return { fts_weight: 0.7, vec_weight: 0.3, intent: 'exact' };

  // Conceptual/vague queries: preferences, opinions, concepts, short natural language
  const isConceptual = q.split(/\s+/).length <= 3 // very short
    || /(prefer|like|love|hate|dislike|opinion|think|feel|want|need|should|better|best)/i.test(q)
    || /(what|how|why|when|where|who|which)/i.test(q)
    || /(similar|like|related|about|regarding|concerning)/i.test(q);
  if (isConceptual) return { fts_weight: 0.3, vec_weight: 0.7, intent: 'conceptual' };

  // Mixed intent: default balanced with slight FTS edge
  return { fts_weight: 0.55, vec_weight: 0.45, intent: 'mixed' };
}

// Reciprocal Rank Fusion: merge multiple ranked lists by position
// Supports weighted RRF: each list can have a weight multiplier
// RRF score = sum(weight / (k + rank)) across all lists. k=60 is standard.
function reciprocalRankFusion(lists, k = 60, weights = null) {
  const scores = new Map(); // id -> { rrf_score, data }
  for (let li = 0; li < lists.length; li++) {
    const listW = weights ? (weights[li] ?? 1.0) : 1.0;
    lists[li].forEach((item, rank) => {
      const id = item.id;
      const existing = scores.get(id);
      const contribution = listW / (k + rank + 1); // 0-indexed rank
      if (existing) {
        existing.rrf_score += contribution;
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

const VALID_TYPES = ['general', 'fact', 'preference', 'profile', 'project', 'goal', 'pattern', 'entity', 'event', 'issue', 'setup', 'learning', 'request', 'reflection', 'summary'];

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

    // Store immediately without waiting for embedding (non-blocking)
    const id = storeMemory({
      session_id: session_id || '',
      type: catType,
      text: trimmed,
      embedding: null, // embedded in background
      metadata: { ...(metadata || {}), source: metadata?.source || "api", extraction_method: metadata?.extraction_method || "store_api", origin_session_id: session_id || "", stored_at: new Date().toISOString() },
      importance: estimateImportance(trimmed, catType),
      context_prefix: contextPrefix,
      entity,
 attribute,
 summary: ruleBasedCompress(trimmed, 2),
    });

  // Queue background embedding
  const enqueued = enqueueEmbedding(id, trimmed, contextPrefix);

	// v2: Wire graph edge extraction
 await extractAndStoreEdges(id, trimmed, session_id);
  onMemoryStored(session_id || 'default');

	invalidateQueryCacheForEntity(entity, attribute);
  res.json({ ok: true, id, embedding: enqueued ? 'queued' : 'dropped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/store-batch', (req, res) => {
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

    // Store immediately without waiting for embedding
    const items = enrichedMemories.map(m => ({
      session_id: m.session_id || '',
      type: m.catType,
      text: m.trimmed,
      embedding: null, // embedded in background
      metadata: { ...(m.metadata || {}), source: m.metadata?.source || "api", extraction_method: m.metadata?.extraction_method || "store_batch_api" },
      importance: estimateImportance(m.trimmed, m.catType),
      context_prefix: m.contextPrefix,
      entity: m.entity,
      attribute: m.attribute,
    }));

    const ids = storeMemories(items);

  // Queue background embedding for all stored memories
  let embedDropped = 0;
  for (let i = 0; i < ids.length; i++) {
    if (!enqueueEmbedding(ids[i], items[i].text, items[i].context_prefix)) embedDropped++;
  }

  res.json({ ok: true, ids, embedding: embedDropped ? 'partial' : 'queued', dropped: embedDropped || undefined });
    for (const item of items) { if (item.entity) invalidateQueryCacheForEntity(item.entity, item.attribute); }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// v2: Code-aware reranking signals (from Semble research)
function applyCodeRerank(results, query, intent) {
	if (!results || results.length === 0) return results;
	const intentType = intent?.intent || 'mixed';

	return results.map(r => {
		let multiplier = 1.0;

		// (1) Definition boost: setup memories rank higher for identifier queries
		if (intentType === 'identifier' && r.type === 'setup') multiplier *= 1.5;

		// (2) Entity coherence boost: results matching query entity get a boost
		if (r.entity && query.toLowerCase().includes(r.entity.toLowerCase())) multiplier *= 1.3;

		// (3) Noise penalty: ephemeral types rank lower for exact/identifier queries
		if ((intentType === 'exact' || intentType === 'identifier') &&
			(r.type === 'request' || r.type === 'event')) multiplier *= 0.3;

		// (4) File saturation decay (applied below per-entity)

		return { ...r, score: Math.round((r.score || 0) * multiplier * 1000) / 1000 };
	}).sort((a, b) => b.score - a.score);
}

// v2: Apply entity saturation decay — reduce score for Nth result with same entity
function applyEntitySaturationDecay(results, decayFactor = 0.5) {
	const entityCounts = new Map();
	return results.map(r => {
		const ent = r.entity || '';
		if (!ent) return r;
		const count = (entityCounts.get(ent) || 0) + 1;
		entityCounts.set(ent, count);
		if (count <= 2) return r; // First 2 results per entity are fine
		const decay = Math.pow(decayFactor, count - 2);
		return { ...r, score: Math.round((r.score || 0) * decay * 1000) / 1000 };
	}).sort((a, b) => b.score - a.score);
}

app.get("/memory/search", async (req, res) => {
  let searchResults = [];
  let queryVecForCache = null;
  try {
    const { q, session_id, limit, method, expand } = req.query;
    if (!q?.trim()) return res.status(400).json({ error: "query required" });
    if (q.length > 1000) return res.status(400).json({ error: "query too long (max 1000 chars)" });
    const limitNum = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
    let searchMethod = "fts";
    const isShortQuery = expand === "true" && q.trim().split(/\s+/).length < 6;

    // Multi-query expansion for vague queries
    let queries = [q.trim()];
    if (isShortQuery && ENABLE_ADVISOR) {
      try {
        const expQ = q.trim().replace(/"/g, "");
        const prompt = "Generate 2 alternative ways to phrase this search query for a personal memory store. Return ONLY a JSON array of 2 strings. Query: " + expQ;
        const expandRes = await fetch(process.env.LLM_URL || process.env.GEMMA_URL || "http://127.0.0.1:8000/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: process.env.LLM_MODEL || process.env.GEMMA_MODEL || "qwen3.6-plus-no-thinking", messages: [{ role: "user", content: prompt }], max_tokens: 100, temperature: 0.3 }),
          signal: AbortSignal.timeout(1500),
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
          if (queryVecs.length === 1) queryVecForCache = qVec;

      // C-3: Skip cache for multi-query — cached single-query results would discard expansion
      const cached = queryVecs.length === 1 && findCachedResult(qVec, q.trim());
      if (cached) {
        searchResults = cached.results.slice(0, limitNum);
        searchMethod = "cache_t" + cached.tier + "+" + (cached.similarity).toFixed(3);
            // Cached results are final — skip live search
  try {
    const ids = searchResults.map(r => r.id).filter(Boolean);
    if (ids.length) incrementRecallCounts(ids);
  } catch {}
            return res.json({ ok: true, method: searchMethod, results: searchResults });
      }

 // v2: Entity+attribute direct lookup — skip vector search for structured queries
 const { entity: qEntity, attribute: qAttribute } = extractEntityAttribute(q.trim());
 if (qEntity && qAttribute) {
 const directHits = applyRecencyScore(getMemoriesByEntityAttr(qEntity, qAttribute));
 if (directHits.length > 0) {
 searchMethod = "entity_direct";
 searchResults = directHits.slice(0, limitNum);
 try { incrementRecallCounts(searchResults.map(r => r.id).filter(Boolean)); } catch {}
 return res.json({ ok: true, method: searchMethod, results: searchResults });
 }
 }

        let embeddingResults = null;

 // v2: Single-pass RRF — collect all variant lists first, merge once
 const intent = classifyQueryIntent(q);
 const allLists = [];
 const allWeights = [];

 // Collect embedding variant results
 for (const vec of queryVecs) {
 let hits = null;
 const knnHits = vectorKnnSearch(vec, limitNum * 3);
 if (knnHits && knnHits.length > 0) { hits = applyRecencyScore(knnHits); }
 else {
 const cands = searchByEmbedding(vec, getAllActiveMemories(), limitNum * 3, intent.intent);
 hits = applyRecencyScore(mmrRerank(vec, cands, limitNum * 2, 0.7));
 }
 if (hits && hits.length > 0) {
 allLists.push(hits);
 allWeights.push(intent.vec_weight);
 }
 }

 if (embeddingResults === null && allLists.length > 0) {
 embeddingResults = allLists.length > 1 ? reciprocalRankFusion(allLists) : allLists[0];
 }
 if (queryVecs.length > 1) searchMethod = "multi-query";

 if (embeddingResults && embeddingResults.length > 0 && method === "embedding") {
 searchResults = embeddingResults.slice(0, limitNum);
 searchMethod = "embedding";
 } else if ((method === "hybrid" || !method) && allLists.length > 0) {
 // Collect FTS variant results and add to single-pass RRF
 for (const qq of queries) {
 const ftsHits = applyRecencyScore(normalizeFtsScore(searchMemories({ query: qq, limit: limitNum * 3 })));
 if (ftsHits && ftsHits.length > 0) {
 allLists.push(ftsHits);
 allWeights.push(intent.fts_weight);
 }
 }
 searchResults = reciprocalRankFusion(allLists, 60, allWeights).slice(0, limitNum);
 searchMethod = "hybrid+" + intent.intent + (queries.length > 1 ? "+expanded" : "");
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

    // v2: Apply code-aware reranking + entity saturation decay
if (searchResults.length > 0) {
	const intent = classifyQueryIntent(q);
	searchResults = applyCodeRerank(searchResults, q, intent);
	searchResults = applyEntitySaturationDecay(searchResults);
	searchResults = searchResults.slice(0, limitNum);
}

// Apply session filter to all search methods
    if (session_id) searchResults = searchResults.filter(r => r.session_id === session_id);

    // Store in semantic cache if we got results from embedding search
    if (queryVecForCache && searchResults.length > 0 && !searchMethod.startsWith("cache")) {
      addToQueryCache(queryVecForCache, searchResults, q.trim());
    }


// Track recall counts for returned results
try {
  const ids = searchResults.map(r => r.id).filter(Boolean);
  if (ids.length) incrementRecallCounts(ids);
} catch {}

// ── Associative retrieval: surface related memories via entity index ──
// Post-retrieval enrichment: for top-3 results with entity data,
// look up other active memories sharing the same entity.
// Lightweight — uses existing SQLite index, no graph DB needed.
let associativeResults = [];
try {
  const topEntities = new Map();
  for (const r of searchResults.slice(0, 3)) {
    if (r.entity) topEntities.set(`${r.entity}::${r.attribute || ''}`, r.entity);
  }
  if (topEntities.size > 0) {
    const mainIds = new Set(searchResults.map(r => r.id));
    for (const [key, entity] of topEntities) {
      const related = getMemoriesByEntityAttr(entity, key.split('::')[1] || '');
      for (const rm of related) {
        if (rm.status === 'active' && !mainIds.has(rm.id) && !associativeResults.some(a => a.id === rm.id)) {
          associativeResults.push({ ...rm, _associative: true, _via_entity: entity });
        }
      }
    }
    associativeResults = associativeResults.slice(0, 10);
		// Re-rank against original query to prevent topic drift
		if (associativeResults.length > 0 && queryVecForCache) {
			associativeResults = associativeResults
				.map(r => {
					const sim = r.embedding ? cosineSimilarity(queryVecForCache, r.embedding) : 1;
					return { ...r, _assoc_sim: sim };
				})
				.filter(r => r._assoc_sim >= 0.75)
				.sort((a, b) => b._assoc_sim - a._assoc_sim)
				.slice(0, 5);
		}
  }
} catch (err) {
  LOG_DEBUG && console.error('[Associative] Entity lookup error:', err.message);
}

res.json({
  ok: true,
  method: searchMethod,
  queries: queries.length > 1 ? queries : undefined,
  results: searchResults,
  related: associativeResults.length > 0 ? associativeResults : undefined,
});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Search feedback loop: Hermes reports which memory IDs actually influenced its response
// This gives a stronger importance boost (+0.03) vs mere retrieval (+0.01)
app.post('/memory/bundle-search', async (req, res) => {
  try {
    const { query, limit } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'query required' });
    if (!isEmbeddingReady()) return res.status(503).json({ error: 'Brain-1 not ready' });
    const results = await bundleSearch(query, parseInt(limit) || 5);
    res.json({ ok: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/search/feedback', (req, res) => {
  try {
    const { memory_ids, session_id, context } = req.body;
    if (!Array.isArray(memory_ids) || !memory_ids.length) {
      return res.status(400).json({ error: 'memory_ids array required' });
    }
    const ids = memory_ids.map(id => parseInt(id)).filter(id => id > 0).slice(0, 50);
    if (!ids.length) return res.status(400).json({ error: 'no valid memory IDs' });
    const boosted = boostUsedMemories(ids);
    // Log citations for reflection tracking
    for (const id of ids) {
      logCitation(id, session_id || '', context || '');
    }
    res.json({ ok: true, boosted });
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

    let memories = getAllActiveMemoriesNoEmbed();
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

    const coreBlocks = getAllCoreBlocks();
res.json({
ok: true,
memories: lines.length,
total_candidates: scored.length,
token_budget: tokenBudget,
text: lines.join('\n'),
core_blocks: coreBlocks,
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
    res.json({ results: all.slice(offsetNum, offsetNum + limitNum), total: getSessionMemoryCount(req.params.sessionId) }); // S-#54
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/type/:type', (req, res) => {
  try {
    const { limit, offset } = req.query;
    const limitNum = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
    const offsetNum = Math.max(parseInt(offset) || 0, 0);
    const all = getMemoriesByType(req.params.type, limitNum + offsetNum);
    res.json({ results: all.slice(offsetNum, offsetNum + limitNum), total: getTypeMemoryCount(req.params.type) }); // S-#54
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

app.post('/memory/graph/edge', (req, res) => {
  try {
    const { from_id, to_id, relation, valid_from, valid_until, strength, source_session_id, metadata } = req.body;
    if (!from_id || !to_id || !relation) {
      return res.status(400).json({ error: 'from_id, to_id, and relation are required' });
    }
    const fromMem = getMemory(from_id);
    const toMem = getMemory(to_id);
    if (!fromMem) return res.status(404).json({ error: `memory ${from_id} not found` });
    if (!toMem) return res.status(404).json({ error: `memory ${to_id} not found` });
    const id = storeEdge({ from_id, to_id, relation, valid_from, valid_until, strength: strength ?? 1.0, source_session_id: source_session_id || '', metadata: metadata || {} });
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get edges from a memory (outgoing relationships)
app.get('/memory/graph/neighbors/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const outgoing = getEdgesFromMemory(id);
    const incoming = getEdgesToMemory(id);
    res.json({ ok: true, id, outgoing, incoming });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Multi-hop graph traversal from a starting memory
app.get('/memory/graph/traverse', (req, res) => {
  try {
    const fromId = parseInt(req.query.from_id);
    const maxDepth = Math.min(parseInt(req.query.max_depth) || 3, 5);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    if (!fromId) return res.status(400).json({ error: 'from_id query parameter required' });
    const steps = traverseMemoryGraph(fromId, maxDepth, limit);
    // Enrich with memory text
    const enriched = steps.map(s => {
      const mem = getMemory(s.to_id);
      return {
        from_id: s.from_id,
        to_id: s.to_id,
        to_text: mem ? mem.text : null,
        to_type: mem ? mem.type : null,
        relation: s.relation,
        strength: Math.round(s.strength * 1000) / 1000,
        depth: s.depth,
      };
    });
    res.json({ ok: true, from_id: fromId, max_depth: maxDepth, steps: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get edges by relation type
app.get('/memory/graph/edges', (req, res) => {
try {
const { relation, limit } = req.query;
const limitNum = parseInt(limit) || 50;
let edges;
if (relation) {
edges = getEdgesByRel(relation, limitNum);
} else {
// No relation filter: return recent edges
const rows = db.prepare('SELECT id FROM memory_edges ORDER BY created_at DESC LIMIT ?').all(limitNum);
edges = rows.map(r => getEdge(r.id)).filter(Boolean);
}
res.json({ ok: true, edges });
} catch (err) { res.status(500).json({ error: err.message }); }
});

// Invalidate an edge (set valid_until = now)
app.post('/memory/graph/edge/:id/invalidate', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const edge = getEdge(id);
    if (!edge) return res.status(404).json({ error: 'edge not found' });
    const changes = invalidateEdgeById(id);
    res.json({ ok: true, invalidated: changes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Core Memory ──────────────────────────────────────────────────

// List all core memory blocks
app.get('/memory/core', (_req, res) => {
  try {
    const blocks = getAllCoreBlocks();
    res.json({ ok: true, blocks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upsert a core memory block
app.put('/memory/core/:key', (req, res) => {
  try {
    const { key } = req.params;
    const { value, description, char_limit } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    const block = upsertCoreBlock({ key, value, description: description || '', char_limit: char_limit || 500 });
    res.json({ ok: true, block });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get a specific core memory block
app.get('/memory/core/:key', (req, res) => {
  try {
    const block = getCoreBlock(req.params.key);
    if (!block) return res.status(404).json({ error: 'core memory block not found' });
    res.json({ ok: true, block });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a core memory block
app.delete('/memory/core/:key', (req, res) => {
  try {
    const changes = deleteCoreBlock(req.params.key);
    res.json({ ok: true, deleted: changes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Citation Tracking ────────────────────────────────────────────

// Get citation stats for a memory
// ─── Screenshot Endpoint ──────────────────────────────────
app.post('/fetch/screenshot', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    const SERVO_FETCH_URL = process.env.SERVO_FETCH_URL || 'http://127.0.0.1:3002';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const r = await fetch(`${SERVO_FETCH_URL}/v1/screenshot`, {
      method: 'POST',
      headers: {},
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) return res.status(502).json({ error: 'servo-fetch screenshot failed', status: r.status });
    const data = await r.json();
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get('/memory/pipeline/status', (_req, res) => {
  res.json({ ok: true, ...getPipelineStatus() });
});

app.post('/memory/learn', async (req, res) => {
  try {
    const { session_id, memory_ids } = req.body;
    const sessionId = session_id || 'pipeline';
    const targetIds = memory_ids || [];

    // Get the requested memories or recent session memories
    const sourceMems = targetIds.length > 0
      ? targetIds.map(id => getMemory(id)).filter(Boolean)
      : getSessionMemories(sessionId).slice(-15);

    if (sourceMems.length < 3) {
      return res.json({ ok: true, procedure_id: null, message: 'Not enough memories to extract a procedure (minimum 3)' });
    }

    const memText = sourceMems.map(m => `[${m.type}] ${m.text}`).join('\n');

    const LLM_URL = process.env.LLM_URL || process.env.GEMMA_URL || 'http://127.0.0.1:8000/v1/chat/completions';
    const LLM_MODEL = process.env.LLM_MODEL || process.env.GEMMA_MODEL || 'qwen3.6-plus-no-thinking';

    const llmRes = await llmFetch(LLM_URL, {
      method: 'POST',
      headers: {},
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: 'Extract a reusable procedure/workflow from these memories. Return JSON: {"name":"...","description":"...","trigger_context":"when to use this","steps":[{"text":"...","step_type":"action|check|decision","expected_outcome":"..."}],"context_points":[{"context_type":"tool|environment|prerequisite","context_value":"..."}]}. If no clear workflow, return empty steps array.' },
          { role: 'user', content: `Memories:
${memText}

Extract procedure:` },
        ],
        max_tokens: 1024,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!llmRes.ok) return res.status(503).json({ error: 'LLM unavailable' });
    const llmData = await llmRes.json();
    const procContent = llmData?.choices?.[0]?.message?.content || '';
    const jsonMatch = procContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ ok: true, procedure_id: null, message: 'No procedure could be extracted' });

    const procData = JSON.parse(jsonMatch[0]);
    if (!procData.steps?.length) return res.json({ ok: true, procedure_id: null, message: 'No steps extracted' });

    const procId = storeProcedure({
      name: procData.name || 'Unnamed Procedure',
      description: procData.description || '',
      trigger_context: procData.trigger_context || '',
      session_id: sessionId,
      steps: procData.steps || [],
      context_points: procData.context_points || [],
    });

    res.json({ ok: true, procedure_id: procId, name: procData.name, steps: procData.steps?.length || 0 });
  } catch (err) {
  res.status(err.name === "TypeError" ? 503 : 500).json({ error: err.message });
  }
});

app.get('/memory/procedures', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const procedures = listAllProcedures(limit);
    res.json({ ok: true, procedures });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/procedures/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'query "q" required' });
    const results = searchProcedures(q);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/procedures/:id', (req, res) => {
  try {
    const proc = getProcedure(parseInt(req.params.id));
    if (!proc) return res.status(404).json({ error: 'not found' });
    touchProcedureUse(proc.id);
    res.json({ ok: true, ...proc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/memory/procedures/:id', (req, res) => {
  try {
    const changes = deleteProcedureById(parseInt(req.params.id));
    res.json({ ok: true, deleted: changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/pipeline/run', async (_req, res) => {
  try {
    await runPipeline();
    res.json({ ok: true, status: getPipelineStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:id/citations', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const count = getRecentCitationCount(id);
    res.json({ ok: true, memory_id: id, citations_last_30d: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get top-cited memories in a session
app.get('/memory/citations/session/:sessionId', (req, res) => {
  try {
    const { limit } = req.query;
    const citations = getSessionCitations(req.params.sessionId, parseInt(limit) || 20);
    res.json({ ok: true, citations });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Memory Compression ───────────────────────────────────────────

// Get raw text for a compressed memory (drill-down)
app.get('/memory/:id/raw', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const mem = getMemory(id);
    if (!mem) return res.status(404).json({ error: 'not found' });
    if (mem.compression_level === 0) {
      return res.json({ ok: true, text: mem.text, compression_level: 0, raw: mem.text });
    }
    const raw = getRawText(id);
    res.json({ ok: true, text: mem.text, compression_level: mem.compression_level, raw: raw || mem.text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual compression trigger
app.post('/memory/compress', (req, res) => {
try {
const { memory_id, target_level, max_level, older_than_days, limit } = req.body;
// Single-memory compression mode
if (memory_id) {
const id = parseInt(memory_id);
const mem = getMemory(id);
if (!mem) return res.status(404).json({ error: 'memory not found' });
const target = Math.min(parseInt(target_level) || (mem.compression_level + 1), 3);
if (target <= mem.compression_level) return res.json({ ok: true, compressed_text: mem.text, level: mem.compression_level, changed: false });
// Store raw text before first compression
if (mem.compression_level === 0) {
try { db.prepare('INSERT OR IGNORE INTO memory_raw (memory_id, raw_text) VALUES (?, ?)').run(id, mem.text); } catch {}
}
const compressed = ruleBasedCompress(mem.text, target);
compressMemory(id, compressed, target);
return res.json({ ok: true, compressed_text: compressed, original_length: mem.text.length, compressed_length: compressed.length, level: target, changed: compressed !== mem.text });
}
// Batch compression mode
const maxLevel = Math.min(parseInt(max_level) || 1, 3);
const olderDays = parseInt(older_than_days) || 0;
const limitNum = Math.min(parseInt(limit) || 50, 200);
const candidates = getCompressibleMemories(maxLevel, olderDays, limitNum);
let compressed = 0;
for (const m of candidates) {
const newText = ruleBasedCompress(m.text, m.compression_level + 1);
if (newText !== m.text) {
compressMemory(m.id, newText, m.compression_level + 1);
compressed++;
}
}
res.json({ ok: true, candidates: candidates.length, compressed });
} catch (err) { res.status(500).json({ error: err.message }); }
});


app.get('/memory/:id', (req, res, next) => {
 if (!/^\d+$/.test(req.params.id)) return next();
  try {
  const mem = getMemory(parseInt(req.params.id));
  if (!mem) return res.status(404).json({ error: 'not found' });
  res.json(mem);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/memory/:id', (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'not found' });
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
  if (old_id === new_id) return res.status(400).json({ error: 'old_id and new_id must differ' });

    const oldMem = getMemory(old_id);
    if (!oldMem) return res.status(404).json({ error: `memory ${old_id} not found` });

    // H-4: Validate new_id exists before making mutations
  let newMem = getMemory(new_id);
  if (!newMem) return res.status(404).json({ error: `memory ${new_id} not found` });

  // Mark old as superseded by new
updateMemoryStatus(old_id, 'superseded', new_id);

// Bi-temporal: set valid_until on old, valid_from on new
const now = new Date().toISOString();
const setValidUntil = db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?');
setValidUntil.run(now, old_id);
const setValidFrom = db.prepare('UPDATE memories SET valid_from = ? WHERE id = ? AND valid_from IS NULL');
setValidFrom.run(now, new_id);

// Add provenance to new memory metadata
newMem = getMemory(new_id);
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
    const MAX_LINEAGE_DEPTH = 50;
    let depth = 0;
    let current = getMemory(id);
    while (current && depth < MAX_LINEAGE_DEPTH) {
      depth++;
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
    if (depth >= MAX_LINEAGE_DEPTH && current?.superseded_by) {
      lineage.push({ id: current.superseded_by, text: '... (lineage truncated at depth cap)', type: 'truncated', status: 'active' });
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
      memories.push({ session_id, type, text: userText, embedding, metadata: { source: "user", extraction_method: "sync", origin_session_id: session_id, timestamp: now }, importance: estimateImportance(userText, type), context_prefix: userPrefix, entity: userEntity, attribute: userAttr, summary: ruleBasedCompress(userText, 2) });
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
      memories.push({ session_id, type: "fact", text: asstText, embedding, metadata: { source: "assistant", extraction_method: "sync", origin_session_id: session_id, timestamp: now }, importance: estimateImportance(asstText, "fact"), context_prefix: asstPrefix, entity: asstEntity, attribute: asstAttr, summary: ruleBasedCompress(asstText, 2) });
    }

    const ids = memories.length > 0 ? storeMemories(memories) : [];
 res.json({ ok: true, stored: ids.length, ids });
    for (const m of memories) { if (m.entity) invalidateQueryCacheForEntity(m.entity, m.attribute); }

	// v2: Wire graph edge extraction for each stored memory
	for (let i = 0; i < ids.length; i++) {
  await extractAndStoreEdges(ids[i], memories[i].text, session_id);
	}

 // Trigger background research pipeline (non-blocking, async)
 if (ENABLE_ADVISOR && user_message?.trim()) {
   triggerResearch({
     sessionId: session_id || '',
     userMessage: user_message,
     assistantResponse: assistant_response || '',
     storeMemoryFn: storeMemory,
     embedFn: embed,
     isEmbeddingReadyFn: isEmbeddingReady,
   });
 }
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
    const structured = req.query.structured === 'true';
  const analysis = await analyzeBeforeCompress(conversation_history || [], session_memories || [], { structured });
    res.json({ ok: true, mode: 'qwen3', analysis });
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
    const structured = req.query.structured === 'true';
 const advice = await getAdvice({
      userMessage: user_message || '',
      conversationHistory: conversation_history || [],
      activeMemories: active_memories || [],
      currentTaskContext: task_context || '',
    structured,
 });
    res.json({ ok: true, mode: 'qwen3', advice });
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
      return res.status(503).json({ error: 'Brain-1 not ready' });
    }
    const limit = req.body?.limit || 100;
    const missing = getMemoriesWithoutEmbedding(limit);
    if (!missing.length) {
      return res.json({ ok: true, reembedded: 0, message: 'no memories missing embeddings' });
    }

    const texts = missing.map(m => (m.context_prefix ? m.context_prefix + ' ' : '') + m.text);
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

// On-demand dedup check — returns duplicate pairs without marking anything invalid
app.post('/memory/dedup', async (req, res) => {
  try {
    const { threshold, auto_mark } = req.body;
    const DUP_THRESHOLD = parseFloat(threshold || process.env.DUP_THRESHOLD || '0.92');
    const memories = getActiveWithEmbedding();
    const withEmbedding = memories.filter(m => m.embedding);
    if (withEmbedding.length < 2) return res.json({ ok: true, duplicates: [], count: 0, marked_invalid: 0 });

    let dupes = [];
    if (withEmbedding.length < 500 || !vectorKnnSearch) {
      dupes = findDuplicates(withEmbedding);
    } else {
      const seen = new Set();
      for (const m of withEmbedding) {
        if (seen.has(m.id)) continue;
        const neighbors = vectorKnnSearch(m.embedding, 20);
        if (!neighbors) { dupes = findDuplicates(withEmbedding); break; }
        for (const n of neighbors) {
          if (n.id === m.id || seen.has(n.id)) continue;
          if (n.score > DUP_THRESHOLD) {
            const [older, newer] = m.id < n.id ? [m, n] : [n, m];
            dupes.push({ older: { id: older.id, text: older.text, type: older.type, created_at: older.created_at }, newer: { id: newer.id, text: newer.text, type: newer.type, created_at: newer.created_at }, similarity: n.score });
            seen.add(older.id);
          }
        }
      }
    }

    // Filter to only those above the requested threshold
    dupes = dupes.filter(d => d.similarity > DUP_THRESHOLD);

    let marked = 0;
    if (auto_mark && dupes.length > 0) {
      for (const d of dupes) {
        const olderId = d.older?.id || d.a?.id;
        if (olderId) { updateMemoryStatus(olderId, 'invalid'); marked++; }
      }
    }

    res.json({ ok: true, duplicates: dupes, count: dupes.length, threshold: DUP_THRESHOLD, marked_invalid: marked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
  shutdownRLM();
  res.json({ ok: true });
});

// Purge low-importance old memories
const AUTO_PURGE_DAYS = parseInt(process.env.AUTO_PURGE_DAYS || '365');
app.post('/memory/purge', (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Purge requires confirm=true in request body' });
  }
  try {
    const before = getMemoryStats();
    const purgeStmt = db.prepare(
      `DELETE FROM memories WHERE importance < 0.3 AND recall_count = 0 AND created_at < datetime('now', '-' || ? || ' days') AND status = 'active'`
    );
    const result = purgeStmt.run(AUTO_PURGE_DAYS);
    const after = getMemoryStats();
    invalidateQueryCache();
    res.json({ ok: true, purged: result.changes, before: before.active, after: after.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Research ──────────────────────────────────────────────────

app.get('/memory/research/status', (_req, res) => {
  res.json({ ok: true, ...getResearchStatus() });
});

// Research hint injection: compact topic summaries for the Python plugin's prefetch()
// Returns recently researched topics with fact counts so Hermes knows background research
// exists without dumping all facts into context. Hermes calls memory_search if it wants details.
app.get('/memory/research/hints', (req, res) => {
  const sessionId = req.query.session_id || '';
  const topics = getRecentResearch(sessionId);
  // Enrich hints with a short summary extracted from stored research memories
  const enriched = topics.map(t => ({
    topic: t.topic,
    fact_count: t.factCount,
    query: t.query || '',
    age_seconds: Math.round((Date.now() - t.timestamp) / 1000),
  }));
  res.json({ ok: true, topics: enriched });
});


// ─── Knowledge Graph ──────────────────────────────────────────────

// Add a relationship edge between two memories
// ─── Start ────────────────────────────────────────────────────────
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`━━━━ Hermes AI Memory Server v2 ━━━━`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Brain-1: ${ENABLE_EMBEDDING ? (isEmbeddingReady() ? 'Ready' : 'Loading...') : 'DISABLED'}`);
  console.log(`  Vector Index: ${isVecReady() ? 'sqlite-vec KNN' : 'JS cosine fallback'} (backend: ${getVectorBackend()})`)
if (getVectorBackend() !== 'sqlite') {
  checkTurboVecHealth().then(h => console.log(`  TurboVec: ${h.ok ? `alive (${h.count} vectors)` : 'unavailable'}`)).catch(() => {})
};
  console.log(` Brain-2: ${ENABLE_ADVISOR ? 'ON' : 'OFF'}`);
  console.log(`  Web Search: ${ENABLE_ADVISOR && process.env.ADVISOR_WEB_SEARCH !== 'false' ? 'DDG' : 'DISABLED'}`);
  console.log(` Research: ${ENABLE_RESEARCH ? 'Background pipeline (topic -> DDG -> fetch -> extract)' : 'OFF (Brain 1 only)'}`);
  console.log(`  Maintenance: ${ENABLE_MAINTENANCE ? 'ON (5min)' : 'DISABLED'}`);
  console.log(`  Decay: Weibull (type-specific eta/k)`);
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

// Handle uncaught errors gracefully — debounce non-fatal errors like llm-server
const _errorCounts = new Map();
const MAX_ERROR_ENTRIES = 1000;
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
  if (_errorCounts.size >= MAX_ERROR_ENTRIES) {
		const oldest = _errorCounts.keys().next().value;
		_errorCounts.delete(oldest);
	}
	_errorCounts.delete(msg); _errorCounts.set(msg, count); // M-8: re-insert to move to end
  if (count === 1) {
    console.error(`Uncaught exception (non-fatal): ${msg}`);
    _startErrorLogger();
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('Unhandled rejection:', msg);
});
