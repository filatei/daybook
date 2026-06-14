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
const { callAI, callAgent, AIError, aiConfigured } = require('./aiClient');
const sales = require('./salesSource');
const scheduler = require('./scheduler');

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
// POS (live fido sales) is available only to tenants explicitly linked to it
// (pos_source set, i.e. Fido/Fiafia) AND when the Mongo source is configured.
const posEnabled = (tenant_id) => sales.salesEnabled() && !!tenant_id && !!(tenantById(tenant_id) || {}).pos_source;
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, photo_url: u.photo_url, is_superadmin: !!u.is_superadmin });

// Create in-app notifications for a set of users (de-duped, skips empties).
function notify(tenant_id, userIds, { type, title, body, link } = {}) {
  const ins = db.prepare('INSERT INTO notifications (id,tenant_id,user_id,type,title,body,link) VALUES (?,?,?,?,?,?,?)');
  for (const u of [...new Set((userIds || []).filter(Boolean))]) {
    ins.run(uuid(), tenant_id || null, u, type || null, title || null, body || null, link || null);
  }
}
// User IDs in a tenant having at least `minRole` (for routing notifications).
function tenantUserIds(tenant_id, minRole) {
  return db.prepare('SELECT user_id, role FROM memberships WHERE tenant_id=? AND user_id IS NOT NULL').all(tenant_id)
    .filter((r) => !minRole || atLeast(r.role, minRole)).map((r) => r.user_id);
}
// Can the caller read/post in this chat channel? 'team' = any member; else a site they can access.
function channelAllowed(ctx, channel) {
  if (!channel || channel === 'team') return true;
  if (ctx.role === 'SITE_MANAGER') return channel === ctx.site_id;
  return !!db.prepare('SELECT 1 FROM sites WHERE id=? AND tenant_id=?').get(channel, ctx.tenant_id);
}

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
  const trialDays = parseInt(process.env.TRIAL_DAYS || '30', 10);
  const trialEnds = Math.floor(Date.now() / 1000) + trialDays * 86400;
  try {
    db.prepare('INSERT INTO tenants (id,slug,name,brand_color,currency,industry,plan,trial_ends_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, realSlug, name, brand_color || '#0ea5e9', currency || 'NGN', industry || null, 'FREE', trialEnds, req.user.id);
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
  if (status === 'SUBMITTED') {
    notify(req.ctx.tenant_id, tenantUserIds(req.ctx.tenant_id, 'GENERAL_MANAGER').filter((u) => u !== req.user.id),
      { type: 'report', title: `Report submitted — ${site.name}`, body: `${b.report_date} · sales ₦${(totals.total_sales || 0).toLocaleString()}`, link: 'reports' });
  }
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

// AI tool: read this tenant's own Daybook data (tenant- and site-scoped).
function daybookMetric(tenant_id, ctx, input) {
  const args = { tenant: tenant_id }; let siteF = '';
  if (ctx.role === 'SITE_MANAGER') { siteF = ' AND site_id=@site'; args.site = ctx.site_id; }
  const dateW = (col) => { let w = ''; if (input.from) { w += ` AND ${col}>=@from`; args.from = input.from; } if (input.to) { w += ` AND ${col}<=@to`; args.to = input.to; } return w; };
  switch (input.metric) {
    case 'reports': return { metric: 'reports', ...db.prepare(`SELECT COUNT(*) reports, COALESCE(SUM(total_sales),0) sales, COALESCE(SUM(diesel+expenses),0) costs, COALESCE(SUM(balance),0) balance FROM daily_reports WHERE tenant_id=@tenant${siteF}${dateW('report_date')}`).get(args) };
    case 'staff': return { metric: 'staff', count: db.prepare(`SELECT COUNT(*) c FROM staff WHERE tenant_id=@tenant AND status='ACTIVE'${siteF}`).get(args).c };
    case 'staff_hours': return { metric: 'staff_hours', ...db.prepare(`SELECT COUNT(CASE WHEN present=1 THEN 1 END) days_present, COALESCE(SUM(hours),0) hours, COALESCE(SUM(bags_bagged),0) bags_bagged, COALESCE(SUM(bags_loaded),0) bags_loaded FROM timesheets WHERE tenant_id=@tenant${siteF}${dateW('work_date')}`).get(args) };
    case 'generators': return { metric: 'generators', rows: db.prepare(`SELECT name, fuel_type, capacity_kva FROM generators WHERE tenant_id=@tenant${siteF} ORDER BY name`).all(args) };
    case 'generator_diesel': return { metric: 'generator_diesel', ...db.prepare(`SELECT COALESCE(SUM(litres),0) litres, COALESCE(SUM(cost),0) cost FROM generator_logs WHERE tenant_id=@tenant AND type='DIESEL'${siteF}${dateW('log_date')}`).get(args) };
    case 'pos_sales': return { metric: 'pos_sales', ...db.prepare(`SELECT COUNT(*) sales, COALESCE(SUM(total),0) total FROM pos_sales WHERE tenant_id=@tenant${siteF}${dateW('sale_date')}`).get(args) };
    default: return { error: 'unknown metric' };
  }
}

router.post('/ai/chat', requireAuth, async (req, res) => {
  const question = (req.body && req.body.message || '').toString().slice(0, 4000);
  if (!question.trim()) return res.status(400).json({ error: 'message required' });
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
  const ctx = aiContext(req);
  const system = `You are Daybook Assistant, a concise analyst inside Daybook — a daily sales & operations app for multi-site businesses. Help the signed-in user understand and act on THEIR OWN company's data only.

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

  // Give the assistant tools to read live data so it can answer ANY question —
  // the fido Mongo (sales, expenses, payroll, staff) for POS-linked companies,
  // plus this tenant's own Daybook data (reports, staff hours, generators, POS).
  const sc = scope(req);
  try {
    if (sc.ctx) {
      const tenant_id = sc.ctx.tenant_id;
      let allowed = db.prepare('SELECT code FROM sites WHERE tenant_id=?').all(tenant_id).map((s) => s.code);
      if (sc.ctx.role === 'SITE_MANAGER') { const me = siteById(sc.ctx.site_id); allowed = me ? [me.code] : []; }
      const pos = posEnabled(tenant_id);
      const resolveSites = (input) => {
        if (!input.site) return allowed;
        const want = String(input.site).toUpperCase().replace(/[^A-Z0-9]/g, '');
        return allowed.filter((c) => c.toUpperCase().replace(/[^A-Z0-9]/g, '') === want);
      };
      const tools = [{
        name: 'query_daybook',
        description: "Read this company's data entered in the Daybook app. metric: reports (daily report totals), staff (headcount), staff_hours (timesheet days/hours), generators (list), generator_diesel (litres+cost), pos_sales (in-app sales). Optional from/to date range (YYYY-MM-DD).",
        input_schema: { type: 'object', properties: {
          metric: { type: 'string', enum: ['reports', 'staff', 'staff_hours', 'generators', 'generator_diesel', 'pos_sales'] },
          from: { type: 'string' }, to: { type: 'string' },
        }, required: ['metric'] },
      }];
      if (pos) tools.push(
        { name: 'query_pos_sales', description: 'Live POS sales (fido) aggregated by site/paymentMethod/product/day over a date range. Amounts in ₦.', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, site: { type: 'string' }, groupBy: { type: 'string', enum: ['site', 'paymentMethod', 'product', 'day'] } }, required: ['from', 'to'] } },
        { name: 'query_expenses', description: 'Live expenses (fido) aggregated by site/category/day over a date range. Amounts in ₦.', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, site: { type: 'string' }, groupBy: { type: 'string', enum: ['site', 'category', 'day'] } }, required: ['from', 'to'] } },
        { name: 'query_payroll', description: 'Live payroll (fido) gross/net totals by site for a given month + year.', input_schema: { type: 'object', properties: { month: { type: 'string', description: 'full month name e.g. May' }, year: { type: 'string' }, site: { type: 'string' } }, required: ['month', 'year'] } },
        { name: 'count_staff', description: 'Live active staff headcount (fido) by site.', input_schema: { type: 'object', properties: { site: { type: 'string' } } } },
      );
      const sysT = system + `\n\nTODAY is ${new Date().toISOString().slice(0, 10)}. ${pos ? `This company is connected to its LIVE operational database — use query_pos_sales, query_expenses, query_payroll, count_staff for real figures. You may only see these sites: ${allowed.join(', ')}.` : ''} Use query_daybook for anything entered in this Daybook app. Call tools as needed (you can call several) and answer precisely in ₦.`;
      const runTool = async (name, input) => {
        try {
          if (name === 'query_pos_sales') { const s = resolveSites(input); return s.length ? { rows: await sales.query({ from: input.from, to: input.to, sites: s, groupBy: input.groupBy || 'site' }) } : { error: 'site not accessible', allowed }; }
          if (name === 'query_expenses') { const s = resolveSites(input); return s.length ? { rows: await sales.queryExpenses({ from: input.from, to: input.to, sites: s, groupBy: input.groupBy || 'site' }) } : { error: 'site not accessible', allowed }; }
          if (name === 'query_payroll') { const s = resolveSites(input); return { rows: await sales.payrollAgg({ month: input.month, year: input.year, sites: s }) }; }
          if (name === 'count_staff') { const s = resolveSites(input); return { rows: await sales.staffCount({ sites: s }) }; }
          if (name === 'query_daybook') return daybookMetric(tenant_id, sc.ctx, input);
          return { error: 'unknown tool' };
        } catch (e) { return { error: e.message }; }
      };
      const reply = await callAgent({ system: sysT, messages, tools, runTool, maxTokens: 1000 });
      return res.json({ reply });
    }
    const reply = await callAI({ system, messages, maxTokens: 700 });
    res.json({ reply });
  } catch (e) {
    const status = e instanceof AIError ? e.httpStatus : 502;
    res.status(status).json({ error: e.userMessage || e.message || 'AI error', code: e.code });
  }
});

// ── SALES SOURCE (read-only fido POS Mongo) ───────────────────────────────────
// Resolve the caller's access to a Daybook site; returns {site, ctx} or null.
function siteAccess(req, siteId) {
  const site = siteById(siteId);
  if (!site) return null;
  const c = contextFor(req.user, site.tenant_id);
  if (!c) return null;
  if (c.role === 'SITE_MANAGER' && c.site_id !== site.id) return null;
  return { site, ctx: c };
}

router.get('/sales/status', requireAuth, (req, res) => res.json({ enabled: posEnabled(requestedTenant(req)) }));

// Pull a site+date's real sales from the POS for the manager to review/confirm.
router.get('/sales/preview', requireAuth, async (req, res) => {
  const { site: siteId, date } = req.query;
  if (!siteId || !date) return res.status(400).json({ error: 'site and date required' });
  const a = siteAccess(req, siteId);
  if (!a) return res.status(403).json({ error: 'no access to this site' });
  if (!posEnabled(a.site.tenant_id)) return res.status(503).json({ error: 'POS not connected for this company', code: 'no_pos' });
  try {
    const s = await sales.getSales(a.site.code, date);
    let expenses = { total: 0, count: 0 };
    try { expenses = await sales.getExpensesTotal(a.site.code, date); } catch {}
    res.json({ site: { id: a.site.id, code: a.site.code, name: a.site.name }, date, sales: s, expenses });
  } catch (e) { res.status(e.httpStatus || 502).json({ error: e.message, code: e.code }); }
});

// All of a company's sites' POS sales for ANY single date (live aggregate).
router.get('/sales/by-date', requireAuth, async (req, res) => {
  const s = scope(req);
  if (s.error || !s.ctx) return res.status(s.ctx ? 200 : 400).json({ error: s.error || 'select a workspace' });
  if (!posEnabled(s.ctx.tenant_id)) return res.status(503).json({ error: 'POS not connected for this company', code: 'no_pos' });
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: 'date required' });
  let codes = db.prepare('SELECT code FROM sites WHERE tenant_id=?').all(s.ctx.tenant_id).map((x) => x.code);
  if (s.ctx.role === 'SITE_MANAGER') { const me = siteById(s.ctx.site_id); codes = me ? [me.code] : []; }
  if (!codes.length) return res.json({ date, rows: [], total: 0 });
  try {
    const rows = await sales.query({ from: date, to: date, sites: codes, groupBy: 'site' });
    res.json({ date, rows, total: rows.reduce((a, r) => a + (r.amount || 0), 0) });
  } catch (e) { res.status(e.httpStatus || 502).json({ error: e.message, code: e.code }); }
});

// Read computed payroll (already finalised in the POS) for a month/year.
router.get('/payroll', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) => {
  if (!posEnabled(req.ctx.tenant_id)) return res.status(503).json({ error: 'POS not connected for this company', code: 'no_pos' });
  try {
    const rows = await sales.getPayroll({ month: req.query.month, year: req.query.year, siteName: req.query.site });
    res.json(rows);
  } catch (e) { res.status(e.httpStatus || 502).json({ error: e.message, code: e.code }); }
});

// AI analysis of a site+date (pulls POS sales when available).
router.post('/ai/analyse', requireAuth, async (req, res) => {
  const { site: siteId, date } = req.body || {};
  if (!siteId || !date) return res.status(400).json({ error: 'site and date required' });
  const a = siteAccess(req, siteId);
  if (!a) return res.status(403).json({ error: 'no access to this site' });
  let posData = null;
  if (posEnabled(a.site.tenant_id)) { try { posData = await sales.getSales(a.site.code, date); } catch {} }
  const existing = db.prepare('SELECT * FROM daily_reports WHERE tenant_id=? AND site_id=? AND report_date=?').get(a.site.tenant_id, siteId, date);
  const system = `You are Daybook Assistant analysing one site's day for a water business. Be concise and practical: state total sales, cash vs transfer split, top products, and flag anything unusual (a payment method missing, a product with zero sales, sales far from typical). End with one recommended action. Money is Naira (₦).`;
  const payload = { site: a.site.name, date, pos_sales: posData, saved_report: existing ? { total_sales: existing.total_sales, total_cash: existing.total_cash, total_deposit: existing.total_deposit, diesel: existing.diesel, expenses: existing.expenses, balance: existing.balance } : null };
  try {
    const reply = await callAI({ system, messages: [{ role: 'user', content: 'Analyse this day:\n' + JSON.stringify(payload) }], maxTokens: 600 });
    res.json({ reply, pos_sales: posData });
  } catch (e) { res.status(e instanceof AIError ? e.httpStatus : 502).json({ error: e.userMessage || e.message, code: e.code }); }
});

// ── STAFF & TIMESHEETS (live staff-hours; Daybook-owned) ──────────────────────
router.get('/staff', requireAuth, (req, res) => {
  const s = scope(req); if (s.error) return res.status(403).json({ error: s.error });
  if (s.all) return res.json(db.prepare('SELECT * FROM staff ORDER BY full_name').all());
  if (s.ctx.role === 'SITE_MANAGER') return res.json(db.prepare("SELECT * FROM staff WHERE tenant_id=? AND site_id=? AND status='ACTIVE' ORDER BY full_name").all(s.ctx.tenant_id, s.ctx.site_id));
  const site = req.query.site;
  res.json(site ? db.prepare('SELECT * FROM staff WHERE tenant_id=? AND site_id=? ORDER BY full_name').all(s.ctx.tenant_id, site)
    : db.prepare('SELECT * FROM staff WHERE tenant_id=? ORDER BY full_name').all(s.ctx.tenant_id));
});
router.post('/staff', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const b = req.body || {};
  const site_id = req.ctx.role === 'SITE_MANAGER' ? req.ctx.site_id : b.site_id;
  if (!b.full_name || !site_id) return res.status(400).json({ error: 'full_name and site_id required' });
  const site = siteById(site_id); if (!site || site.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid site' });
  const id = uuid();
  try { db.prepare('INSERT INTO staff (id,tenant_id,site_id,full_name,role_title,phone,pay_type) VALUES (?,?,?,?,?,?,?)').run(id, req.ctx.tenant_id, site_id, b.full_name.trim(), b.role_title || null, b.phone || null, b.pay_type || 'DAILY'); }
  catch { return res.status(409).json({ error: 'staff already exists for this site' }); }
  res.status(201).json(db.prepare('SELECT * FROM staff WHERE id=?').get(id));
});
router.patch('/staff/:id', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const st = db.prepare('SELECT * FROM staff WHERE id=?').get(req.params.id);
  if (!st || st.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (req.ctx.role === 'SITE_MANAGER' && st.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const f = req.body || {};
  db.prepare('UPDATE staff SET full_name=?,role_title=?,phone=?,pay_type=?,status=?,site_id=? WHERE id=?')
    .run(f.full_name ?? st.full_name, f.role_title ?? st.role_title, f.phone ?? st.phone, f.pay_type ?? st.pay_type, f.status ?? st.status, req.ctx.role === 'SITE_MANAGER' ? st.site_id : (f.site_id ?? st.site_id), st.id);
  res.json(db.prepare('SELECT * FROM staff WHERE id=?').get(st.id));
});
// Import staff from the POS `peoples` collection, matched to this tenant's sites.
router.post('/staff/import', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) => {
  if (!posEnabled(req.ctx.tenant_id)) return res.status(503).json({ error: 'POS not connected for this company', code: 'no_pos' });
  try {
    const people = await sales.getStaff();
    const sites = db.prepare('SELECT * FROM sites WHERE tenant_id=?').all(req.ctx.tenant_id);
    const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const ins = db.prepare('INSERT OR IGNORE INTO staff (id,tenant_id,site_id,full_name,ext_people_id) VALUES (?,?,?,?,?)');
    let added = 0;
    for (const p of people) {
      if (!p.name || !p.siteName) continue;
      const site = sites.find((s) => norm(s.code) === norm(p.siteName) || norm(s.name) === norm(p.siteName));
      if (!site) continue;
      if (ins.run(uuid(), req.ctx.tenant_id, site.id, p.name, p.ext_id).changes) added++;
    }
    audit(req.ctx.tenant_id, req.user.id, 'IMPORT', 'staff', null, { added });
    res.json({ imported: added, scanned: people.length });
  } catch (e) { res.status(e.httpStatus || 502).json({ error: e.message, code: e.code }); }
});

router.get('/timesheets', requireAuth, (req, res) => {
  const s = scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const { site, from, to, date } = req.query; const where = [], args = [];
  if (s.ctx) { where.push('t.tenant_id=?'); args.push(s.ctx.tenant_id);
    if (s.ctx.role === 'SITE_MANAGER') { where.push('t.site_id=?'); args.push(s.ctx.site_id); }
    else if (site) { where.push('t.site_id=?'); args.push(site); } }
  if (date) { where.push('t.work_date=?'); args.push(date); }
  if (from) { where.push('t.work_date>=?'); args.push(from); }
  if (to) { where.push('t.work_date<=?'); args.push(to); }
  const sql = `SELECT t.*, st.full_name FROM timesheets t JOIN staff st ON st.id=t.staff_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.work_date DESC, st.full_name LIMIT 2000`;
  res.json(db.prepare(sql).all(...args));
});
router.post('/timesheets', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const b = req.body || {}; const work_date = b.work_date; const entries = Array.isArray(b.entries) ? b.entries : [];
  const site_id = req.ctx.role === 'SITE_MANAGER' ? req.ctx.site_id : b.site_id;
  if (!work_date || !site_id) return res.status(400).json({ error: 'work_date and site_id required' });
  const up = db.prepare(`INSERT INTO timesheets (id,tenant_id,site_id,staff_id,work_date,present,hours,bags_bagged,bags_loaded,note,recorded_by)
    VALUES (@id,@tenant_id,@site_id,@staff_id,@work_date,@present,@hours,@bags_bagged,@bags_loaded,@note,@recorded_by)
    ON CONFLICT(staff_id,work_date) DO UPDATE SET present=@present,hours=@hours,bags_bagged=@bags_bagged,bags_loaded=@bags_loaded,note=@note,recorded_by=@recorded_by`);
  let n = 0;
  for (const e of entries) {
    const st = db.prepare('SELECT tenant_id FROM staff WHERE id=?').get(e.staff_id);
    if (!st || st.tenant_id !== req.ctx.tenant_id) continue;
    up.run({ id: uuid(), tenant_id: req.ctx.tenant_id, site_id, staff_id: e.staff_id, work_date, present: e.present ? 1 : 0, hours: e.hours ?? null, bags_bagged: e.bags_bagged ?? null, bags_loaded: e.bags_loaded ?? null, note: e.note || null, recorded_by: req.user.id });
    n++;
  }
  res.json({ saved: n, work_date });
});
function tsSummary(tenant_id, site, from, to) {
  const where = ['t.tenant_id=?'], args = [tenant_id];
  if (site) { where.push('t.site_id=?'); args.push(site); }
  if (from) { where.push('t.work_date>=?'); args.push(from); }
  if (to) { where.push('t.work_date<=?'); args.push(to); }
  return db.prepare(`SELECT st.full_name staff, si.name site, COUNT(CASE WHEN t.present=1 THEN 1 END) days,
    COALESCE(SUM(t.hours),0) hours, COALESCE(SUM(t.bags_bagged),0) bags_bagged, COALESCE(SUM(t.bags_loaded),0) bags_loaded
    FROM timesheets t JOIN staff st ON st.id=t.staff_id JOIN sites si ON si.id=t.site_id
    WHERE ${where.join(' AND ')} GROUP BY t.staff_id ORDER BY si.name, st.full_name`).all(...args);
}
router.get('/timesheets/summary', requireAuth, (req, res) => {
  const s = scope(req); if (s.error || !s.ctx) return res.status(s.ctx ? 200 : 400).json({ error: s.error || 'select a workspace' });
  const site = s.ctx.role === 'SITE_MANAGER' ? s.ctx.site_id : req.query.site;
  res.json(tsSummary(s.ctx.tenant_id, site, req.query.from, req.query.to));
});
router.get('/timesheets/summary.csv', requireAuth, (req, res) => {
  const s = scope(req); if (s.error || !s.ctx) return res.status(400).send(s.error || 'select a workspace');
  const site = s.ctx.role === 'SITE_MANAGER' ? s.ctx.site_id : req.query.site;
  const rows = tsSummary(s.ctx.tenant_id, site, req.query.from, req.query.to);
  const csv = ['Staff,Site,Days,Hours,Bags Bagged,Bags Loaded',
    ...rows.map((r) => [r.staff, r.site, r.days, r.hours, r.bags_bagged, r.bags_loaded].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="timesheets-${req.query.from || 'all'}_${req.query.to || 'all'}.csv"`);
  res.send(csv);
});

// Manually run the POS→Daybook sync for a date (superadmin only).
router.post('/sync/run', requireAuth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'superadmin only' });
  if (!sales.salesEnabled()) return res.status(503).json({ error: 'Sales source not configured', code: 'no_sales_source' });
  const date = (req.body && req.body.date) || new Date().toLocaleDateString('en-CA', { timeZone: process.env.SYNC_TZ || 'Africa/Lagos' });
  try { res.json(await scheduler.syncDay(date, { email: !!(req.body && req.body.email) })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ── GENERATORS (per-site power assets + diesel/maintenance logs) ──────────────
router.get('/generators', requireAuth, (req, res) => {
  const s = scope(req); if (s.error) return res.status(403).json({ error: s.error });
  if (s.all) return res.json(db.prepare('SELECT * FROM generators ORDER BY name').all());
  if (s.ctx.role === 'SITE_MANAGER') return res.json(db.prepare("SELECT * FROM generators WHERE tenant_id=? AND site_id=? ORDER BY name").all(s.ctx.tenant_id, s.ctx.site_id));
  const site = req.query.site;
  res.json(site ? db.prepare('SELECT * FROM generators WHERE tenant_id=? AND site_id=? ORDER BY name').all(s.ctx.tenant_id, site)
    : db.prepare('SELECT * FROM generators WHERE tenant_id=? ORDER BY name').all(s.ctx.tenant_id));
});
router.post('/generators', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const b = req.body || {};
  const site_id = req.ctx.role === 'SITE_MANAGER' ? req.ctx.site_id : (b.site_id || null);
  if (!b.name) return res.status(400).json({ error: 'name required' });
  if (site_id) { const site = siteById(site_id); if (!site || site.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid site' }); }
  const id = uuid();
  db.prepare(`INSERT INTO generators (id,tenant_id,site_id,name,fuel_type,make_model,capacity_kva,serial_no,purchase_date,purchase_cost,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, req.ctx.tenant_id, site_id, b.name.trim(), (b.fuel_type || 'DIESEL'), b.make_model || null, b.capacity_kva || null, b.serial_no || null, b.purchase_date || null, b.purchase_cost || null, b.notes || null, req.user.id);
  audit(req.ctx.tenant_id, req.user.id, 'CREATE', 'generator', id, { name: b.name });
  res.status(201).json(db.prepare('SELECT * FROM generators WHERE id=?').get(id));
});
router.patch('/generators/:id', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const g = db.prepare('SELECT * FROM generators WHERE id=?').get(req.params.id);
  if (!g || g.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (req.ctx.role === 'SITE_MANAGER' && g.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const f = req.body || {};
  db.prepare(`UPDATE generators SET name=?,fuel_type=?,make_model=?,capacity_kva=?,serial_no=?,purchase_date=?,purchase_cost=?,status=?,notes=? WHERE id=?`)
    .run(f.name ?? g.name, f.fuel_type ?? g.fuel_type, f.make_model ?? g.make_model, f.capacity_kva ?? g.capacity_kva, f.serial_no ?? g.serial_no, f.purchase_date ?? g.purchase_date, f.purchase_cost ?? g.purchase_cost, f.status ?? g.status, f.notes ?? g.notes, g.id);
  res.json(db.prepare('SELECT * FROM generators WHERE id=?').get(g.id));
});
router.get('/generators/:id/logs', requireAuth, (req, res) => {
  const g = db.prepare('SELECT * FROM generators WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: 'not found' });
  const c = contextFor(req.user, g.tenant_id);
  if (!c || (c.role === 'SITE_MANAGER' && g.site_id && g.site_id !== c.site_id)) return res.status(404).json({ error: 'not found' });
  const { from, to } = req.query; const where = ['generator_id=?'], args = [g.id];
  if (from) { where.push('log_date>=?'); args.push(from); }
  if (to) { where.push('log_date<=?'); args.push(to); }
  const logs = db.prepare(`SELECT * FROM generator_logs WHERE ${where.join(' AND ')} ORDER BY log_date DESC, created_at DESC LIMIT 500`).all(...args);
  const tot = db.prepare(`SELECT COALESCE(SUM(litres),0) litres, COALESCE(SUM(cost),0) cost FROM generator_logs WHERE ${where.join(' AND ')} AND type='DIESEL'`).get(...args);
  res.json({ logs, diesel_total: tot });
});
router.post('/generators/:id/logs', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const g = db.prepare('SELECT * FROM generators WHERE id=?').get(req.params.id);
  if (!g || g.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (req.ctx.role === 'SITE_MANAGER' && g.site_id && g.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {}; const type = (b.type || 'DIESEL').toUpperCase();
  if (!['DIESEL', 'MAINTENANCE', 'NOTE'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  const id = uuid();
  db.prepare(`INSERT INTO generator_logs (id,tenant_id,generator_id,site_id,log_date,type,litres,cost,runtime_hours,detail,recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, g.tenant_id, g.id, g.site_id, b.log_date || new Date().toISOString().slice(0, 10), type, b.litres ?? null, b.cost ?? null, b.runtime_hours ?? null, b.detail || null, req.user.id);
  res.status(201).json(db.prepare('SELECT * FROM generator_logs WHERE id=?').get(id));
});

// ── IN-APP POS (products, customers, live sales, inventory) ───────────────────
// Available to self-contained tenants (those NOT linked to the external fido POS).
function internalPos(tenant_id) { const t = tenantById(tenant_id); return !!t && !t.pos_source; }

router.get('/products', requireAuth, (req, res) => {
  const s = scope(req); if (s.error) return res.status(403).json({ error: s.error });
  if (s.all) return res.json(db.prepare('SELECT * FROM products ORDER BY name').all());
  res.json(db.prepare("SELECT * FROM products WHERE tenant_id=? ORDER BY status, name").all(s.ctx.tenant_id));
});
router.post('/products', requireAuth, needTenant('GENERAL_MANAGER'), (req, res) => {
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  try {
    db.prepare(`INSERT INTO products (id,tenant_id,name,category,price,cost,sku,unit,track_stock,stock_qty)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, req.ctx.tenant_id, b.name.trim(), b.category || null, +b.price || 0, +b.cost || 0, b.sku || null, b.unit || 'unit', b.track_stock === false ? 0 : 1, +b.stock_qty || 0);
  } catch { return res.status(409).json({ error: 'product name already exists' }); }
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id=?').get(id));
});
router.patch('/products/:id', requireAuth, needTenant('GENERAL_MANAGER'), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p || p.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  const f = req.body || {};
  db.prepare('UPDATE products SET name=?,category=?,price=?,cost=?,sku=?,unit=?,track_stock=?,status=? WHERE id=?')
    .run(f.name ?? p.name, f.category ?? p.category, f.price ?? p.price, f.cost ?? p.cost, f.sku ?? p.sku, f.unit ?? p.unit, f.track_stock != null ? (f.track_stock ? 1 : 0) : p.track_stock, f.status ?? p.status, p.id);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(p.id));
});
// Stock movement (purchase / manual adjust). qty signed.
router.post('/products/:id/stock', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p || p.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  const b = req.body || {}; const qty = +b.qty || 0; const type = (b.type || 'ADJUST').toUpperCase();
  if (!qty) return res.status(400).json({ error: 'qty required' });
  db.prepare('INSERT INTO inventory_moves (id,tenant_id,product_id,site_id,type,qty,unit_cost,note,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uuid(), p.tenant_id, p.id, req.ctx.role === 'SITE_MANAGER' ? req.ctx.site_id : (b.site_id || null), ['PURCHASE', 'ADJUST'].includes(type) ? type : 'ADJUST', qty, +b.unit_cost || null, b.note || null, req.user.id);
  db.prepare('UPDATE products SET stock_qty=stock_qty+? WHERE id=?').run(qty, p.id);
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(p.id));
});

router.get('/customers', requireAuth, (req, res) => {
  const s = scope(req); if (s.error || !s.ctx) return res.status(s.ctx ? 200 : 400).json({ error: s.error || 'select a workspace' });
  const q = req.query.q;
  res.json(q ? db.prepare("SELECT * FROM customers WHERE tenant_id=? AND name LIKE ? ORDER BY name LIMIT 50").all(s.ctx.tenant_id, '%' + q + '%')
    : db.prepare('SELECT * FROM customers WHERE tenant_id=? ORDER BY name LIMIT 200').all(s.ctx.tenant_id));
});
router.post('/customers', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  db.prepare('INSERT INTO customers (id,tenant_id,name,phone,email,note) VALUES (?,?,?,?,?,?)').run(id, req.ctx.tenant_id, b.name.trim(), b.phone || null, b.email || null, b.note || null);
  res.status(201).json(db.prepare('SELECT * FROM customers WHERE id=?').get(id));
});

// Record a live sale → decrements stock, assigns a receipt number, returns the sale.
router.post('/pos/sales', requireAuth, needTenant('SITE_MANAGER'), (req, res) => {
  const b = req.body || {};
  // Idempotency: a re-sent offline sale (same client_uid) returns the original.
  if (b.client_uid) {
    const dup = db.prepare('SELECT * FROM pos_sales WHERE tenant_id=? AND client_uid=?').get(req.ctx.tenant_id, b.client_uid);
    if (dup) return res.status(200).json(dup);
  }
  const items = Array.isArray(b.items) ? b.items.filter((i) => i.product_id && (+i.qty > 0)) : [];
  if (!items.length) return res.status(400).json({ error: 'no items' });
  const site_id = req.ctx.role === 'SITE_MANAGER' ? req.ctx.site_id : (b.site_id || null);
  const lines = [];
  for (const it of items) {
    const p = db.prepare('SELECT * FROM products WHERE id=? AND tenant_id=?').get(it.product_id, req.ctx.tenant_id);
    if (!p) return res.status(400).json({ error: 'invalid product in cart' });
    const qty = +it.qty; const price = it.price != null ? +it.price : p.price; const amount = qty * price;
    lines.push({ product_id: p.id, name: p.name, qty, price, amount, track: p.track_stock });
  }
  const subtotal = lines.reduce((a, l) => a + l.amount, 0);
  const discount = +b.discount || 0;
  const total = Math.max(0, subtotal - discount);
  const amount_paid = b.amount_paid != null ? +b.amount_paid : total;
  const balance = +(total - amount_paid).toFixed(2);
  const status = balance <= 0 ? 'PAID' : (amount_paid > 0 ? 'PART' : 'UNPAID');
  const id = uuid();
  const nextNo = (db.prepare('SELECT COALESCE(MAX(receipt_no),0)+1 n FROM pos_sales WHERE tenant_id=?').get(req.ctx.tenant_id).n);
  const sale_date = b.sale_date || new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });
  db.prepare(`INSERT INTO pos_sales (id,tenant_id,site_id,receipt_no,customer_id,customer_name,items_json,subtotal,discount,total,payment_method,amount_paid,balance,status,sale_date,client_uid,sold_by)
    VALUES (@id,@tenant_id,@site_id,@receipt_no,@customer_id,@customer_name,@items_json,@subtotal,@discount,@total,@payment_method,@amount_paid,@balance,@status,@sale_date,@client_uid,@sold_by)`)
    .run({ id, tenant_id: req.ctx.tenant_id, site_id, receipt_no: nextNo, customer_id: b.customer_id || null, customer_name: b.customer_name || null,
      items_json: JSON.stringify(lines.map((l) => ({ product_id: l.product_id, name: l.name, qty: l.qty, price: l.price, amount: l.amount }))),
      subtotal, discount, total, payment_method: (b.payment_method || 'CASH').toUpperCase(), amount_paid, balance, status, sale_date, client_uid: b.client_uid || null, sold_by: req.user.id });
  // stock decrement + inventory move
  for (const l of lines) {
    if (!l.track) continue;
    db.prepare('UPDATE products SET stock_qty=stock_qty-? WHERE id=?').run(l.qty, l.product_id);
    db.prepare('INSERT INTO inventory_moves (id,tenant_id,product_id,site_id,type,qty,ref,created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(uuid(), req.ctx.tenant_id, l.product_id, site_id, 'SALE', -l.qty, 'receipt#' + nextNo, req.user.id);
  }
  res.status(201).json(db.prepare('SELECT * FROM pos_sales WHERE id=?').get(id));
});
router.get('/pos/sales', requireAuth, (req, res) => {
  const s = scope(req); if (s.error || !s.ctx) return res.status(s.ctx ? 200 : 400).json({ error: s.error || 'select a workspace' });
  const { from, to, site } = req.query; const where = ['p.tenant_id=?'], args = [s.ctx.tenant_id];
  if (s.ctx.role === 'SITE_MANAGER') { where.push('p.site_id=?'); args.push(s.ctx.site_id); } else if (site) { where.push('p.site_id=?'); args.push(site); }
  if (from) { where.push('p.sale_date>=?'); args.push(from); }
  if (to) { where.push('p.sale_date<=?'); args.push(to); }
  res.json(db.prepare(`SELECT p.*, s.name site_name FROM pos_sales p LEFT JOIN sites s ON s.id=p.site_id WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT 300`).all(...args));
});
router.get('/pos/sales/:id', requireAuth, (req, res) => {
  const sale = db.prepare('SELECT * FROM pos_sales WHERE id=?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'not found' });
  const c = contextFor(req.user, sale.tenant_id);
  if (!c || (c.role === 'SITE_MANAGER' && sale.site_id && sale.site_id !== c.site_id)) return res.status(404).json({ error: 'not found' });
  res.json({ ...sale, items: J(sale.items_json, []), tenant: tenantById(sale.tenant_id), site: sale.site_id ? siteById(sale.site_id) : null });
});
// Per-day POS summary (feeds the dashboard panel + daily report pull for self-contained tenants).
router.get('/pos/summary', requireAuth, (req, res) => {
  const s = scope(req); if (s.error || !s.ctx) return res.status(s.ctx ? 200 : 400).json({ error: s.error || 'select a workspace' });
  const date = req.query.date; if (!date) return res.status(400).json({ error: 'date required' });
  const where = ['tenant_id=?', 'sale_date=?'], args = [s.ctx.tenant_id, date];
  if (s.ctx.role === 'SITE_MANAGER') { where.push('site_id=?'); args.push(s.ctx.site_id); } else if (req.query.site) { where.push('site_id=?'); args.push(req.query.site); }
  const W = 'WHERE ' + where.join(' AND ');
  const rows = db.prepare(`SELECT * FROM pos_sales ${W}`).all(...args);
  const total = rows.reduce((a, r) => a + (r.total || 0), 0);
  const pay = {}; const prod = {};
  for (const r of rows) {
    pay[r.payment_method] = (pay[r.payment_method] || 0) + (r.total || 0);
    for (const it of J(r.items_json, [])) { const k = it.name; if (!prod[k]) prod[k] = { product: k, qty: 0, amount: 0 }; prod[k].qty += it.qty; prod[k].amount += it.amount; }
  }
  const cash = pay.CASH || 0;
  res.json({ date, total, orders: rows.length, total_cash: cash, total_deposit: total - cash,
    payments: Object.entries(pay).map(([method, amount]) => ({ method, amount })), lines: Object.values(prod) });
});

// ── STAFF CHAT (WhatsApp-style, per company; channel = 'team' or a site_id) ───
router.get('/chat/channels', requireAuth, (req, res) => {
  const s = scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const out = [{ id: 'team', name: 'Team', kind: 'team' }];
  let sites = db.prepare('SELECT id, name, code FROM sites WHERE tenant_id=? ORDER BY name').all(s.ctx.tenant_id);
  if (s.ctx.role === 'SITE_MANAGER') sites = sites.filter((x) => x.id === s.ctx.site_id);
  for (const x of sites) out.push({ id: x.id, name: x.name, code: x.code, kind: 'site' });
  res.json(out);
});
router.get('/chat/messages', requireAuth, (req, res) => {
  const s = scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const channel = req.query.channel || 'team';
  if (!channelAllowed(s.ctx, channel)) return res.status(403).json({ error: 'no access to this channel' });
  const since = parseInt(req.query.since, 10) || 0;
  const rows = db.prepare(`SELECT id, channel, user_id, user_name, body, created_at FROM messages
    WHERE tenant_id=? AND channel=? AND created_at>? ORDER BY created_at ASC, id ASC LIMIT 200`)
    .all(s.ctx.tenant_id, channel, since);
  res.json(rows.map((m) => ({ ...m, mine: m.user_id === req.user.id })));
});
router.post('/chat/messages', requireAuth, (req, res) => {
  const s = scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const b = req.body || {};
  const channel = b.channel || 'team';
  const body = (b.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'empty message' });
  if (!channelAllowed(s.ctx, channel)) return res.status(403).json({ error: 'no access to this channel' });
  // Idempotent on client_uid so offline re-sends don't duplicate.
  if (b.client_uid) {
    const dup = db.prepare('SELECT id FROM messages WHERE tenant_id=? AND client_uid=?').get(s.ctx.tenant_id, b.client_uid);
    if (dup) return res.json({ id: dup.id, duplicate: true });
  }
  const id = uuid();
  const name = req.user.name || req.user.email;
  db.prepare('INSERT INTO messages (id,tenant_id,channel,user_id,user_name,body,client_uid) VALUES (?,?,?,?,?,?,?)')
    .run(id, s.ctx.tenant_id, channel, req.user.id, name, body.slice(0, 2000), b.client_uid || null);
  // Notify the rest of the channel audience (skip self) so the bell lights up.
  let audience = tenantUserIds(s.ctx.tenant_id, 'SITE_MANAGER');
  if (channel !== 'team') {
    const siteUsers = db.prepare("SELECT user_id, role, site_id FROM memberships WHERE tenant_id=? AND user_id IS NOT NULL").all(s.ctx.tenant_id)
      .filter((m) => atLeast(m.role, 'GENERAL_MANAGER') || m.site_id === channel).map((m) => m.user_id);
    audience = siteUsers;
  }
  const label = channel === 'team' ? 'Team chat' : (siteById(channel) || {}).name || 'Site chat';
  notify(s.ctx.tenant_id, audience.filter((u) => u !== req.user.id),
    { type: 'chat', title: `${name} · ${label}`, body: body.slice(0, 120), link: `chat:${channel}` });
  res.status(201).json({ id, channel, user_id: req.user.id, user_name: name, body, created_at: nowS(), mine: true });
});

// ── NOTIFICATIONS (in-app bell) ───────────────────────────────────────────────
router.get('/notifications', requireAuth, (req, res) => {
  const tid = requestedTenant(req);
  const args = [req.user.id]; let tw = '';
  if (tid) { tw = ' AND (tenant_id=? OR tenant_id IS NULL)'; args.push(tid); }
  const list = db.prepare(`SELECT * FROM notifications WHERE user_id=?${tw} ORDER BY created_at DESC LIMIT 60`).all(...args);
  const unread = db.prepare(`SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0${tw}`).get(...args).n;
  res.json({ unread, list });
});
router.post('/notifications/read', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (ids && ids.length) {
    const q = db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND id=?');
    for (const i of ids) q.run(req.user.id, i);
  } else {
    db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  }
  res.json({ ok: true });
});

// ── BILLING (superadmin: mark a tenant paid / extend / reactivate) ────────────
router.post('/tenants/:id/billing', requireAuth, (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'superadmin only' });
  const t = tenantById(req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const now = Math.floor(Date.now() / 1000);
  const paid_until = b.paid_until ? parseInt(b.paid_until, 10)
    : (b.months ? now + parseInt(b.months, 10) * 2629800 : t.paid_until);
  db.prepare('UPDATE tenants SET paid_until=?, plan=?, status=? WHERE id=?')
    .run(paid_until, b.plan ?? t.plan, b.status ?? 'ACTIVE', t.id);
  audit(t.id, req.user.id, 'BILLING', 'tenant', t.id, { paid_until, plan: b.plan });
  res.json(tenantById(t.id));
});

module.exports = router;
