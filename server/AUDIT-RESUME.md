# Hermes-Memory Audit — Resume / Compact Instruction

> Session-resume doc. Re-nạp trạng thái audit + các ràng buộc vĩnh viễn. Caveman FULL mode mặc định.

## Dự án + trạng thái
- Repo `C:\Users\Le Van Tam\hermes-memory`, branch `feat/v2-upgrade`.
- Audit `server/`: xác minh báo cáo bug của Claude + fix confirmed-real. **Claude ĐÚNG 100% về real bug.**
- 4 commit local, **KHÔNG push** (ràng buộc vĩnh viễn).

## Commit history (mới → cũ)
```
d2e7d01 fix: reactivateMemory reopens cascade-archive edges (c) + invalidation_reason migration
120c1b1 fix: archive paths cascade bi-temporal edges (E9 invariant) + regression test
d7b2944 fix: pipeline FK-supersede crash (-1->null) + L3 double-fetch dedupe + regression tests
223ef70 fix: extractMemories undefined-on-[] crash + llm-fetch retry abort drop
```

## Bug đã fix (file:line → fix → test)
| Bug | File:line | Fix | Test |
|---|---|---|---|
| 🔴🔴 FK throw `-1` | `memory-pipeline.mjs` ln183(L2)+ln247(L3) | `updateMemoryStatus(id,'superseded',-1)` → `null`. FK `memories.superseded_by REFERENCES memories(id)` reject vì id AUTOINCREMENT không match `-1`; ngoài `try`, trước llmFetch → nhánh re-extract BUG-17 chưa từng chạy | `test_fk_supersede_claim.mjs` 10/10 (both-dir guard) + `test_l2_supersede_regression.mjs` 9/9 |
| L3 double-fetch | `memory-pipeline.mjs` extractL3Persona | 1 `getAllActiveMemoriesNoEmbed()` thay 2; bỏ dead var `existingPersona` + ternary `:Infinity` | contained in L2 + store-primitive |
| 🔴 archive-bypass E9 | `memory-store.mjs` ln1011+ln1057 (archive loops) | thêm `cascadeInvalidateEdges.run('cascade-archive',r.id,r.id)` cùng tx với `UPDATE status='archived'`. Raw archive path bypass cascade → `traverseGraph` JOIN memory_edges only (no status) → archived mem giữ live edge | `test_archive_cascade_regression.mjs` 14/14 |
| 🔴 reactivate edge-dead | `memory-store.mjs` reactivateMemory + migration | Bug do archive-cascade fix EXPOSED: reactivate archived mem → active+vec-reinsert nhưng edge chết vĩnh viễn. Fix (c): col `invalidation_reason` ('cascade-archive' reversible / 'cascade-supersede'+'manual' dead); `reopenArchivedEdges` trong reactivate tx → reset valid_until=NULL+reason=NULL **chỉ** cascade-archive edge + **chỉ** khi partner active (EXISTS non-self) → không kéo archived partner trở lại. Pre-column NULL không reopen | `test_reactivate_topology_regression.mjs` 18/18 (both-dir guard: bỏ reopen → 16/18 fail đúng 2 check Phase 1) |

**4 suite GREEN: FK 10 + L2 9 + archive 14 + reactivate 18 = 51 pass, 0 fail.**

## Triaged — KHÔNG fix (không bug)
- **#2** `getEdgesFromMemory`/`getEdgesToMemory` no asOf param — API asymmetry, non-crashing. Enhancement.
- **#3** `enforceActiveSetBound` ln1016-1027 no-op khi surplus all L0/L3 (cardinal E6) — design-intent nhưng 🟡 silent unbounded-growth. Optional: surface operator alarm khi `surplus>0 && demoted===0`.
- **#4** `llm-fetch.mjs` `_fetchWithRetry` ln114 retry-on-TimeoutError (per-attempt, không cumulative): pipeline caller truyền `AbortSignal.timeout(60s)` → `AbortSignal.any` ở retry-2 = aborted → fast-loop 2× → bounded ~60s (KHÔNG 180s). Generic no-signal caller = 3× timeout acceptable. LOW.
- BigInt rowid: plausible, không bug.
- Bug 1 (E7 orphan): FALSE — wired via `reactivation-engine.mjs`.

