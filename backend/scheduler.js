/**
 * Daybook — nightly POS sync + optional daily email.
 *
 * Each night it snapshots every site's POS sales for the day into a Daybook
 * daily_report (so there's history + offline access), then (optionally) emails
 * each site's report to the tenant's recipients.
 *
 * SAFE: it never clobbers a report a human submitted/emailed — those are left
 * untouched. Synced rows are created_by = NULL (system) and status DRAFT.
 *
 * Env:
 *   SYNC_ENABLED=1            turn the nightly job on
 *   SYNC_CRON='30 22 * * *'   when to run (default 22:30)
 *   SYNC_TZ='Africa/Lagos'    cron timezone
 *   SYNC_EMAIL=1              also email each synced report to recipients
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');
const sales = require('./salesSource');
const { sendDailyReport } = require('./mailer');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads');

// ── Trial enforcement: suspend lapsed trials; expunge long-suspended (opt-in) ──
async function expungeTenant(id) {
  try {
    const docs = await qall('SELECT stored_name FROM documents WHERE tenant_id=?', [id]);
    for (const d of docs) { try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch {} }
  } catch {}
  for (const tbl of ['generator_logs', 'generators', 'timesheets', 'staff', 'documents', 'daily_reports',
    'recipients', 'invites', 'memberships', 'sites', 'email_log', 'audit_log']) {
    try { await qrun(`DELETE FROM ${tbl} WHERE tenant_id=?`, [id]); } catch {}
  }
  await qrun('DELETE FROM tenants WHERE id=?', [id]);
}

async function enforceTrials() {
  const now = Math.floor(Date.now() / 1000);
  const out = { suspended: 0, expunged: 0 };
  const paidOk = (t) => t.paid_until && t.paid_until >= now;

  // Suspend active non-OWNER tenants whose trial has lapsed and aren't paid.
  const active = await qall("SELECT * FROM tenants WHERE status='ACTIVE' AND plan!='OWNER' AND trial_ends_at IS NOT NULL");
  for (const t of active) {
    if (t.trial_ends_at < now && !paidOk(t)) {
      await qrun("UPDATE tenants SET status='SUSPENDED' WHERE id=?", [t.id]);
      out.suspended++;
    }
  }
  // Expunge long-suspended unpaid tenants — only when explicitly enabled.
  if (process.env.EXPUNGE_ENABLED === '1') {
    const cutoff = now - parseInt(process.env.EXPUNGE_GRACE_DAYS || '30', 10) * 86400;
    const suspended = await qall("SELECT * FROM tenants WHERE status='SUSPENDED' AND plan!='OWNER'");
    for (const t of suspended) {
      if ((t.trial_ends_at || 0) < cutoff && !paidOk(t)) { await expungeTenant(t.id); out.expunged++; }
    }
  }
  return out;
}

function paymentNote(data) {
  const pm = (data.payments || []).map((p) => `${p.method} ₦${Math.round(p.amount).toLocaleString()}`).join(' · ');
  return pm ? `[POS sync ${data.date}] ${pm}` : '';
}

/**
 * Snapshot one day's POS sales into reports.
 * @param {string} dateStr YYYY-MM-DD
 * @param {object} opts { email }
 */
