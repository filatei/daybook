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
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');
const { requireAuth, contextFor, requestedTenant, atLeast, siteBound } = require('./auth');
const { notifyExpenseEvent } = require('./notify_expense');

const router = express.Router();

// Receipt uploads → same Linode disk store as documents.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ATT_OK = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.xls', '.xlsx', '.doc', '.docx', '.txt']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, UPLOAD_DIR),
    filename: (_q, f, cb) => cb(null, `${Date.now()}-${uuid().slice(0, 8)}${path.extname(f.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_MB || '25', 10) * 1024 * 1024 },
  fileFilter: (_q, f, cb) => { const ok = ATT_OK.has(path.extname(f.originalname).toLowerCase()); cb(ok ? null : new Error('File type not allowed'), ok); },
});

const EXPENSE_CATS = ['DIESEL', 'SALARY', 'MAINTENANCE', 'TRANSPORT', 'UTILITIES', 'SUPPLIES', 'OTHER'];

// Normalise expense line items: keep ones with a name, compute amount = qty × price.
function normItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it) => {
      const name = (it && it.name != null ? String(it.name) : '').trim();
      const qty = Number(it && it.qty) || 0;
      const price = Number(it && it.price) || 0;
      const amount = it && it.amount != null ? Number(it.amount) : qty * price;
      return { name, qty: qty || null, price: price || null, amount: Math.round((amount || 0) * 100) / 100 };
    })
    .filter((it) => it.name && it.amount);
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function expenseAccess(req, expenseId) {
  const e = await qone('SELECT * FROM expenses WHERE id=?', [expenseId]);
  if (!e) return null;
  const c = await contextFor(req.user, e.tenant_id);
  if (!c) return null;
  if (siteBound(c) && e.site_id && e.site_id !== c.site_id) return null;
  return { expense: e, ctx: c };
}

// ── GET /expenses ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  if (!tid) return res.status(400).json({ error: 'select a workspace' });
  const c = await contextFor(req.user, tid);
  if (!c) return res.status(403).json({ error: 'forbidden' });

  const { site, from, to, category, vendor, unpaid, kind, q } = req.query;
  const where = ['e.tenant_id=?'], args = [tid];

  if (siteBound(c)) { where.push('e.site_id=?'); args.push(c.site_id); }
  else if (site) { where.push('e.site_id=?'); args.push(site); }
  // Free-text search (id / vendor / site / description) searches ALL history —
  // date filters are ignored when q is present so an old ticket can be found.
  const qq = (q || '').trim();
  if (qq) {
    const like = `%${qq}%`;
    // Search id / vendor / site / description / category / item names (items_json).
    where.push('(e.ext_id ILIKE ? OR e.vendor ILIKE ? OR s.name ILIKE ? OR e.description ILIKE ? OR e.category ILIKE ? OR e.id ILIKE ? OR e.items_json ILIKE ?)');
    args.push(like, like, like, like, like, like, like);
  } else {
    if (from) { where.push('e.expense_date>=?'); args.push(from); }
    if (to)   { where.push('e.expense_date<=?'); args.push(to); }
  }
  if (category) { where.push('e.category=?'); args.push(category.toUpperCase()); }
  if (vendor) { where.push('lower(e.vendor)=lower(?)'); args.push(vendor); }
  if (unpaid === '1') { where.push('e.amount > COALESCE(e.amount_paid,0)'); }
  if (kind) { where.push('COALESCE(e.kind,?)=?'); args.push('NON_IMPREST', kind.toUpperCase()); }

  const rows = await qall(
    `SELECT e.*, (e.amount - COALESCE(e.amount_paid,0)) AS balance, s.name site_name, s.code site_code
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
  const sw = ['e.tenant_id=?'], sargs = [tid];
  if (siteBound(c)) { sw.push('e.site_id=?'); sargs.push(c.site_id); }
  else if (site) { sw.push('e.site_id=?'); sargs.push(site); }

  // Cash basis = expense PAYMENTS made in the period (when money left). Accrual
  // (default) = expense tickets dated in the period (when the cost was incurred).
  if (req.query.basis === 'cash') {
    const where = [...sw], args = [...sargs];
    if (from) { where.push('p.pay_date>=?'); args.push(from); }
    if (to)   { where.push('p.pay_date<=?'); args.push(to); }
    const F = `FROM expense_payments p JOIN expenses e ON e.id=p.expense_id WHERE ${where.join(' AND ')}`;
    const [totals, byCategory, bySite, byDay] = await Promise.all([
      qone(`SELECT COALESCE(SUM(p.amount),0) total, COUNT(*) count ${F}`, args),
      qall(`SELECT e.category, COALESCE(SUM(p.amount),0) total ${F} GROUP BY e.category ORDER BY total DESC`, args),
      qall(`SELECT s.name site, COALESCE(SUM(p.amount),0) total ${F.replace('JOIN expenses e ON e.id=p.expense_id', 'JOIN expenses e ON e.id=p.expense_id JOIN sites s ON s.id=e.site_id')} GROUP BY s.id, s.name ORDER BY total DESC`, args),
      qall(`SELECT p.pay_date day, COALESCE(SUM(p.amount),0) total ${F} GROUP BY p.pay_date ORDER BY p.pay_date DESC LIMIT 30`, args),
    ]);
    return res.json({ basis: 'cash', totals: { ...totals, count: parseInt(totals.count, 10) }, byCategory, bySite, byDay: byDay.reverse() });
  }

  const where = [...sw], args = [...sargs];
  if (from) { where.push('e.expense_date>=?'); args.push(from); }
  if (to)   { where.push('e.expense_date<=?'); args.push(to); }
  const W = 'WHERE ' + where.join(' AND ');

  const [totals, byCategory, bySite, byDay] = await Promise.all([
    qone(`SELECT COALESCE(SUM(amount),0) total, COUNT(*) count FROM expenses e ${W}`, args),
    qall(`SELECT category, COALESCE(SUM(amount),0) total FROM expenses e ${W} GROUP BY category ORDER BY total DESC`, args),
    qall(`SELECT s.name site, COALESCE(SUM(e.amount),0) total FROM expenses e JOIN sites s ON s.id=e.site_id ${W} GROUP BY s.id, s.name ORDER BY total DESC`, args),
    qall(`SELECT expense_date day, COALESCE(SUM(amount),0) total FROM expenses e ${W} GROUP BY expense_date ORDER BY expense_date DESC LIMIT 30`, args),
  ]);
  res.json({ basis: 'accrual', totals: { ...totals, count: parseInt(totals.count, 10) }, byCategory, bySite, byDay: byDay.reverse() });
});

