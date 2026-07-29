/**
 * Daybook — auth helpers & middleware (Google-only sign-in)
 *
 * Sign-in flow:
 *   1. Frontend uses Google Identity Services → gets a Google ID token.
 *   2. POST /api/auth/google { credential } → we verify the token against
 *      Google's certs (audience = GOOGLE_CLIENT_ID, reused from otuburu).
 *   3. If the email maps to a known user (or a pending invite, or self-signup),
 *      we mint our own short-lived session JWT.
 *
 * Session JWT carries only the stable identity ({ sub: userId, sa: superadmin }).
 * Tenant + role are resolved per-request from the memberships table, so access
 * changes take effect immediately without re-issuing tokens.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { qone, qall } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// Sessions persist until the user explicitly signs out (logout clears the
// cookie server-side). Long-lived by default; override with SESSION_TTL.
const TOKEN_TTL = process.env.SESSION_TTL || '365d';
const _gclient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── Google ID token verification ──────────────────────────────────────────────
async function verifyGoogleToken(credential) {
  if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not configured on server');
  const ticket = await _gclient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p || !p.email || !p.email_verified) throw new Error('Google account email not verified');
  return { email: p.email.toLowerCase(), sub: p.sub, name: p.name, picture: p.picture };
}

// ── Session tokens ────────────────────────────────────────────────────────────
function signSession(user) {
  return jwt.sign({ sub: user.id, sa: user.is_superadmin ? 1 : 0, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.cookies && req.cookies.daybook_token) return req.cookies.daybook_token;
  return null;
}

async function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'authentication required' });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    const u = await qone('SELECT * FROM users WHERE id=?', [claims.sub]);
    if (!u || u.status !== 'ACTIVE') return res.status(401).json({ error: 'session user not found' });
    req.user = u;
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired session' });
  }
}

// ── Membership / tenant context resolution ────────────────────────────────────
async function membershipsFor(userId) {
  return qall(
    `SELECT m.*, t.name tenant_name, t.slug tenant_slug, t.brand_color, t.pos_source, t.plan, t.trial_ends_at, t.paid_until
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ? AND m.status='ACTIVE' AND t.status='ACTIVE'
      ORDER BY t.name`,
    [userId]
  );
}

/**
 * Tenants the user can operate in.
 *  - superadmin → every active tenant, acting as ADMIN.
 *  - everyone else → the tenants they hold a membership in, with that role.
 * Returns [{ id, name, slug, brand_color, role, site_id }]
 */
async function accessibleTenants(user) {
  const trialDays = (t) => (t.trial_ends_at && (!t.paid_until || t.paid_until < t.trial_ends_at) && t.plan !== 'OWNER')
    ? Math.ceil((t.trial_ends_at - Math.floor(Date.now() / 1000)) / 86400) : null;
  if (user.is_superadmin) {
    const rows = await qall("SELECT * FROM tenants WHERE status='ACTIVE' ORDER BY name");
    return rows.map((t) => ({ id: t.id, name: t.name, slug: t.slug, brand_color: t.brand_color, role: 'ADMIN', site_id: null, super: true, pos: !!t.pos_source, plan: t.plan, trial_days_left: trialDays(t) }));
  }
  const list = await membershipsFor(user.id);
  return list.map((m) => ({
    id: m.tenant_id, name: m.tenant_name, slug: m.tenant_slug, brand_color: m.brand_color,
    role: m.role, site_id: m.site_id, pos: !!m.pos_source, plan: m.plan, trial_days_left: trialDays(m),
  }));
}

/**
 * Effective context for a request operating on a given tenant.
 * Returns { tenant_id, role, site_id } or null if no access.
 * role is one of ADMIN | GENERAL_MANAGER | SITE_MANAGER (superadmin → ADMIN).
 */
async function contextFor(user, tenantId) {
  if (!tenantId) return null;
  if (user.is_superadmin) {
    const t = await qone('SELECT id FROM tenants WHERE id=?', [tenantId]);
    return t ? { tenant_id: tenantId, role: 'ADMIN', site_id: null, super: true } : null;
  }
  const t = await qone('SELECT status FROM tenants WHERE id=?', [tenantId]);
  if (!t || t.status !== 'ACTIVE') return null;
  const m = await qone("SELECT * FROM memberships WHERE user_id=? AND tenant_id=? AND status='ACTIVE'", [user.id, tenantId]);
  return m ? { tenant_id: tenantId, role: m.role, site_id: m.site_id } : null;
}

// Pick the active tenant from ?tenant= / X-Tenant header.
function requestedTenant(req) {
  return req.query.tenant || req.headers['x-tenant'] || null;
}

