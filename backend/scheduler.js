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

const { v4: uuid } = require('uuid');
const { getDb } = require('./db');
const sales = require('./salesSource');
const { sendDailyReport } = require('./mailer');

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
  const db = getDb();
  const out = { date: dateStr, created: 0, updated: 0, emailed: 0, skipped_human: 0, errors: 0 };
  const tenants = db.prepare("SELECT * FROM tenants WHERE status='ACTIVE'").all();
  for (const t of tenants) {
    const recs = email ? db.prepare('SELECT email FROM recipients WHERE tenant_id=? AND active=1').all(t.id).map((r) => r.email) : [];
    const sitesList = db.prepare("SELECT * FROM sites WHERE tenant_id=? AND status='ACTIVE'").all(t.id);
    for (const s of sitesList) {
      let data;
      try { data = await sales.getSales(s.code, dateStr); } catch { out.errors++; continue; }
      if (!data || (data.orders || 0) === 0) continue; // nothing for this site/day
      const existing = db.prepare('SELECT * FROM daily_reports WHERE tenant_id=? AND site_id=? AND report_date=?').get(t.id, s.id, dateStr);
      if (existing && existing.created_by && (existing.status === 'SUBMITTED' || existing.status === 'EMAILED')) { out.skipped_human++; continue; }
      let exp = { total: 0 };
      try { exp = await sales.getExpensesTotal(s.code, dateStr); } catch {}
      const balance = (data.total || 0) - (exp.total || 0);
      const id = existing ? existing.id : uuid();
      db.prepare(`INSERT INTO daily_reports
        (id,tenant_id,site_id,report_date,total_sales,total_cash,total_deposit,diesel,expenses,balance,sales_json,production_json,notes,status,created_by)
        VALUES (@id,@tenant_id,@site_id,@report_date,@total_sales,@total_cash,@total_deposit,0,@expenses,@balance,@sales_json,'{}',@notes,'DRAFT',NULL)
        ON CONFLICT(tenant_id,site_id,report_date) DO UPDATE SET
          total_sales=@total_sales,total_cash=@total_cash,total_deposit=@total_deposit,expenses=@expenses,
          balance=@balance,sales_json=@sales_json,notes=@notes`)
        .run({ id, tenant_id: t.id, site_id: s.id, report_date: dateStr,
          total_sales: data.total || 0, total_cash: data.total_cash || 0, total_deposit: data.total_deposit || 0,
          expenses: exp.total || 0, balance, sales_json: JSON.stringify(data.lines || []), notes: paymentNote(data) });
      existing ? out.updated++ : out.created++;

      if (email && recs.length) {
        try {
          const report = db.prepare('SELECT * FROM daily_reports WHERE id=?').get(id);
          const sent = await sendDailyReport({ tenant: t, site: s, report, to: recs, attachments: [] });
          db.prepare('UPDATE daily_reports SET status=?, emailed_at=unixepoch() WHERE id=?').run('EMAILED', id);
          db.prepare('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status) VALUES (?,?,?,?,?,?)').run(uuid(), t.id, id, recs.join(','), sent.subject, 'SENT');
          out.emailed++;
        } catch (e) {
          db.prepare('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status,error) VALUES (?,?,?,?,?,?,?)').run(uuid(), t.id, id, recs.join(','), 'Daily report', 'FAILED', e.message);
          out.errors++;
        }
      }
    }
  }
  return out;
}

function start() {
  if (process.env.SYNC_ENABLED !== '1') { console.log('[sync] disabled (set SYNC_ENABLED=1 to enable nightly POS sync)'); return; }
  const cron = require('node-cron');
  const expr = process.env.SYNC_CRON || '30 22 * * *';
  const tz = process.env.SYNC_TZ || 'Africa/Lagos';
  if (!cron.validate(expr)) { console.error('[sync] invalid SYNC_CRON:', expr); return; }
  cron.schedule(expr, () => {
    const d = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD in business TZ
    syncDay(d, { email: process.env.SYNC_EMAIL === '1' })
      .then((r) => console.log('[sync]', JSON.stringify(r)))
      .catch((e) => console.error('[sync] failed:', e.message));
  }, { timezone: tz });
  console.log(`[sync] nightly POS sync scheduled '${expr}' (${tz})${process.env.SYNC_EMAIL === '1' ? ' + email' : ''}`);
}

module.exports = { syncDay, start };
