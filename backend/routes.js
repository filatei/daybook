/**
 * Daybook — REST API routes (multi-client SaaS, Google sign-in, memberships)
 * Postgres/async port: all route handlers are async; db calls use qone/qall/qrun.
 */
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');
const {
  verifyGoogleToken, signSession, requireAuth,
  accessibleTenants, contextFor, requestedTenant, atLeast, siteBound, GOOGLE_CLIENT_ID,
} = require('./auth');
const { sendDailyReport, sendInvite, verifyConnection, sendTest, FROM: MAIL_FROM } = require('./mailer');

const ROLE_LABELS = {
  GATEMAN: 'Gateman / Security', SUPERVISOR: 'Supervisor (loading)', GATE: 'Gate',
  SECRETARY: 'Secretary', ACCOUNTANT: 'Accountant', SNR_ACCOUNTANT: 'Snr Accountant',
  SITE_MANAGER: 'Manager', GENERAL_MANAGER: 'General Manager', ADMIN: 'Admin',
};

// Fire-and-forget invite email + email_log entry (never blocks the add).
async function emailInvite(tenant_id, inviterId, email, role) {
  try {
    const t = await qone('SELECT name, brand_color FROM tenants WHERE id=?', [tenant_id]);
    const inviter = await qone('SELECT name, email FROM users WHERE id=?', [inviterId]);
    const sent = await sendInvite({
      to: email, tenantName: t?.name || 'your company', roleLabel: ROLE_LABELS[role] || role,
      inviterName: inviter?.name || inviter?.email || null, brand: t?.brand_color || '#0ea5e9',
    });
    await qrun('INSERT INTO email_log (id,tenant_id,to_addrs,subject,status) VALUES (?,?,?,?,?)',
      [uuid(), tenant_id, email, sent.subject, 'SENT']);
    return { ok: true };
  } catch (e) {
    await qrun('INSERT INTO email_log (id,tenant_id,to_addrs,subject,status,error) VALUES (?,?,?,?,?,?)',
      [uuid(), tenant_id, email, 'You have been added to Daybook', 'FAILED', e.message]).catch(() => {});
    return { ok: false, error: e.message };
  }
}
const { callAI, callAgent, AIError, aiConfigured } = require('./aiClient');
const sales = require('./salesSource');
const scheduler = require('./scheduler');
const payments = require('./payments');
const ls = require('./lemonsqueezy');
const { emitEvent } = require('./realtime');

const router = express.Router();

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

async function audit(tenant_id, user_id, action, entity, entity_id, meta) {
  await qrun('INSERT INTO audit_log (id,tenant_id,user_id,action,entity,entity_id,meta) VALUES (?,?,?,?,?,?,?)',
    [uuid(), tenant_id || null, user_id || null, action, entity, entity_id || null, meta ? JSON.stringify(meta) : null]);
}
const tenantById = (id) => qone('SELECT * FROM tenants WHERE id=?', [id]);
const siteById = (id) => qone('SELECT * FROM sites WHERE id=?', [id]);
const posEnabled = async (tenant_id) => {
  if (!sales.salesEnabled() || !tenant_id) return false;
  const t = await tenantById(tenant_id);
  return !!(t && t.pos_source);
};
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, photo_url: u.photo_url, is_superadmin: !!u.is_superadmin });

async function notify(tenant_id, userIds, { type, title, body, link } = {}) {
  for (const u of [...new Set((userIds || []).filter(Boolean))]) {
    await qrun('INSERT INTO notifications (id,tenant_id,user_id,type,title,body,link) VALUES (?,?,?,?,?,?,?)',
      [uuid(), tenant_id || null, u, type || null, title || null, body || null, link || null]);
  }
}
async function tenantUserIds(tenant_id, minRole) {
  const rows = await qall('SELECT user_id, role FROM memberships WHERE tenant_id=? AND user_id IS NOT NULL', [tenant_id]);
  return rows.filter((r) => !minRole || atLeast(r.role, minRole)).map((r) => r.user_id);
}
async function channelAllowed(ctx, channel) {
  if (!channel || channel === 'team') return true;
  if (siteBound(ctx)) return channel === ctx.site_id;
  return !!(await qone('SELECT 1 FROM sites WHERE id=? AND tenant_id=?', [channel, ctx.tenant_id]));
}

async function scope(req) {
  const tid = requestedTenant(req);
  if (tid) { const c = await contextFor(req.user, tid); return c ? { ctx: c } : { error: 'no access to this workspace' }; }
  if (req.user.is_superadmin) return { all: true };
  return { error: 'select a workspace' };
}
function needTenant(minRole) {
  return async (req, res, next) => {
    const tid = requestedTenant(req) || req.body?.tenant_id;
    const c = await contextFor(req.user, tid);
    if (!c) return res.status(403).json({ error: 'no access to this workspace' });
    if (minRole && !atLeast(c.role, minRole)) return res.status(403).json({ error: 'insufficient role' });
    req.ctx = c; next();
  };
}

// ── PUBLIC config ──────────────────────────────────────────────────────────────
router.get('/config', (_req, res) => res.json({ google_client_id: GOOGLE_CLIENT_ID }));

// ── AUTH ──────────────────────────────────────────────────────────────────────
async function loginResponse(res, req, user) {
  await qrun('UPDATE users SET last_login=? WHERE id=?', [nowS(), user.id]);
  const token = signSession(user);
  res.cookie('daybook_token', token, { httpOnly: true, sameSite: 'Lax', secure: req.secure, maxAge: 12 * 3600 * 1000 });
  return res.json({ token, user: publicUser(user), tenants: await accessibleTenants(user) });
}

router.post('/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'missing Google credential' });
  let g;
  try { g = await verifyGoogleToken(credential); }
  catch (e) { return res.status(401).json({ error: 'Google verification failed', detail: e.message }); }

  let user = await qone('SELECT * FROM users WHERE lower(email)=lower(?)', [g.email]);
  if (!user) {
    const id = uuid();
    await qrun('INSERT INTO users (id,email,google_sub,name,photo_url) VALUES (?,?,?,?,?)',
      [id, g.email, g.sub, g.name || null, g.picture || null]);
    user = await qone('SELECT * FROM users WHERE id=?', [id]);
  } else if (!user.google_sub) {
    await qrun('UPDATE users SET google_sub=?, name=COALESCE(name,?), photo_url=COALESCE(photo_url,?) WHERE id=?',
      [g.sub, g.name || null, g.picture || null, user.id]);
  }
  const invites = await qall('SELECT * FROM invites WHERE lower(email)=lower(?)', [g.email]);
  for (const inv of invites) {
    try {
      await qrun('INSERT INTO memberships (id,user_id,tenant_id,role,site_id) VALUES (?,?,?,?,?) ON CONFLICT (user_id,tenant_id) DO NOTHING',
        [uuid(), user.id, inv.tenant_id, inv.role, inv.site_id]);
    } catch {}
    await qrun('DELETE FROM invites WHERE id=?', [inv.id]);
  }
  if (user.status !== 'ACTIVE') return res.status(403).json({ error: 'account disabled' });
  // Record a LOGIN in each company the user belongs to (for the Team activity trail).
  try {
    const ms = await qall("SELECT tenant_id FROM memberships WHERE user_id=? AND status='ACTIVE'", [user.id]);
    for (const m of ms) audit(m.tenant_id, user.id, 'LOGIN', 'session', user.id, {});
  } catch { /* non-critical */ }
  return loginResponse(res, req, user);
});

router.post('/auth/dev-login', async (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.DAYBOOK_ALLOW_DEV_LOGIN !== '1')
    return res.status(404).json({ error: 'not found' });
  const email = (req.body?.email || '').toLowerCase();
  let user = await qone('SELECT * FROM users WHERE lower(email)=lower(?)', [email]);
  if (!user) {
    const id = uuid();
    await qrun('INSERT INTO users (id,email,name) VALUES (?,?,?)', [id, email, req.body?.name || email]);
    user = await qone('SELECT * FROM users WHERE id=?', [id]);
  }
  return loginResponse(res, req, user);
});

router.post('/auth/logout', (_req, res) => { res.clearCookie('daybook_token'); res.json({ ok: true }); });
router.get('/auth/me', requireAuth, async (req, res) => res.json({ user: publicUser(req.user), tenants: await accessibleTenants(req.user) }));

// ── ONBOARDING ────────────────────────────────────────────────────────────────
router.post('/onboard', requireAuth, async (req, res) => {
  const { name, slug, brand_color, industry, currency } = req.body || {};
  if (!name) return res.status(400).json({ error: 'company name required' });
  const realSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || ('co-' + uuid().slice(0, 6));
  const id = uuid();
  const trialDays = parseInt(process.env.TRIAL_DAYS || '30', 10);
  const trialEnds = Math.floor(Date.now() / 1000) + trialDays * 86400;
  try {
    await qrun('INSERT INTO tenants (id,slug,name,brand_color,currency,industry,plan,trial_ends_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, realSlug, name, brand_color || '#0ea5e9', currency || 'NGN', industry || null, 'FREE', trialEnds, req.user.id]);
  } catch { return res.status(409).json({ error: 'a workspace with that name/slug already exists' }); }
  await qrun('INSERT INTO memberships (id,user_id,tenant_id,role) VALUES (?,?,?,?)', [uuid(), req.user.id, id, 'ADMIN']);
  await qrun('INSERT INTO recipients (id,tenant_id,email,name) VALUES (?,?,?,?) ON CONFLICT (tenant_id,email) DO NOTHING',
    [uuid(), id, req.user.email, req.user.name || null]);
  await audit(id, req.user.id, 'CREATE', 'tenant', id, { name });
  res.status(201).json({ tenant: await tenantById(id), tenants: await accessibleTenants(req.user) });
});

// ── TENANTS ────────────────────────────────────────────────────────────────────
router.get('/tenants', requireAuth, async (req, res) => res.json(await accessibleTenants(req.user)));
router.patch('/tenants/:id', requireAuth, async (req, res) => {
  const c = await contextFor(req.user, req.params.id);
  if (!c || !atLeast(c.role, 'ADMIN')) return res.status(403).json({ error: 'forbidden' });
  const t = await tenantById(req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
  const f = req.body || {};
  await qrun('UPDATE tenants SET name=?,brand_color=?,currency=?,industry=?,plan=?,status=? WHERE id=?',
    [f.name ?? t.name, f.brand_color ?? t.brand_color, f.currency ?? t.currency, f.industry ?? t.industry,
      req.user.is_superadmin ? (f.plan ?? t.plan) : t.plan, req.user.is_superadmin ? (f.status ?? t.status) : t.status, t.id]);
  res.json(await tenantById(t.id));
});

// ── SITES ────────────────────────────────────────────────────────────────────
router.get('/sites', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error) return res.status(403).json({ error: s.error });
  if (s.all) return res.json(await qall('SELECT * FROM sites ORDER BY tenant_id,name'));
  if (siteBound(s.ctx)) return res.json(await qall('SELECT * FROM sites WHERE id=?', [s.ctx.site_id]));
  res.json(await qall('SELECT * FROM sites WHERE tenant_id=? ORDER BY name', [s.ctx.tenant_id]));
});
router.post('/sites', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const { code, name, address, is_hq } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'code and name required' });
  const id = uuid();
  try {
    await qrun('INSERT INTO sites (id,tenant_id,code,name,address,is_hq) VALUES (?,?,?,?,?,?)',
      [id, req.ctx.tenant_id, code.toUpperCase(), name, address || null, is_hq ? 1 : 0]);
  } catch { return res.status(409).json({ error: 'site code already exists' }); }
  await audit(req.ctx.tenant_id, req.user.id, 'CREATE', 'site', id, { code });
  res.status(201).json(await siteById(id));
});
router.patch('/sites/:id', requireAuth, async (req, res) => {
  const site = await siteById(req.params.id); if (!site) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, site.tenant_id);
  if (!c || !atLeast(c.role, 'ADMIN')) return res.status(403).json({ error: 'forbidden' });
  const f = req.body || {};
  await qrun('UPDATE sites SET name=?,address=?,is_hq=?,status=? WHERE id=?',
    [f.name ?? site.name, f.address ?? site.address, f.is_hq != null ? (f.is_hq ? 1 : 0) : site.is_hq, f.status ?? site.status, site.id]);
  res.json(await siteById(site.id));
});

// ── MEMBERS ───────────────────────────────────────────────────────────────────
router.get('/members', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) => {
  const rows = await qall(
    `SELECT m.id, m.role, m.site_id, m.status, u.email, u.name, u.last_login, (u.google_sub IS NOT NULL) AS active_login
       FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? ORDER BY m.role DESC, u.email`,
    [req.ctx.tenant_id]);
  const pending = await qall('SELECT id,email,role,site_id FROM invites WHERE tenant_id=?', [req.ctx.tenant_id]);
  res.json({ members: rows, invites: pending });
});

// ── Email diagnostics (Admin) — verify SMTP + send a real test message ────────
router.get('/email/health', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const v = await verifyConnection();
  res.json({ ...v, from: MAIL_FROM, host: process.env.SMTP_HOST || 'smtp-relay.gmail.com', port: process.env.SMTP_PORT || '587', auth: !!(process.env.SMTP_USER && process.env.SMTP_PASS) });
});
router.post('/email/test', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const to = ((req.body || {}).to || req.user.email || '').trim();
  if (!to) return res.status(400).json({ error: 'recipient required' });
  try {
    const r = await sendTest({ to });
    await qrun('INSERT INTO email_log (id,tenant_id,to_addrs,subject,status) VALUES (?,?,?,?,?)', [uuid(), req.ctx.tenant_id, to, 'Daybook email test', 'SENT']).catch(() => {});
    res.json({ ok: true, to, ...r });
  } catch (e) {
    await qrun('INSERT INTO email_log (id,tenant_id,to_addrs,subject,status,error) VALUES (?,?,?,?,?,?)', [uuid(), req.ctx.tenant_id, to, 'Daybook email test', 'FAILED', e.message]).catch(() => {});
    res.status(502).json({ ok: false, to, error: e.message, from: MAIL_FROM });
  }
});

router.post('/members', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const { email, role, site_id } = req.body || {};
  if (!email || !role) return res.status(400).json({ error: 'email and role required' });
  const VALID_ROLES = ['ADMIN', 'GENERAL_MANAGER', 'SITE_MANAGER', 'SNR_ACCOUNTANT', 'ACCOUNTANT', 'SECRETARY', 'SUPERVISOR', 'GATEMAN', 'GATE'];
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'invalid role' });
  // Site-bound roles keep a site; Manager & Secretary must have one.
  const SITE_BOUND = ['SITE_MANAGER', 'SECRETARY', 'SUPERVISOR', 'GATEMAN', 'GATE'];
  const SITE_REQUIRED = ['SITE_MANAGER', 'SECRETARY'];
  if (SITE_REQUIRED.includes(role) && !site_id) return res.status(400).json({ error: 'site required for this role' });
  const memberSite = SITE_BOUND.includes(role) ? (site_id || null) : null;
  const lower = email.toLowerCase();
  const existing = await qone('SELECT * FROM users WHERE lower(email)=lower(?)', [lower]);
  if (existing) {
    try {
      await qrun('INSERT INTO memberships (id,user_id,tenant_id,role,site_id) VALUES (?,?,?,?,?) ON CONFLICT (user_id,tenant_id) DO NOTHING',
        [uuid(), existing.id, req.ctx.tenant_id, role, memberSite]);
    } catch { return res.status(409).json({ error: 'this user is already a member' }); }
    await audit(req.ctx.tenant_id, req.user.id, 'ADD_MEMBER', 'membership', existing.id, { email, role });
    const sent = await emailInvite(req.ctx.tenant_id, req.user.id, lower, role);   // await → report status
    return res.status(201).json({ added: true, email, emailed: !!(sent && sent.ok), email_error: sent && sent.ok ? undefined : (sent && sent.error) });
  }
  try {
    await qrun('INSERT INTO invites (id,tenant_id,email,role,site_id,invited_by) VALUES (?,?,?,?,?,?) ON CONFLICT (tenant_id,email) DO NOTHING',
      [uuid(), req.ctx.tenant_id, lower, role, memberSite, req.user.id]);
  } catch { return res.status(409).json({ error: 'already invited' }); }
  await audit(req.ctx.tenant_id, req.user.id, 'INVITE', 'invite', lower, { role });
  const sent = await emailInvite(req.ctx.tenant_id, req.user.id, lower, role);
  res.status(201).json({ invited: true, email: lower, emailed: !!(sent && sent.ok), email_error: sent && sent.ok ? undefined : (sent && sent.error) });
});

// My activity & sent messages — powers the avatar "Activity" panel.
router.get('/me/activity', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  const args = [req.user.id];
  let where = 'a.user_id=?';
  if (tid) { where += ' AND a.tenant_id=?'; args.push(tid); }
  const audits = await qall(
    `SELECT a.action, a.entity, a.entity_id, a.meta, a.created_at, t.name tenant_name
       FROM audit_log a LEFT JOIN tenants t ON t.id=a.tenant_id
      WHERE ${where} ORDER BY a.created_at DESC LIMIT 60`, args);
  let emails = [];
  if (tid) emails = await qall(
    'SELECT to_addrs, subject, status, error, created_at FROM email_log WHERE tenant_id=? ORDER BY created_at DESC LIMIT 25', [tid]);
  res.json({
    audits: audits.map((a) => ({ ...a, meta: J(a.meta, {}) })),
    emails,
  });
});

