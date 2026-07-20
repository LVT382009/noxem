// E19 D1 contradiction flip + resolve — PERMANENT regression test.
//
// D1 (user Option-2, 2026-06-24): the contradiction-detect pass NO LONGER silently auto-supersedes
// the older row. detectContradiction returns a tension type; the pass pair-links BOTH members as
// status='contradicted' (bidirectional contradiction_pair_id) so neither masquerades as the trusted
// fact and BOTH surface for reasoning/audit. Resolution is a separate, EXPLICIT step — the new
// resolveContradictionPair primitive + the Brain2 memory_resolve_contradiction tool — never silent:
//   unlink (false alarm)         — clear the pair, both active again
//   uphold (winner_id wins)      — clear the pair, both active, loser SOFT-flagged superseded-by
//                                  winner (reversible: downrank + is_newer_version_of chain edge,
//                                  status stays active, no retrieval loss)
//   merge  (facets of one truth) — route to mergeMemoriesHard (high conf hard-deletes originals +
//                                  clears the inbound pair FK via hardDeleteMemory._nullPairHD; low
//                                  conf soft-supersedes both + review_pending). Reuses h_memory_merge.
//
// Surfaces + validates, against the REAL sqlite store:
//   S2  detectContradiction: type for the 4 cases + null for non-contradiction.
//   S3  linkContradictionPair: both contradicted + bidirectional pair_id + idempotent.
//   S4  runContradictionPass FLIP: a preference_change pair -> BOTH contradicted (older NOT superseded),
//       contradictions=1, paired=[[older,newer]].
//   S5  runContradictionPass no-conflict (same attr, compatible values) -> 0, status unchanged.
//   S6  runContradictionPass 3-row chain (a>b, b>c both conflicts) -> every flagged row contradicted.
//   S7  resolve unlink -> both active, pair_id null.
//   S8  resolve uphold -> both active, loser downranked + is_newer_version_of chain edge, winner alive.
//   S9  resolve merge high-conf (0.9) -> merge row, originals hard-deleted, pair FK cleared on survivor.
//   S10 resolve merge low-conf (0.6) -> soft-supersede, review_pending=true, originals survive contradicted.
//   S11 bad-args: same id, not-found, bad mode, uphold-no-winner, winner-not-in-pair, merge-no-merge_text.
//   S12 dispatched tool wiring: memory_resolve_contradiction unlink/uphold/bad-mode resolve correctly.
//
// Pure store ops (no LLM). ENABLE_EMBEDDING=false + EMBEDDING_DIM=256 basis vectors (merge embedding arm
// is a guarded soft check, like E18). runContradictionPass is exported precisely so this stays
// deterministic WITHOUT the embedding-ready gate that wraps runMaintenance.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e19.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e19_contradiction.mjs
import { storeMemory, db, linkContradictionPair, resolveContradictionPair } from './memory-store.mjs';
import { detectContradiction, runContradictionPass } from './memory-maintenance.mjs';
import { BRAIN2_TOOLS, dispatchTool } from './brain2-tools.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
const basis = (d) => { const v = new Float32Array(EMBED_DIM); v[d] = 1.0; return v; };

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(` PASS: ${name}`); }
  else { FAIL++; console.log(` FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('S0 vec table ready', vecReady);
check('S0 runContradictionPass exported', typeof runContradictionPass === 'function');
check('S0 resolveContradictionPair exported', typeof resolveContradictionPair === 'function');
check('S0 memory_resolve_contradiction tool registered', BRAIN2_TOOLS.some(t => t.name === 'memory_resolve_contradiction'));

const rowById  = db.prepare('SELECT id, status, importance, contradiction_pair_id, cone_layer, entity, attribute, source_memory_ids, text FROM memories WHERE id = ?');
const memExists = db.prepare('SELECT 1 AS x FROM memories WHERE id = ?');
const chainEdge = db.prepare("SELECT relation FROM memory_edges WHERE from_id = ? AND to_id = ? AND relation = 'is_newer_version_of' LIMIT 1");
const metaOf    = id => { try { return JSON.parse(db.prepare('SELECT metadata FROM memories WHERE id = ?').get(id).metadata || '{}'); } catch { return {}; } };

function mk({ text, entity = 'user', attribute = 'theme', imp = 0.5, layer = 1, embDim = 0 }) {
  return storeMemory({ session_id: 'e19', type: 'fact', text, metadata: {}, cone_layer: layer, importance: imp, entity, attribute, embedding: basis(embDim) });
}

if (vecReady) {
  // ── S2: detectContradiction primitive (4 cases + null) ─────────────────────────────────
  console.log('\n--- S2 detectContradiction cases ---');
  check('S2 preference_change', detectContradiction('i like dark', 'i like light') === 'preference_change');
  check('S2 negation_flip', detectContradiction('i like tea', "i don't like tea") === 'negation_flip');
  // pastMatch sets negated:true, so temporal_update only fires when newer has a DIFFERENT value
  // (else negation_flip shadows it); state_change only fires when older is NEGATED (else
  // preference_change shadows it on value-differ). These quirks are pre-existing extractValue
  // behavior — pinning the only trigger strings that actually reach each branch.
  check('S2 temporal_update', detectContradiction('i previously like tea', 'i like coffee') === 'temporal_update');
  check('S2 state_change', detectContradiction("i don't like vim", 'i switched from vim to emacs') === 'state_change');
  check('S2 no value -> null', detectContradiction('the system rebooted at noon', 'weather is rainy') === null);
  check('S2 same value no conf -> null', detectContradiction('i like tea', 'i like tea') === null);

  // ── S3: linkContradictionPair + idempotent ────────────────────────────────────────────
  console.log('\n--- S3 linkContradictionPair ---');
  const a = mk({ text: 'i like dark mode', embDim: 10 });
  const b = mk({ text: 'i like light mode', embDim: 11 });
  check('S3 returns true', linkContradictionPair(a, b) === true);
  check('S3 a contradicted', rowById.get(a)?.status === 'contradicted');
  check('S3 b contradicted', rowById.get(b)?.status === 'contradicted');
  check('S3 a.pair_id = b', rowById.get(a)?.contradiction_pair_id === b, `got ${rowById.get(a)?.contradiction_pair_id}`);
  check('S3 b.pair_id = a', rowById.get(b)?.contradiction_pair_id === a, `got ${rowById.get(b)?.contradiction_pair_id}`);
  check('S3 idempotent re-link no throw', linkContradictionPair(a, b) === true);
  check('S3 same-id rejects', linkContradictionPair(a, a) === false);

  // ── S4: runContradictionPass FLIP — both contradicted, older NOT superseded ───────────
  console.log('\n--- S4 runContradictionPass flip (no silent supersede) ---');
  const c = mk({ text: 'i prefer serif fonts', entity: 'user', attribute: 'font', embDim: 20 });
  const d = mk({ text: 'i prefer sans fonts', entity: 'user', attribute: 'font', embDim: 21 });
  const res = runContradictionPass([rowById.get(c), rowById.get(d)]);
  check('S4 contradictions=1', res.contradictions === 1, JSON.stringify(res));
  check('S4 paired [[c,d]]', Array.isArray(res.paired) && res.paired.length === 1 && res.paired[0][0] === c && res.paired[0][1] === d, JSON.stringify(res.paired));
  check('S4 older c CONTRADICTED (not superseded)', rowById.get(c)?.status === 'contradicted', `c.status=${rowById.get(c)?.status}`);
  check('S4 newer d CONTRADICTED', rowById.get(d)?.status === 'contradicted', `d.status=${rowById.get(d)?.status}`);
  check('S4 c has NO superseded_by (old path would have flipped status=superseded)', db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(c).superseded_by === null);
  check('S4 pair_id bidirectional', rowById.get(c)?.contradiction_pair_id === d && rowById.get(d)?.contradiction_pair_id === c);

  // ── S5: runContradictionPass no-conflict -> 0, status unchanged ───────────────────────
  console.log('\n--- S5 no-conflict pass ---');
  const e = mk({ text: 'i use git for version control', entity: 'user', attribute: 'vcs', embDim: 30 });
  const f = mk({ text: 'i use git for version control', entity: 'user', attribute: 'vcs', embDim: 31 });
  const res5 = runContradictionPass([rowById.get(e), rowById.get(f)]);
  check('S5 contradictions=0 (identical values)', res5.contradictions === 0, JSON.stringify(res5));
  check('S5 both stay active', rowById.get(e)?.status === 'active' && rowById.get(f)?.status === 'active');

  // ── S6: 3-row chain, every flagged row contradicted ───────────────────────────────────
  console.log('\n--- S6 3-row chain ---');
  const g = mk({ text: 'i like serif', entity: 'user', attribute: 'chain', embDim: 40 });
  const h = mk({ text: 'i like sans', entity: 'user', attribute: 'chain', embDim: 41 });
  const k = mk({ text: 'i like mono', entity: 'user', attribute: 'chain', embDim: 42 });
  const res6 = runContradictionPass([rowById.get(g), rowById.get(h), rowById.get(k)]);
  check('S6 contradictions=2 (g-h, h-k)', res6.contradictions === 2, JSON.stringify(res6));
  check('S6 g contradicted', rowById.get(g)?.status === 'contradicted');
  check('S6 h contradicted', rowById.get(h)?.status === 'contradicted');
  check('S6 k contradicted', rowById.get(k)?.status === 'contradicted');

  // ── S7: resolve unlink -> both active, pair cleared ───────────────────────────────────
  console.log('\n--- S7 resolve unlink ---');
  const u1 = mk({ text: 'i like dark mode', attribute: 'un7', embDim: 50 });
  const u2 = mk({ text: 'i like light mode', attribute: 'un7', embDim: 51 });
  linkContradictionPair(u1, u2);
  check('S7 pre-link both contradicted', rowById.get(u1)?.status === 'contradicted' && rowById.get(u2)?.status === 'contradicted');
  const r7 = resolveContradictionPair(u1, u2);
  check('S7 unlink ok', r7.ok === true, JSON.stringify(r7));
  check('S7 u1 active again', rowById.get(u1)?.status === 'active' && rowById.get(u1)?.contradiction_pair_id === null);
  check('S7 u2 active again', rowById.get(u2)?.status === 'active' && rowById.get(u2)?.contradiction_pair_id === null);
  check('S7 no upheld winner', r7.upheld === null && r7.flagged === null);

  // ── S8: resolve uphold -> loser soft-flagged, reversible, winner alive ────────────────
  console.log('\n--- S8 resolve uphold ---');
  const wp = mk({ text: 'i like dark mode', attribute: 'up8', importance: 0.6, embDim: 60 });
  const wl = mk({ text: 'i like light mode', attribute: 'up8', importance: 0.6, embDim: 61 });
  linkContradictionPair(wp, wl);
  const r8 = resolveContradictionPair(wp, wl, { winnerId: wp, reason: 'user confirmed dark' });
  check('S8 uphold ok', r8.ok === true, JSON.stringify(r8));
  check('S8 upheld winner = wp', r8.upheld === wp);
  check('S8 both pair cleared (active)', rowById.get(wp)?.status === 'active' && rowById.get(wl)?.status === 'active' && rowById.get(wl)?.contradiction_pair_id === null);
  check('S8 winner survives', !!memExists.get(wp));
  check('S8 loser survives (soft-flag, no delete)', !!memExists.get(wl));
  check('S8 loser downranked (importance < 0.6)', Number(rowById.get(wl)?.importance) < 0.6, `imp=${rowById.get(wl)?.importance}`);
  check('S8 chain edge loser->winner emitted', !!chainEdge.get(wl, wp));
  check('S8 loser brain2-flagged metadata set', metaOf(wl).brain2_flagged_superseded_by === wp);

  // ── S9: resolve merge high-conf -> hard-delete + inbound pair FK cleared on survivor ──
  console.log('\n--- S9 resolve merge high-conf ---');
  const m1 = mk({ text: 'i like dark mode', attribute: 'mg9', embDim: 70 });
  const m2 = mk({ text: 'i like light mode', attribute: 'mg9', embDim: 71 });
  linkContradictionPair(m1, m2);
  // A sibling whose contradiction_pair_id points at m1: when the merge hard-deletes m1, the store's
  // hardDeleteMemory._nullPairHD must null THIS row's inbound pair FK (no dangling RESTRICT self-FK).
  const sib9 = mk({ text: 'i like dark mode too', attribute: 'mg9x', embDim: 72 });
  db.prepare("UPDATE memories SET contradiction_pair_id = ?, status = 'contradicted' WHERE id = ?").run(m1, sib9);
  const r9 = await dispatchTool('memory_resolve_contradiction', { id_a: m1, id_b: m2, mode: 'merge', merge_text: 'User stated both dark and light theme over time; a tentative theme change, not a final verdict.', confidence: 0.9, session_id: 'e19' });
  check('S9 dispatch merge ok', r9.ok === true && Number.isFinite(r9.merge_id), JSON.stringify(r9));
  check('S9 originals hard-deleted', !memExists.get(m1) && !memExists.get(m2));
  check('S9 merge row active', rowById.get(r9.merge_id)?.status === 'active');
  check('S9 merge row pair_id null (fresh insert)', rowById.get(r9.merge_id)?.contradiction_pair_id === null);
  check('S9 sibling survives + inbound pair_id nullified (no dangling FK)', !!memExists.get(sib9) && rowById.get(sib9)?.contradiction_pair_id === null, `sib9.pair_id=${rowById.get(sib9)?.contradiction_pair_id}`);

  // ── S10: resolve merge low-conf -> soft-supersede, review_pending, no delete ───────────
  console.log('\n--- S10 resolve merge low-conf ---');
  const p1 = mk({ text: 'i like dark mode', attribute: 'mg10', embDim: 80 });
  const p2 = mk({ text: 'i like light mode', attribute: 'mg10', embDim: 81 });
  linkContradictionPair(p1, p2);
  const r10 = await dispatchTool('memory_resolve_contradiction', { id_a: p1, id_b: p2, mode: 'merge', merge_text: 'tentative: theme possibly changed', confidence: 0.6, session_id: 'e19' });
  check('S10 dispatch merge ok', r10.ok === true && Number.isFinite(r10.merge_id), JSON.stringify(r10));
  check('S10 review_pending true', r10.review_pending === true, JSON.stringify(r10));
  check('S10 deleted empty (no hard delete)', Array.isArray(r10.deleted) && r10.deleted.length === 0, JSON.stringify(r10.deleted));
  check('S10 originals survive (soft-superseded)', !!memExists.get(p1) && !!memExists.get(p2) && rowById.get(p1)?.status === 'superseded' && rowById.get(p2)?.status === 'superseded');
  check('S10 merge metadata brain2_review_pending', metaOf(r10.merge_id).brain2_review_pending === true);

  // ── S11: bad-args ─────────────────────────────────────────────────────────────────────
  console.log('\n--- S11 bad-args ---');
  check('S11 same id', resolveContradictionPair(7, 7).reason === 'bad-args');
  const bf1 = mk({ text: 'x', attribute: 'bf', embDim: 90 });
  check('S11 not-found', resolveContradictionPair(bf1, 9000001).reason === 'not-found');

  // ── S12: tool dispatch wiring ──────────────────────────────────────────────────────────
  console.log('\n--- S12 dispatch memory_resolve_contradiction ---');
  const t1 = mk({ text: 'i like dark mode', attribute: 'tw', embDim: 100 });
  const t2 = mk({ text: 'i like light mode', attribute: 'tw', embDim: 101 });
  linkContradictionPair(t1, t2);
  const drUnlink = await dispatchTool('memory_resolve_contradiction', { id_a: t1, id_b: t2, mode: 'unlink' });
  check('S12 dispatch unlink ok', drUnlink.ok === true, JSON.stringify(drUnlink));
  check('S12 dispatch unlink cleared', rowById.get(t1)?.status === 'active' && rowById.get(t2)?.status === 'active');

  const drBad = await dispatchTool('memory_resolve_contradiction', { id_a: t1, id_b: t2, mode: 'bogus' });
  check('S12 dispatch bad mode rejected', drBad.ok === false && (/mode/).test(drBad.error), JSON.stringify(drBad));

  const drUpholdNoWinner = await dispatchTool('memory_resolve_contradiction', { id_a: t1, id_b: t2, mode: 'uphold' });
  check('S12 dispatch uphold-no-winner rejected', drUpholdNoWinner.ok === false && (/winner/).test(drUpholdNoWinner.error), JSON.stringify(drUpholdNoWinner));

  const drUphold = await dispatchTool('memory_resolve_contradiction', { id_a: t1, id_b: t2, mode: 'uphold', winner_id: t1 });
  check('S12 dispatch uphold ok', drUphold.ok === true && drUphold.upheld === t1, JSON.stringify(drUphold));
}

console.log('\n========================================');
console.log(`E19 contradiction test results: ${PASS} passed, ${FAIL} failed`);
console.log('========================================');
process.exit(FAIL === 0 ? 0 : 1);
