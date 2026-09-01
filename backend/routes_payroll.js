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
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const multer = require('multer');
const { v4: uuid } = require('uuid');

// Parsed in memory, then the original workbook is written under PAYROLL_SHEET_DIR.
const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });
const PAYROLL_SHEET_DIR = process.env.PAYROLL_SHEET_DIR
  || (process.env.UPLOAD_DIR
    ? path.join(path.dirname(process.env.UPLOAD_DIR), 'payroll-sheets')
    : path.join(__dirname, '../data/payroll-sheets'));
const SHEET_EXT_OK = new Set(['.xls', '.xlsx']);
try { fs.mkdirSync(PAYROLL_SHEET_DIR, { recursive: true }); } catch (e) {
  console.warn('[payroll] PAYROLL_SHEET_DIR not ready at startup:', e.message);
}
const { qone, qall, qrun, withTransaction, clientQ } = require('./db');
const { requireAuth, contextFor, requestedTenant, atLeast, siteBound, groupContexts } = require('./auth');
const {
  nameKey, accountDigits, parseBankFields, csvAccountText, personGroups, STAFF_NAME_KEY_SQL,
} = require('./staffIdentity');

const router = express.Router();
const nowS = () => Math.floor(Date.now() / 1000);

// Local copy of routes.js's audit() — that module exports only its router, and
// requiring it here would be circular.
async function audit(tenant_id, user_id, action, entity, entity_id, meta) {
  await qrun('INSERT INTO audit_log (id,tenant_id,user_id,action,entity,entity_id,meta) VALUES (?,?,?,?,?,?,?)',
    [uuid(), tenant_id || null, user_id || null, action, entity, entity_id || null, meta ? JSON.stringify(meta) : null]);
}

// ── helper ────────────────────────────────────────────────────────────────────
// The Group roll-up is a SYNTHETIC workspace invented by the frontend
// (store.jsx GROUP_ID) — there is no such row in `tenants`. Payroll is run for
// the whole business (Fido + Fiafia together), so it is the one area that must
// resolve it rather than 403.
const GROUP_ID = '__group__';

// Payroll compute/config/approve/delete/bank is restricted to the finance tier:
// SNR ACCOUNTANT / GENERAL MANAGER / ADMIN (rank ≥ 7). Operational routes
// (recording production / advances) pass 'SECRETARY' explicitly to stay open
// to site staff.
//
// Uses auth.groupContexts (membership + finance-tier borrow) so a Snr Accountant
// whose row is only under Fido can still open/approve a Fiafia-owned run when
// Saved pins that run's tenant_id under Group.
async function needCtx(req, res, minRole = 'SNR_ACCOUNTANT') {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  if (tid === GROUP_ID) {
    const ctxs = await groupContexts(req.user, minRole);
    if (!ctxs.length) { res.status(403).json({ error: 'forbidden' }); return null; }
    // Anchor on the first tenant; `tenant_ids` carries the full payroll scope.
    // site_id is cleared — a group run is never site-bound.
    return { ...ctxs[0], site_id: null, group: true, tenant_ids: ctxs.map((x) => x.tenant_id) };
  }
  const c = await contextFor(req.user, tid);
  if (c && atLeast(c.role, minRole)) return c;
  // Whole-business finance borrow: SNR+ in ANY tenant → every active tenant.
  const borrowed = (await groupContexts(req.user, minRole)).find((x) => x.tenant_id === tid);
  if (borrowed) {
    return {
      tenant_id: borrowed.tenant_id,
      role: borrowed.role,
      site_id: borrowed.site_id || null,
      borrowed: !!borrowed.borrowed,
    };
  }
  res.status(403).json({ error: 'forbidden' });
  return null;
}

// ── Shared payroll predicates ─────────────────────────────────────────────────
// Defined once so every compute path filters identically. Past bugs came from
// one path quietly missing a guard the others had.
//
// PAYROLL_ELIGIBLE: an accountant has parked this person out of payroll
// (payroll_eligible=false) or marked them as having left (status='LEFT').
// COALESCE covers rows created before the column existed.
const PAYROLL_ELIGIBLE = "COALESCE(payroll_eligible, TRUE) = TRUE AND COALESCE(status,'') <> 'LEFT'";
// PIECE_WORKER: baggers/loaders paid per bag — the only people in a mid-month run.
const PIECE_WORKER = "(UPPER(COALESCE(staff_type,'')) IN ('BAGGER','LOADER') OR UPPER(COALESCE(pay_type,'')) = 'PIECE')";
// Same two predicates, aliased for queries that alias the staff table as `s`.
const PAYROLL_ELIGIBLE_S = PAYROLL_ELIGIBLE.replace(/\b(payroll_eligible|status)\b/g, 's.$1');
const PIECE_WORKER_S = PIECE_WORKER.replace(/\b(staff_type|pay_type)\b/g, 's.$1');
// JS twin of PIECE_WORKER, for guarding writes before they reach the database.
// Keep the two in step: if one changes, the other must.
const isPieceWorker = (st) => ['BAGGER', 'LOADER'].includes(String(st?.staff_type || '').toUpperCase())
  || String(st?.pay_type || '').toUpperCase() === 'PIECE';

// Score a staff row for "which duplicate should drive pay?" — the Fiafia ETL often
// creates a DAILY @ ₦0 twin where people actually clock in, while the Fido import
// carries MONTHLY salary on a record with no attendance. Picking members[0] paid
// zero for permanent staff who clocked in daily (Aug 2026 report: Otasowei et al.).
function payConfigScore(st) {
  const pt = String(st?.pay_type || '').toUpperCase();
  const rate = Number(st?.daily_rate) || 0;
  if (pt === 'MONTHLY' && rate > 0) return 300 + rate;
  if (pt === 'DAILY' && rate > 0) return 200 + rate;
  if (pt === 'PIECE' && (rate > 0 || ['BAGGER', 'LOADER'].includes(String(st?.staff_type || '').toUpperCase()))) return 100 + rate;
  if (pt === 'MONTHLY') return 10;
  return 0;
}

function pickPayrollHead(members) {
  // Pay config (MONTHLY salary, daily rate, piece role) — not sheet membership.
  // A Fiafia DAILY @ ₦0 clock-in twin must not beat a Fido MONTHLY record just
  // because they appear on a bag sheet with zero bags.
  return members.reduce((best, m) => (payConfigScore(m) > payConfigScore(best) ? m : best), members[0]);
}

// Home / primary site for grouping — staff.site_id, not where bags were done.
function resolvePrimarySite(members, siteNames, preferHead) {
  const ordered = preferHead
    ? [preferHead, ...(members || []).filter((m) => m.id !== preferHead.id)]
    : (members || []);
  for (const m of ordered) {
    if (m?.site_id) return { id: m.site_id, name: siteNames[m.site_id] || null };
  }
  return { id: null, name: null };
}

// Prefer the member whose home site reflects where they actually clocked in.
function resolveHomeMember(members, daysByStaff, fallback) {
  return members.find((m) => m.site_id && (daysByStaff[m.id]?.size || 0) > 0)
    || members.find((m) => m.site_id)
    || fallback;
}

// Staff tied to a site for filtering combined runs: home site, clock-ins, or bags.
async function staffIdsForSite(tenantIds, site, from, to) {
  if (!site) return null;
  const ph = tenantIds.map(() => '?').join(',');
  const rows = await qall(
    `SELECT DISTINCT staff_id FROM (
       SELECT id AS staff_id FROM staff WHERE tenant_id IN (${ph}) AND site_id=?
       UNION
       SELECT staff_id FROM attendance WHERE tenant_id IN (${ph}) AND site_id=? AND clock_in IS NOT NULL AND work_date BETWEEN ? AND ?
       UNION
       SELECT staff_id FROM production WHERE tenant_id IN (${ph}) AND site_id=? AND work_date BETWEEN ? AND ?
     ) x`,
    [...tenantIds, site, ...tenantIds, site, from, to, ...tenantIds, site, from, to]);
  return new Set(rows.map((r) => r.staff_id));
}

// Global, SHARED per-bag rates (one for loading, one for bagging) applied to every
// loader/bagger across the combined payroll. Stored tenant-independently.
//
// TWO rate pairs, because there are two different payments:
//   MONTHEND (rate_loaded / rate_bagged)         — full commission, ₦6/bag
//   MIDMONTH (rate_loaded_mid / rate_bagged_mid) — incentive for the lifting, ₦1/bag
// Passing the wrong kind pays 6x or 1/6th, so callers name it explicitly.
const RATE_KEYS = {
  MONTHEND: { loaded: 'rate_loaded', bagged: 'rate_bagged' },
  MIDMONTH: { loaded: 'rate_loaded_mid', bagged: 'rate_bagged_mid' },
};
async function getBagRates(kind = 'MONTHEND') {
  const k = RATE_KEYS[String(kind).toUpperCase()] || RATE_KEYS.MONTHEND;
  const rows = await qall('SELECT key, value FROM payroll_settings WHERE key IN (?,?)', [k.loaded, k.bagged]);
  const m = {}; for (const r of rows) m[r.key] = Number(r.value) || 0;
  return { kind: RATE_KEYS[String(kind).toUpperCase()] ? String(kind).toUpperCase() : 'MONTHEND', loaded: m[k.loaded] || 0, bagged: m[k.bagged] || 0 };
}

// Payroll covers the WHOLE business — every staff member across ALL active
// tenants (e.g. Fido + Fiafia together), not just the runner's own tenant. The
// run is gated by role at the route (needCtx SNR_ACCOUNTANT+); the staff pool is
// company-wide. (A configurable tenant-group can replace this later if Daybook
// ever hosts unrelated businesses.)
// `ctx` (optional): when the request came from the Group roll-up, needCtx has
// already resolved exactly which tenants this user may run — prefer that over
// re-deriving it, so the saved run matches the scope that was previewed.
async function payrollGroup(_user, fallbackTenant, ctx) {
  if (ctx && ctx.group && Array.isArray(ctx.tenant_ids) && ctx.tenant_ids.length) return ctx.tenant_ids;
  // Fido Water + Fiafia Water are one payroll group — shared runs, merged payslips.
  const rows = await qall("SELECT id FROM tenants WHERE status='ACTIVE' AND slug IN ('fido','fiafia') ORDER BY name, id");
  const ids = rows.map((r) => r.id);
  return ids.length ? ids : (fallbackTenant ? [fallbackTenant] : []);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Payroll spans the whole business, so tenant-scoped helpers take EITHER a single
// tenant id or a list (Fido + Fiafia). Normalise once, here.
const tenantList = (t) => (Array.isArray(t) ? t : [t]).filter(Boolean);

// The tenants a request may read/write: every tenant in the Group roll-up, or
// just the one workspace. Use for reads and for ownership checks on rows that
// carry their own tenant_id — NOT to pick a tenant to write a NEW row into.
const ctxTenants = (c) => (c && c.group && Array.isArray(c.tenant_ids) && c.tenant_ids.length ? c.tenant_ids : [c.tenant_id]);
const inScope = (c, tid) => ctxTenants(c).includes(tid);
// SQL fragment + args for "tenant_id IN (…)" over the request's scope.
const scopeSql = (c, col = 'tenant_id') => {
  const ids = ctxTenants(c);
  return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, args: ids };
};
// Creating a row needs ONE tenant to own it. The Group roll-up is synthetic and
// has no such tenant, so anything that writes new tenant-owned rows must refuse
// rather than silently file Fiafia's data under Fido.
function rejectGroupWrite(c, res) {
  if (!c.group) return false;
  res.status(400).json({ error: 'switch to a single workspace (Fido or Fiafia) to do this' });
  return true;
}

// Fetch a pay run this request is entitled to: its own workspace normally, any
// workspace in the roll-up under Group. Without this the Group's Saved tab would
// list a run and then 404 when you opened it.
async function runFor(c, id) {
  const ids = ctxTenants(c);
  return qone(`SELECT * FROM pay_runs WHERE id=? AND tenant_id IN (${ids.map(() => '?').join(',')})`, [id, ...ids]);
}

// Working days in [from,to] inclusive — Mon–Sat (excludes Sundays). Used as the
// denominator for MONTHLY salary proration (the operation works Mon–Sat).
// Month-end payroll treats 27 Mon–Sat days in a 28→27 cycle as full monthly pay;
// Sundays are not working days and must not inflate the denominator or reduce pay.
function workingDays(from, to) {
  let d = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(to).slice(0, 10)}T00:00:00Z`);
  let n = 0;
  while (d <= end) { if (d.getUTCDay() !== 0) n += 1; d.setUTCDate(d.getUTCDate() + 1); }
  return Math.max(1, n);
}

function isSunday(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00Z`);
  return d.getUTCDay() === 0;
}

// Distinct clock-in dates that fall on Mon–Sat. Sunday attendance is ignored for
// salaried proration — the plant does not operate on Sundays.
function workingDaysPresent(dayset) {
  let n = 0;
  for (const dt of dayset) if (!isSunday(dt)) n += 1;
  return n;
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
  const sc = scopeSql(c, 'p.tenant_id');   // Group roll-up: history across workspaces
  const where = [sc.sql], args = [...sc.args];
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
//   Regular staff (MONTHLY): gross = monthly_salary × (Mon–Sat days present) / (Mon–Sat working days in period)
//   Sundays are excluded — 27 working days in a 28→27 cycle with full attendance = full pay.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Pay configuration (rates) — Snr Accountant+ ────────────────────────────────
router.get('/pay-config', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const sc = scopeSql(c);   // Group roll-up lists the roster of every workspace
  const where = [sc.sql, "status='ACTIVE'"], args = [...sc.args];
  if (req.query.site) { where.push('site_id=?'); args.push(req.query.site); }
  res.json(await qall(`SELECT id, full_name, role_title, site_id, pay_type, daily_rate, rate_loaded, rate_bagged
    FROM staff WHERE ${where.join(' AND ')} ORDER BY full_name`, args));
});
router.patch('/pay-config/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const st = await qone('SELECT * FROM staff WHERE id=?', [req.params.id]);
  // Safe under the Group roll-up: the staff row names its own tenant, so we check
  // membership of the scope rather than picking one.
  if (!st || !inScope(c, st.tenant_id)) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const pt = ['DAILY', 'PIECE', 'HOURLY', 'MONTHLY'].includes((b.pay_type || '').toUpperCase()) ? b.pay_type.toUpperCase() : st.pay_type;
  await qrun('UPDATE staff SET pay_type=?, daily_rate=?, rate_loaded=?, rate_bagged=? WHERE id=?',
    [pt, +b.daily_rate || 0, +b.rate_loaded || 0, +b.rate_bagged || 0, st.id]);
  res.json(await qone('SELECT id, full_name, pay_type, daily_rate, rate_loaded, rate_bagged FROM staff WHERE id=?', [st.id]));
});

