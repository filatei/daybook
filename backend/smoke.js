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
  // Managers may add members BELOW their rank, but not a peer/higher role.
  const mgrAddPeer = await api('POST', '/api/members', { token: mgr, body: { tenant_id: fido.id, email: 'peer@y.test', role: 'SITE_MANAGER', site_id: kpansia.id } });
  check('site manager cannot grant an equal/higher role', mgrAddPeer.status === 403, mgrAddPeer.json);
  const mgrAddLower = await api('POST', '/api/members', { token: mgr, body: { tenant_id: fido.id, email: 'gateman@y.test', role: 'GATEMAN', site_id: kpansia.id } });
  check('site manager can add a lower-rank member', mgrAddLower.status === 201 && (mgrAddLower.json.invited || mgrAddLower.json.added), mgrAddLower.json);

  // ── reports/generate must NOT be shadowed by /reports/:id (regression) ──
  const gen = await api('GET', `/api/reports/generate?tenant=${fido.id}&date=2026-06-12`, { token: su });
  check('reports/generate works (not treated as :id)', gen.status === 200 && !!gen.json.scope, gen.json);
  const genSite = await api('GET', `/api/reports/generate?tenant=${fido.id}&date=2026-06-12&site=${kpansia.id}`, { token: su });
  check('reports/generate single site', genSite.status === 200 && genSite.json.scope === 'SITE' && !!genSite.json.summary, genSite.json);
  const genAll = await api('GET', `/api/reports/generate?tenant=${fido.id}&date=2026-06-12&site=ALL`, { token: su });
  check('reports/generate all sites roll-up', genAll.status === 200 && genAll.json.scope === 'ALL' && Array.isArray(genAll.json.bySite), genAll.json);

  // ── day operations capture (save + read back) ──
  const opsPut = await api('PUT', `/api/reports/ops?tenant=${fido.id}`, { token: su, body: { date: '2026-06-12', site: kpansia.id, data: { water: { ph: '7.2', tds: '40' } } } });
  check('reports/ops save', !!opsPut.json.ok, opsPut.json);
  const opsGet = await api('GET', `/api/reports/ops?tenant=${fido.id}&date=2026-06-12&site=${kpansia.id}`, { token: su });
  check('reports/ops read back', opsGet.json.data && opsGet.json.data.water && opsGet.json.data.water.ph === '7.2', opsGet.json);

  // ── expense lifecycle: create → validate → approve → pay (+ imprest tagging) ──
  const exp = await api('POST', `/api/expenses?tenant=${fido.id}`, { token: su, body: { site_id: kpansia.id, category: 'DIESEL', description: 'Smoke diesel', kind: 'IMPREST', items: [{ name: 'Diesel', qty: 10, price: 1000 }] } });
  check('create expense (DRAFT, imprest)', exp.status === 201 && !!exp.json.id && exp.json.wf_state === 'DRAFT' && exp.json.kind === 'IMPREST', exp.json);
  const eid = exp.json.id;
  const t1 = await api('POST', `/api/expenses/${eid}/transition`, { token: su, body: { action: 'validate' } });
  check('expense validate → REVIEWED', t1.json.wf_state === 'REVIEWED', t1.json);
  const t2 = await api('POST', `/api/expenses/${eid}/transition`, { token: su, body: { action: 'approve' } });
  check('expense approve → APPROVED', t2.json.wf_state === 'APPROVED', t2.json);
  const t3 = await api('POST', `/api/expenses/${eid}/transition`, { token: su, body: { action: 'pay' } });
  check('expense pay → PAID', t3.json.wf_state === 'PAID', t3.json);
  const badStep = await api('POST', `/api/expenses/${eid}/transition`, { token: su, body: { action: 'validate' } });
  check('expense bad transition rejected', badStep.status === 409, badStep.json);
  const imp = await api('GET', `/api/expenses/imprest-summary?tenant=${fido.id}&from=2026-06-12&to=2026-06-12`, { token: su });
  check('imprest summary shape', Array.isArray(imp.json.sites), imp.json);

  // ── contact us reaches at least one recipient (admins, with inbox fallback) ──
  const contact = await api('POST', `/api/contact?tenant=${fido.id}`, { token: su, body: { message: 'Smoke contact test' } });
  check('contact reaches a recipient', contact.status === 201 && contact.json.ok && contact.json.recipients >= 1, contact.json);

  // ── email diagnostics (MAIL_DISABLED → no-op success) ──
  const eh = await api('GET', `/api/email/health?tenant=${fido.id}`, { token: su });
  check('email health ok', eh.json.ok === true, eh.json);
  const et = await api('POST', `/api/email/test?tenant=${fido.id}`, { token: su, body: { to: 'test@x.test' } });
  check('email test send ok', et.json.ok === true, et.json);

  // ── disabling a member revokes access but keeps their data ──
  const members = await api('GET', `/api/members?tenant=${fido.id}`, { token: su });
  const mgrMember = (members.json.members || []).find((m) => m.email === 'mgr@fido.test');
  check('members list includes the site manager', !!mgrMember, members.json);
  const disable = await api('PATCH', `/api/members/${mgrMember.id}?tenant=${fido.id}`, { token: su, body: { status: 'DISABLED' } });
  check('admin disables a member', !!disable.json.ok, disable.json);
  const mgrAfter = await api('GET', '/api/auth/me', { token: mgr });
  check('disabled member loses access', (mgrAfter.json.tenants || []).length === 0, mgrAfter.json);
  await api('PATCH', `/api/members/${mgrMember.id}?tenant=${fido.id}`, { token: su, body: { status: 'ACTIVE' } });   // restore

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
