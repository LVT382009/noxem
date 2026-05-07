# Noxem — AI Memory Provider for Hermes Agent

## Two-Brain Architecture

```
Hermes Agent
│
├── Noxem Plugin (Python) ←→ Memory Server (Node.js :3001)
│   ├── Brain 1: EmbeddingGemma 300M
│   │   - Semantic memory search (KNN + JS cosine fallback)
│   │   - Contextual enrichment before embedding (Anthropic technique)
│   │   - Entity-attribute extraction for contradiction detection
│   │   - Deduplication (cosine >0.92)
│   │   - Auto-categorization + importance estimation
│   │
│   ├── Brain 2: Gemma 4 E2B
│   │   - Context recovery after compaction
│   │   - Task drift warnings
│   │   - DuckDuckGo web search
│   │   - Session-end memory extraction
│   │
│   └── SQLite + FTS5 + Embeddings + sqlite-vec
```

## Memory Lifecycle

1. **Store** — Conversation turns saved via `sync_turn` with contextual enrichment + EmbeddingGemma vector
2. **Enrich** — Context prefix prepended to embedding text for 49% better retrieval (Anthropic contextual retrieval)
3. **Categorize** — Auto-tagged: preference, project, profile, request, learning, setup, goal, issue, pattern, entity, event, fact
4. **Extract Entity** — Entity-attribute pairs extracted at store time for contradiction detection (e.g., `entity=user, attribute=prefer_dark_mode`)
5. **Estimate Importance** — Scored 0.1-1.0 based on type, content, and keywords (profile=0.9, trivial=0.1)
6. **Dedup** — Cron (5min): cosine >0.92 → merge, mark older as invalid
7. **Contradict** — Entity-attribute matching + cosine similarity → older marked superseded
8. **Clean** — Invalid memories purged; stale (90d, 0 recalls) archived
9. **Search** — Hybrid (EmbeddingGemma KNN + FTS5 via Reciprocal Rank Fusion) with MMR diversity
10. **Score** — Recency + importance + spaced-repetition weighting (type-specific half-lives)
11. **Recover** — `on_pre_compress`: Gemma 4 preserves critical context
12. **Advise** — Gemma 4 + DDG web search watches for task drift

## Scoring System

### Type-Specific Decay Half-Lives

Memories decay at different rates based on their type:

| Type | Half-Life | Rationale |
|------|-----------|-----------|
| profile | ∞ (never) | Identity never expires |
| preference | 180 days | Preferences change slowly |
| setup | 120 days | Tech stack changes quarterly |
| project | 60 days | Projects evolve monthly |
| pattern | 60 days | Habits are stable |
| goal | 45 days | Goals shift frequently |
| learning | 45 days | Learning persists |
| entity | 90 days | Entities are relatively stable |
| fact | 30 days | Generic facts |
| issue | 14 days | Issues get resolved |
| event | 7 days | Events are time-sensitive |
| request | 3 days | Requests are ephemeral |

### Composite Score Formula

```
final_score = similarity × (0.4 + 0.25 × recency + 0.2 × importance + 0.15 × reinforcement)
```

- `recency = 0.5^(age / effective_half_life)` — Ebbinghaus decay
- `effective_half_life = type_base × (0.5 + importance) × (1 + 0.3 × recall_count)` — SRS-style
- `reinforcement = 1 - e^(-recall_count / 3)` — exponential approach to 1.0

### Contextual Enrichment

Before embedding, a context prefix is prepended to the text (Anthropic contextual retrieval technique):
- `"Preference, about user's prefer dark mode: I prefer dark mode for VS Code"`
- This anchors the embedding to its origin, reducing retrieval failures by ~49%

## API Endpoints

### Core CRUD
- `POST /memory/store` — Store a memory with auto-categorization, entity extraction, importance estimation, contextual enrichment
- `POST /memory/store-batch` — Batch store with enrichment
- `GET /memory/search?q=...&limit=N&method=hybrid|embedding|fts` — Hybrid search with RRF + MMR + recency scoring
- `GET /memory/:id` — Get a single memory
- `GET /memory/stats` — Memory statistics

### Sync & Extraction
- `POST /memory/sync` — Sync a conversation turn (user + assistant)
- `POST /memory/extract` — LLM-based memory extraction

### Provenance & Lineage
- `POST /memory/supersede` — Mark old memory as superseded by new, with reason tracking
- `GET /memory/:id/lineage` — Trace provenance chain through supersession history

### Contradiction Detection
- `POST /memory/contradiction-check` — Find memories with same entity+attribute that express different values

### Filtering
- `GET /memory/session/:sessionId` — Get memories by session
- `GET /memory/type/:type` — Get memories by type

### Maintenance
- `POST /memory/reembed` — Backfill embeddings for memories missing them
- `POST /memory/maintenance/run` — Run dedup + contradiction + archive cycle
- `POST /memory/maintenance/stop` — Stop maintenance cron

