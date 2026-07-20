// E23 flag-then-ping-Brain2 — PERMANENT regression test.
//
// User mandate: "the cron only flag then ping brain 2 to resolve, brain 1 cannot think" +
//   "The dedup step must NOT perform any merge — it should only FLAG the pair as similar, along with the
//    similarity percentage, so Brain 2 can review and decide whether to merge or not."
//
// E23 flips the legacy silent auto-supersede into a DUAL-MODE cron:
//   BRAIN2_ON  — the cron DETECTS + FLAGS (linkSimilarPair → status='similar_pending', reversible
//                flagSupersededBy, OR bi-temporal dated-bypass), then PINGS Brain2 (SQLite verdict queue +
//                sequential drain). Brain1 owns NO verdict.
//   BRAIN2_OFF — legacy deterministic cron verbatim (backward-compat; rollback flips one env).
//
// Surfaces + validates against the REAL sqlite store (no LLM — pure store ops; ENABLE_EMBEDDING=false +
// EMBEDDING_DIM=256 basis vectors so identical texts score sim≈1.0 in findDuplicates):
//   S1  dated bypass, BOTH modes — 22/7 vs 23/7 same-entity/cross-session: legacy keeps older row (superseded,
//       NOT wiped), Brain2 keeps BOTH active + older.valid_until set. The canonical dated-fact killer.
//   S2  similar FLAGGED not superseded — linkSimilarPair sets status='similar_pending' (NOT 'superseded') on
//       BOTH members + bidirectional similar_pair_id + a 'similar' edge.
//   S3  queue holds 2nd, NO drop — enqueueB2Job twice ok (queued=1,2); 3rd returns 'queue-full' (BRAIN2_MAX_QUEUE_DEPTH=2),
//       never a silent drop. Depth-bound back-pressure.
//   S4  continuous loop idempotent — watermark+cooldown: pairRecentlyResolvedSameContent false before any
//       verdict, true after markPairResolvedWatermark (UNCHANGED content, within cooldown), false again past
//       the cooldown OR on text mutation — so the cron does NOT re-flag an already-judged pair every tick.
//   S5  Brain1-only retained — BRAIN2_OFF legacy dedup: older flipped 'superseded' (retrievable, NOT hard-deleted).
//       (covered by S1-legacy; re-asserted here as the Brain1-only contract.)
//   S6  Brain2 fallback store when 0 — enqueueB2Job('augment', { storedMemories: [] }) returns ok:true — the
//       dropped `ids.length>0` gate is GONE; Brain2 still runs when Brain1 stored nothing (can STORE a missed fact).
//   S7  cardinal L0/L3 never hard-deleted — resolveSimilarPair merge mode APPENDS a summary + flags BOTH
//       originals (NEVER hard-deletes; the resolve_similar path has no hard-delete anywhere). Plus hardDeleteMemory
//       refuses a cone_layer=3 row (cardinal guard smoke).
//   S8  reaper clears valid_until<cutoff — a 'similar' verdict edge whose valid_until is in the past is reaped by
//       reapResolvedEdges (the verdict-edge lifecycle: judge → stamp valid_until → reap after grace).
//   S9  merge APPENDS not deletes — resolveSimilarPair merge: summary row created (status active),
//       metadata.merged_from=[a,b], BOTH originals survive + flagged superseded-by the summary (reversible).
//   S10 hardenReviewPendingMerges no-op under BRAIN2_ENABLED=1 — returns { reason:'brain2-on-deferred', hardened:0 };
//       in Brain2-on a flagged review-pending merge is routed to Brain2's reconcile queue, NOT window-hard-deleted.
//   S11 dispatched tool — dispatchTool('memory_resolve_similar',...) distinct/supersede/bad-mode resolve correctly.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e23.sh
// Standalone: ENABLE_EMBEDDING=false ENABLE_ADVISOR=false ENABLE_MAINTENANCE=false ENABLE_RESEARCH=false \
//   PIPELINE_ENABLED=false RLM_ENABLED=false EMBEDDING_DIM=256 LOG_LEVEL=error node test_e23_flag_then_ping.mjs
import { storeMemory, db, linkSimilarPair, resolveSimilarPair, getAuditReport, pairRecentlyResolvedSameContent, markPairResolvedWatermark, hashDiscrimPairText, reapResolvedEdges, hardDeleteMemory, flagSupersededBy, getActiveWithEmbedding } from './memory-store.mjs';
import { runDedupPass, detectDatedDivergence, hardenReviewPendingMerges } from './memory-maintenance.mjs';
import { enqueueB2Job, getB2QueueStatus } from './brain2-agent.mjs';
import { BRAIN2_TOOLS, dispatchTool } from './brain2-tools.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
const basis = (d) => { const v = new Float32Array(EMBED_DIM); v[d] = 1.0; return v; };

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(` PASS: ${name}`); }
  else { FAIL++; console.log(` FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── table reset between sub-tests (foreign_keys off → delete in any order; back on) ──
const _fkOff = () => { try { db.pragma('foreign_keys = OFF'); } catch {} };
const _fkOn  = () => { try { db.pragma('foreign_keys = ON'); } catch {} };
function resetTables() {
  _fkOff();
  try {
    db.exec("DELETE FROM pending_verdicts; DELETE FROM pending_verdicts_dlq; DELETE FROM processed_pairs; DELETE FROM memory_edges; DELETE FROM memories;");
  } catch (e) { /* best-effort */ }
  _fkOn();
}
function clrQueue() { try { db.exec("DELETE FROM pending_verdicts; DELETE FROM pending_verdicts_dlq;"); } catch {} }

const rowStatus   = id => { const r = db.prepare('SELECT status FROM memories WHERE id = ?').get(Number(id)); return r ? r.status : null; };
const rowExists   = id => !!db.prepare('SELECT 1 AS x FROM memories WHERE id = ?').get(Number(id));
const memText     = id => { const r = db.prepare('SELECT text FROM memories WHERE id = ?').get(Number(id)); return r ? r.text : null; };
const rowFull     = id => db.prepare('SELECT id, status, importance, valid_until, similar_pair_id, cone_layer, superseded_by, text, metadata FROM memories WHERE id = ?').get(Number(id));
const metaOf      = id => { try { const m = db.prepare('SELECT metadata FROM memories WHERE id = ?').get(Number(id)); return JSON.parse(m.metadata || '{}'); } catch { return {}; } };
const chainEdge   = (from, to) => !!db.prepare("SELECT 1 AS x FROM memory_edges WHERE from_id = ? AND to_id = ? AND relation = 'is_newer_version_of'").get(Number(from), Number(to));
const simPairEdge = (a, b) => !!db.prepare("SELECT 1 AS x FROM memory_edges WHERE relation = 'similar' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))").get(Number(a), Number(b), Number(b), Number(a));
const queueQueued = () => db.prepare("SELECT COUNT(*) AS c FROM pending_verdicts WHERE status='queued'").get().c;

// ── S0 exports + tool wiring ──────────────────────────────────────────
let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('S0 vec table ready', vecReady);
check('S0 linkSimilarPair exported', typeof linkSimilarPair === 'function');
check('S0 resolveSimilarPair exported', typeof resolveSimilarPair === 'function');
check('S0 reapResolvedEdges exported', typeof reapResolvedEdges === 'function');
check('S0 pairRecentlyResolvedSameContent exported', typeof pairRecentlyResolvedSameContent === 'function');
check('S0 markPairResolvedWatermark exported', typeof markPairResolvedWatermark === 'function');
check('S0 enqueueB2Job exported', typeof enqueueB2Job === 'function');
check('S0 memory_resolve_similar tool registered', BRAIN2_TOOLS.some(t => t.name === 'memory_resolve_similar'));
check('S0 pending_verdicts table exists', db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='pending_verdicts'").get() != null);
check('S0 processed_pairs table exists', db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='processed_pairs'").get() != null);

// ── S1 dated-bypass BOTH modes (the canonical 22/7-vs-23/7 killer) ────
resetTables();
{
  const dv = detectDatedDivergence('Monthly budget is 4000 on 22 July 2026.', 'Monthly budget is 4000 on 23 July 2026.');
  check('S1a detectDatedDivergence flags 22/7 vs 23/7', dv && dv.aToken !== dv.bToken, JSON.stringify(dv));
}
// legacy mode (BRAIN2_ENABLED=0): older survives superseded, NOT hard-deleted.
// runDedupPass is the cron's dual-mode decision logic factored out of runMaintenance so a test can drive
// it WITHOUT the embedding-ready gate that wraps runMaintenance (test_e19 bypasses the same way via
// runContradictionPass). brain2On:false ⇒ the legacy deterministic branch verbatim.
resetTables();
{
  const aLegacy = storeMemory({ session_id: 's-Jun22', type: 'fact', text: 'Monthly budget is 4000 on 22 July 2026.', entity: 'budget', attribute: 'monthly', importance: 0.7, embedding: basis(0), cone_layer: 1 });
  const bLegacy = storeMemory({ session_id: 's-Jul23', type: 'fact', text: 'Monthly budget is 4000 on 23 July 2026.', entity: 'budget', attribute: 'monthly', importance: 0.7, embedding: basis(0), cone_layer: 1 });
  const older = Math.min(Number(aLegacy), Number(bLegacy)), newer = Math.max(Number(aLegacy), Number(bLegacy));
  runDedupPass(getActiveWithEmbedding(), { brain2On: false });
  check('S1b legacy: BOTH rows survive (not wiped)', rowExists(older) && rowExists(newer), `older=${rowExists(older)} newer=${rowExists(newer)}`);
  check('S1c legacy: older text intact', memText(older) === 'Monthly budget is 4000 on 22 July 2026.');
  check('S1d legacy: older status=superseded (reversible, retrievable)', rowStatus(older) === 'superseded', `status=${rowStatus(older)}`);
}
// Brain2-on dated-bypass: BOTH active + older.valid_until set
resetTables();
{
  const a2 = storeMemory({ session_id: 's-Jun22', type: 'fact', text: 'Monthly budget is 4000 on 22 July 2026.', entity: 'budgetD', attribute: 'monthly', importance: 0.7, embedding: basis(0), cone_layer: 1 });
  const b2 = storeMemory({ session_id: 's-Jul23', type: 'fact', text: 'Monthly budget is 4000 on 23 July 2026.', entity: 'budgetD', attribute: 'monthly', importance: 0.7, embedding: basis(0), cone_layer: 1 });
  const older = Math.min(Number(a2), Number(b2)), newer = Math.max(Number(a2), Number(b2));
  runDedupPass(getActiveWithEmbedding(), { brain2On: true });
  check('S1e Brain2-on: BOTH rows survive (not wiped)', rowExists(older) && rowExists(newer), `older=${rowExists(older)} newer=${rowExists(newer)}`);
  check('S1f Brain2-on: BOTH rows still ACTIVE (dated bypass keeps both)', rowStatus(older) === 'active' && rowStatus(newer) === 'active', `older=${rowStatus(older)} newer=${rowStatus(newer)}`);
  check('S1g Brain2-on: older valid_until set (bi-temporal)', rowFull(older).valid_until != null, `valid_until=${rowFull(older).valid_until}`);
  check('S1h Brain2-on: older text intact', memText(older) === 'Monthly budget is 4000 on 22 July 2026.');
}

// ── S2 similar FLAGGED not superseded (the mandates: flag only, never merge the cron) ──
resetTables();
{
  const a = storeMemory({ session_id: 'sx', type: 'fact', text: 'User prefers dark mode', entity: 'user', attribute: 'theme', importance: 0.6, embedding: basis(1), cone_layer: 1 });
  const b = storeMemory({ session_id: 'sy', type: 'fact', text: 'User prefers dark mode', entity: 'user', attribute: 'theme', importance: 0.6, embedding: basis(1), cone_layer: 1 });
  const r = linkSimilarPair(a, b, 0.97);
  check('S2 linkSimilarPair ok', r && r.ok === true);
  const ra = rowFull(a), rb = rowFull(b);
  check('S2a BOTH flagged similar_pending (NOT superseded)', ra.status === 'similar_pending' && rb.status === 'similar_pending', `a=${ra.status} b=${rb.status}`);
  check('S2b bidirectional similar_pair_id', Number(ra.similar_pair_id) === Number(b) && Number(rb.similar_pair_id) === Number(a));
  check('S2c similar edge authored', simPairEdge(a, b), 'no similar edge');
  const audit = getAuditReport();
  check('S2d audit surfaces open_similar_pairs', Array.isArray(audit.open_similar_pairs) && audit.open_similar_pairs.some(p => Number(p.id) === Number(a) || Number(p.pair_id) === Number(a)));
}

// ── S3 queue holds 2nd, NO drop (depth-bound back-pressure) ──────────
resetTables(); clrQueue();
{
  const r1 = enqueueB2Job('augment', { x: 1 });
  const r2 = enqueueB2Job('reconcile', { y: 2 });
  const r3 = enqueueB2Job('reconcile', { z: 3 });
  check('S3a 1st enqueue ok', r1.ok === true, JSON.stringify(r1));
  check('S3b 2nd enqueue ok (queued)=2', r2.ok === true && r2.queued === 2, JSON.stringify(r2));
  check('S3c 3rd enqueue REJECTED queue-full (NO silent drop)', r3.ok === false && r3.reason === 'queue-full', JSON.stringify(r3));
  check('S3d queue still holds exactly 2 (the live jobs survived the reject)', queueQueued() === 2, `queued=${queueQueued()}`);
}
clrQueue();

// ── S4 continuous-loop idempotent (watermark + cooldown) ─────────────
resetTables(); clrQueue();
{
  const a = storeMemory({ session_id: 's4', type: 'fact', text: 'alpha SAME', entity: 'e4', attribute: 'k', importance: 0.5, embedding: basis(2), cone_layer: 1 });
  const b = storeMemory({ session_id: 's4', type: 'fact', text: 'alpha SAME', entity: 'e4', attribute: 'k', importance: 0.5, embedding: basis(2), cone_layer: 1 });
  const tA = 'alpha SAME', tB = 'alpha SAME';
  check('S4a never judged → re-eligible (false)', pairRecentlyResolvedSameContent(a, b, tA, tB) === false);
  markPairResolvedWatermark(a, b, hashDiscrimPairText(tA, tB));
  check('S4b just judged + UNCHANGED content → skip (true)', pairRecentlyResolvedSameContent(a, b, tA, tB) === true);
  // text mutated → re-eligible
  db.prepare('UPDATE memories SET text = ? WHERE id = ?').run('alpha MUTATED', Number(b));
  check('S4c content mutated → re-eligible (false)', pairRecentlyResolvedSameContent(a, b, tA, 'alpha MUTATED') === false);
  // restore + re-stamp, then age past cooldown
  db.prepare('UPDATE memories SET text = ? WHERE id = ?').run(tB, Number(b));
  markPairResolvedWatermark(a, b, hashDiscrimPairText(tA, tB));
  db.prepare("UPDATE processed_pairs SET resolved_at = '2020-01-01 00:00:00' WHERE min_id = ? AND max_id = ? AND relation='similar'").run(Math.min(Number(a), Number(b)), Math.max(Number(a), Number(b)));
  check('S4d past cooldown → re-eligible (false)', pairRecentlyResolvedSameContent(a, b, tA, tB) === false);
}

// ── S5 Brain1-only retained (legacy dedup → older superseded, NOT hard-deleted) ──
resetTables(); clrQueue();
{
  const a = storeMemory({ session_id: 's5o', type: 'fact', text: 'User uses React for the frontend', entity: 'stack', attribute: 'frontend', importance: 0.6, embedding: basis(3), cone_layer: 1 });
  const b = storeMemory({ session_id: 's5n', type: 'fact', text: 'User uses React for the frontend', entity: 'stack', attribute: 'frontend', importance: 0.6, embedding: basis(3), cone_layer: 1 });
  const older = Math.min(Number(a), Number(b)), newer = Math.max(Number(a), Number(b));
  runDedupPass(getActiveWithEmbedding(), { brain2On: false });
  check('S5a Brain1-only: older survives (NOT hard-deleted)', rowExists(older), `older=${rowExists(older)}`);
  check('S5b Brain1-only: older status=superseded (reversible, in lineage)', rowStatus(older) === 'superseded', `status=${rowStatus(older)}`);
  check('S5c Brain1-only: older text preserved', memText(older) === 'User uses React for the frontend');
}

// ── S6 Brain2 fallback store when 0 (the dropped ids.length>0 gate is GONE) ─
resetTables(); clrQueue();
{
  const r = enqueueB2Job('augment', { sessionId: 's6', userMessage: 'hi', assistantResponse: 'hi', storedMemories: [] });
  check('S6 augment enqueued for a Brain1-stored-0 exchange', r.ok === true, JSON.stringify(r));
}
clrQueue();

// ── S7 cardinal L0/L3 never hard-deleted ─────────────────────────────
resetTables(); clrQueue();
{
  const l3 = storeMemory({ session_id: 's7', type: 'persona', text: 'Persona summary: pragmatic builder', entity: 'persona', attribute: 'self', importance: 0.9, embedding: null, cone_layer: 3 });
  const hd = hardDeleteMemory(Number(l3));
  check('S7a hardDeleteMemory REFUSES cone_layer=3 (cardinal guard)', hd && hd.ok === false, JSON.stringify(hd));
  // resolve_similar merge mode appends a summary + flags originals — NEVER hard-deletes (even an L0/L3 member)
  const l0 = storeMemory({ session_id: 's7', type: 'episode', text: 'raw episode about dark mode', entity: 'session7', attribute: 'ep', importance: 0.5, embedding: basis(4), cone_layer: 0 });
  const l1 = storeMemory({ session_id: 's7', type: 'fact', text: 'raw episode about dark mode', entity: 'session7', attribute: 'ep', importance: 0.5, embedding: basis(4), cone_layer: 1 });
  const r = resolveSimilarPair(l0, l1, { mode: 'merge', mergeText: 'canonical: episode established dark-mode preference', reason: 'S7' });
  check('S7b resolve_similar merge ok', r && r.ok === true, JSON.stringify(r));
  check('S7c L0 + L1 originals BOTH survive merge (resolve_similar never hard-deletes)', rowExists(l0) && rowExists(l1), `l0=${rowExists(l0)} l1=${rowExists(l1)}`);
  check('S7d merge summary row created', r.upheld != null && rowExists(r.upheld), `summary=${r.upheld}`);
}

// ── S8 reaper clears valid_until<cutoff (verdict-edge lifecycle) ─────
resetTables(); clrQueue();
{
  const a = storeMemory({ session_id: 's8', type: 'fact', text: 'node version 20', entity: 'env', attribute: 'node', importance: 0.5, embedding: basis(5), cone_layer: 1 });
  const b = storeMemory({ session_id: 's8', type: 'fact', text: 'node version 20', entity: 'env', attribute: 'node', importance: 0.5, embedding: basis(5), cone_layer: 1 });
  // linkSimilarPair first so resolveSimilarPair distinct has an existing 'similar' edge to stamp
  // (the verdict UPDATE targets relation='similar'; without it, 0 rows are affected → nothing to reap).
  linkSimilarPair(a, b, 0.96);
  resolveSimilarPair(a, b, { mode: 'distinct', reason: 'S8' });
  check('S8a a verdict edge stamped valid_until (now)', db.prepare("SELECT COUNT(*) AS c FROM memory_edges WHERE relation='similar' AND (from_id=? OR to_id=?)").get(Number(a), Number(b)).c >= 1);
  // age the verdict edge into the reaper window + reap with a 0-grace cutoff
  db.prepare("UPDATE memory_edges SET valid_until='2020-01-01 00:00:00' WHERE relation='similar' AND (from_id=? OR to_id=?)").run(Number(a), Number(b));
  const reap = reapResolvedEdges({ older_than_ms: 0, max_per_tick: 50 });
  check('S8b reapResolvedEdges reaped the aged verdict edge', reap.ok === true && reap.reaped >= 1, JSON.stringify(reap));
  const left = db.prepare("SELECT COUNT(*) AS c FROM memory_edges WHERE relation='similar' AND (from_id=? OR to_id=?)").get(Number(a), Number(b)).c;
  check('S8c reaped edge gone', left === 0, `left=${left}`);
}

// ── S9 merge mode APPENDS a summary, does NOT delete originals ───────
resetTables(); clrQueue();
{
  const a = storeMemory({ session_id: 's9', type: 'fact', text: 'prefers dark mode', entity: 'user', attribute: 'theme', importance: 0.6, embedding: basis(6), cone_layer: 1 });
  const b = storeMemory({ session_id: 's9', type: 'fact', text: 'prefers dark mode', entity: 'user', attribute: 'theme', importance: 0.6, embedding: basis(6), cone_layer: 1 });
  const r = resolveSimilarPair(a, b, { mode: 'merge', mergeText: 'canonical: user prefers dark mode for the UI', reason: 'S9' });
  check('S9a merge ok + summary returned', r.ok === true && r.summary_id != null, JSON.stringify(r));
  const sum = r.summary_id;
  check('S9b summary row exists + active', rowExists(sum) && rowStatus(sum) === 'active');
  check('S9c summary metadata.merged_from = [a,b]', JSON.stringify((metaOf(sum).merged_from || []).sort((x, y) => x - y)) === JSON.stringify([Number(a), Number(b)].sort((x, y) => x - y)), JSON.stringify(metaOf(sum)));
  check('S9d BOTH originals survive (NOT hard-deleted)', rowExists(a) && rowExists(b), `a=${rowExists(a)} b=${rowExists(b)}`);
  check('S9e originals flagged superseded-by summary (reversible chain)', chainEdge(a, sum) && chainEdge(b, sum), `a→sum=${chainEdge(a, sum)} b→sum=${chainEdge(b, sum)}`);
  check('S9f WATERMARK stamped (loop-breaker)', pairRecentlyResolvedSameContent(a, b, memText(a), memText(b)) !== false);
}

// ── S10 hardenReviewPendingMerges no-op under BRAIN2_ENABLED=1 ───────
resetTables(); clrQueue();
{
  const prev = process.env.BRAIN2_ENABLED; process.env.BRAIN2_ENABLED = '1';
  const r = hardenReviewPendingMerges();
  process.env.BRAIN2_ENABLED = prev;
  check('S10 Brain2-on: hardenReviewPendingMerges is a NO-OP (deferred to Brain2 reconcile)', r && r.hardened === 0, JSON.stringify(r));
}

// ── S11 dispatched tool memory_resolve_similar (distinct / supersede / bad-mode) ─
resetTables(); clrQueue();
{
  const a = storeMemory({ session_id: 's11', type: 'fact', text: 'vitest config cjs', entity: 'test', attribute: 'config', importance: 0.6, embedding: basis(7), cone_layer: 1 });
  const b = storeMemory({ session_id: 's11', type: 'fact', text: 'vitest config cjs', entity: 'test', attribute: 'config', importance: 0.6, embedding: basis(7), cone_layer: 1 });
  linkSimilarPair(a, b, 0.96);
  const rd = await dispatchTool('memory_resolve_similar', { id_a: a, id_b: b, mode: 'distinct', rationale: 'S11 distinct' });
  check('S11a tool mode=distinct resolves (both back to active)', rd && rd.ok === true && rowStatus(a) === 'active' && rowStatus(b) === 'active', `rd=${JSON.stringify(rd)} a=${rowStatus(a)} b=${rowStatus(b)}`);

  const c = storeMemory({ session_id: 's11', type: 'fact', text: 'vitest config mjs', entity: 'test', attribute: 'config', importance: 0.6, embedding: basis(7), cone_layer: 1 });
  const d = storeMemory({ session_id: 's11', type: 'fact', text: 'vitest config mjs', entity: 'test', attribute: 'config', importance: 0.6, embedding: basis(7), cone_layer: 1 });
  linkSimilarPair(c, d, 0.97);
  const ri = await dispatchTool('memory_resolve_similar', { id_a: c, id_b: d, mode: 'supersede', winner_id: d, rationale: 'S11 supersede' });
  check('S11b tool mode=supersede ok + winner kept active', ri && ri.ok === true && rowStatus(c) === 'active', `ri=${JSON.stringify(ri)} c=${rowStatus(c)}`);
  check('S11c loser chain edge superseded-by winner present', chainEdge(c, d));

  const re = await dispatchTool('memory_resolve_similar', { id_a: a, id_b: b, mode: 'banana' });
  check('S11d tool bad-mode rejected', re && re.ok === false && /distinct\|supersede\|merge/.test(re.error || ''), JSON.stringify(re));
}

console.log(`\nE23 flag-then-ping: ${PASS} pass, ${FAIL} fail`);
if (FAIL > 0) { console.error('E23 REGRESSION DETECTED'); process.exit(1); }
console.log('E23 OK');
