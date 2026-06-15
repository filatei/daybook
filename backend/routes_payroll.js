/**
 * Daybook — Payroll engine (Phase 3)
 *
 * Covers:
 *   1. Pay rates — per-staff versioned daily/monthly/piece rates
 *   2. ETL payroll — read-only view of data imported from Fido Mongo
 *   3. Payroll runs — compute from Daybook timesheets, approve, mark paid
 *
 * Mounted at /api/payroll
 */
'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun, withTransaction } = require('./db');
const { requireAuth, contextFor, requestedTenant, atLeast } = require('./auth');

const router = express.Router();
const nowS = () => Math.floor(Date.now() / 1000);

// ── helper ────────────────────────────────────────────────────────────────────
async function needCtx(req, res, minRole = 'SNR_ACCOUNTANT') {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  const c = await contextFor(req.user, tid);
  if (!c || !atLeast(c.role, minRole)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAY RATES
// ═══════════════════════════════════════════════════════════════════════════════

/** Current effective rate for a staff member (latest row ≤ today). */
async function currentRate(staffId) {
  return qone(
    `SELECT * FROM staff_pay_rates
      WHERE staff_id=? AND effective_from<=CURRENT_DATE
      ORDER BY effective_from DESC LIMIT 1`,
    [staffId]);
}

router.get('/rates', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { site } = req.query;
  const where = ['spr.tenant_id=?'], args = [c.tenant_id];
  if (site) { where.push('st.site_id=?'); args.push(site); }
  const rows = await qall(
    `SELECT spr.*, st.full_name staff_name, st.role_title, si.name site_name
     FROM staff_pay_rates spr
     JOIN staff st ON st.id=spr.staff_id
     LEFT JOIN sites si ON si.id=st.site_id
     WHERE ${where.join(' AND ')} ORDER BY st.full_name, spr.effective_from DESC`,
    args);
  res.json(rows);
});

router.post('/rates', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const b = req.body || {};
  if (!b.staff_id || !b.effective_from) return res.status(400).json({ error: 'staff_id and effective_from required' });
  const st = await qone('SELECT * FROM staff WHERE id=? AND tenant_id=?', [b.staff_id, c.tenant_id]);
  if (!st) return res.status(400).json({ error: 'invalid staff' });
  const id = uuid();
  try {
    await qrun(
      `INSERT INTO staff_pay_rates (id,staff_id,tenant_id,pay_type,daily_rate,monthly_rate,piece_rate,effective_from)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, st.id, c.tenant_id,
        b.pay_type || st.pay_type || 'DAILY',
        +b.daily_rate || 0, +b.monthly_rate || 0, +b.piece_rate || 0,
        b.effective_from]);
  } catch { return res.status(409).json({ error: 'a rate already exists for this staff on that date' }); }
  res.status(201).json(await qone('SELECT * FROM staff_pay_rates WHERE id=?', [id]));
});

router.patch('/rates/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const r = await qone('SELECT * FROM staff_pay_rates WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  await qrun(
    `UPDATE staff_pay_rates SET pay_type=?,daily_rate=?,monthly_rate=?,piece_rate=?,effective_from=? WHERE id=?`,
    [b.pay_type ?? r.pay_type, b.daily_rate != null ? +b.daily_rate : r.daily_rate,
      b.monthly_rate != null ? +b.monthly_rate : r.monthly_rate,
      b.piece_rate != null ? +b.piece_rate : r.piece_rate,
      b.effective_from ?? r.effective_from, r.id]);
  res.json(await qone('SELECT * FROM staff_pay_rates WHERE id=?', [r.id]));
});

router.delete('/rates/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'ADMIN'); if (!c) return;
  await qrun('DELETE FROM staff_pay_rates WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ETL PAYROLL (imported from Fido Mongo — read only)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/imported', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { month, year, site } = req.query;
  const where = ['p.tenant_id=?'], args = [c.tenant_id];
  if (month) { where.push('p.month=?'); args.push(String(month)); }
  if (year)  { where.push('p.year=?');  args.push(String(year)); }
  if (site)  { where.push('p.site_id=?'); args.push(site); }
  const rows = await qall(
    `SELECT p.*, s.name site_name FROM payroll p
       LEFT JOIN sites s ON s.id=p.site_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.year DESC, p.month DESC, p.staff_name LIMIT 1000`,
    args);
  res.json(rows);
});

router.get('/imported/summary', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { year, site } = req.query;
  const where = ['p.tenant_id=?'], args = [c.tenant_id];
  if (year) { where.push('p.year=?'); args.push(String(year)); }
  if (site) { where.push('p.site_id=?'); args.push(site); }
  const W = 'WHERE ' + where.join(' AND ');
  const byMonth = await qall(
    `SELECT p.month, p.year, COALESCE(SUM(p.gross_pay),0) gross, COALESCE(SUM(p.net_pay),0) net, COUNT(*) staff
     FROM payroll p ${W}
     GROUP BY p.year, p.month ORDER BY p.year DESC, p.month DESC LIMIT 24`,
    args);
  const bySite = await qall(
    `SELECT s.name site, COALESCE(SUM(p.gross_pay),0) gross, COALESCE(SUM(p.net_pay),0) net
     FROM payroll p LEFT JOIN sites s ON s.id=p.site_id ${W}
     GROUP BY p.site_id, s.name ORDER BY gross DESC`,
    args);
  res.json({ byMonth, bySite });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYROLL RUNS (computed from Daybook timesheets)
// ═══════════════════════════════════════════════════════════════════════════════

const runView = async (runId) => {
  const run = await qone('SELECT * FROM payroll_runs WHERE id=?', [runId]);
  if (!run) return null;
  run.lines = await qall('SELECT * FROM payroll_run_lines WHERE run_id=? ORDER BY staff_name', [runId]);
  return run;
};

router.get('/runs', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { site, status } = req.query;
  const where = ['r.tenant_id=?'], args = [c.tenant_id];
  if (site)   { where.push('r.site_id=?'); args.push(site); }
  if (status) { where.push('r.status=?'); args.push(status.toUpperCase()); }
  const rows = await qall(
    `SELECT r.*, s.name site_name FROM payroll_runs r LEFT JOIN sites s ON s.id=r.site_id
     WHERE ${where.join(' AND ')} ORDER BY r.period_start DESC LIMIT 100`,
    args);
  res.json(rows);
});

router.get('/runs/:id', requireAuth, async (req, res) => {
  const run = await runView(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, run.tenant_id);
  if (!c || !atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'forbidden' });
  res.json(run);
});

/**
 * POST /payroll/runs/compute
 * Compute a payroll run from timesheets for a given site + date range.
 * Does NOT save unless save=true in the body. Returns the computed lines.
 */
router.post('/runs/compute', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const b = req.body || {};
  const { period_start, period_end, site_id, save: doSave } = b;
  if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end required' });
  const siteId = c.role === 'SITE_MANAGER' ? c.site_id : (site_id || null);

  // Check for existing run
  if (siteId) {
    const existing = await qone(
      'SELECT id FROM payroll_runs WHERE tenant_id=? AND site_id=? AND period_start=? AND period_end=?',
      [c.tenant_id, siteId, period_start, period_end]);
    if (existing) return res.status(409).json({ error: 'run already exists for this period', run_id: existing.id });
  }

  // Pull timesheet summaries
  const where = ['t.tenant_id=?', "t.work_date>='" + period_start + "'", "t.work_date<='" + period_end + "'"];
  const args = [c.tenant_id];
  if (siteId) { where.push('t.site_id=?'); args.push(siteId); }
  const tsRows = await qall(
    `SELECT t.staff_id, st.full_name, st.pay_type, st.site_id,
       COUNT(CASE WHEN t.present=1 THEN 1 END) days_present,
       COALESCE(SUM(t.hours),0) hours,
       COALESCE(SUM(t.bags_bagged),0) bags_bagged,
       COALESCE(SUM(t.bags_loaded),0) bags_loaded
     FROM timesheets t
     JOIN staff st ON st.id=t.staff_id
     WHERE ${where.join(' AND ')}
     GROUP BY t.staff_id, st.full_name, st.pay_type, st.site_id`,
    args);

  // Compute pay for each staff member
  const lines = [];
  for (const row of tsRows) {
    const rate = await currentRate(row.staff_id);
    let gross = 0;
    let pay_type = row.pay_type || 'DAILY';
    let rate_used = 0;

    if (rate) {
      pay_type = rate.pay_type;
      if (pay_type === 'DAILY') {
        rate_used = rate.daily_rate;
        gross = parseInt(row.days_present, 10) * rate_used;
      } else if (pay_type === 'MONTHLY') {
        rate_used = rate.monthly_rate;
        gross = rate_used; // monthly is flat regardless of attendance
      } else if (pay_type === 'PIECE') {
        rate_used = rate.piece_rate;
        gross = (parseInt(row.bags_bagged, 10) + parseInt(row.bags_loaded, 10)) * rate_used;
      }
    }

    const deductions = 0; // extend here: tax, advances, etc.
    const net = Math.max(0, gross - deductions);
    lines.push({
      staff_id: row.staff_id,
      staff_name: row.full_name,
      days_present: parseInt(row.days_present, 10),
      hours: parseFloat(row.hours) || 0,
      bags_bagged: parseInt(row.bags_bagged, 10),
      bags_loaded: parseInt(row.bags_loaded, 10),
      pay_type,
      rate: rate_used,
      gross_pay: gross,
      deductions,
      net_pay: net,
    });
  }

  const total_gross = lines.reduce((a, l) => a + l.gross_pay, 0);
  const total_net   = lines.reduce((a, l) => a + l.net_pay, 0);
  const total_deductions = lines.reduce((a, l) => a + l.deductions, 0);

  if (!doSave) {
    return res.json({ preview: true, period_start, period_end, site_id: siteId,
      total_gross, total_net, total_deductions, headcount: lines.length, lines });
  }

  // Save
  const runId = uuid();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO payroll_runs
         (id,tenant_id,site_id,period_start,period_end,total_gross,total_net,total_deductions,headcount,computed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [runId, c.tenant_id, siteId, period_start, period_end,
        total_gross, total_net, total_deductions, lines.length, req.user.id]);
    for (const l of lines) {
      await client.query(
        `INSERT INTO payroll_run_lines
           (id,run_id,tenant_id,staff_id,staff_name,days_present,hours,bags_bagged,bags_loaded,pay_type,rate,gross_pay,deductions,net_pay)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [uuid(), runId, c.tenant_id, l.staff_id, l.staff_name,
          l.days_present, l.hours, l.bags_bagged, l.bags_loaded,
          l.pay_type, l.rate, l.gross_pay, l.deductions, l.net_pay]);
    }
  });

  res.status(201).json(await runView(runId));
});