// ── GET /expenses/imprest-summary — per-site daily imprest total (what each site
// transfers to the Snr Accountant at day end). Defaults to today.
router.get('/imprest-summary', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  if (!tid) return res.status(400).json({ error: 'select a workspace' });
  const c = await contextFor(req.user, tid);
  if (!c) return res.status(403).json({ error: 'forbidden' });
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to || from;
  const where = ["e.tenant_id=?", "COALESCE(e.kind,'NON_IMPREST')='IMPREST'", 'e.expense_date>=?', 'e.expense_date<=?'];
  const args = [tid, from, to];
  if (siteBound(c)) { where.push('e.site_id=?'); args.push(c.site_id); }
  const rows = await qall(
    `SELECT e.site_id, s.name site_name, s.code site_code, COALESCE(SUM(e.amount),0) total, COUNT(*) count
       FROM expenses e LEFT JOIN sites s ON s.id=e.site_id
      WHERE ${where.join(' AND ')}
      GROUP BY e.site_id, s.name, s.code ORDER BY total DESC`, args);
  const grand = rows.reduce((a, r) => a + Number(r.total || 0), 0);
  res.json({ from, to, grand, sites: rows.map((r) => ({ ...r, total: Number(r.total), count: parseInt(r.count, 10) })) });
});

