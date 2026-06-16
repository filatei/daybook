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
const { requireAuth, contextFor, requestedTenant, atLeast, siteBound } = require('./auth');

const router = express.Router();
const nowS = () => Math.floor(Date.now() / 1000);

// ── helper ────────────────────────────────────────────────────────────────────
async function needCtx(req, res, minRole = 'ACCOUNTANT') {
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
  const siteId = siteBound(c) ? c.site_id : (site_id || null);

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

// ═══════════════════════════════════════════════════════════════════════════════
// PAYROLL v2 — pay config, daily production capture, period compute
//   Piece workers (loaders/baggers): pay = bags_loaded×rate_loaded + bags_bagged×rate_bagged
//   Regular staff: pay = days_present (from attendance) × daily_rate
// ═══════════════════════════════════════════════════════════════════════════════

// ── Pay configuration (rates) — Snr Accountant+ ────────────────────────────────
router.get('/pay-config', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const where = ['tenant_id=?', "status='ACTIVE'"], args = [c.tenant_id];
  if (req.query.site) { where.push('site_id=?'); args.push(req.query.site); }
  res.json(await qall(`SELECT id, full_name, role_title, site_id, pay_type, daily_rate, rate_loaded, rate_bagged
    FROM staff WHERE ${where.join(' AND ')} ORDER BY full_name`, args));
});
router.patch('/pay-config/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const st = await qone('SELECT * FROM staff WHERE id=?', [req.params.id]);
  if (!st || st.tenant_id !== c.tenant_id) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const pt = ['DAILY', 'PIECE', 'HOURLY', 'MONTHLY'].includes((b.pay_type || '').toUpperCase()) ? b.pay_type.toUpperCase() : st.pay_type;
  await qrun('UPDATE staff SET pay_type=?, daily_rate=?, rate_loaded=?, rate_bagged=? WHERE id=?',
    [pt, +b.daily_rate || 0, +b.rate_loaded || 0, +b.rate_bagged || 0, st.id]);
  res.json(await qone('SELECT id, full_name, pay_type, daily_rate, rate_loaded, rate_bagged FROM staff WHERE id=?', [st.id]));
});

// ── Daily production entry (bags loaded / bagged) — Supervisor (Site Manager+) ──
router.get('/production', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'SECRETARY'); if (!c) return;
  const date = (req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const where = ['s.tenant_id=?', "s.status='ACTIVE'"], args = [date, c.tenant_id];
  if (siteBound(c)) { where.push('s.site_id=?'); args.push(c.site_id); }
  else if (req.query.site) { where.push('s.site_id=?'); args.push(req.query.site); }
  res.json(await qall(`SELECT s.id staff_id, s.full_name, s.role_title, s.pay_type, s.site_id,
    COALESCE(p.bags_loaded,0) bags_loaded, COALESCE(p.bags_bagged,0) bags_bagged
    FROM staff s LEFT JOIN production p ON p.staff_id=s.id AND p.work_date=?
    WHERE ${where.join(' AND ')} ORDER BY s.full_name`, args));
});
router.post('/production', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'SECRETARY'); if (!c) return;
  const b = req.body || {};
  const st = await qone('SELECT * FROM staff WHERE id=?', [b.staff_id]);
  if (!st || st.tenant_id !== c.tenant_id) return res.status(400).json({ error: 'invalid staff' });
  if (siteBound(c) && st.site_id !== c.site_id) return res.status(403).json({ error: 'forbidden' });
  const date = (b.work_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  await qrun(`INSERT INTO production (id,tenant_id,site_id,staff_id,work_date,bags_loaded,bags_bagged,recorded_by,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT (tenant_id,staff_id,work_date) DO UPDATE SET
      bags_loaded=EXCLUDED.bags_loaded, bags_bagged=EXCLUDED.bags_bagged, recorded_by=EXCLUDED.recorded_by, updated_at=EXCLUDED.updated_at`,
    [uuid(), c.tenant_id, st.site_id, st.id, date, +b.bags_loaded || 0, +b.bags_bagged || 0, req.user.id, nowS()]);
  res.json({ ok: true });
});

