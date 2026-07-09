// E10 keyset (seek) pagination — drop COUNT(*) — PERMANENT regression test.
//
// Master report §6 item: the /memory/session/:id + /memory/type/:id list endpoints paid a COUNT(*)
// over status='active' on EVERY page request (S-#54) AND fetched limit+offset rows just to .slice()
// the first `offset` away — offset paging. E10 replaces that with keyset (seek) pagination:
//   * ORDER BY (created_at DESC, id DESC) — the composite (created_at, id) tiebreak means rows
//     sharing a created_at timestamp are NEVER skipped across pages.
//   * cursor = base64url('created_at|id') of the last row; passed back as the `cursor` query param.
//   * fetch limit+1 → `hasMore` flag; `nextCursor` set only when more exist.
//   * `total` is intentionally NULL — the COUNT(*) is gone (the perf regression target).
//
// Ground truth for expected slices is read straight from the DB with the SAME ORDER BY the keyset
// uses, so the assertions hold whether or not the staged rows share a created_at second — a page is
// a contiguous slice of that order by construction. With 25 sub-second inserts they will typically
// all share one created_at, deliberately exercising the id-DESC tiebreak path.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e10.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e10.mjs
import { storeMemory, deleteMemory, db, DB_VERSION, getSessionMemoriesPage, getMemoriesByTypePage } from './memory-store.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
	if (cond) { PASS++; console.log(`  PASS: ${name}`); }
	else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}
const basis = (d) => { const v = new Float32Array(EMBED_DIM); v[(d % EMBED_DIM)] = 1.0; return v; };

let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('S0 vec table ready', vecReady);

