/**
 * Daybook — REST API routes (multi-client SaaS, Google sign-in, memberships)
 */
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { getDb } = require('./db');
const {
  verifyGoogleToken, signSession, requireAuth,
  accessibleTenants, contextFor, requestedTenant, atLeast, GOOGLE_CLIENT_ID,
} = require('./auth');
const { sendDailyReport, verifyConnection } = require('./mailer');
const { callAI, AIError, aiConfigured } = require('./aiClient');

const router = express.Router();
const db = getDb();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../data/uploads');
const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || '25', 10);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = new Set(['.xls', '.xlsx', '.csv', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.doc', '.docx', '.txt', '.heic']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_q, _f, cb) => cb(null, UPLOAD_DIR),
    filename: (_q, f, cb) => cb(null, `${Date.now()}-${uuid().slice(0, 8)}${path.extname(f.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_q, f, cb) => { const ok = ALLOWED.has(path.extname(f.originalname).toLowerCase()); cb(ok ? null : new Error('File type not allowed'), ok); },
});

const J = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const nowS = () => Math.floor(Date.now() / 1000);
function audit(tenant_id, user_id, action, entity, entity_id, meta) {
  db.prepare('INSERT INTO audit_log (id,tenant_id,user_id,action,entity,entity_id,meta) VALUES (?,?,?,?,?,?,?)')
    .run(uuid(), tenant_id || null, user_id || null, action, entity, entity_id || null, meta ? JSON.stringify(meta) : null);
}
const tenantById = (id) => db.prepare('SELECT * FROM tenants WHERE id=?').get(id);
const siteById = (id) => db.prepare('SELECT * FROM sites WHERE id=?').get(id);
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, photo_url: u.photo_url, is_superadmin: !!u.is_superadmin });

// Resolve the access scope for list/read endpoints.
//  { ctx }      → operating inside one tenant (with role/site)
//  { all:true } → superadmin viewing across every tenant
//  { error }    → no access / must pick a workspace
function scope(req) {
  const tid = requestedTenant(req);
  if (tid) { const c = contextFor(req.user, tid); return c ? { ctx: c } : { error: 'no access to this workspace' }; }
  if (req.user.is_superadmin) return { all: true };
  return { error: 'select a workspace' };
}
// Guard middleware: require active-tenant context with a minimum role.
function needTenant(minRole) {
  return (req, res, next) => {
    const tid = requestedTenant(req) || req.body?.tenant_id;
    const c = contextFor(req.user, tid);
    if (!c) return res.status(403).json({ error: 'no access to this workspace' });
    if (minRole && !atLeast(c.role, minRole)) return res.status(403).json({ error: 'insufficient role' });
    req.ctx = c; next();
  };
}

// ── PUBLIC config (for the Google Sign-In button) ─────────────────────────────
router.get('/config', (_req, res) => res.json({ google_client_id: GOOGLE_CLIENT_ID }));

// ── AUTH ──────────────────────────────────────────────────────────────────────
function loginResponse(res, req, user) {
  db.prepare('UPDATE users SET last_login=unixepoch() WHERE id=?').run(user.id);
  const token = signSession(user);
  res.cookie('daybook_token', token, { httpOnly: true, sameSite: 'Lax', secure: req.secure, maxAge: 12 * 3600 * 1000 });
  return res.json({ token, user: publicUser(user), tenants: accessibleTenants(user) });
}

// Sign in with Google. Verified email → upsert user, attach any pending invites.
router.post('/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'missing Google credential' });
  let g;
  try { g = await verifyGoogleToken(credential); }
  catch (e) { return res.status(401).json({ error: 'Google verification failed', detail: e.message }); }

  let user = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(g.email);
  if (!user) {
    const id = uuid();
    db.prepare('INSERT INTO users (id,email,google_sub,name,photo_url) VALUES (?,?,?,?,?)')
      .run(id, g.email, g.sub, g.name || null, g.picture || null);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  } else if (!user.google_sub) {
    db.prepare('UPDATE users SET google_sub=?, name=COALESCE(name,?), photo_url=COALESCE(photo_url,?) WHERE id=?')
      .run(g.sub, g.name || null, g.picture || null, user.id);
  }
  // Convert any pending invites for this email into memberships.
  const invites = db.prepare('SELECT * FROM invites WHERE lower(email)=lower(?)').all(g.email);
  for (const inv of invites) {
    try {
      db.prepare('INSERT OR IGNORE INTO memberships (id,user_id,tenant_id,role,site_id) VALUES (?,?,?,?,?)')
        .run(uuid(), user.id, inv.tenant_id, inv.role, inv.site_id);
    } catch {}
    db.prepare('DELETE FROM invites WHERE id=?').run(inv.id);
  }
  if (user.status !== 'ACTIVE') return res.status(403).json({ error: 'account disabled' });
  return loginResponse(res, req, user);
});

// Dev-only password-less login for automated tests (never enabled in production).
router.post('/auth/dev-login', (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.DAYBOOK_ALLOW_DEV_LOGIN !== '1')
    return res.status(404).json({ error: 'not found' });
  const email = (req.body?.email || '').toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email);
  if (!user) { const id = uuid(); db.prepare('INSERT INTO users (id,email,name) VALUES (?,?,?)').run(id, email, req.body?.name || email); user = db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  return loginResponse(res, req, user);
});

router.post('/auth/logout', (_req, res) => { res.clearCookie('daybook_token'); res.json({ ok: true }); });
router.get('/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user), tenants: accessibleTenants(req.user) }));

// ── ONBOARDING — any signed-in user can create a new company workspace ────────
router.post('/onboard', requireAuth, (req, res) => {
  const { name, slug, brand_color, industry, currency } = req.body || {};
  if (!name) return res.status(400).json({ error: 'company name required' });
  const realSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || ('co-' + uuid().slice(0, 6));
  const id = uuid();
  try {
    db.prepare('INSERT INTO tenants (id,slug,name,brand_color,currency,industry,plan,created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, realSlug, name, brand_color || '#0ea5e9', currency || 'NGN', industry || null, 'FREE', req.user.id);
  } catch { return res.status(409).json({ error: 'a workspace with that name/slug already exists' }); }
  db.prepare('INSERT INTO memberships (id,user_id,tenant_id,role) VALUES (?,?,?,?)').run(uuid(), req.user.id, id, 'ADMIN');
  // seed a default recipient (the creator) so reports can be emailed immediately
  db.prepare('INSERT OR IGNORE INTO recipients (id,tenant_id,email,name) VALUES (?,?,?,?)').run(uuid(), id, req.user.email, req.user.name || null);
  audit(id, req.user.id, 'CREATE', 'tenant', id, { name });
  res.status(201).json({ tenant: tenantById(id), tenants: accessibleTenants(req.user) });
});

// ── TENANTS ────────────────────────────────────────────────────────────────────
router.get('/tenants', requireAuth, (req, res) => res.json(accessibleTenants(req.user)));
router.patch('/tenants/:id', requireAuth, (req, res) => {
  const c = contextFor(req.user, req.params.id);
  if (!c || !atLeast(c.role, 'ADMIN')) return res.status(403).json({ error: 'forbidden' });
  const t = tenantById(req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
  const f = req.body || {};
  db.prepare('UPDATE tenants SET name=?,brand_color=?,currency=?,industry=?,plan=?,status=? WHERE id=?')
    .run(f.name ?? t.name, f.brand_color ?? t.brand_color, f.currency ?? t.currency, f.industry ?? t.industry,
      req.user.is_superadmin ? (f.plan ?? t.plan) : t.plan, req.user.is_superadmin ? (f.status ?? t.status) : t.status, t.id);
  res.json(tenantById(t.id));
});

// ── SITES ────────────────────────────────────────────────────────────────────
router.get('/sites', requireAuth, (req, res) => {
  const s = scope(req); if (s.error) return res.status(403).json({ error: s.error });
  if (s.all) return res.json(db.prepare('SELECT * FROM sites ORDER BY tenant_id,name').all());
  if (s.ctx.role === 'SITE_MANAGER') return res.json(db.prepare('SELECT * FROM sites WHERE id=?').all(s.ctx.site_id));
  res.json(db.prepare('SELECT * FROM sites WHERE tenant_id=? ORDER BY name').all(s.ctx.tenant_id));
});
router.post('/sites', requireAuth, needTenant('ADMIN'), (req, res) => {
  const { code, name, address, is_hq } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'code and name required' });
  const id = uuid();
  try {
    db.prepare('INSERT INTO sites (id,tenant_id,code,name,address,is_hq) VALUES (?,?,?,?,?,?)')
      .run(id, req.ctx.tenant_id, code.toUpperCase(), name, address || null, is_hq ? 1 : 0);
  } catch { return res.status(409).json({ error: 'site code already exists' }); }
  audit(req.ctx.tenant_id, req.user.id, 'CREATE', 'site', id, { code });
  res.status(201).json(siteById(id));
});
router.patch('/sites/:id', requireAuth, (req, res) => {
  const site = siteById(req.params.id); if (!site) return res.status(404).json({ error: 'not found' });
  const c = contextFor(req.user, site.tenant_id);
  if (!c || !atLeast(c.role, 'ADMIN')) return res.status(403).json({ error: 'forbidden' });
  const f = req.body || {};
  db.prepare('UPDATE sites SET name=?,address=?,is_hq=?,status=? WHERE id=?')
    .run(f.name ?? site.name, f.address ?? site.address, f.is_hq != null ? (f.is_hq ? 1 : 0) : site.is_hq, f.status ?? site.status, site.id);
  res.json(siteById(site.id));
});

// ── MEMBERS (users within a tenant) ───────────────────────────────────────────
router.get('/members', requireAuth, needTenant('GENERAL_MANAGER'), (req, res) => {
  const rows = db.prepare(
    `SELECT m.id, m.role, m.site_id, m.status, u.email, u.name, u.last_login, (u.google_sub IS NOT NULL) AS active_login
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? ORDER BY m.role DESC, u.email`
  ).all(req.ctx.tenant_id);
  const pending = db.prepare('SELECT id,email,role,site_id FROM invites WHERE tenant_id=?').all(req.ctx.tenant_id);
  res.json({ members: rows, invites: pending });
});

router.post('/members', requireAuth, needTenant('ADMIN'), (req, res) => {
  const { email, role, site_id, name } = req.body || {};
  if (!email || !role) return res.status(400).json({ error: 'email and role required' });
  if (!['ADMIN', 'GENERAL_MANAGER', 'SITE_MANAGER'].includes(role)) return res.status(400).json({ error: 'invalid role' });
  if (role === 'SITE_MANAGER' && !site_id) return res.status(400).json({ error: 'site required for a Site Manager' });
  const lower = email.toLowerCase();
  const existing = db.prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(lower);
  if (existing) {
    try {
      db.prepare('INSERT INTO memberships (id,user_id,tenant_id,role,site_id) VALUES (?,?,?,?,?)')
        .run(uuid(), existing.id, req.ctx.tenant_id, role, role === 'SITE_MANAGER' ? site_id : null);
    } catch { return res.status(409).json({ error: 'this user is already a member' }); }
    audit(req.ctx.tenant_id, req.user.id, 'ADD_MEMBER', 'membership', existing.id, { email, role });
    return res.status(201).json({ added: true, email });
  }
  // No account yet → store an invite; converts to a membership on first Google sign-in.
  try {
    db.prepare('INSERT INTO invites (id,tenant_id,email,role,site_id,invited_by) VALUES (?,?,?,?,?,?)')
      .run(uuid(), req.ctx.tenant_id, lower, role, role === 'SITE_MANAGER' ? site_id : null, req.user.id);
  } catch { return res.status(409).json({ error: 'already invited' }); }
  audit(req.ctx.tenant_id, req.user.id, 'INVITE', 'invite', lower, { role });
  res.status(201).json({ invited: true, email: lower });
});

router.patch('/members/:id', requireAuth, needTenant('ADMIN'), (req, res) => {
  const m = db.prepare('SELECT * FROM memberships WHERE id=? AND tenant_id=?').get(req.params.id, req.ctx.tenant_id);
  if (!m) return res.status(404).json({ error: 'not found' });
  const f = req.body || {};
  db.prepare('UPDATE memberships SET role=?,site_id=?,status=? WHERE id=?')
    .run(f.role ?? m.role, f.site_id !== undefined ? f.site_id : m.site_id, f.status ?? m.status, m.id);
  res.json({ ok: true });
});
router.delete('/members/:id', requireAuth, needTenant('ADMIN'), (req, res) => {
  const m = db.prepare('SELECT * FROM memberships WHERE id=? AND tenant_id=?').get(req.params.id, req.ctx.tenant_id);
  if (!m) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM memberships WHERE id=?').run(m.id);
  audit(req.ctx.tenant_id, req.user.id, 'REMOVE_MEMBER', 'membership', m.id);
  res.json({ ok: true });
});
router.delete('/invites/:id', requireAuth, needTenant('ADMIN'), (req, res) => {
  db.prepare('DELETE FROM invites WHERE id=? AND tenant_id=?').run(req.params.id, req.ctx.tenant_id);
  res.json({ ok: true });
});

// ── DAILY REPORTS ──────────────────────────────────────────────────────────────
const reportView = (r) => ({ ...r, sales: J(r.sales_json, []), production: J(r.production_json, {}) });
function computeTotals(b) {
  const sales = Array.isArray(b.sales) ? b.sales : [];
  const fromLines = sales.reduce((a, s) => a + (+s.amount || 0), 0);
  const total_sales = +b.total_sales || fromLines || 0;
  const balance = b.balance != null ? +b.balance : total_sales - ((+b.diesel || 0) + (+b.expenses || 0));
  return { total_sales, balance };
}

router.get('/reports', requireAuth, (req, res) => {
  const s = scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const { site, from, to } = req.query; const where = [], args = [];
  if (s.ctx) { where.push('r.tenant_id=?'); args.push(s.ctx.tenant_id);
    if (s.ctx.role === 'SITE_MANAGER') { where.push('r.site_id=?'); args.push(s.ctx.site_id); }
    else if (site) { where.push('r.site_id=?'); args.push(site); } }
  if (from) { where.push('r.report_date>=?'); args.push(from); }
  if (to) { where.push('r.report_date<=?'); args.push(to); }
  const sql = `SELECT r.*, s.name site_name, s.code site_code, t.name tenant_name
    FROM daily_reports r JOIN sites s ON s.id=r.site_id JOIN tenants t ON t.id=r.tenant_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.report_date DESC, s.name LIMIT 500`;
  res.json(db.prepare(sql).all(...args).map(reportView));
});

router.get('/reports/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT * FROM daily_reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const c = contextFor(req.user, r.tenant_id);
  if (!c || (c.role === 'SITE_MANAGER' && c.site_id !== r.site_id)) return res.status(404).json({ error: 'not found' });
  res.json(reportView(r));
});

router.post('/reports', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const b = req.body || {};
  const site_id = req.ctx.role === 'SITE_MANAGER' ? req.ctx.site_id : b.site_id;
  if (!site_id || !b.report_date) return res.status(400).json({ error: 'site_id and report_date required' });
  const site = siteById(site_id);
  if (!site || site.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid site' });
  const totals = computeTotals(b);
  const existing = db.prepare('SELECT * FROM daily_reports WHERE tenant_id=? AND site_id=? AND report_date=?').get(req.ctx.tenant_id, site_id, b.report_date);
  const id = existing ? existing.id : uuid();
  const status = b.submit ? 'SUBMITTED' : (existing ? existing.status : 'DRAFT');
  db.prepare(`INSERT INTO daily_reports
    (id,tenant_id,site_id,report_date,total_sales,total_cash,total_deposit,diesel,expenses,balance,sales_json,production_json,notes,status,created_by,submitted_at)
    VALUES (@id,@tenant_id,@site_id,@report_date,@total_sales,@total_cash,@total_deposit,@diesel,@expenses,@balance,@sales_json,@production_json,@notes,@status,@created_by,@submitted_at)
    ON CONFLICT(tenant_id,site_id,report_date) DO UPDATE SET
      total_sales=@total_sales,total_cash=@total_cash,total_deposit=@total_deposit,diesel=@diesel,expenses=@expenses,
      balance=@balance,sales_json=@sales_json,production_json=@production_json,notes=@notes,status=@status,submitted_at=@submitted_at`)
    .run({
      id, tenant_id: req.ctx.tenant_id, site_id, report_date: b.report_date,
      total_sales: totals.total_sales, total_cash: +b.total_cash || 0, total_deposit: +b.total_deposit || 0,
      diesel: +b.diesel || 0, expenses: +b.expenses || 0, balance: totals.balance,
      sales_json: JSON.stringify(b.sales || []), production_json: JSON.stringify(b.production || {}),
      notes: b.notes || null, status, created_by: req.user.id,
      submitted_at: status === 'SUBMITTED' ? nowS() : (existing ? existing.submitted_at : null),
    });
  audit(req.ctx.tenant_id, req.user.id, existing ? 'UPDATE' : 'CREATE', 'report', id, { date: b.report_date, status });
  res.status(existing ? 200 : 201).json(reportView(db.prepare('SELECT * FROM daily_reports WHERE id=?').get(id)));
});

router.post('/reports/:id/email', requireAuth, async (req, res) => {
  const r = db.prepare('SELECT * FROM daily_reports WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const c = contextFor(req.user, r.tenant_id);
  if (!c || !atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'forbidden' });
  const tenant = tenantById(r.tenant_id), site = siteById(r.site_id);
  const recs = db.prepare('SELECT email FROM recipients WHERE tenant_id=? AND active=1').all(r.tenant_id).map((x) => x.email);
  const extra = Array.isArray(req.body?.extra) ? req.body.extra : [];
  const fallback = (process.env.DEFAULT_REPORT_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const to = [...new Set([...recs, ...extra, ...(recs.length ? [] : fallback)])].filter(Boolean);
  if (!to.length) return res.status(400).json({ error: 'no recipients configured' });
  const docs = db.prepare('SELECT * FROM documents WHERE report_id=?').all(r.id)
    .map((d) => ({ filename: d.file_name, path: path.join(UPLOAD_DIR, d.stored_name) })).filter((a) => fs.existsSync(a.path));
  try {
    const sent = await sendDailyReport({ tenant, site, report: r, to, attachments: docs });
    db.prepare('UPDATE daily_reports SET status=?, emailed_at=unixepoch() WHERE id=?').run('EMAILED', r.id);
    db.prepare('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status) VALUES (?,?,?,?,?,?)').run(uuid(), r.tenant_id, r.id, to.join(','), sent.subject, 'SENT');
    audit(r.tenant_id, req.user.id, 'EMAIL', 'report', r.id, { to });
    res.json({ ok: true, to, subject: sent.subject });
  } catch (e) {
    db.prepare('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status,error) VALUES (?,?,?,?,?,?,?)').run(uuid(), r.tenant_id, r.id, to.join(','), 'Daily report', 'FAILED', e.message);
    res.status(502).json({ error: 'email failed', detail: e.message });
  }
});

// ── DASHBOARD ──────────────────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, (req, res) => {
  const s = scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const { from, to } = req.query; const where = [], args = [];
  if (s.ctx) { where.push('r.tenant_id=?'); args.push(s.ctx.tenant_id);
    if (s.ctx.role === 'SITE_MANAGER') { where.push('r.site_id=?'); args.push(s.ctx.site_id); } }
  if (from) { where.push('r.report_date>=?'); args.push(from); }
  if (to) { where.push('r.report_date<=?'); args.push(to); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const totals = db.prepare(`SELECT COALESCE(SUM(total_sales),0) sales, COALESCE(SUM(total_cash),0) cash,
    COALESCE(SUM(total_deposit),0) deposit, COALESCE(SUM(diesel+expenses),0) costs, COUNT(*) reports FROM daily_reports r ${W}`).get(...args);
  const bySite = db.prepare(`SELECT s.name site, COALESCE(SUM(r.total_sales),0) sales FROM daily_reports r JOIN sites s ON s.id=r.site_id ${W} GROUP BY s.id ORDER BY sales DESC LIMIT 20`).all(...args);
  const byDay = db.prepare(`SELECT r.report_date day, COALESCE(SUM(r.total_sales),0) sales FROM daily_reports r ${W} GROUP BY r.report_date ORDER BY r.report_date DESC LIMIT 30`).all(...args);
  res.json({ totals, bySite, byDay: byDay.reverse() });
});

// ── DOCUMENTS ──────────────────────────────────────────────────────────────────
router.get('/documents', requireAuth, (req, res) => {
  const s = scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const { category, site } = req.query; const where = [], args = [];
  if (s.ctx) { where.push('d.tenant_id=?'); args.push(s.ctx.tenant_id);
    if (s.ctx.role === 'SITE_MANAGER') { where.push('(d.site_id=? OR d.site_id IS NULL)'); args.push(s.ctx.site_id); } }
  if (category) { where.push('d.category=?'); args.push(category); }
  if (site) { where.push('d.site_id=?'); args.push(site); }
  const sql = `SELECT d.*, s.name site_name, u.name uploader FROM documents d
    LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN users u ON u.id=d.uploaded_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.created_at DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
});

router.post('/documents', requireAuth, needTenant('SITE_MANAGER'), upload.array('files', 10), (req, res) => {
  const files = req.files || []; if (!files.length) return res.status(400).json({ error: 'no files uploaded' });
  const b = req.body || {};
  const site_id = req.ctx.role === 'SITE_MANAGER' ? req.ctx.site_id : (b.site_id || null);
  const ins = db.prepare(`INSERT INTO documents (id,tenant_id,site_id,report_id,category,title,description,file_name,stored_name,mime,size,uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const out = [];
  for (const f of files) {
    const id = uuid();
    ins.run(id, req.ctx.tenant_id, site_id, b.report_id || null, (b.category || 'OTHER').toUpperCase(),
      b.title || f.originalname, b.description || null, f.originalname, f.filename, f.mimetype, f.size, req.user.id);
    out.push(db.prepare('SELECT * FROM documents WHERE id=?').get(id));
  }
  audit(req.ctx.tenant_id, req.user.id, 'UPLOAD', 'document', out[0].id, { count: files.length, category: b.category });
  res.status(201).json(out);
});

router.get('/documents/:id/download', requireAuth, (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const c = contextFor(req.user, d.tenant_id);
  if (!c || (c.role === 'SITE_MANAGER' && d.site_id && d.site_id !== c.site_id)) return res.status(404).json({ error: 'not found' });
  const p = path.join(UPLOAD_DIR, d.stored_name);
  if (!fs.existsSync(p)) return res.status(410).json({ error: 'file missing on disk' });
  res.download(p, d.file_name);
});

router.delete('/documents/:id', requireAuth, (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  const c = contextFor(req.user, d.tenant_id);
  if (!c || !atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'forbidden' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch {}
  db.prepare('DELETE FROM documents WHERE id=?').run(d.id);
  audit(d.tenant_id, req.user.id, 'DELETE', 'document', d.id);
  res.json({ ok: true });
});

// ── RECIPIENTS ──────────────────────────────────────────────────────────────────
router.get('/recipients', requireAuth, needTenant('GENERAL_MANAGER'), (req, res) =>
  res.json(db.prepare('SELECT * FROM recipients WHERE tenant_id=? ORDER BY email').all(req.ctx.tenant_id)));
router.post('/recipients', requireAuth, needTenant('ADMIN'), (req, res) => {
  const { email, name } = req.body || {}; if (!email) return res.status(400).json({ error: 'email required' });
  const id = uuid();
  try { db.prepare('INSERT INTO recipients (id,tenant_id,email,name) VALUES (?,?,?,?)').run(id, req.ctx.tenant_id, email, name || null); }
  catch { return res.status(409).json({ error: 'recipient already exists' }); }
  res.status(201).json(db.prepare('SELECT * FROM recipients WHERE id=?').get(id));
});
router.delete('/recipients/:id', requireAuth, needTenant('ADMIN'), (req, res) => {
  db.prepare('DELETE FROM recipients WHERE id=? AND tenant_id=?').run(req.params.id, req.ctx.tenant_id);
  res.json({ ok: true });
});

router.get('/mail/health', requireAuth, async (_req, res) => res.json(await verifyConnection()));

// ── AI ASSISTANT ────────────────────────────────────────────────────────────
router.get('/ai/health', requireAuth, (_req, res) => res.json({ configured: aiConfigured() }));

// Build a compact context snapshot for the active tenant so the assistant can
// answer questions about the business's own numbers.
function aiContext(req) {
  const s = scope(req);
  if (s.error || s.all) return { scope: 'all companies', note: 'pick a workspace for company-specific figures' };
  const t = tenantById(s.ctx.tenant_id);
  const where = ['r.tenant_id=?']; const args = [s.ctx.tenant_id];
  if (s.ctx.role === 'SITE_MANAGER') { where.push('r.site_id=?'); args.push(s.ctx.site_id); }
  const W = 'WHERE ' + where.join(' AND ');
  const totals = db.prepare(`SELECT COALESCE(SUM(total_sales),0) sales, COALESCE(SUM(total_cash),0) cash,
    COALESCE(SUM(total_deposit),0) deposit, COALESCE(SUM(diesel+expenses),0) costs, COUNT(*) reports FROM daily_reports r ${W}`).get(...args);
  const recent = db.prepare(`SELECT r.report_date, s.name site, r.total_sales, r.balance FROM daily_reports r
    JOIN sites s ON s.id=r.site_id ${W} ORDER BY r.report_date DESC LIMIT 15`).all(...args);
  const sites = db.prepare('SELECT name, code FROM sites WHERE tenant_id=?').all(s.ctx.tenant_id);
  return { company: t.name, currency: t.currency, role: s.ctx.role, totals, sites, recent_reports: recent };
}

router.post('/ai/chat', requireAuth, async (req, res) => {
  const question = (req.body && req.body.message || '').toString().slice(0, 4000);
  if (!question.trim()) return res.status(400).json({ error: 'message required' });
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
  const ctx = aiContext(req);
  const system = `You are Daybook Assistant, a concise analyst inside Daybook — a daily sales & operations reporting app for businesses (e.g. water producers Fido Water and Fiafia Water). Help the signed-in user understand and act on THEIR company's reporting data.

Rules:
- Use only the data provided in CONTEXT below; if something isn't there, say you don't have it yet rather than inventing numbers.
- Amounts are in Nigerian Naira (₦). Format money with ₦ and thousands separators.
- Be brief and practical: surface trends, anomalies (e.g. a site with falling sales or high diesel cost), and clear next actions.
- You cannot change data; if asked to, explain which screen the user should use (Reports, Documents, Admin).

CONTEXT (live snapshot for this user):
${JSON.stringify(ctx)}`;
  const messages = [
    ...history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
    { role: 'user', content: question },
  ];
  try {
    const reply = await callAI({ system, messages, maxTokens: 700 });
    res.json({ reply });
  } catch (e) {
    const status = e instanceof AIError ? e.httpStatus : 502;
    res.status(status).json({ error: e.userMessage || e.message || 'AI error', code: e.code });
  }
});

module.exports = router;