## Ràng buộc vĩnh viễn (giữ mọi session)
- **KHÔNG push**, KHÔNG reconfig remote, chỉ commit local. `git remote -v` check trước khi chạm.
- **KHÔNG tạo/thay token**: PAT `ghp_...OH2b` (rò rỉ old noxem URL) phải REVOKE trên GitHub; KHÔNG echo/nhúng `sta_e99baca5...` hay token nào vào git URL/output.
- **Không thay qwenproxy**. Không chạm repo `noxem\` (fork cũ) hay `~/.hermes/` root.
- **LF only**: verify `CR===0` qua `node -e "console.log([...fs.readFileSync(f)].filter(x=>x===13).length)"` trước commit. Windows Write/Edit có thể CRLF.
- Caveman FULL mode mặc định; auto-clarity cho multi-step/security/irreversible.
- NIM provider workflow: KHÔNG model param, KHÔNG parallel, KHÔNG `schema:` → plain text; sequential by design.

## Lệnh run/test (chốt WSL, nắm vững)
```powershell
# WSL --cd đặt CWD an toàn space, payload bash không chứa space
wsl -d Ubuntu-24.04 --cd '/mnt/c/Users/Le Van Tam/hermes-memory/server' bash -lc 'EMBEDDING_DIM=256 ENABLE_EMBEDDING=false node test_X.mjs 2>&1 | tail -30; echo EXIT=${PIPESTATUS[0]}'

# Syntax check Windows (không cần better-sqlite3)
node --check server/memory-store.mjs

# Suite 4 test → tee file WSL, grep summary (piped stdout bị cắt)
wsl ... bash -lc '{ node t1.mjs; node t2.mjs; ...; } >/tmp/suite.log 2>&1; grep -E "pass" /tmp/suite.log'
```
- **Test isolation:** `MEMORY_DB_DIR=os.tmpdir()` default, `ENABLE_EMBEDDING=false`, `LOG_LEVEL=error`. better-sqlite3+sqlite-vec native CHỈ trên WSL Ubuntu-24.04.
- **Both-direction guard pattern** (proof fix thật): post-fix PASS → revert chính xác dòng fix → thừa nhận 1-2 fail khớp claim → restore → PASS lại.

## Gotchas — lỗi đã mắc
1. **WSL CLI bóp quoting**: `wsl bash -lc "...('new')..."` vỡ. Fix: `--cd 'path space'` + payload bash **không** space/trace; tránh `()` `|` trong echo.
2. **Git Bash tool `/mnt/c`**: không tồn tại (Git Bash, không WSL). Dùng PowerShell+wsl.
3. **PowerShell here-string `@'...'@`**: đóng `'@` phải cột 0 không indent → bóp commit thành pathspec. Fix: `git commit -F file.tmp`.
4. **wsl piped stdout cắt** khi chain nhiều test: tee `/tmp/*.log` rồi grep.
5. **`process.exit()` trên Windows keep-alive sockets** → libuv `UV_HANDLE_CLOSING` assertion: dùng `server.closeAllConnections(); server.unref(); await server.close(r); process.exitCode=`.
6. **Read tool "stale"**: file sửa rồi Read lại báo stale — tin Edit result, không re-read.

## Next steps (roadmap §6, không bug)
- **L3 persona regression test** (germproof đầy): seed 50 L1 + persona 8 ngày → `extractL3Persona` re-extract. Nặng; `test_fk` đã cover L3 caller cùng `updateMemoryStatus`.
- **#3 alarm** (optional): log/surface operator khi `enforceActiveSetBound` return `surplus>0 && demoted===0`.
- **#5 E11** — cone compression-ratio instrumentation (`memory-pipeline.mjs`). Cần design: đo gì, log đâu.
- **#6 E12** — pipeline LLM off /memory/search hot path. Cần design: flag/guard.

## Files probe/stray (bỏ qua, không phải fix này)
`server/.noxem-python`, `server/_e1_probe.mjs`, `server/_e1_purge_probe.mjs`, `server/_run_fktest.sh` (đã xóa). Không stage, không chạm.

## Memory đã ghi
`~/.claude/projects/C--/memory/verify-bug-reports-against-codebase.md` — audit-trail đầy (223ef70→d2e7d01), 4 claim + fix; `MEMORY.md` có pointer.
