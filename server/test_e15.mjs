// E15 — MMR diversity consistency (both KNN backends) + diversity-gain measurement.
// PERMANENT regression test.
//
// Ledger E15 symptom: MMR (lambda=0.7) rerank was applied ONLY on the JS-cosine fallback, never on
// the native KNN path → the same query got different diversity depending on which backend answered.
// Deeper discovery while fixing: NEITHER path actually diversified, because candidates carried no
// `.embedding`, so mmrRerank's maxSim penalty was always 0 and MMR silently collapsed to plain
// score-order. The fix:
//   * mmrRerank takes an optional `embeddingsById` side-band Map so it computes REAL candidate
//     cosine WITHOUT attaching `.embedding` to result objects (which would leak into /memory/search
//     JSON). A candidate's own `.embedding` wins; missing → map; both missing → score-only (safe
//     pre-E15 behavior, no throw).
//   * the native KNN path now applies MMR too (consistency); getEmbeddingsById is a ~topK lookup so
//     the native path gets real vectors WITHOUT a full active-set load.
//   * diversifyAndMeasure returns { results, stats: diversityGain } quantifying how much MMR
//     reduced intra-list redundancy — exposed via /memory/search?stats=true (gated, backward-compat).
//
// Halves: (1) pure-function MMR + measurement on synthetic basis/2-sparse embeddings; (2) the
// getEmbeddingsById store helper against the real sqlite store with basis-vector embeddings.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e15.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e15.mjs
import { mmrRerank, diversifyAndMeasure, cosineSimilarity } from './embedding-engine.mjs';
import { storeMemory, deleteMemory, db, getEmbeddingsById } from './memory-store.mjs';
import { isVecReady } from './vector-index.mjs';

const EMBED_DIM = parseInt(process.env.EMBEDDING_DIM || '256');
let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
	if (cond) { PASS++; console.log(`  PASS: ${name}`); }
	else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}
const basis = (d) => { const v = new Float32Array(EMBED_DIM); v[d % EMBED_DIM] = 1.0; return v; };