// Company-wide activity trail (GM+): every user's audited actions.
router.get('/activity/all', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) => {
  const { user_id, action, before, from, to } = req.query;
  const where = ['a.tenant_id=?'], args = [req.ctx.tenant_id];
  if (user_id) { where.push('a.user_id=?'); args.push(user_id); }
  if (action)  { where.push('a.action=?'); args.push(action); }
  if (before)  { where.push('a.created_at < ?'); args.push(parseInt(before, 10) || 0); }
  if (from) { const e = Math.floor(new Date(`${from}T00:00:00`).getTime() / 1000); if (e) { where.push('a.created_at >= ?'); args.push(e); } }
  if (to)   { const e = Math.floor(new Date(`${to}T23:59:59`).getTime() / 1000);   if (e) { where.push('a.created_at <= ?'); args.push(e); } }
  const rows = await qall(
    `SELECT a.action, a.entity, a.entity_id, a.meta, a.created_at, a.user_id,
            u.name actor_name, u.email actor_email
       FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 100`, args);
  res.json(rows.map((a) => ({ ...a, meta: J(a.meta, {}) })));
});

// CSV export of the (filtered) company activity trail.
router.get('/activity/all.csv', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) => {
  const { user_id, action, from, to } = req.query;
  const where = ['a.tenant_id=?'], args = [req.ctx.tenant_id];
  if (user_id) { where.push('a.user_id=?'); args.push(user_id); }
  if (action)  { where.push('a.action=?'); args.push(action); }
  if (from) { const e = Math.floor(new Date(`${from}T00:00:00`).getTime() / 1000); if (e) { where.push('a.created_at >= ?'); args.push(e); } }
  if (to)   { const e = Math.floor(new Date(`${to}T23:59:59`).getTime() / 1000);   if (e) { where.push('a.created_at <= ?'); args.push(e); } }
  const rows = await qall(
    `SELECT a.action, a.entity, a.entity_id, a.meta, a.created_at, u.name actor_name, u.email actor_email
       FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
      WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 10000`, args);
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = ['When,Actor,Email,Action,Entity,Details'];
  for (const r of rows) {
    const when = new Date((r.created_at || 0) * 1000).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
    const meta = J(r.meta, {});
    const detail = Object.entries(meta).map(([k, v]) => `${k}=${v}`).join('; ');
    lines.push([when, r.actor_name || '', r.actor_email || '', r.action || '', r.entity || '', detail].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="activity_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\r\n'));
});

const activeAdminCount = async (tenant_id) => {
  const r = await qone("SELECT COUNT(*) n FROM memberships WHERE tenant_id=? AND role='ADMIN' AND status='ACTIVE'", [tenant_id]);
  return parseInt(r.n, 10);
};

router.patch('/members/:id', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const m = await qone('SELECT * FROM memberships WHERE id=? AND tenant_id=?', [req.params.id, req.ctx.tenant_id]);
  if (!m) return res.status(404).json({ error: 'not found' });
  const f = req.body || {};
  const newRole = f.role ?? m.role;
  const newStatus = f.status ?? m.status;
  const wasActiveAdmin = m.role === 'ADMIN' && m.status === 'ACTIVE';
  const willBeActiveAdmin = newRole === 'ADMIN' && newStatus === 'ACTIVE';
  if (wasActiveAdmin && !willBeActiveAdmin && await activeAdminCount(req.ctx.tenant_id) <= 1)
    return res.status(400).json({ error: 'This is the last active admin — promote another admin before dismissing or changing this one.' });
  await qrun('UPDATE memberships SET role=?,site_id=?,status=? WHERE id=?',
    [newRole, f.site_id !== undefined ? f.site_id : m.site_id, newStatus, m.id]);
  if (newStatus !== m.status) await audit(req.ctx.tenant_id, req.user.id, newStatus === 'DISABLED' ? 'DISMISS_MEMBER' : 'RESTORE_MEMBER', 'membership', m.id);
  res.json({ ok: true });
});
router.delete('/members/:id', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const m = await qone('SELECT * FROM memberships WHERE id=? AND tenant_id=?', [req.params.id, req.ctx.tenant_id]);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (m.role === 'ADMIN' && m.status === 'ACTIVE' && await activeAdminCount(req.ctx.tenant_id) <= 1)
    return res.status(400).json({ error: 'This is the last active admin — promote another admin before removing this one.' });
  await qrun('DELETE FROM memberships WHERE id=?', [m.id]);
  await audit(req.ctx.tenant_id, req.user.id, 'REMOVE_MEMBER', 'membership', m.id);
  res.json({ ok: true });
});
router.delete('/invites/:id', requireAuth, needTenant('ADMIN'), async (req, res) => {
  await qrun('DELETE FROM invites WHERE id=? AND tenant_id=?', [req.params.id, req.ctx.tenant_id]);
  res.json({ ok: true });
});
router.post('/invites/:id/resend', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const inv = await qone('SELECT * FROM invites WHERE id=? AND tenant_id=?', [req.params.id, req.ctx.tenant_id]);
  if (!inv) return res.status(404).json({ error: 'not found' });
  // Await the real send so the client can report a truthful result.
  const result = await emailInvite(req.ctx.tenant_id, req.user.id, inv.email, inv.role);
  if (!result || !result.ok) return res.status(502).json({ error: result?.error || 'Email could not be sent — check SMTP settings', email: inv.email });
  res.json({ ok: true, email: inv.email });
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

router.get('/reports', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const { site, from, to } = req.query; const where = [], args = [];
  if (s.ctx) {
    where.push('r.tenant_id=?'); args.push(s.ctx.tenant_id);
    if (siteBound(s.ctx)) { where.push('r.site_id=?'); args.push(s.ctx.site_id); }
    else if (site) { where.push('r.site_id=?'); args.push(site); }
  }
  if (from) { where.push('r.report_date>=?'); args.push(from); }
  if (to) { where.push('r.report_date<=?'); args.push(to); }
  const sql = `SELECT r.*, s.name site_name, s.code site_code, t.name tenant_name
    FROM daily_reports r JOIN sites s ON s.id=r.site_id JOIN tenants t ON t.id=r.tenant_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.report_date DESC, s.name LIMIT 500`;
  res.json((await qall(sql, args)).map(reportView));
});

