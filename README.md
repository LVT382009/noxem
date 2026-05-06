<div align="center">

# 🧠 Noxem

**Persistent memory provider for Hermes Agent** — remembers what matters, forgets what doesn't.

![License](https://img.shields.io/badge/License-MIT-green)
![Node](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js)
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
| **Vector Search** | Semantic memory lookup — finds relevant context even with different wording |
| **Auto-Dedup** | Smart deduplication keeps your memory clean and concise |
| **Conflict Resolution** | Automatically resolves contradictory information, keeping only what's current |
| **Context Recovery** | Preserves critical information across session boundaries |
| **Web-Augmented** | Can fetch fresh information when context needs verification |
| **Hybrid Queries** | Combines multiple search strategies for best results |

---

## Quick Start

```bash
# 1. Install everything
bash install.sh

# 2. Launch Hermes with Noxem (auto-starts both servers)
hermes-noxem

# Or manually:
#   cd server && npm install && node memory-server.mjs
#   node gemma4-server.mjs
#   hermes chat
```

**Requirements:** Node.js 22+, Python 3.10+, Hermes Agent v2026+

### macOS Prerequisites

```bash
# 1. Install Xcode Command Line Tools
xcode-select --install

# 2. Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 3. Install Node.js 22+
brew install node

# 4. Run the installer (same as Linux)
bash install.sh
```

> **Apple Silicon (M1–M4):** The Gemma 4 model uses CPU by default on macOS — Apple Silicon CPUs are fast enough for q4f16 inference. To force WebGPU: `export GEMMA4_DEVICE=webgpu` before launching.

---

## Architecture

```
Hermes Agent
      │
      ▼
Noxem Plugin ──HTTP──► Noxem Server (port 3001)
                           │
                      ┌────┴────┐
                      │         │
                   Vector      Search
                   Engine      Engine
                      │         │
                      └────┬────┘
                           │
                        SQLite
                     (FTS5 + Vectors)
```

Two processing layers work together — a **vector engine** for semantic understanding and a **search engine** for precise lookups. Both feed into a shared SQLite store.

---

## Commands

```bash
# Server management
npm start                           # Start the memory server

# Hermes CLI (after plugin is installed)
hermes noxem status                 # Server health + memory stats
hermes noxem search <query>         # Search stored memories
hermes noxem run                    # Run maintenance manually
hermes noxem config                 # Show current configuration
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_PORT` | `3001` | Server port |
| `MEMORY_DB_DIR` | `./data` | Database directory |
| `GEMMA_URL` | `http://127.0.0.1:8000` | Model server endpoint |
| `GEMMA4_DEVICE` | `webgpu` (Win/Lin), `cpu` (macOS) | Inference device |
| `DUP_THRESHOLD` | `0.92` | Deduplication sensitivity |
| `ENABLE_MAINTENANCE` | `true` | Auto-cleanup every 5 minutes |

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
Key information extracted ──► Stored with vector index
      │
      ▼
Background cleanup ──► Duplicates merged, conflicts resolved
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