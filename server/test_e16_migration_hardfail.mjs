// E16 migration stop-on-first-error — PERMANENT regression test.
//
// Master report §6 backlog E16. The migration runner used to catch a failing migration, log, and
// `break` out of the loop — leaving the server running on a PARTIAL schema (some migrations
// applied, the failing one + everything after it skipped). A partial-schema DB silently serving
// reads is a corruption risk. E16 makes the runner HARD-STOP: any migration failure re-throws so
// the module top-level rejects (ESM import → top-level throw → Node process exit non-zero) BEFORE
// the HTTP server boots. "Silent schema drift" is the cardinal failure mode this closes.
//
// Drives the REAL makeMigrationRunner factory against a throwaway :memory: SQLite DB + a poisoned
// migration map, so production schema is never mutated. Also asserts the production top-level call
// completed by importing the REAL store module (whose import side-effect runs runPendingMigrations
// on the real db) — if a real migration had thrown, this file would never execute. The separate
// process-level exit-code guarantee is covered by test_e16_poison_child.mjs.
//
// Run (WSL Ubuntu-24.04, fresh db): bash run-test-e16.sh
// Standalone: ENABLE_EMBEDDING=false EMBEDDING_DIM=256 node test_e16_migration_hardfail.mjs
import Database from 'better-sqlite3';
import { db, makeMigrationRunner } from './memory-store.mjs';

