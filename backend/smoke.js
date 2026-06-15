/**
 * Daybook — smoke test (multi-client SaaS).
 * Exercises: dev-login, membership scoping, report totals, dashboard,
 * self-serve onboarding, tenant isolation, and site-manager restriction.
 *
 * Requires the server booted with NODE_ENV!=production and DAYBOOK_ALLOW_DEV_LOGIN=1.
 * Run: npm run smoke
 */
'use strict';
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8090';

async function api(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json; try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, json };
}
const dev = (email) => api('POST', '/api/auth/dev-login', { body: { email } }).then((r) => r.json.token);

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n, x ? JSON.stringify(x).slice(0, 200) : ''); } };

(async () => {
  console.log('Daybook smoke →', BASE);

  check('healthz', (await api('GET', '/healthz')).json.status === 'ok');
  check('config exposes google_client_id key', 'google_client_id' in (await api('GET', '/api/config')).json);

  // ── superadmin (you) ──
  const su = await dev('filatei@gmail.com');
  const me = await api('GET', '/api/auth/me', { token: su });
  check('superadmin sees both tenants', me.json.tenants.length >= 2 && me.json.user.is_superadmin, me.json);
  const fido = me.json.tenants.find((t) => t.slug === 'fido');
  const fiafia = me.json.tenants.find((t) => t.slug === 'fiafia');
  check('fido + fiafia present', !!fido && !!fiafia);
  check('superadmin role is ADMIN in tenant', fido.role === 'ADMIN');

  const sites = await api('GET', `/api/sites?tenant=${fido.id}`, { token: su });
  check('fido has 7 sites', sites.json.length === 7, sites.json);
  const kpansia = sites.json.find((s) => s.code === 'KPANSIA');

  const rep = await api('POST', '/api/reports', { token: su, body: {
    tenant_id: fido.id, site_id: kpansia.id, report_date: '2026-06-12',
    total_cash: 288600, total_deposit: 51200, diesel: 1147000,
    sales: [{ product: 'PUREWATER', qty: 1030, amount: 309000 }, { product: 'DISPENSER', qty: 44, amount: 30800 }],
    production: { OPENING: 4328, SALES: 1030, AVAILABLE: 3008 }, submit: true } });
  check('create report (totals)', [200, 201].includes(rep.status) && rep.json.total_sales === 339800, rep.json);

  const dash = await api('GET', `/api/dashboard?tenant=${fido.id}`, { token: su });
  check('dashboard aggregates', dash.json.totals.sales >= 339800, dash.json);
  const dashAll = await api('GET', '/api/dashboard', { token: su });
  check('superadmin cross-tenant dashboard', dashAll.status === 200 && dashAll.json.totals.reports >= 1, dashAll.json);

  const recs = await api('GET', `/api/recipients?tenant=${fido.id}`, { token: su });
  check('default recipient seeded', recs.json.some((r) => r.email === 'dailyreports@gtsng.com'), recs.json);

  // ── self-serve onboarding (a brand-new client company) ──
  const acmeUser = await dev('owner@acmewater.test');
  const meEmpty = await api('GET', '/api/auth/me', { token: acmeUser });
  check('new user has no workspaces', meEmpty.json.tenants.length === 0);
  const onboard = await api('POST', '/api/onboard', { token: acmeUser, body: { name: 'Acme Water', industry: 'Bottling' } });
  check('onboard creates tenant + admin', onboard.status === 201 && onboard.json.tenants.length === 1 && onboard.json.tenants[0].role === 'ADMIN', onboard.json);
  const acme = onboard.json.tenants[0];

  // ── tenant isolation: acme admin cannot read fido ──
  const cross = await api('GET', `/api/sites?tenant=${fido.id}`, { token: acmeUser });
  check('tenant isolation (acme blocked from fido)', cross.status === 403, cross.json);

  // ── site manager flow ──
  await dev('mgr@fido.test'); // create the user first
  const add = await api('POST', '/api/members', { token: su, body: { tenant_id: fido.id, email: 'mgr@fido.test', role: 'SITE_MANAGER', site_id: kpansia.id } });
  check('admin adds site manager', add.status === 201 && add.json.added, add.json);
  const mgr = await dev('mgr@fido.test');
  const mgrMe = await api('GET', '/api/auth/me', { token: mgr });
  check('site manager scoped to fido', mgrMe.json.tenants.length === 1 && mgrMe.json.tenants[0].role === 'SITE_MANAGER', mgrMe.json);
  const mgrSites = await api('GET', `/api/sites?tenant=${fido.id}`, { token: mgr });
  check('site manager sees only their site', mgrSites.json.length === 1 && mgrSites.json[0].code === 'KPANSIA', mgrSites.json);
  const mgrAdd = await api('POST', '/api/members', { token: mgr, body: { tenant_id: fido.id, email: 'x@y.test', role: 'SITE_MANAGER', site_id: kpansia.id } });
  check('site manager cannot manage members', mgrAdd.status === 403, mgrAdd.json);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