// ═══ Part 1 — MMR + measurement, pure functions (synthetic embeddings) ═══
{
	console.log('\n── M1 MMR diversity with real embeddingsById (fixes the silent no-op) ──');
	// 5 candidates scored by query-relevance, with embedding redundancy: c0/c1/c3 share axis 0
	// (near-duplicates), c2=axis 1, c4=axis 2. Score-order top-3 = {c0,c1,c2} is high-redundancy
	// (mean intra-sim .333 from one 1.0 pair). MMR must swap the redundant c1 for the diverse c4,
	// yielding orthogonal {c0,c2,c4} (mean intra-sim 0) → diversityGain .333 > 0.
	const cand = [
		{ id: 'c0', score: 1.00, embedding: basis(0) },
		{ id: 'c1', score: 0.98, embedding: basis(0) }, // redundant w/ c0
		{ id: 'c2', score: 0.96, embedding: basis(1) },
		{ id: 'c3', score: 0.94, embedding: basis(0) }, // redundant w/ c0
		{ id: 'c4', score: 0.92, embedding: basis(2) },
	];
	// Side-band map keyed by String(id) — THIS is how the native KNN path supplies vectors now.
	const embMap = new Map(cand.map(c => [String(c.id), c.embedding]));
	// Strip `.embedding` from the candidate objects we hand mmrRerank, to model the real search path
	// (cands from searchByEmbedding / knnHits carry NO .embedding — exactly the no-leak invariant).
	const candsNoEmb = cand.map(({ embedding, ...rest }) => rest);

	const dm = diversifyAndMeasure(basis(0), candsNoEmb, 3, 0.7, embMap);
	check('M1 returned top-3 ids diversified to {c0,c2,c4}', dm.results.map(r => r.id).join(',') === 'c0,c2,c4', `got [${dm.results.map(r => r.id)}]`);
	check('M1 redundant c1 NOT in MMR result (swapped for diverse c4)', !dm.results.some(r => r.id === 'c1'));
	check('M1 redundant c3 NOT in MMR result', !dm.results.some(r => r.id === 'c3'));
	check('M1 stats.diversityGain > 0 (MMR reduced intra-list redundancy)', dm.stats.diversityGain > 0, `gain=${dm.stats.diversityGain}`);
	check('M1 raw mean intra-sim (.333) > mmr mean intra-sim (0)', dm.stats.rawMeanIntraSim > dm.stats.mmrMeanIntraSim, `raw=${dm.stats.rawMeanIntraSim} mmr=${dm.stats.mmrMeanIntraSim}`);
	check('M1 NO `.embedding` field leaked onto result objects', dm.results.every(r => !('embedding' in r) && r.embedding === undefined), `leaked=${JSON.stringify(dm.results.map(r => 'embedding' in r))}`);
	check('M1 stats shape complete', ['candidateCount', 'returnedCount', 'topK', 'lambda', 'rawMeanIntraSim', 'mmrMeanIntraSim', 'diversityGain'].every(k => k in dm.stats), `keys=${Object.keys(dm.stats)}`);
	check('M1 candidateCount=5, returnedCount=3, topK=3, lambda=0.7', dm.stats.candidateCount === 5 && dm.stats.returnedCount === 3 && dm.stats.topK === 3 && dm.stats.lambda === 0.7);

	// M2 — pre-E15 behavior preserved: no embeddings anywhere → safe score-only order, no throw.
	console.log('\n── M2 graceful degradation when embeddings are unavailable ──');
	const plain = [{ id: 'p0', score: 0.9 }, { id: 'p1', score: 0.7 }, { id: 'p2', score: 0.5 }];
	let dmNoEmbThrew = false, dmNoEmb;
	try { dmNoEmb = diversifyAndMeasure(basis(5), plain, 2, 0.7, null); } catch { dmNoEmbThrew = true; }
	check('M2 no embeddings → no throw', dmNoEmbThrew === false);
	check('M2 returns score-ordered top-K (degrades to score-only)', dmNoEmb.results.map(r => r.id).join(',') === 'p0,p1', `got [${dmNoEmb.results.map(r => r.id)}]`);
	check('M2 diversityGain = 0 (no vectors to measure overlap)', dmNoEmb.stats.diversityGain === 0);
	check('M2 no leak (plain cands had no embedding field)', dmNoEmb.results.every(r => !('embedding' in r)));

	// M3 — topK >= candidates → guard returns candidates unchanged; stats still computed on full set.
	console.log('\n── M3 topK >= candidates (guard path) ──');
	const small = [{ id: 's0', score: 0.9, embedding: basis(3) }, { id: 's1', score: 0.7, embedding: basis(3) }];
	const dmSmall = diversifyAndMeasure(basis(3), small, 5, 0.7, null);
	check('M3 returnedCount === full candidate set (2)', dmSmall.results.length === 2 && dmSmall.stats.returnedCount === 2);
	check('M3 identical embeddings → high intra-sim (1.0) on both orders', dmSmall.stats.rawMeanIntraSim === 1 && dmSmall.stats.mmrMeanIntraSim === 1, `raw=${dmSmall.stats.rawMeanIntraSim} mmr=${dmSmall.stats.mmrMeanIntraSim}`);
	check('M3 diversityGain 0 (nothing to diversify — guard returned as-is)', dmSmall.stats.diversityGain === 0);

	// M4 — single candidate → 0 pairs (meanIntraSim 0), no NaN.
	const one = diversifyAndMeasure(basis(0), [{ id: 'x', score: 1 }], 5, 0.7, null);
	check('M4 single candidate → results length 1', one.results.length === 1 && one.stats.returnedCount === 1);
	check('M4 single candidate → meanIntraSim 0 (no pairs), no NaN', one.stats.rawMeanIntraSim === 0 && one.stats.mmrMeanIntraSim === 0 && !Number.isNaN(one.stats.diversityGain));

	// M5 — PARITY: the native-KNN and JS-cosine paths BOTH route through diversifyAndMeasure with the
	// SAME (candidates, embeddingsById), so identical inputs → identical outputs → backend choice is
	// now invisible to diversity. (The ledger's core ask.)
	const a = diversifyAndMeasure(basis(0), candsNoEmb.slice(), 3, 0.7, embMap);
	const b = diversifyAndMeasure(basis(0), candsNoEmb.slice(), 3, 0.7, embMap);
	check('M5 same inputs → identical result ids (parity)', a.results.map(r => r.id).join(',') === b.results.map(r => r.id).join(','));
	check('M5 same inputs → identical diversityGain (parity)', a.stats.diversityGain === b.stats.diversityGain);

	// M6 — mmrRerank kept backward-compat 4-arg signature (no embeddingsById).
	const bc = mmrRerank(basis(0), [{ id: 'z', score: 0.9 }, { id: 'y', score: 0.8 }], 1, 0.7);
	check('M6 4-arg backward-compat → 1 result', Array.isArray(bc) && bc.length === 1 && bc[0].id === 'z');
}

