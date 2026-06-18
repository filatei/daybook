/**
 * Daybook — Compliance vault
 *
 * Stores government/regulator letters, licenses, certificates and permits with
 * issuer, reference number and issue/expiry dates. Expiry reminders are sent by
 * scheduler.js (see compliance.js). Mounted at /api/compliance.
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
const nowS = () => Math.floor(Date.now() / 1000);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || '25', 10);
const ALLOWED = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff',
  '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt', '.rtf', '.ppt', '.pptx', '.zip',
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, UPLOAD_DIR),
    filename: (_q, f, cb) => cb(null, `${Date.now()}-${uuid().slice(0, 8)}${path.extname(f.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_q, f, cb) => { const ok = ALLOWED.has(path.extname(f.originalname).toLowerCase()); cb(ok ? null : new Error('File type not allowed'), ok); },
});

const TYPES = ['LICENSE', 'CERTIFICATE', 'PERMIT', 'LETTER', 'OTHER'];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });
const daysTo = (d) => { if (!d) return null; const ms = new Date(`${d}T00:00:00`).getTime() - new Date(`${today()}T00:00:00`).getTime(); return Math.round(ms / 86400000); };
const statusOf = (days) => days == null ? 'NO_EXPIRY' : days < 0 ? 'EXPIRED' : days <= 30 ? 'EXPIRING' : 'VALID';

// Resolve the caller's membership + role in the requested tenant.
async function ctxFor(req, res, minRole) {
  const tid = requestedTenant(req);
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  const c = await contextFor(req.user, tid);
  if (!c) { res.status(403).json({ error: 'no access' }); return null; }
  if (minRole && !atLeast(c.role, minRole)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return c;
}
const view = (d) => {
  const days = daysTo(d.expiry_date);
  return { ...d, days_to_expiry: days, status: statusOf(days) };
};

// List (SECRETARY+ may view). Filters: type, site, status (VALID|EXPIRING|EXPIRED).
router.get('/', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res, 'SECRETARY'); if (!c) return;
  const where = ['tenant_id=?'], args = [c.tenant_id];
  if (siteBound(c)) { where.push('(site_id=? OR site_id IS NULL)'); args.push(c.site_id); }
  else if (req.query.site) { where.push('site_id=?'); args.push(req.query.site); }
  if (req.query.type) { where.push('doc_type=?'); args.push(String(req.query.type).toUpperCase()); }
  const rows = await qall(
    `SELECT d.*, s.name site_name, u.name uploader FROM compliance_docs d
       LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN users u ON u.id=d.uploaded_by
      WHERE ${where.join(' AND ')} ORDER BY (d.expiry_date IS NULL), d.expiry_date ASC LIMIT 500`, args);
  let out = rows.map(view);
  if (req.query.status) out = out.filter((d) => d.status === String(req.query.status).toUpperCase());
  res.json(out);
});

// Add (SITE_MANAGER+). Multipart: file + fields.
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  const c = await ctxFor(req, res, 'SITE_MANAGER'); if (!c) return;
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title required' });
  const doc_type = TYPES.includes(String(b.doc_type || '').toUpperCase()) ? String(b.doc_type).toUpperCase() : 'OTHER';
  const site_id = siteBound(c) ? c.site_id : (b.site_id || null);
  const f = req.file;
  const id = uuid();
  await qrun(
    `INSERT INTO compliance_docs (id,tenant_id,site_id,doc_type,title,issuer,reference_no,issue_date,expiry_date,notes,file_name,stored_name,mime,size,uploaded_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, c.tenant_id, site_id, doc_type, String(b.title).trim(), b.issuer || null, b.reference_no || null,
      b.issue_date || null, b.expiry_date || null, b.notes || null,
      f ? f.originalname : null, f ? f.filename : null, f ? f.mimetype : null, f ? f.size : null, req.user.id]);
  res.status(201).json(view(await qone('SELECT * FROM compliance_docs WHERE id=?', [id])));
});

// Edit metadata (SITE_MANAGER+). Renewing the expiry resets reminders.
router.patch('/:id', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res, 'SITE_MANAGER'); if (!c) return;
  const d = await qone('SELECT * FROM compliance_docs WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!d) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const doc_type = b.doc_type ? (TYPES.includes(String(b.doc_type).toUpperCase()) ? String(b.doc_type).toUpperCase() : d.doc_type) : d.doc_type;
  const newExpiry = b.expiry_date !== undefined ? (b.expiry_date || null) : d.expiry_date;
  // If the expiry moved later, clear the reminder stage so future alerts fire.
  const reset = (newExpiry && newExpiry !== d.expiry_date && daysTo(newExpiry) > 0) ? 0 : d.reminded_stage;
  await qrun(
    `UPDATE compliance_docs SET doc_type=?, title=?, issuer=?, reference_no=?, issue_date=?, expiry_date=?, notes=?, site_id=?, reminded_stage=? WHERE id=?`,
    [doc_type, b.title ?? d.title, b.issuer ?? d.issuer, b.reference_no ?? d.reference_no,
      b.issue_date !== undefined ? (b.issue_date || null) : d.issue_date, newExpiry, b.notes ?? d.notes,
      siteBound(c) ? d.site_id : (b.site_id !== undefined ? (b.site_id || null) : d.site_id), reset, d.id]);
  res.json(view(await qone('SELECT * FROM compliance_docs WHERE id=?', [d.id])));
});

router.delete('/:id', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res, 'SITE_MANAGER'); if (!c) return;
  const d = await qone('SELECT * FROM compliance_docs WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!d) return res.status(404).json({ error: 'not found' });
  if (d.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch { /* file gone */ } }
  await qrun('DELETE FROM compliance_docs WHERE id=?', [d.id]);
  res.json({ ok: true });
});

router.get('/:id/download', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res, 'SECRETARY'); if (!c) return;
  const d = await qone('SELECT * FROM compliance_docs WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!d || !d.stored_name) return res.status(404).json({ error: 'not found' });
  const p = path.join(UPLOAD_DIR, d.stored_name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'file missing' });
  res.download(p, d.file_name || 'document');
});

module.exports = router;
module.exports.nowS = nowS;
