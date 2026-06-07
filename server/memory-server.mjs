import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import cors from 'cors';
import { initEmbeddingEngine, isEmbeddingReady, getEmbeddingError, embed, embedBatch, searchByEmbedding, mmrRerank, categorizeText, estimateImportance, extractEntityAttribute, generateContextPrefix, findDuplicates, cosineSimilarity } from './embedding-engine.mjs';
let _isShuttingDown = false; // Hoisted: needed by shutdown-aware middleware
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug' || (!process.env.LOG_LEVEL);
const LOG_QUIET = process.env.LOG_LEVEL === 'quiet';

import { isVecReady, checkTurboVecHealth, isTurboVecHealthy, getVectorBackend } from './vector-index.mjs';
import { llmFetch } from './llm-fetch.mjs';
import { LLM_URL, LLM_MODEL, baseLlmUrl } from './llm-config.mjs';
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
import { initModules, entityRanker, spatialFilter, ambientInjector, deltaProcessor, graphPruner, capsuleBuilder, contextCompressor, strategyDistiller, ingestPipeline, compactionCoordinator, lessonVault, declarativeGateway, diagnosticCompiler, crossModalExtractor, multiSourceRouter, getModuleStatus } from './module-registry.mjs';

const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN ? (process.env.CORS_ORIGIN === '*' ? true : process.env.CORS_ORIGIN) : (process.env.NODE_ENV === 'production' ? false : true),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));
// Reject new requests during graceful shutdown (BUG-21: prevent DB ops after close())
app.use((req, res, next) => {
  if (_isShuttingDown) return res.status(503).json({ error: 'Server is shutting down' });
  next();
});
// Trust first proxy only when explicitly enabled — prevents X-Forwarded-For spoofing
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Simple sliding-window rate limiter (in-memory, per-IP)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? '120');
const rateLimitBuckets = new Map();
function rateLimiter(req, res, next) {
  if (RATE_LIMIT_MAX <= 0) return next();
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
  if (!ip) return next(); // Skip rate limiting if no IP identifiable (e.g., Unix domain socket without proxy)
  const now = Date.now();
  // Eagerly evict if at capacity before inserting new entries (BUG-9: prevent unbounded growth)
  if (!rateLimitBuckets.has(ip) && rateLimitBuckets.size >= RATE_LIMIT_MAX_BUCKETS) {
    const entries = [...rateLimitBuckets.entries()].sort((a, b) => a[1].start - b[1].start);
    const toRemove = rateLimitBuckets.size - RATE_LIMIT_MAX_BUCKETS + 1;
    for (let i = 0; i < toRemove; i++) rateLimitBuckets.delete(entries[i][0]);
  }
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
const _rateLimitCleanupInterval = setInterval(() => {
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
}, 120_000).unref();

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
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const tokenHash = createHash("sha256").update(String(token)).digest();
  const keyHash = createHash("sha256").update(String(MEMORY_API_KEY)).digest();
  if (!timingSafeEqual(tokenHash, keyHash)) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing API key" });
  }
    next();
  });
  LOG_DEBUG && console.log('API key authentication: ENABLED');
}