// ── Shared per-bag rates (global) — Snr Accountant / GM / Admin only ───────────
router.get('/bag-rates', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  // Both pairs, so the settings screen can show the ₦6 full rate and the ₦1
  // mid-month incentive side by side.
  const [monthend, midmonth] = await Promise.all([getBagRates('MONTHEND'), getBagRates('MIDMONTH')]);
  res.json({ ...monthend, monthend, midmonth });
});
router.put('/bag-rates', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return; // SNR_ACCOUNTANT+ via default
  const b = req.body || {};
  const set = (k, v) => qrun(
    `INSERT INTO payroll_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
    [k, Math.max(0, +v || 0), nowS(), req.user.id]);
  if (b.rate_loaded != null) await set('rate_loaded', b.rate_loaded);
  if (b.rate_bagged != null) await set('rate_bagged', b.rate_bagged);
  if (b.rate_loaded_mid != null) await set('rate_loaded_mid', b.rate_loaded_mid);
  if (b.rate_bagged_mid != null) await set('rate_bagged_mid', b.rate_bagged_mid);
  const [monthend, midmonth] = await Promise.all([getBagRates('MONTHEND'), getBagRates('MIDMONTH')]);
  await audit(c.tenant_id, req.user.id, 'PAYROLL_BAG_RATES', 'payroll_settings', null, { monthend, midmonth });
  res.json({ ...monthend, monthend, midmonth });
});

// ── Daily production entry (bags loaded / bagged) — Supervisor (Site Manager+) ──
// Production is recorded PER WORK-SITE: a worker who bags/loads at more than one
// site in a day gets one row per site, credited to the site where the work was
// actually done. The entry screen is therefore scoped to a single site.
function recordingSite(c, req) {
  // Site-bound users always record for their own site; HQ/Admin pick one.
  return siteBound(c) ? c.site_id : (req.query.site || req.body?.site_id || null);
}
router.get('/production', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'SECRETARY'); if (!c) return;
  const date = (req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const siteId = recordingSite(c, req);
  // Per-site entry needs a site. HQ users without one selected get an empty list
  // (the UI prompts them to pick a site first).
  if (!siteId) return res.json([]);
  // Show the site's own roster PLUS any visitor who already has production logged
  // here today. Bags shown are this site's figures only.
  res.json(await qall(`SELECT s.id staff_id, s.full_name, s.role_title, s.pay_type, s.staff_type,
      s.site_id primary_site_id, ps.name primary_site_name,
      (s.site_id = ?) AS is_home,
      COALESCE(p.bags_loaded,0) bags_loaded, COALESCE(p.bags_bagged,0) bags_bagged
    FROM staff s
    LEFT JOIN sites ps ON ps.id = s.site_id
    LEFT JOIN production p ON p.staff_id = s.id AND p.work_date = ? AND p.site_id = ?
    WHERE s.tenant_id = ? AND s.status='ACTIVE' AND (s.site_id = ? OR p.id IS NOT NULL)
    ORDER BY (s.site_id = ?) DESC, s.full_name`,
    [siteId, date, siteId, c.tenant_id, siteId, siteId]));
});
// READ-ONLY production over a date range. The entry sheet above is one day at a
// time, which makes it impossible to answer "what did this site actually bag
// this period" without opening thirty pages. This answers that directly, and
// shows only people who recorded something — a roster of 178 with 6 workers is
// noise, not information.
//
// Group-aware: under the Group roll-up it spans every workspace in scope.
router.get('/production/summary', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'SECRETARY'); if (!c) return;
  const from = String(req.query.from || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const to = String(req.query.to || from).slice(0, 10);

  const sc = scopeSql(c, 'p.tenant_id');
  const where = [sc.sql, 'p.work_date BETWEEN ? AND ?',
    '(COALESCE(p.bags_bagged,0) > 0 OR COALESCE(p.bags_loaded,0) > 0)'];
  const args = [...sc.args, from, to];

  // Site-bound users see their own site; everyone else may filter to one.
  // NOTE: filters on where the work happened (p.site_id), not the worker's
  // home site — a visitor's bags belong to the site they were credited to.
  const siteId = siteBound(c) ? c.site_id : (req.query.site || null);
  if (siteId) { where.push('p.site_id = ?'); args.push(siteId); }

  const rows = await qall(`SELECT s.id staff_id, s.full_name,
      COALESCE(NULLIF(s.staff_type,''), '') staff_type,
      COALESCE(NULLIF(s.pay_type,''), '')   pay_type,
      si.id site_id, si.name site_name, t.name tenant_name,
      COUNT(*) days,
      COALESCE(SUM(p.bags_bagged),0) bags_bagged,
      COALESCE(SUM(p.bags_loaded),0) bags_loaded,
      MIN(p.work_date) first_day, MAX(p.work_date) last_day
    FROM production p
    JOIN staff s   ON s.id  = p.staff_id
    JOIN sites si  ON si.id = p.site_id
    JOIN tenants t ON t.id  = p.tenant_id
    WHERE ${where.join(' AND ')}
    GROUP BY s.id, s.full_name, s.staff_type, s.pay_type, si.id, si.name, t.name
    ORDER BY si.name, s.full_name`, args);

  const bySite = {};
  for (const r of rows) {
    const k = r.site_id;
    const g = bySite[k] || (bySite[k] = {
      site_id: r.site_id, site: r.site_name, tenant: r.tenant_name,
      staff: 0, bags_bagged: 0, bags_loaded: 0, rows: [],
    });
    g.staff += 1;
    g.bags_bagged = r2(g.bags_bagged + Number(r.bags_bagged));
    g.bags_loaded = r2(g.bags_loaded + Number(r.bags_loaded));
    g.rows.push({ ...r, bags_bagged: Number(r.bags_bagged), bags_loaded: Number(r.bags_loaded) });
  }
  const sites = Object.values(bySite).sort((a, b) => String(a.site).localeCompare(String(b.site)));
  const totals = sites.reduce((a, g) => ({
    staff: a.staff + g.staff,
    bags_bagged: r2(a.bags_bagged + g.bags_bagged),
    bags_loaded: r2(a.bags_loaded + g.bags_loaded),
  }), { staff: 0, bags_bagged: 0, bags_loaded: 0 });

  res.json({ from, to, sites, totals });
});

// Search active staff (any site) to pull a visiting worker into a site's sheet.
router.get('/production/staff-search', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'SECRETARY'); if (!c) return;
  const q = `%${(req.query.q || '').trim()}%`;
  res.json(await qall(`SELECT s.id staff_id, s.full_name, s.role_title, s.pay_type, s.staff_type,
      s.site_id primary_site_id, ps.name primary_site_name
    FROM staff s LEFT JOIN sites ps ON ps.id = s.site_id
    WHERE s.tenant_id = ? AND s.status='ACTIVE' AND s.full_name ILIKE ?
    ORDER BY s.full_name LIMIT 20`, [c.tenant_id, q]));
});
router.post('/production', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'SECRETARY'); if (!c) return;
  const b = req.body || {};
  const st = await qone('SELECT * FROM staff WHERE id=?', [b.staff_id]);
  if (!st || st.tenant_id !== c.tenant_id) return res.status(400).json({ error: 'invalid staff' });
  // Work-site: site-bound users record at their own site; HQ names the site.
  const siteId = siteBound(c) ? c.site_id : (b.site_id || null);
  if (!siteId) return res.status(400).json({ error: 'site_id (work location) required' });
  const site = await qone('SELECT id FROM sites WHERE id=? AND tenant_id=?', [siteId, c.tenant_id]);
  if (!site) return res.status(400).json({ error: 'invalid site' });
  const date = (b.work_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const loaded = +b.bags_loaded || 0, bagged = +b.bags_bagged || 0;

  // Only baggers and loaders do this work. Salaried and daily staff do not, so
  // bags against them are always a mis-keyed row — and because payroll pays on
  // production, a bad row here is a wrong payment later. Rejected at source
  // rather than caught at payroll time, where it is somebody's pay packet.
  //
  // The right fix when this fires is usually to correct the person's staff_type
  // (they really are a bagger) or to pick the right person, not to force the
  // entry through.
  if (loaded + bagged > 0 && !isPieceWorker(st)) {
    return res.status(400).json({
      error: `${st.full_name} is recorded as ${st.staff_type || st.pay_type || 'non-piece'} staff, `
           + 'so bagging and loading cannot be logged against them. '
           + 'Set them to BAGGER or LOADER first, or pick the right person.',
      code: 'NOT_A_PIECE_WORKER',
      staff_id: st.id, staff_type: st.staff_type || null, pay_type: st.pay_type || null,
    });
  }

  await qrun(`INSERT INTO production (id,tenant_id,site_id,staff_id,work_date,bags_loaded,bags_bagged,recorded_by,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT (tenant_id,staff_id,work_date,site_id) DO UPDATE SET
      bags_loaded=EXCLUDED.bags_loaded, bags_bagged=EXCLUDED.bags_bagged, recorded_by=EXCLUDED.recorded_by, updated_at=EXCLUDED.updated_at`,
    [uuid(), c.tenant_id, siteId, st.id, date, loaded, bagged, req.user.id, nowS()]);

  // A bagger/loader who bagged/loaded anything is counted present for the day.
  // Auto-create their attendance clock-in (without clobbering a real one); only
  // remove the auto record if they have NO production at ANY site that day.
  if (loaded + bagged > 0) {
    await qrun(`INSERT INTO attendance (id,tenant_id,site_id,staff_id,work_date,clock_in,source,captured_by)
      VALUES (?,?,?,?,?,?, 'PRODUCTION', ?) ON CONFLICT (tenant_id,staff_id,work_date) DO NOTHING`,
      [uuid(), c.tenant_id, siteId, st.id, date, nowS(), req.user.id]);
  } else {
    const anyProd = await qone(
      'SELECT 1 FROM production WHERE tenant_id=? AND staff_id=? AND work_date=? AND (bags_loaded>0 OR bags_bagged>0) LIMIT 1',
      [c.tenant_id, st.id, date]);
    if (!anyProd) {
      await qrun("DELETE FROM attendance WHERE tenant_id=? AND staff_id=? AND work_date=? AND source='PRODUCTION'",
        [c.tenant_id, st.id, date]);
    }
  }
  res.json({ ok: true });
});

// Shared: compute gross-pay lines for a period (+ outstanding advance per staff).
// `pieceOnly` drops monthly/daily (REGULAR) staff — used by the mid-month run,
// which pays per-bag commission only.
// Bags for a pay period: normally the sum of what the sites recorded in
// `production`, but the Snr Accountant's uploaded sheet stands in for it when a
// batch covers EXACTLY this window.
//
// Exact-match on the dates, not overlap. The two cycles overlap by design
// (16th→15th and 28th→27th), so an overlap test would let a mid-month sheet
// silently supply a month-end run's numbers at six times the rate.
//
// Returns { by: { staff_id: {l, g} }, override: batch|null, sourceIds:Set }.
// `sourceIds` is who came from the sheet, so a run can say so on the line.
async function bagsForPeriod(tenantIds, from, to, kind) {
  const ids = tenantList(tenantIds);
  const by = {}; const sourceIds = new Set();
  if (!ids.length) return { by, override: null, sourceIds };
  const ph = ids.map(() => '?').join(',');

  const batch = await overrideForPeriod(from, to, kind);

  if (batch) {
    // EXCLUSIVE, not a merge. When a sheet covers the period it IS the bag
    // payroll: production is not consulted at all, so nobody on it is paid twice
    // and nobody off it is paid a figure the accountant never signed.
    //
    // Business decision, 2026-07-21. The alternative — topping the sheet up with
    // whatever the sites recorded — made the July run ₦194,812 heavier than the
    // workbook, which is precisely the reconciliation the Snr Accountant cannot
    // do. Cost of this rule: a site that DOES record its production still gets
    // paid only what the sheet says, so an incomplete sheet underpays. That is
    // why the unmatched list is shown loudly at upload, and why this only
    // applies to periods somebody deliberately loaded a sheet for.
    //
    // Salaried staff are untouched: this function only supplies bags.
    const ovr = await qall(`SELECT staff_id, bags_loaded, bags_bagged FROM production_override
      WHERE batch_id=? AND tenant_id IN (${ph})`, [batch.id, ...ids]);
    for (const o of ovr) {
      by[o.staff_id] = { l: Number(o.bags_loaded) || 0, g: Number(o.bags_bagged) || 0 };
      sourceIds.add(o.staff_id);
    }
    return { by, override: batch, sourceIds };
  }

  const prod = await qall(`SELECT staff_id, COALESCE(SUM(bags_loaded),0) l, COALESCE(SUM(bags_bagged),0) g
    FROM production WHERE tenant_id IN (${ph}) AND work_date BETWEEN ? AND ? GROUP BY staff_id`, [...ids, from, to]);
  for (const p of prod) by[p.staff_id] = { l: Number(p.l), g: Number(p.g) };
  return { by, override: null, sourceIds };
}

// The batch covering a period, or null — for telling the UI that a run it is
// about to compute will use the accountant's sheet rather than the sites' own
// records. Nobody should approve a payroll without knowing which it was.
// `kind` is REQUIRED, not decorative. The two cycles overlap in dates AND a run's
// rate pair is chosen independently of its dates (the Run tab has a free date box
// and a separate mid-month checkbox), so matching on dates alone would let a
// MIDMONTH sheet's bags be paid at the ₦6 month-end rate — a silent 6x overpay.
async function overrideForPeriod(from, to, kind) {
  const k = String(kind || '').toUpperCase() === 'MIDMONTH' ? 'MIDMONTH' : 'MONTHEND';
  return qone(`SELECT * FROM production_override_batch WHERE period_from=? AND period_to=? AND kind=?
    ORDER BY created_at DESC, id DESC LIMIT 1`, [from, to, k]);
}

async function computeLines(tenant_id, from, to, site, rates, pieceOnly = false) {
  // Default follows the run kind: a piece-only run is a mid-month run.
  rates = rates || await getBagRates(pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  const sWhere = ['tenant_id=?', "status='ACTIVE'", "UPPER(COALESCE(full_name,'')) NOT LIKE '%HIRED%'",
    PAYROLL_ELIGIBLE], sArgs = [tenant_id];
  if (pieceOnly) sWhere.push(PIECE_WORKER);
  const staff = await qall(`SELECT id, full_name, role_title, site_id, pay_type, staff_type, daily_rate, rate_loaded, rate_bagged, bank_name, bank_account
    FROM staff WHERE ${sWhere.join(' AND ')} ORDER BY full_name`, sArgs);
  const att = await qall(`SELECT DISTINCT staff_id, work_date FROM attendance
    WHERE tenant_id=? AND clock_in IS NOT NULL AND work_date BETWEEN ? AND ?`, [tenant_id, from, to]);
  const daysByStaff = {};
  for (const a of att) (daysByStaff[a.staff_id] = daysByStaff[a.staff_id] || new Set()).add(a.work_date);
  const { by: prodBy, override, sourceIds } = await bagsForPeriod(tenant_id, from, to, pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  const siteStaff = await staffIdsForSite([tenant_id], site, from, to);
  // Per-site split behind each worker's total (where the bags were actually done).
  const bySite = await siteSplit(tenant_id, from, to, override);
  // Outstanding (unsettled) advances up to the period end.
  const adv = await qall(`SELECT staff_id, COALESCE(SUM(amount),0) a FROM staff_advances
    WHERE tenant_id=? AND run_id IS NULL AND adv_date<=? GROUP BY staff_id`, [tenant_id, to]);
  const advBy = {}; for (const a of adv) advBy[a.staff_id] = Number(a.a);
  // Calendar days in the pay period — denominator for monthly proration.
  const periodDays = workingDays(from, to); // Mon–Sat working days
  const siteNames = {};
  const homeSiteIds = [...new Set(staff.map((s) => s.site_id).filter(Boolean))];
  if (homeSiteIds.length) {
    const sph = homeSiteIds.map(() => '?').join(',');
    for (const r of await qall(`SELECT id, name FROM sites WHERE id IN (${sph})`, homeSiteIds)) siteNames[r.id] = r.name;
  }
  const lines = [];
  for (const g of personGroups(staff, sourceIds)) {
    const { head, members, memberIds, fromSheet, bagIds } = g;
    const payHead = pickPayrollHead(members) || head;
    if (siteStaff && !memberIds.some((id) => siteStaff.has(id))) continue;
    const homeMember = resolveHomeMember(members, daysByStaff, payHead);
    const primary = resolvePrimarySite(members, siteNames, homeMember);
    const dayset = new Set();
    let l = 0, bagged = 0, advance = 0;
    for (const id of memberIds) {
      for (const d of (daysByStaff[id] || [])) dayset.add(d);
      advance += advBy[id] || 0;
    }
    for (const id of bagIds) { const pb = prodBy[id]; if (pb) { l += pb.l; bagged += pb.g; } }
    const pt = (payHead.pay_type || '').toUpperCase();
    const days = pt === 'PIECE' ? dayset.size : workingDaysPresent(dayset);
    let gross;
    if (pt === 'PIECE') gross = l * rates.loaded + bagged * rates.bagged;
    else if (pt === 'MONTHLY') gross = (payHead.daily_rate || 0) * (days / periodDays);
    else gross = days * (payHead.daily_rate || 0);
    lines.push({
      staff_id: payHead.id, full_name: payHead.full_name, role_title: payHead.role_title, pay_type: payHead.pay_type,
      days_present: days, period_days: periodDays, bags_loaded: l, bags_bagged: bagged, gross: Math.round(gross * 100) / 100,
      by_site: memberIds.flatMap((id) => bySite[id] || []),
      primary_site_id: primary.id, primary_site_name: primary.name,
      bags_source: fromSheet ? 'SHEET' : 'PRODUCTION',
      member_ids: memberIds,
      advance: Math.round(advance * 100) / 100,
    });
  }
  lines.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
  return lines;
  // Returns ALL active staff (incl. zero) so the UI can show paid staff up top
  // and cull the rest into a review section. Save (runs2) skips zero lines.
}

// Per-worker, per-site production split for a period. Returns
// { [staff_id]: [{ site_id, site_name, loaded, bagged }, ...] }, only sites with
// nonzero bags, ordered by name. Used to show the breakdown behind each total.
//
// When an override batch supplies the bags, the split comes from the batch
// instead: the sheet gives one LOCATION per person, so their whole total sits at
// that one site. Mixing the two would show a per-site breakdown that does not
// add up to the total being paid, which is worse than a coarse one.
async function siteSplit(tenant_id, from, to, override = null) {
  const ids = tenantList(tenant_id);
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');


  if (override) {
    const ovr = await qall(`SELECT o.staff_id, o.site_id, COALESCE(si.name,'—') site_name,
        o.bags_loaded loaded, o.bags_bagged bagged
      FROM production_override o LEFT JOIN sites si ON si.id = o.site_id
      WHERE o.batch_id=? AND o.tenant_id IN (${ph})
        AND (o.bags_loaded > 0 OR o.bags_bagged > 0)`, [override.id, ...ids]);
    const byO = {};
    for (const r of ovr) {
      byO[r.staff_id] = [{
        site_id: r.site_id, site_name: r.site_name,
        loaded: Number(r.loaded), bagged: Number(r.bagged), source: 'SHEET',
      }];
    }
    return byO;
  }

  const rows = await qall(`SELECT p.staff_id, p.site_id, COALESCE(si.name,'—') site_name,
      COALESCE(SUM(p.bags_loaded),0) loaded, COALESCE(SUM(p.bags_bagged),0) bagged
    FROM production p LEFT JOIN sites si ON si.id = p.site_id
    WHERE p.tenant_id IN (${ph}) AND p.work_date BETWEEN ? AND ?
    GROUP BY p.staff_id, p.site_id, si.name
    HAVING COALESCE(SUM(p.bags_loaded),0) > 0 OR COALESCE(SUM(p.bags_bagged),0) > 0
    ORDER BY si.name`, [...ids, from, to]);
  const by = {};
  for (const r of rows) {
    (by[r.staff_id] = by[r.staff_id] || []).push({
      site_id: r.site_id, site_name: r.site_name, loaded: Number(r.loaded), bagged: Number(r.bagged),
    });
  }

  // REPLACE (not merge) the split for anyone the sheet covers, mirroring what
  // bagsForPeriod did to their totals. If their production split survived here,
  // the breakdown would not add up to the figure being paid.
  if (override) {
    const ovr = await qall(`SELECT o.staff_id, o.site_id, COALESCE(si.name,'—') site_name,
        o.bags_loaded loaded, o.bags_bagged bagged
      FROM production_override o LEFT JOIN sites si ON si.id = o.site_id
      WHERE o.batch_id=? AND o.tenant_id IN (${ph})`, [override.id, ...ids]);
    for (const r of ovr) {
      const loaded = Number(r.loaded) || 0, bagged = Number(r.bagged) || 0;
      by[r.staff_id] = (loaded > 0 || bagged > 0)
        ? [{ site_id: r.site_id, site_name: r.site_name, loaded, bagged, source: 'SHEET' }]
        : [];
    }
  }
  return by;
}

// Combined payroll across MULTIPLE tenants (e.g. Fido + Fiafia), merging the same
// person into one payslip. Identity = normalized name + bank account (name-only
// when no account on file). Piece pay uses the shared per-bag rates; monthly pay
// is prorated by DISTINCT days clocked-in across all the person's tenants.
async function computeCombinedLines(tenantIds, from, to, rates, pieceOnly = false, site = null) {
  rates = rates || await getBagRates(pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  if (!tenantIds.length) return [];
  const ph = tenantIds.map(() => '?').join(',');
  const staff = await qall(`SELECT id, tenant_id, full_name, role_title, site_id, pay_type, daily_rate, bank_name, bank_account, staff_type
    FROM staff WHERE tenant_id IN (${ph}) AND status='ACTIVE'
      AND UPPER(COALESCE(full_name,'')) NOT LIKE '%HIRED%'
      AND ${PAYROLL_ELIGIBLE}
      ${pieceOnly ? `AND ${PIECE_WORKER}` : ''}`, tenantIds);
  const att = await qall(`SELECT DISTINCT staff_id, work_date FROM attendance
    WHERE tenant_id IN (${ph}) AND clock_in IS NOT NULL AND work_date BETWEEN ? AND ?`, [...tenantIds, from, to]);
  const daysByStaff = {};
  for (const a of att) (daysByStaff[a.staff_id] = daysByStaff[a.staff_id] || new Set()).add(a.work_date);
  const { by: prodBy, override, sourceIds } = await bagsForPeriod(tenantIds, from, to, pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  const bySite = await siteSplit(tenantIds, from, to, override);
  const siteStaff = await staffIdsForSite(tenantIds, site, from, to);
  const adv = await qall(`SELECT staff_id, COALESCE(SUM(amount),0) a FROM staff_advances
    WHERE tenant_id IN (${ph}) AND run_id IS NULL AND adv_date<=? GROUP BY staff_id`, [...tenantIds, to]);
  const advBy = {}; for (const a of adv) advBy[a.staff_id] = Number(a.a);
  const periodDays = workingDays(from, to); // Mon–Sat working days
  const siteNames = {};
  const homeSiteIds = [...new Set(staff.map((s) => s.site_id).filter(Boolean))];
  if (homeSiteIds.length) {
    const sph = homeSiteIds.map(() => '?').join(',');
    for (const r of await qall(`SELECT id, name FROM sites WHERE id IN (${sph})`, homeSiteIds)) siteNames[r.id] = r.name;
  }

  // Identity = token-sorted name, or the same ≥9-digit account (see staffIdentity.js).
  const lines = [];
  for (const grp of personGroups(staff, sourceIds)) {
    const { members, memberIds, fromSheet, bagIds } = grp;
    const head = pickPayrollHead(members) || grp.head;
    if (siteStaff && !memberIds.some((id) => siteStaff.has(id))) continue;
    const dayset = new Set();
    let l = 0, bags = 0, advance = 0;
    for (const id of memberIds) {
      for (const d of (daysByStaff[id] || [])) dayset.add(d);
      advance += advBy[id] || 0;
    }
    for (const id of bagIds) { const pb = prodBy[id]; if (pb) { l += pb.l; bags += pb.g; } }
    const pt = (head.pay_type || '').toUpperCase();
    const days = pt === 'PIECE' ? dayset.size : workingDaysPresent(dayset);
    let gross;
    if (pt === 'PIECE') gross = l * rates.loaded + bags * rates.bagged;
    else if (pt === 'MONTHLY') gross = (head.daily_rate || 0) * (days / periodDays);
    else gross = days * (head.daily_rate || 0);
    const siteRows = memberIds.flatMap((id) => bySite[id] || []);
    const displayMember = resolveHomeMember(members, daysByStaff, head);
    const primary = resolvePrimarySite(members, siteNames, displayMember);
    lines.push({
      staff_id: head.id, member_ids: memberIds, full_name: head.full_name, role_title: head.role_title,
      pay_type: head.pay_type, days_present: days, period_days: periodDays,
      bags_loaded: l, bags_bagged: bags, gross: round2(gross), advance: round2(advance),
      by_site: siteRows.length ? siteRows : (displayMember.site_id ? [{ site_id: displayMember.site_id, site_name: siteNames[displayMember.site_id] || '—', loaded: 0, bagged: 0 }] : []),
      primary_site_id: primary.id, primary_site_name: primary.name,
      home_site_id: primary.id || displayMember.site_id || null,
      bags_source: fromSheet ? 'SHEET' : 'PRODUCTION',
      tenants: Array.from(new Set(members.map((m) => m.tenant_id))),
      merged: members.length > 1,
    });
  }
  lines.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
  return lines;
}

// ── Compute a payroll for a period (preview, not saved) — Snr Accountant+ ───────
// `combined:true` runs across all the user's SNR+ tenants (Fido + Fiafia merged).
router.post('/compute2', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { from, to, site, combined } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  // Mid-month pays per-bag commission only — REGULAR (monthly-salary) staff have
  // nothing to earn in it and must not appear. They are paid at month-end.
  const pieceOnly = (req.body || {}).piece_only === true;
  // Rate pair must match the run: mid-month = ₦1 incentive, month-end = ₦6 full.
  const rates = await getBagRates(pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  if (combined) {
    const group = await payrollGroup(req.user, c.tenant_id, c);
    const siteId = siteBound(c) ? c.site_id : (site || null);
    const lines = await computeCombinedLines(group, from, to, rates, pieceOnly, siteId);
    const runKind = payrollKindFromPieceOnly(pieceOnly);
    const sheetUpload = await activeSheetUpload(ctxTenants(c), from, to, runKind);
    return res.json({ from, to, combined: true, piece_only: pieceOnly, site: siteId, tenants: group, rates, lines, override: await overrideForPeriod(from, to, pieceOnly ? 'MIDMONTH' : 'MONTHEND'), sheet_upload: sheetUpload, total: round2(lines.reduce((a, l) => a + l.gross, 0)) });
  }
  const lines = await computeLines(c.tenant_id, from, to, site || null, rates, pieceOnly);
  const runKind = payrollKindFromPieceOnly(pieceOnly);
  const sheetUpload = await activeSheetUpload(ctxTenants(c), from, to, runKind);
  res.json({ from, to, piece_only: pieceOnly, rates, lines, override: await overrideForPeriod(from, to, pieceOnly ? 'MIDMONTH' : 'MONTHEND'), sheet_upload: sheetUpload, total: round2(lines.reduce((a, l) => a + l.gross, 0)) });
});

// ── Excel template download (Fido-shaped: REGULAR / BAGGERS / LOADERS) ─────────
// Pre-filled from the computed payroll so the accountant edits deductions / qty
// and re-uploads. Adds a DEDUCTION + REMARKS column to each sheet.
router.get('/template.xlsx', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).end();
  const combined = req.query.combined === '1' || req.query.combined === 'true';
  // Mid-month: piece workers only, so the REGULAR sheet is omitted entirely.
  const pieceOnly = req.query.piece_only === '1' || req.query.piece_only === 'true';
  const rates = await getBagRates(pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  const siteId = siteBound(c) ? c.site_id : (req.query.site || null);
  const lines = combined
    ? await computeCombinedLines(await payrollGroup(req.user, c.tenant_id, c), from, to, rates, pieceOnly, siteId)
    : await computeLines(c.tenant_id, from, to, siteId, rates, pieceOnly);
  const ids = lines.map((l) => l.staff_id).filter(Boolean);
  const sBy = {};
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const staff = await qall(`SELECT s.id, s.ext_people_id, s.full_name, s.role_title, s.staff_type,
        s.bank_name, s.bank_account, si.name site_name
      FROM staff s LEFT JOIN sites si ON si.id=s.site_id WHERE s.id IN (${ph})`, ids);
    for (const s of staff) sBy[s.id] = s;
  }
  const reg = [], bag = [], load = [];
  for (const l of lines) {
    const s = sBy[l.staff_id] || {};
    const nm = splitName(l.full_name);
    const acct = accountDigits(s.bank_account);
    const pt = (l.pay_type || '').toUpperCase();
    // Sheet bucketing must agree with the PIECE_WORKER filter: staff_type is
    // authoritative, pay_type is the fallback. Testing pay_type alone dropped
    // baggers/loaders whose pay_type was never set into the REGULAR sheet.
    const isPiece = pt === 'PIECE' || s.staff_type === 'BAGGER' || s.staff_type === 'LOADER';
    const isLoader = s.staff_type === 'LOADER'
      || (isPiece && s.staff_type !== 'BAGGER' && Number(l.bags_loaded) > Number(l.bags_bagged));
    if (isPiece && !isLoader) {
      bag.push({ 'S/N': bag.length + 1, ID: s.ext_people_id || '', 'FIRST NAME': nm.first, 'MIDDLE NAME': nm.middle, 'LAST NAME': nm.last, LOCATION: s.site_name || '', QTY: l.bags_bagged, 'ACCOUNT NUMBER': acct, DEDUCTION: l.advance || 0, REMARKS: '', COMMISSION: l.gross });
    } else if (isPiece) {
      load.push({ 'S/N': load.length + 1, ID: s.ext_people_id || '', 'FIRST NAME': nm.first, 'MIDDLE NAME': nm.middle, 'LAST NAME': nm.last, LOCATION: s.site_name || '', 'ACCOUNT NUMBER': acct, 'BAGS LOADED': l.bags_loaded, DEDUCTION: l.advance || 0, REMARKS: '', 'NET PAY (COMMISSION)': l.gross });
    } else {
      reg.push({ 'S/N': reg.length + 1, ID: s.ext_people_id || '', 'FIRST NAME': nm.first, 'MIDDLE NAME': nm.middle, 'LAST NAME': nm.last, DESIGNATION: s.role_title || '', LOCATION: s.site_name || '', 'ACCOUNT NUMBER': acct, 'DAYS WORKED': l.days_present, 'BASE SALARY': '', DEDUCTION: l.advance || 0, REMARKS: '', 'NET SALARY': l.gross });
    }
  }
  const wb = XLSX.utils.book_new();
  // Mid-month has no REGULAR sheet at all — matches MID-MONTH PAYROLL <MONTH>.xls,
  // which ships BAGGERS + LOADERS only.
  if (!pieceOnly) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reg, { header: ['S/N', 'ID', 'FIRST NAME', 'MIDDLE NAME', 'LAST NAME', 'DESIGNATION', 'LOCATION', 'ACCOUNT NUMBER', 'DAYS WORKED', 'BASE SALARY', 'DEDUCTION', 'REMARKS', 'NET SALARY'] }), 'REGULAR');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bag, { header: ['S/N', 'ID', 'FIRST NAME', 'MIDDLE NAME', 'LAST NAME', 'LOCATION', 'QTY', 'ACCOUNT NUMBER', 'DEDUCTION', 'REMARKS', 'COMMISSION'] }), 'BAGGERS');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(load, { header: ['S/N', 'ID', 'FIRST NAME', 'MIDDLE NAME', 'LAST NAME', 'LOCATION', 'ACCOUNT NUMBER', 'BAGS LOADED', 'DEDUCTION', 'REMARKS', 'NET PAY (COMMISSION)'] }), 'LOADERS');
  const buf = XLSX.write(forceAccountTextSheets(wb, ['ACCOUNT NUMBER']), { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${pieceOnly ? 'midmonth-payroll' : 'payroll'}-${from}_${to}.xlsx"`);
  res.send(buf);
});

// ── Staff onboarding template (blank roster sheets) ────────────────────────────
router.get('/staff-template.xlsx', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const wb = XLSX.utils.book_new();
  const reg = ['ID', 'FIRST NAME', 'MIDDLE NAME', 'LAST NAME', 'DESIGNATION', 'LOCATION', 'ACCOUNT NUMBER', 'BASE SALARY'];
  const pieceCols = ['ID', 'FIRST NAME', 'MIDDLE NAME', 'LAST NAME', 'LOCATION', 'ACCOUNT NUMBER'];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([], { header: reg }), 'REGULAR');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([], { header: pieceCols }), 'BAGGERS');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([], { header: pieceCols }), 'LOADERS');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="staff-template.xlsx"');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

// ── Import / onboard the staff roster from a workbook (into THIS workspace) ─────
// Upserts staff by ID (= ext_people_id). REGULAR → MONTHLY (BASE SALARY → salary),
// BAGGERS/LOADERS → PIECE. LOCATION is matched to an existing site by name.
router.post('/staff-import', requireAuth, xlsUpload.single('file'), async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  // Import CREATES staff and resolves LOCATION against one tenant's sites, so it
  // needs a real workspace to own the rows — under Group it would file every
  // imported person under the anchor tenant.
  if (rejectGroupWrite(c, res)) return;
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer' }); } catch { return res.status(400).json({ error: 'unreadable spreadsheet' }); }

  const sites = await qall('SELECT id, name FROM sites WHERE tenant_id=?', [c.tenant_id]);
  const siteByName = {}; for (const s of sites) siteByName[String(s.name).trim().toLowerCase()] = s.id;
  const norm = (k) => String(k || '').trim().toUpperCase();
  const num = (v) => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[, ]/g, '')); return isNaN(n) ? null : n; };
  let created = 0, updated = 0; const noSite = new Set(); const skippedNoSite = [];

  const upsert = async (row, staffType) => {
    const get = (names) => { for (const k of Object.keys(row)) if (names.includes(norm(k))) return row[k]; return undefined; };
    const id = String(get(['ID', 'STAFF ID', 'EXT ID']) ?? '').replace(/\.0$/, '').trim();
    const first = String(get(['FIRST NAME']) ?? '').trim();
    const middle = String(get(['MIDDLE NAME']) ?? '').trim();
    const last = String(get(['LAST NAME']) ?? '').trim();
    const full = [first, middle, last].filter(Boolean).join(' ').trim();
    if (!id && !full) return; // empty row
    if (/HIRED/i.test(full)) return; // "HIRED BAGGER/LOADER" placeholders are not real staff
    const acctRaw = String(get(['ACCOUNT NUMBER', 'ACCOUNT']) ?? '').trim();
    const parsed = parseBankFields(acctRaw, null);
    const loc = String(get(['LOCATION']) ?? '').trim().toLowerCase();
    const siteId = siteByName[loc] || null;
    if (loc && !siteId) noSite.add(loc);
    const designation = String(get(['DESIGNATION']) ?? '').trim() || staffType;
    const payType = staffType === 'REGULAR' ? 'MONTHLY' : 'PIECE';
    const baseSalary = staffType === 'REGULAR' ? (num(get(['BASE SALARY', 'SALARY', 'MONTHLY SALARY'])) || 0) : 0;

    // Match an existing staff by ext id (preferred) or by token-sorted name
    // ("CHINEYE OKARA" = "OKARA CHINEYE", case/spacing ignored).
    let existing = id ? await qone('SELECT id FROM staff WHERE tenant_id=? AND ext_people_id=?', [c.tenant_id, id]) : null;
    if (!existing && full) {
      existing = await qone(
        `SELECT id FROM staff WHERE tenant_id=? AND ${STAFF_NAME_KEY_SQL} = ?`,
        [c.tenant_id, nameKey(full)]);
    }
    const bankName = parsed.bank_name;
    const bankAcct = parsed.bank_account;
    if (existing) {
      await qrun(`UPDATE staff SET full_name=?, role_title=?, staff_type=?, pay_type=?, bank_name=COALESCE(?,bank_name), bank_account=COALESCE(?,bank_account),
        ${baseSalary > 0 ? 'daily_rate=?,' : ''} ext_people_id=COALESCE(?,ext_people_id), site_id=COALESCE(?,site_id), status='ACTIVE' WHERE id=?`,
        baseSalary > 0
          ? [full, designation, staffType, payType, bankName, bankAcct, baseSalary, id || null, siteId, existing.id]
          : [full, designation, staffType, payType, bankName, bankAcct, id || null, siteId, existing.id]);
      updated += 1;
    } else {
      // Never CREATE a staff member without a site — an unsited worker can't be
      // grouped, reported per-site, or reconciled. (An existing staff keeps their
      // site via COALESCE above; only brand-new rows are gated.) Skip and report
      // so the accountant fixes the LOCATION cell and re-imports.
      if (!siteId) { skippedNoSite.push(full || id); return; }
      await qrun(`INSERT INTO staff (id,tenant_id,site_id,full_name,role_title,staff_type,pay_type,daily_rate,bank_name,bank_account,ext_people_id,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE')`,
        [uuid(), c.tenant_id, siteId, full, designation, staffType, payType, baseSalary, bankName, bankAcct, id || null]);
      created += 1;
    }
  };

  for (const [kind, staffType] of [['REGULAR', 'REGULAR'], ['BAGGERS', 'BAGGER'], ['LOADERS', 'LOADER']]) {
    const name = Object.keys(wb.Sheets).find((n) => norm(n) === kind);
    if (!name) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
    for (const r of rows) await upsert(r, staffType);
  }
  res.json({ created, updated, sites_unmatched: Array.from(noSite), skipped_no_site: skippedNoSite });
});

