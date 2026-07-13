#!/usr/bin/env node
/**
 * Daybook — migration smoke test.
 *
 * Runs initDb() against the database in DATABASE_URL, TWICE.
 *
 * Why this exists: on 2026-07-13 a partial index (`... WHERE deleted_at IS NULL`)
 * was written ABOVE the `ALTER TABLE ... ADD COLUMN deleted_at` that creates the
 * column it filters on. Postgres executes the migration top to bottom, so it threw
 * `column "deleted_at" does not exist`, initDb() rejected, and the container
 * crash-looped on boot. Production went down. Neither `node --check` nor ESLint can
 * see a DDL ordering bug — only *executing* the migration can, and until now the
 * first thing that executed it was the live server.
 *
 * Run twice because migrations must be idempotent: every deploy re-runs the whole
 * of initDb() against a database that already has the schema. A statement that
 * succeeds on an empty DB but blows up on a populated one (a non-guarded CREATE, a
 * duplicate constraint) is just as fatal, and only the second pass catches it.
 *
 * Usage: DATABASE_URL=postgres://… node scripts/migrate-check.js [--label NAME]
 *        (DB_MODULE=/path/to/db.js to test a different checkout's migration —
 *         that's how CI replays the previous release's schema, then upgrades it.)
 */
'use strict';

const path = require('path');

const label = (() => {
  const i = process.argv.indexOf('--label');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : 'migration';
})();

const modulePath = process.env.DB_MODULE
  ? path.resolve(process.env.DB_MODULE)
  : path.join(__dirname, '..', 'backend', 'db.js');

if (!process.env.DATABASE_URL) {
  console.error('[migrate-check] DATABASE_URL is required');
  process.exit(1);
}

(async () => {
  const { initDb, getDb } = require(modulePath);
  const t0 = Date.now();

  try {
    await initDb();
    console.log(`[migrate-check] ${label}: pass 1 (apply) OK`);
  } catch (e) {
    console.error(`[migrate-check] ${label}: pass 1 (apply) FAILED — ${e.message}`);
    console.error('  A statement in initDb() cannot run against this database. Most often:');
    console.error('  an index or constraint referencing a column that is added further down the file.');
    process.exit(1);
  }

  // Second pass = what every real deploy does to an existing database.
  try {
    await initDb();
    console.log(`[migrate-check] ${label}: pass 2 (re-apply / idempotent) OK`);
  } catch (e) {
    console.error(`[migrate-check] ${label}: pass 2 (re-apply) FAILED — ${e.message}`);
    console.error('  The migration is NOT idempotent. Every deploy re-runs it against a live');
    console.error('  database, so this would break production even though a fresh DB works.');
    process.exit(1);
  }

  console.log(`[migrate-check] ${label}: OK in ${Date.now() - t0}ms`);
  try { const db = getDb && getDb(); if (db && db.end) await db.end(); } catch { /* pool already closed */ }
  process.exit(0);
})();