// ── GET /expenses/categories — categories actually used (incl. migrated Fido) + defaults
router.get('/categories', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  if (!tid) return res.json(EXPENSE_CATS);
  const rows = await qall(
    "SELECT DISTINCT category FROM expenses WHERE tenant_id=? AND category IS NOT NULL AND category<>'' ORDER BY category", [tid]);
  const merged = Array.from(new Set([...rows.map((r) => r.category), ...EXPENSE_CATS]));
  res.json(merged);
});

// ── POST /expenses ─────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  if (!tid) return res.status(400).json({ error: 'select a workspace' });
  const c = await contextFor(req.user, tid);
  if (!c || !atLeast(c.role, 'SECRETARY')) return res.status(403).json({ error: 'forbidden' });

  const b = req.body || {};
  const site_id = siteBound(c) ? c.site_id : (b.site_id || null);
  const expense_date = b.expense_date || new Date().toISOString().slice(0, 10);
  // Line items: each { name, qty, price } → amount = qty × price. Total = Σ amounts.
  const items = normItems(b.items);
  const amount = items.length ? items.reduce((s, it) => s + it.amount, 0) : (parseFloat(b.amount) || 0);
  if (!amount) return res.status(400).json({ error: 'amount required' });
  // Accept any category (so migrated Fido categories work), normalised to UPPER.
  const category = ((b.category || '').toString().trim().toUpperCase().slice(0, 40)) || 'OTHER';

  const id = uuid();
  const vendor = (b.vendor || '').toString().trim() || null;
  // Auto-register a newly-typed vendor into the directory (idempotent).
  if (vendor) {
    await qrun(`INSERT INTO vendors (id,tenant_id,name) VALUES (?,?,?) ON CONFLICT (tenant_id, lower(name)) DO NOTHING`,
      [uuid(), tid, vendor]).catch(() => {});
  }
  const kind = (b.kind || '').toString().toUpperCase() === 'IMPREST' ? 'IMPREST' : 'NON_IMPREST';
  await qrun(
    `INSERT INTO expenses (id,tenant_id,site_id,expense_date,category,description,vendor,items_json,amount,recorded_by,wf_state,kind)
     VALUES (?,?,?,?,?,?,?,?,?,?,'DRAFT',?)`,
    [id, tid, site_id, expense_date, category, b.description || null, vendor,
      items.length ? JSON.stringify(items) : null, amount, req.user.id, kind]);

  // Keep daily_report.expenses in sync (update if report exists for same day/site)
  if (site_id) {
    await qrun(
      `UPDATE daily_reports SET expenses=expenses+? WHERE tenant_id=? AND site_id=? AND report_date=?`,
      [amount, tid, site_id, expense_date]);
  }

  const created = await qone('SELECT * FROM expenses WHERE id=?', [id]);
  // Notify those who validate it next (managers) + creator.
  notifyExpenseEvent({ tenant_id: tid, expense: created, targetState: 'DRAFT', action: 'create', actorId: req.user.id, actorName: req.user.name || req.user.email });
  res.status(201).json(created);
});