// ── Per-staff payroll breakdown (drill-down) — Snr Accountant+ ─────────────────
// ids = comma-separated staff ids (a single staff, or all merged member ids for a
// combined line). Returns the day-by-day attendance + production behind the totals.
router.get('/staff-detail', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { from, to } = req.query;
  if (!ids.length || !from || !to) return res.json({ days: [], production: [] });
  const ph = ids.map(() => '?').join(',');
  const days = await qall(`SELECT a.work_date, COALESCE(si.name,'—') site_name
    FROM attendance a LEFT JOIN sites si ON si.id=a.site_id
    WHERE a.staff_id IN (${ph}) AND a.clock_in IS NOT NULL AND a.work_date BETWEEN ? AND ?
    ORDER BY a.work_date`, [...ids, from, to]);
  const production = await qall(`SELECT p.work_date, COALESCE(si.name,'—') site_name,
      COALESCE(p.bags_loaded,0) bags_loaded, COALESCE(p.bags_bagged,0) bags_bagged
    FROM production p LEFT JOIN sites si ON si.id=p.site_id
    WHERE p.staff_id IN (${ph}) AND p.work_date BETWEEN ? AND ?
      AND (p.bags_loaded>0 OR p.bags_bagged>0)
    ORDER BY p.work_date`, [...ids, from, to]);
  // Primary (home) site = the staff's own site_id; other sites are derived
  // client-side from the days/production rows above.
  const ps = await qall(`SELECT si.name FROM staff s LEFT JOIN sites si ON si.id=s.site_id WHERE s.id IN (${ph})`, ids);
  const primary_site = (ps.find((r) => r.name) || {}).name || null;

  // If the accountant's sheet supplied this person's bags, the day-by-day list
  // above is empty (or, worse, shows a different, ignored figure) while their pay
  // line reads several thousand bags. Say where the number came from rather than
  // letting the drill-down look like a bug — or like a missing payment.
  // No run kind on this request, so show whichever batch covers the window —
  // this is an explanatory panel, not a payment path.
  const batch = (await overrideForPeriod(from, to, 'MIDMONTH')) || (await overrideForPeriod(from, to, 'MONTHEND'));
  let override = null;
  if (batch) {
    const rows = await qall(`SELECT o.bags_loaded, o.bags_bagged, COALESCE(si.name,'—') site_name
      FROM production_override o LEFT JOIN sites si ON si.id=o.site_id
      WHERE o.batch_id=? AND o.staff_id IN (${ph})`, [batch.id, ...ids]);
    if (rows.length) {
      override = {
        period_from: batch.period_from, period_to: batch.period_to,
        file_name: batch.file_name, site_name: rows[0].site_name,
        bags_loaded: rows.reduce((a, r) => a + (Number(r.bags_loaded) || 0), 0),
        bags_bagged: rows.reduce((a, r) => a + (Number(r.bags_bagged) || 0), 0),
      };
    }
  }
  res.json({ primary_site, days, production, override });
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
  const combined = !!b.combined;
  // Must mirror the compute2 call the accountant previewed, or the saved draft
  // would quietly differ from what they approved on screen.
  const pieceOnly = b.piece_only === true;
  const rates = await getBagRates(pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  const siteId = siteBound(c) ? c.site_id : (site || null);
  const lines = combined
    ? await computeCombinedLines(await payrollGroup(req.user, c.tenant_id, c), from, to, rates, pieceOnly, siteId)
    : await computeLines(c.tenant_id, from, to, siteId, rates, pieceOnly);
  const runId = uuid();
  // Which override batch (if any) fed this run. Recorded ON THE RUN because the
  // batch can later be removed, and an approved payroll whose numbers cannot be
  // explained afterwards is worse than one that was never saved.
  const usedOverride = await overrideForPeriod(from, to, pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  let tg = 0, td = 0, tn = 0;
  await withTransaction(async () => {
    // Persist WHICH run this is. Without it the draft looks REGULAR, and any later
    // line edit or Excel re-import would recompute a ₦1 mid-month run at the ₦6
    // full rate — a silent 6x overpay.
    await qrun(`INSERT INTO pay_runs (id,tenant_id,site_id,period_from,period_to,status,kind,override_batch_id,pay_source,created_by) VALUES (?,?,?,?,?, 'DRAFT', ?,?, 'COMPUTED',?)`,
      [runId, c.tenant_id, siteId || null, from, to, pieceOnly ? 'MIDMONTH' : 'REGULAR',
        usedOverride ? usedOverride.id : null, req.user.id]);
    for (const l of lines) {
      if (l.gross <= 0) continue; // never save a zero payslip line
      const d = Math.min(l.gross, Math.max(0, ded[l.staff_id] != null ? +ded[l.staff_id] : l.advance));
      const net = Math.round((l.gross - d) * 100) / 100;
      tg += l.gross; td += d; tn += net;
      // rec_* = the daily-recorded snapshot at compute time; later edits/uploads
      // are compared against it to flag discrepancies in `remarks`.
      await qrun(`INSERT INTO pay_run_lines (id,run_id,tenant_id,staff_id,staff_name,pay_type,days_present,bags_loaded,bags_bagged,gross,deductions,net,rec_days,rec_loaded,rec_bagged,bags_source,primary_site_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), runId, c.tenant_id, l.staff_id, l.full_name, l.pay_type, l.days_present, l.bags_loaded, l.bags_bagged, l.gross, d, net, l.days_present, l.bags_loaded, l.bags_bagged, l.bags_source || 'PRODUCTION', l.primary_site_name || null]);
      // Settle outstanding advances up to the period end. Combined runs settle
      // across ALL of the person's merged staff ids (both tenants) by staff_id;
      // single-tenant runs scope by tenant_id as before.
      if (d > 0) {
        if (combined && Array.isArray(l.member_ids) && l.member_ids.length) {
          const ph = l.member_ids.map(() => '?').join(',');
          await qrun(`UPDATE staff_advances SET run_id=? WHERE staff_id IN (${ph}) AND run_id IS NULL AND adv_date<=?`, [runId, ...l.member_ids, to]);
        } else {
          await qrun('UPDATE staff_advances SET run_id=? WHERE tenant_id=? AND staff_id=? AND run_id IS NULL AND adv_date<=?', [runId, c.tenant_id, l.staff_id, to]);
        }
      }
    }
    await qrun('UPDATE pay_runs SET total_gross=?, total_deductions=?, total_net=? WHERE id=?',
      [Math.round(tg * 100) / 100, Math.round(td * 100) / 100, Math.round(tn * 100) / 100, runId]);
  });
  res.status(201).json({ id: runId });
});

// Matched vs unmatched totals for a stored month-end sheet. Generate-from-sheet
// (and therefore the bank portal file) only pays linked rows. After sheet upload,
// unmatched rows are auto-created as staff when possible; remaining unmatched_net
// is usually ambiguous IDs/names or rows without identity.
function summarizeSheetLines(lines) {
  const all = lines || [];
  const matchedRows = all.filter((l) => l.staff_id);
  const unmatchedRows = all.filter((l) => !l.staff_id && ((Number(l.net) || 0) > 0 || (Number(l.gross) || 0) > 0));
  return {
    line_count: all.length,
    matched_count: matchedRows.length,
    unmatched_count: unmatchedRows.length,
    uploaded_net: round2(all.reduce((a, l) => a + (Number(l.net) || 0), 0)),
    matched_net: round2(matchedRows.reduce((a, l) => a + (Number(l.net) || 0), 0)),
    unmatched_net: round2(unmatchedRows.reduce((a, l) => a + (Number(l.net) || 0), 0)),
    unmatched: unmatchedRows.slice(0, 80).map((l) => ({
      name: l.name || l.full_name || '—',
      ext_people_id: l.ext_people_id || null,
      net: round2(l.net || 0),
      sheet_kind: l.sheet_kind || null,
      sheet_row: l.sheet_row || null,
    })),
  };
}

// Build pay_run_lines from stored sheet upload rows — figures taken as-is from the
// accountant's workbook, not recomputed from attendance or production.
async function linesFromSheetUpload(upload, sheetLines, tenantId) {
  const staffIds = sheetLines.map((l) => l.staff_id).filter(Boolean);
  const staffById = {};
  if (staffIds.length) {
    const ph = staffIds.map(() => '?').join(',');
    for (const s of await qall(`SELECT s.id, s.full_name, s.pay_type, s.staff_type, s.site_id, st.name site_name
      FROM staff s LEFT JOIN sites st ON st.id=s.site_id WHERE s.id IN (${ph})`, staffIds)) {
      staffById[s.id] = s;
    }
  }
  const periodDays = workingDays(upload.period_from, upload.period_to);
  const lines = [];
  for (const sl of sheetLines) {
    if (!sl.staff_id) continue;
    const st = staffById[sl.staff_id];
    if (!st) continue;
    const gross = r2(sl.gross || 0);
    const ded = r2(sl.deduction || 0);
    const net = r2(sl.net != null && sl.net > 0 ? sl.net : Math.max(0, gross - ded));
    const hasPay = net > 0 || gross > 0 || (sl.days || 0) > 0 || (sl.loaded || 0) > 0 || (sl.bagged || 0) > 0;
    if (!hasPay) continue;
    const kind = String(sl.sheet_kind || '').toUpperCase();
    let payType = (st.pay_type || '').toUpperCase();
    if (kind === 'REGULAR') payType = 'MONTHLY';
    else if (kind === 'BAGGERS' || kind === 'LOADERS') payType = 'PIECE';
    lines.push({
      staff_id: st.id,
      tenant_id: sl.tenant_id || st.tenant_id || tenantId,
      full_name: st.full_name || sl.name,
      pay_type: payType,
      days_present: sl.days || 0,
      period_days: periodDays,
      bags_loaded: sl.loaded || 0,
      bags_bagged: sl.bagged || 0,
      gross,
      deduction: ded,
      net,
      bags_source: 'SHEET',
      primary_site_name: st.site_name || null,
      sheet_kind: kind,
    });
  }
  lines.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
  return lines;
}

// Create a DRAFT payroll run from an uploaded month-end sheet (authoritative figures).
router.post('/runs2/from-sheet', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const b = req.body || {};
  const { from, to, upload_id: uploadIdIn, site } = b;
  const siteId = siteBound(c) ? c.site_id : (site || null);

  let upload = null;
  if (uploadIdIn) {
    upload = await sheetUploadFor(c, uploadIdIn);
    if (!upload || !upload.is_active) return res.status(404).json({ error: 'sheet upload not found' });
  } else {
    if (!from || !to) return res.status(400).json({ error: 'from and to required (or upload_id)' });
    upload = await activeSheetUpload(ctxTenants(c), from, to, SHEET_KIND_REGULAR);
    if (!upload) return res.status(404).json({ error: 'no active sheet upload for this period — upload the month-end workbook first' });
  }

  if (upload.kind === SHEET_KIND_MIDMONTH) {
    return res.status(400).json({ error: 'this endpoint is for month-end (REGULAR) sheets only — use Compute for mid-month' });
  }

  const sheetLines = await qall('SELECT * FROM payroll_sheet_lines WHERE upload_id=? ORDER BY name', [upload.id]);
  const runLines = await linesFromSheetUpload(upload, sheetLines, c.tenant_id);
  if (!runLines.length) {
    return res.status(400).json({ error: 'no matched staff with pay on that sheet — check IDs and re-upload' });
  }

  const summary = summarizeSheetLines(sheetLines);
  const runId = uuid();
  let tg = 0; let td = 0; let tn = 0;
  await withTransaction(async () => {
    await qrun(`INSERT INTO pay_runs (id,tenant_id,site_id,period_from,period_to,status,kind,pay_source,sheet_upload_id,created_by)
      VALUES (?,?,?,?,?, 'DRAFT', 'REGULAR', 'SHEET', ?,?)`,
    [runId, c.tenant_id, siteId || null, upload.period_from, upload.period_to, upload.id, req.user.id]);
    for (const l of runLines) {
      tg += l.gross; td += l.deduction; tn += l.net;
      await qrun(`INSERT INTO pay_run_lines (id,run_id,tenant_id,staff_id,staff_name,pay_type,days_present,bags_loaded,bags_bagged,gross,deductions,net,rec_days,rec_loaded,rec_bagged,bags_source,primary_site_name,remarks)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), runId, l.tenant_id || c.tenant_id, l.staff_id, l.full_name, l.pay_type,
        l.days_present, l.bags_loaded, l.bags_bagged, l.gross, l.deduction, l.net,
        l.days_present, l.bags_loaded, l.bags_bagged, 'SHEET', l.primary_site_name,
        'From accountant sheet']);
    }
    await qrun('UPDATE pay_runs SET total_gross=?, total_deductions=?, total_net=? WHERE id=?',
      [r2(tg), r2(td), r2(tn), runId]);
  });

  await audit(c.tenant_id, req.user.id, 'PAYROLL_RUN_FROM_SHEET', 'pay_runs', runId,
    { upload_id: upload.id, period: `${upload.period_from}..${upload.period_to}`, lines: runLines.length, unmatched: summary.unmatched_count });
  res.status(201).json({
    id: runId,
    pay_source: 'SHEET',
    sheet_upload_id: upload.id,
    period_from: upload.period_from,
    period_to: upload.period_to,
    line_count: runLines.length,
    unmatched_count: summary.unmatched_count,
    unmatched_net: summary.unmatched_net,
    unmatched: summary.unmatched,
    sheet_summary: summary,
    total_gross: r2(tg),
    total_net: r2(tn),
  });
});

router.get('/runs2', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const sc = scopeSql(c, 'r.tenant_id');   // Group roll-up sees every workspace's runs
  const ids = ctxTenants(c);
  const upPh = ids.map(() => '?').join(',');
  res.json(await qall(`SELECT r.*, s.name site_name,
      (SELECT u.id FROM payroll_sheet_uploads u
        WHERE u.tenant_id IN (${upPh}) AND u.period_from=r.period_from AND u.period_to=r.period_to
          AND u.kind=COALESCE(r.kind,'REGULAR') AND u.is_active=1
        ORDER BY u.uploaded_at DESC LIMIT 1) sheet_upload_id
    FROM pay_runs r LEFT JOIN sites s ON s.id=r.site_id
    WHERE ${sc.sql} ORDER BY r.created_at DESC LIMIT 100`, [...ids, ...sc.args]));
});
router.get('/runs2/:id', requireAuth, async (req, res) => {
  try {
    const c = await needCtx(req, res); if (!c) return;
    const run = await runFor(c, req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    // Prefer the site name stored on the line (set at compute/from-sheet). The old
    // correlated REGEXP_REPLACE twin lookup scanned the whole staff table twice per
    // line and made opening a large draft hang on mobile — looking like a no-op.
    // ORDER BY must not use bare primary_site_name — pl.* already exposes that
    // column, so an alias of the same name makes Postgres raise 42702 (ambiguous)
    // and an unhandled throw here crashes the container (502 on every open).
    run.lines = await qall(`SELECT pl.*,
        COALESCE(NULLIF(TRIM(pl.primary_site_name), ''), st.name) AS primary_site_name,
        COALESCE(NULLIF(TRIM(pl.primary_site_name), ''), st.name) AS site_name
      FROM pay_run_lines pl
      LEFT JOIN staff s ON s.id=pl.staff_id
      LEFT JOIN sites st ON st.id=s.site_id
      WHERE pl.run_id=?
      ORDER BY COALESCE(NULLIF(TRIM(pl.primary_site_name), ''), st.name) NULLS LAST, pl.staff_name`, [run.id]);
    // Carry the provenance through to the saved view, so a run that was paid from
    // the accountant's sheet still says so at approval time — and keeps saying so
    // after the batch itself has been removed.
    run.override = run.override_batch_id
      ? await qone('SELECT * FROM production_override_batch WHERE id=?', [run.override_batch_id])
      : null;
    run.override_removed = !!run.override_batch_id && !run.override;
    if (run.sheet_upload_id) {
      const sheetLines = await qall('SELECT * FROM payroll_sheet_lines WHERE upload_id=?', [run.sheet_upload_id]);
      run.sheet_summary = summarizeSheetLines(sheetLines);
    }
    res.json(run);
  } catch (e) {
    console.error('[payroll] GET /runs2/:id', e.message || e);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'failed to load payroll run' });
  }
});
// Edit one payslip line on a DRAFT run — adjust deduction / bags / days, recompute
// gross+net, and flag any discrepancy vs the daily-recorded snapshot in `remarks`.
router.patch('/runs2/:id/lines/:lineId', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status !== 'DRAFT') return res.status(400).json({ error: 'only a draft can be edited' });
  const line = await qone('SELECT * FROM pay_run_lines WHERE id=? AND run_id=?', [req.params.lineId, run.id]);
  if (!line) return res.status(404).json({ error: 'line not found' });

  const b = req.body || {};
  const num = (v, fallback) => (v == null || v === '' || isNaN(+v) ? fallback : +v);
  const days = num(b.days_present, Number(line.days_present) || 0);
  const loaded = num(b.bags_loaded, Number(line.bags_loaded) || 0);
  const bagged = num(b.bags_bagged, Number(line.bags_bagged) || 0);
  const deduction = Math.max(0, num(b.deductions, Number(line.deductions) || 0));

  // Recompute gross from the (possibly edited) quantities, at the rate pair this
  // run was created with — never the default.
  const rates = await getBagRates(run.kind === 'MIDMONTH' ? 'MIDMONTH' : 'MONTHEND');
  const pt = (line.pay_type || '').toUpperCase();
  const st = await qone('SELECT daily_rate FROM staff WHERE id=?', [line.staff_id]);
  const periodDays = workingDays(run.period_from, run.period_to); // Mon–Sat working days
  let gross;
  if (pt === 'PIECE') gross = loaded * rates.loaded + bagged * rates.bagged;
  else if (pt === 'MONTHLY') gross = (Number(st?.daily_rate) || 0) * (days / periodDays);
  else gross = days * (Number(st?.daily_rate) || 0);
  gross = round2(gross);
  const ded = Math.min(gross, deduction);
  const net = round2(gross - ded);

  // Discrepancy vs daily-recorded snapshot → remarks.
  const notes = [];
  const rd = Number(line.rec_days), rl = Number(line.rec_loaded), rg = Number(line.rec_bagged);
  if (pt === 'PIECE') {
    if (!isNaN(rl) && loaded !== rl) notes.push(`Loaded ${rl}→${loaded}`);
    if (!isNaN(rg) && bagged !== rg) notes.push(`Bagged ${rg}→${bagged}`);
  } else if (!isNaN(rd) && days !== rd) notes.push(`Days ${rd}→${days}`);
  const remarks = notes.length ? `Adjusted: ${notes.join(', ')}` : null;

  await qrun('UPDATE pay_run_lines SET days_present=?, bags_loaded=?, bags_bagged=?, gross=?, deductions=?, net=?, remarks=? WHERE id=?',
    [days, loaded, bagged, gross, ded, net, remarks, line.id]);
  // Re-roll run totals.
  const sums = await qone('SELECT COALESCE(SUM(gross),0) g, COALESCE(SUM(deductions),0) d, COALESCE(SUM(net),0) n FROM pay_run_lines WHERE run_id=?', [run.id]);
  await qrun('UPDATE pay_runs SET total_gross=?, total_deductions=?, total_net=? WHERE id=?', [round2(sums.g), round2(sums.d), round2(sums.n), run.id]);
  res.json(await qone('SELECT * FROM pay_run_lines WHERE id=?', [line.id]));
});

// Import a filled-in Excel workbook into a DRAFT run. Matches rows by the ID
// column (= staff.ext_people_id), applies qty + deduction, recomputes gross/net,
// and flags any qty that differs from the daily-recorded snapshot in `remarks`.
router.post('/runs2/:id/import', requireAuth, xlsUpload.single('file'), async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status !== 'DRAFT') return res.status(400).json({ error: 'only a draft can be imported into' });
  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer' }); } catch { return res.status(400).json({ error: 'unreadable spreadsheet' }); }

  // Same rule as the single-line edit: honour the run's own kind, not the default.
  const rates = await getBagRates(run.kind === 'MIDMONTH' ? 'MIDMONTH' : 'MONTHEND');
  const periodDays = workingDays(run.period_from, run.period_to); // Mon–Sat working days
  const lines = await qall('SELECT * FROM pay_run_lines WHERE run_id=?', [run.id]);
  const lineByStaff = {}; for (const l of lines) lineByStaff[l.staff_id] = l;
  const staffIds = lines.map((l) => l.staff_id).filter(Boolean);
  const extToStaff = {};
  if (staffIds.length) {
    const ph = staffIds.map(() => '?').join(',');
    const rows = await qall(`SELECT id, ext_people_id FROM staff WHERE id IN (${ph})`, staffIds);
    for (const s of rows) if (s.ext_people_id != null && s.ext_people_id !== '') extToStaff[String(s.ext_people_id).replace(/\.0$/, '').trim()] = s.id;
  }
  const norm = (k) => String(k || '').trim().toUpperCase();
  const num = (v) => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[, ]/g, '')); return isNaN(n) ? null : n; };
  let updated = 0; const unmatched = [];

  const applyRow = async (row, kind) => {
    const get = (names) => { for (const k of Object.keys(row)) if (names.includes(norm(k))) return row[k]; return undefined; };
    const id = String(get(['ID', 'STAFF ID', 'EXT ID']) ?? '').replace(/\.0$/, '').trim();
    if (!id) return;
    const staffId = extToStaff[id]; const line = staffId && lineByStaff[staffId];
    if (!line) { unmatched.push(id); return; }
    const ded = num(get(['DEDUCTION', 'SALARY ADV', 'ADVANCE']));
    let loaded = Number(line.bags_loaded) || 0, bagged = Number(line.bags_bagged) || 0, days = Number(line.days_present) || 0;
    if (kind === 'BAGGERS') { const q = num(get(['QTY', 'BAGS BAGGED', 'BAGGED'])); if (q != null) bagged = q; }
    else if (kind === 'LOADERS') { const q = num(get(['BAGS LOADED', 'QTY', 'LOADED'])); if (q != null) loaded = q; }
    else { const d = num(get(['DAYS WORKED', 'DAYS'])); if (d != null) days = d; }
    let pt = (line.pay_type || '').toUpperCase();
    let gross;
    if (pt === 'PIECE') {
      gross = loaded * rates.loaded + bagged * rates.bagged;
    } else {
      // First upload that carries a BASE SALARY for a regular staff member PERSISTS
      // it to the staff record (pay_type MONTHLY) so future runs have it. Manual
      // edits on the Rates tab still work.
      const base = kind === 'REGULAR' ? num(get(['BASE SALARY', 'MONTHLY SALARY', 'SALARY'])) : null;
      let rate;
      if (base != null && base > 0) {
        pt = 'MONTHLY';
        await qrun('UPDATE staff SET daily_rate=?, pay_type=? WHERE id=?', [base, 'MONTHLY', staffId]);
        rate = base;
      } else {
        const st = await qone('SELECT daily_rate FROM staff WHERE id=?', [staffId]);
        rate = Number(st?.daily_rate) || 0;
      }
      gross = pt === 'MONTHLY' ? rate * (days / periodDays) : days * rate;
    }
    gross = round2(gross);
    const d2 = Math.min(gross, Math.max(0, ded != null ? ded : Number(line.deductions) || 0));
    const net = round2(gross - d2);
    const notes = [];
    const rd = Number(line.rec_days), rl = Number(line.rec_loaded), rg = Number(line.rec_bagged);
    if (pt === 'PIECE') { if (!isNaN(rl) && loaded !== rl) notes.push(`Loaded ${rl}→${loaded}`); if (!isNaN(rg) && bagged !== rg) notes.push(`Bagged ${rg}→${bagged}`); }
    else if (!isNaN(rd) && days !== rd) notes.push(`Days ${rd}→${days}`);
    const remarks = notes.length ? `Adjusted (upload): ${notes.join(', ')}` : null;
    await qrun('UPDATE pay_run_lines SET pay_type=?, days_present=?, bags_loaded=?, bags_bagged=?, gross=?, deductions=?, net=?, remarks=? WHERE id=?',
      [pt, days, loaded, bagged, gross, d2, net, remarks, line.id]);
    updated += 1;
  };

  for (const kind of ['REGULAR', 'BAGGERS', 'LOADERS']) {
    const name = Object.keys(wb.Sheets).find((n) => norm(n) === kind);
    if (!name) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' });
    for (const r of rows) await applyRow(r, kind);
  }
  const sums = await qone('SELECT COALESCE(SUM(gross),0) g, COALESCE(SUM(deductions),0) d, COALESCE(SUM(net),0) n FROM pay_run_lines WHERE run_id=?', [run.id]);
  await qrun('UPDATE pay_runs SET total_gross=?, total_deductions=?, total_net=? WHERE id=?', [round2(sums.g), round2(sums.d), round2(sums.n), run.id]);
  res.json({ updated, unmatched });
});

// Approve / return to draft (SNR_ACCOUNTANT+) → Paid (GENERAL_MANAGER+; SNR ranks equal to GM).
router.post('/runs2/:id/status', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return; // SNR_ACCOUNTANT+
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const next = (req.body && req.body.status || '').toUpperCase();
  if (next === 'APPROVED') {
    if (!atLeast(c.role, 'SNR_ACCOUNTANT')) return res.status(403).json({ error: 'forbidden' });
    if (run.status !== 'DRAFT') return res.status(400).json({ error: 'only a draft can be approved' });
    await qrun('UPDATE pay_runs SET status=?, approved_by=?, approved_at=? WHERE id=?', ['APPROVED', req.user.id, nowS(), run.id]);
  } else if (next === 'DRAFT') {
    if (!atLeast(c.role, 'SNR_ACCOUNTANT')) return res.status(403).json({ error: 'forbidden' });
    if (run.status !== 'APPROVED') return res.status(400).json({ error: 'only an approved run can be returned to draft' });
    await qrun('UPDATE pay_runs SET status=?, approved_by=NULL, approved_at=NULL WHERE id=?', ['DRAFT', run.id]);
    await audit(run.tenant_id, req.user.id, 'PAYROLL_RUN_UNAPPROVE', 'pay_runs', run.id,
      { period: `${run.period_from}→${run.period_to}`, kind: run.kind, was_approved_by: run.approved_by, was_approved_at: run.approved_at });
  } else if (next === 'PAID') {
    if (!atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'only a General Manager can mark paid' });
    if (run.status !== 'APPROVED') return res.status(400).json({ error: 'approve before marking paid' });
    await qrun('UPDATE pay_runs SET status=?, paid_at=? WHERE id=?', ['PAID', nowS(), run.id]);
  } else return res.status(400).json({ error: 'invalid status' });
  res.json(await qone('SELECT * FROM pay_runs WHERE id=?', [run.id]));
});
// Delete a DRAFT or APPROVED run — SNR_ACCOUNTANT+ only (needCtx). PAID runs are
// permanent payment records and cannot be deleted.
router.delete('/runs2/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return; // SNR_ACCOUNTANT+
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const st = String(run.status || '').toUpperCase();
  if (st === 'PAID') return res.status(400).json({ error: 'a paid run cannot be deleted — it is a permanent payment record' });
  if (st !== 'DRAFT' && st !== 'APPROVED') {
    return res.status(400).json({ error: `a ${st.toLowerCase()} run cannot be deleted` });
  }
  await withTransaction(async () => {
    // Release any advances this run had claimed, or they would stay attached to
    // a run that no longer exists and never be deducted again.
    await qrun('UPDATE staff_advances SET run_id=NULL WHERE run_id=?', [run.id]);
    await qrun('DELETE FROM pay_run_lines WHERE run_id=?', [run.id]);
    await qrun('DELETE FROM pay_runs WHERE id=?', [run.id]);
  });
  await audit(run.tenant_id, req.user.id, 'PAYROLL_RUN_DELETE', 'pay_runs', run.id,
    { period: `${run.period_from}→${run.period_to}`, kind: run.kind, total_gross: run.total_gross, previous_status: st });
  res.json({ ok: true, deleted: run.id });
});

