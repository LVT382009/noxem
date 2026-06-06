# Hermes AI Agent: Comprehensive Report

**Framework by Nous Research | Updated May 28, 2026**

---

## Overview

Hermes Agent is an open-source AI agent framework developed by [Nous Research](https://nousresearch.com/). Marketed with the tagline "The Agent That Grows With You," it distinguishes itself from other agent frameworks through a closed-loop self-improving system, persistent multi-layer memory, and broad platform integration. Unlike frameworks that treat each session as ephemeral, Hermes Agent accumulates operational knowledge across sessions by automatically distilling successful task sequences into reusable skill files.

The project is MIT-licensed and hosted on GitHub at [github.com/nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent). It is written in Python and uses SQLite with FTS5 for session persistence and memory search. The framework supports 18+ LLM providers, 70+ registered tools across approximately 28 toolsets, and 20 messaging platform adapters.

Hermes Agent should not be confused with the Hermes JavaScript engine (by Meta) or any messenger application of the same name. It is specifically an AI agent orchestration and runtime system designed for both local and cloud-based large language model interaction.

---

## Architecture & Design

### Core Orchestration Engine

The central component is **AIAgent** (`run_agent.py`), described as the synchronous orchestration engine. It handles provider selection, prompt construction, tool execution, retries, fallback logic, callbacks, context compression, and session persistence. The agent loop supports up to 90 iterations per conversation.

### Entry Points

Three primary entry points feed into AIAgent:

- **CLI** (`cli.py`) -- Interactive terminal user interface
- **Gateway** (`gateway/run.py`) -- Long-running messaging platform server supporting 20 platform adapters
- **ACP Adapter** (`acp_adapter/`) -- IDE integration via stdio/JSON-RPC for VS Code, Zed, and JetBrains

Additional entry points include a batch runner, API server, and Python library interface.

### Key Subsystems

| Subsystem | File | Purpose |
|-----------|------|---------|
| Prompt Builder | `prompt_builder.py` | Assembles system prompts from personality (SOUL.md), memory, skills, context files, and model-specific instructions |
| Provider Resolution | `runtime_provider.py` | Maps `(provider, model)` tuples to credentials and endpoints; handles 18+ providers |
| Tool Dispatch | `model_tools.py` | Routes tool calls via central registry; 70+ registered tools across ~28 toolsets |
| Context Compressor | `agent/context_compressor.py` | Five-step adaptive compression when context exceeds thresholds |
| Auxiliary Client | `agent/auxiliary_client.py` | Delegates low-complexity tasks (summarization, vision) to cheaper models |
| Smart Model Routing | `agent/smart_model_routing.py` | Rate-limit failover, context-aware model suggestions, multi-provider fuzzy matching |

### Data Flow

**CLI Session:** User input -> HermesCLI -> AIAgent -> prompt builder -> provider resolution -> API call -> tool call loop -> response -> display -> save to SessionDB

**Gateway Message:** Platform event -> adapter -> MessageEvent -> GatewayRunner (authorize, resolve session, create AIAgent with history) -> run conversation -> deliver response back through adapter

**Cron Job:** Scheduler loads due jobs -> creates fresh AIAgent (no history) -> injects skills -> runs prompt -> delivers response -> updates job state

### Design Principles

| Principle | Description |
|-----------|-------------|
| Prompt Stability | System prompt does not change mid-conversation except for explicit user actions like `/model` |
| Observable Execution | Every tool call visible via callbacks; progress shown in CLI and gateway |
| Interruptible | API calls and tool execution cancellable mid-flight |
| Platform-Agnostic Core | One AIAgent class serves all entry points; platform differences stay at entry point layer |
| Loose Coupling | Optional subsystems use registry patterns and check_fn gating, not hard dependencies |
| Profile Isolation | Each profile gets its own HERMES_HOME, config, memory, sessions, and gateway PID |

---

## Key Features

### Self-Improving Loop (Closed-Loop Learning)

The defining differentiator of Hermes Agent is its closed-loop learning system. When the agent completes a complex multi-step task, it automatically distills the operation sequence into a new `.md` skill file. On subsequent encounters with similar problems, the agent invokes the existing skill directly instead of re-reasoning from scratch. Skills also continuously improve through use, making the agent progressively smarter over time rather than resetting each session.

This contrasts sharply with frameworks like LangChain, where task completion is ephemeral and the next session starts from zero. Automatic skill creation is currently marked as experimental but represents a system that genuinely accumulates operational experience.

### Skills System

Hermes Agent includes 74 built-in skills plus 50+ optional skills, all stored in Markdown format with YAML frontmatter, compatible with the agentskills.io standard.

Skills are organized in two directories:
- `skills/` -- Bundled skills, always available
- `optional-skills/` -- Official optional skills, installed explicitly

**Progressive Disclosure (Three Loading Tiers):**

1. **Metadata Layer:** Name, description, trigger conditions -- used for quick matching without loading full content
2. **Full Instruction Layer:** Detailed execution steps -- loaded only after successful match
3. **Reference Layer:** Template files, reference documents -- loaded on demand during execution

This tiered loading prevents flooding the context window with irrelevant skill details.

Management occurs through `skill_commands.py` (slash command handling), `skills_config.py` (enable/disable per platform), and `skills_hub.py` (`/skills` slash command interface).

### Memory Architecture

Memory operates across three distinct layers:

**1. Honcho User Modeling**
Builds user profiles through dialectical Q&A, combining semantic search with LLM synthesis. Enables contextual references to past interactions.

**2. Session Search**
Uses SQLite with FTS5 full-text search virtual table, featuring 6 versioned schema migrations and LLM-driven cross-session recall (not simple keyword matching). Session persistence includes lineage tracking (parent/child across compressions) and per-platform isolation.

**3. Procedural Memory**
Stored as `MEMORY.md` (user-specific) and `SOUL.md` (persona-specific), persisted to the filesystem. These integrate directly into the system prompt.

Memory providers use a pluggable architecture via `memory_manager.py` and `memory_provider.py`, with implementations in `plugins/memory/`. Providers are single-select -- only one of each type can be active at a time.

**Limitation:** No vector embedding search exists natively. FTS5 performs poorly on semantically similar (rather than lexically similar) queries. Integration with Pinecone or Weaviate is recommended for vector retrieval.

### Gateway (Messaging Platform Integration)

The messaging gateway is a long-running process supporting 20 platform adapters:

Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Email, SMS, DingTalk, Feishu, WeCom, WeCom Callback, WeiXin, BlueBubbles, QQBot, HomeAssistant, Webhook, API Server, and Yuanbao.

It provides unified session routing, user authorization (allowlists + DM pairing), slash command dispatch, a hook system, cron ticking, and background maintenance.

### Context Compression

The five-step compression process (`agent/context_compressor.py`, 2,030 lines):

1. Protects head/tail messages based on token budget (not message count)
2. Cheap preprocessing: trimming old tool output
3. Auxiliary cheap model (e.g., Haiku 4.5) generates initial summary
4. Subsequent compressions feed prior summary + new messages for incremental updates
5. Summary capped at 20% of compressed content, never exceeding 12,000 tokens

Structured summary templates capture Goals, Progress, Decisions, File Changes, and Next Steps to ensure compressed information remains actionable.

### Auxiliary Model System

Separates concerns between primary and auxiliary models. The primary model handles reasoning and decision-making while auxiliary models handle vision analysis, summarization, and other low-complexity tasks. This enables using Claude Opus for core reasoning while delegating compression to Haiku, reducing costs by up to 10x.

### MCP Integration

Full OAuth 2.1 PKCE flow for servers like GitHub and Google, CSRF protection with state validation, automatic token refresh for long-running agents, sampling support (MCP servers can request LLM completions during tool invocation), and per-server RPM limits, token caps, and model overrides.

### Execution Backends

Six terminal backends with varying isolation levels:

| Backend | Isolation | Cost |
|---------|-----------|------|
| Local Shell | None | Free |
| Docker Container | Process-level | Free |
| Remote SSH | Machine-level | Varies |
| Modal Serverless | Full sandbox | Pay-per-second |
| Daytona | Persistent containers | Pay-per-use |
| Singularity HPC | HPC-grade | Institutional |

---

## Comparison with Other Frameworks

### Benchmark Performance (Berkeley Function-Calling Leaderboard v3, May 2026)

| Framework | Tool-Call Accuracy | LLM Backend | Environment |
|-----------|-------------------|-------------|-------------|
| Hermes 3 8B (Local) | 91% | Hermes 3 8B via Ollama | RTX 4090, local |
| LangGraph + GPT-4o | 94% | GPT-4o | Cloud |
| CrewAI + GPT-4o | 82% | GPT-4o | Cloud |
| AutoGen + GPT-4o | 79% | GPT-4o | Cloud |

### Developer Experience Comparison

| Task | Hermes + Python | LangGraph | CrewAI | AutoGen |
|------|----------------|-----------|--------|---------|
| First working agent | 30 min | 2-3 hrs | 1 hr | 1 hr |
| Debug failed tool call | Easy | Medium | Hard | Medium |
| Add a new tool | ~5 lines | 10-15 lines | 10-15 lines | 10-15 lines |
| State persistence | Manual | Built-in | Limited | Not built-in |
| Human-in-the-loop | Manual | Built-in | Limited | Via UserProxyAgent |
| Local LLM support | Native (Ollama) | Via ChatOllama | Via LiteLLM | Via LiteLLM |

### Framework Positioning

**Hermes Agent** is best for local tool-calling agents with self-improving capabilities. Its key advantage is running fully locally with zero cloud dependency while maintaining 91% tool-call accuracy. An RTX 3080 10GB handles the 8B Q4_K_M variant at 25-35 tokens/sec. The trade-off is no built-in orchestration -- developers write their own retry loops and state management.

**LangGraph** excels at stateful multi-step graphs with best-in-class state management, built-in human-in-the-loop checkpointing, and native LangSmith integration. It has the steepest learning curve but is the strongest production framework for complex pipelines. Recommended approach: start with Hermes 3 locally, then layer LangGraph on top when state management is needed.

**CrewAI** fits multi-role orchestration with an intuitive role-based mental model. Best for content generation, research reports, and multi-stage writing pipelines. Weakness: limited control over per-step execution once the crew is running, and lowest tool-call accuracy among framework-backed options at 82%.

**AutoGen** suits iterative critique-and-refine workflows with built-in sandboxed code execution. Weakness: conversation loops generate many LLM calls causing cloud costs to accumulate quickly, and termination logic depends on fragile string matching.

### Key Differentiator: Tool Calling Reliability

- **Hermes 3**: Model-level validation -- trained on real tool-call traces, so failures are rare
- **LangGraph**: Inherits underlying model quality; excellent with GPT-4o, degrades with smaller models
- **CrewAI/AutoGen**: Adds abstraction layers on top of model native calls -- more translation steps mean more failure surfaces

---

## Use Cases

1. **Local Development Assistants** -- Run entirely on local hardware with zero cloud costs; ideal for privacy-sensitive code review, documentation generation, and development automation
2. **Multi-Platform Chatbots** -- Single agent deployment across 20 messaging platforms with unified session management and per-platform skill configuration
3. **Self-Improving Automation Pipelines** -- Tasks that benefit from accumulated operational knowledge, such as DevOps runbooks, customer support escalation, and data processing workflows
4. **Research and Analysis Agents** -- Cross-session memory enables longitudinal research projects where context accumulates over days or weeks
5. **IDE-Integrated Coding Agents** -- ACP adapter provides direct integration with VS Code, Zed, and JetBrains for in-editor agent assistance
6. **Scheduled Autonomous Tasks** -- Cron system enables unattended agent execution with skill injection and result delivery
7. **Cost-Optimized Hybrid Deployments** -- Auxiliary model system routes expensive reasoning to premium models while delegating routine tasks to cheaper alternatives

---

## Technical Details

### Tech Stack

| Component | Technology |
|-----------|------------|
| Language | Python |
| Database | SQLite with FTS5 |
| Validation | Pydantic 2.12+ |
| Testing | Pytest (~3,700 test cases, 372 test files) |
| Documentation | Docusaurus |
| IDE Protocol | stdio/JSON-RPC (ACP) |
| License | MIT |

### Supported API Modes

- `chat_completions` (OpenAI-compatible)
- `codex_responses` (Codex-style)
- `anthropic_messages` (Anthropic-native)

### Provider Support

18+ providers with OAuth flows, credential pools, and alias resolution. Provider credentials managed via `auth.py` with a `PROVIDER_REGISTRY`. Runtime maps each `(provider, model)` to an `(api_mode, api_key, base_url)` tuple.

### Hardware Requirements (Hermes 3 Model)

| Variant | Minimum VRAM/RAM | Notes |
|---------|------------------|-------|
| 8B Q4_K_M | 8 GB VRAM | 25-35 tok/sec on RTX 3080 |
| 8B fp16 | 16 GB VRAM | Full precision |
| 70B | 48 GB VRAM | Or CPU offloading |
| CPU-only | 8 GB RAM | 3-5 tok/sec (too slow for agentic loops) |

### Installation

**Linux/macOS/WSL2/Termux:**
```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

**Windows (PowerShell, early beta):**
```powershell
iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)
```

The installer provisions uv, Python 3.11, Node.js, ripgrep, ffmpeg, and a portable Git Bash (MinGit) if no system Git is found. Post-install: `source ~/.bashrc` then `hermes`.

**From source:**
```bash
git clone https://github.com/NousResearch/hermes-agent.git
cd hermes-agent
./setup-hermes.sh
```

Plugin discovery uses pip entry points plus local directories (`~/.hermes/plugins/`, `.hermes/plugins/`). Dependency versions are pinned with range locks.

### Engineering Quality

- ~3,700 test cases across 372 test files
- Integration tests marked with `@pytest.mark.integration`
- Parallel execution via pytest-xdist
- Thread-safe async bridging using `threading.local()` for persistent event loops
- Tool registry pattern solves circular imports; import failures are isolated

---

## Links & References

### Official Resources
- [Hermes Agent Official Site (Nous Research)](https://hermes-agent.nousresearch.com/)
- [GitHub Repository](https://github.com/nousresearch/hermes-agent)
- [Architecture Documentation](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/)
- [About Hermes Agent](https://hermes-agent.org/about/)
- [Release Timeline](https://hermesagents.net/evolution/)

### Technical Deep Dives
- [Hermes Agent Source Code Teardown (Fluxwise)](https://fluxwise.tech/en/resources/articles/2026-04-01-hermes-agent-self-improving-ai)
- [DeepWiki: NousResearch/hermes-agent](https://deepwiki.com/NousResearch/hermes-agent)
- [Hermes Agent Developer Guide (Lushbinary)](https://lushbinary.com/blog/hermes-agent-developer-guide-setup-skills-self-improving-ai/)
- [Hermes Agent Persistent Memory Guide 2026](https://hermes-growth.dev/blog/hermes-agent-persistent-memory-practical-guide-2026)

### Comparisons & Benchmarks
- [Compare Top AI Agent Frameworks: Hermes vs Others 2026](https://markaicode.com/vs/hermes-vs-ai-agent-frameworks/)
- [AI Agent Frameworks 2026 Compared](https://letsdatascience.com/blog/ai-agent-frameworks-compared)
- [Best AI Agent Frameworks: LangGraph, CrewAI, AutoGen Compared](https://www.neurallaunchpad.com/best-ai-agent-frameworks-langgraph-crewai-autogen-compared/)
- [2026 AI Agent Framework Showdown](https://qubittool.com/blog/ai-agent-framework-comparison-2026)

### News & Announcements
- [Nous Research Releases Hermes Agent (MarkTechPost)](https://www.marktechpost.com/2026/02/26/nous-research-releases-hermes-agent-to-fix-ai-forgetfulness-with-multi-level-memory-and-dedicated-remote-terminal-access-support/)
- [Hermes Agent 2026 Release Tracker](https://petronellatech.com/blog/hermes-agent-ai-guide-2026)
- [NousResearch Hermes Complete Guide -- Hermes 4.3 36B](https://www.oflight.co.jp/en/columns/nous-hermes-4-3-function-calling-agent-guide-2026)

---

*Report generated May 28, 2026. Information sourced from official documentation, technical analyses, and benchmark publications.*
