// E5 bounded active set + E14 dedup pagination — PERMANENT regression test.
//
// Master report §6 batch (hạng echo-back #6). Two coupled scalability guarantees:
//   E5  — the active set is bounded at ACTIVE_SET_MAX; surplus lowest-value L1/L2 facets demote to
//         'archived' (preserving audit/lineage, reactivable via E7). L0 (raw episodes) + L3 (persona)
//         are CARDINAL — survive the bound forever (E6 guard). Value rank: importance ASC, then
//         recall_count ASC, then created_at ASC (oldest first). The demotion is GLOBAL (over the
//         whole active set), so each E5 case here `purge()`s to a deterministic baseline before
//         staging — that is what makes the surplus math + value-rank assertions exact.
//         Maintenance wiring lives in runActiveSetBoundStep (extracted so the test drives the REAL
//         gate without booting the embedding engine — runMaintenance early-returns when Brain-1
//         is not ready).
//   E14 — findDuplicates / findContradictions paginate across chunks: NO silent 1000-input
//         truncation (memory beyond index 1000 was NEVER dedup-checked — a coverage gap), work
//         bounded to O(n*window) (closes the BUG-HUNT-v3 DoS), pair ceiling lifted (DEDUP_MAX_PAIRS
//         default 50000, replaces the hard 5000 cap). Small sets (n <= window) degenerate to exact
//         full all-pairs — zero behavior change for the real <500 brute-fallback path.
//
// Drives the REAL enforceActiveSetBound (memory-store), findDuplicates / findContradictions
// (embedding-engine), and runActiveSetBoundStep (memory-maintenance wiring) against the REAL
// sqlite store, using basis-vector embeddings to isolate cosine without the live embedding model.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e5-e14.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e5_e14.mjs
import { storeMemory, deleteMemory, db, setEmbeddingModelId, getActiveWithEmbedding } from './memory-store.mjs';
import { findDuplicates, findContradictions } from './embedding-engine.mjs';
import { enforceActiveSetBound } from './memory-store.mjs';
import { runActiveSetBoundStep } from './memory-maintenance.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
	if (cond) { PASS++; console.log(`  PASS: ${name}`); }
	else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('S0 vec table ready', vecReady);

// Basis vectors isolate each row on its OWN orthogonal axis: cosine = 1.0 on exact, 0.0 across.
// NOTE: v[dim] on a Float32Array(EMBED_DIM) silently no-ops when dim >= EMBED_DIM, yielding an
// ALL-ZERO vector (cosine=NaN) — so every dim passed here MUST be < EMBED_DIM. For sets larger than
// EMBED_DIM we can't get N mutually-orthogonal single-dim axes, so sparsePairVec packs TWO dims at
// 1/sqrt(2) each: C(200,2)=19900 distinct combos, cosine is 1.0 on a full combo match, 0.5 on a
// single-dim overlap, 0.0 otherwise — all < SIMILARITY_THRESHOLD(0.92) except exact matches.
const basisVec = (dim) => { const v = new Float32Array(EMBED_DIM); v[dim % EMBED_DIM] = 1.0; return v; };
const sparsePairVec = (d1, d2) => { const v = new Float32Array(EMBED_DIM); const s = 1 / Math.SQRT2; v[d1 % EMBED_DIM] = s; v[d2 % EMBED_DIM] = s; return v; };
const TWO_SPARSE_AXES = 200;
const comboFor = (k) => { // k -> distinct (d1,d2) pair over TWO_SPARSE_AXES axes (C(200,2)=19900 combos)
	let d1 = 0;
	while (k >= (TWO_SPARSE_AXES - 1 - d1)) { k -= (TWO_SPARSE_AXES - 1 - d1); d1++; }
	return [d1, d1 + 1 + k];
};

// Hard-reset the sandbox to a deterministic baseline: delete every memory (memory row + vec via
// deleteMemory) + the archive_index. enforceActiveSetBound is GLOBAL over the active set, so a known
// empty baseline is what lets the surplus/value-rank assertions be exact.
function purgeAll() {
	const ids = db.prepare('SELECT id FROM memories').all().map(r => r.id);
	for (const id of ids) deleteMemory(id);
	db.exec('DELETE FROM memory_archive_index');
}