// Rebuild a DRAFT in place from today's rates + roster, keeping its id, period and
// kind. The everyday fix after correcting a rate or re-typing staff.
router.post('/runs2/:id/recompute', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status !== 'DRAFT') return res.status(400).json({ error: 'only a draft can be recomputed' });
  if (run.pay_source === 'SHEET') {
    return res.status(400).json({ error: 'this run was built from the accountant\'s sheet — re-upload the sheet and use Generate payroll from sheet instead of Recompute' });
  }
  const pieceOnly = run.kind === 'MIDMONTH';
  const rates = await getBagRates(pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  const group = await payrollGroup(req.user, run.tenant_id, c);
  const combined = group.length > 1;
  const lines = combined
    ? await computeCombinedLines(group, run.period_from, run.period_to, rates, pieceOnly, run.site_id)
    : await computeLines(run.tenant_id, run.period_from, run.period_to, run.site_id, rates, pieceOnly);
  let tg = 0, td = 0, tn = 0, n = 0;
  await withTransaction(async () => {
    await qrun('UPDATE staff_advances SET run_id=NULL WHERE run_id=?', [run.id]);
    await qrun('DELETE FROM pay_run_lines WHERE run_id=?', [run.id]);
    for (const l of lines) {
      if (l.gross <= 0) continue;
      const d = Math.min(l.gross, Math.max(0, l.advance || 0));
      const net = round2(l.gross - d);
      tg += l.gross; td += d; tn += net; n += 1;
      await qrun(`INSERT INTO pay_run_lines (id,run_id,tenant_id,staff_id,staff_name,pay_type,days_present,bags_loaded,bags_bagged,gross,deductions,net,rec_days,rec_loaded,rec_bagged,bags_source,primary_site_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), run.id, run.tenant_id, l.staff_id, l.full_name, l.pay_type, l.days_present, l.bags_loaded, l.bags_bagged, l.gross, d, net, l.days_present, l.bags_loaded, l.bags_bagged, l.bags_source || 'PRODUCTION', l.primary_site_name || null]);
      if (d > 0) {
        if (combined && Array.isArray(l.member_ids) && l.member_ids.length) {
          const ph = l.member_ids.map(() => '?').join(',');
          await qrun(`UPDATE staff_advances SET run_id=? WHERE staff_id IN (${ph}) AND run_id IS NULL AND adv_date<=?`, [run.id, ...l.member_ids, run.period_to]);
        } else {
          await qrun('UPDATE staff_advances SET run_id=? WHERE tenant_id=? AND staff_id=? AND run_id IS NULL AND adv_date<=?', [run.id, run.tenant_id, l.staff_id, run.period_to]);
        }
      }
    }
    // A recompute can pick up an override that did not exist when the draft was
    // first built (or lose one that has since been removed), so the stamp is
    // rewritten here too rather than left describing the previous computation.
    const nowOverride = await overrideForPeriod(run.period_from, run.period_to, pieceOnly ? 'MIDMONTH' : 'MONTHEND');
    await qrun('UPDATE pay_runs SET total_gross=?, total_deductions=?, total_net=?, override_batch_id=? WHERE id=?',
      [round2(tg), round2(td), round2(tn), nowOverride ? nowOverride.id : null, run.id]);
  });
  await audit(run.tenant_id, req.user.id, 'PAYROLL_RUN_RECOMPUTE', 'pay_runs', run.id,
    { was_gross: run.total_gross, now_gross: round2(tg), lines: n, rates });
  res.json({ ok: true, count: n, total_gross: round2(tg), total_net: round2(tn), was_gross: run.total_gross, rates });
});

router.get('/runs2/:id/export.csv', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).end();
  // Joined to staff so the export carries WHO to pay AND WHERE. Without the bank
  // columns this file cannot be checked against a payment, which is most of what
  // anyone opens it for.
  const lines = await qall(`SELECT pl.*, s.ext_people_id, s.bank_name, s.bank_account, st.name site_name
    FROM pay_run_lines pl LEFT JOIN staff s ON s.id=pl.staff_id LEFT JOIN sites st ON st.id=s.site_id
    WHERE pl.run_id=? ORDER BY s.full_name, pl.staff_name`, [run.id]);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const out = [['Staff', 'ID', 'Site', 'Pay type', 'Days', 'Bags loaded', 'Bags bagged',
    'Bank', 'Account number', 'Gross', 'Deductions', 'Net', 'Bags from'].join(','),
  ...lines.map((l) => [l.staff_name, l.ext_people_id || '', l.site_name || '', l.pay_type,
    l.days_present, l.bags_loaded, l.bags_bagged,
    normaliseBank(l.bank_name), csvAccountText(l.bank_account),
    l.gross, l.deductions, l.net,
    l.bags_source === 'SHEET' ? "accountant's sheet" : 'recorded production'].map(q).join(','))];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="payroll-${run.period_from}_${run.period_to}.csv"`);
  res.send(out.join('\r\n'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// MID-MONTH PAYROLL — bagger/loader incentive for the 16th prev → 15th cycle.
// Auto-generated from production × rate, replacing the manual Fido Excel upload.
// ═══════════════════════════════════════════════════════════════════════════════
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const excelSerial = (d) => Math.floor((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000);

/** Mark ACCOUNT NUMBER columns as Excel text so leading zeros survive. */
function forceAccountTextSheets(wb, headers) {
  const want = new Set(headers.map((h) => String(h).trim().toUpperCase()));
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const cols = [];
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c: C })];
      if (cell && want.has(String(cell.v || '').trim().toUpperCase())) cols.push(C);
    }
    for (const C of cols) {
      for (let R = range.s.r + 1; R <= range.e.r; R++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[addr];
        if (!cell) continue;
        const digits = accountDigits(cell.v);
        ws[addr] = { t: 's', v: digits, z: '@', w: digits };
      }
    }
  }
  return wb;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', middle: '', last: '' };
  if (parts.length === 1) return { first: parts[0], middle: '', last: '' };
  if (parts.length === 2) return { first: parts[0], middle: '', last: parts[1] };
  return { first: parts[0], last: parts[parts.length - 1], middle: parts.slice(1, -1).join(' ') };
}
// ── Payroll eligibility (SNR_ACCOUNTANT+) ─────────────────────────────────────
// Lets the accountant take someone out of payroll WITHOUT deleting them — the
// roster carries ex-staff and duplicate records that must stop being paid while
// their history stays intact for past runs and audit.
//
//   PATCH /payroll/staff/:id/eligibility
//     { eligible: false, note: 'duplicate record' }        → parked, still staff
//     { left: true, exit_date: '2026-06-30', reason: '…' } → status LEFT + parked
//     { left: false, eligible: true }                      → reinstated
router.patch('/staff/:id/eligibility', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return; // SNR_ACCOUNTANT+ (default)
  const st = await qone('SELECT * FROM staff WHERE id=?', [req.params.id]);
  if (!st || !inScope(c, st.tenant_id)) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const today = new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });

  let status = st.status, exitDate = st.exit_date, exitReason = st.exit_reason, eligible;
  if (b.left === true) {
    // Left the company: never pay again, and stamp the exit for the record.
    status = 'LEFT';
    exitDate = String(b.exit_date || today).slice(0, 10);
    exitReason = b.reason ?? b.note ?? st.exit_reason ?? null;
    eligible = false;
  } else if (b.left === false) {
    // Reinstated: back to ACTIVE. Eligibility must be granted explicitly.
    status = 'ACTIVE';
    exitDate = null; exitReason = null;
    eligible = b.eligible !== false;
  } else if (b.eligible != null) {
    eligible = !!b.eligible;
  } else {
    return res.status(400).json({ error: 'eligible or left required' });
  }

  await qrun(`UPDATE staff SET status=?, exit_date=?, exit_reason=?, payroll_eligible=?,
      eligibility_note=?, eligibility_by=?, eligibility_at=? WHERE id=?`,
    [status, exitDate, exitReason, eligible, b.note ?? b.reason ?? null, req.user.id, Date.now(), st.id]);
  // Audit against the staff member's OWN tenant, not the roll-up anchor.
  await audit(st.tenant_id, req.user.id, 'STAFF_PAYROLL_ELIGIBILITY', 'staff', st.id,
    { full_name: st.full_name, status, payroll_eligible: eligible, exit_date: exitDate, note: b.note ?? b.reason ?? null });
  res.json(await qone('SELECT * FROM staff WHERE id=?', [st.id]));
});

// Everyone currently excluded from payroll — the accountant's review list, so a
// parked staff member can be found and reinstated rather than lost.
router.get('/staff/excluded', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const sc = scopeSql(c, 's.tenant_id');   // Group roll-up reviews every workspace
  res.json(await qall(`SELECT s.id, s.full_name, s.role_title, s.staff_type, s.status,
      s.exit_date, s.exit_reason, s.payroll_eligible, s.eligibility_note, s.eligibility_at, si.name site_name
    FROM staff s LEFT JOIN sites si ON si.id=s.site_id
    WHERE ${sc.sql} AND NOT (${PAYROLL_ELIGIBLE_S})
    ORDER BY s.full_name`, sc.args));
});

// Mid-month cycle: 16th of the PREVIOUS month → 15th of `month`.
// It deliberately overlaps the month-end cycle (28th prev → 27th current) because
// they are two different payments over the same bags, not one split cycle:
//   mid-month  = ₦1/bag incentive for the lifting, paid on the 15th-ish
//   month-end  = ₦6/bag full commission
// Computed on the date string, not a Date object, to stay timezone-proof.
function midRange(month) {
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' }).slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const py = mo === 1 ? y - 1 : y;          // January rolls back to December
  const pm = mo === 1 ? 12 : mo - 1;
  return { month: m, from: `${py}-${String(pm).padStart(2, '0')}-16`, to: `${m}-15` };
}

// Piece-worker commission lines for a period (baggers & loaders with production).
// `tenant_id` may be one id or a list — the mid-month run covers Fido + Fiafia.
async function computePieceLines(tenant_id, from, to, site, rates) {
  // Mid-month pays the GLOBAL ₦1/bag incentive rate. Deliberately ignores the
  // per-staff rate_loaded/rate_bagged columns: they default to 0 (which zeroed
  // every bagger out), and where they ARE set they hold the ₦6 full rate, which
  // would pay 6x here. Rates are global by design — same as month-end.
  rates = rates || await getBagRates('MIDMONTH');
  const ids = tenantList(tenant_id);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  // Only baggers and loaders earn piece commission. Salaried and daily staff do
  // not do this work, so bags recorded against them are a data-entry error, not
  // an entitlement — the guard in routes_logistics.js now blocks such entries at
  // source. Keeping this gate means a bad row cannot quietly become a payment.
  const sWhere = [`s.tenant_id IN (${ph})`, "s.status='ACTIVE'",
    // "HIRED BAGGER/LOADER" are casual day-labour placeholders paid cash on the
    // day — never payroll. Mirrors computeLines/computeCombinedLines.
    "UPPER(COALESCE(s.full_name,'')) NOT LIKE '%HIRED%'",
    PAYROLL_ELIGIBLE_S, PIECE_WORKER_S], sArgs = [...ids];
  if (site) { sWhere.push('s.site_id=?'); sArgs.push(site); }
  const staff = await qall(`SELECT s.id, s.tenant_id, s.full_name, s.ext_people_id, s.staff_type, s.pay_type,
      s.rate_loaded, s.rate_bagged, s.bank_name, s.bank_account, st.name site_name
    FROM staff s LEFT JOIN sites st ON st.id=s.site_id WHERE ${sWhere.join(' AND ')} ORDER BY st.name, s.full_name`, sArgs);
  const { by, override, sourceIds } = await bagsForPeriod(ids, from, to, 'MIDMONTH');
  const bySite = await siteSplit(ids, from, to, override);

  // MERGE DUPLICATE PEOPLE, exactly as computeCombinedLines does.
  //
  // The roster carries the same human twice: a legacy record with a numeric
  // ext_people_id and an ETL twin keyed by a Mongo ObjectId. Listing both paid
  // them twice for one fortnight's work — and it got worse with the accountant's
  // sheet, which matches one record by id and leaves the twin drawing its own
  // recorded production on a separate line. July 2026 mid-month: 29 people, an
  // extra ₦140,492.
  //
  // Identity is token-sorted name (and shared ≥9-digit account), so "John Doe"
  // and "Doe John" collapse, and "FCMB-123" matches "123". Two real people who
  // share a name but not an account still merge on the name — that is the
  // duplicate the payroll team flagged. Park a genuine namesake via eligibility.
  const lines = [];
  for (const grp of personGroups(staff, sourceIds)) {
    const { members, memberIds, fromSheet, bagIds } = grp;
    const head = pickPayrollHead(members) || grp.head;
    let l = 0, g = 0;
    for (const id of bagIds) { const pb = by[id]; if (pb) { l += pb.l; g += pb.g; } }

    const commission = r2(l * (rates.loaded || 0) + g * (rates.bagged || 0));
    if (commission <= 0) continue;
    // Designation: explicit staff_type, else whichever production dominates.
    const designation = (head.staff_type === 'LOADER' || head.staff_type === 'BAGGER') ? head.staff_type : (l >= g ? 'LOADER' : 'BAGGER');
    const nm = splitName(head.full_name);
    lines.push({
      staff_id: head.id, member_ids: memberIds,
      ext_id: head.ext_people_id || '', ...nm, full_name: head.full_name,
      location: head.site_name || '', primary_site_name: head.site_name || null,
      account: accountDigits(head.bank_account),
      bags_loaded: l, bags_bagged: g, qty: designation === 'LOADER' ? l : g,
      by_site: memberIds.flatMap((id) => bySite[id] || []),
      bags_source: fromSheet ? 'SHEET' : 'PRODUCTION',
      merged: memberIds.length > 1,
      commission, designation,
    });
  }
  lines.sort((a, b) => String(a.location).localeCompare(String(b.location)) || String(a.full_name).localeCompare(String(b.full_name)));
  return lines;
}

router.get('/midmonth/preview', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { month, from, to } = midRange(req.query.month);
  const site = siteBound(c) ? c.site_id : (req.query.site || null);
  // Payroll is run for the whole business, so mid-month spans Fido + Fiafia by
  // default — same as the month-end Run tab. Pass combined=0 for one tenant only.
  const combined = req.query.combined !== '0' && req.query.combined !== 'false';
  const scope = combined ? await payrollGroup(req.user, c.tenant_id, c) : [c.tenant_id];
  const lines = await computePieceLines(scope, from, to, site);
  const baggers = lines.filter((l) => l.designation === 'BAGGER');
  const loaders = lines.filter((l) => l.designation === 'LOADER');
  res.json({
    month, from, to, combined, tenants: scope,
    override: await overrideForPeriod(from, to, 'MIDMONTH'),
    baggers, loaders,
    total_baggers: r2(baggers.reduce((a, l) => a + l.commission, 0)),
    total_loaders: r2(loaders.reduce((a, l) => a + l.commission, 0)),
    total: r2(lines.reduce((a, l) => a + l.commission, 0)),
    count: lines.length,
  });
});

