// test_l2_supersede_regression.mjs — regression for the FK-supersede crash on the REAL pipeline.
//
// Claude's audit claimed extractL2Scenes' BUG-17 "re-extract stale scene (>7 days)" branch crashes
// before the LLM call: `updateMemoryStatus(sc.id, 'superseded', -1)` (memory-pipeline.mjs ln183)
// violated the `memories.superseded_by REFERENCES memories(id)` FK under PRAGMA foreign_keys=ON
// — id is AUTOINCREMENT so -1 never matches → UPDATE rejected → the whole re-extract branch aborts
// and stale scenes never refresh. test_fk_supersede_claim.mjs proved the PRIMITIVE throws;
// THIS test proves the PIPELINE no longer throws after the -1→null fix and that re-extract proceeds:
// stale scene flips to status=superseded (superseded_by null, NOT -1) and a fresh scene is stored.
//
// Ownership rule: every fix ships a permanent regression test. Guards both directions —
// reverting -1 makes extractL2Scenes throw FK → `!threw` fails; a null successor is asserted.
//
// Run (WSL Ubuntu-24.04, better-sqlite3+sqlite-vec native required):
//   EMBEDDING_DIM=256 ENABLE_EMBEDDING=false node test_l2_supersede_regression.mjs
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

// Isolate to a temp db so nothing real is touched. Set BEFORE importing memory-store.
if (!process.env.MEMORY_DB_DIR) {
  process.env.MEMORY_DB_DIR = path.join(os.tmpdir(), `l2reg-${Math.floor(Math.random() * 1e9)}`);
}
process.env.EMBEDDING_DIM ||= '256';
process.env.ENABLE_EMBEDDING = 'false'; // skip transformers model load; storeMemory tolerates null embedding
process.env.LOG_LEVEL = 'error';         // quiet the pipeline debug logs

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  PASS: ${name}`); }
  else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── Mock LLM (OpenAI-compatible) — returns one scene summary so extractL2Scenes stores a fresh scene.
const MOCK_SUMMARY = 'Fresh regl2 scene: user wired the re-extract branch end to end.';
const mockServer = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: MOCK_SUMMARY } }] }));
});
await new Promise((resolve, reject) => {
  mockServer.on('error', reject);
  mockServer.listen(0, '127.0.0.1', resolve);
}).catch(e => { console.error('mock LLM failed:', e.message); process.exit(2); });
const mockPort = mockServer.address().port;
process.env.LLM_URL = `http://127.0.0.1:${mockPort}/v1/chat/completions`;
process.env.LLM_MODEL ||= 'test';

// Import AFTER env: llm-config reads LLM_URL at module load; memory-store opens the temp db.
const { storeMemory, db, getAllActiveMemoriesNoEmbed } = await import('./memory-store.mjs');
const { isVecReady } = await import('./vector-index.mjs');
const { extractL2Scenes } = await import('./memory-pipeline.mjs');

// Wait for the vec table migration (storeMemory prune path needs it).
let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('vec table ready (migration ran)', vecReady);

// Runtime probe: FK must be armed or the fix isn't even testable.
const fk = db.pragma('foreign_keys', { simple: true });
check('runtime PRAGMA foreign_keys === 1', fk === 1, `got ${fk}`);

const emb = () => { const v = new Float32Array(parseInt(process.env.EMBEDDING_DIM)); v[0] = 1.0; return v; };

// ── Seed 5 L1 facet memories, all entity 'regl2'. extractL2Scenes gates: l1Mems.length >= 5
//    (global) AND per-entity mems.length >= 3. 5 of one entity satisfies both.
for (let i = 0; i < 5; i++) {
  storeMemory({
    type: 'fact', text: `regl2 fact ${i}: detail about re-extract path`, session_id: 'l2reg',
    metadata: {}, embedding: emb(), importance: 0.5, entity: 'regl2', cone_layer: 1, intent_type: 'fact',
  });
}
const l1Count = getAllActiveMemoriesNoEmbed().filter(m => m.cone_layer === 1).length;
check('seeded 5 L1 facet memories (passes global >=5 gate)', l1Count === 5, `got ${l1Count}`);

// ── Seed one STALE L2 scene (8 days old, active) for entity 'regl2'. This is the row the BUG-17
//    branch must supersede. Backdate created_at so daysSinceExtract >= 7 opens the re-extract path.
const oldSceneId = storeMemory({
  type: 'project', text: 'stale regl2 scene from 8 days ago', session_id: 'pipeline',
  metadata: {}, embedding: emb(), importance: 0.8, entity: 'regl2', cone_layer: 2, intent_type: 'summary',
});
check('seeded a stale L2 scene row (id assigned)', typeof oldSceneId === 'number' && oldSceneId > 0, `id=${oldSceneId}`);
db.prepare("UPDATE memories SET created_at = datetime('now','-8 days') WHERE id = ?").run(oldSceneId);
const backdated = db.prepare('SELECT created_at FROM memories WHERE id = ?').get(oldSceneId);
check('stale scene created_at backdated 8 days', !!backdated && backdated.created_at, `dt=${backdated?.created_at}`);

// ── THE regression: extractL2Scenes must NOT throw and must drive the stale scene through supersede.
let threw = false, err = '';
try {
  await extractL2Scenes();
} catch (e) {
  threw = true;
  err = String(e.message);
}
check('extractL2Scenes does NOT throw (FK fix verified on pipeline)', !threw, `threw: ${err.slice(0, 120)}`);

const oldRow = db.prepare('SELECT status, superseded_by FROM memories WHERE id = ?').get(oldSceneId);
check('stale scene flipped to status=superseded', oldRow?.status === 'superseded', `status=${oldRow?.status}`);
check('stale scene superseded_by is null (sentinel, NOT -1 / orphan id)', oldRow?.superseded_by === null, `sb=${oldRow?.superseded_by}`);

const freshScenes = db.prepare(
  "SELECT id, text, status FROM memories WHERE cone_layer = 2 AND entity = 'regl2' AND status = 'active'"
).all();
check('a fresh L2 scene was stored (re-extract proceeded)', freshScenes.some(s => s.text === MOCK_SUMMARY),
  `fresh=${JSON.stringify(freshScenes.map(s => s.text))}`);

// Cleanup temp db files + shut the mock server down cleanly.
try { db.close(); } catch {}
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(path.join(process.env.MEMORY_DB_DIR, `hermes-memory.db${ext}`)); } catch {}
}
try { fs.rmdirSync(process.env.MEMORY_DB_DIR, { recursive: true }); } catch {}
if (typeof mockServer.closeAllConnections === 'function') mockServer.closeAllConnections();
mockServer.unref();
await new Promise(r => mockServer.close(r));

console.log(`\n═══ L2 supersede regression: ${PASS} pass, ${FAIL} fail ═══`);
process.exitCode = FAIL > 0 ? 1 : 0;
