#!/usr/bin/env node
/**
 * One-off: give migrated Fido (fido.torama.ng) expenses a proper workflow state.
 *
 * The ETL imported legacy expenses without a `wf_state`, so they defaulted to
 * DRAFT — but a draft can't be paid, and many already carry payments. This maps
 * each legacy ticket (ext_id set) from its payment position:
 *   fully paid  → PAID
 *   part paid   → APPROVED   (can still be paid down)
 *   unpaid      → REVIEWED
 * Idempotent: only touches rows still in DRAFT / NULL. Native Daybook tickets
 * (no ext_id) are left untouched.
 *
 * Run on the server:  node backfill_expense_wf.js
 * (initDb() also applies this automatically on the next deploy.)
 */
'use strict';

const { initDb, getDb } = require('./db');

(async () => {
  await initDb();                       // ensures pool + runs the same migration
  const pool = getDb();
  const r = await pool.query(`
    UPDATE expenses SET wf_state = CASE
        WHEN amount > 0 AND COALESCE(amount_paid,0) >= amount - 0.01 THEN 'PAID'
        WHEN COALESCE(amount_paid,0) > 0.01 THEN 'APPROVED'
        ELSE 'REVIEWED'
      END
     WHERE ext_id IS NOT NULL AND (wf_state IS NULL OR wf_state = 'DRAFT')`);
  console.log(`[backfill] moved ${r.rowCount} legacy expense(s) out of DRAFT.`);
  const summary = await pool.query(
    `SELECT wf_state, COUNT(*) n FROM expenses WHERE ext_id IS NOT NULL GROUP BY wf_state ORDER BY n DESC`);
  for (const row of summary.rows) console.log(`  ${row.wf_state || '(null)'}: ${row.n}`);
  process.exit(0);
})().catch((e) => { console.error('[backfill] failed:', e.message); process.exit(1); });
