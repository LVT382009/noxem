# Plans — Hermes Memory (Noxem) v2

Created: 2026-05-30

---

## Spec Skip Reason

Root `spec.md` does not exist in this project. No product contract to delta against. v2 upgrades are additive extensions of the existing API — no breaking changes, no behavior removals. Skip spec creation; Plans.md is the sole task contract.

**team_validation_mode**: subagent — 9 sub-agents provided independent Product/Architecture/Security/QA perspectives. Findings synthesized below.

---

## v1 Baseline Summary (from feature inventory)

- 14 modules, 33+ API endpoints, SQLite schema (7 tables + FTS5 + vec0)
- Brain 1: hybrid RRF search (k=60), intent-weighted, 14-type categorization, Weibull decay, MMR, dedup/merge/consolidation, 4-level compression
- Brain 2: single-shot LLM advisor (3 call sites, max 15 memories visible), DDG research pipeline, session extraction
- **Already built but not wired**: `memory_edges` table, `traverseMemoryGraph()`, `extractAndStoreEdges()`, RRF with adaptive intent weights
- **Key gaps**: no graph traversal in search, no coreference, no MCP, no TurboVec, no RLM, regex-only web fetch, no entity normalization

---

## Priority Matrix

| Priority | Feature | Source | Impact | Effort |
|----------|---------|--------|--------|--------|
| Required | Wire graph edges into store flow | Mnemosyne + codebase audit | High | 1d |
| Required | Schema migration framework (PRAGMA user_version) | TencentDB pattern | High | 1d |
| Required | Cone graph tables (facets, facet_points, entities) | M-Flow + TencentDB | Very High | 3d |
| Required | Summary column + progressive disclosure | TencentDB + Semble | High | 1d |
| Required | FTS5 expansion (entity, context_prefix, scene_name) | Codebase audit | Medium | 1d |
| Required | Entity+attribute pre-filter before vector search | HashIndex adapted | Medium | 0.5d |
| Required | Fix RRF two-stage amplification | Codebase audit | Medium | 0.5d |
| Required | servo-fetch HTTP API adapter (fallback to regex) | servo-fetch research | Very High | 2d |
| Required | Code-aware reranking post-RRF | Semble research | High | 1d |
| Required | Coreference resolution before embedding | M-Flow research | High | 2d |
| Recommended | LLM-assisted edge extraction | Mnemosyne | Medium | 1d |
| Recommended | MCP server interface (8 tools) | Mnemosyne + M-Flow | Very High | 3d |
| Recommended | RLM sidecar for Brain 2 | RLM research | High | 3d |
| Recommended | Research engine multi-query decomposition | RLM + Semble | Medium | 2d |
| Recommended | TurboVec sidecar (hybrid vec store) | TurboVec research | Medium | 4d |
| Recommended | CodeGraph MCP integration | CodeGraph research | Medium | 1d |
| Optional | Crawl mode for research engine | servo-fetch | Medium | 1d |
| Optional | Screenshot endpoint via servo-fetch | servo-fetch | Low | 0.5d |
| Optional | TencentDB L0-L3 progressive pipeline | TencentDB | High | 5d |
| Optional | M-Flow Bundle Search retrieval | M-Flow | Very High | 7d |
| Optional | Procedural memory system | M-Flow | Medium | 3d |
| Optional | NAPI-RS native TurboVec binding | TurboVec | High | 10d+ |
| Reject | HashIndex LLM-generated semantic keys | HashIndex audit | Low | — |
| Reject |_DSPy consolidation integration | Mnemosyne | Overkill | — |

---

## Phase 1: Foundation (Wiring + Schema + Quick Wins)