// Generate (or refresh) the mid-month DRAFT run (16th prev → 15th) for piece workers.
// `tenant_id` is the ANCHOR the run row is filed under; `opts.tenants` is the
// payroll scope (both tenants, normally). Mirrors how a combined month-end run is
// stored — one pay_runs row on the anchor, lines from every tenant in scope.
async function generateMidMonth(tenant_id, month, userId, site = null, opts = {}) {
  const { from, to } = midRange(month);
  const scope = (opts.tenants && opts.tenants.length) ? opts.tenants : [tenant_id];
  const lines = await computePieceLines(scope, from, to, site);
  let runId;
  await withTransaction(async () => {
    const existing = await qone("SELECT id FROM pay_runs WHERE tenant_id=? AND kind='MIDMONTH' AND period_from=? AND period_to=? AND status='DRAFT' AND COALESCE(site_id,'')=COALESCE(?, '')", [tenant_id, from, to, site]);
    runId = existing ? existing.id : uuid();
    if (existing) await qrun('DELETE FROM pay_run_lines WHERE run_id=?', [runId]);
    else await qrun(`INSERT INTO pay_runs (id,tenant_id,site_id,period_from,period_to,status,kind,created_by) VALUES (?,?,?,?,?, 'DRAFT', 'MIDMONTH', ?)`, [runId, tenant_id, site, from, to, userId || null]);
    let tot = 0;
    for (const l of lines) {
      tot += l.commission;
      await qrun(`INSERT INTO pay_run_lines (id,run_id,tenant_id,staff_id,staff_name,pay_type,days_present,bags_loaded,bags_bagged,gross,deductions,net,primary_site_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), runId, tenant_id, l.staff_id, l.full_name, l.designation, 0, l.bags_loaded, l.bags_bagged, l.commission, 0, l.commission, l.primary_site_name || l.location || null]);
    }
    await qrun('UPDATE pay_runs SET total_gross=?, total_deductions=0, total_net=? WHERE id=?', [r2(tot), r2(tot), runId]);
  });
  // Email the draft + Fido CSV to Accountants/Snr Accountants/GM/Admin.
  if (opts.email && lines.length) emailMidMonth(tenant_id, runId, scope).catch(() => {});
  return { runId, count: lines.length };
}
router.post('/midmonth/generate', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const b = req.body || {};
  const { month } = midRange(b.month);
  const site = siteBound(c) ? c.site_id : (b.site || null);
  // Must match the scope the accountant previewed, or the saved draft would differ.
  const combined = b.combined !== false;
  const tenants = combined ? await payrollGroup(req.user, c.tenant_id, c) : [c.tenant_id];
  // Saving a draft does NOT email. A draft is a working document — it gets
  // recomputed, corrected, and reconciled against the accountant's own workbook
  // before anyone should see it. Emailing on save sent out a run that was
  // ₦194,812 over the sheet because of duplicate staff records. Sending is now
  // an explicit act: POST /runs2/:id/email.
  const out = await generateMidMonth(c.tenant_id, month, req.user.id, site, { email: b.email === true, tenants });
  res.status(201).json(out);
});

// Build the Fido-format CSV (BAGGERS then LOADERS) for a saved mid-month run.
async function fidoCsv(tenant_id, run) {
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
    (l, n) => { const nm = splitName(l.full_name); return [n, l.ext_people_id || '', nm.first, nm.middle, nm.last, l.site_name || '', l.bags_bagged, csvAccountText(l.bank_account), l.gross, ps, pe, 'BAGGER']; });
  section('LOADERS', 'LOADER',
    ['S/N', 'ID', 'FIRST NAME', 'MIDDLE NAME', 'LAST NAME', 'LOCATION', 'ACCOUNT NUMBER', 'BAGS LOADED', 'NET PAY (COMMISSION)', 'PAY START DATE', 'PAY END DATE', 'DESIGNATION'],
    (l, n) => { const nm = splitName(l.full_name); return [n, l.ext_people_id || '', nm.first, nm.middle, nm.last, l.site_name || '', csvAccountText(l.bank_account), l.bags_loaded, l.gross, ps, pe, 'LOADER']; });
  return rows.map((r) => r.map(q).join(',')).join('\r\n');
}
// ═══════════════════════════════════════════════════════════════════════════════
// BANK PAYMENT FILE — the CSV the accountant uploads to FCMB to actually pay.
//
// fidoCsv() above produces the INPUT the accountant used to hand to legacy Fido.
// This is the OUTPUT side legacy Fido produced from it, and it is the file the
// bank consumes. Column names and order are copied from the legacy export
// verbatim because that shape is known to upload successfully — do not "tidy"
// them without testing against a real FCMB upload first.
// ═══════════════════════════════════════════════════════════════════════════════

// Real bank behind the free text. The legacy data carries ~38 spellings of
// roughly 15 banks ("FCMB"/"Fcmb"/"fcmb", "monie point"/"MONIEPOINT MICROFINANCE
// BANK", "Opay Digital Services Limited"…) because the old format crammed bank
// and account into one hyphenated string and split on the hyphen — whatever was
// typed became the bank name.
const BANK_ALIASES = [
  [/^(fcmb|first city monument)/, 'FCMB'],
  [/^(sterl|sterling)/, 'STERLING'],
  [/^(uba|united bank)/, 'UBA'],
  [/^(firstbank|first bank)/, 'FIRSTBANK'],
  [/^access/, 'ACCESS'],
  [/^(opay|opay digital)/, 'OPAY'],
  [/^(moniepoint|monie ?point)/, 'MONIEPOINT'],
  [/^palmpay/, 'PALMPAY'],
  [/^(fidelity|fid$)/, 'FIDELITY'],
  [/^(gtb|gtbank|guaranty)/, 'GTBANK'],
  [/^zenith/, 'ZENITH'],
  [/^eco ?bank/, 'ECOBANK'],
  [/^keystone/, 'KEYSTONE'],
  [/^union/, 'UNION'],
  [/^wema/, 'WEMA'],
  [/^provid/, 'PROVIDUS'],
  [/^globus/, 'GLOBUS'],
  [/^kuda/, 'KUDA'],
  [/^unity/, 'UNITY'],
  [/^heritage/, 'HERITAGE'],
  [/^polaris/, 'POLARIS'],
  [/^jaiz/, 'JAIZ'],
  [/^titan/, 'TITANTRUST'],
];

function normaliseBank(raw) {
  const t = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const low = t.toLowerCase();
  for (const [re, canon] of BANK_ALIASES) if (re.test(low)) return canon;
  return t.toUpperCase();
}

// Canonical bank name → 6-digit NIP institution code (NIBSS interbank
// transfer code — NOT the old 3-digit CBN clearing code), used only for the
// bank payment workbook below. The first 12 came from the accountant's own
// reference file (data/final_Bank_Payroll_Month <Month> <Year> after
// file.xls); the rest were added from NIBSS's public code list (2026-08) to
// cover every canonical name BANK_ALIASES recognises. A bank not in this map
// exports with a blank code rather than a guessed one — add to this map
// (and to BANK_ALIASES if it's a new alias) as new banks turn up on a run.
const BANK_CODES = {
  ACCESS: '000014',
  ECOBANK: '000010',
  FCMB: '000003',
  FIDELITY: '000007',
  FIRSTBANK: '000016',
  GLOBUS: '000027',
  GTBANK: '000013',
  HERITAGE: '000020',
  IBTC: '000012',
  JAIZ: '000006',
  KEYSTONE: '000002',
  KUDA: '090267',
  MONIEPOINT: '090405',
  OPAY: '100004',
  PALMPAY: '100033',
  POLARIS: '000008',
  PROVIDUS: '000023',
  STERLING: '000001',
  TITANTRUST: '000025',
  UBA: '000004',
  UNION: '000018',
  UNITY: '000011',
  WEMA: '000017',
  ZENITH: '000015',
};

// Full NIBSS institution directory (487 banks / microfinance banks /
// fintechs, pulled from NIBSS's public code list, 2026-08) keyed by the
// bank name with punctuation and case stripped, so a staff record's raw
// bank_name text can be matched exactly against an official NIBSS name.
//
// This does NOT drive grouping — normaliseBank()/BANK_ALIASES above still
// decide how a payee is grouped and labelled in the workbook (that stays
// scoped to the ~23 banks actually seen on a Fido/Fiafia roster, so a new,
// obscure bank can't silently steal a regex prefix from a real one). This
// table is purely a code-enrichment fallback: if the raw text is an exact
// match for an official NIBSS name, its code fills in; anything that
// doesn't match still exports with a blank code, same as before.
const NIBSS_CODE_BY_NAME = {
  '3LINECARDMANAGEMENTLIMITED': '110005', // 3line Card Management Limited
  '9PAYMENTSERVICEBANK': '120001', // 9Payment Service Bank
  'AAAFINANCE': '050005', // AAA Finance
  'ABBEYMORTGAGEBANK': '070010', // Abbey Mortgage Bank
  'ABMICROFINANCEBANK': '090270', // AB Microfinance Bank
  'ABOVEONLYMICROFINANCEBANK': '090260', // Above Only Microfinance Bank
  'ABSUMFB': '090640', // ABSU MFB
  'ABULESOROMICROFINANCEBANK': '090545', // Abulesoro Microfinance Bank
  'ABUMICROFINANCEBANK': '090197', // ABU Microfinance Bank
  'ACCELEREXNETWORKLIMITED': '090202', // Accelerex Network Limited
  'ACCESSBANK': '000014', // Access Bank
  'ACCESSMOBILE': '100013', // AccessMobile
  'ACCESSYELLO': '100052', // Access Yello
  'ACCIONMICROFINANCEBANK': '090134', // Accion Microfinance Bank
  'ADAMICROFINANCEBANK': '090483', // Ada Microfinance Bank
  'ADDOSSERMICROFINANCEBANK': '090160', // Addosser Microfinance Bank
  'ADEYEMICOLLEGESTAFFMICROFINANCEBANK': '090268', // Adeyemi College Staff Microfinance Bank
  'ADVANSLAFAYETTEMICROFINANCEBANK': '090155', // Advans La Fayette Microfinance Bank
  'AFEKHAFEMICROFINANCEBANK': '090292', // Afekhafe Microfinance Bank
  'AFEMAIMICROFINANCEBANK': '090518', // Afemai Microfinance Bank
  'AGMORTGAGEBANK': '100028', // AG Mortgage Bank
  'AKPOMICROFINANCEBANK': '090608', // Akpo Microfinance Bank
  'AKUCHUCKWUMICROFINANCEBANK': '090561', // Akuchuckwu Microfinance Bank
  'AKUMICROFINANCEBANK': '090531', // Aku Microfinance Bank
  'AKWASAVINGSLOANSLIMITED': '070025', // Akwa Savings & Loans Limited
  'ALBARAKAHMICROFINANCEBANK': '090133', // AL-Barakah Microfinance Bank
  'ALEKUNMICROFINANCEBANK': '090259', // Alekun Microfinance Bank
  'ALERTMICROFINANCEBANK': '090297', // Alert Microfinance Bank
  'ALHAYATMICROFINANCEBANK': '090277', // Al-Hayat Microfinance Bank
  'ALLWORKERSMICROFINANCEBANK': '090131', // Allworkers Microfinance Bank
  'ALLYMICROFINANCEBANK': '090548', // Ally Microfinance Bank
  'ALPHAKAPITALMICROFINANCEBANK': '090169', // Alpha Kapital Microfinance Bank
  'ALVANAMICROFINANCEBANK': '090489', // Alvana Microfinance Bank
  'AMACMICROFINANCEBANK': '090394', // Amac Microfinance Bank
  'AMEGYMFB': '090629', // Amegy MFB
  'AMJUUNIQUEMICROFINANCEBANK': '090180', // Amju Unique Microfinance Bank
  'AMMLMFB': '090116', // AMML MFB
  'AMOYEMICROFINANCEBANK': '090610', // Amoye Microfinance Bank
  'AMPERSANDMICROFINANCEBANK': '090529', // Ampersand Microfinance Bank
  'AMUCHAMFB': '090645', // Amucha MFB
  'ANCHORAGEMICROFINANCEBANK': '090476', // Anchorage Microfinance Bank
  'ANIOCHAMICROFINANCEBANK': '090469', // Aniocha Microfinance bank
  'APEKSMICROFINANCEBANK': '090143', // Apeks Microfinance Bank
  'APPLEMICROFINANCEBANK': '090376', // Apple Microfinance Bank
  'ARAMOKOMICROFINANCEBANK': '090307', // Aramoko Microfinance Bank
  'ARISEMICROFINANCEBANK': '090282', // Arise Microfinance Bank
  'ASOSAVINGSLOANS': '090001', // ASOSavings & Loans
  'ASPIREMICROFINANCEBANK': '090544', // Aspire Microfinance Bank
  'ASSETMATRIXMICROFINANCEBANK': '090287', // AssetMatrix Microfinance Bank
  'ASSETSMICROFINANCEBANK': '090473', // Assets Microfinance Bank
  'ASTRAPOLARISMICROFINANCEBANK': '090172', // Astrapolaris Microfinance Bank
  'AUCHIMICROFINANCEBANK': '090264', // Auchi Microfinance Bank
  'AVEMARIAMICROFINANCEBANK': '090600', // Ave Maria Microfinance Bank
  'AWACASHMFB': '090633', // Awacash MFB
  'AZTECMICROFINANCEBANK': '090540', // Aztec Microfinance Bank
  'BABURAMFB': '090625', // Babura MFB
  'BAINESCREDITMICROFINANCEBANK': '090188', // Baines Credit Microfinance Bank
  'BALERAMICROFINANCEBANK': '090563', // Balera Microfinance Bank
  'BALOGUNFULANIMICROFINANCEBANK': '090181', // Balogun Fulani Microfinance Bank
  'BALOGUNGAMBARIMICROFINANCEBANK': '090326', // Balogun Gambari Microfinance Bank
  'BANCCORPMFB': '090581', // Banc Corp MFB
  'BCKASHMICROFINANCEBANK': '090127', // BC Kash Microfinance Bank
  'BERACHAHMFB': '090618', // Berachah MFB
  'BESTSTARMFB': '090615', // Beststar MFB
  'BIPCMICROFINANCEBANK': '090336', // BIPC Microfinance Bank
  'BISHOPGATEMICROFINANCEBANK': '090555', // BishopGate Microfinance Bank
  'BLUEPRINTINVESTMENTSMICROFINANCEBANK': '090538', // BluePrint Investments Microfinance Bank
  'BOCTRUSTMICROFINANCEBANK': '090117', // Boctrust Microfinance Bank
  'BOIMICROFINANCEBANK': '090444', // BOI Microfinance Bank
  'BOJIMFB': '090494', // Boji MFB
  'BORGUMICROFINANCEBANK': '090395', // Borgu Microfinance Bank
  'BOSAKMICROFINANCEBANK': '090176', // Bosak Microfinance Bank
  'BOWENMICROFINANCEBANK': '090148', // Bowen Microfinance Bank
  'BRANCHINTERNATIONALFINANCIALSERVICES': '050006', // Branch International Financial Services
  'BRENTMORTGAGEBANK': '070015', // Brent Mortgage Bank
  'BRETHRENMICROFINANCEBANK': '090293', // Brethren Microfinance Bank
  'BRIDGEWAYMICROFINANCEBANK': '090393', // Bridgeway Microfinance Bank
  'BRIGHTWAYMICROFINANCEBANK': '090308', // Brightway Microfinance Bank
  'BRIYTHCOVENANTMFB': '090636', // Briyth-Covenant MFB
  'BROADVIEWMICROFINANCEBANK': '090568', // Broadview Microfinance Bank
  'BUNKUREMFB': '090655', // Bunkure MFB
  'BUSINESSSUPPORTMICROFINANCEBANK': '090406', // Business Support Microfinance Bank
  'CANAANMFB': '090647', // Canaan MFB
  'CARETAKERMICROFINANCEBANK': '090472', // Caretaker Microfinance Bank
  'CASHBRIDGEMFB': '090634', // Cashbridge MFB
  'CASHCONNECTMICROFINANCEBANK': '090360', // CashConnect Microfinance Bank
  'CASHRITEMFB': '090649', // Cashrite MFB
  'CATLANDMFB': '090498', // Catland MFB
  'CEDARMICROFINANCEBANK': '090562', // Cedar Microfinance Bank
  'CELLULANT': '100005', // Cellulant
  'CEMCSMICROFINANCEBANK': '090154', // CEMCS Microfinance Bank
  'CENTRALBANKOFNIGERIA': '000028', // Central Bank of Nigeria
  'CHANGANRTSMICROFINANCEBANK': '090470', // Changan RTS Microfinance Bank
  'CHASEMICROFINANCEBANK': '090523', // Chase Microfinance Bank
  'CHIKUMMICROFINANCEBANK': '090141', // Chikum Microfinance Bank
  'CHUKWUNENYEMFB': '090490', // Chukwunenye MFB
  'CINTRUSTMICROFINANCEBANK': '090480', // Cintrust Microfinance Bank
  'CITIBANK': '000009', // Citi Bank
  'CITMICROFINANCEBANK': '090144', // CIT Microfinance Bank
  'COALCAMPMICROFINANCEBANK': '090254', // Coalcamp Microfinance Bank
  'COASTLINEMICROFINANCEBANK': '090374', // Coastline Microfinance Bank
  'CONFIDENCEMFB': '090530', // Confidence MFB
  'CONPROMICROFINANCEBANK': '090380', // Conpro Microfinance Bank
  'CONSISTENTTRUSTMICROFINANCEBANK': '090553', // Consistent Trust Microfinance Bank
  'CONSUMERMICROFINANCEBANK': '090130', // Consumer Microfinance Bank
  'CONTECGLOBALINFOTECHLIMITEDNOWNOW': '100032', // Contec Global Infotech Limited (NowNow)
  'COOPMORTGAGEBANK': '070021', // Coop Mortgage Bank
  'CORESTEPMICROFINANCEBANK': '090365', // Corestep Microfinance Bank
  'CORONATIONMERCHANTBANK': '060001', // Coronation Merchant Bank
  'COVENANTMFB': '070006', // Covenant MFB
  'CREDITAFRIQUEMICROFINANCEBANK': '090159', // Credit Afrique Microfinance Bank
  'CREDITVILLEMFB': '090611', // Creditville MFB
  'CRESCENTMICROFINANCEBANK': '090526', // Crescent Microfinance Bank
  'CROWDFORCE': '110017', // Crowdforce
  'CSADVANCE': '050017', // CS Advance
  'CYBERSPACELIMITED': '110014', // Cyberspace Limited
  'DALMFB': '090596', // DAL MFB
  'DAVODANIMICROFINANCEBANK': '090391', // Davodani Microfinance Bank
  'DAYLIGHTMICROFINANCEBANK': '090167', // Daylight Microfinance Bank
  'DELTATRUSTMICROFINANCEBANK': '070023', // Delta Trust Microfinance Bank
  'DIGNITYFINANCE': '050013', // Dignity Finance
  'DIOBUMFB': '090643', // Diobu MFB
  'EAGLEFLIGHTMICROFINANCEBANK': '090294', // Eagle Flight Microfinance Bank
  'EARTHOLEUM': '100021', // Eartholeum
  'EBARCSMICROFINANCEBANK': '090156', // e-Barcs Microfinance Bank
  'ECOBANKBANK': '000010', // Ecobank Bank
  'ECOBANKXPRESSACCOUNT': '100008', // Ecobank Xpress Account
  'ECOMOBILE': '100030', // EcoMobile
  'EDFINMICROFINANCEBANK': '090310', // EdFin Microfinance Bank
  'EFINANCE': '050016', // E-Finance
  'EGWAFINMICROFINANCEBANK': '090556', // Egwafin Microfinance Bank
  'EKONDOMFB': '090097', // Ekondo MFB
  'EKRELIABLEMICROFINANCEBANK': '090389', // EK-Reliable Microfinance Bank
  'EMERALDSMICROFINANCEBANK': '090273', // Emeralds Microfinance Bank
  'EMPIRETRUSTMFB': '090114', // Empire trust MFB
  'ENAIRA': '000033', // eNaira
  'ENCOFINANCE': '050012', // Enco Finance
  'ENRICHMICROFINANCEBANK': '090539', // Enrich Microfinance Bank
  'ENTERPRISEBANK': '000019', // Enterprise Bank
  'ESANMICROFINANCEBANK': '090189', // Esan Microfinance Bank
  'ESOEMICROFINANCEBANK': '090166', // Eso-E Microfinance Bank
  'ETRANZACT': '100006', // eTranzact
  'EVANGELMICROFINANCEBANK': '090304', // Evangel Microfinance Bank
  'EVERGREENMICROFINANCEBANK': '090332', // Evergreen Microfinance Bank
  'EWTMICROFINANCEBANK': '090572', // EWT Microfinance Bank
  'EXCELLENTMICROFINANCEBANK': '090541', // Excellent Microfinance Bank
  'EYOWO': '090328', // Eyowo
  'FAIRMONEYMICROFINANCEBANK': '090551', // FairMoney Microfinance Bank
  'FASTCREDIT': '050009', // Fast Credit
  'FASTMICROFINANCEBANK': '090179', // FAST Microfinance Bank
  'FBNMOBILE': '100014', // FBNMobile
  'FBNMORTGAGESLIMITED': '090107', // FBN Mortgages Limited
  'FBNQUESTMERCHANTBANK': '060002', // FBNQUEST Merchant Bank
  'FCMB': '000003', // FCMB
  'FCMBBETA': '090409', // FCMB BETA
  'FCMBEASYACCOUNT': '100031', // FCMB Easy Account
  'FCTMICROFINANCEBANK': '090290', // FCT Microfinance Bank
  'FEDERALPOLYTECHNICNEKEDEMICROFINANCEBANK': '090398', // Federal Polytechnic Nekede Microfinance Bank
  'FEDERALUNIVERSITYDUTSEMICROFINANCEBANK': '090318', // Federal University Dutse Microfinance Bank
  'FEDETHMICROFINANCEBANK': '090482', // Fedeth Microfinance Bank
  'FEDPOLYNASARAWAMICROFINANCEBANK': '090298', // FedPoly Nasarawa Microfinance Bank
  'FET': '100001', // FET
  'FEWCHOREFINANCECOMPANYLIMITED': '050002', // FEWCHORE FINANCE COMPANY LIMITED
  'FFSMICROFINANCEBANK': '090153', // FFS Microfinance Bank
  'FHAMORTGAGEBANK': '070026', // FHA Mortgage Bank
  'FIDELITYBANK': '000007', // Fidelity Bank
  'FIDELITYMOBILE': '100019', // Fidelity Mobile
  'FIDFUNDMICROFINANCEBANK': '090126', // Fidfund Microfinance Bank
  'FIMSMFB': '090507', // FIMS MFB
  'FINATRUSTMICROFINANCEBANK': '090111', // FinaTrust Microfinance Bank
  'FIRMUSMICROFINANCEBANK': '090366', // Firmus Microfinance Bank
  'FIRSTAPPLELIMITED': '110004', // First Apple Limited
  'FIRSTBANKOFNIGERIA': '000016', // First Bank of Nigeria
  'FIRSTGENERATIONMORTGAGEBANK': '070014', // First Generation Mortgage Bank
  'FIRSTMIDASMICROFINANCEBANK': '090575', // First Midas Microfinance Bank
  'FIRSTOPTIONMICROFINANCEBANK': '090285', // First Option Microfinance Bank
  'FIRSTROYALMICROFINANCEBANK': '090164', // First Royal Microfinance Bank
  'FLOURISHMFB': '090614', // Flourish MFB
  'FLUTTERWAVETECHNOLOGYSOLUTIONSLIMITED': '110002', // Flutterwave Technology Solutions Limited
  'FORTISMICROFINANCEBANK': '070002', // Fortis Microfinance Bank
  'FORTISMOBILE': '100016', // FortisMobile
  'FSDHMERCHANTBANK': '400001', // FSDH Merchant Bank
  'FULLRANGEMICROFINANCEBANK': '090145', // Fullrange Microfinance Bank
  'FUNDQUESTFINANCIALSERVICESLIMITED': '050010', // Fundquest Financial Services Limited
  'FUTOMICROFINANCEBANK': '090158', // Futo Microfinance Bank
  'GABASAWAMFB': '090582', // Gabasawa MFB
  'GABSYNMICROFINANCEBANKLIMITED': '090591', // Gabsyn Microfinance Bank Limited
  'GASHUAMICROFINANCEBANK': '090168', // Gashua Microfinance Bank
  'GATEWAYMORTGAGEBANK': '070009', // Gateway Mortgage Bank
  'GBEDEMICROFINANCEBANK': '090579', // Gbede Microfinance Bank
  'GIANTSTRIDEMICROFINANCEBANK': '090475', // Giant Stride Microfinance Bank
  'GIDAUNIYARALHERIMFB': '090621', // Gidauniyar Alheri MFB
  'GIGINYAMICROFINANCEBANK': '090411', // Giginya Microfinance bank
  'GIREIMICROFINANCEBANK': '090186', // Girei Microfinance Bank
  'GLOBALINITIATIVEMFB': '090639', // Global Initiative MFB
  'GLOBUSBANK': '000027', // Globus Bank
  'GLORYMICROFINANCEBANK': '090278', // Glory Microfinance Bank
  'GMBMICROFINANCEBANK': '090408', // GMB Microfinance Bank
  'GOLDMANMFB': '090574', // GOLDMAN MFB
  'GOMBEMFB': '090586', // Gombe MFB
  'GOMONEY': '100022', // GoMoney
  'GOODNEIGBOURSMICROFINANCEBANK': '090467', // Good Neigbours Microfinance Bank
  'GOODNEWSMICROFINANCEBANK': '090495', // Goodnews Microfinance Bank
  'GOWANSMICROFINANCEBANK': '090122', // Gowans Microfinance Bank
  'GREENBANKMICROFINANCEBANK': '090178', // GreenBank Microfinance Bank
  'GREENENERGYMICROFINANCEBANK': '090550', // Green Energy Microfinance Bank
  'GREENVILLEMICROFINANCEBANK': '090269', // Greenville Microfinance Bank
  'GREENWICHMERCHANTBANK': '060004', // Greenwich Merchant Bank
  'GROOMINGMICROFINANCEBANK': '090195', // Grooming Microfinance Bank
  'GTBANKPLC': '000013', // GTBank Plc
  'GTIMICROFINANCEBANK': '090385', // GTI Microfinance Bank
  'GTMOBILE': '100009', // GTMobile
  'HACKMANMICROFINANCEBANK': '090147', // Hackman Microfinance Bank
  'HAGGAIMORTGAGEBANKLIMITED': '070017', // Haggai Mortgage Bank Limited
  'HALALCREDITMICROFINANCEBANK': '090291', // Halal Credit Microfinance Bank
  'HASALMICROFINANCEBANK': '090121', // Hasal Microfinance Bank
  'HEADWAYMICROFINANCEBANK': '090363', // Headway Microfinance Bank
  'HEDONMARK': '100017', // Hedonmark
  'HERITAGEBANK': '000020', // Heritage Bank
  'HIGHSTREETMICROFINANCEBANK': '090175', // HighStreet Microfinance Bank
  'HOMEBASEMORTGAGEBANK': '070024', // Homebase Mortgage Bank
  'HOPEPSB': '120002', // HopePSB
  'IBAMICROFINANCEBANK': '090598', // IBA Microfinance Bank
  'IBILEMICROFINANCEBANK': '090118', // IBILE Microfinance Bank
  'IBOLOMICROFINANCEBANK': '090532', // IBOLO Microfinance Bank
  'IBOMAFADAMAMICROFINANCEBANK': '090519', // Iboma Fadama Microfinance Bank
  'IBUAJEMICROFINANCEBANK': '090488', // Ibu-Aje Microfinance Bank
  'IJEBUIFEMICROFINANCEBANK': '090546', // Ijebu-Ife Microfinance Bank
  'IKENNEMICROFINANCEBANK': '090324', // Ikenne Microfinance Bank
  'IKIREMICROFINANCEBANK': '090279', // Ikire Microfinance Bank
  'IKOYIOSUNMICROFINANCEBANK': '090536', // Ikoyi-Osun Microfinance Bank
  'ILAROPOLYMICROFINANCEBANK': '090571', // Ilaro Poly Microfinance Bank
  'ILISANMICROFINANCEBANK': '090370', // Ilisan Microfinance Bank
  'IMOSTATEMICROFINANCEBANK': '090258', // Imo State Microfinance Bank
  'IMPERIALHOMESMORTGAGEBANK': '100024', // Imperial Homes Mortgage Bank
  'INFINITYMICROFINANCEBANK': '090157', // Infinity Microfinance Bank
  'INFINITYTRUSTMORTGAGEBANK': '070016', // Infinity Trust Mortgage Bank
  'INNOVECTIVESKESH': '100029', // Innovectives Kesh
  'INTELLIFIN': '100027', // Intellifin
  'INTERLANDMICROFINANCEBANK': '090386', // Interland Microfinance Bank
  'INTERSWITCHLIMITED': '110003', // Interswitch Limited
  'IRLMICROFINANCEBANK': '090149', // IRL Microfinance Bank
  'ISALEOYOMICROFINANCEBANK': '090377', // Isaleoyo Microfinance Bank
  'ISLANDMICROFINANCEBANK': '090584', // Island Microfinance Bank
  'IWADEMFBLTD': '090578', // Iwade MFB Ltd
  'IWOAMAMICROFINANCEBANK': '090543', // Iwoama Microfinance Bank
  'IYAMOYEMICROFINANCEBANK': '090570', // Iyamoye Microfinance Bank
  'IYERUOKINMICROFINANCEBANK': '090337', // Iyeru Okin Microfinance Bank
  'IYINEKITIMFB': '090620', // Iyin Ekiti MFB
  'JAIZBANK': '000006', // JAIZ Bank
  'JESSEFIELDMICROFINANCEBANK': '090352', // Jessefield Microfinance Bank
  'JUBILEELIFEMORTGAGEBANK': '090003', // Jubilee-Life Mortgage Bank
  'KADPOLYMICROFINANCEBANK': '090320', // KadPoly Microfinance Bank
  'KAYVEEMICROFINANCEBANK': '090554', // Kayvee Microfinance Bank
  'KCMBMICROFINANCEBANK': '090191', // KCMB Microfinance Bank
  'KCMICROFINANCEBANK': '090549', // KC Microfinance Bank
  'KEGOWCHAMSMOBILE': '100036', // Kegow (Chamsmobile)
  'KENECHUKWUMICROFINANCEBANK': '090602', // Kenechukwu Microfinance Bank
  'KEYSTONEBANK': '000002', // Keystone Bank
  'KKUMFB': '090606', // KKU MFB
  'KONTAGORAMICROFINANCEBANK': '090299', // Kontagora Microfinance Bank
  'KOPOKOPEMFB': '090617', // Kopo Kope MFB
  'KUDAMICROFINANCEBANK': '090267', // Kuda Microfinance Bank
  'LAGOSBUILDINGINVESTMENTCOMPANY': '070012', // Lagos Building Investment Company
  'LAPOMICROFINANCEBANK': '090177', // Lapo Microfinance Bank
  'LAVENDERMICROFINANCEBANK': '090271', // Lavender Microfinance Bank
  'LEADCITYMFB': '090650', // Leadcity MFB
  'LEADREMITLIMITED': '110044', // Leadremit Limited
  'LEGENDMICROFINANCEBANK': '090372', // Legend Microfinance Bank
  'LIFEGATEMICROFINANCEBANK': '090557', // Lifegate Microfinance Bank
  'LIGHTMFB': '090477', // Light MFB
  'LOBREMMICROFINANCEBANK': '090537', // Lobrem Microfinance Bank
  'LOTUSBANK': '000029', // Lotus Bank
  'LOVONUSMICROFINANCEBANK': '090265', // Lovonus Microfinance Bank
  'LUKEFIELDFINANCECOMPANYLIMITED': '050015', // Lukefield Finance Company Limited
  'M36': '100035', // M36
  'MABALLIANZMFB': '090623', // MAB Allianz MFB
  'MABINASMFB': '090630', // Mabinas MFB
  'MACRODMFB': '090603', // Macrod MFB
  'MADOBIMFB': '090605', // Madobi MFB
  'MAINLANDMICROFINANCEBANK': '090323', // Mainland Microfinance Bank
  'MAINSTREETMICROFINANCEBANK': '090171', // Mainstreet Microfinance Bank
  'MAINTRUSTMICROFINANCEBANK': '090465', // Maintrust Microfinance Bank
  'MALACHYMICROFINANCEBANK': '090174', // Malachy Microfinance Bank
  'MARITIMEMICROFINANCEBANK': '090410', // Maritime Microfinance Bank
  'MAYFAIRMICROFINANCEBANK': '090321', // MayFair Microfinance Bank
  'MAYFRESHMORTGAGEBANK': '070019', // MayFresh Mortgage Bank
  'MEDEFMICROFINANCEBANK': '090612', // Medef Microfinance Bank
  'MEGAPRAISEMICROFINANCEBANK': '090280', // Megapraise Microfinance Bank
  'MERCURYMFB': '090589', // Mercury MFB
  'MGBIDIMICROFINANCEBANK': '090528', // Mgbidi Microfinance Bank
  'MICHAELOKPARAUNIAGRICMICROFINANCEBANK': '090659', // MICHAEL OKPARA UNIAGRIC MICROFINANCE BANK
  'MICROBIZMFB': '090587', // Microbiz MFB
  'MICROCREDMICROFINANCEBANK': '090136', // Microcred Microfinance Bank
  'MIDLANDMICROFINANCEBANK': '090192', // Midland Microfinance Bank
  'MINJIBIRMFB': '090607', // MINJIBIR MFB
  'MINTFINEXMICROFINANCEBANK': '090281', // MintFinex Microfinance Bank
  'MKOBOMICROFINANCEBANK': '090455', // Mkobo Microfinance Bank
  'MKUDI': '100011', // Mkudi
  'MOLUSIMICROFINANCEBANK': '090362', // Molusi Microfinance Bank
  'MOMOPSB': '120003', // MoMo PSB
  'MONEYBOX': '100020', // MoneyBox
  'MONEYTRUSTMICROFINANCEBANK': '090129', // Money Trust Microfinance Bank
  'MONIEPOINTMICROFINANCEBANK': '090405', // Moniepoint Microfinance Bank
  'MOYOFADEMICROFINANCEBANK': '090448', // Moyofade Microfinance Bank
  'MUTUALBENEFITSMICROFINANCEBANK': '090190', // Mutual Benefits Microfinance Bank
  'MUTUALTRUSTMICROFINANCEBANK': '090151', // Mutual Trust Microfinance Bank
  'NAGARTAMICROFINANCEBANK': '090152', // Nagarta Microfinance Bank
  'NASSARAWAMICROFINANCEBANK': '090349', // Nassarawa Microfinance Bank
  'NAVYMICROFINANCEBANK': '090263', // Navy Microfinance Bank
  'NDIORAHMICROFINANCEBANK': '090128', // Ndiorah Microfinance Bank
  'NEPTUNEMICROFINANCEBANK': '090329', // Neptune Microfinance Bank
  'NEWDAWNMICROFINANCEBANK': '090205', // New Dawn Microfinance Bank
  'NEWGOLDENPASTURESMICROFINANCEBANK': '090378', // New Golden Pastures Microfinance Bank
  'NEWPRUDENTIALBANK': '090108', // New Prudential Bank
  'NEXIMBANK': '030001', // NEXIM Bank
  'NIGERIANPRISONSMICROFINANCEBANK': '090505', // Nigerian Prisons Microfinance Bank
  'NIPVIRTUALBANK': '999999', // NIP Virtual Bank
  'NIRSALMICROFINANCEBANK': '090194', // NIRSAL Microfinance Bank
  'NKPOLUUSTMFB': '090535', // Nkpolu-Ust MFB
  'NNEWWOMENMICROFINANCEBANK': '090283', // Nnew Women Microfinance Bank
  'NOVAMERCHANTBANK': '060003', // Nova Merchant Bank
  'NPFMICROFINANCEBANK': '070001', // NPF MicroFinance Bank
  'NSEHEMFB': '090628', // Nsehe MFB
  'NSUKMFB': '090491', // Nsuk MFB
  'NUMOMICROFINANCEBANK': '090516', // Numo Microfinance Bank
  'NUTUREMICROFINANCEBANK': '090364', // Nuture Microfinance Bank
  'NWANNEGADIMICROFINANCEBANK': '090399', // Nwannegadi Microfinance Bank
  'OAUMICROFINANCEBANK': '090345', // OAU Microfinance Bank
  'OCHEMICROFINANCEBANK': '090333', // Oche Microfinance Bank
  'OCTOPUSMICROFINANCEBANK': '090576', // Octopus Microfinance Bank
  'ODOAKPUMFB': '090654', // Odoakpu MFB
  'OHAFIAMICROFINANCEBANK': '090119', // Ohafia Microfinance Bank
  'OHHAMFB': '090626', // Ohha MFB
  'OJOKOROMICROFINANCEBANK': '090527', // Ojokoro Microfinance Bank
  'OKEAROOREDEGBEMICROFINANCEBANK': '090565', // Oke-Aro Oredegbe Microfinance Bank
  'OKENGWEMFB': '090646', // Okengwe MFB
  'OKPOGAMICROFINANCEBANK': '090161', // Okpoga Microfinance Bank
  'OKUKUMICROFINANCEBANK': '090566', // Okuku Microfinance Bank
  'OLABISIONABANJOUNIVERSITYMICROFINANCEBANK': '090272', // Olabisi Onabanjo University Microfinance Bank
  'OLOFINOWENAMICROFINANCEBANK': '090468', // OLOFIN OWENA Microfinance Bank
  'OLOWOLAGBAMICROFINANCEBANK': '090404', // Olowolagba Microfinance Bank
  'OLUCHUKWUMICROFINANCEBANK': '090471', // Oluchukwu Microfinance Bank
  'OMIYEMICROFINANCEBANK': '090295', // Omiye Microfinance Bank
  'OMOLUABISAVINGSANDLOANS': '070007', // Omoluabi savings and loans
  'ONEFINANCE': '100026', // One Finance
  'OPTIMUSBANK': '000036', // Optimus Bank
  'ORAUKWUMFB': '090492', // Oraukwu MFB
  'ORISUNMFB': '090588', // Orisun MFB
  'OROKAMMICROFINANCEBANK': '090567', // Orokam Microfinance Bank
  'OSCOTECHMICROFINANCEBANK': '090396', // Oscotech Microfinance Bank
  'OTECHMICROFINANCEBANK': '090580', // Otech Microfinance Bank
  'OTUOMICROFINANCEBANK': '090542', // Otuo Microfinance Bank
  'OYANMFB': '090635', // Oyan MFB
  'PAGA': '100002', // Paga
  'PAGEFINANCIALS': '070008', // Page Financials
  'PALMPAYLIMITED': '100033', // PalmPay Limited
  'PARALLEXBANK': '000030', // Parallex Bank
  'PARKWAYREADYCASH': '100003', // Parkway-ReadyCash
  'PARRALEXMICROFINANCEBANK': '090004', // Parralex Microfinance bank
  'PATRICKGOLDMICROFINANCEBANK': '090317', // PatrickGold Microfinance Bank
  'PAYATTITUDEONLINE': '110001', // PayAttitude Online
  'PAYCOMOPAY': '100004', // Paycom(Opay)
  'PAYSTACKPAYMENTLIMITED': '110006', // Paystack Payment Limited
  'PECANTRUSTMICROFINANCEBANK': '090137', // PecanTrust Microfinance Bank
  'PENNYWISEMICROFINANCEBANK': '090196', // Pennywise Microfinance Bank
  'PERSONALTRUSTMICROFINANCEBANK': '090135', // Personal Trust Microfinance Bank
  'PETRAMICROFINANCEBANK': '090165', // Petra Microfinance Bank
  'PILLARMICROFINANCEBANK': '090289', // Pillar Microfinance Bank
  'PLATINUMMORTGAGEBANK': '070013', // Platinum Mortgage Bank
  'POLARISBANK': '000008', // Polaris Bank
  'POLYBADANMICROFINANCEBANK': '090534', // Polybadan Microfinance Bank
  'POLYUNWANAMICROFINANCEBANK': '090296', // Polyunwana Microfinance Bank
  'PREEMINENTMICROFINANCEBANK': '090412', // Preeminent Microfinance Bank
  'PREMIUMTRUSTBANK': '000031', // Premium Trust Bank
  'PRESTIGEMICROFINANCEBANK': '090274', // Prestige Microfinance Bank
  'PRISTINEDIVITISMICROFINANCEBANK': '090499', // Pristine Divitis Microfinance Bank
  'PROJECTSMICROFINANCEBANK': '090503', // Projects Microfinance Bank
  'PROPHIUS': '110032', // Prophius
  'PROSPERITYMFB': '090642', // Prosperity MFB
  'PROVIDUSBANK': '000023', // Providus Bank
  'PURPLEMONEYMICROFINANCEBANK': '090303', // Purplemoney Microfinance Bank
  'PYRAMIDMFB': '090657', // Pyramid MFB
  'QUBEMICROFINANCEBANK': '090569', // Qube Microfinance Bank
  'QUICKFUNDMICROFINANCEBANK': '090261', // Quickfund Microfinance Bank
  'RANDALPHAMICROFINANCEBANK': '090496', // Randalpha Microfinance Bank
  'RANDMERCHANTBANK': '000024', // Rand Merchant Bank
  'RAYYANMFB': '090616', // Rayyan MFB
  'REFUGEMORTGAGEBANK': '070011', // Refuge Mortgage Bank
  'REGENTMICROFINANCEBANK': '090125', // Regent Microfinance Bank
  'REHOBOTHMICROFINANCEBANK': '090463', // Rehoboth Microfinance Bank
  'RELIANCEMICROFINANCEBANK': '090173', // Reliance Microfinance Bank
  'RENMONEYMICROFINANCEBANK': '090198', // RenMoney Microfinance Bank
  'REPHIDIMMICROFINANCEBANK': '090322', // Rephidim Microfinance Bank
  'RICHWAYMICROFINANCEBANK': '090132', // Richway Microfinance Bank
  'RIGOMICROFINANCEBANK': '090433', // Rigo Microfinance Bank
  'RIMAGROWTHPATHWAYMICROFINANCEBANK': '090515', // RIMA Growth Pathway Microfinance Bank
  'ROCKSHIELDMICROFINANCEBANK': '090547', // Rockshield Microfinance Bank
  'ROYALBLUEMFB': '090622', // Royal Blue MFB
  'ROYALEXCHANGEMICROFINANCEBANK': '090138', // Royal Exchange Microfinance Bank
  'SAFEHAVENMICROFINANCEBANK': '090286', // Safe Haven Microfinance Bank
  'SAFETRUST': '090006', // SafeTrust
  'SAGAMUMICROFINANCEBANK': '090140', // Sagamu Microfinance Bank
  'SAGEGREYFINANCELIMITED': '050003', // SageGrey Finance Limited
  'SEAPMICROFINANCEBANK': '090513', // SEAP Microfinance Bank
  'SEEDCAPITALMICROFINANCEBANK': '090112', // Seed Capital Microfinance Bank
  'SEEDVESTMICROFINANCEBANK': '090369', // Seedvest Microfinance Bank
  'SHALOMMICROFINANCEBANK': '090502', // Shalom Microfinance Bank
  'SHEPHERDTRUSTMICROFINANCEBANK': '090401', // Shepherd Trust Microfinance Bank
  'SHIELDMICROFINANCEBANK': '090559', // Shield Microfinance Bank
  'SHONGOMMICROFINANCEBANK': '090558', // Shongom Microfinance Bank
  'SIGNATUREBANK': '000034', // Signature Bank
  'SIMPLEFINANCELIMITED': '050008', // Simple Finance Limited
  'SMARTCASHPSB': '120004', // SmartCash PSB
  'SNOWMFB': '090573', // Snow MFB
  'SOLIDALLIANZEMFB': '090506', // Solid Allianze MFB
  'SOLIDROCKMICROFINANCEBANK': '090524', // Solidrock microfinance Bank
  'SOURCEMFB': '090641', // Source MFB
  'SPARKLE': '090325', // Sparkle
  'STANBICIBTCBANK': '000012', // StanbicIBTC Bank
  'STANBICIBTCEASEWALLET': '100007', // Stanbic IBTC @ease wallet
  'STANDARDCHARTERED': '000021', // StandardChartered
  'STANFORDMICROFINANCEBAK': '090162', // Stanford Microfinance Bak
  'STATESIDEMICROFINANCEBANK': '090583', // Stateside Microfinance Bank
  'STBMORTGAGEBANK': '070022', // STB Mortgage Bank
  'STELLASMICROFINANCEBANK': '090262', // Stellas Microfinance Bank
  'STERLINGBANK': '000001', // Sterling Bank
  'SULSPAPMICROFINANCEBANK': '090305', // Sulspap Microfinance Bank
  'SUNTOPMFB': '090644', // Suntop MFB
  'SUNTRUSTBANK': '000022', // Suntrust Bank
  'SUPREMEMICROFINANCEBANK': '090564', // Supreme Microfinance Bank
  'TAGPAY': '100023', // TagPay
  'TAJBANK': '000026', // Taj Bank
  'TAJPINSPAY': '080002', // Taj_Pinspay
  'TANADIMICROFINANCEBANK': '090560', // Tanadi Microfinance Bank
  'TANGALEMFB': '090638', // Tangale MFB
  'TASUEDMICROFINANCEBANK': '090593', // Tasued Microfinance Bank
  'TCFMFB': '090115', // TCF MFB
  'TEAMAPTLIMITED': '110007', // Teamapt Limited
  'TEASYMOBILE': '100010', // TeasyMobile
  'TEKLAFINANCELIMITED': '050007', // Tekla Finance Limited
  'THINKFINANCEMICROFINANCEBANK': '090373', // Think Finance Microfinance Bank
  'TITANPAYSTACK': '100039', // TitanPaystack
  'TITANTRUSTBANK': '000025', // Titan Trust Bank
  'TOTALTRUSTMFB': '090613', // Total Trust MFB
  'TRIDENTMICROFINANCEBANK': '090146', // Trident Microfinance Bank
  'TRINITYFINANCIALSERVICESLIMITED': '050014', // Trinity Financial Services Limited
  'TRIPLEAMICROFINANCEBANK': '090525', // TripleA Microfinance Bank
  'TRUSTBONDMORTGAGEBANK': '090005', // Trustbond Mortgage Bank
  'TRUSTFUNDMICROFINANCEBANK': '090276', // Trustfund Microfinance Bank
  'TRUSTMICROFINANCEBANK': '090327', // Trust Microfinance Bank
  'UCMICROFINANCEBANK': '090315', // U & C Microfinance Bank
  'UDAMICROFINANCEBANK': '090403', // UDA Microfinance Bank
  'UHURUMICROFINANCEBANK': '090517', // Uhuru Microfinance Bank
  'UMMAHMICROFINANCEBANK': '090609', // Ummah Microfinance Bank
  'UMUCHUKWUMFB': '090632', // Umuchukwu MFB
  'UNAABMICROFINANCEBANK': '090331', // UNAAB Microfinance Bank
  'UNIBENMICROFINANCEBANK': '090266', // Uniben Microfinance Bank
  'UNICALMICROFINANCEBANK': '090193', // Unical Microfinance Bank
  'UNIFUNDMFB': '090637', // Unifund MFB
  'UNIMAIDMICROFINANCEBANK': '090464', // Unimaid Microfinance Bank
  'UNIONBANK': '000018', // Union Bank
  'UNITEDBANKFORAFRICA': '000004', // United Bank for Africa
  'UNITYBANK': '000011', // Unity Bank
  'UNIUYOMICROFINANCEBANK': '090338', // UniUyo Microfinance Bank
  'UNNMFB': '090251', // UNN MFB
  'VALEFINANCELIMITED': '110071', // Vale Finance Limited
  'VAS2NETSLIMITED': '110015', // Vas2nets Limited
  'VERDANTMICROFINANCEBANK': '090474', // Verdant Microfinance Bank
  'VERITEMICROFINANCEBANK': '090123', // Verite Microfinance Bank
  'VFDMFB': '090110', // VFD MFB
  'VIRTUEMICROFINANCEBANK': '090150', // Virtue Microfinance Bank
  'VISAMICROFINANCEBANK': '090139', // Visa Microfinance Bank
  'VTNETWORKS': '100012', // VTNetworks
  'WAYAMICROFINANCEBANK': '090950', // Waya Microfinance Bank
  'WEMABANK': '000017', // Wema Bank
  'WETLANDMICROFINANCEBANK': '090120', // Wetland Microfinance Bank
  'XPRESSWALLET': '100040', // Xpresswallet
  'XSLNCEMICROFINANCEBANK': '090124', // Xslnce Microfinance Bank
  'YCTMICROFINANCEBANK': '090466', // YCT Microfinance Bank
  'YESMICROFINANCEBANK': '090142', // Yes Microfinance Bank
  'YOBEMICROFINANCEBANK': '090252', // Yobe Microfinance Bank
  'ZENITHBANKPLC': '000015', // Zenith Bank Plc
  'ZENITHEAZYWALLET': '100034', // Zenith Eazy Wallet
  'ZENITHMOBILE': '100018', // ZenithMobile
  'ZIKORAMICROFINANCEBANK': '090504', // Zikora Microfinance Bank
  'ZINTERNETNIGERALIMITED': '100025', // Zinternet Nigera Limited

};

// Strict normaliser for the NIBSS_CODE_BY_NAME lookup — exact match only
// (case/punctuation-insensitive), unlike normaliseBank()'s fuzzy prefixes.
function nibssKey(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Nigerian NUBAN account numbers are exactly 10 digits. Anything else will
// bounce at the bank, so it is worth naming before the file is submitted
// rather than after a failed batch.
function bankLineIssues(l) {
  const out = [];
  const bank = normaliseBank(l.bank_name);
  const acct = accountDigits(l.bank_account);

  if (!bank) out.push('no bank');
  else if (/\d/.test(String(l.bank_name))) out.push(`bank name contains digits ("${l.bank_name}")`);
  else if (bank === 'OTHERBANK') out.push('bank recorded as OTHERBANK (placeholder)');

  if (!acct) out.push('no account number');
  else if (acct.length !== 10) out.push(`account number is ${acct.length} digits, expected 10`);

  return out;
}

async function bankLines(run) {
  return qall(`SELECT pl.*, s.ext_people_id, s.full_name, s.bank_name, s.bank_account, st.name site_name
    FROM pay_run_lines pl
    LEFT JOIN staff s  ON s.id = pl.staff_id
    LEFT JOIN sites st ON st.id = s.site_id
    WHERE pl.run_id=? ORDER BY st.name, s.full_name`, [run.id]);
}

// BANK PAYMENT WORKBOOK — grouped by bank (A→Z), then by staff name within
// each bank, mirroring the layout the Snr Accountant has always built by
// hand (data/final_Bank_Payroll_Month <Month> <Year> after file.xls) so this
// replaces that manual step without changing the shape the bank is used to
// seeing. Column order and the blank spacer row after the header are copied
// from that reference workbook verbatim — do not "tidy" them without
// checking against a real upload first (see the CSV-era note above).
async function bankXlsxBuffer(run) {
  const lines = await bankLines(run);

  const grouped = {};
  for (const l of lines) {
    const bank = normaliseBank(l.bank_name) || '(NO BANK)';
    (grouped[bank] = grouped[bank] || []).push(l);
  }
  const banks = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
  for (const bank of banks) {
    grouped[bank].sort((a, b) =>
      String(a.full_name || a.staff_name || '').localeCompare(String(b.full_name || b.staff_name || '')));
  }

  const HEADER = ['', 'Staff', 'ID', 'Site', 'Pay type', 'Days', 'Bags loaded', 'Bags bagged',
    'Bank', '', 'Account number', 'Gross', 'Deductions', 'Net', 'Bags from'];
  const aoa = [HEADER, []];

  for (const bank of banks) {
    for (const l of grouped[bank]) {
      aoa.push([
        '',
        l.full_name || l.staff_name || '',
        l.ext_people_id || '',
        l.site_name || '',
        String(l.pay_type || '').toUpperCase(),
        r2(l.days_present || 0),
        r2(l.bags_loaded || 0),
        r2(l.bags_bagged || 0),
        bank,
        // Curated 23-bank table first (matches the canon BANK_ALIASES just
        // grouped by); if that misses, try an exact match of what was
        // actually typed against the full NIBSS directory — covers a bank
        // nobody has hard-coded an alias for yet without guessing at one.
        BANK_CODES[bank] || NIBSS_CODE_BY_NAME[nibssKey(l.bank_name)] || '',
        accountDigits(l.bank_account),
        r2(l.gross),
        r2(l.deductions),
        r2(l.net ?? l.gross),
        l.bags_source === 'SHEET' ? "accountant's sheet" : 'recorded production',
      ]);
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 2 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 9 }, { wch: 6 },
    { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 7 }, { wch: 14 }, { wch: 11 }, { wch: 11 },
    { wch: 11 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'BANK PAYMENT');
  return XLSX.write(forceAccountTextSheets(wb, ['Account number']), { type: 'buffer', bookType: 'xlsx' });
}

// Bank portal workbook — available once APPROVED (and still after PAID).
// SNR_ACCOUNTANT+ via needCtx. Drafts must be approved first (Approve → bank file).
// The workbook itself always generates for eligible statuses — a payroll must not
// be blocked by one bad record. Issues ride alongside (bank-check) so the UI can
// warn before submission.
router.get('/runs2/:id/bank.xlsx', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return; // SNR_ACCOUNTANT+
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).end();
  const st = String(run.status || '').toUpperCase();
  if (st !== 'APPROVED' && st !== 'PAID') {
    return res.status(400).json({ error: 'approve the draft before downloading the bank portal file' });
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="bank-payment-${run.period_from}_${run.period_to}.xlsx"`);
  res.send(await bankXlsxBuffer(run));
});

// Pre-flight: who in this run cannot be paid as recorded (SNR+; any status).
router.get('/runs2/:id/bank-check', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });

  const lines = await bankLines(run);
  const problems = [];
  for (const l of lines) {
    const issues = bankLineIssues(l);
    if (issues.length) {
      problems.push({
        staff_id: l.staff_id,
        name: l.full_name || l.staff_name,
        site: l.site_name || '',
        amount: r2(l.net ?? l.gross),
        issues,
      });
    }
  }
  res.json({
    run_id: run.id,
    payees: lines.length,
    ok: lines.length - problems.length,
    at_risk: problems.length,
    at_risk_amount: r2(problems.reduce((a, p) => a + p.amount, 0)),
    problems,
  });
});

