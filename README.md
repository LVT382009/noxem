<div align="center">

# 🧠 Noxem

**Persistent memory that makes AI agents actually remember**

*Remembers what matters. Forgets what doesn't.*

[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3776AB?style=flat-square&logo=python&logoColor=white)](https://python.org/)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![Platform](https://img.shields.io/badge/Platform-Win%20%7C%20Linux%20%7C%20macOS-0078D4?style=flat-square)]()

---

[✨ Features](#-features) · [🚀 Quick Start](#-quick-start) · [🏗️ Architecture](#️-architecture) · [🔧 Config](#-configuration) · [📊 Benchmarks](#-benchmarks) · [🤝 Contributing](#-contributing)

</div>

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
| 📝 **Contextual Enrichment** | Context prefix before embedding — ~49% better retrieval |
| 📉 **Weibull Decay** | Profiles never decay, requests expire in 3 days |
| 🔁 **Spaced Repetition** | Recalled memories stay relevant longer |
| 🎯 **Adaptive Search** | Classifies query intent, weights vector vs keyword |
| 🌐 **MMR Diversity** | No near-identical results in search |
| 🔗 **Provenance Graph** | Full lineage tracking through supersession history |

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

### Windows (via WSL)

```cmd
wsl -d Ubuntu
git clone https://github.com/LVT382009/noxem.git
cd noxem
bash install.sh
hermes-noxem
```

> [!NOTE]
> First run downloads AI models (~300 MB for Brain 1, ~2-3 GB total with Brain 2). Subsequent starts use the local cache.

### Brain Mode

When you run `hermes-noxem`, choose your mode:

| Mode | Enabled | Best for |
|:-----|:--------|:---------|
| **Brain 1 only** | Semantic search, dedup, categorization, FTS5 | Low RAM, quick lookups |
| **Brain 1 + Brain 2** | Everything + advisor, research, context recovery | Full sessions with research |

Skip the prompt with flags:

```bash
hermes-noxem --brain2      # Full mode, no prompt
hermes-noxem --no-brain2   # Memory-only, no prompt
```

---

## 🏗️ Architecture

```
  Hermes Agent
       │
       ▼
  Noxem Plugin (Python) ──HTTP──► Noxem Server (Node.js :3001)
       │                              │
       │                    ┌─────────┴─────────┐
       │                    │                   │
       │              Semantic Engine    Context Advisor
       │              ─────────────    ────────────────
       │              Vector KNN       Drift detection
       │              Dedup/categorize Context recovery
       │              Importance score Background research
       │                    │                   │
       │                    └─────────┬─────────┘
       │                              │
       │                     SQLite DB
       │                  (FTS5 + Vectors)
       │
       └── Tools: memory_search · memory_store ·
                  memory_supersede · memory_lineage ·
                  memory_contradiction_check · memory_feedback
```

---

## 🔄 Memory Lifecycle

```
  Store ──► Enrich ──► Categorize ──► Extract Entity ──► Score Importance
    │          │           │                │                  │
    ▼          ▼           ▼                ▼                  ▼
  SQLite    Context     Auto-tag      Entity+attr       0.1 – 1.0
  + FTS5    prefix      (12 types)    pairs              (type-based)
    │
    ▼
  ┌─────────────────────────────────────────────────────────┐
  │  Background Maintenance (every 5 min)                   │
  │                                                         │
  │  Dedup ──► Contradict ──► Consolidate ──► Clean/Auto-correct │
  └─────────────────────────────────────────────────────────┘
    │
    ▼
  Search ──► Hybrid (KNN + FTS5) ──► RRF merge ──► MMR rerank ──► Score
    │
    ▼
  Feedback: recalled memories get importance boost (+0.03)
```

---

## ⌨️ Commands

```bash
hermes-noxem                 # Launch with interactive brain selection
hermes-noxem --brain2        # Launch full mode (no prompt)
hermes-noxem --no-brain2     # Launch memory-only (no prompt)

hermes noxem status          # Server health + memory stats
hermes noxem search <query>  # Search stored memories
hermes noxem run             # Run maintenance manually
hermes noxem config          # Show current configuration
```

---

## 🛠️ Available Tools

| Tool | Description |
|:-----|:------------|
| `memory_search` | Search with method: hybrid, embedding, or fts |
| `memory_store` | Store a fact with auto-categorization |
| `memory_supersede` | Mark old memory as superseded by newer one |
| `memory_lineage` | Trace provenance chain through supersession history |
| `memory_contradiction_check` | Find contradicting memories (same entity+attribute) |
| `memory_feedback` | Report which memory IDs influenced your response |

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
| `HF_FETCH_TIMEOUT` | `180000` | Model download timeout (ms) |
| `HF_FETCH_RETRIES` | `3` | Retry count for failed model downloads |
| `HF_ENDPOINT` | _(empty)_ | HuggingFace mirror URL (auto-fallback on retry) |

<details>
<summary>📋 Full env variable list</summary>

| Variable | Default | Description |
|:---------|:--------|:------------|
| `ENABLE_EMBEDDING` | `true` | Load embedding model |
| `ENABLE_ADVISOR` | `true` | Enable Brain 2 advisor |
| `EMBEDDING_MODEL` | `onnx-community/embeddinggemma-300m-ONNX` | Embedding model ID |
| `EMBEDDING_DTYPE` | `q8` | Embedding precision (fp32/q8/q4) |
| `EMBEDDING_DIM` | `256` | MRL embedding dimension |
| `EMBEDDING_LOAD_RETRIES` | `2` | Embedding model retry count |
| `EMBEDDING_LOAD_TIMEOUT` | `300000` | Embedding model load timeout (ms) |
| `EMBEDDING_CLEAR_CACHE_ON_RETRY` | `false` | Clear cache on retry |
| `LLM_LOAD_RETRIES` | `2` | Model download retry count |
| `MEMORY_MAX_RESULTS` | `5` | Default search result limit |
| `MEMORY_API_KEY` | _(empty)_ | Bearer token for API auth |
| `CORS_ORIGIN` | `http://localhost:*` | CORS allowed origins |
| `LOG_LEVEL` | `info` | Log verbosity (`silent` to suppress) |

</details>

---

## 📊 Benchmarks

Tested on WSL2 Ubuntu, Node.js 22. Run your own: `cd server && bash benchmark.sh`

| Operation | Latency | Notes |
|:----------|:--------|:------|
| Store (single) | ~23 ms | Auto-categorization + entity extraction + FTS5 |
| Store (batch 50) | ~0.6 ms each | Bulk insert, single transaction |
| Search (hybrid) | ~25 ms | Vector KNN + FTS5 via RRF |
| Search (FTS) | ~26 ms | Full-text with Weibull scoring |
| Sync turn | ~20 ms | Store user + assistant messages |
| Maintenance cycle | ~18 ms | Dedup + contradiction + consolidation + archive |

> [!NOTE]
> With embedding enabled, hybrid search adds ~5-10 ms for vector KNN lookup. Embedding model loads in the background without blocking server startup.

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