// ── PATCH /expenses/:id ────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'GENERAL_MANAGER') && a.expense.recorded_by !== req.user.id)
    return res.status(403).json({ error: 'only the recorder or a manager can edit this expense' });

  const b = req.body || {};
  const oldAmount = parseFloat(a.expense.amount) || 0;
  const items = b.items !== undefined ? normItems(b.items) : null;  // null = unchanged
  const newAmount = items && items.length ? items.reduce((s, it) => s + it.amount, 0)
    : (b.amount != null ? parseFloat(b.amount) || 0 : oldAmount);
  const diff = newAmount - oldAmount;

  const vendor = b.vendor !== undefined ? ((b.vendor || '').toString().trim() || null) : a.expense.vendor;
  if (vendor && vendor !== a.expense.vendor) {
    await qrun(`INSERT INTO vendors (id,tenant_id,name) VALUES (?,?,?) ON CONFLICT (tenant_id, lower(name)) DO NOTHING`,
      [uuid(), a.expense.tenant_id, vendor]).catch(() => {});
  }
  const itemsJson = items === null ? a.expense.items_json : (items.length ? JSON.stringify(items) : null);
  const kind = b.kind !== undefined ? (String(b.kind).toUpperCase() === 'IMPREST' ? 'IMPREST' : 'NON_IMPREST') : (a.expense.kind || 'NON_IMPREST');
  await qrun(
    `UPDATE expenses SET category=?,description=?,vendor=?,items_json=?,amount=?,expense_date=?,kind=? WHERE id=?`,
    [(b.category || a.expense.category).toUpperCase(), b.description ?? a.expense.description,
      vendor, itemsJson, newAmount, b.expense_date ?? a.expense.expense_date, kind, a.expense.id]);

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
  const e = a.expense;
  // Snr Accountant / GM / Admin (or the creator) may delete. Snr Accountant ranks
  // equal to GM, so atLeast('SNR_ACCOUNTANT') covers Snr Accountant, GM and Admin.
  const canByRole = atLeast(a.ctx.role, 'SNR_ACCOUNTANT');
  if (!canByRole && e.recorded_by !== req.user.id)
    return res.status(403).json({ error: 'only Snr Accountant, GM or Admin (or the recorder) can delete an expense' });
  // Business rule: only UNPAID expenses that are not more than one week old.
  if (Number(e.amount_paid || 0) > 0 || ['PAID', 'DELIVERED'].includes(e.wf_state))
    return res.status(409).json({ error: 'this expense has been paid — it cannot be deleted' });
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  if (Number(e.created_at || 0) < weekAgo)
    return res.status(409).json({ error: 'expenses older than one week cannot be deleted' });

  // Reverse the amount in the linked daily report
  if (e.site_id) {
    await qrun(
      `UPDATE daily_reports SET expenses=GREATEST(0,expenses-?) WHERE tenant_id=? AND site_id=? AND report_date=?`,
      [parseFloat(e.amount) || 0, e.tenant_id, e.site_id, e.expense_date]);
  }
  // Remove attachment files + related rows, then the expense.
  const atts = await qall('SELECT stored_name FROM expense_attachments WHERE expense_id=?', [e.id]).catch(() => []);
  for (const at of atts) { if (at.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, at.stored_name)); } catch { /* gone */ } } }
  await qrun('DELETE FROM expense_attachments WHERE expense_id=?', [e.id]).catch(() => {});
  await qrun('DELETE FROM expense_payments WHERE expense_id=?', [e.id]).catch(() => {});
  await qrun('DELETE FROM expense_wf_log WHERE expense_id=?', [e.id]).catch(() => {});
  await qrun('DELETE FROM expenses WHERE id=?', [e.id]);
  res.json({ ok: true });
});

// ── Expense payments (incremental ticket payments) + vendor payables ──────────
const payStatus = (amount, paid) => (paid <= 0.001 ? 'UNPAID' : (paid >= (amount - 0.01) ? 'PAID' : 'PART'));

// Vendor payables — how much we still owe each vendor (open expense balances).
// Defined before /:id routes so "vendors" isn't captured as an :id.
router.get('/vendors/balances', requireAuth, async (req, res) => {
  const tid = requestedTenant(req); if (!tid) return res.status(400).json({ error: 'select a workspace' });
  const c = await contextFor(req.user, tid); if (!c) return res.status(403).json({ error: 'forbidden' });
  const where = ['e.tenant_id=?', "e.vendor IS NOT NULL", "e.vendor<>''"], args = [tid];
  if (siteBound(c)) { where.push('e.site_id=?'); args.push(c.site_id); }
  const rows = await qall(
    `SELECT e.vendor,
        COALESCE(SUM(e.amount),0) billed,
        COALESCE(SUM(COALESCE(e.amount_paid,0)),0) paid,
        COALESCE(SUM(e.amount - COALESCE(e.amount_paid,0)),0) owed,
        SUM(CASE WHEN COALESCE(e.amount_paid,0) < e.amount THEN 1 ELSE 0 END) open_count
      FROM expenses e WHERE ${where.join(' AND ')}
      GROUP BY e.vendor
      HAVING COALESCE(SUM(e.amount - COALESCE(e.amount_paid,0)),0) > 0.01
      ORDER BY owed DESC`, args);
  res.json(rows.map((r) => ({ vendor: r.vendor, billed: Number(r.billed), paid: Number(r.paid), owed: Number(r.owed), open_count: Number(r.open_count) })));
});

