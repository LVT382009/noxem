<div align="center">

# 🧠 Noxem 4
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
| **Vector Search** | Semantic memory lookup — finds relevant context even with different wording |
| **Auto-Dedup** | Smart deduplication keeps your memory clean and concise |
| **Conflict Resolution** | Automatically resolves contradictory information, keeping only what's current |
| **Context Recovery** | Preserves critical information across session boundaries |
| **Web-Augmented** | Can fetch fresh information when context needs verification |
| **Hybrid Queries** | Combines multiple search strategies for best results |

---

## Quick Start

**Requirements:** Node.js 22+, Python 3.10+, Hermes Agent v2026+

### Linux / WSL

```bash
# 1. Clone the repo
git clone https://github.com/LVT382009/noxem.git
cd noxem

# 2. Run the installer (deps + plugin + hooks)
bash install.sh

# 3. Launch Hermes with Noxem (auto-starts both servers)
hermes-noxem
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

# 5. Launch
hermes-noxem
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
hermes-noxem
```

### Manual Start (any OS)

```bash
# Start each component separately
cd server && npm install
node memory-server.mjs     # Memory server (port 3001)
node gemma4-server.mjs     # Gemma 4 advisor (port 8000)
hermes chat                # Hermes agent
```

> **Apple Silicon (M1-M4):** The Gemma 4 model uses CPU by default on macOS — Apple Silicon CPUs are fast enough for q4f16 inference. To force WebGPU: `export GEMMA4_DEVICE=webgpu` before launching.

> **First run** downloads the models (~2-3 GB total). Subsequent starts use the local cache.

---

## Architecture

```
Hermes Agent
      │
      ▼
Noxem Plugin ──HTTP──► Noxem Server (port 3001)
                              │
                    ┌─────────┴─────────┐
                    │                   │
              Embedding Engine     Advisor Engine
              (EmbeddingGemma)      (Gemma 4 E2B)
                    │                   │
                    └─────────┬─────────┘
                              │
                           SQLite
                      (FTS5 + Vectors)
```

Two processing layers work together — an **embedding engine** for semantic understanding and an **advisor engine** for context recovery and task drift detection. Both feed into a shared SQLite store.

---

## Commands

```bash
# Server management
npm start                    # Start the memory server

# Hermes CLI (after plugin is installed)
hermes noxem status          # Server health + memory stats
hermes noxem search <query>  # Search stored memories
hermes noxem run             # Run maintenance manually
hermes noxem config          # Show current configuration
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_PORT` | `3001` | Server port |
| `MEMORY_DB_DIR` | `./data` | Database directory |
| `GEMMA_URL` | `http://127.0.0.1:8000` | Model server endpoint |
| `GEMMA4_DEVICE` | `webgpu` (Win/Lin), `cpu` (macOS) | Inference device |
| `EMBEDDING_DTYPE` | `q8` | Embedding precision (fp32/q8/q4) |
| `EMBEDDING_DIM` | `256` | MRL embedding dimension (128/256/512/768) |
| `DUP_THRESHOLD` | `0.92` | Deduplication sensitivity |
| `CONTRADICT_THRESHOLD` | `0.80` | Contradiction detection threshold |
| `ENABLE_MAINTENANCE` | `true` | Auto-cleanup every 5 minutes |
| `MEMORY_DECAY_HALF_LIFE` | `30` | Default recency decay (days) |

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
