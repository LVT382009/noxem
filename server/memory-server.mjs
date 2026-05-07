import express from 'express';
import cors from 'cors';
import { initEmbeddingEngine, isEmbeddingReady, getEmbeddingError, embed, embedBatch, searchByEmbedding, mmrRerank, categorizeText } from './embedding-engine.mjs';
import { isVecReady } from './vector-index.mjs';
import {
  storeMemory, storeMemories, searchMemories, getMemory, getActiveMemories,
  getAllActiveMemories, getSessionMemories, getMemoriesByType,
  getActiveWithEmbedding, getMemoryStats, updateMemoryStatus, updateMemoryType,
  deleteMemory, deleteInvalid, incrementRecallCounts, archiveStaleMemories, vectorKnnSearch,
  getMemoriesWithoutEmbedding, updateMemoryEmbedding, addVecsToIndex, close,
} from './memory-store.mjs';
import { analyzeBeforeCompress, getAdvice, analyzeSessionEnd } from './advisor-engine.mjs';
import { searchWeb, formatSearchResults } from './ddg-search.mjs';
import { runMaintenance, startMaintenanceCron, stopMaintenanceCron } from './memory-maintenance.mjs';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.MEMORY_PORT || 3001;
const ENABLE_EMBEDDING = process.env.ENABLE_EMBEDDING !== 'false';
const ENABLE_ADVISOR = process.env.ENABLE_ADVISOR !== 'false';
const ENABLE_MAINTENANCE = process.env.ENABLE_MAINTENANCE !== 'false';
const DECAY_HALF_LIFE_DAYS = parseFloat(process.env.MEMORY_DECAY_HALF_LIFE || '30');

// ─── Startup ─────────────────────────────────────────────────────
let startupComplete = false;

async function startup() {
  if (ENABLE_EMBEDDING) await initEmbeddingEngine();
  if (ENABLE_MAINTENANCE) startMaintenanceCron();
  startupComplete = true;
  console.log('Memory server fully initialized');
}

startup().catch(err => {
  console.error('Startup error:', err);
  startupComplete = true; // Allow server to function without embeddings
});

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: '2.0',
    embedding: isEmbeddingReady(),
    embedding_error: getEmbeddingError()?.message || null,
    vector_index: isVecReady(),
    advisor: ENABLE_ADVISOR,
    maintenance: ENABLE_MAINTENANCE,
    mode: 'hybrid-ai',
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