### Advisor
- `POST /memory/advisor/compress` — Pre-compression context recovery
- `POST /memory/advisor/advice` — Get task-relevant advice
- `POST /memory/session/end` — Extract memories at session end

### Web Search
- `GET /search/web?q=...` — DuckDuckGo search

### Health
- `GET /health` — Server health + feature status
- `GET /ready` — Startup readiness check

## Quick Start

```bash
# Start memory server
cd server && npm start

# Enable in Hermes
hermes memory setup  # Select "noxem"

# Verify
hermes noxem status

# Run integration tests
cd server && bash run-test.sh
```

## Files

| File | Purpose |
|------|---------|
| `plugins/memory/noxem/__init__.py` | Hermes MemoryProvider plugin |
| `plugins/memory/noxem/plugin.yaml` | Plugin metadata |
| `plugins/memory/noxem/cli.py` | `hermes noxem` CLI commands |
| `server/memory-server.mjs` | Express API server |
| `server/memory-store.mjs` | SQLite + FTS5 + embeddings + entity/attribute |
| `server/embedding-engine.mjs` | EmbeddingGemma 300M + entity extraction + context prefix |
| `server/vector-index.mjs` | sqlite-vec native KNN (optional, falls back to JS cosine) |
| `server/memory-extract.mjs` | LLM memory extraction |
| `server/advisor-engine.mjs` | Gemma 4 advisor + DDG |
| `server/ddg-search.mjs` | DuckDuckGo search |
| `server/memory-maintenance.mjs` | Cron: dedup/contradiction/archive |
| `server/gemma4-server.mjs` | Gemma 4 model server (retry + fallback + graceful shutdown) |
| `server/run-test.sh` | Integration test script (WSL compatible) |
| `hooks/pre-llm-memory.mjs` | Shell hook: prefetch memories before LLM call |
| `hooks/post-llm-extract.mjs` | Shell hook: extract memories after LLM response |

## Database Schema

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'general',          -- categorization
  text TEXT NOT NULL,                              -- memory content
  embedding BLOB,                                  -- EmbeddingGemma vector (256d float32)
  status TEXT NOT NULL DEFAULT 'active',           -- active/superseded/invalid/archived
  superseded_by INTEGER REFERENCES memories(id),  -- lineage tracking
  metadata TEXT NOT NULL DEFAULT '{}',             -- JSON: source, extraction_method, origin_session_id, stored_at
  importance REAL NOT NULL DEFAULT 0.5,            -- 0.1-1.0 importance score
  context_prefix TEXT NOT NULL DEFAULT '',          -- Anthropic contextual retrieval prefix
  entity TEXT NOT NULL DEFAULT '',                  -- extracted entity (e.g., "user")
  attribute TEXT NOT NULL DEFAULT '',               -- extracted attribute (e.g., "prefer_dark_mode")
  recall_count INTEGER NOT NULL DEFAULT 0,         -- spaced repetition tracking
  last_recalled_at TEXT,                           -- last recall timestamp
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 for keyword search
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='id');

-- Vector index (optional, via sqlite-vec)
CREATE VIRTUAL TABLE memory_vecs USING vec0(embedding float[256]);

-- Indexes
CREATE INDEX idx_memories_session ON memories(session_id);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_created ON memories(created_at);
CREATE INDEX idx_memories_entity_attr ON memories(entity, attribute);
```

## Env Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_PORT` | `3001` | Server port |
| `ENABLE_EMBEDDING` | `true` | Load EmbeddingGemma 300M |
| `ENABLE_ADVISOR` | `true` | Enable Gemma 4 advisor |
| `ENABLE_MAINTENANCE` | `true` | Enable 5-min dedup cron |
| `GEMMA_URL` | `http://127.0.0.1:8000/v1/chat/completions` | Gemma 4 API |
| `EMBEDDING_MODEL` | `onnx-community/embeddinggemma-300m-ONNX` | Embedding model ID |
| `EMBEDDING_DTYPE` | `q8` | Embedding precision (fp32/q8/q4) |
| `EMBEDDING_DIM` | `256` | MRL embedding dimension (128/256/512/768) |
| `DUP_THRESHOLD` | `0.92` | Dedup cosine threshold |
| `CONTRADICT_THRESHOLD` | `0.80` | Contradiction threshold |
| `MEMORY_DECAY_HALF_LIFE` | `30` | Default recency decay half-life (days), overridden per type |
| `GEMMA4_LOAD_RETRIES` | `2` | Model download retry count |
| `EMBEDDING_LOAD_RETRIES` | `2` | Embedding model retry count |
| `MEMORY_DB_DIR` | `./data` | SQLite database directory |
| `MEMORY_MAX_RESULTS` | `5` | Default search result limit |
| `MEMORY_MAX_TOKENS` | `2000` | Token budget for prefetch injection |