router.get('/runs2/:id/fido.csv', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).end();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="midmonth-payroll-${run.period_from}.csv"`);
  res.send(await fidoCsv(c.tenant_id, run));
});

// Email the mid-month draft + Fido CSV to Accountants, Snr Accountants, GMs, Admins.
// `tenants` = the run's full scope. A combined run must reach the accountants of
// EVERY tenant it pays, not just the anchor the run row happens to be filed under.
async function emailMidMonth(tenant_id, runId, tenants) {
  try {
    const tenant = await qone('SELECT * FROM tenants WHERE id=?', [tenant_id]); // branding = anchor
    const run = await qone('SELECT * FROM pay_runs WHERE id=?', [runId]);
    if (!tenant || !run) return;
    const ids = tenantList(tenants && tenants.length ? tenants : tenant_id);
    const ph = ids.map(() => '?').join(',');
    const members = await qall(`SELECT DISTINCT u.email, m.role FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id IN (${ph}) AND u.email IS NOT NULL AND u.email<>''`, ids);
    const to = [...new Set(members.filter((m) => atLeast(m.role, 'ACCOUNTANT')).map((m) => m.email))];
    if (!to.length) return;
    const lines = await qall('SELECT * FROM pay_run_lines WHERE run_id=?', [runId]);
    const baggers = lines.filter((l) => (l.pay_type || '').toUpperCase() === 'BAGGER');
    const loaders = lines.filter((l) => (l.pay_type || '').toUpperCase() === 'LOADER');
    const sum = (a) => r2(a.reduce((s, l) => s + (Number(l.gross) || 0), 0));
    const summary = { count: lines.length, baggers, loaders, total_baggers: sum(baggers), total_loaders: sum(loaders), total: sum(lines) };
    const csv = await fidoCsv(tenant_id, run);
    const mailer = require('./mailer');
    const sent = await mailer.sendMidMonthPayroll({ tenant, from: run.period_from, to: run.period_to, summary, recipients: to, csv });
    await qrun('INSERT INTO email_log (id,tenant_id,to_addrs,subject,status) VALUES (?,?,?,?,?)', [uuid(), tenant_id, to.join(','), sent.subject, 'SENT']).catch(() => {});
  } catch (e) {
    await qrun('INSERT INTO email_log (id,tenant_id,to_addrs,subject,status,error) VALUES (?,?,?,?,?,?)', [uuid(), tenant_id, '', 'Mid-month payroll', 'FAILED', e.message]).catch(() => {});
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  PRODUCTION OVERRIDE — the Snr Accountant's spreadsheet, for one period
// ══════════════════════════════════════════════════════════════════════════════
//
// Payroll pays from `production`. Sites that never enter production pay nobody —
// which is how ~20 Mbiama baggers and loaders worked a fortnight for nothing in
// the app while the accountant's workbook showed every bag.
//
// This lets that workbook stand in for `production` for ONE pay period. It is
// built to be hard to leave switched on:
//
//   * `sheet_override_enabled` starts at 0 and only an ADMIN can raise it;
//   * a successful import puts it straight back to 0;
//   * each upload is a batch, and deleting the batch undoes the whole thing;
//   * `production` itself is never written, so daily reports keep telling the
//     truth about which sites actually record their work.
//
// Sites entering production daily remains the fix. This is the bridge.

const OVERRIDE_FLAG = 'sheet_override_enabled';

async function overrideEnabled() {
  const r = await qone('SELECT value FROM payroll_settings WHERE key=?', [OVERRIDE_FLAG]);
  return Number(r?.value) > 0;
}
async function setOverrideFlag(on, userId) {
  await qrun(`INSERT INTO payroll_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at, updated_by=EXCLUDED.updated_by`,
  [OVERRIDE_FLAG, on ? 1 : 0, nowS(), userId || null]);
}

// Excel stores dates as days since 1899-12-30. The accountant's sheet carries the
// period in PAY START DATE / PAY END DATE, so we can read the window off the file
// rather than trusting whoever is at the keyboard to retype it.
const fromSerial = (n) => {
  const v = Number(n);
  if (!isFinite(v) || v < 20000 || v > 80000) return null;
  return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
};
const asDate = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return fromSerial(s);
};

// Read the flag + the batches already loaded. Snr Accountant+ so the accountant
// can see whether Admin has opened the gate for them yet.
router.get('/production-override', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const enabled = await overrideEnabled();
  const { sql, args } = scopeSql(c, 'o.tenant_id');
  const batches = await qall(`SELECT b.*,
      (SELECT COUNT(*) FROM production_override o WHERE o.batch_id=b.id AND ${sql}) rows_in_scope
    FROM production_override_batch b ORDER BY b.created_at DESC LIMIT 50`, args);
  res.json({ enabled, batches });
});

// Open the gate. ADMIN only — this is the whole point of the control: the person
// who uploads the sheet is not the person who decides the sheet may override the
// system of record.
router.post('/production-override/enable', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'ADMIN'); if (!c) return;
  const on = req.body?.enabled !== false;
  await setOverrideFlag(on, req.user.id);
  await audit(c.tenant_id, req.user.id, on ? 'override.enable' : 'override.disable', 'payroll_settings', OVERRIDE_FLAG, null);
  res.json({ ok: true, enabled: on });
});

// Upload. Reads BAGGERS (QTY) and LOADERS (BAGS LOADED) exactly as the legacy Fido
// workbook lays them out.
router.post('/production-override/import', requireAuth, xlsUpload.single('file'), async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;              // SNR_ACCOUNTANT+
  // A dry run writes nothing, so it does not need the Admin's permission. The
  // accountant can check a sheet parses and matches BEFORE asking for the gate to
  // be opened — otherwise the one enable gets burnt on a typo.
  const dryRun = String(req.body?.dry_run || '') === '1' || req.body?.dry_run === true;
  if (!dryRun && !await overrideEnabled()) {
    return res.status(403).json({
      error: 'Spreadsheet override is switched off. An Admin must enable it for this upload.',
      code: 'OVERRIDE_DISABLED',
    });
  }
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer' }); } catch { return res.status(400).json({ error: 'unreadable spreadsheet' }); }

  // The staff pool is company-wide, like every other payroll path: one workbook
  // covers Fido and Fiafia sites together.
  const tenants = await payrollGroup(req.user, c.tenant_id, c);
  if (!tenants.length) return res.status(400).json({ error: 'no active workspaces' });
  const ph = tenants.map(() => '?').join(',');
  const staff = await qall(`SELECT s.id, s.tenant_id, s.site_id, s.full_name, s.ext_people_id, s.staff_type, s.pay_type,
      s.payroll_eligible, s.status, s.bank_name, s.bank_account FROM staff s WHERE s.tenant_id IN (${ph})`, tenants);
  // An ambiguous match is NOT a match. `null` marks a key that two staff records
  // claim; the row is reported unmatched so a human decides, because paying the
  // wrong Blessing is worse than paying nobody and saying so.
  //
  // ext_people_id has no unique constraint and the pool spans every tenant, so
  // Fido and Fiafia can genuinely share a legacy id — the id needs the same
  // ambiguity check the name gets, not a silent last-one-wins overwrite.
  const byExt = {}, byName = {};
  for (const s of staff) {
    const e = s.ext_people_id == null ? '' : String(s.ext_people_id).replace(/\.0$/, '').trim();
    if (e) byExt[e] = (e in byExt) ? null : s;
    const n = nameKey(s.full_name);
    if (n) byName[n] = (n in byName) ? null : s;
  }

  const norm = (k) => String(k || '').trim().toUpperCase();
  const num = (v) => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[, ₦]/g, '')); return isNaN(n) ? null : n; };

  let mixedPeriod = null;
  const matched = new Map();       // staff_id → { staff, loaded, bagged, row }
  const unmatched = [];
  // Read the window and the cycle OFF THE SHEET. The accountant already stated
  // both in the file; letting a request field win would let a mid-month sheet be
  // stamped as month-end and then paid at six times the rate. The body values are
  // a fallback for a sheet that carries no dates, and are cross-checked below.
  let pFrom = null, pTo = null, sheetKind = null;

  const readSheet = (sheetName, kind) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    for (const row of rows) {
      const get = (names) => { for (const k of Object.keys(row)) if (names.includes(norm(k))) return row[k]; return undefined; };
      const ext = String(get(['ID', 'STAFF ID', 'EXT ID']) ?? '').replace(/\.0$/, '').trim();
      const full = [get(['FIRST NAME']), get(['MIDDLE NAME']), get(['LAST NAME'])]
        .map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
      const qty = num(kind === 'LOADERS'
        ? get(['BAGS LOADED', 'QTY', 'LOADED'])
        : get(['QTY', 'BAGS BAGGED', 'BAGGED']));
      // The sheet's own TOTAL row is a footer, not a person.
      if (/^total$/i.test(full) || (!ext && !full)) continue;
      if (/HIRED/i.test(full)) continue;    // day-labour placeholders, paid cash

      const rFrom = asDate(get(['PAY START DATE', 'PERIOD FROM', 'FROM']));
      const rTo = asDate(get(['PAY END DATE', 'PERIOD TO', 'TO']));
      // Rows that disagree about the period are not a detail to ignore — it means
      // two pay runs got pasted into one file. Refuse rather than pay the first
      // row's window to everybody.
      if (rFrom && rTo) {
        if (pFrom && (rFrom !== pFrom || rTo !== pTo)) mixedPeriod = `${rFrom}..${rTo} vs ${pFrom}..${pTo}`;
        pFrom = pFrom || rFrom; pTo = pTo || rTo;
      }
      const pt = String(get(['PAY TYPE', 'TYPE']) ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
      if (!sheetKind && pt) sheetKind = pt.startsWith('MIDMONTH') ? 'MIDMONTH' : (pt.startsWith('MONTHEND') ? 'MONTHEND' : null);

      const loc = String(get(['LOCATION']) ?? '').trim();
      const note = (reason) => unmatched.push({
        ext_id: ext || null, full_name: full || null, location: loc || null,
        designation: kind === 'LOADERS' ? 'LOADER' : 'BAGGER', bags: qty || 0, reason,
      });

      if (qty == null || qty <= 0) { note('no quantity on the row'); continue; }
      // Ambiguity is checked BEFORE the not-found message, or a person who exists
      // on the roster TWICE gets reported as "not on the roster" — which invites
      // the accountant to create a third duplicate.
      const nk = nameKey(full);
      if (ext && byExt[ext] === null) { note(`ID ${ext} belongs to more than one staff record`); continue; }
      if (!byExt[ext] && nk && byName[nk] === null) { note('name matches more than one staff record'); continue; }
      const st = byExt[ext] || (nk ? byName[nk] : null);
      if (!st) { note(ext ? `no staff with ID ${ext}` : 'name not on the roster'); continue; }
      // These guards MUST mirror the compute paths exactly. Anyone the import
      // accepts but a run later filters out is written into the batch, counted in
      // "N staff overridden", and then silently paid nothing — the exact failure
      // this feature exists to fix, wearing a green tick.
      if (!isPieceWorker(st)) { note(`${st.full_name} is ${st.staff_type || st.pay_type || 'non-piece'} staff`); continue; }
      if (String(st.status || '') !== 'ACTIVE') { note(`${st.full_name} is ${String(st.status || 'not active').toLowerCase()} — payroll only pays ACTIVE staff`); continue; }
      if (st.payroll_eligible === false) { note(`${st.full_name} is parked out of payroll`); continue; }
      if (/HIRED/i.test(st.full_name || '')) { note(`${st.full_name} is a day-labour placeholder, paid cash`); continue; }

      const cur = matched.get(st.id) || { staff: st, loaded: 0, bagged: 0, rows: [], acct: '' };
      if (kind === 'LOADERS') cur.loaded += qty; else cur.bagged += qty;
      cur.rows.push(`${sheetName}:${ext || full}`);
      // "FCMB-6689114019" — the same BANK-ACCOUNT form the staff importer reads.
      cur.acct = cur.acct || String(get(['ACCOUNT NUMBER', 'ACCOUNT']) ?? '').trim();
      matched.set(st.id, cur);
    }
  };

  for (const kind of ['BAGGERS', 'LOADERS']) {
    const name = Object.keys(wb.Sheets).find((n) => norm(n) === kind);
    if (name) readSheet(name, kind);
  }
  if (!matched.size && !unmatched.length) {
    return res.status(400).json({ error: 'no BAGGERS or LOADERS sheet found in that file' });
  }
  if (mixedPeriod) {
    return res.status(400).json({ error: `the sheet covers more than one pay period (${mixedPeriod}) — split it and upload one period at a time` });
  }
  if (!pFrom || !pTo) { pFrom = pFrom || asDate(req.body?.period_from); pTo = pTo || asDate(req.body?.period_to); }
  if (!pFrom || !pTo) {
    return res.status(400).json({ error: 'could not read the pay period — use a sheet with PAY START DATE / PAY END DATE, or send period_from and period_to' });
  }
  if (pFrom > pTo) return res.status(400).json({ error: 'the pay period starts after it ends' });

  // The sheet's own PAY TYPE decides the cycle, because the cycle decides the
  // rate (₦1 vs ₦6 a bag). A caller-supplied kind is honoured only when it
  // AGREES with the sheet, or when the sheet does not say.
  const kindIn = String(req.body?.kind || '').toUpperCase();
  const asked = kindIn === 'MONTHEND' || kindIn === 'MIDMONTH' ? kindIn : null;
  if (asked && sheetKind && asked !== sheetKind) {
    return res.status(400).json({ error: `the sheet says ${sheetKind}, but the upload asked for ${asked}` });
  }
  const kind = sheetKind || asked || 'MIDMONTH';

  const rows0 = [...matched.values()];
  const totals = rows0.reduce((a, r) => ({ bagged: a.bagged + r.bagged, loaded: a.loaded + r.loaded }), { bagged: 0, loaded: 0 });

  // Show the MONEY, not just the bag counts. The accountant is checking this
  // against their own workbook total, and bags at ₦1 vs ₦6 is the single most
  // consequential thing to get wrong — so price it at the rate this batch's kind
  // will actually be paid at, and say which rate that is.
  // BANK DETAILS FROM THE SHEET.
  //
  // The bank file is only as good as the account numbers behind it, and the
  // accountant's workbook is where those are actually maintained. So: fill a
  // BLANK on the roster, and never overwrite one that differs — that is
  // redirecting somebody's wages, and it needs a person to decide, not an
  // upload. Differences are recorded and shown.
  const digits = accountDigits;
  for (const r of rows0) {
    const parsed = parseBankFields(r.acct, null);
    r.sheetBank = parsed.bank_name || '';
    r.sheetAcct = parsed.bank_account || '';
    const have = digits(r.staff.bank_account);
    const want = parsed.bank_account || '';
    if (!want) { r.bankNote = have ? null : 'no account on the sheet or the roster'; r.bankAction = 'NONE'; }
    else if (!have) { r.bankNote = `filled from sheet: ${r.sheetBank}-${r.sheetAcct}`; r.bankAction = 'FILL'; }
    else if (have !== want) { r.bankNote = `sheet says ${r.sheetBank}-${r.sheetAcct}, roster has ${r.staff.bank_name || '?'}-${r.staff.bank_account} — NOT changed`; r.bankAction = 'CONFLICT'; }
    else { r.bankNote = null; r.bankAction = 'SAME'; }
  }
  const bankFilled = rows0.filter((r) => r.bankAction === 'FILL').length;
  const bankConflicts = rows0.filter((r) => r.bankAction === 'CONFLICT').length;
  const bankMissing = rows0.filter((r) => r.bankAction === 'NONE' && r.bankNote).length;

  const pRates = await getBagRates(kind);
  const sites = await qall('SELECT id, name FROM sites');
  const siteName = {}; for (const st of sites) siteName[st.id] = st.name;
  const rows = rows0;
  const priced = rows.map((r) => ({
    staff_id: r.staff.id,
    full_name: r.staff.full_name,
    ext_id: r.staff.ext_people_id || '',
    site_name: siteName[r.staff.site_id] || '—',
    account: accountDigits(r.sheetAcct || r.staff.bank_account),
    bank_note: r.bankNote || null,
    designation: r.loaded >= r.bagged ? 'LOADER' : 'BAGGER',
    bags_loaded: r2(r.loaded), bags_bagged: r2(r.bagged),
    amount: r2(r.loaded * (pRates.loaded || 0) + r.bagged * (pRates.bagged || 0)),
  })).sort((a, b) => a.site_name.localeCompare(b.site_name) || a.full_name.localeCompare(b.full_name));

  const preview = {
    period_from: pFrom, period_to: pTo, kind,
    matched: rows.length, unmatched: unmatched.length,
    total_bagged: r2(totals.bagged), total_loaded: r2(totals.loaded),
    rates: pRates,
    total_amount: r2(priced.reduce((a, x) => a + x.amount, 0)),
    bank_filled: bankFilled, bank_conflicts: bankConflicts, bank_missing: bankMissing,
    bank_notes: rows.filter((r) => r.bankNote).map((r) => ({ full_name: r.staff.full_name, note: r.bankNote })).slice(0, 200),
    // Everyone the sheet will pay, and everyone it will not. Both lists matter:
    // the second is people who worked and would otherwise vanish from the run.
    rows: priced,
    unmatched_rows: unmatched.slice(0, 400),
  };
  if (dryRun) return res.json({ dry_run: true, ...preview });

  const batchId = uuid();
  // EVERY statement below goes through the transaction's own client. Using the
  // pooled qrun here would put the DELETE and the INSERTs on other connections,
  // so the BEGIN/COMMIT would wrap nothing — and since the first act is to delete
  // the previous batch, a mid-way failure would leave the old numbers destroyed
  // and the new ones half-written. That is silent non-payment.
  try {
    await withTransaction(async (client) => {
      const tx = clientQ(client);

      // Consume the enable ATOMICALLY. The earlier overrideEnabled() read is only
      // a fast fail for the common case; two accountants uploading against one
      // Admin enable would both pass it. This UPDATE is the real gate: whoever
      // flips 1→0 owns the upload, and the loser is told to ask again.
      const gate = await tx.qrun('UPDATE payroll_settings SET value=0, updated_at=? WHERE key=? AND value>0', [nowS(), OVERRIDE_FLAG]);
      if (!gate.rowCount) { const e = new Error('OVERRIDE_TAKEN'); e.code = 'OVERRIDE_TAKEN'; throw e; }

      // One live batch per period+kind. Re-uploading a corrected sheet replaces
      // the previous attempt rather than stacking a second set of numbers on it.
      const old = await tx.qall('SELECT id FROM production_override_batch WHERE period_from=? AND period_to=? AND kind=?', [pFrom, pTo, kind]);
      for (const b of old) await tx.qrun('DELETE FROM production_override_batch WHERE id=?', [b.id]);

      await tx.qrun(`INSERT INTO production_override_batch
        (id,period_from,period_to,kind,file_name,note,matched,unmatched,total_bagged,total_loaded,bank_filled,bank_conflicts,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [batchId, pFrom, pTo, kind, req.file.originalname || null, req.body?.note || null,
        rows.length, unmatched.length, r2(totals.bagged), r2(totals.loaded),
        bankFilled, bankConflicts, req.user.id, nowS()]);

      for (const r of rows) {
        await tx.qrun(`INSERT INTO production_override (id,batch_id,tenant_id,staff_id,site_id,bags_loaded,bags_bagged,source_row,sheet_bank,sheet_account,bank_note)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), batchId, r.staff.tenant_id, r.staff.id, r.staff.site_id || null, r2(r.loaded), r2(r.bagged),
          r.rows.join(', '), r.sheetBank || null, r.sheetAcct || null, r.bankNote || null]);

        // Fill a blank only. A staff record that already has an account keeps it;
        // the difference is reported instead. Wages go where the roster says.
        if (r.bankAction === 'FILL') {
          await tx.qrun(`UPDATE staff SET bank_name=COALESCE(NULLIF(bank_name,''),?), bank_account=COALESCE(NULLIF(bank_account,''),?)
            WHERE id=?`, [r.sheetBank || null, r.sheetAcct || null, r.staff.id]);
        }
      }
      for (const u of unmatched) {
        await tx.qrun(`INSERT INTO production_override_unmatched (id,batch_id,ext_id,full_name,location,designation,bags,reason)
          VALUES (?,?,?,?,?,?,?,?)`,
        [uuid(), batchId, u.ext_id, u.full_name, u.location, u.designation, u.bags, u.reason]);
      }
    });
  } catch (e) {
    if (e.code === 'OVERRIDE_TAKEN') {
      return res.status(409).json({ error: 'Another upload used the Admin\'s enable first. Ask for it to be enabled again.', code: 'OVERRIDE_TAKEN' });
    }
    // Nothing was written — the transaction rolled back, including the gate, so
    // the enable is still available for a retry.
    return res.status(500).json({ error: `Import failed, nothing was changed: ${e.message}` });
  }

  await audit(c.tenant_id, req.user.id, 'override.import', 'production_override_batch', batchId,
    { period: `${pFrom}..${pTo}`, kind, matched: rows.length, unmatched: unmatched.length });
  res.json({ batch_id: batchId, ...preview, enabled_now: false });
});

router.get('/production-override/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const b = await qone('SELECT * FROM production_override_batch WHERE id=?', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'not found' });
  const { sql, args } = scopeSql(c, 'o.tenant_id');
  const rows = await qall(`SELECT o.*, s.full_name, s.ext_people_id, s.staff_type, st.name site_name, t.name tenant_name
    FROM production_override o
    JOIN staff s ON s.id=o.staff_id
    LEFT JOIN sites st ON st.id=o.site_id
    LEFT JOIN tenants t ON t.id=o.tenant_id
    WHERE o.batch_id=? AND ${sql} ORDER BY t.name, st.name, s.full_name`, [req.params.id, ...args]);
  const unmatched = await qall('SELECT * FROM production_override_unmatched WHERE batch_id=? ORDER BY location, full_name', [req.params.id]);
  res.json({ batch: b, rows, unmatched });
});

// Revert. The whole point of keeping this out of `production` is that undoing it
// is one delete and leaves no trace in the daily records.
router.delete('/production-override/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'ADMIN'); if (!c) return;
  const b = await qone('SELECT * FROM production_override_batch WHERE id=?', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'not found' });
  await qrun('DELETE FROM production_override_batch WHERE id=?', [req.params.id]);
  await audit(c.tenant_id, req.user.id, 'override.delete', 'production_override_batch', req.params.id,
    { period: `${b.period_from}..${b.period_to}`, kind: b.kind });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MONTH-END PAYROLL SHEET UPLOAD (side-by-side with computed payroll)
// SNR_ACCOUNTANT+ can upload without Admin enabling sheet_override_enabled.
// Stored independently — does not mutate pay_runs or production.
// ═══════════════════════════════════════════════════════════════════════════════

const SHEET_KIND_REGULAR = 'REGULAR';
const SHEET_KIND_MIDMONTH = 'MIDMONTH';

// Shared Excel helpers (also used by production-override above).
const xlsNorm = (k) => String(k || '').trim().toUpperCase();
const xlsNum = (v) => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[, ₦]/g, ''));
  return isNaN(n) ? null : n;
};
const xlsGet = (row, names) => {
  for (const k of Object.keys(row)) if (names.includes(xlsNorm(k))) return row[k];
  return undefined;
};

function resolveStaffForSheet(ext, full, staffPool, opts = {}) {
  const extNorm = ext ? String(ext).replace(/\.0$/, '').trim() : '';
  const nk = nameKey(full);
  const { workspaceTenantId, preferredTenantId, siteByName, location } = opts;

  let candidates = [];
  if (extNorm) {
    candidates = staffPool.filter((s) => {
      const e = s.ext_people_id == null ? '' : String(s.ext_people_id).replace(/\.0$/, '').trim();
      return e === extNorm;
    });
  }
  if (!candidates.length && nk) {
    candidates = staffPool.filter((s) => nameKey(s.full_name) === nk);
  }
  if (!candidates.length) {
    return {
      staff: null,
      reason: extNorm ? `no staff with ID ${extNorm}` : (full ? 'name not on the roster' : 'no Staff ID or name'),
    };
  }
  if (candidates.length === 1) return { staff: candidates[0], reason: null };

  const loc = String(location || '').trim().toLowerCase();
  let locTenant = null;
  if (loc && siteByName?.[loc]?.length) {
    const matches = siteByName[loc];
    const site = matches.length === 1 ? matches[0]
      : matches.find((m) => m.tenant_id === preferredTenantId) || matches[0];
    locTenant = site?.tenant_id || null;
  }
  const pickFrom = (list, subset) => (subset.length ? subset : list);
  let pool = candidates;
  if (locTenant) pool = pickFrom(pool, pool.filter((s) => s.tenant_id === locTenant));
  if (workspaceTenantId) pool = pickFrom(pool, pool.filter((s) => s.tenant_id === workspaceTenantId));
  if (preferredTenantId) pool = pickFrom(pool, pool.filter((s) => s.tenant_id === preferredTenantId));
  return { staff: pickPayrollHead(pool), reason: null, resolved_ambiguous: true };
}

// Group roll-up spans Fido + Fiafia; a single-workspace upload should match/create
// only within that workspace so cross-tenant duplicates do not block linking.
function sheetStaffTenants(c, payrollTenants) {
  return c.group ? payrollTenants : [c.tenant_id];
}

// Parse REGULAR / BAGGERS / LOADERS from a month-end workbook. Returns sheet
// values as-is — no staff updates, no pay_run mutations.
function parsePayrollSheetWorkbook(wb, staff, body = {}) {
  let pFrom = null;
  let pTo = null;
  let sheetKind = null;
  let mixedPeriod = null;
  const lines = [];
  const unmatched = [];

  const readSheet = (sheetName, sheetKindName) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const ext = String(xlsGet(row, ['ID', 'STAFF ID', 'EXT ID']) ?? '').replace(/\.0$/, '').trim();
      const full = [xlsGet(row, ['FIRST NAME']), xlsGet(row, ['MIDDLE NAME']), xlsGet(row, ['LAST NAME'])]
        .map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
      if (/^total$/i.test(full) || (!ext && !full)) continue;
      if (/HIRED/i.test(full)) continue;

      const rFrom = asDate(xlsGet(row, ['PAY START DATE', 'PERIOD FROM', 'FROM']));
      const rTo = asDate(xlsGet(row, ['PAY END DATE', 'PERIOD TO', 'TO']));
      if (rFrom && rTo) {
        if (pFrom && (rFrom !== pFrom || rTo !== pTo)) mixedPeriod = `${rFrom}..${rTo} vs ${pFrom}..${pTo}`;
        pFrom = pFrom || rFrom;
        pTo = pTo || rTo;
      }
      const pt = String(xlsGet(row, ['PAY TYPE', 'TYPE']) ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
      if (!sheetKind && pt) sheetKind = pt.startsWith('MIDMONTH') ? SHEET_KIND_MIDMONTH : (pt.startsWith('MONTHEND') ? 'MONTHEND' : null);

      const ded = xlsNum(xlsGet(row, ['DEDUCTION', 'SALARY ADV', 'ADVANCE'])) || 0;
      let days = 0;
      let loaded = 0;
      let bagged = 0;
      let baseSalary = 0;
      let gross = 0;
      let net = 0;

      if (sheetKindName === 'REGULAR') {
        days = xlsNum(xlsGet(row, ['DAYS WORKED', 'DAYS'])) || 0;
        const daysAbs = xlsNum(xlsGet(row, ['DAYS ABS', 'DAYS ABSENT', 'ABSENT']));
        baseSalary = xlsNum(xlsGet(row, ['BASE SALARY', 'MONTHLY SALARY', 'SALARY'])) || 0;
        net = xlsNum(xlsGet(row, ['NET SALARY', 'NET PAY', 'NET'])) || 0;
        gross = xlsNum(xlsGet(row, ['GROSS', 'GROSS PAY'])) || (net + ded);
        if (!days && daysAbs != null) row._days_abs = daysAbs;
      } else if (sheetKindName === 'BAGGERS') {
        bagged = xlsNum(xlsGet(row, ['QTY', 'BAGS BAGGED', 'BAGGED'])) || 0;
        gross = xlsNum(xlsGet(row, ['COMMISSION', 'GROSS', 'NET PAY (COMMISSION)'])) || 0;
        net = xlsNum(xlsGet(row, ['NET PAY (COMMISSION)', 'NET', 'NET PAY'])) || Math.max(0, gross - ded);
        if (!gross && net) gross = net + ded;
      } else {
        loaded = xlsNum(xlsGet(row, ['BAGS LOADED', 'QTY', 'LOADED'])) || 0;
        gross = xlsNum(xlsGet(row, ['NET PAY (COMMISSION)', 'COMMISSION', 'GROSS'])) || 0;
        net = xlsNum(xlsGet(row, ['NET', 'NET PAY'])) || Math.max(0, gross - ded);
        if (!gross && net) gross = net + ded;
      }

      const hasPay = gross > 0 || net > 0 || days > 0 || loaded > 0 || bagged > 0;
      if (!hasPay) continue;

      const location = String(xlsGet(row, ['LOCATION', 'SITE']) ?? '').trim();
      const accountRaw = String(xlsGet(row, ['ACCOUNT NUMBER', 'ACCOUNT', 'BANK ACCOUNT']) ?? '').trim();
      const designation = String(xlsGet(row, ['DESIGNATION', 'ROLE', 'TITLE']) ?? '').trim();

      const { staff: st, reason } = resolveStaffForSheet(ext, full, staff, { location });
      const sheetRow = `${sheetName}:${i + 2}`;
      if (!st) {
        unmatched.push({ ext_id: ext || null, full_name: full || null, sheet_kind: sheetKindName, reason, sheet_row: sheetRow });
        lines.push({
          staff_id: null, tenant_id: null, ext_people_id: ext || null, name: full || null,
          days, loaded, bagged, base_salary: baseSalary, gross: r2(gross), deduction: r2(ded), net: r2(net),
          sheet_kind: sheetKindName, sheet_row: sheetRow, unmatched: true,
          days_abs: row._days_abs, location, account_raw: accountRaw, designation,
        });
        continue;
      }
      lines.push({
        staff_id: st.id, tenant_id: st.tenant_id, ext_people_id: st.ext_people_id || ext || null,
        name: st.full_name || full, days, loaded, bagged, base_salary: baseSalary,
        gross: r2(gross), deduction: r2(ded), net: r2(net), sheet_kind: sheetKindName, sheet_row: sheetRow,
        days_abs: row._days_abs, location, account_raw: accountRaw, designation,
      });
    }
  };

  for (const kind of ['REGULAR', 'BAGGERS', 'LOADERS']) {
    const name = Object.keys(wb.Sheets).find((n) => xlsNorm(n) === kind);
    if (name) readSheet(name, kind);
  }
  if (!lines.length) return { error: 'no REGULAR, BAGGERS or LOADERS sheet found in that file' };
  if (mixedPeriod) return { error: `the sheet covers more than one pay period (${mixedPeriod}) — split it and upload one period at a time` };

  if (!pFrom || !pTo) {
    pFrom = pFrom || asDate(body.period_from);
    pTo = pTo || asDate(body.period_to);
  }
  if (!pFrom || !pTo) return { error: 'could not read the pay period — use a sheet with PAY START DATE / PAY END DATE, or send period_from and period_to' };
  if (pFrom > pTo) return { error: 'the pay period starts after it ends' };

  const periodWorkingDays = workingDays(pFrom, pTo);
  for (const l of lines) {
    if (l.sheet_kind === 'REGULAR') {
      if (!l.days && l.days_abs != null) {
        l.days = Math.max(0, periodWorkingDays - l.days_abs);
      }
      // Infer base salary from net + days when workbook omits BASE SALARY (Fido month-end export).
      if (!l.base_salary && l.net > 0 && l.days > 0 && l.days < periodWorkingDays) {
        l.base_salary = r2(l.net * periodWorkingDays / l.days);
        if (!l.gross) l.gross = r2(l.base_salary * l.days / periodWorkingDays);
      } else if (!l.base_salary && l.net > 0 && l.days >= periodWorkingDays) {
        l.base_salary = l.net;
      }
      delete l.days_abs;
    }
  }

  const kindIn = String(body.kind || '').toUpperCase();
  const asked = kindIn === 'MONTHEND' || kindIn === 'MIDMONTH' ? kindIn : (kindIn === SHEET_KIND_MIDMONTH ? 'MIDMONTH' : (kindIn === SHEET_KIND_REGULAR ? 'MONTHEND' : null));
  if (asked && sheetKind && asked !== sheetKind) {
    return { error: `the sheet says ${sheetKind}, but the upload asked for ${asked}` };
  }
  const runKind = sheetKind === 'MIDMONTH' ? SHEET_KIND_MIDMONTH : (asked === 'MIDMONTH' ? SHEET_KIND_MIDMONTH : SHEET_KIND_REGULAR);

  return {
    period_from: pFrom, period_to: pTo, kind: runKind, lines, unmatched,
    matched: lines.filter((l) => l.staff_id).length,
    line_count: lines.length,
    totals: {
      gross: r2(lines.reduce((a, l) => a + (l.gross || 0), 0)),
      deduction: r2(lines.reduce((a, l) => a + (l.deduction || 0), 0)),
      net: r2(lines.reduce((a, l) => a + (l.net || 0), 0)),
    },
  };
}

function sheetStaffType(sheetKind) {
  const k = String(sheetKind || '').toUpperCase();
  if (k === 'BAGGERS' || k === 'BAGGER') return 'BAGGER';
  if (k === 'LOADERS' || k === 'LOADER') return 'LOADER';
  return 'REGULAR';
}

function sheetPayType(sheetKind) {
  const st = sheetStaffType(sheetKind);
  // REGULAR month-end salary schedule → MONTHLY (prorated by DAYS WORKED).
  // Piece sections → PIECE. DAILY is only for non-sheet manual roster rows.
  return st === 'REGULAR' ? 'MONTHLY' : 'PIECE';
}

/**
 * Auto-create / update Daybook staff for unmatched month-end sheet rows, then
 * set payroll_sheet_lines.staff_id so generate-from-sheet includes them.
 *
 * Tenant rule (Group / combined workbook covering Fido + Fiafia):
 *   1. LOCATION matches exactly one site in the payroll group → that site's tenant
 *   2. LOCATION matches the same site name on more than one tenant → prefer Fido
 *   3. No LOCATION / unmatched location → prefer Fido if in scope, else the
 *      uploader's current workspace; attach to that tenant's first site by name
 *
 * Idempotent: re-upload matches by ext_people_id then nameKey and updates rather
 * than inserting duplicates. Duplicate roster rows (same ID or nameKey) are resolved
 * to the best existing staff record — not skipped.
 * Garbage rows (no Staff ID and no name, HIRED placeholders, TOTAL) are skipped.
 *
 * `q` is either the global helpers ({ qone, qall, qrun }) or a transaction clientQ.
 */
async function ensureStaffFromSheetLines(q, lines, opts = {}) {
  const tenantIds = tenantList(opts.tenantIds);
  const workspaceTenantId = opts.workspaceTenantId || tenantIds[0];
  const dryRun = !!opts.dryRun;
  if (!tenantIds.length || !lines?.length) {
    return { created: [], updated: [], skipped: [], tenant_rule: null };
  }

  const ph = tenantIds.map(() => '?').join(',');
  const tenants = await q.qall(`SELECT id, slug, name FROM tenants WHERE id IN (${ph})`, tenantIds);
  const fido = tenants.find((t) => String(t.slug || '').toLowerCase() === 'fido');
  const preferredTenantId = (fido && tenantIds.includes(fido.id)) ? fido.id : workspaceTenantId;
  const tenantRule = {
    preferred_tenant_id: preferredTenantId,
    preferred_slug: fido && preferredTenantId === fido.id ? 'fido' : null,
    note: 'LOCATION → site tenant; ambiguous site name → Fido; else Fido if in payroll group, else current workspace',
  };

  const sites = await q.qall(
    `SELECT id, tenant_id, name FROM sites WHERE tenant_id IN (${ph}) ORDER BY name, id`,
    tenantIds,
  );
  const siteByName = Object.create(null);
  const sitesByTenant = Object.create(null);
  for (const s of sites) {
    const k = String(s.name || '').trim().toLowerCase();
    if (k) (siteByName[k] = siteByName[k] || []).push(s);
    (sitesByTenant[s.tenant_id] = sitesByTenant[s.tenant_id] || []).push(s);
  }

  const resolveSite = (location) => {
    const loc = String(location || '').trim().toLowerCase();
    if (loc && siteByName[loc]?.length) {
      const matches = siteByName[loc];
      if (matches.length === 1) return { site: matches[0], how: 'location' };
      const prefer = matches.find((m) => m.tenant_id === preferredTenantId);
      return { site: prefer || matches[0], how: 'location_ambiguous_prefer_fido' };
    }
    const list = sitesByTenant[preferredTenantId] || sitesByTenant[workspaceTenantId] || [];
    if (!list.length) return { site: null, how: 'none' };
    return { site: list[0], how: loc ? 'location_unmatched_default' : 'default_preferred' };
  };

  let staffPool = await q.qall(
    `SELECT id, tenant_id, site_id, full_name, ext_people_id, staff_type, pay_type,
            bank_name, bank_account, daily_rate, status, payroll_eligible
       FROM staff WHERE tenant_id IN (${ph})`,
    tenantIds,
  );

  const created = [];
  const updated = [];
  const skipped = [];

  const applyLink = (line, st) => {
    line.staff_id = st.id;
    line.tenant_id = st.tenant_id;
    line.unmatched = false;
    if (!line.name) line.name = st.full_name;
    if (!line.ext_people_id && st.ext_people_id) line.ext_people_id = st.ext_people_id;
  };

  for (const line of lines) {
    if (line.staff_id) continue;

    const ext = line.ext_people_id == null ? '' : String(line.ext_people_id).replace(/\.0$/, '').trim();
    const full = String(line.name || '').trim();
    const hasPay = (Number(line.net) || 0) > 0 || (Number(line.gross) || 0) > 0
      || (Number(line.days) || 0) > 0 || (Number(line.loaded) || 0) > 0 || (Number(line.bagged) || 0) > 0;
    if (!hasPay) continue;
    if (!ext && !full) {
      skipped.push({ name: null, ext_people_id: null, reason: 'no Staff ID or name', sheet_row: line.sheet_row || null });
      continue;
    }
    if (/HIRED/i.test(full) || /^total$/i.test(full)) {
      skipped.push({ name: full || null, ext_people_id: ext || null, reason: 'placeholder / total row', sheet_row: line.sheet_row || null });
      continue;
    }

    // Rematch against the live pool (covers same-upload creates + re-upload idempotency).
    const rematch = resolveStaffForSheet(ext, full, staffPool, {
      workspaceTenantId, preferredTenantId, siteByName, location: line.location,
    });

    const staffType = sheetStaffType(line.sheet_kind);
    const payType = sheetPayType(line.sheet_kind);
    const baseSalary = staffType === 'REGULAR' ? (Number(line.base_salary) || 0) : 0;
    const designation = String(line.designation || '').trim() || staffType;
    const bank = parseBankFields(line.account_raw, null);

    if (rematch.staff) {
      const st = rematch.staff;
      const { site } = resolveSite(line.location);
      if (!dryRun) {
        // Fill blank bank only — never overwrite a different roster account.
        const haveAcct = accountDigits(st.bank_account);
        const wantAcct = bank.bank_account || '';
        const fillBank = wantAcct && !haveAcct;
        await q.qrun(
          `UPDATE staff SET
             full_name = COALESCE(NULLIF(?, ''), full_name),
             role_title = COALESCE(NULLIF(?, ''), role_title),
             staff_type = ?,
             pay_type = ?,
             payroll_eligible = TRUE,
             status = 'ACTIVE',
             ext_people_id = COALESCE(NULLIF(ext_people_id, ''), ?),
             site_id = COALESCE(site_id, ?),
             bank_name = CASE WHEN ? THEN ? ELSE bank_name END,
             bank_account = CASE WHEN ? THEN ? ELSE bank_account END,
             daily_rate = CASE WHEN ? > 0 THEN ? ELSE daily_rate END
           WHERE id = ?`,
          [
            full || null, designation, staffType, payType,
            ext || null, site ? site.id : null,
            fillBank, fillBank ? bank.bank_name : null,
            fillBank, fillBank ? bank.bank_account : null,
            baseSalary, baseSalary,
            st.id,
          ],
        );
        st.full_name = full || st.full_name;
        st.ext_people_id = st.ext_people_id || ext || null;
        st.staff_type = staffType;
        st.pay_type = payType;
        if (fillBank) {
          st.bank_name = bank.bank_name;
          st.bank_account = bank.bank_account;
        }
        if (baseSalary > 0) st.daily_rate = baseSalary;
        if (!st.site_id && site) st.site_id = site.id;
      }
      applyLink(line, st);
      updated.push({
        id: st.id, name: st.full_name || full, ext_people_id: st.ext_people_id || ext || null,
        staff_type: staffType, net: round2(line.net || 0), action: 'updated',
      });
      continue;
    }

    const { site, how } = resolveSite(line.location);
    if (!site) {
      skipped.push({
        name: full || null, ext_people_id: ext || null,
        reason: 'no site in payroll group to attach — create a site or set LOCATION',
        sheet_row: line.sheet_row || null,
      });
      continue;
    }

    const newId = uuid();
    if (!dryRun) {
      try {
        await q.qrun(
          `INSERT INTO staff
             (id, tenant_id, site_id, full_name, role_title, staff_type, pay_type,
              daily_rate, bank_name, bank_account, ext_people_id, status, payroll_eligible)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE', TRUE)`,
          [
            newId, site.tenant_id, site.id, full || ext, designation, staffType, payType,
            baseSalary, bank.bank_name, bank.bank_account, ext || null,
          ],
        );
      } catch (e) {
        // uq_staff_tenant_name_key (tenant + token-sorted name) — link existing instead of failing.
        const twins = await q.qall(
          `SELECT id, tenant_id, site_id, full_name, ext_people_id, staff_type, pay_type,
                  bank_name, bank_account, daily_rate, status, payroll_eligible
             FROM staff
            WHERE tenant_id=? AND ${STAFF_NAME_KEY_SQL} = ?
              AND COALESCE(status,'') <> 'LEFT'
            LIMIT 8`,
          [site.tenant_id, nameKey(full || ext)],
        );
        const twin = twins.length ? pickPayrollHead(twins) : null;
        if (twin) {
          applyLink(line, twin);
          updated.push({
            id: twin.id, name: twin.full_name || full, ext_people_id: twin.ext_people_id || ext || null,
            staff_type: staffType, net: round2(line.net || 0), action: 'linked_existing',
          });
          if (!staffPool.some((s) => s.id === twin.id)) staffPool.push(twin);
          continue;
        }
        skipped.push({
          name: full || null, ext_people_id: ext || null,
          reason: `could not create staff: ${e.message}`, sheet_row: line.sheet_row || null,
        });
        continue;
      }
    }

    const createdStaff = {
      id: dryRun ? `dry:${line.sheet_row || created.length}` : newId,
      tenant_id: site.tenant_id,
      site_id: site.id,
      full_name: full || ext,
      ext_people_id: ext || null,
      staff_type: staffType,
      pay_type: payType,
    };
    if (!dryRun) {
      staffPool.push(createdStaff);
    }
    applyLink(line, createdStaff);
    created.push({
      id: createdStaff.id,
      name: createdStaff.full_name,
      ext_people_id: ext || null,
      staff_type: staffType,
      tenant_id: site.tenant_id,
      site_id: site.id,
      site_how: how,
      net: round2(line.net || 0),
      action: 'created',
    });
  }

  return { created, updated, skipped, tenant_rule: tenantRule };
}

