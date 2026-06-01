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

## Verification

- **Syntax check**: All .mjs and .py files pass `node --check` / `python -m py_compile`
- **Integration tests**: 65 passed, 0 failed (run-test.sh in WSL Ubuntu-24.04)

## Phase 5 — MEDIUM/LOW (deferred)

See individual BUGS-*.md reports for remaining 34 MEDIUM + 17 LOW bugs.