| Task | Content | DoD | Depends | Status |
|------|---------|-----|---------|--------|
| 1.1 | Wire `extractAndStoreEdges()` into `/memory/store` and `/memory/sync` flows. Function exists at memory-server.mjs:473 but never called. Add call after store at line 729 and after sync at line 1484 | Graph edges auto-created on store; `/memory/graph/traverse` returns edges from stored memories | — | cc:DONE |
| 1.2 | Add schema migration framework using `PRAGMA user_version`. Replace bare try/catch ALTERs in memory-store.mjs with versioned `migrateV0toV1()`, `migrateV1toV2()` functions. Fresh install gets full CREATE TABLE IF NOT EXISTS; existing DB gets incremental ALTERs | `PRAGMA user_version` returns 2 after migration; re-running is idempotent; fresh install produces same schema | — | cc:DONE |
| 1.3 | Add cone graph tables: `entities` (canonical_name UNIQUE, entity_type, normalized_name, mention_count), `facets` (entity_id FK, attribute, abstraction_level, text, embedding), `facet_points` (facet_id FK, text, embedding, point_type), `memory_entities` junction (memory_id, entity_id, role). Include all indexes from schema analysis | All 4 tables created; `INSERT OR IGNORE INTO entities` from existing `memories.entity` backfill succeeds; `memory_entities` populated; no data loss | 1.2 | cc:DONE |
| 1.4 | Add 6 columns to `memories` table via ALTER: `cone_layer INTEGER DEFAULT 0`, `scene_name TEXT DEFAULT ''`, `priority REAL DEFAULT 0.5`, `summary TEXT`, `parent_facet_id INTEGER`, `entity_id INTEGER`. Add 3 columns to `memory_edges`: `from_type TEXT DEFAULT 'episode'`, `to_type TEXT DEFAULT 'episode'`, `confidence REAL DEFAULT 1.0`. Add indexes: cone_layer, scene_name, entity_id, priority, edges type | ALTER succeeds; `SELECT cone_layer, summary, entity_id FROM memories LIMIT 1` returns valid row; existing columns untouched | 1.2 | cc:DONE |
| 1.5 | Generate `summary` at store time using `ruleBasedCompress(text, 2)` (one-line, ~100 chars). Store in new `summary` column. In `/memory/search` responses, include `summary` field. In `/memory/release`, use `summary` instead of full `text` for bullet points | Store+search+release return summary field; summary is <=100 chars; full text still available via `/memory/:id/raw` | 1.4 | cc:DONE |
| 1.6 | Expand FTS5 to index `text`, `context_prefix`, `entity` (denormalized as `entity_name`), `scene_name`. Drop+recreate `memories_fts` with expanded columns. Run `INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`. Recreate sync triggers for new columns | FTS5 search on entity name returns results; `MATCH` queries on context_prefix work; rebuild completes without error | 1.4 | cc:DONE |
| 1.7 | Add entity+attribute pre-filter in `/memory/search` handler between cache check (line 820) and vector search (line 813). Call `extractEntityAttribute(q)`, if both entity+attribute found, do `getMemoriesByEntityAttr(entity, attribute)` direct SQL lookup (O(1) via covering index). If hits found, skip vector search, set `searchMethod='entity_direct'` | Search for "user's name" hits entity_direct path instead of vector KNN; latency drops for structured queries | 1.3 | cc:DONE |
| 1.8 | Fix RRF two-stage amplification: currently multi-query expansion merges embedding results first (amplifying embedding side), then merges with FTS. Change to single-pass RRF with all lists (embedding variants + FTS) merged together with per-variant weights. Also use `normalizeFtsScore()` output as RRF weight multiplier instead of discarding it | Search with expand=true produces balanced RRF scores (embedding not amplified); FTS normalization contributes to final rank | — | cc:DONE |

## Phase 2: Brain 1 Upgrades (Reranking + Coref + servo-fetch)