router.get('/:id/payments', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(await qall('SELECT * FROM expense_payments WHERE expense_id=? ORDER BY pay_date DESC, created_at DESC', [req.params.id]));
});

// Record a (partial) payment against an expense ticket — Secretary/Manager+.
router.post('/:id/payments', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'SECRETARY')) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const amount = Math.round((+b.amount || 0) * 100) / 100;
  if (!(amount > 0)) return res.status(400).json({ error: 'amount required' });
  const total = +a.expense.amount || 0;
  const already = +a.expense.amount_paid || 0;
  const remaining = Math.max(0, Math.round((total - already) * 100) / 100);
  if (amount > remaining + 0.01) return res.status(400).json({ error: `exceeds balance — ₦${remaining.toLocaleString()} left to pay` });
  const id = uuid();
  const pay_date = (b.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  await qrun('INSERT INTO expense_payments (id,tenant_id,expense_id,pay_date,amount,method,bank,memo,paid_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, a.expense.tenant_id, a.expense.id, pay_date, amount, b.method || null, (b.bank || '').toUpperCase() || null, b.memo || null, req.user.id]);
  const paid = Math.round((already + amount) * 100) / 100;
  const status = payStatus(total, paid);
  await qrun('UPDATE expenses SET amount_paid=?, status=? WHERE id=?', [paid, status, a.expense.id]);
  res.status(201).json({ id, amount_paid: paid, balance: Math.max(0, Math.round((total - paid) * 100) / 100), status });
});

// Reverse a payment — Manager+.
router.delete('/payments/:pid', requireAuth, async (req, res) => {
  const p = await qone('SELECT * FROM expense_payments WHERE id=?', [req.params.pid]);
  if (!p) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, p.tenant_id);
  if (!c || !atLeast(c.role, 'SITE_MANAGER')) return res.status(403).json({ error: 'only a manager can reverse a payment' });
  await qrun('DELETE FROM expense_payments WHERE id=?', [p.id]);
  const exp = await qone('SELECT * FROM expenses WHERE id=?', [p.expense_id]);
  if (exp) {
    const paid = Math.max(0, Math.round(((+exp.amount_paid || 0) - (+p.amount || 0)) * 100) / 100);
    await qrun('UPDATE expenses SET amount_paid=?, status=? WHERE id=?', [paid, payStatus(+exp.amount || 0, paid), exp.id]);
  }
  res.json({ ok: true });
});

// ── Receipts & notes on an expense ticket (kept on disk for dispute records) ──
router.get('/:id/attachments', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const rows = await qall('SELECT id,note,file_name,mime,size,uploaded_by,created_at FROM expense_attachments WHERE expense_id=? ORDER BY created_at DESC', [req.params.id]);
  res.json(rows.map((r) => ({ ...r, has_file: !!r.file_name })));
});

// Add a note and/or a receipt file (one entry). Anyone with access to the expense.
router.post('/:id/attachments', requireAuth, upload.single('file'), async (req, res) => {
  // Anyone with access to the expense may attach receipts/notes (record-keeping).
  const a = await expenseAccess(req, req.params.id);
  if (!a) { if (req.file) { try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch {} } return res.status(404).json({ error: 'not found' }); }
  const note = (req.body && req.body.note ? String(req.body.note) : '').trim() || null;
  if (!req.file && !note) return res.status(400).json({ error: 'attach a receipt or write a note' });
  const id = uuid();
  await qrun('INSERT INTO expense_attachments (id,tenant_id,expense_id,note,file_name,stored_name,mime,size,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, a.expense.tenant_id, a.expense.id, note,
      req.file ? req.file.originalname : null, req.file ? req.file.filename : null, req.file ? req.file.mimetype : null, req.file ? req.file.size : null, req.user.id]);
  res.status(201).json({ id });
});