// Privilege ladder (low → high).  GATEMAN/SUPERVISOR/GATE are gate-only and the
// lowest privilege.  Office writers start at SECRETARY (can use Sales/Expenses);
// (Site) MANAGER adds operational ownership; GM is cross-site; ADMIN manages users.
// Operations tier (Secretary = Manager, site-bound) sits BELOW the finance tier
// (Accountant/Snr Accountant) so payroll can include Accountants but exclude
// Managers/Secretaries, while operational actions start at Secretary.
// Snr Accountant ranks EQUAL to General Manager — same access level (cross-site
// + every GM-gated capability), per business rule. Admin remains above both.
const ROLE_RANK = {
  GATEMAN: 1, GATE: 1, SUPERVISOR: 2,
  SECRETARY: 3, SITE_MANAGER: 4,
  ACCOUNTANT: 5,
  SNR_ACCOUNTANT: 7, GENERAL_MANAGER: 7,
  ADMIN: 8,
};
const atLeast = (role, min) => (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 0);
// A membership is "site-bound" when it has a site and is below Senior Accountant —
// such users (Manager, Accountant, Secretary, gate roles) only see/act on their own
// site.  Senior Accountant, General Manager and Admin are cross-site (all sites).
const siteBound = (ctx) => !!(ctx && ctx.site_id && !atLeast(ctx.role, 'SNR_ACCOUNTANT'));

// ── Whole-business (Group) scope ──────────────────────────────────────────────
// Every ACTIVE tenant this user may act in at minRole. Two ways in:
//   1. A membership at minRole+ in that tenant (the original rule).
//   2. BUSINESS RULE (2026-07-29): the finance tier is whole-business. Payroll
//      is prepared for Fido + Fiafia COMBINED, so a user holding
//      SNR_ACCOUNTANT+ in ANY active tenant gets a borrowed, site-unbound
//      context in every other active tenant at that same role. Without this, a
//      Snr Accountant whose membership row exists only under Fido silently got
//      a Fido-only "combined" payroll — Fiafia staff, clock-ins and bag counts
//      just didn't show up, with nothing to say why.
// Ordering: membership tenants first (alphabetical), borrowed after — so the
// anchor (first entry) is always a tenant the user really belongs to, and it
// is stable between a combined run's preview and its save.
async function groupContexts(user, minRole) {
  const rows = await qall("SELECT id, name FROM tenants WHERE status='ACTIVE' ORDER BY name, id");
  const out = []; const rest = [];
  let financeRole = null;   // the user's highest SNR_ACCOUNTANT+ role anywhere
  for (const t of rows) {
    const c = await contextFor(user, t.id);
    if (c && atLeast(c.role, 'SNR_ACCOUNTANT') && (!financeRole || !atLeast(financeRole, c.role))) financeRole = c.role;
    if (c && atLeast(c.role, minRole)) out.push({ ...c, tenant_name: t.name });
    else rest.push(t);
  }
  if (financeRole && atLeast(financeRole, minRole)) {
    for (const t of rest) out.push({ tenant_id: t.id, tenant_name: t.name, role: financeRole, site_id: null, borrowed: true });
  }
  return out;
}

// The whole-business roll-up for the workspace switcher: [{id, name}] when this
// user qualifies for a combined (Group) view spanning 2+ tenants, else null.
// Sent with every auth payload so the frontend builds the Group entry from what
// the SERVER says the scope is — not from the user's own membership list, which
// misses tenants the finance rule above grants without a membership row.
async function groupTenantsFor(user) {
  const ctxs = await groupContexts(user, 'SNR_ACCOUNTANT');
  if (ctxs.length < 2) return null;
  return ctxs.map((c) => ({ id: c.tenant_id, name: c.tenant_name }));
}

// Sets req.user when a valid token is present, but never blocks the request.
async function optionalAuth(req, _res, next) {
  const token = readToken(req);
  if (token) {
    try {
      const claims = jwt.verify(token, JWT_SECRET);
      const u = await qone('SELECT * FROM users WHERE id=?', [claims.sub]);
      if (u && u.status === 'ACTIVE') req.user = u;
    } catch { /* ignore — treat as anonymous */ }
  }
  next();
}

module.exports = {
  verifyGoogleToken, signSession, requireAuth, optionalAuth,
  membershipsFor, accessibleTenants, contextFor, requestedTenant, atLeast, siteBound,
  groupContexts, groupTenantsFor,
  JWT_SECRET, GOOGLE_CLIENT_ID,
};