if (vecReady) {
	const SESSION = `e10_sess_${Math.floor(Math.random() * 1e9)}`;
	const TYPE = `e10_type_${Math.floor(Math.random() * 1e9)}`;
	const purgeScope = () => {
		const ids = db.prepare("SELECT id FROM memories WHERE session_id IN (?,?) OR type IN (?,?)").all(SESSION, SESSION, TYPE, TYPE).map(r => r.id);
		for (const id of ids) try { deleteMemory(id); } catch {}
	};
	purgeScope(); // clean slate for this session/type scope (session_id filter isolates from any seed rows)

	// S1 — the migration framework reached DB_VERSION (v9 indexes applied). E16 guarantees the hard-stop
	// rollback would have aborted startup if v9 had failed; reaching DB_VERSION confirms a clean schema.
	const uv = db.pragma('user_version', { simple: true });
	check('S1 DB user_version reached DB_VERSION (9)', uv === DB_VERSION, `got ${uv} want ${DB_VERSION}`);

	// S2 — the E10 keyset covering indexes exist on the real schema (migration v9).
	const idxs = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'").all().map(r => r.name);
	check('S2 idx_memories_session_active_time exists', idxs.includes('idx_memories_session_active_time'), `idxs=${idxs.join(', ')}`);
	check('S2 idx_memories_type_active_time exists', idxs.includes('idx_memories_type_active_time'));

	// Stage 25 active memories in one session+type (sub-second → same created_at → tiebreak path,
	// although ground-truth ordering makes the test correct regardless).
	const ids = [];
	for (let i = 0; i < 25; i++) {
		const id = storeMemory({ session_id: SESSION, type: TYPE, text: `row${i}`, metadata: {}, embedding: basis(10 + i), importance: 0.5, entity: 'e10', cone_layer: 1, intent_type: 'preference' });
		ids.push(Number(id));
	}
	ids.sort((a, b) => a - b);
	// Ground truth = the EXACT ORDER BY the keyset impl uses. Every page must be a contiguous slice.
	const truthOrder = db.prepare("SELECT id FROM memories WHERE session_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC").all(SESSION).map(r => Number(r.id));
	check('K0 ground truth has all 25 staged ids', truthOrder.length === 25 && truthOrder.length === new Set(truthOrder).size, `len=${truthOrder.length}`);

	// K1 — first page (no cursor): up to `limit` rows, ordered, hasMore + nextCursor set, total NULL.
	const p1 = getSessionMemoriesPage(SESSION, { limit: '10' });
	check('K1 page1 results.length === 10', p1.results.length === 10, `got ${p1.results.length}`);
	check('K1 page1 ordered (created_at DESC, id DESC) = ground truth slice', p1.results.map(r => Number(r.id)).join(',') === truthOrder.slice(0, 10).join(','), `got [${p1.results.map(r => r.id)}] want [${truthOrder.slice(0, 10)}]`);
	check('K1 hasMore true', p1.hasMore === true, `hasMore=${p1.hasMore}`);
	check('K1 nextCursor set (opaque string)', typeof p1.nextCursor === 'string' && p1.nextCursor.length > 0);
	check('K1 total === null (COUNT(*) dropped)', p1.total === null, `total=${JSON.stringify(p1.total)}`);
	check('K1 response shape present (results/hasMore/nextCursor/total)', Array.isArray(p1.results) && 'hasMore' in p1 && 'nextCursor' in p1 && 'total' in p1);

	// K2 — page 2 via cursor: continues with NO overlap from page 1.
	const p2 = getSessionMemoriesPage(SESSION, { cursor: p1.nextCursor, limit: '10' });
	check('K2 page2 results.length === 10', p2.results.length === 10, `got ${p2.results.length}`);
	check('K2 page2 = ground truth slice [10:20]', p2.results.map(r => Number(r.id)).join(',') === truthOrder.slice(10, 20).join(','), `got [${p2.results.map(r => r.id)}] want [${truthOrder.slice(10, 20)}]`);
	check('K2 no id overlap with page 1', !p2.results.some(r => p1.results.some(r2 => Number(r2.id) === Number(r.id))));
	check('K2 hasMore true', p2.hasMore === true);
	check('K2 nextCursor set', typeof p2.nextCursor === 'string' && p2.nextCursor.length > 0);

	// K3 — final page: remainder 5, hasMore FALSE, nextCursor null (end of result set).
	const p3 = getSessionMemoriesPage(SESSION, { cursor: p2.nextCursor, limit: '10' });
	check('K3 page3 results.length === 5 (remainder)', p3.results.length === 5, `got ${p3.results.length}`);
	check('K3 page3 = ground truth slice [20:25]', p3.results.map(r => Number(r.id)).join(',') === truthOrder.slice(20, 25).join(','), `got [${p3.results.map(r => r.id)}] want [${truthOrder.slice(20, 25)}]`);
	check('K3 hasMore false', p3.hasMore === false, `hasMore=${p3.hasMore}`);
	check('K3 nextCursor null', p3.nextCursor === null, `nextCursor=${p3.nextCursor}`);

	// K4 — full coverage: union of the three pages == all 25 ids with NO gap and NO duplicate.
	const allPaged = [...p1.results, ...p2.results, ...p3.results].map(r => Number(r.id)).sort((a, b) => a - b);
	const missing = ids.filter(id => !allPaged.includes(id));
	const unionCount = new Set(allPaged).size;
	check('K4 union covers all 25 staged ids (no gap)', missing.length === 0, `missing=${missing.join(',')}`);
	check('K4 no duplicate rows across pages', unionCount === allPaged.length, `unique=${unionCount} totalRows=${allPaged.length}`);
	check('K4 union size exactly 25', unionCount === 25, `union=${unionCount}`);

	// K5 — /memory/type/:id endpoint mirrors the session path (same staged rows, type filter).
	const t1 = getMemoriesByTypePage(TYPE, { limit: '10' });
	check('K5 type page1 results.length === 10', t1.results.length === 10, `got ${t1.results.length}`);
	check('K5 type page1 = ground truth slice [0:10] (same data)', t1.results.map(r => Number(r.id)).join(',') === truthOrder.slice(0, 10).join(','), `got [${t1.results.map(r => r.id)}]`);
	check('K5 type hasMore true', t1.hasMore === true);
	check('K5 type total === null', t1.total === null);
	const t2 = getMemoriesByTypePage(TYPE, { cursor: t1.nextCursor, limit: '10' });
	const t3 = getMemoriesByTypePage(TYPE, { cursor: t2.nextCursor, limit: '10' });
	const tAll = [...t1.results, ...t2.results, ...t3.results].map(r => Number(r.id)).sort((a, b) => a - b);
	check('K5 type full coverage (25, no gap/dup)', tAll.length === 25 && new Set(tAll).size === 25 && ids.every(id => tAll.includes(id)), `len=${tAll.length} unique=${new Set(tAll).size}`);

	// K6 — limit sanitization: bad/missing limit → default; counts only what exists.
	const kBad = getSessionMemoriesPage(SESSION, { limit: 'not-a-number' });
	check('K6 bad limit → default returns all 25 (≤ cap 500), hasMore false', kBad.results.length === 25 && kBad.hasMore === false && kBad.nextCursor === null, `len=${kBad.results.length} hasMore=${kBad.hasNextCursor}`);
	const kNone = getSessionMemoriesPage(SESSION, {});
	check('K6 no limit → default returns all 25, hasMore false', kNone.results.length === 25 && kNone.hasMore === false, `len=${kNone.results.length}`);
	const kCap = getSessionMemoriesPage(SESSION, { limit: '10000' });
	check('K6 limit 10000 capped to 500 max (only 25 exist)', kCap.results.length === 25 && kCap.hasMore === false, `len=${kCap.results.length}`);

	// K7 — invalid cursor decodes to null → treated as first page (graceful, never throws).
	const kBadCur = getSessionMemoriesPage(SESSION, { cursor: '!!!not-base64url!!!', limit: '10' });
	check('K7 invalid cursor → first page (decode fallback)', kBadCur.results.map(r => Number(r.id)).join(',') === truthOrder.slice(0, 10).join(','), `got [${kBadCur.results.map(r => r.id)}]`);
	const kEmptyCur = getSessionMemoriesPage(SESSION, { cursor: '', limit: '10' });
	check('K7 empty string cursor → first page', kEmptyCur.results.map(r => Number(r.id)).join(',') === truthOrder.slice(0, 10).join(','));

	// K8 — arrow-stable: re-seeking the SAME page3 cursor is idempotent (no stateful drift).
	const p3b = getSessionMemoriesPage(SESSION, { cursor: p2.nextCursor, limit: '10' });
	check('K8 same cursor → idempotent last page', p3b.results.map(r => Number(r.id)).join(',') === p3.results.map(r => Number(r.id)).join(',') && p3b.hasMore === false && p3b.nextCursor === null);

	// K9 — empty session → empty page (no throw, correct shape).
	const kEmpty = getSessionMemoriesPage('definitely-nonexistent-session-e10', { limit: '10' });
	check('K9 nonexistent session → 0 results, hasMore false, nextCursor null', kEmpty.results.length === 0 && kEmpty.hasMore === false && kEmpty.nextCursor === null && kEmpty.total === null, `results=${kEmpty.results.length}`);

	purgeScope();
}

console.log(`\n═══ E10: ${PASS} pass, ${FAIL} fail ═══`);
if (FAIL > 0) process.exit(1);