async function activeSheetUpload(tenantIds, periodFrom, periodTo, kind) {
  const ph = tenantIds.map(() => '?').join(',');
  return qone(`SELECT * FROM payroll_sheet_uploads
    WHERE tenant_id IN (${ph}) AND period_from=? AND period_to=? AND kind=? AND is_active=1
    ORDER BY uploaded_at DESC LIMIT 1`, [...tenantIds, periodFrom, periodTo, kind]);
}

async function sheetUploadFor(c, uploadId) {
  const ids = ctxTenants(c);
  return qone(`SELECT * FROM payroll_sheet_uploads WHERE id=? AND tenant_id IN (${ids.map(() => '?').join(',')})`,
    [uploadId, ...ids]);
}

function payrollSheetStorageKey(tenantId, periodFrom, periodTo, kind, uploadId, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const safeExt = SHEET_EXT_OK.has(ext) ? ext : '.xlsx';
  const period = `${periodFrom}_${periodTo}`.replace(/[^0-9_-]/g, '');
  const k = String(kind || 'REGULAR').replace(/[^A-Z0-9_-]/gi, '');
  return path.join(tenantId, period, `${k}_${uploadId}${safeExt}`);
}

function savePayrollSheetFile(buffer, tenantId, periodFrom, periodTo, kind, uploadId, originalName, mime) {
  const rel = payrollSheetStorageKey(tenantId, periodFrom, periodTo, kind, uploadId, originalName);
  const abs = path.join(PAYROLL_SHEET_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  return {
    stored_path: rel,
    file_size: buffer.length,
    content_type: mime || (rel.endsWith('.xls') ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  };
}

function resolvePayrollSheetPath(storedPath) {
  if (!storedPath || storedPath.includes('..') || path.isAbsolute(storedPath)) return null;
  const resolved = path.resolve(PAYROLL_SHEET_DIR, storedPath);
  const base = path.resolve(PAYROLL_SHEET_DIR) + path.sep;
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function removePayrollSheetFile(storedPath) {
  const p = resolvePayrollSheetPath(storedPath);
  if (!p) return;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

function payrollKindFromPieceOnly(pieceOnly) {
  return pieceOnly ? SHEET_KIND_MIDMONTH : SHEET_KIND_REGULAR;
}

function comparePayrollLines(computed, uploaded) {
  const byStaff = new Map();
  const byExt = new Map();
  for (const l of computed || []) {
    if (l.staff_id) byStaff.set(l.staff_id, l);
    const ext = l.ext_people_id == null ? '' : String(l.ext_people_id).replace(/\.0$/, '').trim();
    if (ext) byExt.set(ext, l);
  }

  const seen = new Set();
  const diffs = [];
  const addDiff = (computedLine, uploadedLine, source) => {
    const key = computedLine?.staff_id || uploadedLine?.staff_id || `ext:${uploadedLine?.ext_people_id || computedLine?.ext_people_id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const cNet = round2(computedLine?.net ?? computedLine?.gross ?? 0);
    const uNet = round2(uploadedLine?.net ?? 0);
    const delta = round2(uNet - cNet);
    let presence = 'both';
    if (!computedLine) presence = 'uploaded';
    else if (!uploadedLine) presence = 'computed';
    diffs.push({
      staff_id: computedLine?.staff_id || uploadedLine?.staff_id || null,
      ext_people_id: uploadedLine?.ext_people_id || computedLine?.ext_people_id || null,
      name: uploadedLine?.name || computedLine?.full_name || computedLine?.staff_name || '—',
      computed_net: cNet,
      uploaded_net: uNet,
      delta,
      presence,
      source,
    });
  };

  for (const u of uploaded || []) {
    const c = (u.staff_id && byStaff.get(u.staff_id))
      || (u.ext_people_id && byExt.get(String(u.ext_people_id).replace(/\.0$/, '').trim()))
      || null;
    addDiff(c, u, 'uploaded');
  }
  for (const c of computed || []) {
    const ext = c.ext_people_id == null ? '' : String(c.ext_people_id).replace(/\.0$/, '').trim();
    const matched = uploaded?.some((u) => (u.staff_id && u.staff_id === c.staff_id)
      || (ext && u.ext_people_id && String(u.ext_people_id).replace(/\.0$/, '').trim() === ext));
    if (!matched) addDiff(c, null, 'computed');
  }
  diffs.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return diffs;
}

router.post('/sheet-upload', requireAuth, xlsUpload.single('file'), async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  let wb;
  try { wb = XLSX.read(req.file.buffer, { type: 'buffer' }); } catch { return res.status(400).json({ error: 'unreadable spreadsheet' }); }

  const payrollTenants = await payrollGroup(req.user, c.tenant_id, c);
  if (!payrollTenants.length) return res.status(400).json({ error: 'no active workspaces' });
  const staffTenants = sheetStaffTenants(c, payrollTenants);
  const ph = staffTenants.map(() => '?').join(',');
  const staff = await qall(`SELECT s.id, s.tenant_id, s.full_name, s.ext_people_id FROM staff s WHERE s.tenant_id IN (${ph})`, staffTenants);

  const parsed = parsePayrollSheetWorkbook(wb, staff, req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const staffOpts = { tenantIds: staffTenants, workspaceTenantId: c.tenant_id };
  const dryRun = String(req.body?.dry_run || '') === '1' || req.body?.dry_run === true;
  if (dryRun) {
    const staffFromSheet = await ensureStaffFromSheetLines(
      { qone, qall, qrun },
      parsed.lines,
      { ...staffOpts, dryRun: true },
    );
    // Rebuild unmatched list after dry-run linking for an accurate preview summary.
    parsed.unmatched = parsed.lines
      .filter((l) => !l.staff_id)
      .map((l) => ({
        ext_id: l.ext_people_id || null, full_name: l.name || null,
        sheet_kind: l.sheet_kind, reason: 'still unmatched', sheet_row: l.sheet_row,
      }));
    parsed.matched = parsed.lines.filter((l) => l.staff_id).length;
    const sheetSummary = summarizeSheetLines(parsed.lines);
    return res.json({
      dry_run: true, file_name: req.file.originalname, ...parsed, sheet_summary: sheetSummary,
      staff_from_sheet: {
        created_count: staffFromSheet.created.length,
        updated_count: staffFromSheet.updated.length,
        skipped_count: staffFromSheet.skipped.length,
        created: staffFromSheet.created.slice(0, 80),
        updated: staffFromSheet.updated.slice(0, 40),
        skipped: staffFromSheet.skipped.slice(0, 40),
        tenant_rule: staffFromSheet.tenant_rule,
      },
    });
  }

  const uploadId = uuid();
  const scopeTenants = ctxTenants(c);
  let fileMeta;
  try {
    fileMeta = savePayrollSheetFile(req.file.buffer, c.tenant_id, parsed.period_from, parsed.period_to,
      parsed.kind, uploadId, req.file.originalname, req.file.mimetype);
  } catch (e) {
    return res.status(500).json({ error: `Could not store file: ${e.message}` });
  }

  let staffFromSheet = { created: [], updated: [], skipped: [], tenant_rule: null };
  try {
    await withTransaction(async (client) => {
      const tx = clientQ(client);
      // Create / link staff for unmatched rows BEFORE inserting lines so staff_id is set.
      staffFromSheet = await ensureStaffFromSheetLines(tx, parsed.lines, {
        ...staffOpts, dryRun: false,
      });

      const deactivatePh = scopeTenants.map(() => '?').join(',');
      await tx.qrun(`UPDATE payroll_sheet_uploads SET is_active=0, status='SUPERSEDED'
        WHERE tenant_id IN (${deactivatePh}) AND period_from=? AND period_to=? AND kind=? AND is_active=1`,
      [...scopeTenants, parsed.period_from, parsed.period_to, parsed.kind]);

      await tx.qrun(`INSERT INTO payroll_sheet_uploads
        (id, tenant_id, period_from, period_to, kind, file_name, uploaded_by, uploaded_at, status, is_active, line_count, stored_path, file_size, content_type)
        VALUES (?,?,?,?,?,?,?,?, 'ACTIVE', 1, ?, ?, ?, ?)`,
      [uploadId, c.tenant_id, parsed.period_from, parsed.period_to, parsed.kind,
        req.file.originalname || null, req.user.id, nowS(), parsed.line_count,
        fileMeta.stored_path, fileMeta.file_size, fileMeta.content_type]);

      for (const l of parsed.lines) {
        await tx.qrun(`INSERT INTO payroll_sheet_lines
          (id, upload_id, tenant_id, staff_id, ext_people_id, name, days, loaded, bagged, base_salary, gross, deduction, net, sheet_kind, sheet_row)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), uploadId, l.tenant_id, l.staff_id, l.ext_people_id, l.name,
          l.days, l.loaded, l.bagged, l.base_salary, l.gross, l.deduction, l.net, l.sheet_kind, l.sheet_row]);
      }
    });
  } catch (e) {
    removePayrollSheetFile(fileMeta.stored_path);
    return res.status(500).json({ error: `Upload failed: ${e.message}` });
  }

  parsed.unmatched = parsed.lines
    .filter((l) => !l.staff_id)
    .map((l) => ({
      ext_id: l.ext_people_id || null, full_name: l.name || null,
      sheet_kind: l.sheet_kind, reason: 'still unmatched', sheet_row: l.sheet_row,
    }));
  parsed.matched = parsed.lines.filter((l) => l.staff_id).length;
  const sheetSummary = summarizeSheetLines(parsed.lines);
  const staffPayload = {
    created_count: staffFromSheet.created.length,
    updated_count: staffFromSheet.updated.length,
    skipped_count: staffFromSheet.skipped.length,
    created: staffFromSheet.created.slice(0, 80),
    updated: staffFromSheet.updated.slice(0, 40),
    skipped: staffFromSheet.skipped.slice(0, 40),
    tenant_rule: staffFromSheet.tenant_rule,
  };
  await audit(c.tenant_id, req.user.id, 'sheet.upload', 'payroll_sheet_uploads', uploadId,
    {
      period: `${parsed.period_from}..${parsed.period_to}`, kind: parsed.kind, lines: parsed.line_count,
      unmatched: sheetSummary.unmatched_count,
      staff_created: staffPayload.created_count, staff_updated: staffPayload.updated_count,
    });
  res.status(201).json({
    id: uploadId, file_name: req.file.originalname, ...parsed,
    sheet_summary: sheetSummary, staff_from_sheet: staffPayload,
  });
});