router.get('/reports/:id', requireAuth, async (req, res) => {
  const r = await qone('SELECT * FROM daily_reports WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, r.tenant_id);
  if (!c || (siteBound(c) && c.site_id !== r.site_id)) return res.status(404).json({ error: 'not found' });
  res.json(reportView(r));
});
router.delete('/reports/:id', requireAuth, async (req, res) => {
  const r = await qone('SELECT * FROM daily_reports WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, r.tenant_id);
  if (!c || (siteBound(c) && c.site_id !== r.site_id)) return res.status(404).json({ error: 'not found' });
  const allowed = r.created_by === req.user.id || req.user.is_superadmin || atLeast(c.role, 'GENERAL_MANAGER');
  if (!allowed) return res.status(403).json({ error: "only the report's creator or a manager can delete it" });
  await qrun('DELETE FROM daily_reports WHERE id=?', [r.id]);
  await audit(r.tenant_id, req.user.id, 'DELETE', 'report', r.id, { date: r.report_date, site: r.site_id });
  res.json({ ok: true });
});

// Auto-email a submitted daily report (Fido & Fiafia only) to its creator and
// dailyreports@torama.money. Fire-and-forget; logs success/failure to email_log.
const REPORTS_INBOX = process.env.REPORTS_INBOX || 'dailyreports@torama.money';
async function emailReportOnSubmit(tenant_id, reportId, site, user) {
  try {
    const tenant = await tenantById(tenant_id);
    const isFidoFiafia = !!tenant && (tenant.pos_source || ['fido', 'fiafia'].includes(String(tenant.slug || '').toLowerCase()));
    if (!isFidoFiafia) return;
    const report = await qone('SELECT * FROM daily_reports WHERE id=?', [reportId]);
    if (!report) return;
    const to = [...new Set([user && user.email, REPORTS_INBOX].filter(Boolean))];
    if (!to.length) return;
    const docs = (await qall('SELECT * FROM documents WHERE report_id=?', [reportId]))
      .map((d) => ({ filename: d.file_name, path: path.join(UPLOAD_DIR, d.stored_name) })).filter((a) => fs.existsSync(a.path));
    const sent = await sendDailyReport({ tenant, site, report, to, attachments: docs });
    await qrun('UPDATE daily_reports SET emailed_at=? WHERE id=?', [nowS(), reportId]).catch(() => {});
    await qrun('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status) VALUES (?,?,?,?,?,?)',
      [uuid(), tenant_id, reportId, to.join(','), sent.subject, 'SENT']);
  } catch (e) {
    await qrun('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status,error) VALUES (?,?,?,?,?,?,?)',
      [uuid(), tenant_id, reportId, REPORTS_INBOX, 'Daily report', 'FAILED', e.message]).catch(() => {});
  }
}

router.post('/reports', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const b = req.body || {};
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : b.site_id;
  if (!site_id || !b.report_date) return res.status(400).json({ error: 'site_id and report_date required' });
  const site = await siteById(site_id);
  if (!site || site.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid site' });
  const totals = computeTotals(b);
  const existing = await qone('SELECT * FROM daily_reports WHERE tenant_id=? AND site_id=? AND report_date=?',
    [req.ctx.tenant_id, site_id, b.report_date]);
  const id = existing ? existing.id : uuid();
  const status = b.submit ? 'SUBMITTED' : (existing ? existing.status : 'DRAFT');
  const submitted_at = status === 'SUBMITTED' ? nowS() : (existing ? existing.submitted_at : null);
  await qrun(
    `INSERT INTO daily_reports
      (id,tenant_id,site_id,report_date,total_sales,total_cash,total_deposit,diesel,expenses,balance,sales_json,production_json,notes,status,created_by,submitted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,site_id,report_date) DO UPDATE SET
        total_sales=EXCLUDED.total_sales, total_cash=EXCLUDED.total_cash, total_deposit=EXCLUDED.total_deposit,
        diesel=EXCLUDED.diesel, expenses=EXCLUDED.expenses, balance=EXCLUDED.balance,
        sales_json=EXCLUDED.sales_json, production_json=EXCLUDED.production_json,
        notes=EXCLUDED.notes, status=EXCLUDED.status, submitted_at=EXCLUDED.submitted_at`,
    [id, req.ctx.tenant_id, site_id, b.report_date,
      totals.total_sales, +b.total_cash || 0, +b.total_deposit || 0,
      +b.diesel || 0, +b.expenses || 0, totals.balance,
      JSON.stringify(b.sales || []), JSON.stringify(b.production || {}),
      b.notes || null, status, req.user.id, submitted_at]);
  await audit(req.ctx.tenant_id, req.user.id, existing ? 'UPDATE' : 'CREATE', 'report', id, { date: b.report_date, status });
  if (status === 'SUBMITTED') {
    const uids = (await tenantUserIds(req.ctx.tenant_id, 'GENERAL_MANAGER')).filter((u) => u !== req.user.id);
    await notify(req.ctx.tenant_id, uids,
      { type: 'report', title: `Report submitted — ${site.name}`, body: `${b.report_date} · sales ₦${(totals.total_sales || 0).toLocaleString()}`, link: 'reports' });
    // Fido & Fiafia: email the submitted report to the creator + dailyreports@torama.money.
    emailReportOnSubmit(req.ctx.tenant_id, id, site, req.user).catch(() => {});
  }
  res.status(existing ? 200 : 201).json(reportView(await qone('SELECT * FROM daily_reports WHERE id=?', [id])));
});

// Auto-assemble a daily report from the data the app already has: POS sales
// (cash / POS / transfer / incentive), per-site totals, production (bags loaded
// & bagged per loader/bagger), and expenses. Returns a prefilled report body the
// user reviews, adds incidents to, and submits.
const classifyMethod = (m) => {
  const x = String(m || '').toUpperCase();
  if (x === 'INCENTIVE') return 'incentive';
  if (x.includes('CASH')) return 'cash';
  if (x.includes('POS') || x.includes('CARD')) return 'pos';
  return 'transfer';
};
router.get('/reports/generate', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : req.query.site;
  if (!site_id) return res.status(400).json({ error: 'pick a site to generate its daily report' });
  const site = await siteById(site_id);
  if (!site || site.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid site' });

  // ── Sales by payment bucket (cash / POS / transfer) + incentive ──────────────
  let cash = 0, pos = 0, transfer = 0, incentive = 0, orders = 0;
  if (await posEnabled(req.ctx.tenant_id)) {
    try {
      const sum = await sales.getSales(site.code, date);   // already excludes incentive from total/cash
      incentive = sum.incentive || 0;
      orders = sum.orders || 0;
      for (const p of (sum.payments || [])) {
        const k = classifyMethod(p.method); if (k === 'incentive') continue;
        if (k === 'cash') cash += p.amount; else if (k === 'pos') pos += p.amount; else transfer += p.amount;
      }
    } catch { /* fall through to pos_sales */ }
  }
  if (!orders && !cash && !pos && !transfer) {
    const rows = await qall("SELECT payment_method, COALESCE(SUM(total),0) amt, COUNT(*) n FROM pos_sales WHERE tenant_id=? AND site_id=? AND sale_date=? GROUP BY payment_method", [req.ctx.tenant_id, site_id, date]);
    for (const r of rows) {
      const k = classifyMethod(r.payment_method); const amt = Number(r.amt);
      if (k === 'incentive') { incentive += amt; continue; }
      orders += Number(r.n);
      if (k === 'cash') cash += amt; else if (k === 'pos') pos += amt; else transfer += amt;
    }
  }
  const totalSales = cash + pos + transfer;

  // ── Production: bags loaded / bagged per staff at this site for the day ───────
  const prod = await qall(
    `SELECT st.full_name name, st.staff_type, COALESCE(p.bags_loaded,0) loaded, COALESCE(p.bags_bagged,0) bagged
       FROM production p JOIN staff st ON st.id=p.staff_id
      WHERE p.tenant_id=? AND p.site_id=? AND p.work_date=? ORDER BY st.full_name`,
    [req.ctx.tenant_id, site_id, date]);
  const loaders = prod.filter((r) => Number(r.loaded) > 0).map((r) => ({ name: r.name, loaded: Number(r.loaded) }));
  const baggers = prod.filter((r) => Number(r.bagged) > 0).map((r) => ({ name: r.name, bagged: Number(r.bagged) }));
  const totalLoaded = loaders.reduce((a, r) => a + r.loaded, 0);
  const totalBagged = baggers.reduce((a, r) => a + r.bagged, 0);

  // ── Expenses (and diesel split out) for the day ──────────────────────────────
  const exp = await qone("SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(CASE WHEN category='DIESEL' THEN amount ELSE 0 END),0) diesel FROM expenses WHERE tenant_id=? AND site_id=? AND expense_date=?", [req.ctx.tenant_id, site_id, date]);
  const diesel = Number(exp.diesel) || 0;
  const otherExp = (Number(exp.total) || 0) - diesel;

  const production = { totalLoaded, totalBagged, loaders, baggers, incentive };
  res.json({
    report_date: date, site_id, site_name: site.name,
    summary: { cash, pos, transfer, incentive, totalSales, orders, totalLoaded, totalBagged, loaders, baggers, diesel, expenses: otherExp },
    // Prefilled body matching POST /reports (total_sales derives from sales lines).
    prefill: {
      report_date: date, site_id,
      total_cash: cash, total_deposit: pos + transfer, diesel, expenses: otherExp,
      sales: [
        { label: 'Cash', amount: cash },
        { label: 'POS / Card', amount: pos },
        { label: 'Transfer', amount: transfer },
      ].filter((l) => l.amount > 0 || true),
      production,
    },
  });
});

router.post('/reports/:id/email', requireAuth, async (req, res) => {
  const r = await qone('SELECT * FROM daily_reports WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, r.tenant_id);
  if (!c || !atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'forbidden' });
  const tenant = await tenantById(r.tenant_id), site = await siteById(r.site_id);
  const recs = (await qall('SELECT email FROM recipients WHERE tenant_id=? AND active=1', [r.tenant_id])).map((x) => x.email);
  const extra = Array.isArray(req.body?.extra) ? req.body.extra : [];
  const fallback = (process.env.DEFAULT_REPORT_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const to = [...new Set([...recs, ...extra, ...(recs.length ? [] : fallback)])].filter(Boolean);
  if (!to.length) return res.status(400).json({ error: 'no recipients configured' });
  const docs = (await qall('SELECT * FROM documents WHERE report_id=?', [r.id]))
    .map((d) => ({ filename: d.file_name, path: path.join(UPLOAD_DIR, d.stored_name) })).filter((a) => fs.existsSync(a.path));
  try {
    const sent = await sendDailyReport({ tenant, site, report: r, to, attachments: docs });
    await qrun('UPDATE daily_reports SET status=?, emailed_at=? WHERE id=?', ['EMAILED', nowS(), r.id]);
    await qrun('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status) VALUES (?,?,?,?,?,?)',
      [uuid(), r.tenant_id, r.id, to.join(','), sent.subject, 'SENT']);
    await audit(r.tenant_id, req.user.id, 'EMAIL', 'report', r.id, { to });
    res.json({ ok: true, to, subject: sent.subject });
  } catch (e) {
    await qrun('INSERT INTO email_log (id,tenant_id,report_id,to_addrs,subject,status,error) VALUES (?,?,?,?,?,?,?)',
      [uuid(), r.tenant_id, r.id, to.join(','), 'Daily report', 'FAILED', e.message]);
    res.status(502).json({ error: 'email failed', detail: e.message });
  }
});

// ── DASHBOARD ──────────────────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const { from, to } = req.query; const where = [], args = [];
  if (s.ctx) {
    where.push('r.tenant_id=?'); args.push(s.ctx.tenant_id);
    if (siteBound(s.ctx)) { where.push('r.site_id=?'); args.push(s.ctx.site_id); }
  }
  if (from) { where.push('r.report_date>=?'); args.push(from); }
  if (to) { where.push('r.report_date<=?'); args.push(to); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const totals = await qone(`SELECT COALESCE(SUM(total_sales),0) sales, COALESCE(SUM(total_cash),0) cash,
    COALESCE(SUM(total_deposit),0) deposit, COALESCE(SUM(diesel+expenses),0) costs, COUNT(*) reports FROM daily_reports r ${W}`, args);
  const bySite = await qall(`SELECT s.name site, COALESCE(SUM(r.total_sales),0) sales FROM daily_reports r JOIN sites s ON s.id=r.site_id ${W} GROUP BY s.id, s.name ORDER BY sales DESC LIMIT 20`, args);
  const byDay = await qall(`SELECT r.report_date AS "day", COALESCE(SUM(r.total_sales),0) sales FROM daily_reports r ${W} GROUP BY r.report_date ORDER BY r.report_date DESC LIMIT 30`, args);
  res.json({ totals: { ...totals, reports: parseInt(totals.reports, 10) }, bySite, byDay: byDay.reverse() });
});

// ── DOCUMENTS ──────────────────────────────────────────────────────────────────
router.get('/documents', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const { category, site } = req.query; const where = [], args = [];
  if (s.ctx) {
    where.push('d.tenant_id=?'); args.push(s.ctx.tenant_id);
    if (siteBound(s.ctx)) { where.push('(d.site_id=? OR d.site_id IS NULL)'); args.push(s.ctx.site_id); }
  }
  if (category) { where.push('d.category=?'); args.push(category); }
  if (site) { where.push('d.site_id=?'); args.push(site); }
  const sql = `SELECT d.*, s.name site_name, u.name uploader FROM documents d
    LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN users u ON u.id=d.uploaded_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.created_at DESC LIMIT 500`;
  res.json(await qall(sql, args));
});

router.post('/documents', requireAuth, needTenant('SECRETARY'), upload.array('files', 10), async (req, res) => {
  const files = req.files || []; if (!files.length) return res.status(400).json({ error: 'no files uploaded' });
  const b = req.body || {};
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : (b.site_id || null);
  const out = [];
  for (const f of files) {
    const id = uuid();
    await qrun(`INSERT INTO documents (id,tenant_id,site_id,report_id,category,title,description,file_name,stored_name,mime,size,uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.ctx.tenant_id, site_id, b.report_id || null, (b.category || 'OTHER').toUpperCase(),
        b.title || f.originalname, b.description || null, f.originalname, f.filename, f.mimetype, f.size, req.user.id]);
    out.push(await qone('SELECT * FROM documents WHERE id=?', [id]));
  }
  await audit(req.ctx.tenant_id, req.user.id, 'UPLOAD', 'document', out[0].id, { count: files.length, category: b.category });
  res.status(201).json(out);
});

router.get('/documents/:id/download', requireAuth, async (req, res) => {
  const d = await qone('SELECT * FROM documents WHERE id=?', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, d.tenant_id);
  if (!c || (siteBound(c) && d.site_id && d.site_id !== c.site_id)) return res.status(404).json({ error: 'not found' });
  const p = path.join(UPLOAD_DIR, d.stored_name);
  if (!fs.existsSync(p)) return res.status(410).json({ error: 'file missing on disk' });
  res.download(p, d.file_name);
});

router.delete('/documents/:id', requireAuth, async (req, res) => {
  const d = await qone('SELECT * FROM documents WHERE id=?', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, d.tenant_id);
  if (!c || !atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'forbidden' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch {}
  await qrun('DELETE FROM documents WHERE id=?', [d.id]);
  await audit(d.tenant_id, req.user.id, 'DELETE', 'document', d.id);
  res.json({ ok: true });
});

// ── RECIPIENTS ────────────────────────────────────────────────────────────────
router.get('/recipients', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) =>
  res.json(await qall('SELECT * FROM recipients WHERE tenant_id=? ORDER BY email', [req.ctx.tenant_id])));
router.post('/recipients', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const { email, name } = req.body || {}; if (!email) return res.status(400).json({ error: 'email required' });
  const id = uuid();
  try { await qrun('INSERT INTO recipients (id,tenant_id,email,name) VALUES (?,?,?,?)', [id, req.ctx.tenant_id, email, name || null]); }
  catch { return res.status(409).json({ error: 'recipient already exists' }); }
  res.status(201).json(await qone('SELECT * FROM recipients WHERE id=?', [id]));
});
router.delete('/recipients/:id', requireAuth, needTenant('ADMIN'), async (req, res) => {
  await qrun('DELETE FROM recipients WHERE id=? AND tenant_id=?', [req.params.id, req.ctx.tenant_id]);
  res.json({ ok: true });
});

router.get('/mail/health', requireAuth, async (_req, res) => res.json(await verifyConnection()));

// ── AI ASSISTANT ──────────────────────────────────────────────────────────────
router.get('/ai/health', requireAuth, (_req, res) => res.json({ configured: aiConfigured() }));

async function aiContext(req) {
  const s = await scope(req);
  if (s.error || s.all) return { scope: 'all companies', note: 'pick a workspace for company-specific figures' };
  const t = await tenantById(s.ctx.tenant_id);
  const where = ['r.tenant_id=?']; const args = [s.ctx.tenant_id];
  if (siteBound(s.ctx)) { where.push('r.site_id=?'); args.push(s.ctx.site_id); }
  const W = 'WHERE ' + where.join(' AND ');
  const totals = await qone(`SELECT COALESCE(SUM(total_sales),0) sales, COALESCE(SUM(total_cash),0) cash,
    COALESCE(SUM(total_deposit),0) deposit, COALESCE(SUM(diesel+expenses),0) costs, COUNT(*) reports FROM daily_reports r ${W}`, args);
  const recent = await qall(`SELECT r.report_date, s.name site, r.total_sales, r.balance FROM daily_reports r
    JOIN sites s ON s.id=r.site_id ${W} ORDER BY r.report_date DESC LIMIT 15`, args);
  const sites = await qall('SELECT name, code FROM sites WHERE tenant_id=?', [s.ctx.tenant_id]);
  return { company: t.name, currency: t.currency, role: s.ctx.role, totals, sites, recent_reports: recent };
}

async function daybookMetric(tenant_id, ctx, input) {
  const args = [tenant_id]; let siteF = '';
  if (siteBound(ctx)) { siteF = ' AND site_id=$2'; args.push(ctx.site_id); }
  const n = args.length;
  const dateW = (col) => {
    let w = ''; let i = args.length;
    if (input.from) { i++; w += ` AND ${col}>=$${i}`; args.push(input.from); }
    if (input.to) { i++; w += ` AND ${col}<=$${i}`; args.push(input.to); }
    return w;
  };
  // Note: uses direct $N params since we build the SQL manually here
  const base = `tenant_id=$1${siteF}`;
  switch (input.metric) {
    case 'reports': return { metric: 'reports', ...(await qone(`SELECT COUNT(*) reports, COALESCE(SUM(total_sales),0) sales, COALESCE(SUM(diesel+expenses),0) costs, COALESCE(SUM(balance),0) balance FROM daily_reports WHERE ${base}${dateW('report_date')}`, args)) };
    case 'staff': return { metric: 'staff', count: parseInt((await qone(`SELECT COUNT(*) c FROM staff WHERE ${base} AND status='ACTIVE'`, args)).c, 10) };
    case 'staff_hours': return { metric: 'staff_hours', ...(await qone(`SELECT COUNT(CASE WHEN present=1 THEN 1 END) days_present, COALESCE(SUM(hours),0) hours, COALESCE(SUM(bags_bagged),0) bags_bagged, COALESCE(SUM(bags_loaded),0) bags_loaded FROM timesheets WHERE ${base}${dateW('work_date')}`, args)) };
    case 'generators': return { metric: 'generators', rows: await qall(`SELECT name, fuel_type, capacity_kva FROM generators WHERE ${base} ORDER BY name`, args) };
    case 'generator_diesel': return { metric: 'generator_diesel', ...(await qone(`SELECT COALESCE(SUM(litres),0) litres, COALESCE(SUM(cost),0) cost FROM generator_logs WHERE ${base} AND type='DIESEL'${dateW('log_date')}`, args)) };
    case 'pos_sales': return { metric: 'pos_sales', ...(await qone(`SELECT COUNT(*) sales, COALESCE(SUM(total),0) total FROM pos_sales WHERE ${base}${dateW('sale_date')}`, args)) };
    default: return { error: 'unknown metric' };
  }
}

router.post('/ai/chat', requireAuth, async (req, res) => {
  const question = (req.body && req.body.message || '').toString().slice(0, 4000);
  if (!question.trim()) return res.status(400).json({ error: 'message required' });
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-8) : [];
  const ctx = await aiContext(req);
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
  const sc = await scope(req);
  try {
    if (sc.ctx) {
      const tenant_id = sc.ctx.tenant_id;
      let allowed = (await qall('SELECT code FROM sites WHERE tenant_id=?', [tenant_id])).map((s) => s.code);
      if (sc.siteBound(ctx)) { const me = await siteById(sc.ctx.site_id); allowed = me ? [me.code] : []; }
      const pos = await posEnabled(tenant_id);
      const resolveSites = (input) => {
        if (!input.site) return allowed;
        const want = String(input.site).toUpperCase().replace(/[^A-Z0-9]/g, '');
        return allowed.filter((c) => c.toUpperCase().replace(/[^A-Z0-9]/g, '') === want);
      };
      const tools = [{
        name: 'query_daybook',
        description: "Read this company's data entered in the Daybook app. metric: reports, staff, staff_hours, generators, generator_diesel, pos_sales. Optional from/to date range (YYYY-MM-DD).",
        input_schema: { type: 'object', properties: {
          metric: { type: 'string', enum: ['reports', 'staff', 'staff_hours', 'generators', 'generator_diesel', 'pos_sales'] },
          from: { type: 'string' }, to: { type: 'string' },
        }, required: ['metric'] },
      }];
      if (pos) tools.push(
        { name: 'query_pos_sales', description: 'Live POS sales (fido) aggregated.', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, site: { type: 'string' }, groupBy: { type: 'string', enum: ['site', 'paymentMethod', 'product', 'day'] } }, required: ['from', 'to'] } },
        { name: 'query_expenses', description: 'Live expenses (fido).', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, site: { type: 'string' }, groupBy: { type: 'string', enum: ['site', 'category', 'day'] } }, required: ['from', 'to'] } },
        { name: 'query_payroll', description: 'Live payroll (fido).', input_schema: { type: 'object', properties: { month: { type: 'string' }, year: { type: 'string' }, site: { type: 'string' } }, required: ['month', 'year'] } },
        { name: 'count_staff', description: 'Live staff headcount (fido).', input_schema: { type: 'object', properties: { site: { type: 'string' } } } },
      );
      const sysT = system + `\n\nTODAY is ${new Date().toISOString().slice(0, 10)}. ${pos ? `This company is connected to its LIVE operational database — use query_pos_sales, query_expenses, query_payroll, count_staff for real figures. You may only see these sites: ${allowed.join(', ')}.` : ''} Use query_daybook for anything entered in this Daybook app.`;
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

// ── SALES SOURCE ──────────────────────────────────────────────────────────────
async function siteAccess(req, siteId) {
  const site = await siteById(siteId); if (!site) return null;
  const c = await contextFor(req.user, site.tenant_id); if (!c) return null;
  if (siteBound(c) && c.site_id !== site.id) return null;
  return { site, ctx: c };
}

router.get('/sales/status', requireAuth, async (req, res) => res.json({ enabled: await posEnabled(requestedTenant(req)) }));

router.get('/sales/preview', requireAuth, async (req, res) => {
  const { site: siteId, date } = req.query;
  if (!siteId || !date) return res.status(400).json({ error: 'site and date required' });
  const a = await siteAccess(req, siteId); if (!a) return res.status(403).json({ error: 'no access to this site' });
  if (!await posEnabled(a.site.tenant_id)) return res.status(503).json({ error: 'POS not connected for this company', code: 'no_pos' });
  try {
    const s = await sales.getSales(a.site.code, date);
    let expenses = { total: 0, count: 0 };
    try { expenses = await sales.getExpensesTotal(a.site.code, date); } catch {}
    res.json({ site: { id: a.site.id, code: a.site.code, name: a.site.name }, date, sales: s, expenses });
  } catch (e) { res.status(e.httpStatus || 502).json({ error: e.message, code: e.code }); }
});

router.get('/sales/by-date', requireAuth, async (req, res) => {
  const s = await scope(req);
  if (s.error || !s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  if (!await posEnabled(s.ctx.tenant_id)) return res.status(503).json({ error: 'POS not connected for this company', code: 'no_pos' });
  const date = req.query.date; if (!date) return res.status(400).json({ error: 'date required' });
  let codes = (await qall('SELECT code FROM sites WHERE tenant_id=?', [s.ctx.tenant_id])).map((x) => x.code);
  if (siteBound(s.ctx)) { const me = await siteById(s.ctx.site_id); codes = me ? [me.code] : []; }
  if (!codes.length) return res.json({ date, rows: [], total: 0 });
  try {
    const rows = await sales.query({ from: date, to: date, sites: codes, groupBy: 'site' });
    res.json({ date, rows, total: rows.reduce((a, r) => a + (r.amount || 0), 0) });
  } catch (e) { res.status(e.httpStatus || 502).json({ error: e.message, code: e.code }); }
});

router.get('/payroll', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) => {
  if (!await posEnabled(req.ctx.tenant_id)) return res.status(503).json({ error: 'POS not connected for this company', code: 'no_pos' });
  try {
    const rows = await sales.getPayroll({ month: req.query.month, year: req.query.year, siteName: req.query.site });
    res.json(rows);
  } catch (e) { res.status(e.httpStatus || 502).json({ error: e.message, code: e.code }); }
});

router.post('/ai/analyse', requireAuth, async (req, res) => {
  const { site: siteId, date } = req.body || {};
  if (!siteId || !date) return res.status(400).json({ error: 'site and date required' });
  const a = await siteAccess(req, siteId); if (!a) return res.status(403).json({ error: 'no access to this site' });
  let posData = null;
  if (await posEnabled(a.site.tenant_id)) { try { posData = await sales.getSales(a.site.code, date); } catch {} }
  const existing = await qone('SELECT * FROM daily_reports WHERE tenant_id=? AND site_id=? AND report_date=?', [a.site.tenant_id, siteId, date]);
  const system = `You are Daybook Assistant analysing one site's day for a water business. Be concise and practical: state total sales, cash vs transfer split, top products, and flag anything unusual. End with one recommended action. Money is Naira (₦).`;
  const payload = { site: a.site.name, date, pos_sales: posData, saved_report: existing ? { total_sales: existing.total_sales, total_cash: existing.total_cash, total_deposit: existing.total_deposit, diesel: existing.diesel, expenses: existing.expenses, balance: existing.balance } : null };
  try {
    const reply = await callAI({ system, messages: [{ role: 'user', content: 'Analyse this day:\n' + JSON.stringify(payload) }], maxTokens: 600 });
    res.json({ reply, pos_sales: posData });
  } catch (e) { res.status(e instanceof AIError ? e.httpStatus : 502).json({ error: e.userMessage || e.message, code: e.code }); }
});

// ── STAFF & TIMESHEETS ────────────────────────────────────────────────────────
// Staff list columns — exclude the bulky face_descriptor; expose face_enrolled flag.
const STAFF_COLS = `id,tenant_id,site_id,full_name,role_title,phone,pay_type,staff_type,department,
  bank_name,bank_account,daily_rate,rate_loaded,rate_bagged,badge_code,ext_people_id,status,created_at,
  (face_descriptor IS NOT NULL) AS face_enrolled, face_enrolled_at, (photo IS NOT NULL) AS has_photo`;
const newBadgeCode = () => 'B' + Math.random().toString(36).slice(2, 9).toUpperCase();
const STAFF_TYPES = ['REGULAR', 'BAGGER', 'LOADER'];
// Piece workers (baggers/loaders) are paid per bag; regular staff get a daily/monthly rate.
const payTypeFor = (staffType, requested) => (staffType === 'BAGGER' || staffType === 'LOADER') ? 'PIECE' : (['DAILY', 'MONTHLY', 'HOURLY'].includes(String(requested || '').toUpperCase()) ? String(requested).toUpperCase() : 'DAILY');
router.get('/staff', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const cols = STAFF_COLS + (req.query.photos === '1' ? ', photo' : '');   // photos for badge screen
  if (s.all) return res.json(await qall(`SELECT ${cols} FROM staff ORDER BY full_name`));
  if (siteBound(s.ctx)) return res.json(await qall(`SELECT ${cols} FROM staff WHERE tenant_id=? AND site_id=? AND status='ACTIVE' ORDER BY full_name`, [s.ctx.tenant_id, s.ctx.site_id]));
  const site = req.query.site;
  res.json(site ? await qall(`SELECT ${cols} FROM staff WHERE tenant_id=? AND site_id=? ORDER BY full_name`, [s.ctx.tenant_id, site])
    : await qall(`SELECT ${cols} FROM staff WHERE tenant_id=? ORDER BY full_name`, [s.ctx.tenant_id]));
});

// Get a staff member's enrolled face descriptor (for client-side matching at clock-in).
router.get('/staff/:id/face', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: 'select a workspace' });
  const st = await qone('SELECT id,tenant_id,site_id,face_descriptor FROM staff WHERE id=?', [req.params.id]);
  if (!st || st.tenant_id !== s.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (siteBound(s.ctx) && st.site_id !== s.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const t = await qone('SELECT face_match_threshold FROM tenants WHERE id=?', [s.ctx.tenant_id]);
  res.json({ enrolled: !!st.face_descriptor, descriptor: st.face_descriptor ? J(st.face_descriptor, null) : null, threshold: t?.face_match_threshold ?? 0.55 });
});

// Tenant settings (face match threshold, …)
router.get('/settings', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: 'select a workspace' });
  const t = await qone('SELECT face_match_threshold FROM tenants WHERE id=?', [s.ctx.tenant_id]);
  res.json({ face_match_threshold: t?.face_match_threshold ?? 0.55 });
});
router.patch('/settings', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const b = req.body || {};
  if (b.face_match_threshold != null) {
    const v = Number(b.face_match_threshold);
    if (!(v >= 0.3 && v <= 0.8)) return res.status(400).json({ error: 'threshold must be between 0.30 and 0.80' });
    await qrun('UPDATE tenants SET face_match_threshold=? WHERE id=?', [v, req.ctx.tenant_id]);
  }
  const t = await qone('SELECT face_match_threshold FROM tenants WHERE id=?', [req.ctx.tenant_id]);
  res.json({ face_match_threshold: t?.face_match_threshold ?? 0.55 });
});

