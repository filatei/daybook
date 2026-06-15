/**
 * Daybook — Expenses module (Phase 3)
 *
 * Site managers log daily operational expenses directly here.
 * These roll up into the daily report's `expenses` field and are
 * visible in the AI assistant via the query_daybook tool.
 *
 * Mounted at /api/expenses
 */
'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');
const { requireAuth, contextFor, accessibleTenants, requestedTenant, atLeast } = require('./auth');

const router = express.Router();

const EXPENSE_CATS = ['DIESEL', 'SALARY', 'MAINTENANCE', 'TRANSPORT', 'UTILITIES', 'SUPPLIES', 'OTHER'];

// ── helpers ───────────────────────────────────────────────────────────────────
async function expenseAccess(req, expenseId) {
  const e = await qone('SELECT * FROM expenses WHERE id=?', [expenseId]);
  if (!e) return null;
  const c = await contextFor(req.user, e.tenant_id);
  if (!c) return null;
  if (c.role === 'SITE_MANAGER' && e.site_id && e.site_id !== c.site_id) return null;
  return { expense: e, ctx: c };
}

// ── GET /expenses ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  if (!tid) return res.status(400).json({ error: 'select a workspace' });
  const c = await contextFor(req.user, tid);
  if (!c) return res.status(403).json({ error: 'forbidden' });

  const { site, from, to, category } = req.query;
  const where = ['e.tenant_id=?'], args = [tid];

  if (c.role === 'SITE_MANAGER') { where.push('e.site_id=?'); args.push(c.site_id); }
  else if (site) { where.push('e.site_id=?'); args.push(site); }
  if (from) { where.push('e.expense_date>=?'); args.push(from); }
  if (to)   { where.push('e.expense_date<=?'); args.push(to); }
  if (category) { where.push('e.category=?'); args.push(category.toUpperCase()); }

  const rows = await qall(
    `SELECT e.*, s.name site_name, s.code site_code
       FROM expenses e LEFT JOIN sites s ON s.id=e.site_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 500`,
    args);
  res.json(rows);
});

// ── GET /expenses/summary ──────────────────────────────────────────────────────
router.get('/summary', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  if (!tid) return res.status(400).json({ error: 'select a workspace' });
  const c = await contextFor(req.user, tid);
  if (!c) return res.status(403).json({ error: 'forbidden' });

  const { from, to, site } = req.query;
  const where = ['e.tenant_id=?'], args = [tid];
  if (c.role === 'SITE_MANAGER') { where.push('e.site_id=?'); args.push(c.site_id); }
  else if (site) { where.push('e.site_id=?'); args.push(site); }
  if (from) { where.push('e.expense_date>=?'); args.push(from); }
  if (to)   { where.push('e.expense_date<=?'); args.push(to); }
  const W = 'WHERE ' + where.join(' AND ');

  const [totals, byCategory, bySite, byDay] = await Promise.all([
    qone(`SELECT COALESCE(SUM(amount),0) total, COUNT(*) count FROM expenses e ${W}`, args),
    qall(`SELECT category, COALESCE(SUM(amount),0) total FROM expenses e ${W} GROUP BY category ORDER BY total DESC`, args),
    qall(`SELECT s.name site, COALESCE(SUM(e.amount),0) total FROM expenses e JOIN sites s ON s.id=e.site_id ${W} GROUP BY s.id, s.name ORDER BY total DESC`, args),
    qall(`SELECT expense_date day, COALESCE(SUM(amount),0) total FROM expenses e ${W} GROUP BY expense_date ORDER BY expense_date DESC LIMIT 30`, args),
  ]);
  res.json({ totals: { ...totals, count: parseInt(totals.count, 10) }, byCategory, bySite, byDay: byDay.reverse() });
});

// ── GET /expenses/categories ───────────────────────────────────────────────────
router.get('/categories', requireAuth, (_req, res) => res.json(EXPENSE_CATS));