router.get('/sheet-upload', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { period_from: pFrom, period_to: pTo, kind } = req.query;
  if (!pFrom || !pTo) return res.status(400).json({ error: 'period_from and period_to required' });
  const runKind = kind === SHEET_KIND_MIDMONTH || kind === 'MIDMONTH' ? SHEET_KIND_MIDMONTH : SHEET_KIND_REGULAR;
  const upload = await activeSheetUpload(ctxTenants(c), pFrom, pTo, runKind);
  if (!upload) return res.json({ upload: null, lines: [] });
  const lines = await qall('SELECT * FROM payroll_sheet_lines WHERE upload_id=? ORDER BY name', [upload.id]);
  const sheetSummary = summarizeSheetLines(lines);
  res.json({
    upload,
    lines,
    sheet_summary: sheetSummary,
    totals: {
      gross: r2(lines.reduce((a, l) => a + (l.gross || 0), 0)),
      deduction: r2(lines.reduce((a, l) => a + (l.deduction || 0), 0)),
      net: sheetSummary.uploaded_net,
    },
  });
});

router.get('/sheet-upload/history', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const ids = ctxTenants(c);
  const ph = ids.map(() => '?').join(',');
  const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10) || 200, 1), 500);
  const rows = await qall(
    `SELECT u.*, usr.name AS uploaded_by_name,
            pr.id AS run_id, pr.status AS run_status, pr.pay_source AS run_pay_source,
            t.name AS tenant_name
       FROM payroll_sheet_uploads u
       LEFT JOIN users usr ON usr.id = u.uploaded_by
       LEFT JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN LATERAL (
         SELECT id, status, pay_source FROM pay_runs
          WHERE sheet_upload_id = u.id
          ORDER BY created_at DESC LIMIT 1
       ) pr ON TRUE
      WHERE u.tenant_id IN (${ph})
      ORDER BY u.uploaded_at DESC
      LIMIT ${limit}`,
    ids,
  );
  res.json({
    uploads: rows.map((u) => ({
      id: u.id,
      tenant_id: u.tenant_id,
      tenant_name: u.tenant_name,
      period_from: u.period_from,
      period_to: u.period_to,
      kind: u.kind,
      file_name: u.file_name,
      uploaded_by: u.uploaded_by,
      uploaded_by_name: u.uploaded_by_name,
      uploaded_at: u.uploaded_at,
      status: u.status,
      is_active: !!u.is_active,
      line_count: u.line_count,
      file_size: u.file_size,
      has_file: !!(u.stored_path),
      run_id: u.run_id || null,
      run_status: u.run_status || null,
      run_pay_source: u.run_pay_source || null,
    })),
  });
});

router.get('/sheet-upload/:id/lines', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const upload = await sheetUploadFor(c, req.params.id);
  if (!upload) return res.status(404).json({ error: 'not found' });
  const lines = await qall('SELECT * FROM payroll_sheet_lines WHERE upload_id=? ORDER BY name', [upload.id]);
  const sheetSummary = summarizeSheetLines(lines);
  res.json({
    upload,
    lines,
    sheet_summary: sheetSummary,
    totals: {
      gross: r2(lines.reduce((a, l) => a + (l.gross || 0), 0)),
      deduction: r2(lines.reduce((a, l) => a + (l.deduction || 0), 0)),
      net: sheetSummary.uploaded_net,
    },
  });
});

router.get('/sheet-upload/:id/download', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const upload = await sheetUploadFor(c, req.params.id);
  if (!upload) return res.status(404).json({ error: 'not found' });
  if (!upload.stored_path) {
    return res.status(404).json({ error: 'file not stored — uploaded before file retention was enabled' });
  }
  const p = resolvePayrollSheetPath(upload.stored_path);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'file not found on server' });
  return res.download(p, upload.file_name || path.basename(p));
});

router.delete('/sheet-upload/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const upload = await sheetUploadFor(c, req.params.id);
  if (!upload) return res.status(404).json({ error: 'not found' });
  await qrun('UPDATE payroll_sheet_uploads SET is_active=0, status=? WHERE id=?', ['DELETED', upload.id]);
  await audit(c.tenant_id, req.user.id, 'sheet.delete', 'payroll_sheet_uploads', upload.id,
    { period: `${upload.period_from}..${upload.period_to}`, kind: upload.kind });
  res.json({ ok: true });
});

router.get('/compare', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { period_from: pFrom, period_to: pTo, kind, combined, site, piece_only } = req.query;
  if (!pFrom || !pTo) return res.status(400).json({ error: 'period_from and period_to required' });
  const pieceOnly = piece_only === '1' || piece_only === 'true';
  const runKind = kind === SHEET_KIND_MIDMONTH || kind === 'MIDMONTH' ? SHEET_KIND_MIDMONTH : SHEET_KIND_REGULAR;
  const rates = await getBagRates(pieceOnly ? 'MIDMONTH' : 'MONTHEND');
  const isCombined = combined === '1' || combined === 'true' || c.group;
  const siteId = siteBound(c) ? c.site_id : (site || null);

  const computed = isCombined
    ? await computeCombinedLines(await payrollGroup(req.user, c.tenant_id, c), pFrom, pTo, rates, pieceOnly, siteId)
    : await computeLines(c.tenant_id, pFrom, pTo, siteId, rates, pieceOnly);

  const staffIds = (computed || []).map((l) => l.staff_id).filter(Boolean);
  const extByStaff = {};
  if (staffIds.length) {
    const ph = staffIds.map(() => '?').join(',');
    for (const s of await qall(`SELECT id, ext_people_id FROM staff WHERE id IN (${ph})`, staffIds)) {
      extByStaff[s.id] = s.ext_people_id;
    }
  }

  const computedLines = (computed || []).map((l) => ({
    staff_id: l.staff_id,
    ext_people_id: extByStaff[l.staff_id] || null,
    full_name: l.full_name,
    gross: l.gross,
    net: round2(Math.max(0, (l.gross || 0) - (l.advance || 0))),
    deduction: l.advance || 0,
  }));

  const upload = await activeSheetUpload(ctxTenants(c), pFrom, pTo, runKind);
  const uploaded = upload
    ? await qall('SELECT * FROM payroll_sheet_lines WHERE upload_id=? ORDER BY name', [upload.id])
    : [];

  const diffs = comparePayrollLines(computedLines, uploaded);
  const sheetSummary = upload ? summarizeSheetLines(uploaded) : null;
  res.json({
    period_from: pFrom,
    period_to: pTo,
    kind: runKind,
    upload,
    computed: computedLines,
    uploaded,
    diffs,
    sheet_summary: sheetSummary,
    totals: {
      computed: {
        gross: round2(computedLines.reduce((a, l) => a + (l.gross || 0), 0)),
        net: round2(computedLines.reduce((a, l) => a + (l.net || 0), 0)),
      },
      uploaded: upload ? {
        gross: r2(uploaded.reduce((a, l) => a + (l.gross || 0), 0)),
        net: sheetSummary.uploaded_net,
        matched_net: sheetSummary.matched_net,
        unmatched_net: sheetSummary.unmatched_net,
        unmatched_count: sheetSummary.unmatched_count,
      } : null,
    },
  });
});

// Send the mid-month draft + Fido CSV to the accountants — on request, never
// automatically. Returns who it went to so the sender can see it landed.
router.post('/runs2/:id/email', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const run = await runFor(c, req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const lines = await qone('SELECT COUNT(*) n FROM pay_run_lines WHERE run_id=?', [run.id]);
  if (!Number(lines?.n)) return res.status(400).json({ error: 'nothing to send — this run has no lines' });
  const tenants = await payrollGroup(req.user, run.tenant_id, c);
  try {
    await emailMidMonth(run.tenant_id, run.id, tenants);
  } catch (e) {
    return res.status(500).json({ error: `could not send: ${e.message}` });
  }
  // emailMidMonth swallows its own failures into email_log, so read the outcome
  // back rather than reporting success just because the call returned.
  const sent = await qone('SELECT to_addrs, status, error FROM email_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT 1', [run.tenant_id]).catch(() => null);
  if (sent && sent.status === 'FAILED') return res.status(502).json({ error: `mail server refused it: ${sent.error || 'unknown error'}` });
  await audit(run.tenant_id, req.user.id, 'PAYROLL_RUN_EMAIL', 'pay_runs', run.id, { period: `${run.period_from}..${run.period_to}` });
  res.json({ ok: true, recipients: sent?.to_addrs || null, status: sent?.status || 'SENT' });
});

module.exports = router;
module.exports.generateMidMonth = generateMidMonth;
module.exports.emailMidMonth = emailMidMonth;