// Enrol / update a staff member's face descriptor (128 floats).
router.post('/staff/:id/face', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const st = await qone('SELECT id,tenant_id,site_id FROM staff WHERE id=?', [req.params.id]);
  if (!st || st.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (siteBound(req.ctx) && st.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const d = (req.body || {}).descriptor;
  if (!Array.isArray(d) || d.length !== 128 || !d.every((x) => typeof x === 'number' && isFinite(x))) {
    return res.status(400).json({ error: 'descriptor must be 128 numbers' });
  }
  await qrun('UPDATE staff SET face_descriptor=?, face_enrolled_at=? WHERE id=?', [JSON.stringify(d), nowS(), st.id]);
  await audit(req.ctx.tenant_id, req.user.id, 'FACE_ENROLL', 'staff', st.id, {});
  res.json({ ok: true });
});
router.delete('/staff/:id/face', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const st = await qone('SELECT id,tenant_id,site_id FROM staff WHERE id=?', [req.params.id]);
  if (!st || st.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  await qrun('UPDATE staff SET face_descriptor=NULL, face_enrolled_at=NULL WHERE id=?', [st.id]);
  res.json({ ok: true });
});
// Passport-style staff photo for the badge (small JPEG data URL, ≤ ~200 KB).
router.get('/staff/:id/photo', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: 'select a workspace' });
  const st = await qone('SELECT tenant_id, photo FROM staff WHERE id=?', [req.params.id]);
  if (!st || st.tenant_id !== s.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  res.json({ photo: st.photo || null });
});
router.post('/staff/:id/photo', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const st = await qone('SELECT id,tenant_id,site_id FROM staff WHERE id=?', [req.params.id]);
  if (!st || st.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (siteBound(req.ctx) && st.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const photo = (req.body || {}).photo;
  if (typeof photo !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/.test(photo)) return res.status(400).json({ error: 'photo must be an image data URL' });
  if (photo.length > 300 * 1024) return res.status(400).json({ error: 'photo too large — keep it small (passport size)' });
  await qrun('UPDATE staff SET photo=?, photo_at=? WHERE id=?', [photo, nowS(), st.id]);
  await audit(req.ctx.tenant_id, req.user.id, 'STAFF_PHOTO', 'staff', st.id, {});
  res.json({ ok: true });
});
router.delete('/staff/:id/photo', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const st = await qone('SELECT id,tenant_id,site_id FROM staff WHERE id=?', [req.params.id]);
  if (!st || st.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  await qrun('UPDATE staff SET photo=NULL, photo_at=NULL WHERE id=?', [st.id]);
  res.json({ ok: true });
});
router.post('/staff', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const b = req.body || {};
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : b.site_id;
  if (!b.full_name || !site_id) return res.status(400).json({ error: 'full_name and site_id required' });
  const site = await siteById(site_id); if (!site || site.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid site' });
  const id = uuid();
  const staff_type = STAFF_TYPES.includes(String(b.staff_type || '').toUpperCase()) ? String(b.staff_type).toUpperCase() : 'REGULAR';
  const pay_type = payTypeFor(staff_type, b.pay_type);
  // Baggers/loaders use a piece role_title by default; regular keep their position.
  const role_title = (b.role_title || '').trim() || (staff_type === 'REGULAR' ? null : staff_type.charAt(0) + staff_type.slice(1).toLowerCase());
  try {
    await qrun(`INSERT INTO staff (id,tenant_id,site_id,full_name,role_title,phone,pay_type,staff_type,department,bank_name,bank_account,daily_rate,rate_loaded,rate_bagged,badge_code,ext_people_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.ctx.tenant_id, site_id, b.full_name.trim(), role_title, b.phone || null, pay_type, staff_type,
        b.department || null, b.bank_name || null, b.bank_account || null,
        +b.daily_rate || 0, +b.rate_loaded || 0, +b.rate_bagged || 0, newBadgeCode(), b.ext_people_id || null]);
  } catch { return res.status(409).json({ error: 'staff already exists for this site' }); }
  await audit(req.ctx.tenant_id, req.user.id, 'STAFF_ADD', 'staff', id, { full_name: b.full_name, staff_type });
  res.status(201).json(await qone('SELECT * FROM staff WHERE id=?', [id]));
});
router.patch('/staff/:id', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const st = await qone('SELECT * FROM staff WHERE id=?', [req.params.id]);
  if (!st || st.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (siteBound(req.ctx) && st.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const f = req.body || {};
  const staff_type = f.staff_type != null ? (STAFF_TYPES.includes(String(f.staff_type).toUpperCase()) ? String(f.staff_type).toUpperCase() : st.staff_type) : st.staff_type;
  const pay_type = f.staff_type != null || f.pay_type != null ? payTypeFor(staff_type, f.pay_type ?? st.pay_type) : st.pay_type;
  await qrun(`UPDATE staff SET full_name=?,role_title=?,phone=?,pay_type=?,staff_type=?,department=?,bank_name=?,bank_account=?,
      daily_rate=?,rate_loaded=?,rate_bagged=?,status=?,site_id=? WHERE id=?`,
    [f.full_name ?? st.full_name, f.role_title ?? st.role_title, f.phone ?? st.phone, pay_type, staff_type,
      f.department ?? st.department, f.bank_name ?? st.bank_name, f.bank_account ?? st.bank_account,
      f.daily_rate ?? st.daily_rate, f.rate_loaded ?? st.rate_loaded, f.rate_bagged ?? st.rate_bagged,
      f.status ?? st.status, siteBound(req.ctx) ? st.site_id : (f.site_id ?? st.site_id), st.id]);
  res.json(await qone('SELECT * FROM staff WHERE id=?', [st.id]));
});
router.post('/staff/import', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) => {
  if (!await posEnabled(req.ctx.tenant_id)) return res.status(503).json({ error: 'POS not connected for this company', code: 'no_pos' });
  try {
    const people = await sales.getStaff();
    const sites = await qall('SELECT * FROM sites WHERE tenant_id=?', [req.ctx.tenant_id]);
    const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let added = 0;
    for (const p of people) {
      if (!p.name || !p.siteName) continue;
      const site = sites.find((s) => norm(s.code) === norm(p.siteName) || norm(s.name) === norm(p.siteName));
      if (!site) continue;
      const r = await qrun('INSERT INTO staff (id,tenant_id,site_id,full_name,ext_people_id) VALUES (?,?,?,?,?) ON CONFLICT (tenant_id,site_id,full_name) DO NOTHING',
        [uuid(), req.ctx.tenant_id, site.id, p.name, p.ext_id]);
      if (r.rowCount) added++;
    }
    await audit(req.ctx.tenant_id, req.user.id, 'IMPORT', 'staff', null, { added });
    res.json({ imported: added, scanned: people.length });
  } catch (e) { res.status(e.httpStatus || 502).json({ error: e.message, code: e.code }); }
});

// ── TYPE-AHEAD ────────────────────────────────────────────────────────────────
router.get('/suggest/staff', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.json([]);
  const q = (req.query.q || '').toString().trim(); if (q.length < 2) return res.json([]);
  if (await posEnabled(s.ctx.tenant_id)) { try { return res.json(await sales.searchStaff(q)); } catch {} }
  res.json(await qall("SELECT DISTINCT full_name AS name, role_title AS role, phone FROM staff WHERE tenant_id=? AND full_name LIKE ? ORDER BY full_name LIMIT 8", [s.ctx.tenant_id, `%${q}%`]));
});
router.get('/suggest/customers', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.json([]);
  const q = (req.query.q || '').toString().trim(); if (q.length < 2) return res.json([]);
  if (await posEnabled(s.ctx.tenant_id)) { try { return res.json(await sales.searchCustomers(q)); } catch {} }
  res.json(await qall('SELECT DISTINCT name, phone FROM customers WHERE tenant_id=? AND name ILIKE ? ORDER BY name LIMIT 10', [s.ctx.tenant_id, `%${q}%`]));
});

router.get('/suggest/vendors', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.json([]);
  const q = (req.query.q || '').toString().trim(); if (q.length < 1) return res.json([]);
  // Primary source: the imported vendors directory (name + bank/phone hint).
  const rows = await qall(
    `SELECT name, phone, bank, account_no, category FROM vendors
      WHERE tenant_id=? AND status='ACTIVE' AND name ILIKE ? ORDER BY name LIMIT 12`,
    [s.ctx.tenant_id, `%${q}%`]);
  const seen = new Set(rows.map((r) => r.name.toLowerCase()));
  // Fallback: any free-typed vendor names already used on expenses but not in the directory.
  const extra = await qall(
    `SELECT DISTINCT vendor FROM expenses WHERE tenant_id=? AND vendor IS NOT NULL AND vendor <> '' AND vendor ILIKE ? ORDER BY vendor LIMIT 8`,
    [s.ctx.tenant_id, `%${q}%`]);
  const out = rows.map((r) => ({
    label: r.name, vendor: r.name,
    sub: [r.bank && r.account_no ? `${r.bank} · ${r.account_no}` : r.bank, r.phone, r.category].filter(Boolean).join(' · ') || undefined,
  }));
  for (const e of extra) { if (!seen.has(e.vendor.toLowerCase())) out.push({ label: e.vendor, vendor: e.vendor }); }
  res.json(out);
});

// Suggest expense-item names already used (incl. migrated history) — for the
// itemised expense form. New names are simply accepted (stored on the expense).
router.get('/suggest/expense-items', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.json([]);
  const q = (req.query.q || '').toString().trim(); if (q.length < 1) return res.json([]);
  try {
    const rows = await qall(
      `SELECT name, COUNT(*) n FROM (
         SELECT TRIM(elem->>'name') AS name
         FROM expenses e, LATERAL jsonb_array_elements(e.items_json::jsonb) elem
         WHERE e.tenant_id=? AND e.items_json IS NOT NULL AND left(e.items_json,1)='['
       ) t
       WHERE name <> '' AND name ILIKE ? GROUP BY name ORDER BY n DESC, name LIMIT 12`,
      [s.ctx.tenant_id, `%${q}%`]);
    res.json(rows.map((r) => ({ label: r.name })));
  } catch { res.json([]); }   // malformed items_json shouldn't break the picker
});

// ── SITE MESSAGES (private note from a site user to the admin) ────────────────
// Visible only to the sender and to admins. Each side can hide its own copy.
router.get('/site-messages', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const isAdmin = atLeast(s.ctx.role, 'ADMIN');
  const rows = isAdmin
    ? await qall(`SELECT m.*, u.name sender_name, u.email sender_email, st.name site_name
        FROM site_messages m LEFT JOIN users u ON u.id=m.sender_id LEFT JOIN sites st ON st.id=m.site_id
        WHERE m.tenant_id=? AND m.deleted_by_admin=false ORDER BY m.created_at DESC LIMIT 300`, [s.ctx.tenant_id])
    : await qall(`SELECT m.*, st.name site_name FROM site_messages m LEFT JOIN sites st ON st.id=m.site_id
        WHERE m.tenant_id=? AND m.sender_id=? AND m.deleted_by_sender=false ORDER BY m.created_at DESC LIMIT 200`, [s.ctx.tenant_id, req.user.id]);
  res.json({ is_admin: isAdmin, messages: rows.map((r) => ({
    id: r.id, body: r.body, site_name: r.site_name || null,
    sender_name: r.sender_name || null, sender_email: r.sender_email || null,
    mine: r.sender_id === req.user.id, created_at: Number(r.created_at),
  })) });
});
router.post('/site-messages', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'message required' });
  if (body.length > 4000) return res.status(400).json({ error: 'message too long' });
  const site_id = s.ctx.site_id || (req.body || {}).site_id || null;
  const id = uuid();
  await qrun('INSERT INTO site_messages (id,tenant_id,site_id,sender_id,body) VALUES (?,?,?,?,?)', [id, s.ctx.tenant_id, site_id, req.user.id, body]);
  try {
    const admins = (await tenantUserIds(s.ctx.tenant_id, 'ADMIN')).filter((u) => u !== req.user.id);
    await notify(s.ctx.tenant_id, admins, { type: 'message', title: 'New site message', body: body.slice(0, 80), link: 'messages' });
  } catch { /* notify best-effort */ }
  res.status(201).json({ id, ok: true });
});
router.delete('/site-messages/:id', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const m = await qone('SELECT * FROM site_messages WHERE id=? AND tenant_id=?', [req.params.id, s.ctx.tenant_id]);
  if (!m) return res.status(404).json({ error: 'not found' });
  // The sender hides only their own copy; an admin hides only the admin copy.
  if (m.sender_id === req.user.id) await qrun('UPDATE site_messages SET deleted_by_sender=true WHERE id=?', [m.id]);
  else if (atLeast(s.ctx.role, 'ADMIN')) await qrun('UPDATE site_messages SET deleted_by_admin=true WHERE id=?', [m.id]);
  else return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: true });
});

// ── ATTENDANCE ────────────────────────────────────────────────────────────────
const ATT_DIR = path.join(UPLOAD_DIR, 'attendance');
fs.mkdirSync(ATT_DIR, { recursive: true });
function saveDataUrl(dataUrl, tag) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new Error('image too large');
  const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
  const name = `${tag}-${Date.now()}-${uuid().slice(0, 8)}.${ext}`;
  fs.writeFileSync(path.join(ATT_DIR, name), buf);
  return name;
}
router.get('/attendance', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const where = ['a.tenant_id=?'], args = [s.ctx.tenant_id];
  // Single ?date=, or a ?from=&to= range.
  if (req.query.from || req.query.to) {
    if (req.query.from) { where.push('a.work_date>=?'); args.push(req.query.from); }
    if (req.query.to)   { where.push('a.work_date<=?'); args.push(req.query.to); }
  } else {
    where.push('a.work_date=?'); args.push(req.query.date || new Date().toISOString().slice(0, 10));
  }
  if (siteBound(s.ctx)) { where.push('a.site_id=?'); args.push(s.ctx.site_id); }
  else if (req.query.site) { where.push('a.site_id=?'); args.push(req.query.site); }
  const rows = await qall(`SELECT a.*, st.full_name, si.name site_name FROM attendance a
    LEFT JOIN staff st ON st.id=a.staff_id LEFT JOIN sites si ON si.id=a.site_id
    WHERE ${where.join(' AND ')} ORDER BY a.work_date DESC, a.clock_in DESC, st.full_name LIMIT 500`, args);
  res.json(rows.map((r) => ({
    id: r.id, staff_id: r.staff_id, staff: r.full_name, site_id: r.site_id, site: r.site_name, work_date: r.work_date,
    clock_in: r.clock_in, clock_out: r.clock_out, has_photo_in: !!r.photo_in, has_photo_out: !!r.photo_out, has_signature: !!r.signature,
    match_score: r.match_score, in_lat: r.in_lat, in_lng: r.in_lng, out_lat: r.out_lat, out_lng: r.out_lng,
  })));
});
router.post('/attendance/clock', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'out' ? 'out' : 'in';
  const st = await qone('SELECT * FROM staff WHERE id=?', [b.staff_id]);
  if (!st || st.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid staff' });
  if (siteBound(req.ctx) && st.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const date = (b.work_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  let photo = null, sig = null;
  try { photo = saveDataUrl(b.photo, kind === 'out' ? 'out' : 'in'); sig = saveDataUrl(b.signature, 'sig'); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const now = nowS();
  const existing = await qone('SELECT * FROM attendance WHERE tenant_id=? AND staff_id=? AND work_date=?', [req.ctx.tenant_id, st.id, date]);
  const id = existing ? existing.id : uuid();
  const lat = b.lat != null ? Number(b.lat) : null, lng = b.lng != null ? Number(b.lng) : null, acc = b.accuracy != null ? Number(b.accuracy) : null;
  const match = b.match_score != null ? Number(b.match_score) : null;
  if (!existing) {
    await qrun(`INSERT INTO attendance (id,tenant_id,site_id,staff_id,work_date,clock_in,photo_in,signature,in_lat,in_lng,in_acc,match_score,captured_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.ctx.tenant_id, st.site_id, st.id, date,
        kind === 'in' ? now : null, kind === 'in' ? photo : null, sig,
        kind === 'in' ? lat : null, kind === 'in' ? lng : null, kind === 'in' ? acc : null, match, req.user.id]);
    if (kind === 'out') await qrun('UPDATE attendance SET clock_out=?, photo_out=?, out_lat=?, out_lng=?, out_acc=?, match_score=? WHERE id=?', [now, photo, lat, lng, acc, match, id]);
  } else if (kind === 'in') {
    await qrun('UPDATE attendance SET clock_in=?, photo_in=COALESCE(?,photo_in), signature=COALESCE(?,signature), in_lat=?, in_lng=?, in_acc=?, match_score=?, updated_at=? WHERE id=?',
      [now, photo, sig, lat, lng, acc, match, now, id]);
  } else {
    await qrun('UPDATE attendance SET clock_out=?, photo_out=COALESCE(?,photo_out), signature=COALESCE(?,signature), out_lat=?, out_lng=?, out_acc=?, match_score=?, updated_at=? WHERE id=?',
      [now, photo, sig, lat, lng, acc, match, now, id]);
  }
  await audit(req.ctx.tenant_id, req.user.id, kind === 'in' ? 'CLOCK_IN' : 'CLOCK_OUT', 'attendance', id, { staff: st.full_name, date });
  res.status(existing ? 200 : 201).json({ id, kind, clock: now });
});

// Badge clock-in/out: scan a staff badge code → auto clock-in (first scan today)
// or clock-out (already clocked in). Fast, hands-free attendance for the floor.
router.post('/attendance/badge', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const code = String((req.body || {}).badge_code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'badge code required' });
  const st = await qone('SELECT * FROM staff WHERE tenant_id=? AND UPPER(badge_code)=?', [req.ctx.tenant_id, code]);
  if (!st) return res.status(404).json({ error: 'Badge not recognised' });
  if (st.status === 'INACTIVE') return res.status(400).json({ error: `${st.full_name} is inactive` });
  if (siteBound(req.ctx) && st.site_id && st.site_id !== req.ctx.site_id) return res.status(403).json({ error: `${st.full_name} belongs to another site` });
  const date = new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });
  const now = nowS();
  const existing = await qone('SELECT * FROM attendance WHERE tenant_id=? AND staff_id=? AND work_date=?', [req.ctx.tenant_id, st.id, date]);
  let action;
  if (!existing) {
    await qrun('INSERT INTO attendance (id,tenant_id,site_id,staff_id,work_date,clock_in,captured_by) VALUES (?,?,?,?,?,?,?)',
      [uuid(), req.ctx.tenant_id, st.site_id, st.id, date, now, req.user.id]);
    action = 'in';
  } else if (!existing.clock_out) {
    await qrun('UPDATE attendance SET clock_out=?, updated_at=? WHERE id=?', [now, now, existing.id]);
    action = 'out';
  } else {
    return res.json({ staff_id: st.id, staff_name: st.full_name, action: 'done', clock_in: existing.clock_in, clock_out: existing.clock_out, message: `${st.full_name} already clocked out today` });
  }
  await audit(req.ctx.tenant_id, req.user.id, action === 'in' ? 'CLOCK_IN' : 'CLOCK_OUT', 'attendance', st.id, { staff: st.full_name, date, via: 'badge' });
  res.json({ staff_id: st.id, staff_name: st.full_name, role: st.role_title || null, action, clock: now });
});
router.get('/attendance/:id/img/:which', requireAuth, async (req, res) => {
  const a = await qone('SELECT * FROM attendance WHERE id=?', [req.params.id]);
  if (!a) return res.status(404).end();
  const c = await contextFor(req.user, a.tenant_id);
  if (!c || (siteBound(c) && a.site_id !== c.site_id)) return res.status(404).end();
  const name = req.params.which === 'out' ? a.photo_out : req.params.which === 'sig' ? a.signature : a.photo_in;
  if (!name) return res.status(404).end();
  const p = path.join(ATT_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ── TIMESHEETS ────────────────────────────────────────────────────────────────
router.get('/timesheets', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const { site, from, to, date } = req.query; const where = [], args = [];
  if (s.ctx) {
    where.push('t.tenant_id=?'); args.push(s.ctx.tenant_id);
    if (siteBound(s.ctx)) { where.push('t.site_id=?'); args.push(s.ctx.site_id); }
    else if (site) { where.push('t.site_id=?'); args.push(site); }
  }
  if (date) { where.push('t.work_date=?'); args.push(date); }
  if (from) { where.push('t.work_date>=?'); args.push(from); }
  if (to) { where.push('t.work_date<=?'); args.push(to); }
  const sql = `SELECT t.*, st.full_name FROM timesheets t JOIN staff st ON st.id=t.staff_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.work_date DESC, st.full_name LIMIT 2000`;
  res.json(await qall(sql, args));
});
router.post('/timesheets', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const b = req.body || {}; const work_date = b.work_date; const entries = Array.isArray(b.entries) ? b.entries : [];
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : b.site_id;
  if (!work_date || !site_id) return res.status(400).json({ error: 'work_date and site_id required' });
  let n = 0;
  for (const e of entries) {
    const st = await qone('SELECT tenant_id FROM staff WHERE id=?', [e.staff_id]);
    if (!st || st.tenant_id !== req.ctx.tenant_id) continue;
    await qrun(
      `INSERT INTO timesheets (id,tenant_id,site_id,staff_id,work_date,present,hours,bags_bagged,bags_loaded,note,recorded_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(staff_id,work_date) DO UPDATE SET
         present=EXCLUDED.present, hours=EXCLUDED.hours, bags_bagged=EXCLUDED.bags_bagged,
         bags_loaded=EXCLUDED.bags_loaded, note=EXCLUDED.note, recorded_by=EXCLUDED.recorded_by`,
      [uuid(), req.ctx.tenant_id, site_id, e.staff_id, work_date, e.present ? 1 : 0,
        e.hours ?? null, e.bags_bagged ?? null, e.bags_loaded ?? null, e.note || null, req.user.id]);
    n++;
  }
  res.json({ saved: n, work_date });
});
async function tsSummary(tenant_id, site, from, to) {
  const where = ['t.tenant_id=?'], args = [tenant_id];
  if (site) { where.push('t.site_id=?'); args.push(site); }
  if (from) { where.push('t.work_date>=?'); args.push(from); }
  if (to) { where.push('t.work_date<=?'); args.push(to); }
  return qall(`SELECT st.full_name staff, si.name site, COUNT(CASE WHEN t.present=1 THEN 1 END) days,
    COALESCE(SUM(t.hours),0) hours, COALESCE(SUM(t.bags_bagged),0) bags_bagged, COALESCE(SUM(t.bags_loaded),0) bags_loaded
    FROM timesheets t JOIN staff st ON st.id=t.staff_id JOIN sites si ON si.id=t.site_id
    WHERE ${where.join(' AND ')} GROUP BY t.staff_id, st.full_name, si.name ORDER BY si.name, st.full_name`, args);
}
router.get('/timesheets/summary', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error || !s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const site = siteBound(s.ctx) ? s.ctx.site_id : req.query.site;
  res.json(await tsSummary(s.ctx.tenant_id, site, req.query.from, req.query.to));
});
router.get('/timesheets/summary.csv', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error || !s.ctx) return res.status(400).send(s.error || 'select a workspace');
  const site = siteBound(s.ctx) ? s.ctx.site_id : req.query.site;
  const rows = await tsSummary(s.ctx.tenant_id, site, req.query.from, req.query.to);
  const csv = ['Staff,Site,Days,Hours,Bags Bagged,Bags Loaded',
    ...rows.map((r) => [r.staff, r.site, r.days, r.hours, r.bags_bagged, r.bags_loaded].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="timesheets-${req.query.from || 'all'}_${req.query.to || 'all'}.csv"`);
  res.send(csv);
});

router.post('/sync/run', requireAuth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'superadmin only' });
  if (!sales.salesEnabled()) return res.status(503).json({ error: 'Sales source not configured', code: 'no_sales_source' });
  const date = (req.body && req.body.date) || new Date().toLocaleDateString('en-CA', { timeZone: process.env.SYNC_TZ || 'Africa/Lagos' });
  try { res.json(await scheduler.syncDay(date, { email: !!(req.body && req.body.email) })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ── GENERATORS ────────────────────────────────────────────────────────────────
router.get('/generators', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error) return res.status(403).json({ error: s.error });
  const SEL = 'SELECT g.*, st.name site_name FROM generators g LEFT JOIN sites st ON st.id=g.site_id';
  if (s.all) return res.json(await qall(`${SEL} ORDER BY st.name, g.name`));
  if (siteBound(s.ctx)) return res.json(await qall(`${SEL} WHERE g.tenant_id=? AND g.site_id=? ORDER BY g.name`, [s.ctx.tenant_id, s.ctx.site_id]));
  const site = req.query.site;
  res.json(site ? await qall(`${SEL} WHERE g.tenant_id=? AND g.site_id=? ORDER BY g.name`, [s.ctx.tenant_id, site])
    : await qall(`${SEL} WHERE g.tenant_id=? ORDER BY st.name, g.name`, [s.ctx.tenant_id]));
});
router.post('/generators', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const b = req.body || {};
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : (b.site_id || null);
  if (!b.name) return res.status(400).json({ error: 'name required' });
  if (site_id) { const site = await siteById(site_id); if (!site || site.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid site' }); }
  const id = uuid();
  await qrun(`INSERT INTO generators (id,tenant_id,site_id,name,fuel_type,make_model,capacity_kva,serial_no,purchase_date,purchase_cost,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.ctx.tenant_id, site_id, b.name.trim(), b.fuel_type || 'DIESEL', b.make_model || null, b.capacity_kva || null, b.serial_no || null, b.purchase_date || null, b.purchase_cost || null, b.notes || null, req.user.id]);
  await audit(req.ctx.tenant_id, req.user.id, 'CREATE', 'generator', id, { name: b.name });
  res.status(201).json(await qone('SELECT * FROM generators WHERE id=?', [id]));
});
router.patch('/generators/:id', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const g = await qone('SELECT * FROM generators WHERE id=?', [req.params.id]);
  if (!g || g.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (siteBound(req.ctx) && g.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const f = req.body || {};
  await qrun(`UPDATE generators SET name=?,fuel_type=?,make_model=?,capacity_kva=?,serial_no=?,purchase_date=?,purchase_cost=?,status=?,notes=? WHERE id=?`,
    [f.name ?? g.name, f.fuel_type ?? g.fuel_type, f.make_model ?? g.make_model, f.capacity_kva ?? g.capacity_kva, f.serial_no ?? g.serial_no, f.purchase_date ?? g.purchase_date, f.purchase_cost ?? g.purchase_cost, f.status ?? g.status, f.notes ?? g.notes, g.id]);
  res.json(await qone('SELECT * FROM generators WHERE id=?', [g.id]));
});
router.get('/generators/:id/logs', requireAuth, async (req, res) => {
  const g = await qone('SELECT * FROM generators WHERE id=?', [req.params.id]);
  if (!g) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, g.tenant_id);
  if (!c || (siteBound(c) && g.site_id && g.site_id !== c.site_id)) return res.status(404).json({ error: 'not found' });
  const { from, to } = req.query; const where = ['generator_id=?'], args = [g.id];
  if (from) { where.push('log_date>=?'); args.push(from); }
  if (to) { where.push('log_date<=?'); args.push(to); }
  const logs = await qall(`SELECT * FROM generator_logs WHERE ${where.join(' AND ')} ORDER BY log_date DESC, created_at DESC LIMIT 500`, args);
  const tot = await qone(`SELECT COALESCE(SUM(litres),0) litres, COALESCE(SUM(cost),0) cost FROM generator_logs WHERE ${where.join(' AND ')} AND type='DIESEL'`, args);
  res.json({ logs, diesel_total: tot });
});
router.post('/generators/:id/logs', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const g = await qone('SELECT * FROM generators WHERE id=?', [req.params.id]);
  if (!g || g.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (siteBound(req.ctx) && g.site_id && g.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {}; const type = (b.type || 'DIESEL').toUpperCase();
  if (!['DIESEL', 'MAINTENANCE', 'NOTE'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  const id = uuid();
  await qrun(`INSERT INTO generator_logs (id,tenant_id,generator_id,site_id,log_date,type,litres,cost,runtime_hours,detail,recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, g.tenant_id, g.id, g.site_id, b.log_date || new Date().toISOString().slice(0, 10), type, b.litres ?? null, b.cost ?? null, b.runtime_hours ?? null, b.detail || null, req.user.id]);
  res.status(201).json(await qone('SELECT * FROM generator_logs WHERE id=?', [id]));
});

// ── IN-APP POS ────────────────────────────────────────────────────────────────
router.get('/products', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error) return res.status(403).json({ error: s.error });
  if (s.all) return res.json(await qall('SELECT * FROM products ORDER BY name'));
  const q = (req.query.q || '').toString().trim();
  if (q) {
    return res.json(await qall(
      "SELECT * FROM products WHERE tenant_id=? AND status='ACTIVE' AND (name ILIKE ? OR sku ILIKE ?) ORDER BY name LIMIT 20",
      [s.ctx.tenant_id, `%${q}%`, `%${q}%`]));
  }
  res.json(await qall("SELECT * FROM products WHERE tenant_id=? ORDER BY status, name", [s.ctx.tenant_id]));
});
router.post('/products', requireAuth, needTenant('SITE_MANAGER'), async (req, res) => {
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  try {
    await qrun(`INSERT INTO products (id,tenant_id,name,category,price,cost,sku,unit,track_stock,stock_qty)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, req.ctx.tenant_id, b.name.trim(), b.category || null, +b.price || 0, +b.cost || 0, b.sku || null, b.unit || 'unit', b.track_stock === false ? 0 : 1, +b.stock_qty || 0]);
  } catch { return res.status(409).json({ error: 'product name already exists' }); }
  res.status(201).json(await qone('SELECT * FROM products WHERE id=?', [id]));
});
router.patch('/products/:id', requireAuth, needTenant('SITE_MANAGER'), async (req, res) => {
  const p = await qone('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!p || p.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  const f = req.body || {};
  await qrun('UPDATE products SET name=?,category=?,price=?,cost=?,sku=?,unit=?,track_stock=?,status=? WHERE id=?',
    [f.name ?? p.name, f.category ?? p.category, f.price ?? p.price, f.cost ?? p.cost, f.sku ?? p.sku, f.unit ?? p.unit, f.track_stock != null ? (f.track_stock ? 1 : 0) : p.track_stock, f.status ?? p.status, p.id]);
  res.json(await qone('SELECT * FROM products WHERE id=?', [p.id]));
});
router.post('/products/:id/stock', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const p = await qone('SELECT * FROM products WHERE id=?', [req.params.id]);
  if (!p || p.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  const b = req.body || {}; const qty = +b.qty || 0; const type = (b.type || 'ADJUST').toUpperCase();
  if (!qty) return res.status(400).json({ error: 'qty required' });
  await qrun('INSERT INTO inventory_moves (id,tenant_id,product_id,site_id,type,qty,unit_cost,note,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [uuid(), p.tenant_id, p.id, siteBound(req.ctx) ? req.ctx.site_id : (b.site_id || null), ['PURCHASE', 'ADJUST'].includes(type) ? type : 'ADJUST', qty, +b.unit_cost || null, b.note || null, req.user.id]);
  await qrun('UPDATE products SET stock_qty=stock_qty+? WHERE id=?', [qty, p.id]);
  res.json(await qone('SELECT * FROM products WHERE id=?', [p.id]));
});

router.get('/customers', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error || !s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const q = req.query.q;
  res.json(q ? await qall("SELECT * FROM customers WHERE tenant_id=? AND name LIKE ? ORDER BY name LIMIT 50", [s.ctx.tenant_id, '%' + q + '%'])
    : await qall('SELECT * FROM customers WHERE tenant_id=? ORDER BY name LIMIT 200', [s.ctx.tenant_id]));
});
router.post('/customers', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const b = req.body || {}; if (!b.name) return res.status(400).json({ error: 'name required' });
  const name = b.name.trim();
  // Upsert: if name already exists for this tenant return existing record (names are unique per tenant)
  const existing = await qone('SELECT * FROM customers WHERE tenant_id=? AND lower(name)=lower(?)', [req.ctx.tenant_id, name]);
  if (existing) return res.json(existing);
  const id = uuid();
  try {
    await qrun('INSERT INTO customers (id,tenant_id,name,phone,email,note) VALUES (?,?,?,?,?,?)',
      [id, req.ctx.tenant_id, name, b.phone || null, b.email || null, b.note || null]);
    res.status(201).json(await qone('SELECT * FROM customers WHERE id=?', [id]));
  } catch (e) {
    // Race condition: another request inserted between our check and insert
    const race = await qone('SELECT * FROM customers WHERE tenant_id=? AND lower(name)=lower(?)', [req.ctx.tenant_id, name]);
    if (race) return res.json(race);
    res.status(409).json({ error: 'Customer already exists' });
  }
});

router.post('/pos/sales', requireAuth, needTenant('SECRETARY'), async (req, res) => {
  const b = req.body || {};
  if (b.client_uid) {
    const dup = await qone('SELECT * FROM pos_sales WHERE tenant_id=? AND client_uid=?', [req.ctx.tenant_id, b.client_uid]);
    if (dup) return res.status(200).json(dup);
  }
  const items = Array.isArray(b.items) ? b.items.filter((i) => i.product_id && (+i.qty > 0)) : [];
  if (!items.length) return res.status(400).json({ error: 'no items' });
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : (b.site_id || null);
  const lines = [];
  for (const it of items) {
    const p = await qone('SELECT * FROM products WHERE id=? AND tenant_id=?', [it.product_id, req.ctx.tenant_id]);
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
  const nextNoRow = await qone('SELECT COALESCE(MAX(receipt_no),0)+1 n FROM pos_sales WHERE tenant_id=?', [req.ctx.tenant_id]);
  const nextNo = parseInt(nextNoRow.n, 10);
  const sale_date = b.sale_date || new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });
  // Customer is optional (walk-in = blank). A newly-typed name is registered
  // into the customer directory so it becomes a typeahead match next time.
  let customer_id = b.customer_id || null;
  const cname = (b.customer_name || '').trim();
  if (!customer_id && cname) {
    const cu = await qone(
      `INSERT INTO customers (id,tenant_id,name) VALUES (?,?,?)
       ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET name=customers.name
       RETURNING id`, [uuid(), req.ctx.tenant_id, cname]).catch(() => null);
    customer_id = cu ? cu.id : null;
  }
  // Non-cash payments can carry the bank / POS terminal it went through.
  const pmU = (b.payment_method || 'CASH').toUpperCase();
  const bank = pmU === 'CASH' ? null : (String(b.bank || '').trim().toUpperCase() || null);
  const terminal = pmU === 'CASH' ? null : (String(b.terminal || '').trim().toUpperCase() || null);
  await qrun(
    `INSERT INTO pos_sales (id,tenant_id,site_id,receipt_no,customer_id,customer_name,items_json,subtotal,discount,total,payment_method,amount_paid,balance,status,sale_date,bank,terminal,client_uid,sold_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.ctx.tenant_id, site_id, nextNo, customer_id, cname || null,
      JSON.stringify(lines.map((l) => ({ product_id: l.product_id, name: l.name, qty: l.qty, price: l.price, amount: l.amount }))),
      subtotal, discount, total, pmU, amount_paid, balance, status, sale_date, bank, terminal, b.client_uid || null, req.user.id]);
  for (const l of lines) {
    if (!l.track) continue;
    await qrun('UPDATE products SET stock_qty=stock_qty-? WHERE id=?', [l.qty, l.product_id]);
    await qrun('INSERT INTO inventory_moves (id,tenant_id,product_id,site_id,type,qty,ref,created_by) VALUES (?,?,?,?,?,?,?,?)',
      [uuid(), req.ctx.tenant_id, l.product_id, site_id, 'SALE', -l.qty, 'receipt#' + nextNo, req.user.id]);
  }
  emitEvent(req.ctx.tenant_id, site_id, 'sale.created', { sale_id: id, receipt_no: nextNo, total, customer_name: b.customer_name || null, payment_method: (b.payment_method || 'CASH').toUpperCase(), status });
  audit(req.ctx.tenant_id, req.user.id, 'SALE', 'pos_sale', id, { receipt_no: nextNo, total });
  res.status(201).json(await qone('SELECT * FROM pos_sales WHERE id=?', [id]));
});
router.get('/pos/sales', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error || !s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const { from, to, site, source } = req.query; const where = ['p.tenant_id=?'], args = [s.ctx.tenant_id];
  if (siteBound(s.ctx)) { where.push('p.site_id=?'); args.push(s.ctx.site_id); } else if (site) { where.push('p.site_id=?'); args.push(site); }
  if (from) { where.push('p.sale_date>=?'); args.push(from); }
  if (to) { where.push('p.sale_date<=?'); args.push(to); }
  if (source === 'app') where.push('p.ext_id IS NULL');   // in-app sales only (exclude migrated history)
  res.json(await qall(`SELECT p.*, s.name site_name, u.name sold_by_name FROM pos_sales p
    LEFT JOIN sites s ON s.id=p.site_id LEFT JOIN users u ON u.id=p.sold_by
    WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT 300`, args));
});
router.get('/pos/sales/:id', requireAuth, async (req, res) => {
  const sale = await qone('SELECT * FROM pos_sales WHERE id=?', [req.params.id]);
  if (!sale) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, sale.tenant_id);
  if (!c || (siteBound(c) && sale.site_id && sale.site_id !== c.site_id)) return res.status(404).json({ error: 'not found' });
  res.json({ ...sale, items: J(sale.items_json, []), tenant: await tenantById(sale.tenant_id), site: sale.site_id ? await siteById(sale.site_id) : null });
});

// Delete a sale (GM/Admin) — used during testing.  Restores tracked stock and
// reverses inventory moves so figures stay consistent.
router.delete('/pos/sales/:id', requireAuth, async (req, res) => {
  const sale = await qone('SELECT * FROM pos_sales WHERE id=?', [req.params.id]);
  if (!sale) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, sale.tenant_id);
  if (!c || !atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'only a manager can delete a sale' });
  // Restore stock for any tracked products on the receipt.
  const lines = J(sale.items_json, []);
  for (const l of lines) {
    if (!l.product_id) continue;
    const p = await qone('SELECT track_stock FROM products WHERE id=?', [l.product_id]);
    if (p && p.track_stock) await qrun('UPDATE products SET stock_qty=stock_qty+? WHERE id=?', [+l.qty || 0, l.product_id]);
  }
  await qrun('DELETE FROM inventory_moves WHERE tenant_id=? AND ref=?', [sale.tenant_id, 'receipt#' + sale.receipt_no]);
  await qrun('DELETE FROM pos_sales WHERE id=?', [sale.id]);
  audit(sale.tenant_id, req.user.id, 'DELETE', 'pos_sale', sale.id, { receipt_no: sale.receipt_no, total: sale.total });
  emitEvent(sale.tenant_id, sale.site_id, 'sale.deleted', { sale_id: sale.id, receipt_no: sale.receipt_no });
  res.json({ ok: true });
});

// Gate: look up receipt by number (for gate staff to verify before releasing vehicle)
router.get('/pos/gate/:receiptNo', requireAuth, async (req, res) => {
  const s = await scope(req);
  if (s.error || !s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const rn = parseInt(req.params.receiptNo, 10);
  if (isNaN(rn)) return res.status(400).json({ error: 'invalid receipt number' });
  const sale = await qone(
    `SELECT p.*, s.name site_name FROM pos_sales p
     LEFT JOIN sites s ON s.id = p.site_id
     WHERE p.tenant_id=? AND p.receipt_no=?
     ORDER BY p.created_at DESC LIMIT 1`,
    [s.ctx.tenant_id, rn],
  );
  if (!sale) return res.status(404).json({ error: `Receipt #${rn} not found` });
  res.json({ ...sale, items: J(sale.items_json, []) });
});

// Gate: mark sale as exited (truck/customer has left the premises)
router.post('/pos/sales/:id/exit', requireAuth, async (req, res) => {
  const sale = await qone('SELECT * FROM pos_sales WHERE id=?', [req.params.id]);
  if (!sale) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, sale.tenant_id);
  // Gateman / Security release goods; Managers+ may also.  Supervisors only load.
  const canExit = c && (c.role === 'GATEMAN' || c.role === 'GATE' || atLeast(c.role, 'SECRETARY'));
  if (!canExit) return res.status(403).json({ error: 'Not permitted to release/exit' });
  if (siteBound(c) && sale.site_id && sale.site_id !== c.site_id) return res.status(403).json({ error: 'forbidden' });
  if (sale.exited_at) return res.status(400).json({ error: 'Already exited', exited_at: sale.exited_at });
  const ts = nowS();
  await qrun('UPDATE pos_sales SET exited_at=? WHERE id=?', [ts, sale.id]);
  await audit(sale.tenant_id, req.user.id, 'EXIT', 'pos_sale', sale.id, { receipt_no: sale.receipt_no });
  emitEvent(sale.tenant_id, sale.site_id, 'sale.exited', { sale_id: sale.id, receipt_no: sale.receipt_no, exited_at: ts });
  res.json({ ...sale, exited_at: ts, items: J(sale.items_json, []) });
});