if (vecReady) {
	setEmbeddingModelId('e5e14-test-model');
	const getRow = db.prepare('SELECT id, status, cone_layer, importance, recall_count, type FROM memories WHERE id = ?');
	const countActive = () => db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'").get().n;
	const inArchiveIndex = (id) => !!db.prepare('SELECT 1 FROM memory_archive_index WHERE archived_id = ?').get(id);

	// ── E14: findDuplicates / findContradictions (paginated, cap lifted) ──────────────────
	console.log('\n── E14 dedup/contradiction pagination ──');

	// E14-T1: n <= window → exact full all-pairs (degenerate path = real <500 case, no regress).
	const mem5 = Array.from({ length: 5 }, (_, i) => ({ id: 1000 + i, embedding: basisVec(120) }));
	const d5 = findDuplicates(mem5);
	check('E14-T1 small set exact all-pairs (C(5,2)=10)', d5.length === 10, `got ${d5.length}`);
	check('E14-T1 pairs similarity > threshold', d5.every(d => d.similarity > 0.92));
	check('E14-T1 both a + b present per pair', d5.every(d => d.a && d.b));

	// E14-T2 (no silent 1000-input truncation). 2500 memories; every BULK row gets a DISTINCT
	// 2-sparse embedding (comboFor over C(200,2)=19900 combos → pairwise cosine ≤ 0.5 across the
	// bulk, < SIMILARITY_THRESHOLD so none register as dupes). ONLY the pair at indices 1500/1501
	// (ids 3500/3501) share an embedding (basisVec(20), cosine 1.0). The OLD code sliced the input
	// to the first 1000 → index 1500 was NEVER reached → that dup pair was SILENTLY MISSED. The
	// windowed pass reaches i=1500 (window=1000, jMax=2500), finds the pair. Exactly 1 dup, and it
	// is the far pair — direct proof no silent coverage drop past 1000. (All embeddings non-zero,
	// so unlike a naive dim>=EMBED_DIM overflow there are no zero-vector NaN rows masking the test.)
	const memFar = Array.from({ length: 2500 }, (_, i) => {
		// 0..1499 + 1502..2499 = 2498 bulk rows each on a distinct 2-sparse combo (cos ≤ 0.5 apart).
		const bulkIdx = i < 1500 ? i : i - 2; // skip slots 1500 & 1501
		const [d1, d2] = comboFor(bulkIdx);
		return { id: 2000 + i, embedding: sparsePairVec(d1, d2) };
	});
	memFar[1500] = { id: 3500, embedding: basisVec(20) }; // only this pair shares an axis → ONLY dup
	memFar[1501] = { id: 3501, embedding: basisVec(20) };
	const dFar = findDuplicates(memFar);
	check('E14-T2 sparse far dup: exactly 1 pair found (no truncation)', dFar.length === 1, `got ${dFar.length}`);
	const farPairIds = dFar.length === 1 ? new Set([dFar[0].a?.id, dFar[0].b?.id]) : new Set();
	check('E14-T2 far dup is the index-1500 pair (ids 3500/3501)', farPairIds.has(3500) && farPairIds.has(3501), `ids=${[...farPairIds].join(',')}`);

	// E14-T2b (pair ceiling lifted past old 5000 cap). 200 identical memories, n <= window → exact
	// full all-pairs = C(200,2) = 19900. Old code capped at 5000 (truncating coverage). 19900 > 5000
	// → cap lifted; 19900 < 50000 ceiling → not ceiling-saturated (so this is genuine cap removal,
	// not just a higher cut). Directly proves the old 5000-pairs cap is gone.
	const mem200 = Array.from({ length: 200 }, (_, i) => ({ id: 4000 + i, embedding: basisVec(121) }));
	const d200 = findDuplicates(mem200);
	check('E14-T2b 200-id set yields C(200,2)=19900 pairs (> old 5000 cap, < ceiling)', d200.length === 19900, `got ${d200.length}`);

	// E14-T3: explicit maxPairs ceiling respected — backward-compat signature.
	const dCap = findDuplicates(mem200, 100);
	check('E14-T3 explicit maxPairs=100 ceiling respected', dCap.length === 100, `got ${dCap.length}`);

	// E14-T4: control — distinct orthogonal embeddings → 0 dup pairs.
	const memOrtho = Array.from({ length: 8 }, (_, i) => ({ id: 5000 + i, embedding: basisVec(130 + i) }));
	const dOrtho = findDuplicates(memOrtho);
	check('E14-T4 orthogonal embeddings → 0 dup pairs', dOrtho.length === 0, `got ${dOrtho.length}`);

	// E14-T5: findContradictions — small set exact all-pairs (degenerate path, no regress).
	const memContr = Array.from({ length: 5 }, (_, i) => ({ id: 6000 + i, embedding: basisVec(140), type: 'preference', text: 'I prefer vim' }));
	const c5 = findContradictions(memContr);
	check('E14-T5 contradictions small set exact all-pairs (C(5,2)=10)', c5.length === 10, `got ${c5.length}`);

	// E14-T6: findContradictions large set — bounded (O(n*window), no DoS freeze) + ceiling lifted.
	// 3000 preference-type identical → ~4.5M pairs uncapped (BUG-HUNT-v3 DoS). Windowed + 50000
	// ceiling must return cleanly (no throw) and cap at 50000 (old cap was 5000).
	const memContrBig = Array.from({ length: 3000 }, (_, i) => ({ id: 7000 + i, embedding: basisVec(141), type: 'preference', text: 'I love vim' }));
	let bigThrew = false, cBigLen = -1;
	try { cBigLen = findContradictions(memContrBig).length; } catch { bigThrew = true; }
	check('E14-T6 contradictions large set did not throw (bounded)', bigThrew === false);
	check('E14-T6 contradictions large set ≤ ceiling 50000', cBigLen >= 0 && cBigLen <= 50000, `got ${cBigLen}`);
	check('E14-T6 contradictions reached ceiling 50000 (old 5000 cap lifted)', cBigLen === 50000, `got ${cBigLen}`);

	// E14-T7: 'general' type memories never participate in contradictions (skip guard preserved).
	const memGen = Array.from({ length: 5 }, (_, i) => ({ id: 8000 + i, embedding: basisVec(142), type: 'general', text: 'I prefer vim' }));
	const cGen = findContradictions(memGen);
	check("E14-T7 'general' type excluded from contradictions", cGen.length === 0, `got ${cGen.length}`);

	// ── E5: bounded active set (GLOBAL demotion; purge() per case for deterministic surplus) ──
	console.log('\n── E5 bounded active set ──');

	// E5-T1: exact surplus demote, L1/L2 only. Stage 14 L1 facets; cap=10 → demote 4. Archived rows
	// are cone 1 (never L0/L3), land in archive_index (revivable), and are excluded from active
	// retrieval. (E5-T6's archive assertions are merged here since later cases purge the set.)
	purgeAll();
	{
		const before = countActive();
		const ids = [];
		for (let i = 0; i < 14; i++) ids.push(storeMemory({ session_id: 'e5', type: 'preference', text: `drop${i}`, metadata: {}, embedding: basisVec(150 + i), importance: 0.1, entity: 'e5_t1', cone_layer: 1, intent_type: 'preference' }));
		const cap = before + 10;
		const r = enforceActiveSetBound({ maxActive: cap });
		check('E5-T1 gated true', r.gated === true, `r=${JSON.stringify(r).slice(0, 120)}`);
		check('E5-T1 activeCount reflects full staged set', r.activeCount === before + 14, `got ${r.activeCount} want ${before + 14}`);
		check('E5-T1 demoted === surplus (4)', r.demoted === 4, `demoted=${r.demoted} surplus=${r.surplus}`);
		check('E5-T1 active bounded to cap after demote', countActive() === cap, `active=${countActive()} cap=${cap}`);
		const arch = db.prepare("SELECT id, cone_layer FROM memories WHERE status='archived' AND entity='e5_t1'").all();
		check('E5-T1 4 archived rows', arch.length === 4, `got ${arch.length}`);
		check('E5-T1 all demoted rows are L1 (cone 1)', arch.every(r => r.cone_layer === 1));
		check('E5-T1 NO demoted row is L0 (cone 0)', arch.every(r => r.cone_layer !== 0));
		check('E5-T1 NO demoted row is L3 (cone 3)', arch.every(r => r.cone_layer !== 3));
		check('E5-T1 all archived are in memory_archive_index (revivable)', arch.every(r => inArchiveIndex(r.id)));
		const activeEmb = getActiveWithEmbedding();
		check('E5-T1 archived rows excluded from active retrieval', arch.every(r => !activeEmb.some(m => String(m.id) === String(r.id))));
	}

	// E5-T2: cardinal survives DESPITE lowest importance + exact value-rank. Stage 6 L1
// (importance 0.01..0.06) + 2 L0 + 2 L3 each at importance 0.001 (the LOWEST of all). cap=6 →
	// surplus 4 → demote the 4 lowest-importance L1/L2 = the L1 @ 0.01,0.02,0.03,0.04. The L0/L3
	// at 0.001 would be "first to demote" by importance alone — they survive ONLY because the
	// cone_layer IN (1,2) guard excludes them. Strong proof the E6 guard beats importance.
	purgeAll();
	{
		const before = countActive();
		const l1Ids = [];
		for (let i = 0; i < 6; i++) l1Ids.push(storeMemory({ session_id: 'e5', type: 'preference', text: `v${i}`, metadata: {}, embedding: basisVec(160 + i), importance: 0.01 * (i + 1), entity: 'e5_t2', cone_layer: 1, intent_type: 'preference' }));
		const l0Ids = [storeMemory({ session_id: 'e5', type: 'greeting', text: 'ep0', metadata: {}, embedding: basisVec(170), importance: 0.001, entity: 'e5_t2', cone_layer: 0, intent_type: 'greeting' }), storeMemory({ session_id: 'e5', type: 'greeting', text: 'ep1', metadata: {}, embedding: basisVec(171), importance: 0.001, entity: 'e5_t2', cone_layer: 0, intent_type: 'greeting' })];
		const l3Ids = [storeMemory({ session_id: 'e5', type: 'persona', text: 'persona0', metadata: {}, embedding: basisVec(172), importance: 0.001, entity: 'e5_t2', cone_layer: 3, intent_type: 'fact' }), storeMemory({ session_id: 'e5', type: 'persona', text: 'persona1', metadata: {}, embedding: basisVec(173), importance: 0.001, entity: 'e5_t2', cone_layer: 3, intent_type: 'fact' })];
		const cap = before + 6;
		const r = enforceActiveSetBound({ maxActive: cap });
		check('E5-T2 demoted === 4 (lowest-value L1/L2)', r.demoted === 4, `demoted=${r.demoted}`);
		const archIds = db.prepare("SELECT id FROM memories WHERE status='archived' AND entity='e5_t2'").all().map(r => String(r.id));
		const expectedDemoted = l1Ids.slice(0, 4).map(String);
		check('E5-T2 demoted the 4 lowest-importance L1 (0.01,0.02,0.03,0.04)', archIds.length === 4 && archIds.every(id => expectedDemoted.includes(id)) && expectedDemoted.every(id => archIds.includes(id)), `archived=${archIds.join(',')} expected=${expectedDemoted.join(',')}`);
		check('E5-T2 top-2 L1 (importance 0.05,0.06) survived', l1Ids.slice(4).every(id => getRow.get(id)?.status === 'active'));
		check('E5-T2 BOTH L0 cardinal survived despite LOWEST importance (0.001)', l0Ids.every(id => getRow.get(id)?.status === 'active'), `${l0Ids.map(id => getRow.get(id)?.status).join(',')}`);
		check('E5-T2 BOTH L3 cardinal survived despite LOWEST importance (0.001)', l3Ids.every(id => getRow.get(id)?.status === 'active'), `${l3Ids.map(id => getRow.get(id)?.status).join(',')}`);
		check('E5-T2 no cardinal demoted (archived all cone 1)', db.prepare("SELECT cone_layer FROM memories WHERE status='archived' AND entity='e5_t2'").all().every(r => r.cone_layer === 1));
	}

	// E5-T3: ALL surplus is cardinal → honest report, NO demote (never violate the cardinal guard).
	// 5 L0 + 5 L3 = 10 active, all cardinal; cap=6 → surplus 4 but ZERO demotable L1/L2.
	purgeAll();
	{
		const before = countActive();
		for (let i = 0; i < 5; i++) storeMemory({ session_id: 'e5', type: 'greeting', text: `cL0_${i}`, metadata: {}, embedding: basisVec(180 + i), importance: 0.05, entity: 'e5_t3', cone_layer: 0, intent_type: 'greeting' });
		for (let i = 0; i < 5; i++) storeMemory({ session_id: 'e5', type: 'persona', text: `cL3_${i}`, metadata: {}, embedding: basisVec(186 + i), importance: 0.05, entity: 'e5_t3', cone_layer: 3, intent_type: 'fact' });
		const cap = before + 6;
		const r = enforceActiveSetBound({ maxActive: cap });
		check('E5-T3 gated true (over cap)', r.gated === true);
		check('E5-T3 demoted 0 (cardinal surplus, no L1/L2)', r.demoted === 0, `demoted=${r.demoted}`);
		check('E5-T3 reason reports cardinal guard', typeof r.reason === 'string' && /no demotable/i.test(r.reason), `reason="${r.reason}"`);
		check('E5-T3 active unchanged (did NOT violate cardinal)', countActive() === before + 10, `active=${countActive()} want ${before + 10}`);
	}

	// E5-T4: below cap → no-op.
	purgeAll();
	{
		const before = countActive();
		for (let i = 0; i < 3; i++) storeMemory({ session_id: 'e5', type: 'preference', text: `sub${i}`, metadata: {}, embedding: basisVec(190 + i), importance: 0.2, entity: 'e5_t4', cone_layer: 1, intent_type: 'preference' });
		const r = enforceActiveSetBound({ maxActive: before + 1000 });
		check('E5-T4 below cap → not gated', r.gated === false, `r=${JSON.stringify(r)}`);
		check('E5-T4 demoted 0', r.demoted === 0);
		check('E5-T4 active unchanged', countActive() === before + 3);
	}

	// E5-T5: disabled cap (maxActive 0 / negative) → no-op, reason disabled.
	{
		const before = countActive();
		const r0 = enforceActiveSetBound({ maxActive: 0 });
		check('E5-T5 maxActive=0 → not gated', r0.gated === false);
		check('E5-T5 disabled reason', typeof r0.reason === 'string' && /disabled/i.test(r0.reason));
		check('E5-T5 active unchanged when disabled', countActive() === before);
	}

	// E5-W: wiring — runActiveSetBoundStep drives enforceActiveSetBound under the
	// ENABLE_ACTIVE_SET_BOUND gate, using process.env.ACTIVE_SET_MAX. Proves the maintenance wiring
	// is hooked (gate ON → demotes; gate OFF → no-op even when over cap) without booting Brain-1.
	purgeAll();
	{
		const before = countActive();
		for (let i = 0; i < 12; i++) storeMemory({ session_id: 'e5', type: 'preference', text: `w${i}`, metadata: {}, embedding: basisVec(200 + i), importance: 0.1, entity: 'e5_w', cone_layer: 1, intent_type: 'preference' });
		process.env.ACTIVE_SET_MAX = String(before + 4); // surplus 8 → demote 8
		const out = {};
		runActiveSetBoundStep(out);
		check('E5-W wiring gate ON → activeSetBound present', !!out.activeSetBound);
		check('E5-W wiring gated true', out.activeSetBound?.gated === true, `r=${JSON.stringify(out.activeSetBound).slice(0, 120)}`);
		check('E5-W wiring demoted 8 (via env ACTIVE_SET_MAX)', out.activeSetBound?.demoted === 8, `demoted=${out.activeSetBound?.demoted}`);
		check('E5-W wiring active bounded to cap', countActive() === before + 4, `active=${countActive()} cap=${before + 4}`);
		// gate OFF → no-op even though env ACTIVE_SET_MAX would demand a huge demote.
		process.env.ENABLE_ACTIVE_SET_BOUND = 'false';
		process.env.ACTIVE_SET_MAX = String(before + 1); // would demand surplus if gate on — must NOT demote
		const beforeOff = countActive();
		const out2 = {};
		runActiveSetBoundStep(out2);
		check('E5-W wiring gate OFF → not gated', out2.activeSetBound?.gated === false, `r=${JSON.stringify(out2.activeSetBound)}`);
		check('E5-W wiring gate OFF reason disabled', typeof out2.activeSetBound?.reason === 'string' && /gate disabled/i.test(out2.activeSetBound.reason));
		check('E5-W wiring gate OFF → active unchanged', countActive() === beforeOff, `active=${countActive()} want ${beforeOff}`);
		delete process.env.ACTIVE_SET_MAX;
		delete process.env.ENABLE_ACTIVE_SET_BOUND;
	}
}

console.log(`\n═══ E5+E14: ${PASS} pass, ${FAIL} fail ═══`);
if (FAIL > 0) process.exit(1);