const _EXTRACT_TIMEOUT_RAW = parseInt(process.env.EXTRACT_TIMEOUT_MS ?? '60000');
const EXTRACT_TIMEOUT_MS = Number.isFinite(_EXTRACT_TIMEOUT_RAW) && _EXTRACT_TIMEOUT_RAW >= 1000 ? _EXTRACT_TIMEOUT_RAW : 60000;

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
    while (_embedQueue.length > 0 && !_isShuttingDown) {
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
          } catch (embedErr) { LOG_DEBUG && console.error(`[EmbedQueue] Failed for ${batch[i]?.id}:`, embedErr.message); }
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
const QUERY_CACHE_TTL_MS = parseInt(process.env.QUERY_CACHE_TTL_MIN ?? '120') * 60 * 1000; // 2h default (personal memory is stable)
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
  // Scan only most recent entries to avoid O(n) cost on large caches
  let bestMatch = null, bestSim = 0;
  const recentEntries = [..._queryCache.entries()].slice(-50);
  for (const [key, entry] of recentEntries) {
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
  const keysToDelete = [];
  for (const [cacheKey, entry] of _queryCache) {
    if (entry.resultEntities?.some(e => e.startsWith(`${entity}::`))) {
      keysToDelete.push(cacheKey);
      _queryCacheNorm.delete(entry.queryNorm);
      removed++;
    }
  }
  for (const k of keysToDelete) _queryCache.delete(k);
  // Also remove any expired entries
  const now = Date.now();
  const expiredKeys = [];
  for (const [cacheKey, entry] of _queryCache) {
    if (now - entry.timestamp > QUERY_CACHE_TTL_MS) {
      expiredKeys.push(cacheKey);
      _queryCacheNorm.delete(entry.queryNorm);
      removed++;
    }
  }
  for (const k of expiredKeys) _queryCache.delete(k);
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
 
 
 const llmRes = await llmFetch(LLM_URL, {
 method: 'POST',
 body: JSON.stringify({
 model: LLM_MODEL,
 messages: [
 { role: 'system', content: 'Extract relationships between the entity and other entities. Return JSON array: [{"relation":"implements|references|derives_from|clarifies","target":"entity name"}]. Max 3 relations. Empty array if none.' },
{ role: 'user', content: `Entity: ${fromMem.entity}\nContext: ${text.substring(0, 500)}\nRecent memories:\n${recentMems.substring(0, 1000)}` },
 ],
 max_tokens: 256,
 temperature: 0.1,
 }),
 signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
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
// Cache LLM health status to avoid probing on every /health request
let _llmHealthCache = { ok: false, timestamp: 0 };
const _LLM_HEALTH_TTL_MS = 30_000; // 30 seconds

app.get('/health', async (_req, res) => {
  const stats = getMemoryStats();
  const now = Date.now();
  let llmOk = _llmHealthCache.ok;
  if (now - _llmHealthCache.timestamp > _LLM_HEALTH_TTL_MS) {
    try {
      const r = await llmFetch(`${baseLlmUrl()}/v1/models`, { signal: AbortSignal.timeout(2000) });
      llmOk = r.ok;
    } catch { llmOk = false; }
    _llmHealthCache = { ok: llmOk, timestamp: now };
  }
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
  // Exact match signals: quoted strings, specific names, technical terms
  // Require at least 2 technical-code terms OR quoted string to reduce false positives
  const httpMethodMatch = q.match(/(GET|POST|PUT|DELETE|PATCH|API|URL|HTTP|CSS|HTML|SQL|JSON|YAML)/gi);
  const codeTermMatch = q.match(/(error|exception|stack|trace|debug|crash|fail|broken)/gi);
  const devTermMatch = q.match(/(fix|bug|issue|ticket|PR|commit|merge|branch)/gi);
  const techCount = (httpMethodMatch?.length || 0) + (codeTermMatch?.length || 0) + (devTermMatch?.length || 0);
  const hasExactSignals = /["`']/.test(q) // quoted strings
    || techCount >= 2 // Multiple technical terms = strong signal
    || ((httpMethodMatch?.length || 0) >= 1 && /[/.]/.test(q)) // HTTP method near path-like chars
    || ((devTermMatch?.length || 0) >= 1 && /(https?:|git|repo|code|build|test|deploy)/i.test(q)); // Dev term + dev context

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

    // v2.1: Storage-time structural dedup (MemPalace pattern)
 try { const _dup = spatialFilter.checkStorageTimeDuplicate(trimmed, entity, attribute); if (_dup) return res.json({ ok: true, id: _dup.id, embedding: 'duplicate', duplicate_of: _dup.id }); } catch {}
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
  onMemoryStored(session_id || '');
	// v2.1: Track session activity for ambient injection (Lemma pattern)
	try { if (session_id) ambientInjector.trackSessionActivity(session_id); } catch {}

	invalidateQueryCacheForEntity(entity, attribute);
	// v2.1: Touch entity recency (Memary pattern)
	try { if (entity) entityRanker.touchEntityWithRecency(entity); } catch {}
	// v2.2: Upsert entity with recency tracking
	try { if (entity) entityRanker.upsertEntityWithRecency({ name: entity, type: catType }); } catch {}
	// v2.2: Record version history (capsule builder)
	try { capsuleBuilder.recordVersion(db, id, 'create'); } catch {}
	// v2.2: Post-store capsule hooks
	try { capsuleBuilder.onMemoryStored(db, id, trimmed, entity, attribute); } catch {}
	// v2.2: Track L0 hash for pipeline
	try { if (session_id) ingestPipeline.computeL0Hash(session_id); } catch {}
	// v2.2: Invalidate ambient injection cache on new memory
	try { ambientInjector.invalidateInjectionCache(); } catch {}
	// v2.2: Classify content type for compression patterns
	try { contextCompressor.classifyContentType(trimmed); } catch {}
	// v2.2: Validate write quality (lesson vault)
	try { lessonVault.validateWrite(trimmed, catType, entity); } catch {}
  res.json({ ok: true, id, embedding: enqueued ? 'queued' : 'dropped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/memory/store-batch', (req, res) => {
  try {
    const { memories } = req.body;
    if (!memories?.length) return res.status(400).json({ error: 'memories array required' });
    if (memories.length > 100) return res.status(400).json({ error: 'batch too large (max 100)' });

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
	// v2.2: Batch store hooks
	try { for (const item of items) { if (item.entity) { entityRanker.upsertEntityWithRecency({ name: item.entity, type: item.type }); entityRanker.touchEntityWithRecency(item.entity); } } } catch {}
	try { for (let i = 0; i < ids.length; i++) { capsuleBuilder.recordVersion(db, ids[i], 'create'); capsuleBuilder.onMemoryStored(db, ids[i], items[i].text, items[i].entity, items[i].attribute); } } catch {}
	try { ambientInjector.invalidateInjectionCache(); } catch {}

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
        const expandRes = await llmFetch(LLM_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 100, temperature: 0.3 }),
          signal: AbortSignal.timeout(1500),
        });
        if (expandRes.ok) {
          const expandData = await expandRes.json();
          const content = expandData.choices?.[0]?.message?.content || "";
          const match = content.match(/\[.*?\]/s);
        if (match && match[0].length <= 500) {
          try {
            const alternates = JSON.parse(match[0]);
            if (Array.isArray(alternates)) queries = [q.trim(), ...alternates.slice(0, 2)];
          } catch { /* malformed LLM JSON — skip expansion */ }
      }
      }
    } catch { /* expansion is optional */ }
  }

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

 // v2.1: Structural pre-filter (MemPalace — 34pp recall gain)
 let _prefilter = null;
 try { _prefilter = spatialFilter.prefilterByStructure(q.trim()); } catch {}
 if (_prefilter?.prefiltered && _prefilter.results.length > 0) {
   searchMethod = "prefilter+" + (_prefilter.wing || '') + "/" + (_prefilter.room || '');
 }

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
  // v2.1: Entity-centric search boost (Memary pattern)
  try { searchResults = entityRanker.applyEntityBoost(searchResults); } catch {}
	// v2.2: Merge structural with semantic results
	try { if (_prefilter?.prefiltered && searchResults.length > 0) searchResults = spatialFilter.mergeStructuralWithSemantic(_prefilter.results, searchResults); } catch {}
	// v2.2: Expand hit graph by entities
	try { if (searchResults.length > 0) searchResults = entityRanker.expandHitGraphByEntities(q.trim(), searchResults.map(r => r.id)); } catch {}
	// v2.2: Modality boost for cross-modal results
	try { if (searchResults.length > 0) searchResults = crossModalExtractor.modalityBoost(searchResults, q.trim()); } catch {}
	// v2.2: Hall-type corridor diversity
	try { if (searchResults.length > 0) searchResults = spatialFilter.addHallTypeCorridor(searchResults); } catch {}
	// Apply session filter BEFORE final limit to avoid returning fewer results than requested
	if (session_id) searchResults = searchResults.filter(r => r.session_id === session_id);
	searchResults = searchResults.slice(0, limitNum);
  }

    // Store in semantic cache if we got results from embedding search
    if (queryVecForCache && searchResults.length > 0 && !searchMethod.startsWith("cache")) {
      addToQueryCache(queryVecForCache, searchResults, q.trim());
    }


// Track recall counts for returned results
try {
  const ids = searchResults.map(r => r.id).filter(Boolean);
  if (ids.length) incrementRecallCounts(ids);
		// v2.2: Track co-recall signals
		try { if (ids.length > 1) ambientInjector.trackCoRecall(ids); } catch {}
		// v2.2: Track corecalls for hot cache
		try { if (ids.length) capsuleBuilder.trackCorecall(db, ids); } catch {}
		// v2.2: On-recall hooks for capsule builder
		try { if (ids.length) capsuleBuilder.onMemoriesRecalled(db, ids); } catch {}
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
  const sessionTag = (sessionId && m.session_id && m.session_id !== sessionId)
    ? `[from session ${m.session_id.slice(0, 8)}]` : '';
  const line = `- (${m.type}) ${prefix}${sessionTag}${sessionTag ? ' ' : ''}${m.text}`;
      if (chars + line.length > charBudget) break;
      lines.push(line);
      chars += line.length;
    }

		// v2.2: Preload hot cache for top recall candidates
		try { if (deduped.length > 0) capsuleBuilder.preloadHotCache(db, deduped[0].id); } catch {}
// v2.1: Inject wake-up context layer (MemPalace L0+L1 facts)
  let _wakeup = '';
  try { const wc = spatialFilter.generateWakeUpContext(); if (wc) _wakeup = String.fromCharCode(10) + wc; } catch {}


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
    const memories = getAllActiveMemoriesNoEmbed();
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
      if (!m.text || typeof m.text !== 'string' || m.text.length > 10000) continue;
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
    const direction = req.query.direction || 'both';
    const relation = req.query.relation || '';
    if (!fromId) return res.status(400).json({ error: 'from_id query parameter required' });
    const steps = traverseMemoryGraph(fromId, maxDepth, limit, direction, relation);
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
    const { isPrivateUrlAfterDns } = await import('./web-fetch.mjs');
    const isPrivate = await isPrivateUrlAfterDns(url);
    if (isPrivate) return res.status(403).json({ error: 'URL resolves to private/internal network — not allowed' });
    // Block same-origin requests (to own server port)
    try {
      const parsed = new URL(url);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && port === String(PORT)) {
        return res.status(403).json({ error: 'URL points to this server — not allowed' });
      }
    } catch {}
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
    const sessionId = session_id || '';
    const targetIds = memory_ids || [];

    // Get the requested memories or recent session memories
    const sourceMems = targetIds.length > 0
      ? targetIds.map(id => getMemory(id)).filter(Boolean)
      : getSessionMemories(sessionId).slice(-15);

    if (sourceMems.length < 3) {
      return res.json({ ok: true, procedure_id: null, message: 'Not enough memories to extract a procedure (minimum 3)' });
    }

    const memText = sourceMems.map(m => `[${m.type}] ${m.text}`).join('\n');

    
    

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
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    });

    if (!llmRes.ok) return res.status(503).json({ error: 'LLM unavailable' });
    const llmData = await llmRes.json();
    const procContent = llmData?.choices?.[0]?.message?.content || '';
    const jsonMatch = procContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ ok: true, procedure_id: null, message: 'No procedure could be extracted' });

  let procData;
  try { procData = JSON.parse(jsonMatch[0]); } catch { return res.json({ ok: true, procedure_id: null, message: "LLM returned invalid JSON" }); }

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