// Stream/download a receipt file.
router.get('/:id/attachments/:aid/file', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).end();
  const att = await qone('SELECT * FROM expense_attachments WHERE id=? AND expense_id=?', [req.params.aid, req.params.id]);
  if (!att || !att.stored_name) return res.status(404).end();
  const p = path.join(UPLOAD_DIR, att.stored_name);
  if (!fs.existsSync(p)) return res.status(404).end();
  if (req.query.download === '1') return res.download(p, att.file_name || 'receipt');
  res.sendFile(p);
});

router.delete('/:id/attachments/:aid', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'SITE_MANAGER')) return res.status(403).json({ error: 'only a manager can remove a receipt' });
  const att = await qone('SELECT * FROM expense_attachments WHERE id=? AND expense_id=?', [req.params.aid, req.params.id]);
  if (!att) return res.status(404).json({ error: 'not found' });
  if (att.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, att.stored_name)); } catch {} }
  await qrun('DELETE FROM expense_attachments WHERE id=?', [att.id]);
  res.json({ ok: true });
});

// ── Ticket lifecycle (Fido) — DRAFT→VALIDATED→REVIEWED→APPROVED→PAID→DELIVERED / DECLINED ──
// allow(ctx, expense, uid) decides who may run each transition.
const isCreator = (e, uid) => e.recorded_by === uid;
// Imprest = paid from cash at hand (e.g. diesel). These can be approved/declined
// by Snr Accountant & GM (atLeast SNR_ACCOUNTANT covers Snr Acct=GM=7, Admin=8+),
// then paid to close. Every other (non-imprest) expense still needs ADMIN approval.
const isImprest = (e) => String(e.kind || 'NON_IMPREST').toUpperCase() === 'IMPREST';
const approveRole = (e) => (isImprest(e) ? 'SNR_ACCOUNTANT' : 'ADMIN');
const FLOW = {
  // Creator OR a secretary validates a draft (confirms what was entered).
  validate: { from: ['DRAFT'], to: 'VALIDATED', allow: (c, e, uid) => isCreator(e, uid) || atLeast(c.role, 'SECRETARY') },
  // A manager reviews a validated ticket and sends it for approval.
  review:   { from: ['VALIDATED'], to: 'REVIEWED', allow: (c) => atLeast(c.role, 'SITE_MANAGER') },
  // Approve/decline a reviewed ticket: imprest (cash-at-hand) → Snr Accountant/GM;
  // everything else → Admin.
  approve:  { from: ['REVIEWED'], to: 'APPROVED', allow: (c, e) => atLeast(c.role, approveRole(e)) },
  decline:  { from: ['REVIEWED'], to: 'DECLINED', allow: (c, e) => atLeast(c.role, approveRole(e)) },
  // Managers / Accountants / GM / Snr Acct / Admin pay (then attach the receipt).
  pay:      { from: ['APPROVED'], to: 'PAID', allow: (c) => atLeast(c.role, 'SITE_MANAGER') },
  // Mark the cash handed to the receiver.
  deliver:  { from: ['APPROVED', 'PAID'], to: 'DELIVERED', allow: (c) => atLeast(c.role, 'SITE_MANAGER') },
  // Send a ticket back to draft to fix it.
  reset:    { from: ['VALIDATED', 'REVIEWED', 'APPROVED', 'PAID', 'DELIVERED', 'DECLINED'], to: 'DRAFT', allow: (c) => atLeast(c.role, 'SITE_MANAGER') },
};

// Which transitions a given role may run from the ticket's current state.
function allowedActions(state, ctx, expense, uid) {
  return Object.entries(FLOW)
    .filter(([, f]) => f.from.includes(state) && f.allow(ctx, expense, uid))
    .map(([k]) => k);
}