// Recency-weighted scoring: blend similarity with recency
// Formula: final_score = similarity * (0.7 + 0.3 * recency_weight)
// recency_weight = 0.5 ** (age_days / half_life_days)
function applyRecencyScore(results) {
  const now = Date.now();
  const halfLifeMs = DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  return results.map(r => {
    const createdAt = new Date(r.created_at).getTime();
    const ageMs = Math.max(0, now - createdAt);
    const recencyWeight = Math.pow(0.5, ageMs / halfLifeMs);
    const boosted = r.score * (0.7 + 0.3 * recencyWeight);
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

app.post('/memory/store', async (req, res) => {
  try {
    const { text, session_id, type, metadata } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

    const catType = type || categorizeText(text);
    let embedding = null;

    if (isEmbeddingReady()) {
      try {
        const vec = await embed(text);
        embedding = new Float32Array(vec).buffer;
      } catch { /* proceed without embedding */ }
    }

    const id = storeMemory({
      session_id: session_id || '',
      type: catType,
      text: text.trim(),
      embedding,
      metadata: metadata || {},
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

    let embeddings = null;
    if (isEmbeddingReady()) {
      try {
        embeddings = await embedBatch(memories.map(m => m.text));
      } catch { /* proceed */ }
    }

    const items = memories.map((m, i) => ({
      session_id: m.session_id || '',
      type: m.type || categorizeText(m.text),
      text: m.text.trim(),
      embedding: embeddings ? new Float32Array(embeddings[i]).buffer : null,
      metadata: m.metadata || {},
    }));

    const ids = storeMemories(items);
    res.json({ ok: true, ids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/search', async (req, res) => {
  let searchResults = [];
  try {
    const { q, session_id, limit, method } = req.query;
    if (!q?.trim()) return res.status(400).json({ error: 'query "q" required' });

    const limitNum = limit ? parseInt(limit) : 10;
    let searchMethod = 'fts';

    // Embedding search (primary) — try sqlite-vec KNN first, fall back to JS cosine
    if ((!method || method === 'hybrid' || method === 'embedding') && isEmbeddingReady()) {
      try {
        const qVec = await embed(q.trim(), 'query');

        // Try native KNN via sqlite-vec (much faster for large datasets)
        let embeddingResults = null;
        const knnHits = vectorKnnSearch(qVec, limitNum * 3);
        if (knnHits && knnHits.length > 0) {
          embeddingResults = applyRecencyScore(knnHits);
          searchMethod = 'knn';
        } else {
          // Fallback: JS brute-force cosine similarity
          const allMemories = getAllActiveMemories();
          const embeddingCandidates = searchByEmbedding(qVec, allMemories, limitNum * 3);
          embeddingResults = applyRecencyScore(mmrRerank(qVec, embeddingCandidates, limitNum * 2, 0.7));
        }

        if (embeddingResults.length > 0 && method === 'embedding') {
          searchResults = embeddingResults.slice(0, limitNum);
          searchMethod = 'embedding';
        } else if (method === 'hybrid' || !method) {
          // Hybrid: Reciprocal Rank Fusion of embedding + FTS results
          const ftsResults = normalizeFtsScore(searchMemories({ query: q, limit: limitNum * 3 }));
          const merged = reciprocalRankFusion([embeddingResults, ftsResults]);
          searchResults = merged.slice(0, limitNum);
          searchMethod = 'hybrid';
        }
      } catch { /* fall through to FTS */ }
    }

    // FTS fallback
    if (!searchResults.length) {
      searchResults = applyRecencyScore(normalizeFtsScore(searchMemories({ query: q, limit: limitNum })));
      if (session_id) {
        searchResults = searchResults.filter(r => r.session_id === session_id);
      }
    }

    res.json({ ok: true, method: searchMethod, results: searchResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
  // Track recall counts for returned results
  try {
    const ids = searchResults.map(r => r.id).filter(Boolean);
    if (ids.length) incrementRecallCounts(ids);
  } catch {}
});

app.get('/memory/stats', (_req, res) => {
  res.json(getMemoryStats());
});

app.get('/memory/session/:sessionId', (req, res) => {
  const { limit } = req.query;
  res.json({ results: getSessionMemories(req.params.sessionId, limit ? parseInt(limit) : 50) });
});

app.get('/memory/type/:type', (req, res) => {
  const { limit } = req.query;
  res.json({ results: getMemoriesByType(req.params.type, limit ? parseInt(limit) : 50) });
});

app.get('/memory/:id', (req, res) => {
  const mem = getMemory(parseInt(req.params.id));
  if (!mem) return res.status(404).json({ error: 'not found' });
  res.json(mem);
});

// ─── Sync Turn (called by provider.sync_turn) ──────────────────

// Skip short/greeting messages that aren't worth storing
const SKIP_PATTERNS = [
  /^(ok|okay|sure|yes|no|got it|thanks|thank you|done|continue|go ahead|please|yep|yeah|nope|cool|great|good|fine|right|correct|agreed)$/i,
  /^(hi|hello|hey|good morning|good afternoon|good evening|bye|goodbye|see you)$/i,
  /^\s*.{0,15}\s*$/, // Very short messages (<16 chars)
];

function shouldSkipMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
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
      let embedding = null;
      if (isEmbeddingReady()) {
        try { embedding = new Float32Array(await embed(user_message)).buffer; } catch {}
      }
      memories.push({ session_id, type, text: user_message.trim().substring(0, 500), embedding, metadata: { source: 'user', timestamp: now } });
    }

    // Store assistant response — skip very short responses
    if (assistant_response?.trim() && !shouldSkipMessage(assistant_response)) {
      let embedding = null;
      if (isEmbeddingReady()) {
        try { embedding = new Float32Array(await embed(assistant_response.substring(0, 500))).buffer; } catch {}
      }
      memories.push({ session_id, type: 'fact', text: assistant_response.trim().substring(0, 500), embedding, metadata: { source: 'assistant', timestamp: now } });
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
          try { embedding = new Float32Array(await embed(m.text)).buffer; } catch {}
        }
        const id = storeMemory({ session_id, type: m.type, text: m.text, embedding });
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
      const vec = new Float32Array(embeddings[i]).buffer;
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
        try { embedding = new Float32Array(await embed(m.text)).buffer; } catch {}
      }
      const id = storeMemory({ session_id, type: m.type, text: m.text, embedding });
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

// Handle uncaught errors gracefully
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  shutdown('UNCAUGHT_EXCEPTION');
});