/** Approve or mark paid */
router.post('/runs/:id/status', requireAuth, async (req, res) => {
  const run = await qone('SELECT * FROM payroll_runs WHERE id=?', [req.params.id]);
  if (!run) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, run.tenant_id);
  if (!c || !atLeast(c.role, 'ADMIN')) return res.status(403).json({ error: 'admin required' });
  const newStatus = (req.body?.status || '').toUpperCase();
  const valid = { DRAFT: ['APPROVED', 'DELETED'], APPROVED: ['PAID'] };
  const allowed = valid[run.status] || [];
  if (!allowed.includes(newStatus) && newStatus !== 'DELETED')
    return res.status(400).json({ error: `Cannot move from ${run.status} to ${newStatus}` });
  if (newStatus === 'DELETED') {
    await qrun('DELETE FROM payroll_runs WHERE id=?', [run.id]);
    return res.json({ ok: true, deleted: true });
  }
  await qrun(
    `UPDATE payroll_runs SET status=?, approved_by=CASE WHEN ?='APPROVED' THEN ? ELSE approved_by END WHERE id=?`,
    [newStatus, newStatus, req.user.id, run.id]);
  res.json(await runView(run.id));
});

/** CSV export of a run */
router.get('/runs/:id/export.csv', requireAuth, async (req, res) => {
  const run = await runView(req.params.id);
  if (!run) return res.status(404).end();
  const c = await contextFor(req.user, run.tenant_id);
  if (!c || !atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).end();
  const headers = ['Staff', 'Days Present', 'Hours', 'Bags Bagged', 'Bags Loaded', 'Pay Type', 'Rate', 'Gross Pay', 'Deductions', 'Net Pay'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [headers.join(','),
    ...run.lines.map((l) => [l.staff_name, l.days_present, l.hours, l.bags_bagged, l.bags_loaded,
      l.pay_type, l.rate, l.gross_pay, l.deductions, l.net_pay].map(q).join(','))];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${run.period_start}_${run.period_end}.csv"`);
  res.send(rows.join('\n'));
});

module.exports = router;
