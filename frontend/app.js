/* Daybook PWA — single-file SPA logic (Google sign-in, multi-tenant SaaS) */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ngn = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const ROLE_LABEL = { ADMIN: 'Admin', GENERAL_MANAGER: 'General Manager', SITE_MANAGER: 'Site Manager' };

const State = {
  token: localStorage.getItem('daybook_token') || null,
  user: null, tenants: [], tenant: localStorage.getItem('daybook_tenant') || null,
  tab: 'dashboard', sites: [], charts: {},
};
const active = () => State.tenants.find((t) => t.id === State.tenant) || null;
const myRole = () => (State.user?.is_superadmin && !active() ? 'ADMIN' : active()?.role) || null;
const isAdmin = () => myRole() === 'ADMIN';
const isGMup = () => ['ADMIN', 'GENERAL_MANAGER'].includes(myRole());
const isSiteMgr = () => myRole() === 'SITE_MANAGER';

/* ── API ─────────────────────────────────────────────── */
async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {}; if (State.token) headers.Authorization = `Bearer ${State.token}`;
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch('/api' + path, { method, headers, body: payload });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || json.detail || `Error ${res.status}`);
  return json;
}
const scoped = (p) => (State.tenant ? p + (p.includes('?') ? '&' : '?') + 'tenant=' + State.tenant : p);

/* ── Toast / Modal / Validation (shared) ─────────────── */
function toast(msg, kind = 'info', ms = 3200) {
  const el = document.createElement('div'); const ic = { ok: '✓', err: '⚠', info: 'ℹ' }[kind] || 'ℹ';
  el.className = `toast ${kind}`; el.innerHTML = `<span class="ti">${ic}</span><span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el); setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}
function modal(html, { title, sub } = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-bg"><div class="modal"><div class="grip"></div>
    ${title ? `<h3>${esc(title)}</h3>` : ''}${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
    <div id="modalBody">${html}</div></div></div>`;
  const bg = $('.modal-bg', root); bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
  return $('#modalBody', root);
}
function closeModal() { const m = $('.modal', $('#modalRoot')); if (m) { m.style.animation = 'sheet .25s reverse'; setTimeout(() => ($('#modalRoot').innerHTML = ''), 220); } }
function setErr(id, show) { const i = $('#' + id), e = $('#' + id + '-e'); if (i) i.classList.toggle('err', show); if (e) e.classList.toggle('show', show); }
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/* ── Google Sign-In ──────────────────────────────────── */
async function initGoogle() {
  let cfg = {}; try { cfg = await api('/config'); } catch {}
  const clientId = cfg.google_client_id;
  if (!clientId) { $('#gsi-fallback').classList.remove('hidden'); return; }
  const wait = () => new Promise((res) => { const t = setInterval(() => { if (window.google?.accounts?.id) { clearInterval(t); res(); } }, 80); setTimeout(() => { clearInterval(t); res(); }, 6000); });
  await wait();
  if (!window.google?.accounts?.id) { $('#gsi-fallback').classList.remove('hidden'); return; }
  google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
  google.accounts.id.renderButton($('#gsi-button'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
}
async function onGoogleCredential(resp) {
  try {
    const r = await api('/auth/google', { method: 'POST', body: { credential: resp.credential } });
    State.token = r.token; localStorage.setItem('daybook_token', r.token);
    await boot();
  } catch (e) { toast(e.message, 'err', 5000); }
}
$('#logoutBtn').addEventListener('click', logout);
function logout() {
  State.token = null; localStorage.removeItem('daybook_token'); aiHistory = [];
  if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  const f = $('#aiFab'); if (f) f.remove();
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
}

/* ── Boot ────────────────────────────────────────────── */
async function boot() {
  const me = await api('/auth/me');
  State.user = me.user; State.tenants = me.tenants;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  if (!State.tenants.length) { renderOnboarding(true); return; }
  if (!State.tenant || !State.tenants.find((t) => t.id === State.tenant)) State.tenant = State.tenants[0].id;
  localStorage.setItem('daybook_tenant', State.tenant || '');
  applyBrand(); buildTenantSelect(); setupNav();
  $('.nav button[data-tab="admin"]').classList.toggle('hidden', !isGMup());
  mountAssistant();
  go('dashboard');
}
function applyBrand() {
  const t = active();
  const col = t?.brand_color || '#0ea5e9';
  document.documentElement.style.setProperty('--brand', col);
  document.documentElement.style.setProperty('--brand-d', shade(col, -18));
  document.documentElement.style.setProperty('--brand-l', shade(col, 88));
  $('meta[name=theme-color]').setAttribute('content', col);
}
function shade(hex, p) {
  const n = parseInt(hex.slice(1), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + (p > 0 ? (255 - c) * p / 100 : c * p / 100))));
  return '#' + [f(r), f(g), f(b)].map((c) => c.toString(16).padStart(2, '0')).join('');
}
function buildTenantSelect() {
  const sel = $('#tenantSelect'); const pill = $('#tenantPill');
  const multi = State.tenants.length > 1 || State.user.is_superadmin;
  pill.classList.toggle('hidden', !multi);
  const allOpt = State.user.is_superadmin ? `<option value="">★ All companies</option>` : '';
  sel.innerHTML = allOpt + State.tenants.map((t) => `<option value="${t.id}" ${t.id === State.tenant ? 'selected' : ''}>${esc(t.name)} · ${ROLE_LABEL[t.role]}</option>`).join('');
  sel.value = State.tenant || '';
  sel.onchange = () => { State.tenant = sel.value || null; localStorage.setItem('daybook_tenant', State.tenant || ''); applyBrand(); $('.nav button[data-tab="admin"]').classList.toggle('hidden', !isGMup()); go(State.tab); };
}
function setupNav() { $$('.nav button').forEach((b) => b.onclick = () => go(b.dataset.tab)); }
function go(tab) {
  State.tab = tab; $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ({ dashboard: viewDashboard, reports: viewReports, documents: viewDocuments, admin: viewAdmin }[tab] || viewDashboard)();
}
async function loadSites() { try { State.sites = await api(scoped('/sites')); } catch { State.sites = []; } return State.sites; }
const siteName = (id) => State.sites.find((s) => s.id === id)?.name || '—';
function fabSet(on, handler) { const f = $('#fab'); f.classList.toggle('hidden', !on); f.onclick = handler || null; }

