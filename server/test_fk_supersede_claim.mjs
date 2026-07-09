// test_fk_supersede_claim.mjs — empirically verify the 3rd-party claim that
// `updateMemoryStatus(id, 'superseded', -1)` throws a SQLite FK constraint failure
// (memory-pipeline.mjs ln183 + ln247 pass `-1` as supersededBy when re-extracting a stale L2 scene
// / L3 persona older than 7 days; -1 is outside try/catch, before the llmFetch call).
//
// Structural case: memories.superseded_by REFERENCES memories(id) (memory-store.mjs ln53),
// db.pragma('foreign_keys = ON') (ln36), id is AUTOINCREMENT (ln47 → never -1). So -1 is a
// non-NULL orphan reference → FK should reject the UPDATE. Claude's audit said it reproduced this
// against a hand-built "schema y hệt". This test is STRONGER: it imports the REAL updateMemoryStatus
// + real storeMemory + runs the real auto-migration, against a temp db routed via MEMORY_DB_DIR so
// nothing real is touched. Decisive on the real code path.
//
// Negative control: updateMemoryStatus(id, 'superseded', null) must NOT throw (column is
// nullable → null is the correct "no specific successor" sentinel). Runtime pragma probe confirms
// foreign_keys is actually armed on the live connection.
//
// Run (WSL Ubuntu-24.04, better-sqlite3 native required): MEMORY_DB_DIR=/tmp/fktest_existing node test_fk_supersede_claim.mjs
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

if (!process.env.MEMORY_DB_DIR) {
  // Default to a temp dir under the OS tmp so a default run never clobbers the real data/ db.
  process.env.MEMORY_DB_DIR = path.join(os.tmpdir(), `fktest-${Math.floor(Math.random()*1e9)}`);
}
process.env.EMBEDDING_DIM ||= '256';

// Import AFTER env is set so memory-store opens the temp db.
const { storeMemory, updateMemoryStatus, db } = await import('./memory-store.mjs');
const { isVecReady } = await import('./vector-index.mjs');

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
  if (cond) { PASS++; console.log(`  PASS: ${name}`); }
  else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

// Wait for the vec table (storeMemory's pruneVectors path needs it).
let vecReady = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { vecReady = true; break; } await new Promise(r => setTimeout(r, 100)); }
check('vec table ready (migration ran)', vecReady);

// Runtime probe: is foreign_keys actually armed on the live connection the store uses?
const fkSetting = db.pragma('foreign_keys', { simple: true });
check('runtime PRAGMA foreign_keys === 1', fkSetting === 1, `got ${fkSetting}`);

// Seed one L2 scene so we have a real row id to supersede.
const emb = () => { const v = new Float32Array(parseInt(process.env.EMBEDDING_DIM)); v[0] = 1.0; return v; };
const sceneId = storeMemory({
  type: 'project', text: 'stale-scene-verify', session_id: 'fktest', metadata: {},
  embedding: emb(), importance: 0.8, entity: 'fktest', cone_layer: 2, intent_type: 'summary',
});
check('seeded an L2 scene row (id assigned)', typeof sceneId === 'number' && sceneId > 0, `id=${sceneId}`);

let threwFK = false, errmsg = '';
try {
  updateMemoryStatus(sceneId, 'superseded', -1);  // ← the exact pipeline call (ln183/247)
} catch (e) {
  threwFK = true;
  errmsg = String(e.message);
}
check('updateMemoryStatus(id,"superseded",-1) THROWS (Claude claim)', threwFK, `no throw`);
check('  error is FK constraint (not some other throw)', threwFK && /foreign key/i.test(errmsg), `err=${errmsg.slice(0,120)}`);

// Confirm the row is STILL active (UPDATE was rejected atomically → status unchanged).
const rowAfter = db.prepare('SELECT status, superseded_by FROM memories WHERE id = ?').get(sceneId);
check('row remains active (UPDATE rejected)', rowAfter && rowAfter.status === 'active', `status=${rowAfter?.status}`);
check('row superseded_by still null (UPDATE rejected)', rowAfter && rowAfter.superseded_by === null, `sb=${rowAfter?.superseded_by}`);

// Negative control: null is the correct "no successor" sentinel (column nullable) → must NOT throw.
let threwNull = false, nullErr = '';
try {
  updateMemoryStatus(sceneId, 'superseded', null);
} catch (e) {
  threwNull = true;
  nullErr = String(e.message);
}
check('negative control: null does NOT throw', !threwNull, `err=${nullErr}`);
const rowAfterNull = db.prepare('SELECT status, superseded_by FROM memories WHERE id = ?').get(sceneId);
check('null flip set status=superseded', rowAfterNull && rowAfterNull.status === 'superseded', `status=${rowAfterNull?.status}`);
check('null flip left superseded_by null', rowAfterNull && rowAfterNull.superseded_by === null, `sb=${rowAfterNull?.superseded_by}`);

// Cleanup: drop the temp db files so repeated runs don't accumulate.
try { db.close(); } catch {}
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(path.join(process.env.MEMORY_DB_DIR, `hermes-memory.db${ext}`)); } catch {}
}
try { fs.rmdirSync(process.env.MEMORY_DB_DIR, { recursive: true }); } catch {}

console.log(`\n═══ FK-supersede claim: ${PASS} pass, ${FAIL} fail ═══`);
process.exitCode = FAIL > 0 ? 1 : 0;
