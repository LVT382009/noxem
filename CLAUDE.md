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
│   │   - Multi-query expansion for vague searches
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
6. **Bi-temporal Track** — `valid_from`/`valid_until` timestamps track when memories are current
7. **Dedup** — Cron (5min): cosine >0.92 → merge, mark older as invalid
8. **Contradict** — Entity-attribute matching + cosine similarity → older marked superseded
9. **Consolidate** — Significance-gated: 3+ low-importance clustered memories (cosine >0.75) → single high-importance summary
10. **Clean** — Invalid memories purged; stale (90d, 0 recalls) archived
11. **Search** — Hybrid (EmbeddingGemma KNN + FTS5 via Reciprocal Rank Fusion) with MMR diversity + multi-query expansion
12. **Score** — Recency + importance + spaced-repetition weighting (type-specific half-lives)
13. **Recover** — `on_pre_compress`: Gemma 4 preserves critical context
14. **Advise** — Gemma 4 + DDG web search watches for task drift

## Scoring System

### Type-Specific Weibull Decay

Memories decay using Weibull function: `w = exp(-(age/eta)^k)`

| Type | eta (days) | k (shape) | Behavior |
|------|-----------|-----------|----------|
| profile | ∞ | 1.0 | Never decays |
| preference | 180 | 1.2 | Slow start, long tail |
| setup | 120 | 1.3 | Moderate acceleration |
| project | 60 | 1.4 | Evolving decay |
| goal | 45 | 1.5 | Faster decay |
| pattern | 60 | 1.2 | Stable with tail |
| learning | 45 | 1.1 | Slightly better retention |
| entity | 90 | 1.1 | Stable |
| fact | 30 | 1.0 | Standard exponential |
| issue | 14 | 2.0 | Sharp cutoff (resolves or lingers) |
| event | 7 | 2.5 | Very fast decay |
| request | 3 | 3.0 | Extremely ephemeral |

k > 1 = aging accelerates over time; k = 1 = standard exponential; k < 1 = rapid initial then slow

### Composite Score Formula

```
final_score = similarity × (0.4 + 0.25 × recency + 0.2 × importance + 0.15 × reinforcement)
```

- `recency = exp(-(age/eta)^k)` — Weibull decay with type-specific (eta, k)
- `effective_eta = eta_base × (0.5 + importance) × (1 + 0.3 × recall_count)` — SRS extends lifespan
- `reinforcement = 1 - e^(-recall_count / 3)` — exponential approach to 1.0
- `importance_boost = +0.01 per recall` — capped at 1.0

### Adaptive Search Weighting

Hybrid search classifies query intent and weights embedding vs FTS accordingly:

| Intent | Vector Weight | FTS Weight | Trigger |
|--------|--------------|------------|---------|
| identifier | 0.15 | 0.85 | camelCase, file paths, code keywords |
| exact | 0.30 | 0.70 | quoted strings, error/debug terms, HTTP verbs |
| conceptual | 0.70 | 0.30 | preferences, WH-questions, short queries |
| mixed | 0.45 | 0.55 | Default balanced |

### Contextual Enrichment

Before embedding, a context prefix is prepended to the text (Anthropic contextual retrieval technique):
- `"Preference, about user's prefer dark mode: I prefer dark mode for VS Code"`
- This anchors the embedding to its origin, reducing retrieval failures by ~49%

### Significance-Gated Consolidation

When 3+ low-importance memories (importance <0.5) about the same entity cluster together (cosine >0.75):
- Clustered memories are merged into a single summary
- Originals are marked superseded with bi-temporal tracking
- New memory gets importance = max(cluster) + 0.2 (capped at 1.0)
- Source memory IDs are tracked for provenance graph

### Multi-Query Expansion

For short queries (<6 words), Gemma 4 generates 2 alternate phrasings:
- All variants are searched independently
- Results merged via Reciprocal Rank Fusion
- Improves recall for vague or imprecise queries

## API Endpoints

### Core CRUD
- `POST /memory/store` — Store a memory with auto-categorization, entity extraction, importance estimation, contextual enrichment, bi-temporal `valid_from`
- `POST /memory/store-batch` — Batch store with enrichment + vector index bulk insert
- `GET /memory/search?q=...&limit=N&method=hybrid|embedding|fts&session_id=...&expand=true|false` — Hybrid search with adaptive RRF weighting + MMR + Weibull recency scoring + session filter + multi-query expansion
- `GET /memory/:id` — Get a single memory (includes all fields)
- `DELETE /memory/:id` — Delete a memory by ID
- `GET /memory/stats` — Memory statistics

### Sync & Extraction
- `POST /memory/sync` — Sync a conversation turn (user + assistant) with entity extraction + importance
- `POST /memory/extract` — LLM-based memory extraction

### Provenance & Lineage
- `POST /memory/supersede` — Mark old memory as superseded by new, with reason tracking + bi-temporal `valid_from`/`valid_until` + `source_memory_ids`
- `GET /memory/:id/lineage` — Trace provenance chain through supersession history (includes bi-temporal data)

### Contradiction Detection
- `POST /memory/contradiction-check` — Find memories with same entity+attribute that express different values

### Filtering
- `GET /memory/session/:sessionId?limit=N&offset=N` — Get memories by session (paginated)
- `GET /memory/type/:type?limit=N&offset=N` — Get memories by type (paginated)