// Run one transition on one accessible ticket. Returns { ok, to } or { error, code }.
async function performTransition(a, action, req, note = null) {
  const f = FLOW[action];
  if (!f) return { error: 'unknown action', code: 400 };
  const cur = a.expense.wf_state || 'DRAFT';
  if (!f.from.includes(cur)) return { error: `cannot ${action} from ${cur}`, code: 409 };
  if (!f.allow(a.ctx, a.expense, req.user.id)) return { error: `you cannot ${action} this ticket`, code: 403 };
  await qrun('UPDATE expenses SET wf_state=? WHERE id=?', [f.to, a.expense.id]);
  // Paying an imprest (cash-at-hand) ticket closes it: settle the outstanding
  // balance with a CASH payment so it shows fully paid (and the GL/vendor
  // balances reflect the cash going out).
  if (action === 'pay' && isImprest(a.expense)) {
    const total = +a.expense.amount || 0;
    const already = +a.expense.amount_paid || 0;
    const remaining = Math.max(0, Math.round((total - already) * 100) / 100);
    if (remaining > 0.001) {
      await qrun('INSERT INTO expense_payments (id,tenant_id,expense_id,pay_date,amount,method,memo,paid_by) VALUES (?,?,?,?,?,?,?,?)',
        [uuid(), a.expense.tenant_id, a.expense.id, new Date().toISOString().slice(0, 10), remaining, 'CASH', 'Imprest cash — closed on pay', req.user.id]);
      await qrun('UPDATE expenses SET amount_paid=?, status=? WHERE id=?', [total, 'PAID', a.expense.id]);
    }
  }
  await qrun(
    `INSERT INTO expense_wf_log (id,tenant_id,expense_id,action,from_state,to_state,note,actor,actor_name)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [uuid(), a.expense.tenant_id, a.expense.id, action, cur, f.to, note, req.user.id, req.user.name || req.user.email || null]);
  notifyExpenseEvent({ tenant_id: a.expense.tenant_id, expense: { ...a.expense, wf_state: f.to }, targetState: f.to, action, actorId: req.user.id, actorName: req.user.name || req.user.email });
  return { ok: true, to: f.to };
}

router.post('/:id/transition', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const action = String((req.body && req.body.action) || '').toLowerCase();
  const note = (req.body && req.body.note ? String(req.body.note) : '').trim() || null;
  const r = await performTransition(a, action, req, note);
  if (r.error) return res.status(r.code || 400).json({ error: r.error });
  res.json({ wf_state: r.to, actions: allowedActions(r.to, a.ctx, { ...a.expense, wf_state: r.to }, req.user.id) });
});

// Bulk apply one transition to many tickets (Admin/Snr/GM select several in a
// status and push them all to the next state). Per-ticket permission + state is
// still enforced; the response reports what moved and what was skipped.
router.post('/bulk-transition', requireAuth, async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
  const action = String(b.action || '').toLowerCase();
  const note = (b.note ? String(b.note) : '').trim() || null;
  if (!ids.length) return res.status(400).json({ error: 'no tickets selected' });
  if (!FLOW[action]) return res.status(400).json({ error: 'unknown action' });
  const done = [], skipped = [];
  for (const id of ids) {
    const a = await expenseAccess(req, id);
    if (!a) { skipped.push({ id, reason: 'not found / no access' }); continue; }
    const r = await performTransition(a, action, req, note);
    if (r.ok) done.push(id); else skipped.push({ id, reason: r.error });
  }
  res.json({ action, moved: done.length, skipped: skipped.length, done, skippedDetail: skipped });
});

// Lifecycle audit trail + the actions the caller may run right now.
router.get('/:id/log', requireAuth, async (req, res) => {
  const a = await expenseAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const log = await qall('SELECT action,from_state,to_state,note,actor_name,created_at FROM expense_wf_log WHERE expense_id=? ORDER BY created_at DESC', [req.params.id]);
  const state = a.expense.wf_state || 'DRAFT';
  res.json({ wf_state: state, actions: allowedActions(state, a.ctx, a.expense, req.user.id), log });
});

module.exports = router;