async function syncDay(dateStr, { email = false } = {}) {
  if (!sales.salesEnabled()) return { skipped: 'sales source not configured' };
  const out = { date: dateStr, created: 0, updated: 0, emailed: 0, skipped_human: 0, errors: 0 };
  const tenants = await qall("SELECT * FROM tenants WHERE status='ACTIVE'");
  for (const t of tenants) {
    const recs = email
      ? (await qall('SELECT email FROM recipients WHERE tenant_id=? AND active=1', [t.id])).map((r) => r.email)
      : [];
    const sitesList = await qall("SELECT * FROM sites WHERE tenant_id=? AND status='ACTIVE'", [t.id]);
    for (const s of sitesList) {
      let data;
      try { data = await sales.getSales(s.code, dateStr); } catch { out.errors++; continue; }
      if (!data || (data.orders || 0) === 0) continue; // nothing for this site/day
      const existing = await qone('SELECT * FROM daily_reports WHERE tenant_id=? AND site_id=? AND report_date=?', [t.id, s.id, dateStr]);
      if (existing && existing.created_by && (existing.status === 'SUBMITTED' || existing.status === 'EMAILED')) {
        out.skipped_human++; continue;
      }
      let exp = { total: 0 };
      try { exp = await sales.getExpensesTotal(s.code, dateStr); } catch {}
      const balance = (data.total || 0) - (exp.total || 0);
      const id = existing ? existing.id : uuid();
      await qrun(
        `INSERT INTO daily_reports
          (id,tenant_id,site_id,report_date,total_sales,total_cash,total_deposit,diesel,expenses,balance,sales_json,production_json,notes,status,created_by)
          VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,NULL)
          ON CONFLICT(tenant_id,site_id,report_date) DO UPDATE SET
            total_sales=EXCLUDED.total_sales, total_cash=EXCLUDED.total_cash, total_deposit=EXCLUDED.total_deposit,
            expenses=EXCLUDED.expenses, balance=EXCLUDED.balance, sales_json=EXCLUDED.sales_json, notes=EXCLUDED.notes`,
        [id, t.id, s.id, dateStr,
          data.total || 0, data.total_cash || 0, data.total_deposit || 0,
          exp.total || 0, balance,
          JSON.stringify(data.lines || []), '{}', paymentNote(data), 'DRAFT']);
      existing ? out.updated++ : out.created++;

      if (email && recs.length) {
        try {
          const report = await qone('SELECT * FROM daily_reports WHERE id=?', [id]);
          const sent = await sendDailyReport({ tenant: t, site: s, report, to: recs, attachments: [] });
          await qrun('UPDATE daily_reports SET status=?, emailed_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=?', ['EMAILED', id]);
          await qrun('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status) VALUES (?,?,?,?,?,?)',
            [uuid(), t.id, id, recs.join(','), sent.subject, 'SENT']);
          out.emailed++;
        } catch (e) {
          await qrun('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status,error) VALUES (?,?,?,?,?,?,?)',
            [uuid(), t.id, id, recs.join(','), 'Daily report', 'FAILED', e.message]);
          out.errors++;
        }
      }
    }
  }
  return out;
}

// Run the Fido→Postgres ETL as a child process. A short --from window keeps the
// date-filtered collections (orders, expenses) to a delta while the small
// reference sets (staff, customers, vendors, products, generators) refresh fully.
function runEtl(label = 'scheduled') {
  const { spawn } = require('child_process');
  const days = parseInt(process.env.ETL_BACKFILL_DAYS || '2', 10);
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const args = [path.join(__dirname, 'etl.js'), '--collection', 'all', '--from', from];
  console.log(`[etl] ${label} run starting: node etl.js --collection all --from ${from}`);
  const p = spawn('node', args, { env: process.env, stdio: 'inherit' });
  p.on('close', (code) => console.log(`[etl] ${label} run finished (exit ${code})`));
  p.on('error', (e) => console.error('[etl] spawn failed:', e.message));
}

function start() {
  const cron = require('node-cron');
  const tz = process.env.SYNC_TZ || 'Africa/Lagos';

  // Scheduled ETL (opt-in) — keeps ALL Fido data (not just live sales) current.
  if (process.env.ETL_ENABLED === '1') {
    const ecron = process.env.ETL_CRON || '0 1 * * *'; // 01:00 nightly
    if (cron.validate(ecron)) {
      cron.schedule(ecron, () => runEtl('cron'), { timezone: tz });
      console.log(`[etl] scheduled '${ecron}' (${tz}), --from = today-${process.env.ETL_BACKFILL_DAYS || '2'}d`);
    } else { console.error('[etl] invalid ETL_CRON:', ecron); }
  } else {
    console.log('[etl] scheduled ETL disabled (set ETL_ENABLED=1 to keep all entities current)');
  }

  // Daily trial enforcement (always on — suspension is safe; expunge is opt-in).
  const tcron = process.env.TRIAL_CRON || '0 2 * * *';
  if (cron.validate(tcron)) {
    cron.schedule(tcron, () => {
      enforceTrials()
        .then((r) => console.log('[trials]', JSON.stringify(r)))
        .catch((e) => console.error('[trials] failed:', e.message));
    }, { timezone: tz });
    console.log(`[trials] enforcement scheduled '${tcron}' (${tz})${process.env.EXPUNGE_ENABLED === '1' ? ' + expunge' : ''}`);
  }

  // Nightly POS → Daybook sync (opt-in).
  if (process.env.SYNC_ENABLED !== '1') { console.log('[sync] disabled (set SYNC_ENABLED=1 to enable nightly POS sync)'); return; }
  const expr = process.env.SYNC_CRON || '30 22 * * *';
  if (!cron.validate(expr)) { console.error('[sync] invalid SYNC_CRON:', expr); return; }
  cron.schedule(expr, () => {
    const d = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    syncDay(d, { email: process.env.SYNC_EMAIL === '1' })
      .then((r) => console.log('[sync]', JSON.stringify(r)))
      .catch((e) => console.error('[sync] failed:', e.message));
  }, { timezone: tz });
  console.log(`[sync] nightly POS sync scheduled '${expr}' (${tz})${process.env.SYNC_EMAIL === '1' ? ' + email' : ''}`);
}

module.exports = { syncDay, enforceTrials, start };
