<div align="center">

# 🧠 Noxem
**Persistent memory provider for Hermes Agent** — remembers what matters, forgets what doesn't.

![License](https://img.shields.io/badge/License-MIT-green)
![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python)
![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-0078D4)

---

[Features](#features) • [Quick Start](#quick-start) • [Architecture](#architecture) • [Commands](#commands) • [Configuration](#configuration) • [Contributing](#contributing)

</div>

---

## Features

| Feature | Description |
|---------|-------------|
| **Semantic Search** | Hybrid vector + keyword search — finds relevant context even with different wording |
| **Auto-Categorization** | Incoming memories are auto-tagged: preference, project, profile, goal, pattern, entity, event, issue, setup, learning, fact |
| **Smart Dedup** | Detects duplicate memories (cosine >0.92) and merges them automatically |
| **Conflict Resolution** | Entity-attribute matching detects contradicting memories — older ones are superseded |
| **Significance-Gated Consolidation** | Clusters 3+ low-importance memories about the same topic into a single high-importance summary |
| **Contextual Enrichment** | Prepends context prefixes before embedding for ~49% better retrieval (Anthropic technique) |
| **Weibull Decay** | Type-specific recency scoring — profile memories never decay, requests expire in 3 days |
| **Spaced Repetition** | Memories recalled more often stay relevant longer — reinforced through use |
| **Search Feedback Loop** | Report which memories influenced your response for stronger importance boost |
| **Background Research** | Auto-detects technical topics in conversation → web search → extract facts → store as learning memories |
| **Research Hints** | Compact topic summaries injected into context so Hermes knows research exists without dumping all facts |
| **Category Auto-Correction** | Rule-based validation catches misclassified memories and corrects them during maintenance |
| **Adaptive Search Weighting** | Classifies query intent (identifier/exact/conceptual) and weights vector vs keyword search accordingly |
| **Context Recovery** | Preserves critical information across session boundaries and context compaction |
| **Bi-Temporal Tracking** | `valid_from`/`valid_until` timestamps track when memories are current vs superseded |
| **Provenance Graph** | Full lineage tracking — trace any memory through its supersession history and source memory IDs |
| **Auto-Start** | Servers start automatically when Hermes runs — no manual setup needed |
| **Multi-Query Expansion** | Short queries get 2 alternate phrasings, merged via Reciprocal Rank Fusion for better recall |
| **MMR Diversity** | Maximal Marginal Relevance reranking prevents returning near-identical results |

---

## Quick Start

**Requirements:** Node.js 22+, Python 3.10+, Hermes Agent v2026+

### Linux / WSL

```bash
# 1. Clone the repo
git clone https://github.com/LVT382009/noxem.git
cd noxem

# 2. Run the installer
bash install.sh

# 3. Enable Noxem in Hermes, then run
hermes memory setup   # Select "noxem"
hermes chat           # Servers auto-start
```

### macOS

```bash
# 1. Install Xcode Command Line Tools
xcode-select --install

# 2. Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 3. Install Node.js 22+
brew install node

# 4. Clone and install
git clone https://github.com/LVT382009/noxem.git
cd noxem
bash install.sh

# 5. Enable and run
hermes memory setup   # Select "noxem"
hermes chat
```

### Windows (via WSL)

Open Command Prompt or PowerShell, then:

```cmd
:: Option A: use the Windows batch installer
install.bat

:: Option B: do it manually inside WSL
wsl -d Ubuntu
git clone https://github.com/LVT382009/noxem.git
cd noxem
bash install.sh
hermes memory setup
hermes chat
```

> **First run** downloads AI models (~2-3 GB total). Subsequent starts use the local cache. No manual server startup needed — both servers auto-start when Hermes launches.

---

## Architecture

```
Hermes Agent
    │
    ▼
Noxem Plugin (Python) ──HTTP──► Noxem Server (Node.js, port 3001)
    │                                │
    │                          ┌─────┴─────┐
    │                          │           │
    │                     Semantic     Context
    │                     Engine      Advisor
    │                          │           │
    │                          └─────┬─────┘
    │                                │
    │                           SQLite DB
    │                        (FTS5 + Vectors)
    │
    └── Tools: memory_search, memory_store,
        memory_supersede, memory_lineage,
        memory_contradiction_check, memory_feedback
```

Two AI processing layers work together — a **semantic engine** for vector search, dedup, and categorization, and a **context advisor** for task drift detection, context recovery, and background web research. Both feed into a shared SQLite store with FTS5 full-text search and native KNN vector indexing.

---

## Memory Lifecycle

1. **Store** — Conversation turns saved with auto-categorization, entity extraction, and importance scoring
2. **Enrich** — Context prefix prepended to embedding input for better retrieval
3. **Categorize** — Auto-tagged: preference, project, profile, request, learning, setup, goal, issue, pattern, entity, event, fact
4. **Dedup** — Cosine >0.92 → merge, mark older as invalid
5. **Contradict** — Entity-attribute matching → older marked superseded
6. **Consolidate** — 3+ low-importance clustered memories → single high-importance summary
7. **Clean** — Invalid memories purged; stale (90d, 0 recalls) archived
8. **Search** — Hybrid (vector + FTS5 via Reciprocal Rank Fusion) with MMR diversity
9. **Score** — Recency + importance + spaced-repetition weighting (type-specific Weibull decay)
10. **Research** — Background: detect technical topic → web search → fetch pages → extract facts → store
11. **Recover** — Context advisor preserves critical info across compaction
12. **Feedback** — Search results that influenced the response get +0.03 importance boost

---

## Commands

```bash
# Hermes CLI (after plugin is installed)
hermes noxem status       # Server health + memory stats
hermes noxem search <query>  # Search stored memories
hermes noxem run           # Run maintenance manually
hermes noxem config        # Show current configuration
```

---

## Available Tools (Hermes)

| Tool | Description |
|------|-------------|
| `memory_search` | Search with method selection: hybrid, embedding, or fts |
| `memory_store` | Store a fact with auto-categorization |
| `memory_supersede` | Mark an old memory as superseded by a newer one |
| `memory_lineage` | Trace provenance chain through supersession history |
| `memory_contradiction_check` | Check for contradicting memories with same entity+attribute |
| `memory_feedback` | Report which memory IDs influenced your response (improves ranking) |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
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

---

## Data Flow

```
User says something
    │
    ▼
Noxem checks memory ──► Relevant past context injected
    │
    ▼
Turn is processed
    │
    ▼
Key info extracted ──► Stored with vector index + categorization
    │
    ▼
Background research ──► Technical topic? → web search → facts stored
    │
    ▼
Background cleanup ──► Duplicates merged, conflicts resolved, categories corrected
```

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## License

MIT © LVT382009