// Loading point: mark order as loaded (goods handed to customer/truck)
router.post('/pos/sales/:id/loaded', requireAuth, async (req, res) => {
  const sale = await qone('SELECT * FROM pos_sales WHERE id=?', [req.params.id]);
  if (!sale) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, sale.tenant_id);
  // Supervisors mark goods loaded; Managers+ may also.  Gatemen only release.
  const canLoad = c && (c.role === 'SUPERVISOR' || atLeast(c.role, 'SECRETARY'));
  if (!canLoad) return res.status(403).json({ error: 'Not permitted to mark loaded' });
  if (siteBound(c) && sale.site_id && sale.site_id !== c.site_id) return res.status(403).json({ error: 'forbidden' });
  if (sale.loaded_at) return res.status(400).json({ error: 'Already marked as loaded', loaded_at: sale.loaded_at });
  const ts = nowS();
  await qrun('UPDATE pos_sales SET loaded_at=? WHERE id=?', [ts, sale.id]);
  await audit(sale.tenant_id, req.user.id, 'LOADED', 'pos_sale', sale.id, { receipt_no: sale.receipt_no });
  emitEvent(sale.tenant_id, sale.site_id, 'sale.loaded', { sale_id: sale.id, receipt_no: sale.receipt_no, loaded_at: ts });
  res.json({ ...sale, loaded_at: ts, items: J(sale.items_json, []) });
});

