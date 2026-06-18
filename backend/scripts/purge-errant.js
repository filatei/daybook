/**
 * Purge errant orders — server maintenance script.
 *
 * Deletes orders that have NO timestamp or NO order id, and clears the
 * ephemeral sale.created events that were (historically) persisted and replayed
 * as phantom "live sales". Errant pos_sales rows are copied into etl_quarantine
 * first, so the deletion is auditable.
 *
 * Run on the server (inside the daybook container, or anywhere DATABASE_URL points
 * at the Daybook Postgres):
 *
 *   docker exec -it daybook node backend/scripts/purge-errant.js          # delete
 *   docker exec -it daybook node backend/scripts/purge-errant.js --dry    # preview only
 *
 * Idempotent: re-running is safe (nothing left to purge ⇒ zero rows).
 */
'use strict';
const { v4: uuid } = require('uuid');
const { initDb, qall, qrun, qone } = require('../db');

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
// A pos_sales row is errant if it has no order number or no timestamp.
const ERRANT = '(receipt_no IS NULL OR created_at IS NULL OR sale_date IS NULL)';

async function main() {
  await initDb();
  console.log(`\n[purge-errant] ${DRY ? 'DRY RUN — no deletes' : 'LIVE — deleting'}\n`);

  // 1) Errant pos_sales — preview, quarantine, then delete.
  const rows = await qall(
    `SELECT id, tenant_id, receipt_no, total, sale_date, created_at, ext_id, customer_name
       FROM pos_sales WHERE ${ERRANT}`);
  console.log(`pos_sales errant rows: ${rows.length}`);
  for (const r of rows.slice(0, 20)) {
    console.log(`  · ${r.receipt_no == null ? '(no order#)' : '#' + r.receipt_no} · ${r.customer_name || 'Walk-in'} · ₦${Number(r.total || 0).toLocaleString()} · ${r.sale_date || 'no date'}`);
  }
  if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);

  if (!DRY && rows.length) {
    for (const r of rows) {
      const reason = (r.receipt_no == null) ? 'PURGED_NO_ORDER_ID' : 'PURGED_NO_TIMESTAMP';
      await qrun(
        `INSERT INTO etl_quarantine (id,tenant_id,source,ext_id,reason,site,amount,raw)
         VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (source,ext_id) DO NOTHING`,
        [uuid(), r.tenant_id, 'pos_sales', String(r.ext_id || r.id), reason, null, r.total,
          JSON.stringify({ order_no: r.receipt_no, customer: r.customer_name, sale_date: r.sale_date })]).catch(() => {});
    }
    const del = await qrun(`DELETE FROM pos_sales WHERE ${ERRANT}`);
    console.log(`  → deleted ${del.rowCount} errant pos_sales (quarantined for audit)`);
  }

  // 2) Phantom live-sale events — sale.created was historically persisted and
  //    replayed on reconnect. It's ephemeral now; clear the backlog so it stops
  //    resurrecting on the dashboard.
  const ev = await qone(`SELECT COUNT(*)::int n FROM events WHERE type='sale.created'`).catch(() => ({ n: 0 }));
  console.log(`\nevents (sale.created) to clear: ${ev.n}`);
  if (!DRY && ev.n) {
    const del = await qrun(`DELETE FROM events WHERE type='sale.created'`);
    console.log(`  → deleted ${del.rowCount} sale.created events`);
  }

  console.log(`\n[purge-errant] done.\n`);
  process.exit(0);
}

main().catch((e) => { console.error('[purge-errant] failed:', e); process.exit(1); });