/* ── ONBOARDING (new company workspace) ──────────────── */
function renderOnboarding(firstTime) {
  $('#tenantPill').classList.add('hidden'); fabSet(false);
  $$('.nav button').forEach((b) => b.classList.remove('active'));
  $('#view').innerHTML = `
    <div class="card" style="margin-top:24px;text-align:center">
      <div style="font-size:40px">🏢</div>
      <h2 style="margin:8px 0 4px">${firstTime ? 'Welcome to Daybook' : 'Create a company'}</h2>
      <p class="muted">Set up a workspace for your business. You'll be its admin and can add sites and managers.</p>
    </div>
    <div class="card">
      <form id="obForm" novalidate>
        <label class="fl">Company name</label>
        <input class="input" id="ob-name" placeholder="e.g. Acme Water"/>
        <div class="err-msg" id="ob-name-e">Company name required</div>
        <label class="fl">Industry (optional)</label>
        <input class="input" id="ob-ind" placeholder="e.g. Water production, Retail…"/>
        <label class="fl">Brand colour</label>
        <input class="input" id="ob-color" type="color" value="#0ea5e9" style="height:48px"/>
        <div style="height:16px"></div>
        <button class="btn" type="submit" id="ob-btn">Create workspace</button>
      </form>
    </div>`;
  $('#obForm').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('#ob-name').value.trim(); if (!name) { setErr('ob-name', true); return; } setErr('ob-name', false);
    const btn = $('#ob-btn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Creating…';
    try {
      const r = await api('/onboard', { method: 'POST', body: { name, industry: $('#ob-ind').value.trim(), brand_color: $('#ob-color').value } });
      State.tenants = r.tenants; State.tenant = r.tenant.id; localStorage.setItem('daybook_tenant', State.tenant);
      toast('Workspace created', 'ok'); applyBrand(); buildTenantSelect(); setupNav();
      $('.nav button[data-tab="admin"]').classList.toggle('hidden', !isGMup()); go('admin');
    } catch (er) { toast(er.message, 'err'); btn.disabled = false; btn.textContent = 'Create workspace'; }
  };
}

/* ── DASHBOARD ───────────────────────────────────────── */
async function viewDashboard() {
  fabSet(false); const v = $('#view');
  v.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel" style="height:200px"></div>`;
  try {
    const d = await api(scoped('/dashboard')); const t = d.totals;
    const scopeLabel = State.tenant ? esc(active().name) : 'All companies';
    v.innerHTML = `
      <div class="section-title">${scopeLabel} · overview</div>
      <div class="stat-grid">
        <div class="stat accent"><div class="k">Total Sales</div><div class="v">${ngn(t.sales)}</div></div>
        <div class="stat"><div class="k">Cash</div><div class="v">${ngn(t.cash)}</div></div>
        <div class="stat"><div class="k">Deposits</div><div class="v">${ngn(t.deposit)}</div></div>
        <div class="stat"><div class="k">Diesel + Costs</div><div class="v" style="color:var(--err)">${ngn(t.costs)}</div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Sales by site</h3><canvas id="cSite" height="190"></canvas></div>
      <div class="card"><h3>Daily sales trend</h3><canvas id="cDay" height="190"></canvas></div>
      <div class="muted" style="text-align:center;font-size:12px">${t.reports} report(s) on record</div>`;
    drawBar('cSite', d.bySite.map((x) => x.site), d.bySite.map((x) => x.sales));
    drawLine('cDay', d.byDay.map((x) => x.day.slice(5)), d.byDay.map((x) => x.sales));
  } catch (e) { v.innerHTML = errBox(e); }
}
const brandColor = () => getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#0ea5e9';
function drawBar(id, labels, data) {
  State.charts[id]?.destroy();
  State.charts[id] = new Chart($('#' + id), { type: 'bar', data: { labels, datasets: [{ data, backgroundColor: brandColor(), borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => '₦' + v / 1000 + 'k' } } } } });
}
function drawLine(id, labels, data) {
  State.charts[id]?.destroy();
  State.charts[id] = new Chart($('#' + id), { type: 'line', data: { labels, datasets: [{ data, borderColor: brandColor(), backgroundColor: brandColor() + '22', fill: true, tension: .35, pointRadius: 2 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => '₦' + v / 1000 + 'k' } } } } });
}