### Maintenance
- `POST /memory/dedup` — On-demand dedup check (dry run or auto_mark). Returns duplicate pairs with similarity scores
- `POST /memory/reembed` — Backfill embeddings for memories missing them
- `POST /memory/maintenance/run` — Run dedup + contradiction + consolidation + archive cycle
- `POST /memory/maintenance/stop` — Stop maintenance cron
- `POST /memory/purge` — Delete low-importance old memories (importance <0.3, 0 recalls, older than AUTO_PURGE_DAYS)

### Export / Import
- `GET /memory/export` — Export all active memories as JSON (backup)
- `POST /memory/import` — Import memories from JSON (restore/migration)

### Advisor
- `POST /memory/advisor/compress` — Pre-compression context recovery
- `POST /memory/advisor/advice` — Get task-relevant advice
- `POST /memory/session/end` — Extract memories at session end

### Web Search
- `GET /search/web?q=...` — DuckDuckGo search

### Health
- `GET /health` — Server health + uptime + memory stats + gemma4 status + feature flags
- `GET /ready` — Startup readiness check

## Python Plugin Tools

The Noxem plugin exposes these tools to Hermes:
- `memory_search` — Search with method selection (hybrid/embedding/fts)
- `memory_store` — Store with type categorization
- `memory_supersede` — Mark old as superseded by new
- `memory_lineage` — Trace provenance chain
- `memory_contradiction_check` — Check for contradicting memories

## Quick Start

```bash
# Start memory server
cd server && npm start

# Enable in Hermes
hermes memory setup # Select "noxem"

# Verify
hermes noxem status

# Run integration tests (34 tests)
cd server && bash run-test.sh
```

## Files

| File | Purpose |
|------|---------|
| `plugins/memory/noxem/__init__.py` | Hermes MemoryProvider plugin (5 tools: search, store, supersede, lineage, contradiction) |
| `plugins/memory/noxem/plugin.yaml` | Plugin metadata |
| `plugins/memory/noxem/cli.py` | `hermes noxem` CLI commands |
| `server/memory-server.mjs` | Express API server |
| `server/memory-store.mjs` | SQLite + FTS5 + embeddings + entity/attribute + bi-temporal |
| `server/embedding-engine.mjs` | EmbeddingGemma 300M + entity extraction + context prefix + importance |
| `server/vector-index.mjs` | sqlite-vec native KNN (optional, falls back to JS cosine) |
| `server/memory-extract.mjs` | LLM memory extraction |
| `server/advisor-engine.mjs` | Gemma 4 advisor + DDG |
| `server/ddg-search.mjs` | DuckDuckGo search |
| `server/memory-maintenance.mjs` | Cron: dedup/contradiction/consolidation/archive |
| `server/gemma4-server.mjs` | Gemma 4 model server (retry + fallback + graceful shutdown) |
| `server/run-test.sh` | Integration test script (34 tests, WSL compatible) |
| `server/run-embedding-test.sh` | Embedding E2E test script (full vector pipeline) |
| `hooks/pre-llm-memory.mjs` | Shell hook: prefetch memories before LLM call |
| `hooks/post-llm-extract.mjs` | Shell hook: extract memories after LLM response |

## Database Schema

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'general', -- categorization
  text TEXT NOT NULL, -- memory content
  embedding BLOB, -- EmbeddingGemma vector (256d float32)
  status TEXT NOT NULL DEFAULT 'active', -- active/superseded/invalid/archived
  superseded_by INTEGER REFERENCES memories(id), -- lineage tracking
  metadata TEXT NOT NULL DEFAULT '{}', -- JSON: source, extraction_method, origin_session_id, stored_at
  importance REAL NOT NULL DEFAULT 0.5, -- 0.1-1.0 importance score
  context_prefix TEXT NOT NULL DEFAULT '', -- Anthropic contextual retrieval prefix
  entity TEXT NOT NULL DEFAULT '', -- extracted entity (e.g., "user")
  attribute TEXT NOT NULL DEFAULT '', -- extracted attribute (e.g., "prefer_dark_mode")
  recall_count INTEGER NOT NULL DEFAULT 0, -- spaced repetition tracking
  last_recalled_at TEXT, -- last recall timestamp
  valid_from TEXT, -- bi-temporal: when this memory became current
  valid_until TEXT, -- bi-temporal: when this memory was superseded
  source_memory_ids TEXT NOT NULL DEFAULT '[]', -- provenance graph: IDs this was derived from
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 for keyword search
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content='memories', content_rowid='id');

-- Vector index (optional, via sqlite-vec)
CREATE VIRTUAL TABLE memory_vecs USING vec0(embedding float[256] distance_metric=cosine);

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
| `RATE_LIMIT_MAX` | `120` | Max requests per minute per IP (0 = disable) |
| `AUTO_PURGE_DAYS` | `365` | Days after which low-importance memories are purged |
| `CORS_ORIGIN` | `http://localhost:* http://127.0.0.1:*` | CORS allowed origins |
| `MEMORY_API_KEY` | (empty = disabled) | Bearer token for API auth. Health/ready endpoints exempt |
| `EMBEDDING_LOAD_TIMEOUT` | `300000` | Embedding model load timeout (ms) |
| `EMBEDDING_CLEAR_CACHE_ON_RETRY` | `false` | Clear cache on retry (set `true` for corrupt cache) |
| `LOG_LEVEL` | `info` | Log verbosity (`silent` to suppress request logs) |