// Shared: compute gross-pay lines for a period (+ outstanding advance per staff).
async function computeLines(tenant_id, from, to, site) {
  const sWhere = ['tenant_id=?', "status='ACTIVE'"], sArgs = [tenant_id];
  if (site) { sWhere.push('site_id=?'); sArgs.push(site); }
  const staff = await qall(`SELECT id, full_name, role_title, site_id, pay_type, daily_rate, rate_loaded, rate_bagged
    FROM staff WHERE ${sWhere.join(' AND ')} ORDER BY full_name`, sArgs);
  const att = await qall(`SELECT staff_id, COUNT(DISTINCT work_date) d FROM attendance
    WHERE tenant_id=? AND clock_in IS NOT NULL AND work_date BETWEEN ? AND ? GROUP BY staff_id`, [tenant_id, from, to]);
  const daysBy = {}; for (const a of att) daysBy[a.staff_id] = Number(a.d);
  const prod = await qall(`SELECT staff_id, COALESCE(SUM(bags_loaded),0) l, COALESCE(SUM(bags_bagged),0) g FROM production
    WHERE tenant_id=? AND work_date BETWEEN ? AND ? GROUP BY staff_id`, [tenant_id, from, to]);
  const prodBy = {}; for (const p of prod) prodBy[p.staff_id] = { l: Number(p.l), g: Number(p.g) };
  // Outstanding (unsettled) advances up to the period end.
  const adv = await qall(`SELECT staff_id, COALESCE(SUM(amount),0) a FROM staff_advances
    WHERE tenant_id=? AND run_id IS NULL AND adv_date<=? GROUP BY staff_id`, [tenant_id, to]);
  const advBy = {}; for (const a of adv) advBy[a.staff_id] = Number(a.a);
  return staff.map((s) => {
    const days = daysBy[s.id] || 0;
    const pb = prodBy[s.id] || { l: 0, g: 0 };
    const piece = (s.pay_type || '').toUpperCase() === 'PIECE';
    const gross = piece ? (pb.l * (s.rate_loaded || 0) + pb.g * (s.rate_bagged || 0)) : (days * (s.daily_rate || 0));
    return { staff_id: s.id, full_name: s.full_name, role_title: s.role_title, pay_type: s.pay_type,
      days_present: days, bags_loaded: pb.l, bags_bagged: pb.g, gross: Math.round(gross * 100) / 100,
      advance: Math.round((advBy[s.id] || 0) * 100) / 100 };
  }).filter((l) => l.gross > 0 || l.days_present > 0 || l.bags_loaded > 0 || l.bags_bagged > 0 || l.advance > 0);
}

// ── Compute a payroll for a period (preview, not saved) — Snr Accountant+ ───────
router.post('/compute2', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { from, to, site } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const lines = await computeLines(c.tenant_id, from, to, site || null);
  res.json({ from, to, lines, total: Math.round(lines.reduce((a, l) => a + l.gross, 0) * 100) / 100 });
});

// ── Advances / deductions — Supervisor (Site Manager+) records; settled at run ──
router.post('/advances', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'SECRETARY'); if (!c) return;
  const b = req.body || {};
  const st = await qone('SELECT * FROM staff WHERE id=?', [b.staff_id]);
  if (!st || st.tenant_id !== c.tenant_id) return res.status(400).json({ error: 'invalid staff' });
  if (siteBound(c) && st.site_id !== c.site_id) return res.status(403).json({ error: 'forbidden' });
  const amount = +b.amount || 0; if (!amount) return res.status(400).json({ error: 'amount required' });
  const id = uuid();
  await qrun('INSERT INTO staff_advances (id,tenant_id,staff_id,adv_date,amount,reason,created_by) VALUES (?,?,?,?,?,?,?)',
    [id, c.tenant_id, st.id, (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10), amount, b.reason || null, req.user.id]);
  res.status(201).json({ id });
});
router.get('/advances', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'SECRETARY'); if (!c) return;
  const where = ['sa.tenant_id=?'], args = [c.tenant_id];
  if (req.query.staff_id) { where.push('sa.staff_id=?'); args.push(req.query.staff_id); }
  if (req.query.outstanding === '1') where.push('sa.run_id IS NULL');
  res.json(await qall(`SELECT sa.*, s.full_name FROM staff_advances sa LEFT JOIN staff s ON s.id=sa.staff_id
    WHERE ${where.join(' AND ')} ORDER BY sa.adv_date DESC LIMIT 300`, args));
});

