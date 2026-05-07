import express from 'express';
import cors from 'cors';
import { initEmbeddingEngine, isEmbeddingReady, getEmbeddingError, embed, embedBatch, searchByEmbedding, categorizeText } from './embedding-engine.mjs';
import {
  storeMemory, storeMemories, searchMemories, getMemory, getActiveMemories,
  getAllActiveMemories, getSessionMemories, getMemoriesByType,
  getActiveWithEmbedding, getMemoryStats, updateMemoryStatus, updateMemoryType,
  deleteMemory, deleteInvalid, close,
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
    advisor: ENABLE_ADVISOR,
    maintenance: ENABLE_MAINTENANCE,
    mode: 'hybrid-ai',
  });
});

app.get('/ready', (_req, res) => {
  if (startupComplete) return res.json({ ok: true });
  res.status(503).json({ ok: false, message: 'still starting up' });
});

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
  try {
    const { q, session_id, limit, method } = req.query;
    if (!q?.trim()) return res.status(400).json({ error: 'query "q" required' });

    const limitNum = limit ? parseInt(limit) : 10;

    // Embedding search (primary)
    if ((!method || method === 'hybrid' || method === 'embedding') && isEmbeddingReady()) {
      try {
        const qVec = await embed(q.trim(), 'query');
        const allMemories = getAllActiveMemories();
        const results = searchByEmbedding(qVec, allMemories, limitNum);

        if (results.length > 0 && method === 'embedding') {
          return res.json({
            ok: true,
            method: 'embedding',
            results,
          });
        }

        // Hybrid: merge FTS + embedding results
        if (method === 'hybrid' || !method) {
          const ftsResults = searchMemories({ query: q, limit: limitNum });
          // Deduplicate by id, prefer embedding (scored)
          const seen = new Set(results.map(r => r.id));
          for (const r of ftsResults) {
            if (!seen.has(r.id)) {
              results.push({ ...r, score: r.score * 0.5 });
              seen.add(r.id);
            }
          }
          return res.json({
            ok: true,
            method: 'hybrid',
            results: results.sort((a, b) => b.score - a.score).slice(0, limitNum),
          });
        }
      } catch { /* fall through to FTS */ }
    }

    // FTS fallback
    const results = searchMemories({ query: q, limit: limitNum });

    if (session_id) {
      return res.json({
        ok: true,
        method: 'fts',
        results: results.filter(r => r.session_id === session_id),
      });
    }

    res.json({ ok: true, method: 'fts', results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/memory/:id', (req, res) => {
  const mem = getMemory(parseInt(req.params.id));
  if (!mem) return res.status(404).json({ error: 'not found' });
  res.json(mem);
});

app.get('/memory/session/:sessionId', (req, res) => {
  const { limit } = req.query;
  res.json({ results: getSessionMemories(req.params.sessionId, limit ? parseInt(limit) : 50) });
});

app.get('/memory/type/:type', (req, res) => {
  const { limit } = req.query;
  res.json({ results: getMemoriesByType(req.params.type, limit ? parseInt(limit) : 50) });
});

app.get('/memory/stats', (_req, res) => {
  res.json(getMemoryStats());
});

// ─── Sync Turn (called by provider.sync_turn) ──────────────────
app.post('/memory/sync', async (req, res) => {
  try {
    const { user_message, assistant_response, session_id } = req.body;
    if (!user_message && !assistant_response) {
      return res.status(400).json({ error: 'user_message or assistant_response required' });
    }

    const memories = [];
    const now = new Date().toISOString();

    // Store user message as memory
    if (user_message?.trim()) {
      const type = categorizeText(user_message);
      let embedding = null;
      if (isEmbeddingReady()) {
        try { embedding = new Float32Array(await embed(user_message)).buffer; } catch {}
      }
      memories.push({ session_id, type, text: user_message.trim().substring(0, 500), embedding, metadata: { source: 'user', timestamp: now } });
    }

    // Store assistant response key points
    if (assistant_response?.trim()) {
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
app.listen(PORT, '127.0.0.1', () => {
  console.log(`━━━━ Hermes AI Memory Server v2 ━━━━`);
  console.log(`  Port:       ${PORT}`);
  console.log(`  Embedding:  ${ENABLE_EMBEDDING ? 'EmbeddingGemma 300M' : 'DISABLED'}`);
  console.log(`  Advisor:    ${ENABLE_ADVISOR ? 'Gemma 4' : 'DISABLED'}`);
  console.log(`  Web Search: ${ENABLE_ADVISOR && process.env.ADVISOR_WEB_SEARCH !== 'false' ? 'DDG' : 'DISABLED'}`);
  console.log(`  Maintenance: ${ENABLE_MAINTENANCE ? 'ON (5min)' : 'DISABLED'}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});