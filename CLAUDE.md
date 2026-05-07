# Noxem — AI Memory Provider for Hermes Agent

## Two-Brain Architecture

```
Hermes Agent
  │
  ├── Noxem Plugin (Python) ←→ Memory Server (Node.js :3001)
  │                                   ├── Brain 1: EmbeddingGemma 300M
  │                                   │   - Semantic memory search
  │                                   │   - Deduplication (cosine >0.92)
  │                                   │   - Contradiction detection (>0.80)
  │                                   │   - Auto-categorization
  │                                   │
  │                                   ├── Brain 2: Gemma 4 E2B
  │                                   │   - Context recovery after compaction
  │                                   │   - Task drift warnings
  │                                   │   - DuckDuckGo web search
  │                                   │   - Session-end memory extraction
  │                                   │
  │                                   └── SQLite + FTS5 + Embeddings
```

## Memory Lifecycle

1. **Store** — Every conversation turn saved via `sync_turn` with EmbeddingGemma vector
2. **Categorize** — Auto-tagged: preference, project, profile, request, learning, setup, goal, issue, pattern, entity, event, fact
3. **Dedup** — Cron (5min): cosine >0.92 → merge, mark older as invalid
4. **Contradiction** — Cron: same-entity opposite preferences → older marked superseded
5. **Clean** — Invalid memories purged
6. **Search** — Hybrid (embedding + FTS5) on `prefetch`
7. **Recover** — `on_pre_compress`: Gemma 4 preserves critical context
8. **Advise** — Gemma 4 + DDG web search watches for task drift

## Quick Start

```bash
# Start memory server
cd server && npm start

# Enable in Hermes
hermes memory setup   # Select "noxem"

# Verify
hermes noxem status
```

## Files

| File | Purpose |
|------|---------|
| `plugins/memory/noxem/__init__.py` | Hermes MemoryProvider plugin |
| `plugins/memory/noxem/plugin.yaml` | Plugin metadata |
| `plugins/memory/noxem/cli.py` | `hermes noxem` CLI commands |
| `server/memory-server.mjs` | Express API server |
| `server/memory-store.mjs` | SQLite + FTS5 + embeddings |
| `server/embedding-engine.mjs` | EmbeddingGemma 300M wrapper |
| `server/vector-index.mjs` | sqlite-vec native KNN (optional) |
| `server/memory-extract.mjs` | LLM memory extraction |
| `server/advisor-engine.mjs` | Gemma 4 advisor + DDG |
| `server/ddg-search.mjs` | DuckDuckGo search |
| `server/memory-maintenance.mjs` | Cron: dedup/contradiction/categorize |
| `hooks/pre-llm-memory.mjs` | Shell hook (backup) |
| `hooks/post-llm-extract.mjs` | Shell hook (backup) |

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
| `MEMORY_DECAY_HALF_LIFE` | `30` | Recency decay half-life in days |
| `GEMMA4_LOAD_RETRIES` | `2` | Model download retry count |
| `EMBEDDING_LOAD_RETRIES` | `2` | Embedding model retry count |