/* ── REPORTS ─────────────────────────────────────────── */
async function viewReports() {
  const v = $('#view');
  fabSet(!!State.tenant, () => reportForm());
  v.innerHTML = `<div class="section-title">Daily reports</div><div class="skel"></div><div class="skel"></div>`;
  try {
    await loadSites();
    const rows = await api(scoped('/reports'));
    let head = `<div class="section-title">Daily reports</div>`;
    if (!State.tenant) head += `<div class="muted" style="margin:0 4px 10px;font-size:13px">Viewing all companies. Pick a workspace to add a report.</div>`;
    if (!rows.length) { v.innerHTML = head + emptyBox('🧾', 'No reports yet', State.tenant ? 'Tap ＋ to record a daily report.' : 'No reports across your companies.'); return; }
    v.innerHTML = head + rows.map(reportCard).join('');
    $$('[data-rep]').forEach((el) => el.onclick = () => openReport(el.dataset.rep));
  } catch (e) { v.innerHTML = errBox(e); }
}
function reportCard(r) {
  return `<div class="card tap" data-rep="${r.id}">
    <div class="row between"><div><div style="font-weight:800">${esc(r.site_name)}</div>
      <div class="muted" style="font-size:13px">${r.report_date}${!State.tenant ? ' · ' + esc(r.tenant_name) : ''}</div></div>
      <span class="badge ${r.status.toLowerCase()}">${r.status}</span></div>
    <div class="row between" style="margin-top:10px">
      <div><div class="muted" style="font-size:11px">SALES</div><div style="font-weight:800;font-size:18px">${ngn(r.total_sales)}</div></div>
      <div style="text-align:right"><div class="muted" style="font-size:11px">BALANCE</div><div style="font-weight:700">${ngn(r.balance)}</div></div></div></div>`;
}
async function openReport(id) {
  try {
    const r = await api('/reports/' + id);
    const sales = (r.sales || []).map((s) => `<div class="row between" style="padding:4px 0"><span>${esc(s.product || s.label)} <span class="muted">×${s.qty ?? ''}</span></span><b>${ngn(s.amount)}</b></div>`).join('') || '<div class="muted">No line items</div>';
    const prod = Object.entries(r.production || {}).map(([k, val]) => `<div class="row between" style="padding:3px 0;font-size:14px"><span class="muted">${esc(k)}</span><span>${esc(String(val))}</span></div>`).join('');
    const b = modal(`
      <div class="stat-grid" style="margin-bottom:12px">
        <div class="stat accent"><div class="k">Total Sales</div><div class="v">${ngn(r.total_sales)}</div></div>
        <div class="stat"><div class="k">Balance</div><div class="v">${ngn(r.balance)}</div></div>
        <div class="stat"><div class="k">Cash</div><div class="v" style="font-size:18px">${ngn(r.total_cash)}</div></div>
        <div class="stat"><div class="k">Deposit</div><div class="v" style="font-size:18px">${ngn(r.total_deposit)}</div></div></div>
      <div class="section-title" style="margin-left:0">Sales</div>${sales}
      ${prod ? `<div class="section-title" style="margin-left:0">Production / Inventory</div>${prod}` : ''}
      ${r.notes ? `<div class="section-title" style="margin-left:0">Notes</div><div class="muted">${esc(r.notes)}</div>` : ''}
      <div style="height:16px"></div>
      <button class="btn ghost sm" id="r-edit" style="width:100%">✎ Edit report</button>
      ${isGMup() ? `<div style="height:8px"></div><button class="btn sm" id="r-email" style="width:100%">✉ Email report to recipients</button>` : ''}`,
      { title: r.site_name || siteName(r.site_id), sub: r.report_date + ' · ' + r.status });
    $('#r-edit', b).onclick = () => { closeModal(); reportForm(r); };
    if (isGMup()) $('#r-email', b).onclick = async (ev) => {
      ev.target.disabled = true; ev.target.innerHTML = '<span class="spin"></span>Sending…';
      try { const res = await api(`/reports/${r.id}/email`, { method: 'POST', body: {} }); toast('Emailed to ' + res.to.length + ' recipient(s)', 'ok'); closeModal(); go('reports'); }
      catch (e) { toast(e.message, 'err'); ev.target.disabled = false; ev.target.textContent = '✉ Email report to recipients'; }
    };
  } catch (e) { toast(e.message, 'err'); }
}
function reportForm(existing) {
  const ex = existing || {};
  const siteOpts = State.sites.map((s) => `<option value="${s.id}" ${ex.site_id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const lines = (ex.sales && ex.sales.length ? ex.sales : [{ product: '', qty: '', amount: '' }]);
  const b = modal(`
    <form id="repForm" novalidate>
      ${isSiteMgr() ? '' : `<label class="fl">Site</label><select class="input" id="rf-site">${siteOpts}</select>`}
      <label class="fl">Report date</label><input class="input" id="rf-date" type="date" value="${ex.report_date || today()}"/>
      <div class="err-msg" id="rf-date-e">Date required</div>
      <div class="section-title" style="margin-left:0">Sales line items</div>
      <div id="rf-lines">${lines.map(lineRow).join('')}</div>
      <button type="button" class="btn ghost sm" id="rf-add">＋ Add item</button>
      <div class="grid2" style="margin-top:8px">
        <div><label class="fl">Total cash</label><input class="input" id="rf-cash" type="number" inputmode="decimal" value="${ex.total_cash || ''}" placeholder="0"/></div>
        <div><label class="fl">Total deposit</label><input class="input" id="rf-deposit" type="number" inputmode="decimal" value="${ex.total_deposit || ''}" placeholder="0"/></div>
        <div><label class="fl">Diesel</label><input class="input" id="rf-diesel" type="number" inputmode="decimal" value="${ex.diesel || ''}" placeholder="0"/></div>
        <div><label class="fl">Other expenses</label><input class="input" id="rf-exp" type="number" inputmode="decimal" value="${ex.expenses || ''}" placeholder="0"/></div>
      </div>
      <div class="section-title" style="margin-left:0">Production / Inventory (optional)</div>
      <div class="grid2">
        <div><label class="fl">Opening bags</label><input class="input pf" data-k="OPENING" type="number" value="${ex.production?.OPENING ?? ''}"/></div>
        <div><label class="fl">Production</label><input class="input pf" data-k="PRODUCTION" type="number" value="${ex.production?.PRODUCTION ?? ''}"/></div>
        <div><label class="fl">Sales (bags)</label><input class="input pf" data-k="SALES" type="number" value="${ex.production?.SALES ?? ''}"/></div>
        <div><label class="fl">Leakage</label><input class="input pf" data-k="LEAKAGE" type="number" value="${ex.production?.LEAKAGE ?? ''}"/></div>
        <div><label class="fl">Available</label><input class="input pf" data-k="AVAILABLE" type="number" value="${ex.production?.AVAILABLE ?? ''}"/></div>
      </div>
      <label class="fl">Notes / incidents</label>
      <textarea class="input" id="rf-notes" rows="3" placeholder="Anything notable today…">${esc(ex.notes || '')}</textarea>
      <div class="card" style="margin:14px 0 6px;background:var(--brand-l);border:none">
        <div class="row between"><b>Computed total sales</b><b id="rf-total" style="font-size:18px">${ngn(ex.total_sales || 0)}</b></div></div>
      <div class="grid2"><button type="button" class="btn ghost" id="rf-draft">Save draft</button>
        <button type="submit" class="btn" id="rf-submit">Submit</button></div>
    </form>`, { title: existing ? 'Edit report' : 'New daily report', sub: active()?.name });
  const recalc = () => { const sum = $$('#rf-lines .line', b).reduce((a, l) => a + (+$('.l-amt', l).value || 0), 0); $('#rf-total', b).textContent = ngn(sum); };
  function bindLines() { $$('#rf-lines .line', b).forEach((l) => { $('.l-amt', l).oninput = recalc; $('.x', l).onclick = () => { l.remove(); recalc(); }; }); }
  $('#rf-add', b).onclick = () => { const d = document.createElement('div'); d.innerHTML = lineRow({}); $('#rf-lines', b).appendChild(d.firstElementChild); bindLines(); };
  bindLines();
  async function save(submit) {
    const date = $('#rf-date', b).value; if (!date) { setErr('rf-date', true); return; }
    const site_id = isSiteMgr() ? active().site_id : $('#rf-site', b).value;
    const sales = $$('#rf-lines .line', b).map((l) => ({ product: $('.l-prod', l).value.trim(), qty: +$('.l-qty', l).value || 0, amount: +$('.l-amt', l).value || 0 })).filter((s) => s.product || s.amount);
    const production = {}; $$('.pf', b).forEach((i) => { if (i.value !== '') production[i.dataset.k] = +i.value; });
    const payload = { tenant_id: State.tenant, site_id, report_date: date, total_cash: +$('#rf-cash', b).value || 0, total_deposit: +$('#rf-deposit', b).value || 0,
      diesel: +$('#rf-diesel', b).value || 0, expenses: +$('#rf-exp', b).value || 0, sales, production, notes: $('#rf-notes', b).value.trim(), submit };
    const btn = submit ? $('#rf-submit', b) : $('#rf-draft', b); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Saving…';
    try { await api('/reports', { method: 'POST', body: payload }); toast(submit ? 'Report submitted' : 'Draft saved', 'ok'); closeModal(); go('reports'); }
    catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = submit ? 'Submit' : 'Save draft'; }
  }
  $('#rf-draft', b).onclick = () => save(false);
  $('#repForm', b).onsubmit = (e) => { e.preventDefault(); save(true); };
}
function lineRow(s = {}) {
  return `<div class="line"><input class="input l-prod" placeholder="Product" value="${esc(s.product || '')}"/>
    <input class="input l-qty" type="number" inputmode="numeric" placeholder="Qty" value="${s.qty ?? ''}"/>
    <input class="input l-amt" type="number" inputmode="decimal" placeholder="Amount" value="${s.amount ?? ''}"/>
    <button type="button" class="x">×</button></div>`;
}

/* ── DOCUMENTS ───────────────────────────────────────── */
const CATS = [['DAILY_REPORT', 'Daily report'], ['CORRESPONDENCE', 'Correspondence'], ['LEGAL', 'Legal'], ['INVENTORY', 'Inventory / receipts'], ['INCIDENT', 'Incident / issue'], ['OTHER', 'Other']];
const catLabel = (c) => (CATS.find((x) => x[0] === c) || [, c])[1];
const catIcon = (c) => ({ DAILY_REPORT: '🧾', CORRESPONDENCE: '✉️', LEGAL: '⚖️', INVENTORY: '📦', INCIDENT: '⚠️', OTHER: '📄' }[c] || '📄');
let docFilter = '';
async function viewDocuments() {
  const v = $('#view'); fabSet(!!State.tenant, () => docForm());
  v.innerHTML = `<div class="section-title">Documents</div>
    <select class="input" id="docCat" style="margin-bottom:12px"><option value="">All categories</option>${CATS.map((c) => `<option value="${c[0]}" ${docFilter === c[0] ? 'selected' : ''}>${c[1]}</option>`).join('')}</select>
    <div class="skel"></div><div class="skel"></div>`;
  $('#docCat').onchange = (e) => { docFilter = e.target.value; viewDocuments(); };
  try {
    await loadSites();
    const docs = await api(scoped('/documents' + (docFilter ? '?category=' + docFilter : '')));
    v.querySelectorAll('.skel').forEach((s) => s.remove());
    v.insertAdjacentHTML('beforeend', docs.length ? docs.map(docCard).join('') : emptyBox('📁', 'No documents', State.tenant ? 'Tap ＋ to upload files.' : 'Pick a workspace to upload.'));
    $$('[data-doc]').forEach((el) => el.onclick = () => window.open('/api/documents/' + el.dataset.doc + '/download', '_blank'));
    $$('[data-del]').forEach((el) => el.onclick = (e) => { e.stopPropagation(); delDoc(el.dataset.del); });
  } catch (e) { v.insertAdjacentHTML('beforeend', errBox(e)); }
}
function docCard(d) {
  const kb = d.size ? (d.size / 1024).toFixed(0) + ' KB' : '';
  return `<div class="card tap" data-doc="${d.id}" style="padding:12px"><div class="list-item" style="border:none;padding:0">
    <div class="av">${catIcon(d.category)}</div>
    <div class="meta"><div class="t">${esc(d.title || d.file_name)}</div>
      <div class="s"><span class="pill-cat">${catLabel(d.category)}</span> ${d.site_name ? '· ' + esc(d.site_name) : ''} ${kb ? '· ' + kb : ''}</div></div>
    ${isGMup() ? `<button class="x" data-del="${d.id}" style="background:#fee2e2;color:var(--err);border:none;width:34px;height:34px;border-radius:9px">🗑</button>` : ''}</div></div>`;
}
function docForm() {
  const siteOpts = State.sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const b = modal(`
    <form id="docForm" novalidate>
      <label class="fl">Files (Excel, PDF, image, Word…)</label>
      <input class="input" id="df-files" type="file" multiple accept=".xls,.xlsx,.csv,.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.txt,.heic"/>
      <div class="err-msg" id="df-files-e">Choose at least one file</div>
      <label class="fl">Category</label><select class="input" id="df-cat">${CATS.map((c) => `<option value="${c[0]}">${c[1]}</option>`).join('')}</select>
      ${isSiteMgr() ? '' : `<label class="fl">Site (optional)</label><select class="input" id="df-site"><option value="">— none —</option>${siteOpts}</select>`}
      <label class="fl">Title (optional)</label><input class="input" id="df-title" placeholder="e.g. Moniepoint receipt"/>
      <label class="fl">Description (optional)</label><textarea class="input" id="df-desc" rows="2"></textarea>
      <div style="height:16px"></div><button class="btn" id="df-btn" type="submit">Upload</button>
    </form>`, { title: 'Upload documents', sub: 'Correspondence, legal, receipts, incidents…' });
  $('#docForm', b).onsubmit = async (e) => {
    e.preventDefault(); const files = $('#df-files', b).files;
    if (!files.length) { setErr('df-files', true); return; } setErr('df-files', false);
    const fd = new FormData(); [...files].forEach((f) => fd.append('files', f));
    fd.append('tenant_id', State.tenant); fd.append('category', $('#df-cat', b).value);
    if (!isSiteMgr()) fd.append('site_id', $('#df-site', b).value || '');
    fd.append('title', $('#df-title', b).value); fd.append('description', $('#df-desc', b).value);
    const btn = $('#df-btn', b); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Uploading…';
    try { await api('/documents', { method: 'POST', form: fd }); toast('Uploaded ' + files.length + ' file(s)', 'ok'); closeModal(); viewDocuments(); }
    catch (er) { toast(er.message, 'err'); btn.disabled = false; btn.textContent = 'Upload'; }
  };
}
function delDoc(id) { confirmModal('Delete document?', 'This removes the file permanently.', async () => { try { await api('/documents/' + id, { method: 'DELETE' }); toast('Deleted', 'ok'); viewDocuments(); } catch (e) { toast(e.message, 'err'); } }); }

/* ── ADMIN ───────────────────────────────────────────── */
async function viewAdmin() {
  fabSet(false); const v = $('#view');
  if (!State.tenant) { v.innerHTML = `<div class="section-title">Administration</div>` + emptyBox('🏢', 'Pick a workspace', 'Choose a company at the top to manage it.') + (State.user.is_superadmin ? `<button class="btn" id="newco">＋ Create a company</button>` : ''); if ($('#newco')) $('#newco').onclick = () => renderOnboarding(false); return; }
  const adminRow = (id, ic, t, s) => `<div class="card tap" id="${id}"><div class="list-item" style="border:none;padding:0"><div class="av">${ic}</div><div class="meta"><div class="t">${t}</div><div class="s">${s}</div></div><span>›</span></div></div>`;
  v.innerHTML = `<div class="section-title">${esc(active().name)} · administration</div>
    ${adminRow('a-sites', '📍', 'Sites', 'Manage locations')}
    ${isAdmin() ? adminRow('a-members', '👤', 'People', 'Admins, managers & site managers') : ''}
    ${adminRow('a-recips', '✉️', 'Report recipients', 'Daily report email list')}
    ${isAdmin() ? adminRow('a-settings', '🎨', 'Workspace settings', 'Name & branding') : ''}
    ${State.user.is_superadmin ? adminRow('a-newco', '🏢', 'Create a company', 'Add another workspace') : ''}
    <div class="card" style="margin-top:10px"><div class="row between"><div><b>Signed in</b><div class="muted" style="font-size:13px">${esc(State.user.email)}${State.user.is_superadmin ? ' · Superadmin' : ' · ' + ROLE_LABEL[myRole()]}</div></div></div></div>`;
  $('#a-sites').onclick = adminSites; $('#a-recips').onclick = adminRecipients;
  if ($('#a-members')) $('#a-members').onclick = adminMembers;
  if ($('#a-settings')) $('#a-settings').onclick = adminSettings;
  if ($('#a-newco')) $('#a-newco').onclick = () => renderOnboarding(false);
}
async function adminSites() {
  await loadSites();
  const b = modal(`<div>${State.sites.map((s) => `<div class="list-item"><div class="av">📍</div><div class="meta"><div class="t">${esc(s.name)} ${s.is_hq ? '<span class="pill-cat">HQ</span>' : ''}</div><div class="s">${esc(s.code)} · ${s.status}</div></div></div>`).join('') || '<div class="muted">No sites</div>'}</div>
    ${isAdmin() ? `<div style="height:12px"></div><button class="btn" id="addSite">＋ Add site</button>` : ''}`, { title: 'Sites', sub: active().name });
  if ($('#addSite', b)) $('#addSite', b).onclick = () => {
    const f = modal(`<form id="sf"><label class="fl">Code</label><input class="input" id="s-code" placeholder="E.g. SWALI"/>
      <label class="fl">Name</label><input class="input" id="s-name" placeholder="Swali"/>
      <label class="fl">Address</label><input class="input" id="s-addr"/>
      <label class="fl row"><input type="checkbox" id="s-hq" style="width:auto;margin-right:8px"/> Headquarters</label>
      <div style="height:14px"></div><button class="btn" type="submit">Create site</button></form>`, { title: 'New site' });
    $('#sf', f).onsubmit = async (e) => { e.preventDefault();
      try { await api('/sites?tenant=' + State.tenant, { method: 'POST', body: { tenant_id: State.tenant, code: $('#s-code', f).value.trim(), name: $('#s-name', f).value.trim(), address: $('#s-addr', f).value.trim(), is_hq: $('#s-hq', f).checked } }); toast('Site added', 'ok'); closeModal(); }
      catch (er) { toast(er.message, 'err'); } };
  };
}
async function adminMembers() {
  await loadSites();
  const data = await api(scoped('/members'));
  const memHtml = data.members.map((m) => `<div class="list-item"><div class="av">👤</div><div class="meta"><div class="t">${esc(m.name || m.email)}</div>
    <div class="s">${esc(m.email)} · ${ROLE_LABEL[m.role]}${m.site_id ? ' · ' + esc(siteName(m.site_id)) : ''}${m.active_login ? '' : ' · <i>pending sign-in</i>'}</div></div>
    <button class="x" data-rmm="${m.id}" style="background:#fee2e2;color:var(--err);border:none;width:34px;height:34px;border-radius:9px">×</button></div>`).join('');
  const invHtml = data.invites.map((i) => `<div class="list-item"><div class="av">✉️</div><div class="meta"><div class="t">${esc(i.email)}</div><div class="s">Invited · ${ROLE_LABEL[i.role]}${i.site_id ? ' · ' + esc(siteName(i.site_id)) : ''}</div></div>
    <button class="x" data-rmi="${i.id}" style="background:#fef3c7;color:#92400e;border:none;width:34px;height:34px;border-radius:9px">×</button></div>`).join('');
  const b = modal(`<div>${memHtml || '<div class="muted">No members</div>'}${invHtml}</div>
    <div style="height:12px"></div><button class="btn" id="addMember">＋ Add person</button>`, { title: 'People', sub: active().name });
  $$('[data-rmm]', b).forEach((el) => el.onclick = () => confirmModal('Remove member?', '', async () => { try { await api('/members/' + el.dataset.rmm + '?tenant=' + State.tenant, { method: 'DELETE' }); toast('Removed', 'ok'); adminMembers(); } catch (e) { toast(e.message, 'err'); } }));
  $$('[data-rmi]', b).forEach((el) => el.onclick = async () => { try { await api('/invites/' + el.dataset.rmi + '?tenant=' + State.tenant, { method: 'DELETE' }); toast('Invite cancelled', 'ok'); adminMembers(); } catch (e) { toast(e.message, 'err'); } });
  $('#addMember', b).onclick = () => {
    const siteOpts = State.sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    const f = modal(`<form id="mf">
      <label class="fl">Google email</label><input class="input" id="m-email" type="email" placeholder="person@gmail.com"/><div class="err-msg" id="m-email-e">Valid email required</div>
      <label class="fl">Role</label><select class="input" id="m-role"><option value="SITE_MANAGER">Site Manager (one site)</option><option value="GENERAL_MANAGER">General Manager (all sites)</option><option value="ADMIN">Admin (full control)</option></select>
      <div id="m-sitewrap"><label class="fl">Site</label><select class="input" id="m-site">${siteOpts}</select></div>
      <div style="height:14px"></div><button class="btn" type="submit">Add person</button>
      <p class="muted" style="font-size:12px;margin-top:10px">They sign in with this Google account to get access. Unknown emails are held as a pending invite until first sign-in.</p>
    </form>`, { title: 'Add person', sub: active().name });
    $('#m-role', f).onchange = (e) => $('#m-sitewrap', f).style.display = e.target.value === 'SITE_MANAGER' ? '' : 'none';
    $('#mf', f).onsubmit = async (e) => { e.preventDefault();
      const email = $('#m-email', f).value.trim(); if (!isEmail(email)) { setErr('m-email', true); return; } setErr('m-email', false);
      const role = $('#m-role', f).value;
      try { const r = await api('/members?tenant=' + State.tenant, { method: 'POST', body: { tenant_id: State.tenant, email, role, site_id: role === 'SITE_MANAGER' ? $('#m-site', f).value : null } });
        toast(r.invited ? 'Invite sent — they get access on sign-in' : 'Member added', 'ok'); closeModal(); adminMembers(); }
      catch (er) { toast(er.message, 'err'); } };
  };
}
async function adminRecipients() {
  const recs = await api(scoped('/recipients'));
  const canEdit = isAdmin();
  const b = modal(`<div>${recs.map((r) => `<div class="list-item"><div class="av">✉️</div><div class="meta"><div class="t">${esc(r.email)}</div><div class="s">${esc(r.name || '')}</div></div>${canEdit ? `<button class="x" data-rid="${r.id}" style="background:#fee2e2;color:var(--err);border:none;width:34px;height:34px;border-radius:9px">×</button>` : ''}</div>`).join('') || '<div class="muted">No recipients</div>'}</div>
    ${canEdit ? `<form id="rf2" style="margin-top:12px"><label class="fl">Add recipient email</label><input class="input" id="r-email" type="email" placeholder="name@company.com"/><div class="err-msg" id="r-email-e">Valid email required</div><div style="height:10px"></div><button class="btn" type="submit">Add recipient</button></form>` : ''}`,
    { title: 'Daily report recipients', sub: 'Who receives submitted reports' });
  $$('[data-rid]', b).forEach((el) => el.onclick = async () => { try { await api('/recipients/' + el.dataset.rid + '?tenant=' + State.tenant, { method: 'DELETE' }); toast('Removed', 'ok'); adminRecipients(); } catch (e) { toast(e.message, 'err'); } });
  if ($('#rf2', b)) $('#rf2', b).onsubmit = async (e) => { e.preventDefault(); const email = $('#r-email', b).value.trim(); if (!isEmail(email)) { setErr('r-email', true); return; } setErr('r-email', false);
    try { await api('/recipients?tenant=' + State.tenant, { method: 'POST', body: { tenant_id: State.tenant, email } }); toast('Added', 'ok'); adminRecipients(); } catch (er) { toast(er.message, 'err'); } };
}
async function adminSettings() {
  const t = active();
  const f = modal(`<form id="tf"><label class="fl">Company name</label><input class="input" id="t-name" value="${esc(t.name)}"/>
    <label class="fl">Brand colour</label><input class="input" id="t-color" type="color" value="${t.brand_color || '#0ea5e9'}" style="height:48px"/>
    <div style="height:14px"></div><button class="btn" type="submit">Save</button></form>`, { title: 'Workspace settings', sub: t.name });
  $('#tf', f).onsubmit = async (e) => { e.preventDefault();
    try { await api('/tenants/' + State.tenant, { method: 'PATCH', body: { name: $('#t-name', f).value.trim(), brand_color: $('#t-color', f).value } });
      toast('Saved', 'ok'); closeModal(); await boot(); go('admin'); } catch (er) { toast(er.message, 'err'); } };
}

/* ── shared bits ─────────────────────────────────────── */
function confirmModal(title, sub, onYes) {
  const b = modal(`<div class="grid2"><button class="btn ghost" id="cm-no">Cancel</button><button class="btn danger" id="cm-yes">Confirm</button></div>`, { title, sub });
  $('#cm-no', b).onclick = closeModal; $('#cm-yes', b).onclick = () => { closeModal(); onYes(); };
}
const emptyBox = (ic, t, s) => `<div class="empty"><div class="ic">${ic}</div><h3 style="margin:8px 0 4px">${esc(t)}</h3><p>${esc(s)}</p></div>`;
const errBox = (e) => `<div class="empty"><div class="ic">⚠️</div><h3>Something went wrong</h3><p>${esc(e.message)}</p></div>`;

/* ── AI ASSISTANT ────────────────────────────────────── */
let aiHistory = [];
function mountAssistant() {
  if ($('#aiFab')) return;
  const b = document.createElement('button');
  b.id = 'aiFab'; b.className = 'fab ai'; b.title = 'Ask Daybook AI'; b.textContent = '✨';
  b.onclick = openAssistant;
  $('#app').appendChild(b);
}
async function openAssistant() {
  const greeting = aiHistory.length ? '' : `<div class="bub sys">Ask me about ${esc(active()?.name || 'your companies')}'s sales, balances, trends, or which site to look at. I read your live report data.</div>`;
  const body = modal(`
    <div class="chat" id="aiChat">${greeting}${aiHistory.map(renderBub).join('')}</div>
    <div class="chat-input">
      <textarea class="input" id="aiInput" rows="1" placeholder="e.g. Which site had the best week?"></textarea>
      <button class="btn" id="aiSend" style="width:auto;padding:13px 16px">➤</button>
    </div>`, { title: '✨ Daybook Assistant', sub: active() ? `${active().name} · ${ROLE_LABEL[myRole()]}` : 'All companies' });
  const chat = $('#aiChat', body), input = $('#aiInput', body), send = $('#aiSend', body);
  chat.scrollTop = chat.scrollHeight;
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
  input.oninput = grow;
  const submit = async () => {
    const q = input.value.trim(); if (!q) return;
    input.value = ''; grow();
    aiHistory.push({ role: 'user', content: q });
    chat.insertAdjacentHTML('beforeend', renderBub({ role: 'user', content: q }));
    const typing = document.createElement('div'); typing.className = 'bub a'; typing.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    chat.appendChild(typing); chat.scrollTop = chat.scrollHeight; send.disabled = true;
    try {
      const r = await api('/ai/chat', { method: 'POST', body: { message: q, history: aiHistory.slice(0, -1) } });
      typing.remove();
      aiHistory.push({ role: 'assistant', content: r.reply });
      chat.insertAdjacentHTML('beforeend', renderBub({ role: 'assistant', content: r.reply }));
    } catch (e) {
      typing.remove();
      const msg = e.message && e.message.includes('not configured')
        ? 'AI isn\'t switched on yet — add an Anthropic API key (AI_API_KEY) on the server to enable it.' : e.message;
      chat.insertAdjacentHTML('beforeend', `<div class="bub sys">${esc(msg)}</div>`);
    } finally { send.disabled = false; chat.scrollTop = chat.scrollHeight; input.focus(); }
  };
  send.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
  setTimeout(() => input.focus(), 100);
}
const renderBub = (m) => `<div class="bub ${m.role === 'user' ? 'u' : 'a'}">${esc(m.content)}</div>`;

/* ── start ───────────────────────────────────────────── */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
initGoogle();
if (State.token) boot().catch(() => logout());