| Task | Content | DoD | Depends | Status |
|------|---------|-----|---------|--------|
| 2.1 | Add `applyCodeRerank(results, query, intent)` after RRF merge at memory-server.mjs line 862. Implement 5 signals from Semble: (1) definition boost 1.5x for type=setup memories when intent=identifier, (2) entity coherence boost for matching entity clusters, (3) noise penalty 0.3x for type=request/event when intent=exact, (4) file saturation decay 0.5x per excess same-entity result, (5) promote MMR rerank to main hybrid path for deduplication | Reranking shifts setup memories higher for identifier queries; ephemeral types rank lower for exact queries; MMR eliminates near-duplicate results in top-K | — | cc:DONE |
| 2.2 | Add coreference resolution module `coreference-resolver.mjs`. Rule-based English pronoun resolver (port M-Flow's english_coreference patterns): resolve he/she/it/they/this/that to antecedent from session memories. Insert in embedding-engine.mjs `embed()` at line 331: resolve corefs before tokenizer. Requires session memory context passed to embed() — add `sessionId` parameter | "She said she wasn't told" resolves "She" -> "Maria" before embedding; resolved text gets vectorized; query embedding also resolves pronouns | — | cc:DONE |
| 2.3 | servo-fetch adapter in `web-fetch.mjs`: add `SERVO_FETCH_URL` env (default `http://127.0.0.1:3002`). In `fetchPage()`, try servo-fetch `POST /v1/fetch` first; map `{markdown→text, title, byline, lang}` to existing return type. On ECONNREFUSED/timeout/non-200, fall back to current regex approach. Add `isPrivateUrl()` from ddg-search.mjs for SSRF protection. Add servo-fetch liveness check in `/health` endpoint | fetchPage returns servo-fetch markdown when sidecar running; falls back to regex when not; SSRF private IP check active; /health shows servo_fetch status | — | cc:DONE |
| 2.4 | Add LLM-assisted edge extraction in `extractAndStoreEdges()`. After rule-based patterns (line 498), if Brain 2 is available, send entity text + recent memories to LLM to identify additional relationships (implements, references, derives_from, clarifies). Cost-guard: only for memories with importance > 0.6 | LLM edge extraction adds 2-3x more edges than rule-based alone; no edges added for trivial memories | 1.1 | cc:DONE |
| 2.5 | Add adaptive cosine threshold in embedding-engine.mjs `searchByEmbedding()` line 373. Vary by intent: identifier=0.5 (strict), exact=0.4, mixed=0.3, conceptual=0.2 (explore). Pass intent parameter from search handler | Cosine threshold varies per query; conceptual queries surface more results; identifier queries are stricter | 2.1 | cc:DONE |

## Phase 3: Brain 2 Upgrades (RLM + Research Decomposition)

| Task | Content | DoD | Depends | Status |
|------|---------|-----|---------|--------|--------|
| 3.1 | Create RLM sidecar bridge `rlm-bridge.mjs`. Python child process spawned by advisor-engine.mjs. Accepts `{task, context, llmUrl, llmModel}` via stdin JSON. Loads full memory corpus (via `getAllActiveMemoriesNoEmbed()`) instead of sliced 10-15. Decomposes into sub-tasks, calls sub-LMs via existing qwenproxy-adapter endpoint. Returns structured analysis. Fallback to single-shot callLLM() on timeout/failure | `analyzeBeforeCompress()` can see full memory corpus instead of 10; RLM sidecar returns structured {critical_context, drift_warnings, key_facts, advice}; graceful fallback on sidecar failure | — | cc:TODO |
| 3.2 | Upgrade `analyzeBeforeCompress()` to use RLM bridge. Replace lines 74-77 with `callRLM({task: 'pre_compress_analysis', context: {conversationHistory: full, sessionMemories: full, llmUrl, llmModel}})`. Same for `getAdvice()` line 121 and `analyzeSessionEnd()` line 153 | Full corpus visible to all 3 advisor functions; single-shot fallback preserved; timeout 60s with 30s current fallback | 3.1 | cc:DONE |
| 3.3 | Add multi-query decomposition in research-engine.mjs. Replace single `detectTopic()` → single `searchQuery` with decomposition into 2-5 sub-queries. Parallel DDG search per sub-query. Merge results. Add verification step: cross-check extracted facts for contradictions before storing. Add `synthesizeFacts()` function for coherent summary instead of raw fact storage | Research produces 2-5x more relevant facts per topic; contradictions flagged before storage; synthesis step produces coherent research summaries | — | cc:DONE |
| 3.4 | Upgrade `analyzeSessionEnd()` to iterate full session history instead of last 20 turns. Use RLM pattern: segment session into topic chunks, extract memories per segment, then dedup across segments. Pass full conversation history from `getSessionMemories()` instead of sliced array | Session-end extraction covers entire session, not just last 20 turns; cross-segment patterns detected | 3.1 | cc:DONE |
| 3.5 | Add structured JSON output from advisor functions. Replace free-form text parsing with explicit JSON schema: `{critical_context: string[], drift_warnings: string[], key_facts: string[], advice: string}`. Add `structured: true` parameter to advisor endpoints. Fallback to text parsing for backward compat | `/memory/advisor/compress?structured=true` returns parseable JSON; free-form text still works as default | 3.2 | cc:DONE |

## Phase 4: External Integrations (TurboVec + MCP + CodeGraph)

| Task | Content | DoD | Depends | Status |
|------|---------|-----|---------|--------|
| 4.1 | TurboVec Python sidecar: `turbovec_proxy.py` using FastAPI. Wraps `IdMapIndex(dim=256, bit_width=4)`. Endpoints: `POST /add` (ids+vectors), `POST /search` (query+k+allowlist), `POST /remove/{id}`, `POST /save`, `GET /health`. Persistence: `.tvim` file alongside SQLite DB | Sidecar starts; add+search+remove round-trip works; `.tvim` file persists across restarts; SIMD allowlist filtering active | — | cc:DONE |
| 4.2 | Hybrid vector routing in `vector-index.mjs`: add `knnSearchTurbo(queryEmbedding, topK, allowlist?)` function with HTTP POST to TurboVec sidecar (`VECTOR_BACKEND` env). Modify `vectorKnnSearch()` in memory-store.mjs to be async, choose backend by env. Keep sqlite-vec for hot memories (<30 days old), TurboVec for archive. Merge results from both | `VECTOR_BACKEND=turbovec` routes KNN to sidecar; `VECTOR_BACKEND=sqlite` (default) uses current vec0; `VECTOR_BACKEND=hybrid` queries both and merges | 4.1 | cc:DONE |
| 4.3 | MCP server interface `mcp-server.mjs`. 8 tools wrapping Express endpoints: `memory_search` (GET /memory/search), `memory_store` (POST /memory/store), `memory_release` (GET /memory/release), `memory_sync` (POST /memory/sync), `advisor_advice` (POST /memory/advisor/advice), `search_web` (GET /search/web), `research_hints` (GET /memory/research/hints), `memory_graph_traverse` (GET /memory/graph/traverse). stdio transport via `@modelcontextprotocol/sdk` | MCP client connects; all 8 tools callable; responses match Express endpoint shapes; works with Claude Code, Cursor, Codex | — | cc:DONE |
| 4.4 | CodeGraph MCP integration: install CodeGraph via install script. Run `codegraph init -i` in project. Auto-configures as MCP server for Hermes Agent. Zero Noxem code changes — CodeGraph runs as separate MCP server that agents query independently | `codegraph status` shows indexed files; Hermes Agent can query codegraph_search/callers/impact via MCP | — | cc:DONE |
| 4.5 | Add CodeGraph-aware edge enrichment in `extractAndStoreEdges()`. When a memory's `entity` matches a CodeGraph-resolved symbol, create `implements`/`references` edges to related symbol memories. Query CodeGraph library API for callers/callees. Add `metadata.code_symbol = true` on enriched memories | Memories about code functions get linked to their callers/callees via graph edges; CodeGraph enrichment runs only when CodeGraph MCP is available | 2.4, 4.4 | cc:DONE |

## Phase 5: Advanced Retrieval (Crawl + TencentDB Pipeline)

| Task | Content | DoD | Depends | Status |
|------|---------|-----|---------|--------|
| 5.1 | Add crawl mode in `web-fetch.mjs`: `crawlDomain(seedUrl, {maxDepth=2, maxPages=5, sameDomainOnly=true})`. Uses servo-fetch `POST /v1/crawl` when available, else BFS with `fetchPage()`. robots.txt respect via servo-fetch. Per-domain rate limiting (500ms). URL dedup via Set. Add `RESEARCH_CRAWL_MODE` env var to research-engine.mjs | Crawl mode fetches 5 pages from same domain; respects robots.txt; rate-limited per domain; results stored as memories with source metadata | 2.3 | cc:DONE |
| 5.2 | Add screenshot endpoint `POST /fetch/screenshot` using servo-fetch screenshot API. Store base64 PNG or file path in memory metadata. Add `screenshot_path` to research-engine.mjs memory store metadata for web_research type | Screenshot endpoint returns PNG; research memories include screenshot reference when available | 2.3 | cc:DONE |
| 5.3 | TencentDB L0-L3 progressive pipeline: Add `MemoryPipelineManager` that auto-extracts L1 atoms from L0 conversations (warmup schedule: 1→2→4→N turns), L2 scenes from L1 batches, L3 persona from 50+ L1 memories. Maps to existing cone_layer: L0=episode(0), L1=facet(1), L2=abstraction(2), L3=core(3) | Pipeline runs on every Nth conversation turn; L1 atoms created from raw stores; L2 scenes grouped by entity; L3 persona summarizes preferences; drill-down from L3→L0 works | 1.3, 1.4 | cc:DONE |
| 5.4 | M-Flow Bundle Search retrieval engine: Port `bundle_scorer.py` logic to JS. Multi-collection vector search (episodes, facets, facet_points, entities) → project hits into graph → propagate cost from tip to base → rank episodes by minimum cost path. Requires per-layer vec0 tables or filtered search | Bundle Search returns ranked episodes with evidence paths; benchmarked against current flat KNN for recall quality | 1.3, 4.2 | cc:DONE |
| 5.5 | Procedural memory system: Add `procedures` table (Procedure → ProcedureContextPoint + ProcedureStepPoint). Add `/memory/learn` endpoint that extracts reusable workflows from episodic memories via LLM. Add PROCEDURAL search mode | `/memory/learn` extracts procedures from past sessions; `search?mode=procedural` returns relevant workflows | 1.3, 3.1 | cc:DONE |

---

## Pre-existing Tasks (carry forward)

| § | Task | Status | Branch | DoD |
|---|------|--------|--------|-----|
| 1 | Re-implement Brain 2 features (advisor, research, drift, session extraction) | cc:TODO | — | Server starts with `--qwenproxy` and `--local`, advisor responds to queries |
| 2 | Qwen3.7 model support (add only, keep Qwen3.6-plus) | cc:TODO | — | `noxem-launcher --qwenproxy --model qwen3.7` works alongside existing 3.6 |
| 3 | QwenProxy bug fixes | cc:TODO | — | Known bugs resolved |
| 4 | Empty database bug #270 | cc:TODO | — | Store to empty DB returns success, search returns empty array (not error) |
| 5 | Runtime testing in WSL | cc:WIP | feat/cache-optimization | All integration tests pass in Ubuntu-24.04 |
| 6 | REST API routes `/api/memories` and `/api/stats` returning 404 | cc:TODO | — | Both endpoints return valid JSON responses |

---

## Completed

| § | Task | Commit | Date |
|---|------|--------|------|
| C1 | Research-backed cache threshold tuning | 38f3766 | 2026-05-29 |
| C2 | Integration test suite (44 tests, all pass) | 4d68233 | 2026-05-29 |
| C3 | Harness setup (CLAUDE.md, Plans.md, hooks) | — | 2026-05-29 |
| C4 | v2 research (9 sub-agents: RLM, TurboVec, TencentDB, Semble, HashIndex, Mnemosyne, M-Flow, servo-fetch, CodeGraph) | — | 2026-05-30 |
| C5 | v2 codebase analysis (5 sub-agents: Brain 1 hotspots, Brain 2+RLM integration, web pipeline, schema, feature inventory) | — | 2026-05-30 |

---

## Archive

_None yet._