// ── POST /expenses ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  if (!tid) return res.status(400).json({ error: 'select a workspace' });
  const c = await contextFor(req.user, tid);
  if (!c || !atLeast(c.role, 'SITE_MANAGER')) return res.status(403).json({ error: 'forbidden' });

  const b = req.body || {};
  const site_id = c.role === 'SITE_MANAGER' ? c.site_id : (b.site_id || null);
  const expense_date = b.expense_date || new Date().toISOString().slice(0, 10);
  const amount = parseFloat(b.amount) || 0;
  if (!amount) return res.status(400).json({ error: 'amount required' });
  const category = EXPENSE_CATS.includes((b.category || '').toUpperCase()) ? b.category.toUpperCase() : 'OTHER';

  const id = uuid();
  const vendor = (b.vendor || '').toString().trim() || null;
  // Auto-register a newly-typed vendor into the directory (idempotent).
  if (vendor) {
    await qrun(`INSERT INTO vendors (id,tenant_id,name) VALUES (?,?,?) ON CONFLICT (tenant_id, lower(name)) DO NOTHING`,
      [uuid(), tid, vendor]).catch(() => {});
  }
  await qrun(
    `INSERT INTO expenses (id,tenant_id,site_id,expense_date,category,description,vendor,amount,recorded_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, tid, site_id, expense_date, category, b.description || null, vendor, amount, req.user.id]);

  // Keep daily_report.expenses in sync (update if report exists for same day/site)
  if (site_id) {
    await qrun(
      `UPDATE daily_reports SET expenses=expenses+? WHERE tenant_id=? AND site_id=? AND report_date=?`,
      [amount, tid, site_id, expense_date]);
  }

  res.status(201).json(await qone('SELECT * FROM expenses WHERE id=?', [id]));
});

// ── PATCH /expenses/:id ────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'GENERAL_MANAGER') && a.expense.recorded_by !== req.user.id)
    return res.status(403).json({ error: 'only the recorder or a manager can edit this expense' });

  const b = req.body || {};
  const oldAmount = parseFloat(a.expense.amount) || 0;
  const newAmount = b.amount != null ? parseFloat(b.amount) || 0 : oldAmount;
  const diff = newAmount - oldAmount;

  const vendor = b.vendor !== undefined ? ((b.vendor || '').toString().trim() || null) : a.expense.vendor;
  if (vendor && vendor !== a.expense.vendor) {
    await qrun(`INSERT INTO vendors (id,tenant_id,name) VALUES (?,?,?) ON CONFLICT (tenant_id, lower(name)) DO NOTHING`,
      [uuid(), a.expense.tenant_id, vendor]).catch(() => {});
  }
  await qrun(
    `UPDATE expenses SET category=?,description=?,vendor=?,amount=?,expense_date=? WHERE id=?`,
    [(b.category || a.expense.category).toUpperCase(), b.description ?? a.expense.description,
      vendor, newAmount, b.expense_date ?? a.expense.expense_date, a.expense.id]);

  // Sync report if amount changed
  if (diff !== 0 && a.expense.site_id) {
    await qrun(
      `UPDATE daily_reports SET expenses=expenses+? WHERE tenant_id=? AND site_id=? AND report_date=?`,
      [diff, a.expense.tenant_id, a.expense.site_id, a.expense.expense_date]);
  }
  res.json(await qone('SELECT * FROM expenses WHERE id=?', [a.expense.id]));
});

// ── DELETE /expenses/:id ───────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'GENERAL_MANAGER') && a.expense.recorded_by !== req.user.id)
    return res.status(403).json({ error: 'insufficient permission' });

  // Reverse the amount in the linked daily report
  if (a.expense.site_id) {
    await qrun(
      `UPDATE daily_reports SET expenses=GREATEST(0,expenses-?) WHERE tenant_id=? AND site_id=? AND report_date=?`,
      [parseFloat(a.expense.amount) || 0, a.expense.tenant_id, a.expense.site_id, a.expense.expense_date]);
  }
  await qrun('DELETE FROM expenses WHERE id=?', [a.expense.id]);
  res.json({ ok: true });
});

module.exports = router;
