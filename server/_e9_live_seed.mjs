// _e9_live_seed.mjs — seeds 2 memories + 1 parent edge directly via the store (bypassing the
// HTTP /memory/store handler's embedding-off "duplicate" short-circuit, which returns no id and
// skips persistence). Used by run-test-e9-live.sh so the E9 GRAPH HTTP endpoints (traverse/edges/
// supersede-cascade) can be exercised against real persisted rows WITHOUT the embedding model.
// Prints "M0 M1 EID" on stdout; not a permanent test (prefixed _) — runtime scaffolding only.
import { storeMemory, storeEdge, db, close } from './memory-store.mjs';
import { isVecReady } from './vector-index.mjs';

const D = parseInt(process.env.EMBEDDING_DIM || '256');
const basis = (d) => { const v = new Float32Array(D); v[d % D] = 1.0; return v; };
let ready = false;
for (let i = 0; i < 40; i++) { if (isVecReady()) { ready = true; break; } await new Promise(r => setTimeout(r, 100)); }
if (!ready) { console.error('seed: vec table not ready'); process.exit(2); }

const S = 'e9live';
const m0 = storeMemory({ session_id: S, type: 'preference', text: 'graph-m0', metadata: {}, embedding: basis(0), importance: 0.7, entity: S, cone_layer: 1, intent_type: 'preference' });
const m1 = storeMemory({ session_id: S, type: 'preference', text: 'graph-m1', metadata: {}, embedding: basis(1), importance: 0.7, entity: S, cone_layer: 1, intent_type: 'preference' });
const e = storeEdge({ from_id: m0, to_id: m1, relation: 'parent', strength: 1.0, source_session_id: S });
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
// Marker line: the migration runner (memory-store import) logs `[Schema] Migration …` to stdout and
// would otherwise corrupt the `read M0 M1 EID` in the runner. Prefix makes it grep-able.
process.stdout.write(`E9SEED:${m0}:${m1}:${e}\n`);
close();
process.exit(0);
