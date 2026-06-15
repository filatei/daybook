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
const TOKEN_TTL = '12h';
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
const ROLE_RANK = {
  GATEMAN: 1, GATE: 1, SUPERVISOR: 2,
  SECRETARY: 3, SITE_MANAGER: 4,
  ACCOUNTANT: 5, SNR_ACCOUNTANT: 6,
  GENERAL_MANAGER: 7, ADMIN: 8,
};
const atLeast = (role, min) => (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 0);
// A membership is "site-bound" when it has a site and is below General Manager —
// such users (Manager, Secretary, gate roles) only see/act on their own site.
const siteBound = (ctx) => !!(ctx && ctx.site_id && !atLeast(ctx.role, 'GENERAL_MANAGER'));

module.exports = {
  verifyGoogleToken, signSession, requireAuth,
  membershipsFor, accessibleTenants, contextFor, requestedTenant, atLeast, siteBound,
  JWT_SECRET, GOOGLE_CLIENT_ID,
};
