# Noxem v2 — Fixing Log

**Date**: 2026-06-01
**Methodology**: Karpathy guidelines — surgical changes, simplicity first, verify each fix
**Source**: BUGS-MASTER-REPORT.md (75 bugs: 6C/18H/34M/17L)

---

## Phase 1 — Data Loss / Crashes (CRITICAL)

| # | Bug | File | Status |
|---|-----|------|--------|
| C1 | `insertVec(db, id, vec)` undefined `id` | memory-store.mjs:549 | DONE — use `result.lastInsertRowid` |
| C2 | Coreference regex no capture group → TypeError | coreference-resolver.mjs:23 | NOT A BUG — regex has capture group, tested OK |
| H1 | `deleteVec` Number not BigInt | vector-index.mjs:110 | DONE — `BigInt(memoryId)` |
| C6 | FTS5 rank not aliased as score → NaN | memory-server.mjs:432 | DONE — added `f.rank AS score` |

## Phase 2 — Auth / LLM

| # | Bug | File | Status |
|---|-----|------|--------|
| C3 | QwenProxy adapter missing auth in streaming | qwenproxy-adapter.mjs:49,272 | DONE — `upstreamHeaders()` |
| H5 | Edge extraction + learn missing Content-Type | memory-server.mjs:543,1396 | DONE — `llmFetch()` w/ auth |

## Phase 3 — Pipeline Correctness

| # | Bug | File | Status |
|---|-----|------|--------|
| H2 | Warmup threshold uses cumulative not index | memory-pipeline.mjs:38 | DONE — index into WARMUP_SCHEDULE |
| H3 | L2/L3 extraction creates duplicates | memory-pipeline.mjs:129 | DONE — dedup check before insert |
| H4 | Coreference replace offset drift | coreference-resolver.mjs:23 | DONE — right-to-left matchAll |
| H12 | Nested bracket regex in memory-extract | memory-extract.mjs:60 | DONE — balanced array extractor |

## Phase 4 — Reliability / Windows / Plugin

| # | Bug | File | Status |
|---|-----|------|--------|
| C5 | sync_turn deadlock (lock held during sleep) | __init__.py:768-772 | DONE — moved sleep outside lock |
| H7 | Circuit breaker thundering herd | rlm-bridge.mjs:40-47 | DONE — `halfOpenProbe` flag |
| H8 | Windows path for sidecar spawn | rlm-bridge.mjs:15,21 | DONE — `fileURLToPath()` |
| H9 | Greedy regex in rlm_sidecar.py | rlm_sidecar.py:197,259,402,425 | DONE — balanced extractors |
| H10 | shutdownRLM sets null before SIGTERM | rlm-bridge.mjs:205-216 | DONE — local var + clear pending |
| H11 | stdin sync loop hangs on Windows | rlm_sidecar.py:473-496 | DONE — executor-based readline |
| H13 | LOG_DEBUG undefined in web-fetch | web-fetch.mjs:272 | DONE — added const declaration |
| H14 | MCP graph_traverse ignores params | mcp-server.mjs:312-314 | DONE — added incoming+both SQL, direction/relation params |
| H15 | Installer hardcoded venv path | install.sh:150 | DONE — dynamic via `python3 -c site.getsitepackages()` |
| H16 | Installer rm -rf destroys DB | install.sh:271 | DONE — backup/restore data dir |
| H6 | Supersede metadata not in transaction | memory-server.mjs:1616 | DONE — `db.transaction()` wrapper |
| H18 | _api_post empty error string falsy | __init__.py | DONE — check `"error" in result` |

## Verification (Phase 1–4)

- **Syntax check**: All .mjs and .py files pass `node --check` / `python -m py_compile`
- **Integration tests**: 65 passed, 0 failed (run-test.sh in WSL Ubuntu-24.04)

---

## Phase 5 — Second Audit Round (2026-06-02)

Source: 4 parallel sub-agent audits → BUGS-sidecars-infra-v2.md, BUGS-server-core-v2.md, BUGS-pipeline-search-v2.md, BUGS-plugin-mcp-installer-v2.md

### CRITICAL fixes

| # | Bug | File | Status |
|---|-----|------|--------|
| S-C1 | `process.kill(pid, 'SIGTERM')` leaks zombie on Windows | rlm-bridge.mjs:223 | DONE — `childProc.kill()` + SIGKILL fallback |
| S-C2 | `shutdownRLM` doesn't reject pending requests — callers hang | rlm-bridge.mjs:217 | DONE — reject all before clear |
| S-C3 | `traverseGraphIncoming` used but never defined — incoming graph traversal crashes | memory-store.mjs:768,774 | DONE — added prepared statement |
| P-C1 | `storeMemory` silently drops `cone_layer` — L1/L2/L3 all stored as 0 | memory-store.mjs:375,545 | DONE — added to INSERT + function signature + batch |
| P-C2 | `CONTEXT_WINDOW` undefined in advisor-engine — NaN disables truncation | advisor-engine.mjs:224,264 | DONE — added local const |
| P-C3 | Race condition: concurrent L1 extraction for same session | memory-pipeline.mjs:55 | DONE — `extractingL1` per-session lock |

### HIGH fixes

| # | Bug | File | Status |
|---|-----|------|--------|
| S-H3 | `TURN_CONTENT_LIMIT` local variable not accessible from called functions | rlm_sidecar.py:293,362 | DONE — pass as `turn_limit` parameter |
| S-H4 | Windows venv path `bin/python3` wrong on Windows | rlm-bridge.mjs:23 | DONE — platform-aware `Scripts/python.exe` |
| S-H8 | `llmHeaders` overwrites caller Authorization with global env var | llm-fetch.mjs:10 | DONE — only add if not present + normalize Headers |
| S-H20 | `halfOpenProbe` stuck true — circuit breaker never fully recovers | rlm-bridge.mjs:46-52 | DONE — reset in readline handler |
| SC-H2 | `getMemoriesWithoutEmbedding` missing `context_prefix` | memory-store.mjs:457 | DONE — added to SELECT |
| PS-H1 | Dijkstra edge weight can go negative — breaks algorithm | bundle-search.mjs:57 | DONE — `Math.max(0, ...)` clamp |
| PI-H9 | `context_window` config default is string "8192" not int | __init__.py:418 | DONE — changed to integer `8192` |

### MEDIUM fixes

| # | Bug | File | Status |
|---|-----|------|--------|
| S-M6 | `collectSSE` buffers entire response — no per-chunk idle timeout | qwenproxy-adapter.mjs:73 | NOTED — requires streaming refactor |
| S-M10 | ddg-search redirect body not drained — socket leak | ddg-search.mjs:41 | DONE — `res.resume()` before redirect |
| S-M12 | `crawlDomain` extracts links from stripped text, not HTML | web-fetch.mjs:307 | NOTED — needs fetchRawHtml helper |
| S-M15 | research-engine `headers: {}` redundant | research-engine.mjs:206 | DONE — removed |
| S-M18 | network-diagnostics `dns.resolve4` used incorrectly | network-diagnostics.mjs:16 | DONE — added `dnsPromises` import |
| PS-H2 | L2 scene extraction "skip if exists" too aggressive | memory-pipeline.mjs:143 | NOTED — needs design decision |

## Verification (Phase 5)

- **Syntax check**: All .mjs and .py files pass `node --check` / `python -m py_compile`
- **Integration tests**: 65 passed, 0 failed (run-test.sh in WSL Ubuntu-24.04)

## Phase 6 — MEDIUM/LOW (deferred)

See individual BUGS-*-v2.md reports for remaining bugs across all 4 audit files.
