// E9 — Bi-temporal edge cascade + asOf graph traversal.
// PERMANENT regression test.
//
// Ledger E9 (narrow tailgates, FF delta c): two gaps in the ALREADY-present bi-temporal edge layer.
//   Gap 1 — cascade: when a memory is superseded/archived, its linked edges stayed valid_until IS
//           NULL (no cascade), so the graph's end-validity drifted out of sync with the memory's.
//   Gap 2 — asOf: traverseMemoryGraph + getEdgesByRelation hardcoded datetime('now') → a caller
//           couldn't reconstruct the graph's state at a past timestamp (no asOf param, unlike the
//           memory-level /memory/at-time endpoint).
//
// Fix: cascadeInvalidateEdges(id) fires inside updateMemoryStatus's non-active tx (same tx as the
// status flip + vector prune); asOf-variant prepared statements mirror the now-path edge queries
// with datetime(?) (SQLite normalizes the bound ISO8601 to the space-format valid_until is stored
// in, so the string comparison is correct) and the endpoint threads ?asOf=<ISO> through.
//
// Halves: (1) asOf traversal + edges logic, deterministic against a KNOWN-invalidated edge (parse
// its valid_until and pick asOf one second before/after — no wall-clock race); (2) cascade proves
// touching edges die on supersede AND on archive, while an edge between two OTHER memories survives;
// (3) backward-compat (no asOf == prior behavior) + status reactivation does NOT re-open edges.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e9.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e9.mjs
import { storeMemory, deleteMemory, updateMemoryStatus, storeEdge, getEdge, getEdgesByRel, traverseMemoryGraph, invalidateEdgeById, getMemory, db } from './memory-store.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
	if (cond) { PASS++; console.log(`  PASS: ${name}`); }
	else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}
const basis = (d) => { const v = new Float32Array(EMBED_DIM); v[d % EMBED_DIM] = 1.0; return v; };
// SQLite datetime('now') yields "YYYY-MM-DD HH:MM:SS" (space, UTC, second precision). Parse it back
// to a JS Date (treat as UTC) so the test can construct asOf timestamps strictly before/after it
// WITHOUT racing the wall clock.
const parseSqliteTs = (s) => new Date(s.replace(' ', 'T') + 'Z');
const iso = (d) => d.toISOString();
const SCOPE_BASE = 'e9-' + Math.floor(Math.random() * 1e9);

// best-effort cleanup of any rows this test created (memories + their edges)
function cleanupMemories(ids) {
	for (const id of ids) {
		try { deleteMemory(id); } catch {}
	}
	try { db.prepare(`DELETE FROM memory_edges WHERE from_id IN (${ids.map(()=>'?').join(',')}) OR to_id IN (${ids.map(()=>'?').join(',')})`).all(...ids, ...ids); } catch {}
}
function edgeIdByEndpoints(from, to, rel) {
	const row = db.prepare('SELECT id FROM memory_edges WHERE from_id=? AND to_id=? AND relation=? ORDER BY id DESC LIMIT 1').get(from, to, rel);
	return row ? row.id : null;
}

// ═══ Wait for the vec table (storeMemory needs it for pruneVectors paths) ═══
let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('S0 vec table ready', vecReady);

