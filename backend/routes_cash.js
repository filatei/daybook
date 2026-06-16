/**
 * Daybook — Cash at hand (end-of-day).
 *
 * Managers/secretaries log cash handed to POS agents that must be paid into the
 * company bank account, attaching the transfer receipt(s). Admin reviews each
 * entry (NOT_SEEN → SEEN) and validates at end of day, checking that the total
 * recorded equals the cash actually collected.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');
const { requireAuth, contextFor, requestedTenant, atLeast, siteBound } = require('./auth');

const router = express.Router();

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
const today = () => new Date().toISOString().slice(0, 10);
const nowS = () => Math.floor(Date.now() / 1000);

async function cashAccess(req, id) {
  const e = await qone('SELECT * FROM cash_deposits WHERE id=?', [id]);
  if (!e) return null;
  const c = await contextFor(req.user, e.tenant_id);
  if (!c) return null;
  if (siteBound(c) && e.site_id && e.site_id !== c.site_id) return null;
  return { cash: e, ctx: c };
}

// ── GET /cash — list (default today) + total + attachment counts ───────────────
router.get('/', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  if (!tid) return res.status(400).json({ error: 'select a workspace' });
  const c = await contextFor(req.user, tid);
  if (!c) return res.status(403).json({ error: 'forbidden' });

  const { site, status } = req.query;
  const from = req.query.from || today();
  const to = req.query.to || from;
  const where = ['d.tenant_id=?', 'd.deposit_date>=?', 'd.deposit_date<=?'], args = [tid, from, to];
  if (siteBound(c)) { where.push('d.site_id=?'); args.push(c.site_id); }
  else if (site) { where.push('d.site_id=?'); args.push(site); }
  if (status) { where.push('d.status=?'); args.push(status.toUpperCase()); }

  const rows = await qall(
    `SELECT d.*, s.name site_name, s.code site_code,
            (SELECT COUNT(*) FROM cash_attachments a WHERE a.cash_id=d.id) AS receipts
       FROM cash_deposits d LEFT JOIN sites s ON s.id=d.site_id
      WHERE ${where.join(' AND ')}
      ORDER BY d.created_at DESC LIMIT 500`, args);
  const total = rows.reduce((a, r) => a + Number(r.amount || 0), 0);
  res.json({ rows, total, from, to });
});

// Distinct payee accounts used before — for the create-on-the-fly picker.
router.get('/accounts', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  if (!tid) return res.json([]);
  const rows = await qall(
    "SELECT DISTINCT payee_account FROM cash_deposits WHERE tenant_id=? AND payee_account IS NOT NULL AND payee_account<>'' ORDER BY payee_account LIMIT 50", [tid]);
  res.json(rows.map((r) => r.payee_account));
});

// ── POST /cash — record a cash entry (+ optional first receipt) ────────────────
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  const cleanup = () => { if (req.file) { try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch {} } };
  if (!tid) { cleanup(); return res.status(400).json({ error: 'select a workspace' }); }
  const c = await contextFor(req.user, tid);
  if (!c || !atLeast(c.role, 'SECRETARY')) { cleanup(); return res.status(403).json({ error: 'forbidden' }); }

  const b = req.body || {};
  const amount = parseFloat(b.amount) || 0;
  if (!amount) { cleanup(); return res.status(400).json({ error: 'amount required' }); }
  const site_id = siteBound(c) ? c.site_id : (b.site_id || null);
  const id = uuid();
  await qrun(
    `INSERT INTO cash_deposits (id,tenant_id,site_id,deposit_date,amount,depositor,payee_account,memo,status,created_by)
     VALUES (?,?,?,?,?,?,?,?, 'NOT_SEEN', ?)`,
    [id, tid, site_id, b.deposit_date || today(), amount,
      (b.depositor || '').trim() || null, (b.payee_account || '').trim() || null, (b.memo || '').trim() || null, req.user.id]);
  if (req.file) {
    await qrun('INSERT INTO cash_attachments (id,tenant_id,cash_id,note,file_name,stored_name,mime,size,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [uuid(), tid, id, null, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id]);
  }
  res.status(201).json(await qone('SELECT * FROM cash_deposits WHERE id=?', [id]));
});

// ── GET /cash/:id — detail + receipts ──────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const a = await cashAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const site = a.cash.site_id ? await qone('SELECT name FROM sites WHERE id=?', [a.cash.site_id]) : null;
  const receipts = await qall('SELECT id,note,file_name,mime,size,created_at FROM cash_attachments WHERE cash_id=? ORDER BY created_at', [req.params.id]);
  res.json({ ...a.cash, site_name: site && site.name, receipts: receipts.map((r) => ({ ...r, has_file: !!r.file_name })) });
});

// ── Receipts: anyone with access can attach ────────────────────────────────────
router.get('/:id/attachments', requireAuth, async (req, res) => {
  const a = await cashAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const rows = await qall('SELECT id,note,file_name,mime,size,created_at FROM cash_attachments WHERE cash_id=? ORDER BY created_at', [req.params.id]);
  res.json(rows.map((r) => ({ ...r, has_file: !!r.file_name })));
});
router.post('/:id/attachments', requireAuth, upload.single('file'), async (req, res) => {
  const a = await cashAccess(req, req.params.id);
  if (!a) { if (req.file) { try { fs.unlinkSync(path.join(UPLOAD_DIR, req.file.filename)); } catch {} } return res.status(404).json({ error: 'not found' }); }
  const note = (req.body && req.body.note ? String(req.body.note) : '').trim() || null;
  if (!req.file && !note) return res.status(400).json({ error: 'attach a receipt or write a note' });
  const id = uuid();
  await qrun('INSERT INTO cash_attachments (id,tenant_id,cash_id,note,file_name,stored_name,mime,size,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [id, a.cash.tenant_id, a.cash.id, note,
      req.file ? req.file.originalname : null, req.file ? req.file.filename : null, req.file ? req.file.mimetype : null, req.file ? req.file.size : null, req.user.id]);
  res.status(201).json({ id });
});
router.get('/:id/attachments/:aid/file', requireAuth, async (req, res) => {
  const a = await cashAccess(req, req.params.id);
  if (!a) return res.status(404).end();
  const att = await qone('SELECT * FROM cash_attachments WHERE id=? AND cash_id=?', [req.params.aid, req.params.id]);
  if (!att || !att.stored_name) return res.status(404).end();
  const p = path.join(UPLOAD_DIR, att.stored_name);
  if (!fs.existsSync(p)) return res.status(404).end();
  if (req.query.download === '1') return res.download(p, att.file_name || 'receipt');
  res.sendFile(p);
});
router.delete('/:id/attachments/:aid', requireAuth, async (req, res) => {
  const a = await cashAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'SITE_MANAGER')) return res.status(403).json({ error: 'only a manager can remove a receipt' });
  const att = await qone('SELECT * FROM cash_attachments WHERE id=? AND cash_id=?', [req.params.aid, req.params.id]);
  if (!att) return res.status(404).json({ error: 'not found' });
  if (att.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, att.stored_name)); } catch {} }
  await qrun('DELETE FROM cash_attachments WHERE id=?', [att.id]);
  res.json({ ok: true });
});

// ── Review: mark SEEN / NOT_SEEN (Snr Acct/GM/Admin) ───────────────────────────
router.post('/:id/seen', requireAuth, async (req, res) => {
  const a = await cashAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'SNR_ACCOUNTANT')) return res.status(403).json({ error: 'only Snr Accountant/GM/Admin can review' });
  if (a.cash.status === 'VALIDATED') return res.status(409).json({ error: 'already validated' });
  const seen = req.body?.seen !== false;
  await qrun('UPDATE cash_deposits SET status=?, seen_by=?, seen_at=? WHERE id=?',
    [seen ? 'SEEN' : 'NOT_SEEN', seen ? req.user.id : null, seen ? nowS() : null, a.cash.id]);
  res.json({ status: seen ? 'SEEN' : 'NOT_SEEN' });
});

// ── Validate at end of day (Admin) ─────────────────────────────────────────────
router.post('/:id/validate', requireAuth, async (req, res) => {
  const a = await cashAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'ADMIN')) return res.status(403).json({ error: 'only an admin can validate' });
  await qrun('UPDATE cash_deposits SET status=?, validated_by=?, validated_at=?, seen_by=COALESCE(seen_by,?), seen_at=COALESCE(seen_at,?) WHERE id=?',
    ['VALIDATED', req.user.id, nowS(), req.user.id, nowS(), a.cash.id]);
  res.json({ status: 'VALIDATED' });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const a = await cashAccess(req, req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!atLeast(a.ctx.role, 'SITE_MANAGER') && a.cash.created_by !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (a.cash.status === 'VALIDATED' && !atLeast(a.ctx.role, 'ADMIN')) return res.status(409).json({ error: 'validated entries can only be removed by an admin' });
  const atts = await qall('SELECT stored_name FROM cash_attachments WHERE cash_id=?', [a.cash.id]);
  for (const at of atts) { if (at.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, at.stored_name)); } catch {} } }
  await qrun('DELETE FROM cash_deposits WHERE id=?', [a.cash.id]);
  res.json({ ok: true });
});

module.exports = router;
