<div align="center">

# 🧠 Noxem

**Persistent memory that makes agents actually remember**

*Remembers what matters. Forgets what doesn't.*

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org/)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![Platform](https://img.shields.io/badge/Platform-Win%20%7C%20Linux%20%7C%20macOS-0078D4?style=flat-square)]()

---

[✨ Features](#-features) · [🆕 What's New](#-whats-new) · [🚀 Quick Start](#-quick-start) · [🏗️ Architecture](#️-architecture) · [🔧 Config](#-configuration) · [📊 Benchmarks](#-benchmarks) · [🤝 Contributing](#-contributing)

</div>

---

## 🆕 What's New (v2.1)

Phase 1 ships major upgrades to both brains:

| Feature | Brain | Description |
|:--------|:------|:------------|
| **Knowledge Graph** | Brain 1 | `memory_edges` table + `WITH RECURSIVE` CTE traversal for multi-hop relationship queries |
| **Core Memory** | Brain 2 | Always-in-context key-value blocks (Letta-style). Zero-latency, agent-editable |
| **Async Write Path** | Brain 1 | Store/sync return immediately — embedding computed in background queue |
| **Semantic Query Cache** | Brain 1 | LRU cache keyed by query embedding hash (cosine >0.95 = hit, 5min TTL) |
| **Citation Tracking** | Brain 2 | Auto-logs which memories influenced LLM responses, feeds back into decay |
| **Progressive Compression** | Brain 2 | 4 levels (raw → key phrases → one-line → keywords) + `memory_raw` drill-down |
| **Enhanced Prefetch** | Brain 1 | Entity expansion, graph neighbor traversal, core memory injection in pre-LLM hook |
| **Graph Edge Extraction** | Brain 2 | Rule-based `EDGE_PATTERNS` on sync_turn (5 relation types) |
| **Reflection & Summary** | Brain 2 | New memory types with dedicated Weibull decay profiles |
| **SQLite Optimizations** | Brain 1 | Covering indexes, 64 MiB page cache, WAL tuning |

---

## ✨ Features

<table>
<tr>
<td width="50%">

### :brain: Brain 1 — Semantic Engine

| | |
|---|---|
| 🔍 **Hybrid Search** | Vector KNN + FTS5 keyword, merged via Reciprocal Rank Fusion |
| 🏷️ **Auto-Categorization** | Tags: preference, project, profile, goal, entity, event, fact… |
| 🧹 **Smart Dedup** | Cosine >0.92 → merge automatically |
| ⚔️ **Conflict Resolution** | Entity-attribute matching → older superseded |
| 📝 **Contextual Enrichment** | Context prefix before indexing — ~49% better retrieval |
| 📉 **Weibull Decay** | Profiles never decay, requests expire in 3 days |
| 🔁 **Spaced Repetition** | Recalled memories stay relevant longer |
| 🎯 **Adaptive Search** | Classifies query intent, weights vector vs keyword |
| 🌐 **MMR Diversity** | No near-identical results in search |
| 🔗 **Provenance Graph** | Full lineage tracking through supersession history |
| 🕸️ **Knowledge Graph** | Temporal edges + recursive CTE traversal |
| ⚡ **Async Writes** | Store returns instantly, embedding queued in background |
| 💨 **Query Cache** | Semantic LRU cache — near-instant repeat searches |

</td>
<td width="50%">

### :rocket: Brain 2 — Reasoning Engine (Only for user have high RAM)

| | |
|---|---|
| 🛡️ **Drift Detection** | Warns when conversation goes off-goal |
| 💾 **Context Recovery** | Preserves critical info across compaction |
| 📤 **Session Extraction** | Stores key memories when session ends |
| 🔬 **Background Research** | Detects topics → web search → extract facts → store |
| 🧩 **Multi-Query Expansion** | Generates alternate phrasings for vague searches |
| 🗃️ **Consolidation** | Clusters low-importance → single high-importance summary |
| ✅ **Category Auto-Correction** | Catches and fixes misclassified memories |
| 📊 **Search Feedback Loop** | Boost importance for memories that influenced responses |
| ⏱️ **Bi-Temporal Tracking** | `valid_from` / `valid_until` timestamps |
| 📋 **Research Hints** | Compact summaries injected — no fact dump |
| 🧬 **Core Memory** | Always-in-context blocks, agent-editable, zero-latency |
| 📎 **Citation Tracking** | Tracks memory influence on responses, adjusts decay |
| 🗜️ **Progressive Compression** | 4 levels — search compressed, drill-down to raw |
| 🔗 **Graph Extraction** | Rule-based relationship extraction on sync_turn |
| 💭 **Reflection & Summary** | New decay-aware memory types for meta-cognition |

</td>
</tr>
</table---

> [!TIP]
> Run `hermes-noxem` to start. Choose **Brain 1 only** (fast, low RAM) or **Brain 1 + Brain 2** (full power). No `hermes memory setup` needed.

---

## 🚀 Quick Start

**Requirements:** Node.js 22+, Python 3.10+, Hermes Agent v2026+

### Linux / WSL

```bash
git clone https://github.com/LVT382009/noxem.git
cd noxem
bash install.sh
hermes-noxem
```

### macOS

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node
git clone https://github.com/LVT382009/noxem.git
cd noxem
bash install.sh
hermes-noxem
```

> [!NOTE]
> First run downloads brain components (~300 MB for Brain 1, ~2-3 GB total with Brain 2). Subsequent starts use the local cache.

### Brain Mode

When you run `hermes-noxem`, choose your mode:

| Mode | Enabled | Best for |
|:-----|:--------|:---------|
| **Brain 1 only** | Semantic search, dedup, categorization, FTS5, knowledge graph, query cache | Low RAM, quick lookups |
| **Brain 1 + Brain 2** | Everything + advisor, research, context recovery, core memory, citations, compression | Full sessions with research |

Skip the prompt with flags:

```bash
hermes-noxem --brain2    # Full mode, no prompt
hermes-noxem --no-brain2 # Memory-only, no prompt
```

---

## 🏗️ Architecture

```
Hermes Agent
│
▼
Noxem Plugin (Python) ──HTTP──► Noxem Server (Node.js :3001)
                                  │
                     ┌────────────┴────────────┐
                     │                         │
                Semantic Engine          Context Advisor
                ─────────────            ────────────────
                Vector KNN              Drift detection
                Knowledge Graph         Context recovery
                Dedup/categorize        Core Memory blocks
                Query cache             Citation tracking
                Async write queue       Progressive compression
                Importance score        Background research
                Prefetch hook           Graph edge extraction
                     │                         │
                     └────────────┬────────────┘
                                  │
                             SQLite DB
                         (FTS5 + Vectors +
                          Graph + Core + Raw)
```

---

## 🔄 Memory Lifecycle

```
Store ──► Enrich ──► Categorize ──► Extract Entity ──► Score Importance
  │          │          │               │                  │
  ▼          ▼          ▼               ▼                  ▼
SQLite   Context   Auto-tag       Entity+attr        0.1 – 1.0
+ FTS5   prefix    (14 types)      pairs             (type-based)
  │
  ├──► Async Embed Queue (background) ──► Vector Index
  │
  ├──► Graph Edge Extraction (rule-based) ──► memory_edges
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│                 Background Maintenance (every 5 min)    │
│                                                         │
│  Dedup ──► Contradict ──► Consolidate ──► Compress ──► Clean/Auto-correct │
└─────────────────────────────────────────────────────────┘
  │
  ▼
Search ──► Cache hit? ──► Hybrid (KNN + FTS5) ──► RRF ──► MMR ──► Score
              │              │                                         │
              ▼              ▼                                         ▼
         Near-instant    Graph expand                            Feedback:
         response        Core blocks inject                  +0.03 importance
```

---

## ⌨️ Commands

```bash
hermes-noxem              # Launch with interactive brain selection
hermes-noxem --brain2     # Launch full mode (no prompt)
hermes-noxem --no-brain2  # Launch memory-only (no prompt)

hermes noxem status       # Server health + memory stats
hermes noxem search <query>  # Search stored memories
hermes noxem run          # Run maintenance manually
hermes noxem config       # Show current configuration
```

---

## 🛠️ Available Tools

| Tool | Description |
|:-----|:------------|
| `memory_search` | Search with method: hybrid, vector, or keyword |
| `memory_store` | Store a fact with auto-categorization |
| `memory_supersede` | Mark old memory as superseded by newer one |
| `memory_lineage` | Trace provenance chain through supersession history |
| `memory_contradiction_check` | Find contradicting memories (same entity+attribute) |
| `memory_feedback` | Report which memory IDs influenced your response |

---

## 🌐 API Endpoints

### Core CRUD
- `POST /memory/store` — Store with auto-categorization + async embedding queue
- `POST /memory/store-batch` — Batch store with enrichment + bulk vector insert
- `GET /memory/search?q=...` — Hybrid search with adaptive RRF + MMR + Weibull scoring + query cache
- `GET /memory/:id` — Get a single memory
- `DELETE /memory/:id` — Delete a memory
- `GET /memory/stats` — Memory statistics

### Sync & Extraction
- `POST /memory/sync` — Sync conversation turn (user + assistant) with edge extraction
- `POST /memory/extract` — LLM-based memory extraction

### Knowledge Graph *(Phase 1)*
- `POST /memory/graph/edge` — Create an edge between two memories
- `GET /memory/graph/neighbors/:id` — Get outgoing + incoming edges for a memory
- `GET /memory/graph/traverse?from_id=N&max_depth=N` — Recursive CTE multi-hop traversal
- `GET /memory/graph/edges?relation=X&limit=N` — List edges (relation optional)
- `POST /memory/graph/edge/:id/invalidate` — Set `valid_until` on an edge

### Core Memory *(Phase 1)*
- `GET /memory/core` — List all core memory blocks
- `PUT /memory/core/:key` — Upsert a core memory block
- `GET /memory/core/:key` — Get a specific core memory block
- `DELETE /memory/core/:key` — Delete a core memory block

### Citations *(Phase 1)*
- `GET /memory/:id/citations` — Citation count for a memory (last 30 days)
- `GET /memory/citations/session/:sessionId` — Citation records for a session

### Compression *(Phase 1)*
- `POST /memory/compress` — Single-memory (`memory_id` + `target_level`) or batch compression
- `GET /memory/:id/raw` — Get original text for a compressed memory (drill-down)

### Context Injection
- `GET /memory/release` — Curated context with core blocks for LLM injection

### Provenance & Lineage
- `POST /memory/supersede` — Mark old memory as superseded
- `GET /memory/:id/lineage` — Trace provenance chain

### Contradiction Detection
- `POST /memory/contradiction-check` — Find contradicting memories

### Filtering
- `GET /memory/session/:sessionId` — Get memories by session (paginated)
- `GET /memory/type/:type` — Get memories by type (paginated)

### Maintenance
- `POST /memory/dedup` — On-demand dedup check
- `POST /memory/reembed` — Backfill missing embeddings
- `POST /memory/maintenance/run` — Run full maintenance cycle
- `POST /memory/purge` — Delete low-importance old memories

### Export / Import
- `GET /memory/export` — Export all active memories as JSON
- `POST /memory/import` — Import memories from JSON

### Advisor
- `POST /memory/advisor/compress` — Pre-compression context recovery
- `POST /memory/advisor/advice` — Get task-relevant advice
- `POST /memory/session/end` — Extract memories at session end

### Web Search
- `GET /search/web?q=...` — DuckDuckGo search

### Health
- `GET /health` — Server health + uptime + memory stats + core blocks count + query cache stats
- `GET /ready` — Startup readiness check

---

## 🔧 Configuration

| Variable | Default | Description |
|:---------|:--------|:------------|
| `MEMORY_PORT` | `3001` | Server port |
| `MEMORY_DB_DIR` | `./data` | Database directory |
| `DUP_THRESHOLD` | `0.92` | Deduplication sensitivity |
| `CONTRADICT_THRESHOLD` | `0.80` | Contradiction detection threshold |
| `ENABLE_MAINTENANCE` | `true` | Auto-cleanup every 5 minutes |
| `ENABLE_RESEARCH` | `true` | Background web research pipeline |
| `RESEARCH_MIN_INTERVAL` | `30000` | Min ms between research per session |
| `MEMORY_DECAY_HALF_LIFE` | `30` | Default recency decay (days) |
| `MEMORY_MAX_TOKENS` | `2000` | Token budget for context injection |
| `RATE_LIMIT_MAX` | `120` | Max requests per minute per IP |
| `AUTO_PURGE_DAYS` | `365` | Days before low-importance memories are purged |
| `HF_FETCH_TIMEOUT` | `180000` | Component download timeout (ms) |
| `HF_FETCH_RETRIES` | `3` | Retry count for failed component downloads |
| `HF_ENDPOINT` | *(empty)* | Mirror URL for component downloads |

<details>
<summary>📋 Full env variable list</summary>

| Variable | Default | Description |
|:---------|:--------|:------------|
| `ENABLE_EMBEDDING` | `true` | Enable Brain 1 semantic engine |
| `ENABLE_ADVISOR` | `true` | Enable Brain 2 advisor |
| `EMBEDDING_MODEL` | `default` | Brain 1 engine identifier |
| `EMBEDDING_DTYPE` | `q8` | Engine precision (fp32/q8/q4) |
| `EMBEDDING_DIM` | `256` | Brain 1 vector dimension |
| `EMBEDDING_LOAD_RETRIES` | `2` | Brain 1 engine retry count |
| `EMBEDDING_LOAD_TIMEOUT` | `300000` | Brain 1 engine load timeout (ms) |
| `EMBEDDING_CLEAR_CACHE_ON_RETRY` | `false` | Clear engine cache on retry |
| `LLM_LOAD_RETRIES` | `2` | Component download retry count |
| `MEMORY_MAX_RESULTS` | `5` | Default search result limit |
| `MEMORY_API_KEY` | *(empty)* | Bearer token for API auth |
| `CORS_ORIGIN` | `http://localhost:*` | CORS allowed origins |
| `LOG_LEVEL` | `info` | Log verbosity (`quiet` = suppress request logs) |

</details>

---

## 📊 Benchmarks

Tested on WSL2 Ubuntu, Node.js 22. Run your own: `cd server && bash benchmark.sh`

| Operation | Latency | Notes |
|:----------|:--------|:------|
| Store (single) | ~23 ms | Async — returns instantly, embedding queued |
| Store (batch 50) | ~0.6 ms each | Bulk insert, single transaction |
| Search (hybrid) | ~25 ms | Vector KNN + FTS5 via RRF (cache hit: <1 ms) |
| Search (FTS) | ~26 ms | Full-text with Weibull scoring |
| Sync turn | ~20 ms | Store user + assistant + edge extraction |
| Graph traverse | ~5 ms | WITH RECURSIVE CTE, max depth 3 |
| Core memory get | ~1 ms | SQLite lookup, zero-latency |
| Compression (single) | ~2 ms | Rule-based, 3 compression levels |
| Maintenance cycle | ~18 ms | Dedup + contradiction + consolidation + archive |

> [!NOTE]
> With Brain 1 enabled, hybrid search adds ~5-10 ms for vector KNN lookup. Brain 1 loads in the background without blocking server startup. Query cache makes repeat searches near-instant.

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

<div align="center">

## License

MIT © [LVT382009](https://github.com/LVT382009)

</div>