router.get('/pos/summary', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error || !s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const date = req.query.date; if (!date) return res.status(400).json({ error: 'date required' });
  const where = ['tenant_id=?', 'sale_date=?'], args = [s.ctx.tenant_id, date];
  if (siteBound(s.ctx)) { where.push('site_id=?'); args.push(s.ctx.site_id); } else if (req.query.site) { where.push('site_id=?'); args.push(req.query.site); }
  const rows = await qall(`SELECT * FROM pos_sales WHERE ${where.join(' AND ')}`, args);
  const pay = {}; const prod = {}; let total = 0, orders = 0, incentive = 0;
  for (const r of rows) {
    pay[r.payment_method] = (pay[r.payment_method] || 0) + (r.total || 0);
    if (r.payment_method === 'INCENTIVE') { incentive += (r.total || 0); continue; }   // bonus, not sales/cash
    total += (r.total || 0); orders += 1;
    for (const it of J(r.items_json, [])) { const k = it.name; if (!prod[k]) prod[k] = { product: k, qty: 0, amount: 0 }; prod[k].qty += it.qty; prod[k].amount += it.amount; }
  }
  const cash = pay.CASH || 0;
  res.json({ date, total, orders, total_cash: cash, total_deposit: total - cash, incentive,
    payments: Object.entries(pay).map(([method, amount]) => ({ method, amount })), lines: Object.values(prod) });
});

// Date-range POS sales aggregate (the imported Fido history + live in-app sales
// all live in pos_sales). Powers the Reports sales summary and the Dashboard.
router.get('/pos/range', requireAuth, async (req, res) => {
  const s = await scope(req); if (s.error || !s.ctx) return res.status(s.ctx ? 200 : 400).json({ error: s.error || 'select a workspace' });
  const { from, to, site } = req.query;

  // Pre-cutover: POS-connected tenants (fido/fiafia) read LIVE from the source
  // system, so today's in-progress sales show up.  pos_sales is only the
  // historical migration snapshot — it is NOT updated with new fido sales.
  if (from && to && await posEnabled(s.ctx.tenant_id)) {
    try {
      let sites = (await qall('SELECT code FROM sites WHERE tenant_id=?', [s.ctx.tenant_id])).map((r) => r.code);
      if (siteBound(s.ctx)) {
        const sc = await qone('SELECT code FROM sites WHERE id=?', [s.ctx.site_id]);
        sites = sc ? [sc.code] : sites;
      } else if (site) {
        const sc = await qone('SELECT code FROM sites WHERE id=?', [site]);
        if (sc) sites = [sc.code];
      }
      const [bySiteR, byDayR, byMethodR] = await Promise.all([
        sales.query({ from, to, sites, groupBy: 'site' }),
        sales.query({ from, to, sites, groupBy: 'day' }),
        sales.query({ from, to, sites, groupBy: 'paymentMethod' }),
      ]);
      const isCash = (m) => String(m || '').toUpperCase().includes('CASH');
      const orders = byMethodR.reduce((a, r) => a + (r.orders || 0), 0);
      const salesTot = byMethodR.reduce((a, r) => a + (r.amount || 0), 0);
      const cash = byMethodR.filter((r) => isCash(r.group)).reduce((a, r) => a + (r.amount || 0), 0);
      const inc = await sales.incentiveTotal({ from, to, sites }).catch(() => ({ amount: 0, orders: 0 }));
      return res.json({
        live: true,
        totals: { sales: salesTot, orders, cash, transfer: salesTot - cash, incentive: inc.amount, incentive_orders: inc.orders },
        bySite: bySiteR.map((r) => ({ site: r.group || '—', code: r.group, sales: r.amount, orders: r.orders })),
        byDay: byDayR.map((r) => ({ day: r.group, sales: r.amount })).sort((a, b) => (a.day < b.day ? -1 : 1)),
        byMethod: byMethodR.map((r) => ({ method: r.group || '—', sales: r.amount, orders: r.orders })),
      });
    } catch (e) { /* fall through to the pos_sales snapshot on any source error */ }
  }

  const where = ['tenant_id=?'], args = [s.ctx.tenant_id];
  if (siteBound(s.ctx)) { where.push('site_id=?'); args.push(s.ctx.site_id); } else if (site) { where.push('site_id=?'); args.push(site); }
  if (from) { where.push('sale_date>=?'); args.push(from); }
  if (to) { where.push('sale_date<=?'); args.push(to); }
  const W = 'WHERE ' + where.join(' AND ');
  const WP = 'WHERE ' + where.map((c) => 'p.' + c).join(' AND ');   // prefixed for the JOIN query
  // Incentive orders (bonus, no cash) are excluded from sales/cash and reported apart.
  const Wn = W + " AND payment_method<>'INCENTIVE'";
  const WPn = WP + " AND p.payment_method<>'INCENTIVE'";
  const totals = await qone(`SELECT
    COALESCE(SUM(CASE WHEN payment_method<>'INCENTIVE' THEN total ELSE 0 END),0) sales,
    SUM(CASE WHEN payment_method<>'INCENTIVE' THEN 1 ELSE 0 END) orders,
    COALESCE(SUM(CASE WHEN payment_method='CASH' THEN total ELSE 0 END),0) cash,
    COALESCE(SUM(CASE WHEN payment_method NOT IN ('CASH','INCENTIVE') THEN total ELSE 0 END),0) transfer,
    COALESCE(SUM(CASE WHEN payment_method='INCENTIVE' THEN total ELSE 0 END),0) incentive
    FROM pos_sales ${W}`, args);
  const bySite = await qall(`SELECT s.name site, s.code, COALESCE(SUM(p.total),0) sales, COUNT(*) orders
    FROM pos_sales p JOIN sites s ON s.id=p.site_id ${WPn} GROUP BY s.id, s.name, s.code ORDER BY sales DESC LIMIT 20`, args);
  const byDay = await qall(`SELECT sale_date AS "day", COALESCE(SUM(total),0) sales FROM pos_sales ${Wn} GROUP BY sale_date ORDER BY sale_date DESC LIMIT 60`, args);
  const byMethod = await qall(`SELECT payment_method method, COALESCE(SUM(total),0) sales, COUNT(*) orders FROM pos_sales ${W} GROUP BY payment_method ORDER BY sales DESC`, args);
  res.json({
    totals: { sales: Number(totals.sales), orders: parseInt(totals.orders, 10), cash: Number(totals.cash), transfer: Number(totals.transfer), incentive: Number(totals.incentive) },
    bySite: bySite.map((r) => ({ ...r, sales: Number(r.sales), orders: Number(r.orders) })),
    byDay: byDay.reverse().map((r) => ({ ...r, sales: Number(r.sales) })),
    byMethod: byMethod.map((r) => ({ ...r, sales: Number(r.sales), orders: Number(r.orders) })),
  });
});

// Today's individual sales (newest first) for the live Sell ticker.  For
// POS-connected tenants this reads live fido orders; otherwise in-app pos_sales.
router.get('/pos/recent', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
  if (await posEnabled(s.ctx.tenant_id)) {
    try {
      let sites = (await qall('SELECT code FROM sites WHERE tenant_id=?', [s.ctx.tenant_id])).map((r) => r.code);
      if (siteBound(s.ctx)) { const sc = await qone('SELECT code FROM sites WHERE id=?', [s.ctx.site_id]); sites = sc ? [sc.code] : sites; }
      return res.json(await sales.recentOrders({ sites, date, limit }));
    } catch (e) { /* fall through to pos_sales */ }
  }
  const where = ['p.tenant_id=?', 'p.sale_date=?'], args = [s.ctx.tenant_id, date];
  if (siteBound(s.ctx)) { where.push('p.site_id=?'); args.push(s.ctx.site_id); }
  const rows = await qall(`SELECT p.id, p.receipt_no, p.total amount, p.payment_method, p.customer_name customer, s.name site, p.created_at
    FROM pos_sales p LEFT JOIN sites s ON s.id=p.site_id WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT ${limit}`, args);
  res.json(rows.map((r) => ({ id: String(r.id), receipt_no: r.receipt_no, site: r.site || '', customer: r.customer || null, amount: Number(r.amount), payment_method: r.payment_method, at: r.created_at })));
});

// Individual orders for a date range + site (drill-down from the Reports POS
// summary).  Returns line items so each order has a printable receipt.
router.get('/pos/orders', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to || from;
  const { site, site_code, method, bank, terminal } = req.query;
  if (await posEnabled(s.ctx.tenant_id)) {
    try {
      let sites = (await qall('SELECT code FROM sites WHERE tenant_id=?', [s.ctx.tenant_id])).map((r) => r.code);
      if (siteBound(s.ctx)) { const sc = await qone('SELECT code FROM sites WHERE id=?', [s.ctx.site_id]); sites = sc ? [sc.code] : sites; }
      else if (site_code) { sites = [site_code]; }
      else if (site) { const sc = await qone('SELECT code FROM sites WHERE id=?', [site]); if (sc) sites = [sc.code]; }
      return res.json(await sales.listOrders({ from, to, sites, method, bank, terminal, limit: 800 }));
    } catch (e) { /* fall through */ }
  }
  const where = ['p.tenant_id=?', 'p.sale_date>=?', 'p.sale_date<=?'], args = [s.ctx.tenant_id, from, to];
  if (siteBound(s.ctx)) { where.push('p.site_id=?'); args.push(s.ctx.site_id); } else if (site) { where.push('p.site_id=?'); args.push(site); }
  if (method === 'CASH') { where.push("p.payment_method='CASH'"); }
  else if (method === 'NONCASH') { where.push("p.payment_method NOT IN ('CASH','INCENTIVE')"); }
  else if (method) { where.push('p.payment_method=?'); args.push(method.toUpperCase()); }
  else { where.push("p.payment_method<>'INCENTIVE'"); }   // exclude bonus from "all orders"
  if (bank) { where.push('UPPER(p.bank)=UPPER(?)'); args.push(bank); }
  if (terminal) { where.push('UPPER(p.terminal)=UPPER(?)'); args.push(terminal); }
  const rows = await qall(`SELECT p.id, p.receipt_no order_no, p.total amount, p.payment_method, p.customer_name customer, p.items_json, p.bank, p.terminal, s.name site, u.name entry_by, p.created_at
    FROM pos_sales p LEFT JOIN sites s ON s.id=p.site_id LEFT JOIN users u ON u.id=p.sold_by WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC LIMIT 800`, args);
  res.json(rows.map((r) => ({ id: String(r.id), order_no: r.order_no, site: r.site || '', customer: r.customer || null, entry_by: r.entry_by || null, amount: Number(r.amount), payment_method: r.payment_method, bank: r.bank || null, terminal: r.terminal || null, items: J(r.items_json, []), at: r.created_at })));
});