// ── Save a payroll run (DRAFT) with per-line deductions — Snr Accountant+ ───────
router.post('/runs2', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const b = req.body || {};
  const { from, to } = b; const site = b.site || null;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const ded = b.deductions || {};   // { staff_id: amount }
  const lines = await computeLines(c.tenant_id, from, to, site);
  const runId = uuid();
  let tg = 0, td = 0, tn = 0;
  await withTransaction(async () => {
    await qrun(`INSERT INTO pay_runs (id,tenant_id,site_id,period_from,period_to,status,created_by) VALUES (?,?,?,?,?, 'DRAFT', ?)`,
      [runId, c.tenant_id, site, from, to, req.user.id]);
    for (const l of lines) {
      const d = Math.min(l.gross, Math.max(0, ded[l.staff_id] != null ? +ded[l.staff_id] : l.advance));
      const net = Math.round((l.gross - d) * 100) / 100;
      tg += l.gross; td += d; tn += net;
      await qrun(`INSERT INTO pay_run_lines (id,run_id,tenant_id,staff_id,staff_name,pay_type,days_present,bags_loaded,bags_bagged,gross,deductions,net)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), runId, c.tenant_id, l.staff_id, l.full_name, l.pay_type, l.days_present, l.bags_loaded, l.bags_bagged, l.gross, d, net]);
      // Settle outstanding advances for this worker up to the period end.
      if (d > 0) await qrun('UPDATE staff_advances SET run_id=? WHERE tenant_id=? AND staff_id=? AND run_id IS NULL AND adv_date<=?', [runId, c.tenant_id, l.staff_id, to]);
    }
    await qrun('UPDATE pay_runs SET total_gross=?, total_deductions=?, total_net=? WHERE id=?',
      [Math.round(tg * 100) / 100, Math.round(td * 100) / 100, Math.round(tn * 100) / 100, runId]);
  });
  res.status(201).json({ id: runId });
});

router.get('/runs2', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  res.json(await qall(`SELECT r.*, s.name site_name FROM pay_runs r LEFT JOIN sites s ON s.id=r.site_id
    WHERE r.tenant_id=? ORDER BY r.created_at DESC LIMIT 100`, [c.tenant_id]));
});
router.get('/runs2/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await qone('SELECT * FROM pay_runs WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!run) return res.status(404).json({ error: 'not found' });
  run.lines = await qall('SELECT * FROM pay_run_lines WHERE run_id=? ORDER BY staff_name', [run.id]);
  res.json(run);
});
// Approve (Snr Accountant+) → Paid (General Manager+).
router.post('/runs2/:id/status', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await qone('SELECT * FROM pay_runs WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!run) return res.status(404).json({ error: 'not found' });
  const next = (req.body && req.body.status || '').toUpperCase();
  if (next === 'APPROVED') {
    if (run.status !== 'DRAFT') return res.status(400).json({ error: 'only a draft can be approved' });
    await qrun('UPDATE pay_runs SET status=?, approved_by=?, approved_at=? WHERE id=?', ['APPROVED', req.user.id, nowS(), run.id]);
  } else if (next === 'PAID') {
    if (!atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'only a General Manager can mark paid' });
    if (run.status !== 'APPROVED') return res.status(400).json({ error: 'approve before marking paid' });
    await qrun('UPDATE pay_runs SET status=?, paid_at=? WHERE id=?', ['PAID', nowS(), run.id]);
  } else return res.status(400).json({ error: 'invalid status' });
  res.json(await qone('SELECT * FROM pay_runs WHERE id=?', [run.id]));
});
router.get('/runs2/:id/export.csv', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await qone('SELECT * FROM pay_runs WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!run) return res.status(404).end();
  const lines = await qall('SELECT * FROM pay_run_lines WHERE run_id=? ORDER BY staff_name', [run.id]);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const out = [['Staff', 'Pay type', 'Days', 'Bags loaded', 'Bags bagged', 'Gross', 'Deductions', 'Net'].join(','),
    ...lines.map((l) => [l.staff_name, l.pay_type, l.days_present, l.bags_loaded, l.bags_bagged, l.gross, l.deductions, l.net].map(q).join(','))];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${run.period_from}_${run.period_to}.csv"`);
  res.send(out.join('\r\n'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// MID-MONTH PAYROLL — piece-worker (bagger/loader) commission for the 1st–15th.
// Auto-generated from production × rate, replacing the manual Fido Excel upload.
// ═══════════════════════════════════════════════════════════════════════════════
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const excelSerial = (d) => Math.floor((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000);
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', middle: '', last: '' };
  if (parts.length === 1) return { first: parts[0], middle: '', last: '' };
  if (parts.length === 2) return { first: parts[0], middle: '', last: parts[1] };
  return { first: parts[0], last: parts[parts.length - 1], middle: parts.slice(1, -1).join(' ') };
}
function midRange(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' }).slice(0, 7);
  return { month: m, from: `${m}-01`, to: `${m}-15` };
}

// Piece-worker commission lines for a period (baggers & loaders with production).
async function computePieceLines(tenant_id, from, to, site) {
  const sWhere = ['s.tenant_id=?', "s.status='ACTIVE'",
    "(UPPER(COALESCE(s.staff_type,'')) IN ('BAGGER','LOADER') OR UPPER(COALESCE(s.pay_type,''))='PIECE')"], sArgs = [tenant_id];
  if (site) { sWhere.push('s.site_id=?'); sArgs.push(site); }
  const staff = await qall(`SELECT s.id, s.full_name, s.ext_people_id, s.staff_type, s.pay_type,
      s.rate_loaded, s.rate_bagged, s.bank_name, s.bank_account, st.name site_name
    FROM staff s LEFT JOIN sites st ON st.id=s.site_id WHERE ${sWhere.join(' AND ')} ORDER BY st.name, s.full_name`, sArgs);
  const prod = await qall(`SELECT staff_id, COALESCE(SUM(bags_loaded),0) l, COALESCE(SUM(bags_bagged),0) g
    FROM production WHERE tenant_id=? AND work_date BETWEEN ? AND ? GROUP BY staff_id`, [tenant_id, from, to]);
  const by = {}; for (const p of prod) by[p.staff_id] = { l: Number(p.l), g: Number(p.g) };
  const lines = [];
  for (const s of staff) {
    const pb = by[s.id] || { l: 0, g: 0 };
    const loadComm = pb.l * (s.rate_loaded || 0);
    const bagComm = pb.g * (s.rate_bagged || 0);
    const commission = r2(loadComm + bagComm);
    if (commission <= 0) continue;
    // Designation: explicit staff_type, else whichever production dominates.
    const designation = (s.staff_type === 'LOADER' || s.staff_type === 'BAGGER') ? s.staff_type : (pb.l >= pb.g ? 'LOADER' : 'BAGGER');
    const nm = splitName(s.full_name);
    lines.push({
      staff_id: s.id, ext_id: s.ext_people_id || '', ...nm, full_name: s.full_name,
      location: s.site_name || '', account: [s.bank_name, s.bank_account].filter(Boolean).join('-'),
      bags_loaded: pb.l, bags_bagged: pb.g, qty: designation === 'LOADER' ? pb.l : pb.g,
      commission, designation,
    });
  }
  return lines;
}

router.get('/midmonth/preview', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { month, from, to } = midRange(req.query.month);
  const site = siteBound(c) ? c.site_id : (req.query.site || null);
  const lines = await computePieceLines(c.tenant_id, from, to, site);
  const baggers = lines.filter((l) => l.designation === 'BAGGER');
  const loaders = lines.filter((l) => l.designation === 'LOADER');
  res.json({
    month, from, to,
    baggers, loaders,
    total_baggers: r2(baggers.reduce((a, l) => a + l.commission, 0)),
    total_loaders: r2(loaders.reduce((a, l) => a + l.commission, 0)),
    total: r2(lines.reduce((a, l) => a + l.commission, 0)),
    count: lines.length,
  });
});

// Generate (or refresh) the mid-month DRAFT run for the 1st–15th piece workers.
async function generateMidMonth(tenant_id, month, userId, site = null) {
  const { from, to } = midRange(month);
  const lines = await computePieceLines(tenant_id, from, to, site);
  let runId;
  await withTransaction(async () => {
    const existing = await qone("SELECT id FROM pay_runs WHERE tenant_id=? AND kind='MIDMONTH' AND period_from=? AND period_to=? AND status='DRAFT' AND COALESCE(site_id,'')=COALESCE(?, '')", [tenant_id, from, to, site]);
    runId = existing ? existing.id : uuid();
    if (existing) await qrun('DELETE FROM pay_run_lines WHERE run_id=?', [runId]);
    else await qrun(`INSERT INTO pay_runs (id,tenant_id,site_id,period_from,period_to,status,kind,created_by) VALUES (?,?,?,?,?, 'DRAFT', 'MIDMONTH', ?)`, [runId, tenant_id, site, from, to, userId || null]);
    let tot = 0;
    for (const l of lines) {
      tot += l.commission;
      await qrun(`INSERT INTO pay_run_lines (id,run_id,tenant_id,staff_id,staff_name,pay_type,days_present,bags_loaded,bags_bagged,gross,deductions,net)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), runId, tenant_id, l.staff_id, l.full_name, l.designation, 0, l.bags_loaded, l.bags_bagged, l.commission, 0, l.commission]);
    }
    await qrun('UPDATE pay_runs SET total_gross=?, total_deductions=0, total_net=? WHERE id=?', [r2(tot), r2(tot), runId]);
  });
  return { runId, count: lines.length };
}
router.post('/midmonth/generate', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { month } = midRange((req.body || {}).month);
  const site = siteBound(c) ? c.site_id : ((req.body || {}).site || null);
  const out = await generateMidMonth(c.tenant_id, month, req.user.id, site);
  res.status(201).json(out);
});

// Fido-format export (BAGGERS then LOADERS) for a saved mid-month run.
router.get('/runs2/:id/fido.csv', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await qone('SELECT * FROM pay_runs WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!run) return res.status(404).end();
  const lines = await qall(`SELECT pl.*, s.ext_people_id, s.full_name, s.bank_name, s.bank_account, st.name site_name
    FROM pay_run_lines pl LEFT JOIN staff s ON s.id=pl.staff_id LEFT JOIN sites st ON st.id=s.site_id
    WHERE pl.run_id=? ORDER BY st.name, s.full_name`, [run.id]);
  const ps = excelSerial(run.period_from), pe = excelSerial(run.period_to);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [];
  const section = (title, desig, header, mapRow) => {
    rows.push([title]); rows.push(header);
    let n = 0;
    for (const l of lines.filter((x) => (x.pay_type || '').toUpperCase() === desig)) rows.push(mapRow(l, ++n));
    rows.push([]);
  };
  section('BAGGERS', 'BAGGER',
    ['S/N', 'ID', 'FIRST NAME', 'MIDDLE NAME', 'LAST NAME', 'LOCATION', 'QTY', 'ACCOUNT NUMBER', 'COMMISSION', 'PAY START DATE', 'PAY END DATE', 'DESIGNATION'],
    (l, n) => { const nm = splitName(l.full_name); return [n, l.ext_people_id || '', nm.first, nm.middle, nm.last, l.site_name || '', l.bags_bagged, [l.bank_name, l.bank_account].filter(Boolean).join('-'), l.gross, ps, pe, 'BAGGER']; });
  section('LOADERS', 'LOADER',
    ['S/N', 'ID', 'FIRST NAME', 'MIDDLE NAME', 'LAST NAME', 'LOCATION', 'ACCOUNT NUMBER', 'BAGS LOADED', 'NET PAY (COMMISSION)', 'PAY START DATE', 'PAY END DATE', 'DESIGNATION'],
    (l, n) => { const nm = splitName(l.full_name); return [n, l.ext_people_id || '', nm.first, nm.middle, nm.last, l.site_name || '', [l.bank_name, l.bank_account].filter(Boolean).join('-'), l.bags_loaded, l.gross, ps, pe, 'LOADER']; });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="midmonth-payroll-${run.period_from}.csv"`);
  res.send(rows.map((r) => r.map(q).join(',')).join('\r\n'));
});

module.exports = router;
module.exports.generateMidMonth = generateMidMonth;
