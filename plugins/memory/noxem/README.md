# Noxem — AI Memory Provider for Hermes

## Architecture

**Two-brain AI memory system:**

| Brain | Model | Role |
|-------|-------|------|
| **Vector Brain** | EmbeddingGemma 300M (ONNX) | Semantic search, dedup, contradiction detection, categorization |
| **Advisor Brain** | Gemma 4 E2B (ONNX) | Context recovery, task drift detection, DDG web search, session analysis |

## Data Flow

```
Hermes Agent ←→ Noxem Provider Plugin ←HTTP→ Memory Server (Node.js, port 3001)
                                                 ├── EmbeddingGemma 300M (vector engine)
                                                 ├── Gemma 4 E2B (advisor engine)
                                                 ├── SQLite + FTS5 + embeddings
                                                 ├── DuckDuckGo search
                                                 └── Maintenance cron (dedup/cleanup)
```

## Setup

1. Start the memory server:
   ```bash
   cd ~/hermes-memory/server && npm start
   ```

2. Make sure the memory server is listed:
   ```bash
   hermes memory setup
   # Select "noxem" from the provider list
   ```

3. Verify:
   ```bash
   hermes noxem status
   ```

## Requirements

- Node.js 20+ (for the memory server)
- Python 3.10+ (for the Hermes plugin)
- Gemma 4 E2B ONNX model running on port 8000 (optional, for advisor)
- EmbeddingGemma 300M downloads on first server start

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NOXEM_SERVER` | `http://127.0.0.1:3001` | Memory server URL |
| `GEMMA_URL` | `http://127.0.0.1:8000/v1/chat/completions` | Gemma 4 API |
| `MEMORY_DB_DIR` | `./data` | SQLite DB path |

## CLI Commands

```bash
hermes noxem status    # Server status + memory stats
hermes noxem search <query>  # Search memories
hermes noxem advice    # Advisor analysis
hermes noxem config    # Show config
hermes noxem run       # Run maintenance manually
```