// Non-cash sales broken down by POS terminal / transfer bank (dashboard drill).
router.get('/pos/banks', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to || from;
  const { site, site_code } = req.query;
  if (await posEnabled(s.ctx.tenant_id)) {
    try {
      let sites = (await qall('SELECT code FROM sites WHERE tenant_id=?', [s.ctx.tenant_id])).map((r) => r.code);
      if (siteBound(s.ctx)) { const sc = await qone('SELECT code FROM sites WHERE id=?', [s.ctx.site_id]); sites = sc ? [sc.code] : sites; }
      else if (site_code) { sites = [site_code]; }
      else if (site) { const sc = await qone('SELECT code FROM sites WHERE id=?', [site]); if (sc) sites = [sc.code]; }
      return res.json(await sales.bankBreakdown({ from, to, sites }));
    } catch (e) { /* fall through */ }
  }
  const where = ['p.tenant_id=?', 'p.sale_date>=?', 'p.sale_date<=?', "p.payment_method NOT IN ('CASH','INCENTIVE')"], args = [s.ctx.tenant_id, from, to];
  if (siteBound(s.ctx)) { where.push('p.site_id=?'); args.push(s.ctx.site_id); } else if (site) { where.push('p.site_id=?'); args.push(site); }
  const rows = await qall(`SELECT p.payment_method, UPPER(COALESCE(p.bank,'')) bank, UPPER(COALESCE(p.terminal,'')) terminal,
      COALESCE(SUM(p.total),0) amount, COUNT(*) orders
    FROM pos_sales p WHERE ${where.join(' AND ')} GROUP BY p.payment_method, UPPER(COALESCE(p.bank,'')), UPPER(COALESCE(p.terminal,'')) ORDER BY amount DESC LIMIT 200`, args);
  res.json(rows.map((r) => ({
    kind: /POS|CARD/i.test(r.payment_method || '') ? 'POS' : 'TRANSFER',
    bank: r.bank || null, terminal: r.terminal || null, amount: Number(r.amount), orders: Number(r.orders),
  })));
});

// One order's full detail (powers live-line / order drill-down click).
router.get('/pos/orders/:id', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  if (await posEnabled(s.ctx.tenant_id)) {
    try {
      const o = await sales.getOrder(req.params.id);
      if (o) {
        if (siteBound(s.ctx)) { const sc = await qone('SELECT code FROM sites WHERE id=?', [s.ctx.site_id]); if (sc && String(o.site).toUpperCase().replace(/[^A-Z0-9]/g, '') !== String(sc.code).toUpperCase().replace(/[^A-Z0-9]/g, '')) return res.status(404).json({ error: 'not found' }); }
        return res.json(o);
      }
    } catch (e) { /* fall through */ }
  }
  const r = await qone(`SELECT p.id, p.receipt_no order_no, p.total amount, p.payment_method, p.customer_name customer, p.items_json, p.bank, p.terminal, s.name site, u.name entry_by, p.created_at, p.tenant_id, p.site_id
    FROM pos_sales p LEFT JOIN sites s ON s.id=p.site_id LEFT JOIN users u ON u.id=p.sold_by WHERE p.id=?`, [req.params.id]);
  if (!r || r.tenant_id !== s.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  if (siteBound(s.ctx) && r.site_id && r.site_id !== s.ctx.site_id) return res.status(404).json({ error: 'not found' });
  res.json({ id: String(r.id), order_no: r.order_no, site: r.site || '', customer: r.customer || null, entry_by: r.entry_by || null, amount: Number(r.amount), payment_method: r.payment_method, bank: r.bank || null, terminal: r.terminal || null, items: J(r.items_json, []), at: r.created_at });
});

// POS terminals available to this tenant (for the Sell "which POS?" picker).
// Site-bound users only see terminals at their site (or unassigned ones).
router.get('/pos/terminals', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const where = ['tenant_id=?', "COALESCE(status,'ACTIVE')<>'INACTIVE'"], args = [s.ctx.tenant_id];
  if (siteBound(s.ctx)) { where.push('(site_id=? OR site_id IS NULL)'); args.push(s.ctx.site_id); }
  const rows = await qall(`SELECT id, bank, location, sn, terminal_id, label FROM pos_terminals WHERE ${where.join(' AND ')} ORDER BY bank, location`, args);
  res.json(rows.map((r) => ({
    id: r.id, bank: r.bank || '', location: r.location || '', sn: r.sn || '', terminal_id: r.terminal_id || '',
    label: r.label || [r.bank, r.location].filter(Boolean).join(' · ') || r.terminal_id || r.sn || 'Terminal',
  })));
});

// Full terminal list incl. site + status — for the management screen (Manager+).
router.get('/pos/terminals/manage', requireAuth, needTenant('SITE_MANAGER'), async (req, res) => {
  const where = ['t.tenant_id=?'], args = [req.ctx.tenant_id];
  if (siteBound(req.ctx)) { where.push('(t.site_id=? OR t.site_id IS NULL)'); args.push(req.ctx.site_id); }
  res.json(await qall(`SELECT t.*, s.name site_name FROM pos_terminals t LEFT JOIN sites s ON s.id=t.site_id
    WHERE ${where.join(' AND ')} ORDER BY COALESCE(t.status,'ACTIVE'), t.bank, t.location`, args));
});

const termLabel = (b) => [String(b.bank || '').trim().toUpperCase(), String(b.location || '').trim().toUpperCase()].filter(Boolean).join(' · ') || String(b.terminal_id || b.sn || 'Terminal').trim();
// Create / update / deactivate POS terminals — Manager, GM, Accountant+, Admin.
router.post('/pos/terminals', requireAuth, needTenant('SITE_MANAGER'), async (req, res) => {
  const b = req.body || {};
  if (!String(b.bank || '').trim()) return res.status(400).json({ error: 'bank is required' });
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : (b.site_id || null);
  if (site_id) { const site = await siteById(site_id); if (!site || site.tenant_id !== req.ctx.tenant_id) return res.status(400).json({ error: 'invalid site' }); }
  const id = uuid();
  await qrun(`INSERT INTO pos_terminals (id,tenant_id,site_id,terminal_id,bank,location,sn,company,label,status)
    VALUES (?,?,?,?,?,?,?,?,?, 'ACTIVE')`,
    [id, req.ctx.tenant_id, site_id, String(b.terminal_id || '').trim() || null,
      String(b.bank).trim().toUpperCase(), String(b.location || '').trim().toUpperCase() || null,
      String(b.sn || '').trim() || null, null, termLabel(b)]);
  await audit(req.ctx.tenant_id, req.user.id, 'TERMINAL_ADD', 'pos_terminal', id, { bank: b.bank });
  res.status(201).json(await qone('SELECT * FROM pos_terminals WHERE id=?', [id]));
});
router.patch('/pos/terminals/:id', requireAuth, needTenant('SITE_MANAGER'), async (req, res) => {
  const t = await qone('SELECT * FROM pos_terminals WHERE id=? AND tenant_id=?', [req.params.id, req.ctx.tenant_id]);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (siteBound(req.ctx) && t.site_id && t.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const bank = b.bank != null ? String(b.bank).trim().toUpperCase() : t.bank;
  const location = b.location != null ? (String(b.location).trim().toUpperCase() || null) : t.location;
  const site_id = siteBound(req.ctx) ? t.site_id : (b.site_id !== undefined ? (b.site_id || null) : t.site_id);
  const status = b.status && ['ACTIVE', 'INACTIVE'].includes(String(b.status).toUpperCase()) ? String(b.status).toUpperCase() : t.status;
  await qrun(`UPDATE pos_terminals SET bank=?,location=?,terminal_id=?,sn=?,site_id=?,status=?,label=? WHERE id=?`,
    [bank, location, b.terminal_id != null ? String(b.terminal_id).trim() || null : t.terminal_id,
      b.sn != null ? String(b.sn).trim() || null : t.sn, site_id, status,
      termLabel({ bank, location, terminal_id: b.terminal_id ?? t.terminal_id, sn: b.sn ?? t.sn }), t.id]);
  res.json(await qone('SELECT * FROM pos_terminals WHERE id=?', [t.id]));
});
router.delete('/pos/terminals/:id', requireAuth, needTenant('SITE_MANAGER'), async (req, res) => {
  const t = await qone('SELECT * FROM pos_terminals WHERE id=? AND tenant_id=?', [req.params.id, req.ctx.tenant_id]);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (siteBound(req.ctx) && t.site_id && t.site_id !== req.ctx.site_id) return res.status(403).json({ error: 'forbidden' });
  // Soft-delete so historical sales keep their terminal label.
  await qrun("UPDATE pos_terminals SET status='INACTIVE' WHERE id=?", [t.id]);
  await audit(req.ctx.tenant_id, req.user.id, 'TERMINAL_REMOVE', 'pos_terminal', t.id, {});
  res.json({ ok: true });
});

// Distinct bank names known to this tenant (terminals + past transfers) — powers
// the Transfer bank typeahead.  Falls back to a common Nigerian-bank list.
const COMMON_BANKS = ['ACCESS', 'GTB', 'UBA', 'ZENITH', 'FIRST BANK', 'FCMB', 'FIDELITY', 'STERLING', 'UNION', 'WEMA', 'POLARIS', 'STANBIC', 'ECOBANK', 'KEYSTONE', 'MONIEPOINT', 'OPAY', 'PALMPAY', 'KUDA'];
router.get('/pos/banks', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const set = new Set();
  try { (await qall('SELECT DISTINCT bank FROM pos_terminals WHERE tenant_id=? AND bank IS NOT NULL', [s.ctx.tenant_id])).forEach((r) => r.bank && set.add(String(r.bank).toUpperCase())); } catch { /* table may be empty */ }
  try { (await qall("SELECT DISTINCT bank FROM pos_sales WHERE tenant_id=? AND bank IS NOT NULL AND bank<>'' LIMIT 200", [s.ctx.tenant_id])).forEach((r) => r.bank && set.add(String(r.bank).toUpperCase())); } catch { /* ignore */ }
  COMMON_BANKS.forEach((b) => set.add(b));
  res.json([...set].sort());
});