let PASS = 0, FAIL = 0;
function check(name, cond, detail = '') {
	if (cond) { PASS++; console.log(`  PASS: ${name}`); }
	else { FAIL++; console.log(`  FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── S0: production top-level migration completed on import ──────────────────────────
// Importing this module (above) ran runPendingMigrations() at top level on the real db. If ANY real
// migration had thrown, the ESM import would have rejected and this test file would not be running.
// Assert the real db reached DB_VERSION to prove the happy path runs to completion (not a partial).
console.log('\n── S0 production top-level migration ran clean ──');
check('real db reached DB_VERSION(8) after import', db.pragma('user_version', { simple: true }) === 8,
	`got ${db.pragma('user_version', { simple: true })}`);

// ── S1: happy path — clean migrations advance user_version, no throw ────────────────
console.log('\n── S1 happy path advances user_version ──');
const s1 = new Database(':memory:');
s1.exec('CREATE TABLE mem (id INTEGER PRIMARY KEY)');
const s1Run = makeMigrationRunner(s1, {
	1: () => s1.exec('ALTER TABLE mem ADD COLUMN col_a TEXT'),
	2: () => s1.exec('ALTER TABLE mem ADD COLUMN col_b INTEGER'),
}, 2, { silent: true });
let s1Threw = false;
try { s1Run(); } catch { s1Threw = true; }
check('S1 clean run did not throw', s1Threw === false);
check('S1 user_version advanced to 2', s1.pragma('user_version', { simple: true }) === 2);

// ── S2: HARD-STOP on first failure — re-throws, user_version NOT advanced past failure ──
console.log('\n── S2 hard-stop on first failing migration ──');
const s2 = new Database(':memory:');
s2.exec('CREATE TABLE mem (id INTEGER PRIMARY KEY)');
const s2Run = makeMigrationRunner(s2, {
	1: () => { throw new Error('POISON_v1_manual_boom'); },
}, 1, { silent: true });
let s2Threw = false, s2Msg = '';
try { s2Run(); } catch (e) { s2Threw = true; s2Msg = e.message; }
check('S2 poison migration threw (hard-stop)', s2Threw === true);
check('S2 re-threw ORIGINAL error verbatim', s2Msg === 'POISON_v1_manual_boom', `got "${s2Msg}"`);
check('S2 user_version NOT advanced (stays 0)', s2.pragma('user_version', { simple: true }) === 0,
	`got ${s2.pragma('user_version', { simple: true })}`);

// ── S3: partial boundary — v1 applies, v2 throws, v3 NEVER runs ─────────────────────
// Proves the failure is a HARD stop, not a soft skip: v1's user_version bump survives (it ran in its
// own committed transaction), v2's throw rolls back v2's bump, and v3 is never reached. DB ends at
// user_version=1 — honestly recording "v1 done, v2+ pending" — never a phantom v2 partial.
console.log('\n── S3 partial boundary (v1 ok, v2 poison, v3 untouched) ──');
const s3 = new Database(':memory:');
s3.exec('CREATE TABLE mem (id INTEGER PRIMARY KEY)');
const s3Run = makeMigrationRunner(s3, {
	1: () => s3.exec('ALTER TABLE mem ADD COLUMN col_a TEXT'),
	2: () => { throw new Error('POISON_v2_manual_boom'); },
	3: () => s3.exec('ALTER TABLE mem ADD COLUMN col_c TEXT'),
}, 3, { silent: true });
let s3Threw = false, s3Msg = '';
try { s3Run(); } catch (e) { s3Threw = true; s3Msg = e.message; }
check('S3 threw on v2 (hard-stop)', s3Threw === true);
check('S3 re-threw v2 error', s3Msg === 'POISON_v2_manual_boom', `got "${s3Msg}"`);
check('S3 user_version stopped at 1 (v1 applied, v2 NOT bumped)', s3.pragma('user_version', { simple: true }) === 1,
	`got ${s3.pragma('user_version', { simple: true })}`);
check('S3 v3 column absent (v3 never ran)',
	!s3.prepare('PRAGMA table_info(mem)').all().some(c => c.name === 'col_c'));

// ── S4: currentVersion already at dbVersion — no-op, no throw ───────────────────────
// A fully-migrated DB must not even attempt migrations (the loop bound is exclusive on the upper end).
console.log('\n── S4 fully-migrated db is a no-op ──');
const s4 = new Database(':memory:');
s4.exec('CREATE TABLE mem (id INTEGER PRIMARY KEY)');
s4.pragma('user_version = 2');
const s4Run = makeMigrationRunner(s4, {
	1: () => { throw new Error('should_not_run'); },
	2: () => { throw new Error('should_not_run'); },
}, 2, { silent: true });
let s4Threw = false;
try { s4Run(); } catch { s4Threw = true; }
check('S4 fully-migrated skipped all migrations (no throw)', s4Threw === false);
check('S4 user_version unchanged', s4.pragma('user_version', { simple: true }) === 2);

// ── S5: transaction rollback — failing migration leaves NO partial side effects ──────
// v1 applies cleanly, then v2 creates a table (side effect) THEN throws. Because the migration body
// + the user_version pragma are wrapped in ONE better-sqlite3 transaction, the CREATE TABLE rolls
// back too — the DB must not show v2's leaked table. Proves no half-applied migration residue.
console.log('\n── S5 failing migration rolls back its own side effects ──');
const s5 = new Database(':memory:');
s5.exec('CREATE TABLE base (id INTEGER PRIMARY KEY)');
const s5Run = makeMigrationRunner(s5, {
	1: () => s5.exec('ALTER TABLE base ADD COLUMN a TEXT'),
	2: () => {
		s5.exec('CREATE TABLE leaked_tbl (x INTEGER)'); // side effect before throwing
		throw new Error('POISON_v2_after_write');
	},
}, 2, { silent: true });
let s5Threw = false;
try { s5Run(); } catch { s5Threw = true; }
check('S5 threw on v2', s5Threw === true);
check('S5 user_version stopped at 1 (v1 applied)', s5.pragma('user_version', { simple: true }) === 1,
	`got ${s5.pragma('user_version', { simple: true })}`);
check('S5 v2 leaked table rolled back (absent)',
	!s5.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leaked_tbl'").get());

console.log(`\n═══ E16 migration hard-fail: ${PASS} pass, ${FAIL} fail ═══`);
if (FAIL > 0) process.exit(1);