app.delete('/memory/:id', (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  try {
    const id = parseInt(req.params.id);
    const mem = getMemory(id);
    if (!mem) return res.status(404).json({ error: 'not found' });
    deleteMemory(id);
	// v2.2: On-delete hooks
	try { capsuleBuilder.onMemoryDeleted(db, id); } catch {}
	try { capsuleBuilder.deleteTripletsForMemory(db, id); } catch {}
	try { capsuleBuilder.deleteSlotsForMemory(db, id); } catch {}
	try { ambientInjector.invalidateInjectionCache(); } catch {}
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
	// v2.2: Record supersession in version history
	try { capsuleBuilder.recordVersion(db, old_id, 'supersede'); capsuleBuilder.recordVersion(db, new_id, 'promoted'); } catch {}
	try { ambientInjector.invalidateInjectionCache(); } catch {}

// Bi-temporal: set valid_until on old, valid_from on new
const now = new Date().toISOString();
const setValidUntil = db.prepare('UPDATE memories SET valid_until = ? WHERE id = ?');
setValidUntil.run(now, old_id);
const setValidFrom = db.prepare('UPDATE memories SET valid_from = ? WHERE id = ? AND valid_from IS NULL');
setValidFrom.run(now, new_id);

// Add provenance to new memory metadata
newMem = getMemory(new_id);
  if (newMem) {
    const updateSupersedeMeta = db.transaction(() => {
      const cur = getMemory(new_id);
      if (!cur) return;
      const oldMeta = JSON.parse(oldMem.metadata || '{}');
      const newMeta = JSON.parse(cur.metadata || '{}');
      newMeta.supersedes = old_id;
      newMeta.supersede_reason = reason || 'contradiction';
      newMeta.derived_from = [...(oldMeta.derived_from || []), old_id];
      let sourceIds = [];
      try { sourceIds = JSON.parse(cur.source_memory_ids || '[]'); } catch {}
      if (!sourceIds.includes(old_id)) sourceIds.push(old_id);
      const updateMeta = db.prepare('UPDATE memories SET metadata = ?, source_memory_ids = ? WHERE id = ?');
      updateMeta.run(JSON.stringify(newMeta), JSON.stringify(sourceIds), new_id);
    });
    updateSupersedeMeta();
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
 /\b(i am|i'm)\s+(gay|lesbian|bisexual|trans|nonbinary|queer|straight|asexual|demisexual|pansexual|aromantic)\b/i,
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
      const userText = user_message.trim().substring(0, 2000);
      const { entity: userEntity, attribute: userAttr } = extractEntityAttribute(userText);
      const userPrefix = generateContextPrefix(userText, type, session_id);
    memories.push({ session_id, type, text: userText, embedding: null, metadata: { source: "user", extraction_method: "sync", origin_session_id: session_id, timestamp: now }, importance: estimateImportance(userText, type), context_prefix: userPrefix, entity: userEntity, attribute: userAttr, summary: ruleBasedCompress(userText, 2) });
  }

  // Store assistant response — skip very short responses
  if (assistant_response?.trim() && !shouldSkipMessage(assistant_response)) {
    const asstText = assistant_response.trim().substring(0, 4000);
    const { entity: asstEntity, attribute: asstAttr } = extractEntityAttribute(asstText);
    const asstPrefix = generateContextPrefix(asstText, "fact", session_id);
    memories.push({ session_id, type: "fact", text: asstText, embedding: null, metadata: { source: "assistant", extraction_method: "sync", origin_session_id: session_id, timestamp: now }, importance: estimateImportance(asstText, "fact"), context_prefix: asstPrefix, entity: asstEntity, attribute: asstAttr, summary: ruleBasedCompress(asstText, 2) });
  }

  const ids = memories.length > 0 ? storeMemories(memories) : [];
  // Queue background embedding (consistent with /memory/store — avoids inline await)
  for (let i = 0; i < ids.length; i++) {
    enqueueEmbedding(ids[i], memories[i].text, memories[i].context_prefix);
  }
  for (const m of memories) { if (m.entity) invalidateQueryCacheForEntity(m.entity, m.attribute); }

	// v2: Wire graph edge extraction (fire-and-forget to avoid headers-already-sent)
	for (let i = 0; i < ids.length; i++) {
		extractAndStoreEdges(ids[i], memories[i].text, session_id).catch(() => {});
	}

  // Respond AFTER enqueue but BEFORE async edge extraction completes
  res.json({ ok: true, stored: ids.length, ids });

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
    res.json({ ok: true, mode: 'brain2', analysis });
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
    res.json({ ok: true, mode: 'brain2', advice });
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

     // v2.1: Auto-link co-accessed memories (Lemma corecalls)
 try { ambientInjector.createCorecallEdges(); } catch {}
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
const _AUTO_PURGE_DAYS_RAW = parseInt(process.env.AUTO_PURGE_DAYS ?? '365');
const AUTO_PURGE_DAYS = Number.isFinite(_AUTO_PURGE_DAYS_RAW) && _AUTO_PURGE_DAYS_RAW > 0 ? _AUTO_PURGE_DAYS_RAW : 365;
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
// ── v2.1 Module Endpoints ───────────────────────────────────────

// Capsule Builder (Memvid)
app.get('/memory/capsule/export', (_req, res) => {
  try {
    const result = capsuleBuilder.exportCapsule(db);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/capsule/import', (req, res) => {
  try {
    const result = capsuleBuilder.importCapsule(db, req.body);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/versions/:id', (req, res) => {
  try {
    const history = capsuleBuilder.getMemoryHistory(db, +req.params.id);
    res.json({ ok: true, history });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/at-time', (req, res) => {
  try {
    const memories = capsuleBuilder.getMemoriesAtTime(db, req.query.timestamp);
    res.json({ ok: true, memories });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ambient Injector (Lemma)
app.get('/memory/audit', async (_req, res) => {
  try {
    const report = await ambientInjector.runMemoryAudit(db);
    const formatted = ambientInjector.formatAuditReport(report);
    res.json({ ok: true, report, formatted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/feedback', (req, res) => {
  try {
    const result = ambientInjector.processMemoryFeedback(db, req.body);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/session/status', (req, res) => {
  try {
    const session = ambientInjector.getSession(db, req.query.session_id);
    res.json({ ok: true, session });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/ambient/session/end', (req, res) => {
  try {
    const result = ambientInjector.endSession(db, req.body);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Compaction Coordinator (MARM)
app.post('/memory/compaction/candidates', async (_req, res) => {
  try {
    const candidates = await compactionCoordinator.findCompactionCandidates(db);
    res.json({ ok: true, candidates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/compaction/status', (_req, res) => {
  try {
    const status = compactionCoordinator.compactionStatus(db);
    res.json({ ok: true, ...status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compaction/review', (req, res) => {
  try {
    const result = compactionCoordinator.compactionReview(db, req.body);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compaction/apply', (req, res) => {
  try {
    const result = compactionCoordinator.compactionApply(db, req.body);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compaction/discard', (req, res) => {
  try {
    const result = compactionCoordinator.compactionDiscard(db, req.body);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Strategy Distiller (ReasoningBank)
app.post('/memory/reasoning/recall', (req, res) => {
  try {
    const result = strategyDistiller.reasoningRecall(db, req.body);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/reasoning/extract', async (req, res) => {
  try {
    const result = await strategyDistiller.extractReasoningFromTrace(db, req.body, llmFetch);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/reasoning/stats', (_req, res) => {
  try {
    const stats = strategyDistiller.getReasoningStats(db);
    res.json({ ok: true, ...stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Entity Ranker (Memary)
app.get('/memory/entity/ranking', (req, res) => {
  try {
    const ranking = entityRanker.getEntityRanking(db, req.query);
    res.json({ ok: true, ranking });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/entity/stream', (req, res) => {
  try {
    const stream = entityRanker.getMemoryStream(db, req.query);
    res.json({ ok: true, stream });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ingest Pipeline (LLM Wiki)
app.get('/memory/gaps', async (_req, res) => {
  try {
    const gaps = await ingestPipeline.detectKnowledgeGaps(db);
    res.json({ ok: true, gaps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/cross-link', async (_req, res) => {
  try {
    const result = await ingestPipeline.autoGenerateCrossLinks(db);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnostic Compiler (zerolang)
app.post('/memory/diagnostic/explain', (req, res) => {
  try {
    const explanation = diagnosticCompiler.explainDiagnostic(db, req.body.code);
    res.json({ ok: true, explanation });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/diagnostic/codes', (_req, res) => {
  try {
    const codes = diagnosticCompiler.listDiagnosticCodes(db);
    res.json({ ok: true, codes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/diagnostic/repair', (req, res) => {
  try {
    const plan = diagnosticCompiler.generateRepairPlan(db, req.body);
    res.json({ ok: true, plan });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/skills', (_req, res) => {
  try {
    const skills = diagnosticCompiler.getSkills(db);
    res.json({ ok: true, skills });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Declarative Gateway (MCP Toolbox)
app.get('/memory/query/templates', (_req, res) => {
  try {
    const templates = declarativeGateway.listQueryTemplates(db);
    res.json({ ok: true, templates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/query/template', (req, res) => {
  try {
    const result = declarativeGateway.executeQueryTemplate(db, req.body);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/query/nl', (req, res) => {
  try {
    const result = declarativeGateway.nlQuery(db, req.body.query);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Context Compressor (Headroom)
app.post('/memory/compress/typed', (req, res) => {
  try {
    const result = contextCompressor.compressByType(req.body.text, req.body.opts);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Spatial Filter (MemPalace)
app.get('/memory/tunnels', async (_req, res) => {
  try {
    const tunnels = await spatialFilter.detectCrossWingTunnels(db);
    res.json({ ok: true, tunnels });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lesson Vault
app.get('/memory/sliding-window', (req, res) => {
  try {
    const window = lessonVault.getSlidingWindow(db, req.query);
    res.json({ ok: true, ...window });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Initialize Module Registry (v2.1 adapters) ────────────────

// ── v2.2: Additional Adapter Endpoints ─────────────────────────────

// Capsule Builder: extended operations
app.get('/memory/capsule/export/file', (req, res) => {
	try {
		const result = capsuleBuilder.exportCapsuleToFile(db, req.query.path || 'noxem-export.json');
		res.json({ ok: true, path: result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/capsule/corecalls/:id', (req, res) => {
	try {
		const corecalls = capsuleBuilder.getCorecalls(db, +req.params.id);
		res.json({ ok: true, corecalls });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/capsule/hot-cache', (_req, res) => {
	try {
		const stats = capsuleBuilder.getHotCacheStats();
		res.json({ ok: true, stats });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/capsule/hot-cache/clear', (_req, res) => {
	try {
		capsuleBuilder.clearHotCache();
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/capsule/triplets/search', (req, res) => {
	try {
		const results = capsuleBuilder.searchTriplets(db, req.query);
		res.json({ ok: true, results });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/capsule/triplets/:id', (req, res) => {
	try {
		const triplets = capsuleBuilder.getTripletsForMemory(db, +req.params.id);
		res.json({ ok: true, triplets });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/capsule/slot', (req, res) => {
	try {
		const slot = capsuleBuilder.getSlot(db, req.query.entity, req.query.attribute);
		res.json({ ok: true, slot });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/capsule/slots/rebuild', (_req, res) => {
	try {
		const count = capsuleBuilder.rebuildSlotIndex(db);
		res.json({ ok: true, count });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Context Compressor: patterns + strategies + KV align
app.get('/memory/compressor/patterns', (req, res) => {
	try {
		const contentType = contextCompressor.classifyContentType(req.query.text || '');
		res.json({ ok: true, contentType });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/compressor/fingerprint', (req, res) => {
	try {
		const fp = contextCompressor.structuralFingerprint(req.query.text || '', req.query.contentType || 'text');
		res.json({ ok: true, fingerprint: fp });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/compressor/strategy', (req, res) => {
	try {
		const strategy = contextCompressor.getBestStrategy(db, req.query.hash || '');
		res.json({ ok: true, strategy });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compressor/feedback', (req, res) => {
	try {
		contextCompressor.recordCompressionFeedback(db, req.body.structureHash, req.body.contentType, req.body.strategy, req.body.recallScore, req.body.ratio);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compressor/kv-align', (req, res) => {
	try {
		const { alignedText, tokenMap } = contextCompressor.alignKVCachePrefixes(req.body.text || '');
		res.json({ ok: true, alignedText, tokenCount: Object.keys(tokenMap).length });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compressor/batch', (req, res) => {
	try {
		const results = contextCompressor.batchCompressMemories(req.body.memories || [], db);
		res.json({ ok: true, results });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compressor/conversation', (req, res) => {
	try {
		const compressed = contextCompressor.compressConversationTurns(req.body.turns || []);
		res.json({ ok: true, compressed });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compressor/ccr/retrieve', (req, res) => {
	try {
		const original = contextCompressor.retrieveCCROriginal(db, req.body.hash);
		res.json({ ok: true, original });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compressor/pre-compress', (req, res) => {
	try {
		const compressed = contextCompressor.preCompressForAdvisor(req.body.history || [], req.body.sessionMemories || []);
		res.json({ ok: true, compressed });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Compaction Coordinator: notebooks + staging + dashboard
app.post('/memory/compaction/stage', (req, res) => {
	try {
		const result = compactionCoordinator.compactionStage(db, req.body.candidateId, req.body.summary);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/compaction/candidates/list', (_req, res) => {
	try {
		const candidates = compactionCoordinator.compactionCandidates(db);
		res.json({ ok: true, candidates });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compaction/dispatch', (req, res) => {
	try {
		const result = compactionCoordinator.compactionDispatch(db, req.body.action, req.body.params || {});
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/compaction/preview', (req, res) => {
	try {
		const preview = compactionCoordinator.previewCompactionCandidates(req.body.memories || [], req.body.deps || {});
		res.json({ ok: true, preview });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/memory/notebook', (req, res) => {
	try {
		compactionCoordinator.upsertNotebook(db, req.body);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/notebook/:name', (req, res) => {
	try {
		const notebook = compactionCoordinator.getNotebook(db, req.params.name);
		res.json({ ok: true, notebook });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/notebooks', (req, res) => {
	try {
		const notebooks = compactionCoordinator.listNotebooks(db, req.query.category || '');
		res.json({ ok: true, notebooks });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/memory/notebook/:name', (req, res) => {
	try {
		compactionCoordinator.deleteNotebook(db, req.params.name);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/notebooks/activate', (req, res) => {
	try {
		compactionCoordinator.useNotebooks(db, req.body.names || [], req.body.sessionId || 'default');
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/notebooks/active', (req, res) => {
	try {
		const active = compactionCoordinator.getActiveNotebooks(req.query.sessionId || 'default');
		res.json({ ok: true, active });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/notebooks/clear', (req, res) => {
	try {
		compactionCoordinator.clearActiveNotebooks(req.body.sessionId || 'default');
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/notebook/dispatch', (req, res) => {
	try {
		const result = compactionCoordinator.notebookDispatch(db, req.body.action, req.body.params || {});
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/dashboard', (_req, res) => {
	try {
		const html = compactionCoordinator.generateDashboardHTML(db);
		res.type('html').send(html);
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Multi-Source Router
app.get('/memory/sources/catalog', (_req, res) => {
	try {
		const catalog = multiSourceRouter.getSourceCatalog();
		res.json({ ok: true, catalog });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/sources/route', async (req, res) => {
	try {
		const result = await multiSourceRouter.routeToSources(req.body.query, { llmFetch, llmUrl: LLM_URL, llmModel: LLM_MODEL, topK: req.body.topK || 3 });
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/sources/dispatch', (req, res) => {
	try {
		const result = multiSourceRouter.dispatchToSource(req.body.sourceId, req.body.query, req.body.deps || {}, req.body.limit || 15);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/sources/hyde', async (req, res) => {
	try {
		const hyde = await multiSourceRouter.generateHyDE(req.body.query, { llmFetch, llmUrl: LLM_URL, llmModel: LLM_MODEL });
		res.json({ ok: true, hyde });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/sources/rerank', async (req, res) => {
	try {
		const reranked = await multiSourceRouter.evidenceRerank(req.body.query, req.body.candidates || [], { llmFetch, llmUrl: LLM_URL, llmModel: LLM_MODEL });
		res.json({ ok: true, reranked });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/sources/search', async (req, res) => {
	try {
		const results = await multiSourceRouter.multiSourceSearch(req.body.query, req.body.deps || {}, { llmFetch, llmUrl: LLM_URL, llmModel: LLM_MODEL });
		res.json({ ok: true, results });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Cross-Modal Extractor
app.post('/memory/multimodal/store', (req, res) => {
	try {
		const validation = crossModalExtractor.validateMultimodalFields(req.body);
		if (!validation.valid) return res.status(400).json({ error: validation.errors });
		const result = crossModalExtractor.storeMultimodalMemory(db, req.body, (m) => storeMemory(m));
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/multimodal/link', (req, res) => {
	try {
		const result = crossModalExtractor.linkMultimodalMemory(db, req.body.textMemId, req.body.visualMemId, req.body.relation || 'illustrates', req.body.sessionId || '');
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/multimodal/auto-link', (req, res) => {
	try {
		const result = crossModalExtractor.autoLinkCrossModal(db, req.body.newMemory);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/multimodal/scene', (req, res) => {
	try {
		const source = crossModalExtractor.getSceneSource(req.query.sceneName || '');
		res.json({ ok: true, source });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/multimodal/migrate', (_req, res) => {
	try {
		const result = crossModalExtractor.runCrossModalMigration(db);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/multimodal/embedding-text', (req, res) => {
	try {
		const embeddingText = crossModalExtractor.prepareEmbeddingText(req.body.memory || {});
		res.json({ ok: true, embeddingText });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Entity Ranker: topic shifts + eviction context
app.get('/memory/entity/topic-shifts', (req, res) => {
	try {
		const shifts = entityRanker.detectTopicShifts(req.query.binDays ? +req.query.binDays : undefined);
		res.json({ ok: true, shifts });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/entity/eviction-context', (req, res) => {
	try {
		const context = entityRanker.assembleEvictionContext(req.body.history || [], req.body.tokenBudget || 2000);
		res.json({ ok: true, context });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Spatial Filter: tunnels + corridors
app.get('/memory/tunnels/query', (req, res) => {
	try {
		const tunnels = spatialFilter.getTunnels(req.query.entity || '', req.query.attribute || '');
		res.json({ ok: true, tunnels });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/tunnels/expand', (req, res) => {
	try {
		const expanded = spatialFilter.expandResultsViaTunnels(req.body.results || [], req.body.limitPerTunnel || 3);
		res.json({ ok: true, expanded });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Ambient Injector: session management + agents-md + distill
app.post('/memory/ambient/session/manage', (req, res) => {
	try {
		const result = ambientInjector.manageSession(req.body.sessionId, req.body.action, req.body.options || {});
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/ambient/agents-md', (req, res) => {
	try {
		const injection = ambientInjector.buildAgentsMdInjection(req.query.projectDir || process.cwd());
		res.json({ ok: true, injection });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/ambient/combined', (req, res) => {
	try {
		const context = ambientInjector.buildCombinedAmbientContext(req.query.projectDir || process.cwd());
		res.json({ ok: true, context });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/ambient/agents-md/invalidate', (_req, res) => {
	try {
		ambientInjector.invalidateAgentsMdCache();
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/ambient/context-tool-def', (req, res) => {
	try {
		const def = ambientInjector.buildAmbientContextToolDef(req.query.forceRefresh === 'true');
		res.json({ ok: true, def });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/ambient/feedback/stats', (req, res) => {
	try {
		const stats = ambientInjector.getMemoryFeedbackStats(req.query.memoryId ? +req.query.memoryId : undefined);
		res.json({ ok: true, stats });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/ambient/store', (req, res) => {
	try {
		const result = ambientInjector.storeMemoryWithAmbient(req.body);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/ambient/recall', (req, res) => {
	try {
		const result = ambientInjector.recallWithAmbient(req.body.ids || []);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/ambient/tools', (_req, res) => {
	try {
		const tools = ambientInjector.buildAmbientInjectorTools();
		res.json({ ok: true, tools });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/ambient/distill/guide', async (req, res) => {
	try {
		const result = await ambientInjector.distillGuide(req.body.procedureId, llmFetch);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Strategy Distiller: store + quality + contrast + failure-aware
app.post('/memory/reasoning/store', async (req, res) => {
	try {
		const result = await strategyDistiller.storeReasoningMemory(req.body);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/reasoning/quality', async (req, res) => {
	try {
		const result = await strategyDistiller.judgeReasoningQuality(req.body.items || []);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/reasoning/contrast', async (req, res) => {
	try {
		const result = await strategyDistiller.contrastTrajectories(req.body.entity || '', req.body.opts || {});
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/reasoning/failure-extract', async (req, res) => {
	try {
		const result = await strategyDistiller.onFailureAwareExtract(req.body.text || '', req.body.sessionId || '');
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Ingest Pipeline: extract + relevance + status
app.get('/memory/ingest/status', (_req, res) => {
	try {
		const status = ingestPipeline.getIngestStatus();
		res.json({ ok: true, status });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/ingest/extract-l1', async (req, res) => {
	try {
		const result = await ingestPipeline.twoStepExtractL1(req.body.sessionId || '', req.body.opts || {});
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/ingest/relevance', (req, res) => {
	try {
		const score = ingestPipeline.calculateRelevance(req.body.memA || {}, req.body.memB || {});
		res.json({ ok: true, score });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/ingest/graph-expand', async (req, res) => {
	try {
		const result = await ingestPipeline.expandWithGraphSignals(req.body.hitIds || [], req.body.opts || {});
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Declarative Gateway: toolsets + templates + skill export + stats
app.post('/memory/toolset/register', (req, res) => {
	try {
		declarativeGateway.registerToolset(req.body.name, req.body.tools, req.body.access_level || 'read', req.body.description || '');
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/toolsets', (_req, res) => {
	try {
		const toolsets = declarativeGateway.listToolsets();
		res.json({ ok: true, toolsets });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/toolset/resolve', (req, res) => {
	try {
		const tools = declarativeGateway.resolveToolset(req.body.name);
		res.json({ ok: true, tools });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/toolset/filter', (req, res) => {
	try {
		const filtered = declarativeGateway.filterToolsByAccess(req.body.toolNames || [], req.body.toolsetName || '');
		res.json({ ok: true, filtered });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/query/template/upsert', (req, res) => {
	try {
		declarativeGateway.upsertQueryTemplate(req.body);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/memory/query/template/:name', (req, res) => {
	try {
		declarativeGateway.deleteQueryTemplate(req.params.name);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/query/parameterized', (req, res) => {
	try {
		const result = declarativeGateway.runParameterizedQuery(req.body.sqlTemplate, req.body.paramsSchemaJson, req.body.params || {});
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/skill/export', (req, res) => {
	try {
		const pkg = declarativeGateway.exportSkillPackage(req.body);
		res.json({ ok: true, ...pkg });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/toolset/reload', async (req, res) => {
	try {
		await declarativeGateway.reloadToolConfig(req.body.configPath);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/declarative/stats', (_req, res) => {
	try {
		const stats = declarativeGateway.getDeclarativeGatewayStats();
		res.json({ ok: true, stats });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnostic Compiler: repair execution + procedure deps
app.post('/memory/diagnostic/repair/execute', (req, res) => {
	try {
		const result = diagnosticCompiler.executeRepairPlan(db, req.body.items || [], req.body.options || {});
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/skills/version', (_req, res) => {
	try {
		const version = diagnosticCompiler.getSkillsVersion();
		res.json({ ok: true, version });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/skills/names', (_req, res) => {
	try {
		const names = diagnosticCompiler.listSkillNames();
		res.json({ ok: true, names });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/procedure-deps/init', (_req, res) => {
	try {
		diagnosticCompiler.initProcedureDeps(db);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/procedure-deps/add', (req, res) => {
	try {
		diagnosticCompiler.addProcedureDep(req.body.procedureId, req.body.dependsOnId, req.body.depType || 'references');
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/memory/procedure-deps/remove', (req, res) => {
	try {
		diagnosticCompiler.removeProcedureDep(req.body.procedureId, req.body.dependsOnId);
		res.json({ ok: true });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/procedure-deps/:id', (req, res) => {
	try {
		const deps = diagnosticCompiler.getProcedureDependencies(+req.params.id);
		const dependents = diagnosticCompiler.getProcedureDependents(+req.params.id);
		res.json({ ok: true, deps, dependents });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/procedure-deps-graph', (_req, res) => {
	try {
		const graph = diagnosticCompiler.getProcedureDependencyGraph();
		res.json({ ok: true, graph });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/procedure-deps/extract', (req, res) => {
	try {
		const deps = diagnosticCompiler.extractProcedureDepsFromSteps(db, +req.body.procedureId);
		res.json({ ok: true, deps });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/diagnostic/stats', (_req, res) => {
	try {
		const stats = diagnosticCompiler.getDiagnosticAdapterStats();
		res.json({ ok: true, stats });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/entity-hash', (req, res) => {
	try {
		const hash = diagnosticCompiler.computeEntityHash(db, req.query.entity || '', req.query.attribute || '');
		res.json({ ok: true, hash });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/entity-hash/validate', (req, res) => {
	try {
		const result = diagnosticCompiler.validateContentHash(db, req.body.entity, req.body.expectedHash, req.body.attribute || '');
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Lesson Vault: PCA + dimension reduction + reranking + table extract
app.post('/memory/pca', (req, res) => {
	try {
		const result = lessonVault.computePCA(req.body.samples || [], req.body.varianceThreshold);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/d-eff', (_req, res) => {
	try {
		const info = lessonVault.measureEffectiveDim(getActiveWithEmbedding(), db);
		res.json({ ok: true, ...info });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/d-eff/project', (req, res) => {
	try {
		const projected = lessonVault.applyDEffProjection(req.body.embedding || [], db);
		res.json({ ok: true, projected });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/write-stats', (_req, res) => {
	try {
		const stats = lessonVault.getWriteStats();
		res.json({ ok: true, stats });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/poisoning-audit', (_req, res) => {
	try {
		const report = lessonVault.auditMemoryPoisoning(db);
		res.json({ ok: true, ...report });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/table-detect', (req, res) => {
	try {
		const chunks = lessonVault.extractTableChunks(req.body.text || '', req.body.options || {});
		res.json({ ok: true, chunks });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/rerank', (req, res) => {
	try {
		const reranked = lessonVault.rerankResults(req.body.results || [], req.body.weights || {});
		res.json({ ok: true, reranked });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/rerank/prepare', (req, res) => {
	try {
		const prepared = lessonVault.prepareForReranking(req.body.results || [], req.body.method || 'hybrid', req.body.query || '');
		res.json({ ok: true, prepared });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Graph Pruner: hub nodes + PQ search + code detection + maintenance
app.get('/memory/hub-nodes', (_req, res) => {
	try {
		const ids = graphPruner.getHubNodeIds(db);
		res.json({ ok: true, ids });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/pq/search', (req, res) => {
	try {
		const results = graphPruner.knnSearchPQ(db, req.body.queryVec, req.body.topK || 5, req.body.options || {});
		res.json({ ok: true, results });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/code/chunk', (req, res) => {
	try {
		const chunks = graphPruner.chunkCodeAST(req.body.codeText || '', req.body.options || {});
		res.json({ ok: true, chunks });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/code/detect', (req, res) => {
	try {
		const result = graphPruner.detectCodeContent(req.body.text || '');
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/dedup/knn', async (req, res) => {
	try {
		const results = await graphPruner.findDuplicatesKNN(db, vectorKnnSearch, req.body.options || {});
		res.json({ ok: true, results });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/graph/maintenance', async (_req, res) => {
	try {
		const result = await graphPruner.runMaintenancePipeline(db, embed);
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

// Delta Processor: sync, logic version, startup checks
app.post('/memory/delta/sync-hash', (req, res) => {
	try {
		const hash = deltaProcessor.computeSyncContentHash(req.body.items || []);
		res.json({ ok: true, hash });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/delta/sync-diff', (req, res) => {
	try {
		const diff = deltaProcessor.computeSyncDiff(req.body.previous || [], req.body.current || []);
		res.json({ ok: true, ...diff });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/delta/logic-version', (_req, res) => {
	try {
		const version = deltaProcessor.computeLogicVersion(String(categorizeText), String(estimateImportance));
		res.json({ ok: true, version });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/memory/delta/startup-checks', (_req, res) => {
	try {
		const result = deltaProcessor.runStartupChecks({ db, categorizeSrc: String(categorizeText).slice(0, 200), importanceSrc: String(estimateImportance).slice(0, 200), modelId: 'local', embedDim: 256, dtype: 'float32', hasExistingEmbeddings: getActiveMemories().length > 0 });
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/memory/delta/logic-reevaluate', (req, res) => {
	try {
		const result = deltaProcessor.runLogicReevaluation({ db, categorizeFn: categorizeText, estimateFn: estimateImportance, limit: req.body.limit || 1000 });
		res.json({ ok: true, ...result });
	} catch (err) { res.status(500).json({ error: err.message }); }
});


initModules(embed).then(() => {
  const status = getModuleStatus();
  if (LOG_DEBUG) console.log('[Server] Modules initialized:', status.loaded, '/', status.moduleCount, status.skipped ? `(${status.skipped} skipped)` : '');
}).catch(err => console.error('[Server] Module init failed:', err.message));

// ─── Start ────────────────────────────────────────────────────────
const server = app.listen(PORT, '127.0.0.1', () => {
  if (!LOG_QUIET) console.log(`━━━━ Hermes AI Memory Server v2 ━━━━`);
  if (!LOG_QUIET) console.log(`  Port: ${PORT}`);
  if (!LOG_QUIET) console.log(`  Brain-1: ${ENABLE_EMBEDDING ? (isEmbeddingReady() ? 'Ready' : 'Loading...') : 'DISABLED'}`);
  if (!LOG_QUIET) console.log(`  Vector Index: ${isVecReady() ? 'sqlite-vec KNN' : 'JS cosine fallback'} (backend: ${getVectorBackend()})`)
if (!LOG_QUIET && (getVectorBackend() === 'hybrid' || getVectorBackend() === 'turbovec')) { checkTurboVecHealth().then(h => console.log(`  TurboVec: ${h.ok ? `alive (${h.count} vectors)` : 'starting... (sqlite-vec fallback active)'}`)).catch(() => {}); };
  if (!LOG_QUIET) console.log(` Brain-2: ${ENABLE_ADVISOR ? 'ON' : 'OFF'}`);
  if (!LOG_QUIET) console.log(`  Web Search: ${ENABLE_ADVISOR && process.env.ADVISOR_WEB_SEARCH !== 'false' ? 'DDG' : 'DISABLED'}`);
  if (!LOG_QUIET) console.log(` Research: ${ENABLE_RESEARCH ? 'Background pipeline (topic -> DDG -> fetch -> extract)' : 'OFF (Brain 1 only)'}`);
  if (!LOG_QUIET) console.log(`  Maintenance: ${ENABLE_MAINTENANCE ? 'ON (5min)' : 'DISABLED'}`);
  if (!LOG_QUIET) console.log(`  Decay: Weibull (type-specific eta/k)`);
  if (!LOG_QUIET) console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});

// Graceful shutdown
function shutdown(signal) {
  if (_isShuttingDown) return; // Prevent double-shutdown
  _isShuttingDown = true;
  if (!LOG_QUIET) console.log(`\n${signal} received — shutting down gracefully...`);
  if (_errorLogInterval) clearInterval(_errorLogInterval);
  if (_rateLimitCleanupInterval) clearInterval(_rateLimitCleanupInterval);
  stopMaintenanceCron();
  shutdownRLM(); // Stop Brain 2 sidecar before closing server
  // Flush embed queue: reject pending items so DB close doesn't orphan them
  if (_embedQueue.length > 0) {
    LOG_DEBUG && console.log(`[EmbedQueue] Shutdown: dropping ${_embedQueue.length} pending items`);
    _embedQueue.length = 0;
  }
  server.close(() => {
    close(); // close SQLite
    if (!LOG_QUIET) console.log('Memory server stopped.');
    process.exit(0);
  });
  // Force exit after 5s if connections don't close
  setTimeout(() => {
    if (!LOG_QUIET) console.log('Forcing exit after timeout.');
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
  const stack = reason instanceof Error ? reason.stack : '';
  console.error('Unhandled rejection:', msg, stack);
});