// ── RECONCILIATIONS (transfer/POS confirmations + cash deposits) ──────────────
router.get('/reconciliations', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const { from, to, site, kind, status } = req.query;
  const where = ['r.tenant_id=?'], args = [s.ctx.tenant_id];
  if (siteBound(s.ctx)) { where.push('(r.site_id=? OR r.site_id IS NULL)'); args.push(s.ctx.site_id); } else if (site) { where.push('r.site_id=?'); args.push(site); }
  if (from) { where.push('r.txn_date>=?'); args.push(from); }
  if (to) { where.push('r.txn_date<=?'); args.push(to); }
  if (kind) { where.push('r.kind=?'); args.push(kind); }
  if (status) { where.push('r.status=?'); args.push(status); }
  res.json(await qall(`SELECT r.*, s.name site_name, c.name customer_name FROM reconciliations r
    LEFT JOIN sites s ON s.id=r.site_id LEFT JOIN customers c ON c.id=r.customer_id
    WHERE ${where.join(' AND ')} ORDER BY r.txn_date DESC NULLS LAST, r.created_at DESC LIMIT 300`, args));
});
router.get('/reconciliations/summary', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const { from, to, site } = req.query;
  const where = ['tenant_id=?'], args = [s.ctx.tenant_id];
  if (siteBound(s.ctx)) { where.push('(site_id=? OR site_id IS NULL)'); args.push(s.ctx.site_id); } else if (site) { where.push('site_id=?'); args.push(site); }
  if (from) { where.push('txn_date>=?'); args.push(from); }
  if (to) { where.push('txn_date<=?'); args.push(to); }
  const byKind = await qall(`SELECT kind, COALESCE(SUM(amount),0) amount, COUNT(*) n,
    COUNT(*) FILTER (WHERE status='PENDING') pending, COUNT(*) FILTER (WHERE status='CONFIRMED') confirmed
    FROM reconciliations WHERE ${where.join(' AND ')} GROUP BY kind ORDER BY amount DESC`, args);
  res.json({ byKind: byKind.map((r) => ({ kind: r.kind, amount: Number(r.amount), n: Number(r.n), pending: Number(r.pending), confirmed: Number(r.confirmed) })) });
});
router.post('/reconciliations', requireAuth, needTenant('SECRETARY'), upload.single('image'), async (req, res) => {
  const b = req.body || {};
  const kind = (b.kind || 'CASH_DEPOSIT').toUpperCase();
  const site_id = siteBound(req.ctx) ? req.ctx.site_id : (b.site_id || null);
  const id = uuid();
  await qrun(`INSERT INTO reconciliations (id,tenant_id,site_id,kind,txn_date,amount,amount_confirmed,bank,account_name,ref,status,remarks,image,recorded_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.ctx.tenant_id, site_id, kind, b.txn_date || new Date().toISOString().slice(0, 10),
      +b.amount || 0, b.amount_confirmed ? +b.amount_confirmed : null, b.bank || null, b.account_name || null, b.ref || null,
      b.status || 'PENDING', b.remarks || null, req.file ? req.file.filename : null, req.user.id]);
  audit(req.ctx.tenant_id, req.user.id, 'CREATE', 'reconciliation', id, { kind });
  res.status(201).json(await qone('SELECT * FROM reconciliations WHERE id=?', [id]));
});
router.patch('/reconciliations/:id', requireAuth, needTenant('GENERAL_MANAGER'), async (req, res) => {
  const r = await qone('SELECT * FROM reconciliations WHERE id=?', [req.params.id]);
  if (!r || r.tenant_id !== req.ctx.tenant_id) return res.status(404).json({ error: 'not found' });
  const b = req.body || {}; const ok = ['PENDING', 'CONFIRMED', 'FLAGGED'];
  await qrun('UPDATE reconciliations SET status=?, amount_confirmed=?, action_taken=?, remarks=? WHERE id=?',
    [ok.includes(b.status) ? b.status : r.status,
      b.amount_confirmed !== undefined ? (b.amount_confirmed === null ? null : +b.amount_confirmed) : r.amount_confirmed,
      b.action_taken !== undefined ? b.action_taken : r.action_taken,
      b.remarks !== undefined ? b.remarks : r.remarks, r.id]);
  audit(r.tenant_id, req.user.id, 'RECONCILE', 'reconciliation', r.id, { status: b.status });
  res.json(await qone('SELECT * FROM reconciliations WHERE id=?', [r.id]));
});
router.get('/reconciliations/:id/image', requireAuth, async (req, res) => {
  const r = await qone('SELECT * FROM reconciliations WHERE id=?', [req.params.id]);
  if (!r) return res.status(404).end();
  const c = await contextFor(req.user, r.tenant_id);
  if (!c || (siteBound(c) && r.site_id && r.site_id !== c.site_id)) return res.status(404).end();
  if (!r.image) return res.status(404).end();
  if (/^https?:\/\//.test(r.image)) return res.redirect(r.image);   // imported proof lives on the old fido server
  const p = path.join(UPLOAD_DIR, r.image);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ── CHAT ──────────────────────────────────────────────────────────────────────
router.get('/chat/channels', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const out = [{ id: 'team', name: 'Team', kind: 'team' }];
  let sites = await qall('SELECT id, name, code FROM sites WHERE tenant_id=? ORDER BY name', [s.ctx.tenant_id]);
  if (siteBound(s.ctx)) sites = sites.filter((x) => x.id === s.ctx.site_id);
  for (const x of sites) out.push({ id: x.id, name: x.name, code: x.code, kind: 'site' });
  res.json(out);
});
router.get('/chat/messages', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const channel = req.query.channel || 'team';
  if (!await channelAllowed(s.ctx, channel)) return res.status(403).json({ error: 'no access to this channel' });
  const since = parseInt(req.query.since, 10) || 0;
  const rows = await qall(`SELECT id, channel, user_id, user_name, body, created_at FROM messages
    WHERE tenant_id=? AND channel=? AND created_at>? ORDER BY created_at ASC, id ASC LIMIT 200`,
    [s.ctx.tenant_id, channel, since]);
  res.json(rows.map((m) => ({ ...m, mine: m.user_id === req.user.id })));
});
router.post('/chat/messages', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const b = req.body || {};
  const channel = b.channel || 'team';
  const body = (b.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'empty message' });
  if (!await channelAllowed(s.ctx, channel)) return res.status(403).json({ error: 'no access to this channel' });
  if (b.client_uid) {
    const dup = await qone('SELECT id FROM messages WHERE tenant_id=? AND client_uid=?', [s.ctx.tenant_id, b.client_uid]);
    if (dup) return res.json({ id: dup.id, duplicate: true });
  }
  const id = uuid();
  const name = req.user.name || req.user.email;
  await qrun('INSERT INTO messages (id,tenant_id,channel,user_id,user_name,body,client_uid) VALUES (?,?,?,?,?,?,?)',
    [id, s.ctx.tenant_id, channel, req.user.id, name, body.slice(0, 2000), b.client_uid || null]);
  let audience = await tenantUserIds(s.ctx.tenant_id, 'SITE_MANAGER');
  if (channel !== 'team') {
    const siteUsers = (await qall("SELECT user_id, role, site_id FROM memberships WHERE tenant_id=? AND user_id IS NOT NULL", [s.ctx.tenant_id]))
      .filter((m) => atLeast(m.role, 'GENERAL_MANAGER') || m.site_id === channel).map((m) => m.user_id);
    audience = siteUsers;
  }
  const siteName = channel !== 'team' ? ((await siteById(channel)) || {}).name || 'Site chat' : null;
  const label = channel === 'team' ? 'Team chat' : siteName;
  await notify(s.ctx.tenant_id, audience.filter((u) => u !== req.user.id),
    { type: 'chat', title: `${name} · ${label}`, body: body.slice(0, 120), link: `chat:${channel}` });
  res.status(201).json({ id, channel, user_id: req.user.id, user_name: name, body, created_at: nowS(), mine: true });
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
router.get('/notifications', requireAuth, async (req, res) => {
  const tid = requestedTenant(req);
  const args = [req.user.id]; let tw = '';
  if (tid) { tw = ' AND (tenant_id=? OR tenant_id IS NULL)'; args.push(tid); }
  const list = await qall(`SELECT * FROM notifications WHERE user_id=?${tw} ORDER BY created_at DESC LIMIT 60`, args);
  const unreadRow = await qone(`SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0${tw}`, args);
  res.json({ unread: parseInt(unreadRow.n, 10), list });
});
router.post('/notifications/read', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (ids && ids.length) {
    for (const i of ids) await qrun('UPDATE notifications SET read=1 WHERE user_id=? AND id=?', [req.user.id, i]);
  } else {
    await qrun('UPDATE notifications SET read=1 WHERE user_id=?', [req.user.id]);
  }
  res.json({ ok: true });
});

// ── FEATURE REQUESTS ──────────────────────────────────────────────────────────
router.get('/feature-requests', requireAuth, async (req, res) => {
  if (req.user.is_superadmin && !requestedTenant(req)) {
    return res.json(await qall(`SELECT f.*, t.name tenant_name FROM feature_requests f LEFT JOIN tenants t ON t.id=f.tenant_id ORDER BY f.created_at DESC LIMIT 200`));
  }
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  res.json(await qall('SELECT * FROM feature_requests WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200', [s.ctx.tenant_id]));
});
router.post('/feature-requests', requireAuth, async (req, res) => {
  const s = await scope(req); if (!s.ctx) return res.status(400).json({ error: s.error || 'select a workspace' });
  const b = req.body || {};
  const title = (b.title || '').toString().trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  const id = uuid(); const name = req.user.name || req.user.email;
  await qrun('INSERT INTO feature_requests (id,tenant_id,user_id,user_name,title,body) VALUES (?,?,?,?,?,?)',
    [id, s.ctx.tenant_id, req.user.id, name, title.slice(0, 160), (b.body || '').toString().slice(0, 4000)]);
  await audit(s.ctx.tenant_id, req.user.id, 'CREATE', 'feature_request', id, { title });
  const supers = (await qall('SELECT id FROM users WHERE is_superadmin=1')).map((u) => u.id);
  const t = await tenantById(s.ctx.tenant_id);
  await notify(s.ctx.tenant_id, [...await tenantUserIds(s.ctx.tenant_id, 'ADMIN'), ...supers].filter((u) => u !== req.user.id),
    { type: 'feature', title: `Feature request — ${t?.name || ''}`, body: title.slice(0, 120), link: 'admin' });
  res.status(201).json(await qone('SELECT * FROM feature_requests WHERE id=?', [id]));
});
router.patch('/feature-requests/:id', requireAuth, async (req, res) => {
  const fr = await qone('SELECT * FROM feature_requests WHERE id=?', [req.params.id]);
  if (!fr) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, fr.tenant_id);
  const canTriage = req.user.is_superadmin || (c && atLeast(c.role, 'ADMIN'));
  if (!canTriage) return res.status(403).json({ error: 'admins only' });
  const b = req.body || {};
  const ok = ['NEW', 'PLANNED', 'IN_PROGRESS', 'DONE', 'DECLINED'];
  const status = ok.includes(b.status) ? b.status : fr.status;
  await qrun('UPDATE feature_requests SET status=?, updated_at=? WHERE id=?', [status, nowS(), fr.id]);
  if (status !== fr.status && fr.user_id && fr.user_id !== req.user.id) {
    await notify(fr.tenant_id, [fr.user_id], { type: 'feature', title: `Your request is now ${status}`, body: fr.title, link: 'admin' });
  }
  res.json(await qone('SELECT * FROM feature_requests WHERE id=?', [fr.id]));
});

// ── BILLING ───────────────────────────────────────────────────────────────────
router.post('/tenants/:id/billing', requireAuth, async (req, res) => {
  if (!req.user.is_superadmin) return res.status(403).json({ error: 'superadmin only' });
  const t = await tenantById(req.params.id); if (!t) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const now = Math.floor(Date.now() / 1000);
  const paid_until = b.paid_until ? parseInt(b.paid_until, 10)
    : (b.months ? now + parseInt(b.months, 10) * 2629800 : t.paid_until);
  await qrun('UPDATE tenants SET paid_until=?, plan=?, status=? WHERE id=?',
    [paid_until, b.plan ?? t.plan, b.status ?? 'ACTIVE', t.id]);
  await audit(t.id, req.user.id, 'BILLING', 'tenant', t.id, { paid_until, plan: b.plan });
  res.json(await tenantById(t.id));
});

const MONTH_SECS = 2629800;

async function applyPaidPayment(reference, rawData) {
  const p = await qone('SELECT * FROM payments WHERE reference=?', [reference]);
  if (!p) return { error: 'unknown reference' };
  if (p.status === 'SUCCESS') return { tenant: await tenantById(p.tenant_id), already: true };
  const t = await tenantById(p.tenant_id); if (!t) return { error: 'tenant gone' };
  const now = Math.floor(Date.now() / 1000);
  const base = Math.max(now, t.paid_until || 0);
  const paid_until = base + (p.months || 1) * MONTH_SECS;
  await qrun("UPDATE tenants SET paid_until=?, plan=?, status='ACTIVE' WHERE id=?", [paid_until, p.plan || t.plan, t.id]);
  await qrun("UPDATE payments SET status='SUCCESS', paid_at=?, raw=? WHERE id=?", [now, rawData ? JSON.stringify(rawData).slice(0, 8000) : p.raw, p.id]);
  await audit(t.id, p.created_by, 'SUBSCRIBE', 'tenant', t.id, { reference, provider: p.provider, plan: p.plan, months: p.months, paid_until });
  await notify(t.id, await tenantUserIds(t.id, 'ADMIN'), { type: 'billing', title: 'Subscription active', body: `${p.plan} · ${p.months} month(s)`, link: 'admin' });
  return { tenant: await tenantById(t.id) };
}
async function confirmPayment(reference) {
  const p = await qone('SELECT * FROM payments WHERE reference=?', [reference]);
  if (!p) return { status: 'unknown' };
  if (p.status === 'SUCCESS') return { status: 'success', tenant: await tenantById(p.tenant_id) };
  const r = await payments.verifyGateway(p.provider, { reference: p.reference, providerReference: p.provider_reference, amountNaira: p.amount });
  if (r.ok) { const a = await applyPaidPayment(reference, r.data || { raw: r.raw }); return { status: 'success', tenant: a.tenant }; }
  await qrun("UPDATE payments SET status='FAILED' WHERE reference=? AND status<>'SUCCESS'", [reference]);
  return { status: r.raw || 'pending' };
}

router.get('/billing/plans', requireAuth, (_req, res) => res.json({
  enabled: payments.paymentsEnabled(), provider: payments.activeProvider(), currency: payments.CURRENCY,
  public_key: payments.paystack.PUBLIC, plans: payments.planList(),
  subscription: { enabled: ls.subscriptionsEnabled(), price_label: ls.priceLabel() },
  autorenew: { enabled: payments.paystack.paystackEnabled(), provider: 'paystack' },
}));

async function ensurePaystackPlan(planType, interval) {
  const meta = payments.PLANS[planType]; if (!meta) throw new Error('unknown plan');
  const intv = interval === 'annually' ? 'annually' : 'monthly';
  const key = `${planType}_${intv}`;
  const cached = await qone('SELECT plan_code FROM payment_plans WHERE code=?', [key]);
  if (cached && cached.plan_code) return { plan_code: cached.plan_code, interval: intv, amountKobo: (intv === 'annually' ? meta.price * 12 : meta.price) * 100 };
  const amountKobo = (intv === 'annually' ? meta.price * 12 : meta.price) * 100;
  const created = await payments.paystack.createPlan({ name: `Daybook ${meta.name} (${intv})`, amountKobo, interval: intv });
  await qrun('INSERT INTO payment_plans (id,code,provider,plan_code,interval,amount) VALUES (?,?,?,?,?,?) ON CONFLICT (code) DO UPDATE SET plan_code=EXCLUDED.plan_code',
    [uuid(), key, 'paystack', created.plan_code, intv, amountKobo / 100]);
  return { plan_code: created.plan_code, interval: intv, amountKobo };
}

async function applySubscriptionCharge(data) {
  const reference = data && data.reference; if (!reference) return;
  if (await qone("SELECT 1 FROM payments WHERE reference=? AND status='SUCCESS'", [reference])) return;
  const meta = data.metadata || {};
  const custCode = data.customer && data.customer.customer_code;
  let t = meta.tenant_id ? await tenantById(meta.tenant_id) : null;
  if (!t && custCode) t = await qone('SELECT * FROM tenants WHERE ps_customer_code=?', [custCode]);
  if (!t) return;
  const interval = (data.plan && data.plan.interval) || meta.interval || 'monthly';
  const now = Math.floor(Date.now() / 1000);
  const add = (interval === 'annually' ? 12 : 1) * MONTH_SECS;
  const base = Math.max(now, t.paid_until || 0);
  const paid_until = base + add;
  await qrun(`UPDATE tenants SET paid_until=?, plan=COALESCE(?,plan), status='ACTIVE', subscription_status='active',
      ps_customer_code=COALESCE(?,ps_customer_code), ps_subscription_code=COALESCE(?,ps_subscription_code), subscription_renews_at=? WHERE id=?`,
    [paid_until, meta.plan || null, custCode || null, data.subscription_code || null, paid_until, t.id]);
  await qrun(`INSERT INTO payments (id,tenant_id,reference,plan,months,amount,currency,provider,status,paid_at,raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (reference) DO NOTHING`,
    [uuid(), t.id, reference, meta.plan || t.plan, interval === 'annually' ? 12 : 1,
      Math.round((Number(data.amount) || 0) / 100), payments.CURRENCY, 'paystack', 'SUCCESS', now, JSON.stringify(data).slice(0, 8000)]);
  await audit(t.id, null, 'SUBSCRIBE_RENEW', 'tenant', t.id, { reference, interval, paid_until });
  await notify(t.id, await tenantUserIds(t.id, 'ADMIN'), { type: 'billing', title: 'Subscription renewed', body: `Auto-renew · paid through ${new Date(paid_until * 1000).toLocaleDateString()}`, link: 'admin' });
}

router.post('/billing/checkout', requireAuth, needTenant('ADMIN'), async (req, res) => {
  const provider = payments.activeProvider();
  if (!provider) return res.status(503).json({ error: 'billing not configured', code: 'no_provider' });
  const t = await tenantById(req.ctx.tenant_id);
  if (t.plan === 'OWNER') return res.status(400).json({ error: 'this workspace does not require a subscription' });
  const b = req.body || {};
  const price = payments.priceFor(b.plan, b.months);
  if (!price) return res.status(400).json({ error: 'unknown plan' });
  const reference = 'DBK-' + t.id.slice(0, 8) + '-' + Date.now().toString(36) + '-' + uuid().slice(0, 6);
  await qrun('INSERT INTO payments (id,tenant_id,reference,plan,months,amount,currency,provider,email,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [uuid(), t.id, reference, b.plan, price.months, price.naira, payments.CURRENCY, provider, req.user.email, req.user.id]);
  const callback_url = (process.env.PAYMENT_CALLBACK_URL || process.env.PUBLIC_BASE_URL || '') + '/?pay=' + reference;
  try {
    const g = await payments.initGateway(provider, { email: req.user.email, customerName: t.name, reference, price,
      metadata: { tenant_id: t.id, plan: b.plan, months: price.months, custom_fields: [{ display_name: 'Workspace', variable_name: 'workspace', value: t.name }] },
      callback_url, label: `Daybook · ${t.name} (${b.plan})`, description: `Daybook ${b.plan} · ${price.months} month(s)` });
    if (g.providerReference && g.providerReference !== reference)
      await qrun('UPDATE payments SET provider_reference=? WHERE reference=?', [g.providerReference, reference]);
    res.json({ authorization_url: g.url, provider, reference, amount: price.naira, currency: payments.CURRENCY, months: price.months });
  } catch (e) {
    await qrun("UPDATE payments SET status='FAILED' WHERE reference=?", [reference]);
    res.status(502).json({ error: e.message });
  }
});

router.get('/billing/verify', requireAuth, async (req, res) => {
  const reference = req.query.reference; if (!reference) return res.status(400).json({ error: 'reference required' });
  const p = await qone('SELECT * FROM payments WHERE reference=?', [reference]);
  if (!p) return res.status(404).json({ error: 'unknown reference' });
  if (!await contextFor(req.user, p.tenant_id)) return res.status(403).json({ error: 'not your workspace' });
  try { res.json(await confirmPayment(reference)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/billing/reconcile', requireAuth, needTenant('ADMIN'), async (req, res) => {
  if (!payments.activeProvider()) return res.json({ status: 'none' });
  const p = await qone("SELECT * FROM payments WHERE tenant_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 1", [req.ctx.tenant_id]);
  if (!p) return res.json({ status: 'none' });
  try {
    const r = await payments.verifyGateway(p.provider, { reference: p.reference, providerReference: p.provider_reference, amountNaira: p.amount });
    if (r.ok) { const a = await applyPaidPayment(p.reference, r.data || { raw: r.raw }); return res.json({ status: 'success', tenant: a.tenant }); }
    return res.json({ status: 'pending' });
  } catch { return res.json({ status: 'pending' }); }
});

router.post('/billing/autorenew', requireAuth, needTenant('ADMIN'), async (req, res) => {
  if (!payments.paystack.paystackEnabled()) return res.status(503).json({ error: 'auto-renew not configured', code: 'no_paystack' });
  const t = await tenantById(req.ctx.tenant_id);
  if (t.plan === 'OWNER') return res.status(400).json({ error: 'this workspace does not require a subscription' });
  const b = req.body || {};
  if (!payments.PLANS[b.plan]) return res.status(400).json({ error: 'unknown plan' });
  const interval = b.interval === 'annually' ? 'annually' : 'monthly';
  try {
    const plan = await ensurePaystackPlan(b.plan, interval);
    const reference = 'DBKSUB-' + t.id.slice(0, 8) + '-' + Date.now().toString(36) + '-' + uuid().slice(0, 6);
    await qrun('INSERT INTO payments (id,tenant_id,reference,plan,months,amount,currency,provider,email,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [uuid(), t.id, reference, b.plan, interval === 'annually' ? 12 : 1, plan.amountKobo / 100, payments.CURRENCY, 'paystack', req.user.email, req.user.id]);
    const callback_url = (process.env.PAYMENT_CALLBACK_URL || process.env.PUBLIC_BASE_URL || '') + '/?pay=' + reference;
    const data = await payments.paystack.initTransaction({ email: req.user.email, amountKobo: plan.amountKobo, reference,
      plan: plan.plan_code, currency: payments.CURRENCY, callback_url, label: `Daybook ${b.plan} · auto-renew (${interval})`,
      metadata: { tenant_id: t.id, plan: b.plan, interval, kind: 'subscription' } });
    res.json({ authorization_url: data.authorization_url, reference, interval, plan: b.plan });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/billing/subscribe', requireAuth, needTenant('ADMIN'), async (req, res) => {
  if (!ls.subscriptionsEnabled()) return res.status(503).json({ error: 'subscriptions not configured', code: 'no_ls' });
  try {
    const url = await ls.createCheckout({ tenantId: req.ctx.tenant_id, email: req.user.email });
    if (!url) return res.status(502).json({ error: 'could not start subscription' });
    res.json({ url });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

router.post(['/billing/webhook', '/billing/webhook/paystack'], async (req, res) => {
  if (!payments.paystack.verifySignature(req.rawBody, req.headers['x-paystack-signature'])) return res.status(401).json({ error: 'bad signature' });
  res.json({ received: true });
  const evt = req.body || {}; const data = evt.data || {};
  try {
    if (evt.event === 'charge.success') {
      if (data.plan && data.plan.plan_code) applySubscriptionCharge(data).catch(() => {});
      else if (data.reference) confirmPayment(data.reference).catch(() => {});
    } else if (evt.event === 'subscription.create' && data.subscription_code) {
      const cust = data.customer && data.customer.customer_code;
      const t = cust && await qone('SELECT id FROM tenants WHERE ps_customer_code=?', [cust]);
      if (t) await qrun("UPDATE tenants SET ps_subscription_code=?, subscription_status='active' WHERE id=?", [data.subscription_code, t.id]);
    } else if ((evt.event === 'subscription.disable' || evt.event === 'subscription.not_renew') && data.subscription_code) {
      const status = evt.event === 'subscription.disable' ? 'cancelled' : 'non-renewing';
      await qrun('UPDATE tenants SET subscription_status=? WHERE ps_subscription_code=?', [status, data.subscription_code]);
    }
  } catch (e) { console.warn('[billing] paystack webhook', e.message); }
});
router.post('/billing/webhook/monnify', (req, res) => {
  const secret = payments.monnify.SECRET_KEY;
  if (!secret) return res.sendStatus(200);
  const expected = require('crypto').createHmac('sha512', secret).update(req.rawBody || Buffer.from('')).digest('hex');
  const provided = String(req.headers['monnify-signature'] || '');
  let ok = false; try { ok = expected.length === provided.length && require('crypto').timingSafeEqual(Buffer.from(expected), Buffer.from(provided)); } catch {}
  if (!ok) return res.status(401).json({ error: 'bad signature' });
  res.sendStatus(200);
  const ref = req.body && req.body.eventData && req.body.eventData.paymentReference;
  if (ref) confirmPayment(ref).catch((e) => console.warn('[billing] monnify webhook', ref, e.message));
});
router.post('/billing/webhook/lemonsqueezy', (req, res) => {
  if (!ls.verifyWebhookSignature(req.rawBody, String(req.headers['x-signature'] || ''))) return res.status(401).json({ error: 'bad signature' });
  res.sendStatus(200);
  try { ls.applySubscriptionEvent(req.rawBody); } catch (e) { console.warn('[billing] ls webhook', e.message); }
});

// ── PHASE 3 FEATURE MODULES ───────────────────────────────────────────────────
router.use('/expenses',  require('./routes_expenses'));
router.use('/logistics', require('./routes_logistics'));
router.use('/payroll',   require('./routes_payroll'));

module.exports = router;