if (vecReady) {
	let memSeq = 0;
	const mk = (label) => storeMemory({ session_id: SCOPE_BASE, type: 'preference', text: label, metadata: {}, embedding: basis(memSeq++ % EMBED_DIM), importance: 0.5, entity: SCOPE_BASE, cone_layer: 1, intent_type: 'preference' });

	// ═══ Part 1 — asOf traversal + edges logic (deterministic against a KNOWN invalidation time) ═══
	{
		console.log('\n── A1 asOf: edges live before invalidation, dead after (traverse + getEdgesByRel) ──');
		const m0 = mk('asof-m0'), m1 = mk('asof-m1');
		const eId = storeEdge({ from_id: m0, to_id: m1, relation: 'parent', strength: 1.0, source_session_id: SCOPE_BASE });
		check('A1 edge created with valid_until NULL', getEdge(eId).valid_until === null);
		// NOW: edge is live → traverse from m0 reaches m1
		const nowReach = traverseMemoryGraph(m0, 3, 20, 'outgoing', '').map(s => s.to_id);
		check('A1 NOW traverse from m0 reaches m1 (live edge)', nowReach.includes(m1), `reached=[${nowReach}]`);
		check('A1 NOW getEdgesByRel(parent) includes the edge', getEdgesByRel('parent', 50).some(e => e.id === eId));
		// Invalidate the edge explicitly → valid_until = datetime('now') (deterministic T_inv)
		invalidateEdgeById(eId);
		const inv = getEdge(eId);
		check('A1 invalidateEdgeById set valid_until non-null', inv.valid_until !== null, `vu=${inv?.valid_until}`);
		const T_inv = parseSqliteTs(inv.valid_until);
		const T_before = new Date(T_inv.getTime() - 1000);  // 1s strictly before invalidation
		const T_at     = new Date(T_inv.getTime());          // exactly the invalidation second
		const T_after  = new Date(T_inv.getTime() + 1000);   // 1s strictly after
		// NOW: edge dead (valid_until <= now)
		const nowReach2 = traverseMemoryGraph(m0, 3, 20, 'outgoing', '').map(s => s.to_id);
		check('A1 NOW traverse EXCLUDES m1 after invalidation', !nowReach2.includes(m1), `reached=[${nowReach2}]`);
		check('A1 NOW getEdgesByRel(parent) EXCLUDES the edge after invalidation', !getEdgesByRel('parent', 50).some(e => e.id === eId));
		// asOf BEFORE invalidation → edge was live → reaches m1
		const reachBefore = traverseMemoryGraph(m0, 3, 20, 'outgoing', '', iso(T_before)).map(s => s.to_id);
		check('A1 asOf<inv traverse REACHES m1 (edge was live at that time)', reachBefore.includes(m1), `reached=[${reachBefore}]`);
		check('A1 asOf<inv getEdgesByRel(parent) INCLUDES the edge', getEdgesByRel('parent', 50, iso(T_before)).some(e => e.id === eId));
		// asOf AT the invalidation second → exclusive end → dead (valid_until > datetime(asOf) is FALSE at equality)
		const reachAt = traverseMemoryGraph(m0, 3, 20, 'outgoing', '', iso(T_at)).map(s => s.to_id);
		check('A1 asOf==inv traverse EXCLUDES m1 (valid_until is exclusive end)', !reachAt.includes(m1), `reached=[${reachAt}]`);
		// asOf AFTER invalidation → dead
		const reachAfter = traverseMemoryGraph(m0, 3, 20, 'outgoing', '', iso(T_after)).map(s => s.to_id);
		check('A1 asOf>inv traverse EXCLUDES m1', !reachAfter.includes(m1), `reached=[${reachAfter}]`);

		console.log('\n── A2 asOf: direction "both" + incoming also honors the cutoff ──');
		const mX = mk('asof-mX');
		const eIn = storeEdge({ from_id: mX, to_id: m0, relation: 'derived', strength: 1.0, source_session_id: SCOPE_BASE }); // mX → m0
		invalidateEdgeById(eIn);
		const T_in = parseSqliteTs(getEdge(eIn).valid_until);
		const T_in_before = new Date(T_in.getTime() - 1000);
		// 'both' from m0: outgoing (m0→m1, dead) + incoming (mX→m0, dead at now) → none at now
		const bothNow = traverseMemoryGraph(m0, 3, 20, 'both', '').map(s => `${s.from_id}->${s.to_id}`);
		check('A2 NOW traverse both from m0 excludes the dead incoming edge', !bothNow.some(p => p === `${mX}->${m0}`), `bothNow=[${bothNow}]`);
		const bothAsOf = traverseMemoryGraph(m0, 3, 20, 'both', '', iso(T_in_before)).map(s => `${s.from_id}->${s.to_id}`);
		check('A2 asOf<inv traverse both SURFACES the incoming edge', bothAsOf.some(p => p === `${mX}->${m0}`), `bothAsOf=[${bothAsOf}]`);
		const inReachAsOf = traverseMemoryGraph(m0, 3, 20, 'incoming', '', iso(T_in_before)).map(s => `${s.from_id}->${s.to_id}`);
		check('A2 asOf<inv traverse incoming SURFACES mX→m0', inReachAsOf.some(p => p === `${mX}->${m0}`), `inAsOf=[${inReachAsOf}]`);

		cleanupMemories([m0, m1, mX]);
	}

	// ═══ Part 2 — cascadeInvalidateEdges (supersede + archive) ═══
	{
		console.log('\n── C1 cascade: supersede invalidates ONLY touching edges ──');
		const a = mk('c1-a'), b = mk('c1-b'), c = mk('c1-c');
		const e_ab = storeEdge({ from_id: a, to_id: b, relation: 'parent', source_session_id: SCOPE_BASE });     // touches b
		const e_bc = storeEdge({ from_id: b, to_id: c, relation: 'parent', source_session_id: SCOPE_BASE });     // touches b
		const e_ac = storeEdge({ from_id: a, to_id: c, relation: 'child',  source_session_id: SCOPE_BASE });     // touches neither (a→c; b NOT involved)
		const e_ba = storeEdge({ from_id: b, to_id: a, relation: 'ref',    source_session_id: SCOPE_BASE });     // touches b (incoming to b? from_id=b)
		check('C1 all 4 edges start valid_until NULL', [e_ab, e_bc, e_ac, e_ba].every(id => getEdge(id).valid_until === null));
		// supersede b → cascade invalidates edges touching b: e_ab(b as to_id), e_bc(b as from_id), e_ba(b as from_id). e_ac survives.
		updateMemoryStatus(b, 'superseded', c);
		check('C1 e_ab (touching b) cascade-invalidated', getEdge(e_ab).valid_until !== null);
		check('C1 e_bc (touching b) cascade-invalidated', getEdge(e_bc).valid_until !== null);
		check('C1 e_ba (touching b, from_id=b) cascade-invalidated', getEdge(e_ba).valid_until !== null);
		check('C1 e_ac (b NOT involved) SURVIVES (valid_until still NULL)', getEdge(e_ac).valid_until === null, `vu=${getEdge(e_ac).valid_until}`);
		// via getEdgesByRel(now): parent excludes e_ab/e_bc, child includes e_ac
		check('C1 getEdgesByRel(parent) drops the two touching edges', !getEdgesByRel('parent', 50).some(e => e.id === e_ab || e.id === e_bc));
		check('C1 getEdgesByRel(child) still lists e_ac (survivor)', getEdgesByRel('child', 50).some(e => e.id === e_ac));

		console.log('\n── C2 cascade: archive ALSO invalidates touching edges (non-active terminal) ──');
		// e_ac still live (a active, c active). Archive a → cascade invalidates edges touching a: e_ac(a as from_id), e_ba(a as to_id, already invalid).
		updateMemoryStatus(a, 'archived');
		check('C2 archive a → e_ac (touching a) now invalidated', getEdge(e_ac).valid_until !== null);
		// an edge between two OTHER still-active memories (c and a fresh m) survives archiving a
		const mFresh = mk('c2-fresh');   // fresh active memory
		const e_cfresh = storeEdge({ from_id: c, to_id: mFresh, relation: 'sibling', source_session_id: SCOPE_BASE }); // neither = a
		updateMemoryStatus(a, 'invalid'); // re-flip a to invalid (already archived; harmless, exercises invalid path too)
		check('C2 edge between two OTHER memories SURVIVES a-invalidation', getEdge(e_cfresh).valid_until === null, `vu=${getEdge(e_cfresh).valid_until}`);

		console.log('\n── C3 cascade: reactivation does NOT re-open (un-close) a cascaded edge ──');
		// b currently superseded. e_ab/e_bc have valid_until set. Reactivate b to active → edges stay
		// closed (bi-temporal history is immutable; recreating the link needs a fresh edge, not a
		// status flip). This guards against a plausiblecascade-invalidation-on-active bug.
		updateMemoryStatus(b, 'active');
		check('C3 reactivating b does NOT un-invalidate e_ab', getEdge(e_ab).valid_until !== null);
		check('C3 b is active again', getMemory(b).status === 'active');

		cleanupMemories([a, b, c, mFresh]);
	}

	// ═══ Part 3 — backward-compat: no-asOf path unchanged + malformed-but-bound shape ═══
	{
		console.log('\n── B1 backward-compat: omitting asOf == prior behavior ──');
		const p = mk('b1-p'), q = mk('b1-q');
		const e_pq = storeEdge({ from_id: p, to_id: q, relation: 'parent', source_session_id: SCOPE_BASE });
		const reachNoAsOf = traverseMemoryGraph(p, 3, 20, 'outgoing', '').map(s => s.to_id);
		check('B1 no-asOf traverse reaches q (live edge)', reachNoAsOf.includes(q));
		// passing asOf=null explicitly == omitting (now-path, equal semantics)
		const reachNull = traverseMemoryGraph(p, 3, 20, 'outgoing', '', null).map(s => s.to_id);
		check('B1 asOf=null == no-asOf (same result set)', JSON.stringify(reachNull) === JSON.stringify(reachNoAsOf));
		// getEdgesByRel without asOf returns the same set as with a far-future asOf for LIVE edges
		const liveNow = getEdgesByRel('parent', 50).map(e => e.id);
		const liveFuture = getEdgesByRel('parent', 50, iso(new Date(Date.parse('2099-12-31T00:00:00Z')))).map(e => e.id);
		check('B1 far-future asOf matches now for a still-live edge', JSON.stringify(liveNow.sort((a,b)=>a-b)) === JSON.stringify(liveFuture.sort((a,b)=>a-b)), `now=${liveNow} fut=${liveFuture}`);
		// edge between p,q: clean up
		cleanupMemories([p, q]);
	}
}

console.log(`\n═══ E9: ${PASS} pass, ${FAIL} fail ═══`);
if (FAIL > 0) process.exit(1);