// ═══ Part 2 — getEmbeddingsById against the real store (basis-vector embeddings) ═══
{
	console.log('\n── REAL-DB getEmbeddingsById (native-path MMR vector supply) ──');
	let vecReady = false;
	for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
	check('S0 vec table ready', vecReady);

	if (vecReady) {
		const SCOPE = 'e15-' + Math.floor(Math.random() * 1e9);
		const staged = [];
		for (let i = 0; i < 3; i++) {
			const id = storeMemory({ session_id: SCOPE, type: 'preference', text: `emb${i}`, metadata: {}, embedding: basis(20 + i), importance: 0.5, entity: SCOPE, cone_layer: 1, intent_type: 'preference' });
			staged.push(Number(id));
		}
		staged.sort((a, b) => a - b);
		check('G1 staged 3 active memories', db.prepare("SELECT COUNT(*) AS n FROM memories WHERE session_id=? AND status='active'").get(SCOPE).n === 3, `count for ${SCOPE}`);

		// G2 — getEmbeddingsById returns a Map keyed by String(id) with a decoded float array.
		const m = getEmbeddingsById(staged);
		check('G2 returns a Map', m instanceof Map);
		check('G2 contains all 3 staged ids', staged.every(id => m.has(String(id))));
		check('G2 values are arrays of length EMBED_DIM', [...m.values()].every(v => Array.isArray(v) && v.length === EMBED_DIM), `lens=${[...m.values()].map(v => v.length)}`);

		// G3 — the decoded embedding IS the staged basis vector (the EMBED_DIM axis lights up).
		const v0 = m.get(String(staged[0]));
		check('G3 decoded embedding dim 20 set to ~1.0 (first staged basis(20))', Math.abs(v0[20] - 1.0) < 1e-5, `v0[20]=${v0[20]}`);
		check('G3 all other dims ~0 in decoded vector', v0.filter((x, idx) => idx !== 20 && Math.abs(x) > 1e-6).length === 0);

		// G4 — round-trip: decoding matches what cosineSimilarity would need; pairwise = 0 (orthogonal basis).
		const cos01 = cosineSimilarity(m.get(String(staged[0])), m.get(String(staged[1])));
		check('G4 decoded orthogonal basis → cosine 0 across staged rows', Math.abs(cos01) < 1e-6, `cos01=${cos01}`);

		// G5 — edge cases: empty input → empty Map; unknown id → not in map (no throw).
		check('G5 empty ids → empty Map', getEmbeddingsById([]).size === 0);
		const withUnk = getEmbeddingsById([staged[0], 999999999]);
		check('G5 unknown id tolerated (only known ids in map)', withUnk.has(String(staged[0])) && !withUnk.has('999999999') && withUnk.size === 1);

		// G6 — feeds the MMR path: building embeddingsById from real knn-hit-style ids works.
		const dmReal = diversifyAndMeasure(basis(20), staged.map((id, i) => ({ id, score: 0.95 - i * 0.05 })), 2, 0.7, getEmbeddingsById(staged));
		check('G6 native-path-style call returns 2 diversified results', dmReal.results.length === 2);
		check('G6 no leak on DB-fed results', dmReal.results.every(r => !('embedding' in r)));
		check('G6 orthogonal staged → diversityGain 0 (already diverse, nothing to gain)', dmReal.stats.diversityGain === 0, `gain=${dmReal.stats.diversityGain}`);

		// cleanup
		for (const id of staged) try { deleteMemory(id); } catch {}
	}
}

console.log(`\n═══ E15: ${PASS} pass, ${FAIL} fail ═══`);
if (FAIL > 0) process.exit(1);
