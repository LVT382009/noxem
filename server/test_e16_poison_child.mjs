// E16 process-level exit guard — companion to test_e16_migration_hardfail.mjs.
//
// The in-process test covers the runner CONTRACT (re-throws, user_version boundary, rollback). This
// thin child proves the REAL module's top-level hard-stop surfaces as a NON-ZERO PROCESS EXIT: the
// node process must die (server never boots) when a migration throws at module-import time.
//
// Mechanism: makeMigrationRunner runs a poisoned migration that throws synchronously at top level
// (nothing catches it here) → Node surfaces an unhandled error and exits non-zero. A sentinel line
// ("E16_POISON_CHILD_SURVIVED_FAILURE") is printed ONLY if the hard-stop FAILED — the harness
// (run-test-e16.sh) asserts that sentinel never appears AND the exit code is non-zero.
//
// NOT run standalone — driven by run-test-e16.sh which checks the exit code.
import Database from 'better-sqlite3';
import { makeMigrationRunner } from './memory-store.mjs';

const tdb = new Database(':memory:');
tdb.pragma('user_version = 0');
const poisoned = { 1: () => { throw new Error('POISON_child_import_time_v1'); } };
makeMigrationRunner(tdb, poisoned, 1, { silent: true })();
// Unreachable on a correct hard-stop. Sentinel for the harness to detect a broken guard.
console.log('E16_POISON_CHILD_SURVIVED_FAILURE');
