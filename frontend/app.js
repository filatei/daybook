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
const posOn = () => !!(active() && active().pos);   // external fido POS (Fido/Fiafia)
const internalPos = () => !!(active() && !active().pos);  // self-contained tenants → in-app POS
function updateTabs() {
  $('.nav button[data-tab="admin"]').classList.toggle('hidden', !isGMup());
  $('.nav button[data-tab="sell"]').classList.toggle('hidden', !internalPos());
}
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

/* ── Offline-first (cache + sale outbox that syncs on reconnect) ──────────── */
State.online = navigator.onLine;
const uuidv4 = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxxxxxx4xxxyxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const lsGet = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };
const outbox = () => lsGet('daybook_outbox', []);
const setOutbox = (a) => { localStorage.setItem('daybook_outbox', JSON.stringify(a)); updatePill(); };
const queueSale = (tenant, payload) => { const o = outbox(); o.push({ tenant, payload }); setOutbox(o); };
const isNetErr = (e) => !navigator.onLine || /failed to fetch|networkerror|load failed|fetch failed/i.test(e && e.message || '');
function updatePill() {
  const n = outbox().length, show = (!State.online || n > 0) && State.token;
  let pill = $('#offlinePill');
  if (!show) { if (pill) pill.remove(); return; }
  if (!pill) { pill = document.createElement('div'); pill.id = 'offlinePill'; pill.className = 'offline-pill'; document.body.appendChild(pill); }
  pill.textContent = State.online ? `↻ syncing ${n}…` : (n ? `⚡ offline · ${n} queued` : '⚡ offline');
}
async function syncOutbox() {
  if (!State.token || !State.online) return;
  const o = outbox(); if (!o.length) { updatePill(); return; }
  const remain = [];
  for (const it of o) {
    try { await api('/pos/sales?tenant=' + it.tenant, { method: 'POST', body: it.payload }); }
    catch (e) { remain.push(it); }   // still offline / failed → keep for next pass
  }
  const synced = o.length - remain.length; setOutbox(remain);
  if (synced > 0) { toast(`Synced ${synced} offline sale(s)`, 'ok'); if (State.tab === 'sell') viewSell(); }
}
window.addEventListener('online', () => { State.online = true; updatePill(); syncOutbox(); syncChatOutbox(); });
window.addEventListener('offline', () => { State.online = false; updatePill(); });
setInterval(() => { if (State.online) { syncOutbox(); syncChatOutbox(); } }, 30000);

/* ── Toast / Modal / Validation (shared) ─────────────── */
function toast(msg, kind = 'info', ms = 3200) {
  const el = document.createElement('div'); const ic = { ok: '✓', err: '⚠', info: 'ℹ' }[kind] || 'ℹ';
  el.className = `toast ${kind}`; el.innerHTML = `<span class="ti">${ic}</span><span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el); setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}
let modalOpen = false;
function modal(html, { title, sub } = {}) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-bg"><div class="modal"><div class="grip"></div>
    <button class="modal-x" id="modalX" aria-label="Close" title="Close">✕</button>
    ${title ? `<h3>${esc(title)}</h3>` : ''}${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
    <div id="modalBody">${html}</div></div></div>`;
  const bg = $('.modal-bg', root); bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
  $('#modalX', root).addEventListener('click', () => closeModal());
  // Push one history entry for the modal layer so the phone Back button closes it
  // (instead of leaving the app). Reuse the entry when replacing one modal with another.
  if (!(history.state && history.state.dbkModal)) history.pushState({ dbkModal: true }, '');
  modalOpen = true;
  return $('#modalBody', root);
}
// Closing never touches history (so "close then open another modal" works). A
// leftover modal history entry is harmlessly consumed by the next Back press.
function closeModal() {
  if (!modalOpen) return;
  if (typeof stopCam === 'function') stopCam();          // release camera if an attendance capture was open
  modalOpen = false;
  const m = $('.modal', $('#modalRoot'));
  if (m) { m.style.animation = 'sheet .25s reverse'; setTimeout(() => { if (!modalOpen) $('#modalRoot').innerHTML = ''; }, 220); }
}
// Phone/browser Back: close an open modal first; otherwise keep the user in the
// app (route to dashboard) rather than letting Back exit the PWA.
window.addEventListener('popstate', () => {
  if (modalOpen) { closeModal(); return; }
  if (State.token && !$('#app').classList.contains('hidden')) {
    if (State.tab && State.tab !== 'dashboard') go('dashboard');
    history.pushState({ dbkAnchor: true }, '');               // re-anchor so Back never exits the app
  }
});
function setErr(id, show) { const i = $('#' + id), e = $('#' + id + '-e'); if (i) i.classList.toggle('err', show); if (e) e.classList.toggle('show', show); }
// Attach a debounced suggestion dropdown to a text input. kind = 'staff' | 'customers'.
// Fido/Fiafia draw from the live fido directory; other companies from their own records.
function attachTypeahead(input, kind, onPick) {
  if (!input) return;
  const wrap = document.createElement('div'); wrap.className = 'ta';
  input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
  const list = document.createElement('div'); list.className = 'ta-list hidden'; wrap.appendChild(list);
  const close = () => { list.classList.add('hidden'); list.innerHTML = ''; };
  let timer, lastQ = '';
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => {
    const q = input.value.trim(); clearTimeout(timer);
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      if (q === lastQ) return; lastQ = q;
      try {
        const items = await api(scoped('/suggest/' + kind + '?q=' + encodeURIComponent(q)));
        if (!items.length) { close(); return; }
        list.innerHTML = items.map((it, i) => `<button type="button" class="ta-item" data-i="${i}">${esc(it.name)}${it.phone ? ` · <span class="muted">${esc(it.phone)}</span>` : it.role ? ` · <span class="muted">${esc(it.role)}</span>` : ''}</button>`).join('');
        list.classList.remove('hidden');
        $$('.ta-item', list).forEach((el) => el.onclick = () => { const it = items[+el.dataset.i]; input.value = it.name; close(); if (onPick) onPick(it); });
      } catch { close(); }
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(close, 180));
}
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
  clearInterval(State.notifTimer); clearInterval(ChatUI.timer); ChatUI.open = false;
  ['#chatBtn', '#bellBtn'].forEach((s) => { const b = $(s); if (b) b.classList.add('hidden'); });
  const bb = $('#bellBadge'); if (bb) bb.classList.add('hidden');
  $('#app').classList.add('hidden'); $('#login').classList.remove('hidden');
}

/* ── Boot ────────────────────────────────────────────── */
async function boot() {
  let me;
  try { me = await api('/auth/me'); localStorage.setItem('daybook_me', JSON.stringify(me)); State.online = true; }
  catch (e) {
    const cached = lsGet('daybook_me', null);
    if (cached && State.token) { me = cached; State.online = false; toast('Offline — working from cached data', 'info', 4000); }
    else throw e;
  }
  State.user = me.user; State.tenants = me.tenants;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  if (!State.tenants.length) { renderOnboarding(true); return; }
  if (!State.tenant || !State.tenants.find((t) => t.id === State.tenant)) State.tenant = State.tenants[0].id;
  localStorage.setItem('daybook_tenant', State.tenant || '');
  applyBrand(); buildTenantSelect(); setupNav();
  updateTabs(); mountAssistant(); mountChat(); mountNotifications(); updatePill();
  syncOutbox(); syncChatOutbox(); pollNotifs();
  go(!State.online && internalPos() ? 'sell' : 'dashboard');  // offline → straight to selling
  history.pushState({ dbkAnchor: true }, '');                 // extra entry so Back has something to pop (stays in app)
  handlePaymentReturn();                                      // confirm a Paystack return, if any
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
  sel.onchange = () => { State.tenant = sel.value || null; localStorage.setItem('daybook_tenant', State.tenant || ''); applyBrand(); updateTabs(); go(State.tab); };
}
function setupNav() { $$('.nav button').forEach((b) => b.onclick = () => go(b.dataset.tab)); }
function go(tab) {
  State.tab = tab; $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ({ dashboard: viewDashboard, sell: viewSell, reports: viewReports, staff: viewStaff, documents: viewDocuments, admin: viewAdmin }[tab] || viewDashboard)();
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
      ${trialBanner()}
      <div class="section-title">${scopeLabel} · overview</div>
      <div class="stat-grid">
        <div class="stat accent"><div class="k">Total Sales</div><div class="v">${ngn(t.sales)}</div></div>
        <div class="stat"><div class="k">Cash</div><div class="v">${ngn(t.cash)}</div></div>
        <div class="stat"><div class="k">Deposits</div><div class="v">${ngn(t.deposit)}</div></div>
        <div class="stat"><div class="k">Diesel + Costs</div><div class="v" style="color:var(--err)">${ngn(t.costs)}</div></div>
      </div>
      ${posOn() ? `<div class="card" style="margin-top:14px">
        <div class="row between" style="margin-bottom:8px"><h3 style="margin:0">⚡ Live POS sales</h3>
          <input class="input" id="posDate" type="date" value="${today()}" style="width:auto;padding:8px 10px"/></div>
        <div id="posList"><div class="skel"></div></div></div>` : ''}
      ${State.tenant ? `<div class="card tap" id="genCard" style="margin-top:14px"><div class="list-item" style="border:none;padding:0"><div class="av">🔌</div><div class="meta"><div class="t">Generators</div><div class="s">Diesel & maintenance logs</div></div><span>›</span></div></div>` : ''}
      <div class="card" style="margin-top:14px"><h3>Sales by site</h3><canvas id="cSite" height="190"></canvas></div>
      <div class="card"><h3>Daily sales trend</h3><canvas id="cDay" height="190"></canvas></div>
      <div class="muted" style="text-align:center;font-size:12px">${t.reports} report(s) on record</div>
      ${State.tenant ? `<div style="text-align:center;margin:14px 0 4px"><button class="btn ghost" id="dashIdea" style="width:auto;padding:9px 16px">💡 Suggest a feature</button></div>` : ''}`;
    if ($('#dashIdea')) $('#dashIdea').onclick = () => openFeatureForm();
    if ($('#genCard')) $('#genCard').onclick = manageGenerators;
    drawBar('cSite', d.bySite.map((x) => x.site), d.bySite.map((x) => x.sales));
    drawLine('cDay', d.byDay.map((x) => x.day.slice(5)), d.byDay.map((x) => x.sales));
    if ($('#posDate')) { $('#posDate').onchange = loadPosSales; loadPosSales(); }
  } catch (e) { v.innerHTML = errBox(e); }
}
async function loadPosSales() {
  const list = $('#posList'); if (!list) return; list.innerHTML = '<div class="skel"></div>';
  const date = $('#posDate').value;
  try {
    const d = await api(scoped('/sales/by-date?date=' + date));
    if (!d.rows.length) { list.innerHTML = `<div class="muted" style="padding:10px 2px">No POS sales for ${date}</div>`; return; }
    list.innerHTML = d.rows.map((r) => `<div class="row between" style="padding:7px 2px;border-bottom:1px solid var(--line)">
        <span>${esc(r.group)}</span><span><b>${ngn(r.amount)}</b> <span class="muted" style="font-size:12px">· ${r.orders}</span></span></div>`).join('')
      + `<div class="row between" style="padding:9px 2px 0"><b>Total</b><b style="color:var(--brand-d)">${ngn(d.total)}</b></div>`;
  } catch (e) { list.innerHTML = `<div class="muted" style="padding:10px 2px">${esc(e.message.includes('not configured') ? 'Sales DB not connected' : e.message)}</div>`; }
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
      <div style="height:8px"></div><button class="btn ghost sm" id="r-analyse" style="width:100%;color:#5b21b6;border-color:#ddd6fe">✨ AI analyse this day</button>
      ${isGMup() ? `<div style="height:8px"></div><button class="btn sm" id="r-email" style="width:100%">✉ Email report to recipients</button>` : ''}
      ${(r.created_by === State.user.id || isGMup()) ? `<div style="height:8px"></div><button class="btn ghost sm" id="r-del" style="width:100%;color:var(--err);border-color:#fecaca">🗑 Delete report</button>` : ''}`,
      { title: r.site_name || siteName(r.site_id), sub: r.report_date + ' · ' + r.status });
    $('#r-edit', b).onclick = () => { closeModal(); reportForm(r); };
    if ($('#r-del', b)) $('#r-del', b).onclick = () => confirmModal('Delete this report?', `${r.site_name || siteName(r.site_id)} · ${r.report_date}. This can’t be undone.`, async () => {
      try { await api('/reports/' + r.id, { method: 'DELETE' }); toast('Report deleted', 'ok'); closeModal(); go('reports'); }
      catch (e) { toast(e.message, 'err'); }
    });
    $('#r-analyse', b).onclick = async (ev) => {
      ev.target.disabled = true; ev.target.innerHTML = '<span class="spin"></span>Analysing…';
      try { const a = await api('/ai/analyse', { method: 'POST', body: { site: r.site_id, date: r.report_date } });
        modal(`<div class="bub a" style="max-width:100%">${esc(a.reply)}</div>`, { title: '✨ Analysis', sub: `${r.site_name || siteName(r.site_id)} · ${r.report_date}` }); }
      catch (e) { toast(e.message.includes('not configured') ? 'AI not switched on yet' : e.message, 'err'); ev.target.disabled = false; ev.target.innerHTML = '✨ AI analyse this day'; }
    };
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
      ${posOn() ? `<button type="button" class="btn ghost sm" id="rf-pull" style="width:100%;margin-top:10px;color:#5b21b6;border-color:#ddd6fe">⤓ Pull from sales DB</button>` : ''}
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
  if ($('#rf-pull', b)) $('#rf-pull', b).onclick = async () => {
    const date = $('#rf-date', b).value;
    const site_id = isSiteMgr() ? active().site_id : ($('#rf-site', b) && $('#rf-site', b).value);
    if (!date || !site_id) { toast('Pick a site and date first', 'err'); return; }
    const btn = $('#rf-pull', b); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Pulling…';
    try {
      const r = await api(`/sales/preview?site=${site_id}&date=${date}`);
      const lines = (r.sales.lines || []).length ? r.sales.lines : [{ product: '', qty: '', amount: '' }];
      $('#rf-lines', b).innerHTML = lines.map((l) => lineRow({ product: l.product, qty: Math.round(l.qty || 0), amount: Math.round(l.amount || 0) })).join('');
      bindLines();
      $('#rf-cash', b).value = Math.round(r.sales.total_cash || 0);
      $('#rf-deposit', b).value = Math.round(r.sales.total_deposit || 0);
      if (r.expenses && r.expenses.total) $('#rf-exp', b).value = Math.round(r.expenses.total);
      recalc();
      const pm = (r.sales.payments || []).map((p) => `${p.method} ${ngn(p.amount)}`).join(' · ');
      toast(`Pulled ${r.sales.orders} orders · ${ngn(r.sales.total)}`, 'ok', 4500);
      if (pm) $('#rf-notes', b).value = (($('#rf-notes', b).value || '').trim() + `\n[POS ${date}] ${pm}`).trim();
    } catch (e) { toast(e.message.includes('not configured') ? 'Sales DB not connected yet' : e.message, 'err'); }
    finally { btn.disabled = false; btn.innerHTML = '⤓ Pull from sales DB'; }
  };
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
    ${posOn() ? adminRow('a-payroll', '💵', 'Payroll', 'Staff pay (from POS)') : ''}
    ${isAdmin() ? adminRow('a-settings', '🎨', 'Workspace settings', 'Name & branding') : ''}
    ${isAdmin() && active().plan !== 'OWNER' ? adminRow('a-billing', '💳', 'Subscription', 'Plan & billing') : ''}
    ${adminRow('a-ideas', '💡', 'Feature requests', 'Suggest & track improvements')}
    ${State.user.is_superadmin ? adminRow('a-newco', '🏢', 'Create a company', 'Add another workspace') : ''}
    <div class="card" style="margin-top:10px"><div class="row between"><div><b>Signed in</b><div class="muted" style="font-size:13px">${esc(State.user.email)}${State.user.is_superadmin ? ' · Superadmin' : ' · ' + ROLE_LABEL[myRole()]}</div></div></div></div>`;
  $('#a-sites').onclick = adminSites; $('#a-recips').onclick = adminRecipients;
  if ($('#a-members')) $('#a-members').onclick = adminMembers;
  if ($('#a-settings')) $('#a-settings').onclick = adminSettings;
  if ($('#a-newco')) $('#a-newco').onclick = () => renderOnboarding(false);
  if ($('#a-payroll')) $('#a-payroll').onclick = adminPayroll;
  if ($('#a-ideas')) $('#a-ideas').onclick = adminFeatures;
  if ($('#a-billing')) $('#a-billing').onclick = adminBilling;
}
async function adminBilling() {
  // Safety net: re-check any pending payment with the gateway before showing status
  // (covers a payer who closed the checkout tab before redirecting back).
  try {
    const rec = await api('/billing/reconcile?tenant=' + State.tenant);
    if (rec.status === 'success') { toast('Payment confirmed — subscription active 🎉', 'ok', 4500); const me = await api('/auth/me'); State.tenants = me.tenants; buildTenantSelect(); applyBrand(); }
  } catch { /* offline / transient — ignore */ }
  const t = active();
  const paidUntil = t.paid_until ? new Date(t.paid_until * 1000).toLocaleDateString() : null;
  const statusLine = paidUntil ? `Paid through <b>${paidUntil}</b>` : (t.trial_days_left != null ? `Free trial · <b>${t.trial_days_left} day(s)</b> left` : 'No active subscription');
  const b = modal(`<div class="card" style="background:var(--brand-l);border:none;margin-bottom:12px"><div class="t">${esc(t.name)}</div><div class="s">${statusLine}</div></div>
    <div id="bl-plans"><div class="skel"></div></div>`, { title: '💳 Subscription', sub: 'Powered by Paystack' });
  let cfg; try { cfg = await api('/billing/plans?tenant=' + State.tenant); } catch (e) { $('#bl-plans', b).innerHTML = errBox(e); return; }
  if (!cfg.enabled) {
    $('#bl-plans', b).innerHTML = `<div class="muted" style="text-align:center;padding:18px">Online payment isn't switched on yet.<br>Contact Torama to activate your subscription.</div>`;
    return;
  }
  const cur = (n) => '₦' + Number(n).toLocaleString('en-NG');
  const auto = cfg.autorenew && cfg.autorenew.enabled;
  $('#bl-plans', b).innerHTML = `
    ${auto ? `<div class="seg" id="bl-mode"><button class="seg-b on" data-mode="once">Pay once</button><button class="seg-b" data-mode="auto">🔁 Auto-renew</button></div>` : ''}
    <label class="fl" id="bl-perlbl">Billing period</label>
    <select class="input" id="bl-period"></select>
    <div style="height:10px"></div>
    ${cfg.plans.map((p) => `<div class="card" style="margin-bottom:10px"><div class="row between"><div><b>${esc(p.name)}</b><div class="muted" style="font-size:12.5px">${esc(p.blurb)}</div></div>
      <div style="text-align:right"><div><b class="bl-price" data-price="${p.price}">${cur(p.price)}</b><span class="muted bl-unit" style="font-size:12px">/mo</span></div>
      <button class="btn" data-plan="${p.code}" style="width:auto;padding:8px 14px;margin-top:6px">Pay</button></div></div></div>`).join('')}
    <div class="muted" id="bl-note" style="font-size:11.5px;text-align:center;margin-top:4px">You'll be redirected to ${esc((cfg.provider || 'the gateway'))}'s secure page to pay.</div>
    ${cfg.subscription && cfg.subscription.enabled ? `<div class="card" style="margin-top:12px;background:var(--brand-l);border:none"><div class="row between"><div><b>International (USD)</b><div class="muted" style="font-size:12.5px">${esc(cfg.subscription.price_label)} · cancel anytime</div></div>
      <button class="btn ghost" id="bl-sub" style="width:auto;padding:8px 14px">Subscribe</button></div></div>` : ''}`;
  let mode = 'once';
  const period = $('#bl-period', b), note = $('#bl-note', b);
  const onceOpts = [[1, '1 month'], [3, '3 months'], [6, '6 months'], [12, '12 months']];
  const autoOpts = [['monthly', 'Monthly'], ['annually', 'Annually']];
  const render = () => {
    period.innerHTML = (mode === 'auto' ? autoOpts : onceOpts).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    $('#bl-perlbl', b).textContent = mode === 'auto' ? 'Renews' : 'Billing period';
    note.textContent = mode === 'auto'
      ? 'Card is saved and charged automatically each period — cancel anytime.'
      : `You'll be redirected to ${cfg.provider || 'the gateway'}'s secure page to pay.`;
    reprice();
  };
  const reprice = () => {
    const mult = mode === 'auto' ? (period.value === 'annually' ? 12 : 1) : (+period.value || 1);
    $$('.bl-price', b).forEach((el) => el.textContent = cur(+el.dataset.price * mult));
    $$('.bl-unit', b).forEach((el) => el.textContent = mode === 'auto' ? (period.value === 'annually' ? '/yr' : '/mo') : '');
  };
  period.onchange = reprice;
  if (auto) $$('#bl-mode .seg-b', b).forEach((sb) => sb.onclick = () => { mode = sb.dataset.mode; $$('#bl-mode .seg-b', b).forEach((x) => x.classList.toggle('on', x === sb)); render(); });
  render();
  $$('[data-plan]', b).forEach((btn) => btn.onclick = async () => {
    btn.disabled = true; const old = btn.textContent; btn.innerHTML = '<span class="spin"></span>';
    try {
      const r = mode === 'auto'
        ? await api('/billing/autorenew?tenant=' + State.tenant, { method: 'POST', body: { plan: btn.dataset.plan, interval: period.value } })
        : await api('/billing/checkout?tenant=' + State.tenant, { method: 'POST', body: { plan: btn.dataset.plan, months: +period.value } });
      window.location.href = r.authorization_url;   // hand off to the gateway's hosted checkout
    } catch (e) { btn.disabled = false; btn.textContent = old; toast(e.message, 'err'); }
  });
  if ($('#bl-sub', b)) $('#bl-sub', b).onclick = async () => {
    const btn = $('#bl-sub', b); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try { const r = await api('/billing/subscribe?tenant=' + State.tenant, { method: 'POST', body: {} }); window.location.href = r.url; }
    catch (e) { btn.disabled = false; btn.textContent = 'Subscribe'; toast(e.message, 'err'); }
  };
}
// After returning from Paystack (?pay=REF), confirm the payment server-side.
async function handlePaymentReturn() {
  const u = new URL(location.href);
  if (u.searchParams.get('sub') === 'success') {     // Lemon Squeezy subscription return
    u.searchParams.delete('sub'); history.replaceState({}, '', u.pathname + (u.search || ''));
    toast('Subscription started 🎉 — it activates once confirmed', 'ok', 5000);
    try { const me = await api('/auth/me'); State.tenants = me.tenants; buildTenantSelect(); applyBrand(); } catch {}
  }
  const ref = u.searchParams.get('pay'); if (!ref) return;
  u.searchParams.delete('pay'); history.replaceState({}, '', u.pathname + (u.search || ''));
  try {
    const r = await api('/billing/verify?reference=' + encodeURIComponent(ref) + (State.tenant ? '&tenant=' + State.tenant : ''));
    if (r.status === 'success') { toast('Payment confirmed — subscription active 🎉', 'ok', 5000); try { const me = await api('/auth/me'); State.tenants = me.tenants; buildTenantSelect(); applyBrand(); } catch {} go('dashboard'); }
    else toast('Payment ' + (r.status || 'pending') + ' — we\'ll update once confirmed', 'info', 5000);
  } catch (e) { toast('Could not confirm payment: ' + e.message, 'err'); }
}
const FR_STATUS = ['NEW', 'PLANNED', 'IN_PROGRESS', 'DONE', 'DECLINED'];
const FR_BADGE = { NEW: '#64748b', PLANNED: '#0ea5e9', IN_PROGRESS: '#d97706', DONE: '#16a34a', DECLINED: '#ef4444' };
async function adminFeatures() {
  const triage = isAdmin() || State.user.is_superadmin;
  const b = modal(`<div id="fr-list"><div class="skel"></div></div>
    <div style="height:10px"></div><button class="btn" id="fr-new">＋ Suggest a feature</button>`,
    { title: '💡 Feature requests', sub: active() ? active().name : '' });
  async function load() {
    const list = $('#fr-list', b); list.innerHTML = '<div class="skel"></div>';
    let rows; try { rows = await api(scoped('/feature-requests')); } catch (e) { list.innerHTML = errBox(e); return; }
    if (!rows.length) { list.innerHTML = '<div class="muted" style="text-align:center;padding:18px">No requests yet — be the first 💡</div>'; return; }
    list.innerHTML = rows.map((r) => `<div class="list-item" style="align-items:flex-start">
      <div class="meta"><div class="t">${esc(r.title)}</div>
        <div class="s">${r.tenant_name ? esc(r.tenant_name) + ' · ' : ''}${esc(r.user_name || '')} · ${timeAgo(r.created_at)}</div>
        ${r.body ? `<div class="muted" style="font-size:12.5px;margin-top:3px">${esc(r.body)}</div>` : ''}</div>
      ${triage
        ? `<select class="fr-st input" data-id="${r.id}" style="width:auto;padding:5px 8px;font-size:12px">${FR_STATUS.map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select>`
        : `<span class="pill-cat" style="background:${FR_BADGE[r.status] || '#64748b'}22;color:${FR_BADGE[r.status] || '#64748b'}">${r.status}</span>`}
    </div>`).join('');
    if (triage) $$('.fr-st', list).forEach((sel) => sel.onchange = async () => {
      try { await api(scoped('/feature-requests/' + sel.dataset.id), { method: 'PATCH', body: { status: sel.value } }); toast('Updated', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    });
  }
  $('#fr-new', b).onclick = () => openFeatureForm(load);
  load();
}
function openFeatureForm(after) {
  const f = modal(`<form id="frf">
    <label class="fl">What would you like?</label><input class="input" id="fr-t" placeholder="Short title" maxlength="160"/>
    <label class="fl">Details (optional)</label><textarea class="input" id="fr-b" rows="4" placeholder="What problem would this solve?"></textarea>
    <div style="height:14px"></div><button class="btn" type="submit">Send request</button></form>`, { title: '💡 Suggest a feature' });
  $('#frf', f).onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#fr-t', f).value.trim(); if (!title) { setErr('fr-t', true); return; }
    try { await api(scoped('/feature-requests'), { method: 'POST', body: { title, body: $('#fr-b', f).value.trim() } }); closeModal(); toast('Thanks — request sent 💡', 'ok'); if (after) after(); }
    catch (er) { toast(er.message, 'err'); }
  };
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
async function adminPayroll() {
  const now = new Date();
  const b = modal(`
    <div class="grid2">
      <div><label class="fl">Month</label><select class="input" id="pr-month">${MONTHS.map((m, i) => `<option ${i === now.getMonth() ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
      <div><label class="fl">Year</label><select class="input" id="pr-year">${[0, 1, 2].map((d) => now.getFullYear() - d).map((y) => `<option>${y}</option>`).join('')}</select></div>
    </div>
    <div id="pr-list" style="margin-top:12px"><div class="skel"></div></div>`, { title: 'Payroll', sub: active().name + ' · from POS' });
  async function load() {
    const list = $('#pr-list', b); list.innerHTML = '<div class="skel"></div><div class="skel"></div>';
    try {
      const rows = await api(`/payroll?month=${$('#pr-month', b).value}&year=${$('#pr-year', b).value}`);
      if (!rows.length) { list.innerHTML = '<div class="muted" style="text-align:center;padding:20px">No payroll for this period</div>'; return; }
      const net = rows.reduce((a, r) => a + (r.netPay || 0), 0);
      list.innerHTML = `<div class="card" style="background:var(--brand-l);border:none"><div class="row between"><b>${rows.length} staff</b><b>${ngn(net)} net</b></div></div>` +
        rows.map((r) => `<div class="list-item"><div class="av">👤</div><div class="meta"><div class="t">${esc(r.staff)}</div><div class="s">${esc(r.siteName || '')} · ${r.daysWorked || 0} days · ${esc(r.status || '')}</div></div><div class="amt">${ngn(r.netPay)}</div></div>`).join('');
    } catch (e) { list.innerHTML = errBox(e); }
  }
  $('#pr-month', b).onchange = load; $('#pr-year', b).onchange = load; load();
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

/* ── STAFF HOURS / TIMESHEETS ────────────────────────── */
let staffDate = today(), staffSite = null;
async function viewStaff() {
  fabSet(false); const v = $('#view');
  if (!State.tenant) { v.innerHTML = `<div class="section-title">Staff hours</div>` + emptyBox('👷', 'Pick a workspace', 'Choose a company at the top to record staff hours.'); return; }
  await loadSites();
  if (isSiteMgr()) staffSite = active().site_id;
  else if (!staffSite || !State.sites.find((s) => s.id === staffSite)) staffSite = State.sites[0]?.id || null;
  const siteSel = isSiteMgr() ? '' : `<select class="input" id="st-site" style="flex:1">${State.sites.map((s) => `<option value="${s.id}" ${s.id === staffSite ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
  v.innerHTML = `<div class="section-title">Staff hours</div>
    <div class="row" style="gap:8px;margin-bottom:10px">${siteSel}<input class="input" id="st-date" type="date" value="${staffDate}" style="flex:1"/></div>
    <button class="btn" id="st-attend" style="margin-bottom:10px">📸 Attendance · clock staff in/out</button>
    <div class="row between" style="margin-bottom:10px">
      <button class="btn ghost sm" id="st-summary">📊 Summary / export</button>
      ${isGMup() && posOn() ? `<button class="btn ghost sm" id="st-import">⤓ Import from POS</button>` : ''}
    </div>
    <div id="st-list"><div class="skel"></div><div class="skel"></div></div>`;
  if ($('#st-site')) $('#st-site').onchange = (e) => { staffSite = e.target.value; loadStaffGrid(); };
  $('#st-date').onchange = (e) => { staffDate = e.target.value; loadStaffGrid(); };
  $('#st-attend').onclick = openAttendance;
  $('#st-summary').onclick = staffSummary;
  if ($('#st-import')) $('#st-import').onclick = importStaff;
  loadStaffGrid();
}
async function loadStaffGrid() {
  const list = $('#st-list'); if (!list) return; list.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  try {
    let sp = '/staff'; if (!isSiteMgr() && staffSite) sp += '?site=' + staffSite;
    let tp = '/timesheets?date=' + staffDate; if (!isSiteMgr() && staffSite) tp += '&site=' + staffSite;
    const [staff, ts] = await Promise.all([api(scoped(sp)), api(scoped(tp))]);
    const byStaff = {}; ts.forEach((t) => { byStaff[t.staff_id] = t; });
    if (!staff.length) { list.innerHTML = emptyBox('👷', 'No staff yet', 'Add staff below' + (isGMup() && posOn() ? ' or import from the POS.' : '.')) + addBtns(); bindStaffBtns(); return; }
    list.innerHTML = staff.map((s) => {
      const t = byStaff[s.id] || { present: 1 };
      return `<div class="card" data-sid="${s.id}" style="padding:12px">
        <div class="row between"><b>${esc(s.full_name)}</b>
          <label class="row" style="gap:6px;font-size:13px"><input type="checkbox" class="st-present" ${t.present ? 'checked' : ''} style="width:auto"/> Present</label></div>
        <div class="grid2" style="margin-top:8px">
          <input class="input st-hours" type="number" inputmode="decimal" placeholder="Hours" value="${t.hours ?? ''}"/>
          <input class="input st-bagged" type="number" inputmode="numeric" placeholder="Bags bagged" value="${t.bags_bagged ?? ''}"/>
        </div>
        <input class="input st-loaded" type="number" inputmode="numeric" placeholder="Bags loaded" value="${t.bags_loaded ?? ''}" style="margin-top:6px"/>
      </div>`;
    }).join('') + `<button class="btn" id="st-save" style="margin-top:6px">Save day</button>` + addBtns();
    $('#st-save').onclick = saveStaffDay; bindStaffBtns();
  } catch (e) { list.innerHTML = errBox(e); }
}
const addBtns = () => `<button class="btn ghost sm" id="st-add" style="margin-top:8px">＋ Add staff</button>`;
function bindStaffBtns() { if ($('#st-add')) $('#st-add').onclick = addStaffForm; }
async function saveStaffDay() {
  const entries = $$('#st-list [data-sid]').map((c) => ({
    staff_id: c.dataset.sid, present: $('.st-present', c).checked,
    hours: $('.st-hours', c).value === '' ? null : +$('.st-hours', c).value,
    bags_bagged: $('.st-bagged', c).value === '' ? null : +$('.st-bagged', c).value,
    bags_loaded: $('.st-loaded', c).value === '' ? null : +$('.st-loaded', c).value,
  }));
  const btn = $('#st-save'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Saving…';
  try { const r = await api('/timesheets?tenant=' + State.tenant, { method: 'POST', body: { work_date: staffDate, site_id: isSiteMgr() ? active().site_id : staffSite, entries } });
    toast(`Saved ${r.saved} staff for ${staffDate}`, 'ok'); }
  catch (e) { toast(e.message, 'err'); } finally { btn.disabled = false; btn.textContent = 'Save day'; }
}
function addStaffForm() {
  const f = modal(`<form id="sf"><label class="fl">Full name</label><input class="input" id="ns-name"/>
    <label class="fl">Role (optional)</label><input class="input" id="ns-role" placeholder="e.g. Bagger, Loader"/>
    <label class="fl">Pay type</label><select class="input" id="ns-pay"><option>DAILY</option><option>HOURLY</option><option>MONTHLY</option><option>PIECE</option></select>
    <div style="height:14px"></div><button class="btn" type="submit">Add staff</button></form>`, { title: 'Add staff', sub: isSiteMgr() ? active().name : siteName(staffSite) });
  let pickedExt = null;
  attachTypeahead($('#ns-name', f), 'staff', (it) => { pickedExt = it.ext_id || null; if (it.role && !$('#ns-role', f).value) $('#ns-role', f).value = it.role; });
  $('#ns-name', f).addEventListener('input', () => { pickedExt = null; });   // typing again clears the link
  $('#sf', f).onsubmit = async (e) => { e.preventDefault(); const name = $('#ns-name', f).value.trim(); if (!name) { toast('Name required', 'err'); return; }
    try { await api('/staff?tenant=' + State.tenant, { method: 'POST', body: { full_name: name, role_title: $('#ns-role', f).value.trim(), pay_type: $('#ns-pay', f).value, site_id: isSiteMgr() ? active().site_id : staffSite, ext_people_id: pickedExt } });
      toast('Staff added', 'ok'); closeModal(); loadStaffGrid(); } catch (er) { toast(er.message, 'err'); } };
}
async function importStaff() {
  confirmModal('Import staff from POS?', 'Pulls active staff from the POS and matches them to this company\'s sites.', async () => {
    try { const r = await api('/staff/import?tenant=' + State.tenant, { method: 'POST', body: {} }); toast(`Imported ${r.imported} of ${r.scanned}`, 'ok'); loadStaffGrid(); }
    catch (e) { toast(e.message.includes('not configured') ? 'Sales DB not connected yet' : e.message, 'err'); }
  });
}
function monthStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); }
async function staffSummary() {
  const b = modal(`
    <div class="grid2"><div><label class="fl">From</label><input class="input" id="su-from" type="date" value="${monthStart()}"/></div>
      <div><label class="fl">To</label><input class="input" id="su-to" type="date" value="${today()}"/></div></div>
    <div id="su-list" style="margin-top:12px"><div class="skel"></div></div>
    <button class="btn" id="su-csv" style="margin-top:10px">⬇ Export CSV (for payroll)</button>`, { title: 'Staff summary', sub: isSiteMgr() ? active().name : (staffSite ? siteName(staffSite) : active().name) });
  const q = () => { let s = `from=${$('#su-from', b).value}&to=${$('#su-to', b).value}`; if (!isSiteMgr() && staffSite) s += '&site=' + staffSite; return s; };
  async function load() {
    const list = $('#su-list', b); list.innerHTML = '<div class="skel"></div>';
    try { const rows = await api(scoped('/timesheets/summary?' + q()));
      if (!rows.length) { list.innerHTML = '<div class="muted" style="text-align:center;padding:16px">No timesheet data in range</div>'; return; }
      list.innerHTML = rows.map((r) => `<div class="list-item"><div class="meta"><div class="t">${esc(r.staff)}</div><div class="s">${esc(r.site)} · ${r.days} days · ${r.hours || 0}h · bagged ${r.bags_bagged || 0} · loaded ${r.bags_loaded || 0}</div></div></div>`).join('');
    } catch (e) { list.innerHTML = errBox(e); }
  }
  $('#su-from', b).onchange = load; $('#su-to', b).onchange = load; load();
  $('#su-csv', b).onclick = async () => {
    try { const res = await fetch('/api' + scoped('/timesheets/summary.csv?' + q()), { headers: { Authorization: 'Bearer ' + State.token } });
      if (!res.ok) throw new Error('export failed'); const blob = await res.blob();
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `timesheets-${$('#su-from', b).value}_${$('#su-to', b).value}.csv`; a.click(); URL.revokeObjectURL(a.href);
      toast('CSV downloaded', 'ok'); } catch (e) { toast(e.message, 'err'); }
  };
}

/* ── SELL (in-app POS) ───────────────────────────────── */
let cart = [];
async function viewSell() {
  fabSet(false); const v = $('#view');
  v.innerHTML = `<div class="section-title">Sell</div><div class="skel"></div>`;
  try {
    let raw;
    try { raw = await api(scoped('/products')); localStorage.setItem('dbk_prod_' + State.tenant, JSON.stringify(raw)); State.online = true; }
    catch (e) { raw = lsGet('dbk_prod_' + State.tenant, null); if (!raw) throw e; State.online = false; updatePill(); }  // offline → cached catalog
    const products = raw.filter((p) => p.status === 'ACTIVE');
    State._products = products;
    v.innerHTML = `${trialBanner()}
      <div class="row between" style="margin-bottom:8px"><h3 style="margin:0">💳 New sale</h3>
        <button class="btn ghost sm" id="sellManage">⚙️ Catalog</button></div>
      <input class="input" id="prodSearch" placeholder="Search products…" style="margin-bottom:10px"/>
      <div id="prodGrid" class="prodgrid"></div><div id="cartBar"></div>`;
    renderGrid(products); renderCart();
    $('#prodSearch').oninput = (e) => { const q = e.target.value.toLowerCase(); renderGrid(products.filter((p) => p.name.toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q))); };
    $('#sellManage').onclick = manageCatalog;
  } catch (e) { v.innerHTML = errBox(e); }
}
function renderGrid(products) {
  const g = $('#prodGrid'); if (!g) return;
  if (!products.length) { g.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="ic">📦</div><p>No products yet. Tap ⚙️ Catalog to add.</p></div>`; return; }
  g.innerHTML = products.map((p) => `<button class="prodcard" data-p="${p.id}"><div class="pn">${esc(p.name)}</div><div class="pp">${ngn(p.price)}</div>${p.track_stock ? `<div class="ps ${p.stock_qty <= 0 ? 'out' : ''}">${p.stock_qty} ${esc(p.unit || '')}</div>` : ''}</button>`).join('');
  $$('#prodGrid .prodcard').forEach((b) => b.onclick = () => addToCart(b.dataset.p));
}
function addToCart(pid) { const p = State._products.find((x) => x.id === pid); if (!p) return; const ex = cart.find((c) => c.product_id === pid); if (ex) ex.qty++; else cart.push({ product_id: pid, name: p.name, price: p.price, qty: 1 }); renderCart(); }
function renderCart() {
  const bar = $('#cartBar'); if (!bar) return;
  if (!cart.length) { bar.innerHTML = ''; return; }
  const total = cart.reduce((a, c) => a + c.qty * c.price, 0);
  bar.innerHTML = `<div class="card" style="margin-top:12px">
    ${cart.map((c, i) => `<div class="row between" style="padding:6px 0"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span>
      <span class="row" style="gap:7px"><button class="qb" data-dec="${i}">−</button><b>${c.qty}</b><button class="qb" data-inc="${i}">＋</button><b style="min-width:72px;text-align:right">${ngn(c.qty * c.price)}</b></span></div>`).join('')}
    <div class="row between" style="padding-top:8px;border-top:1px solid var(--line)"><b>Total</b><b style="font-size:18px">${ngn(total)}</b></div>
    <button class="btn" id="charge" style="margin-top:10px">Charge ${ngn(total)}</button></div>`;
  $$('[data-inc]', bar).forEach((b) => b.onclick = () => { cart[+b.dataset.inc].qty++; renderCart(); });
  $$('[data-dec]', bar).forEach((b) => b.onclick = () => { const i = +b.dataset.dec; cart[i].qty--; if (cart[i].qty <= 0) cart.splice(i, 1); renderCart(); });
  $('#charge', bar).onclick = checkout;
}
function checkout() {
  const total = cart.reduce((a, c) => a + c.qty * c.price, 0);
  const f = modal(`<form id="cf">
    <div class="row between" style="margin-bottom:8px"><b>Total</b><b style="font-size:20px">${ngn(total)}</b></div>
    <label class="fl">Payment method</label><select class="input" id="c-method"><option>CASH</option><option>TRANSFER</option><option>POS</option><option>CREDIT</option></select>
    <label class="fl">Amount paid</label><input class="input" id="c-paid" type="number" inputmode="decimal" value="${Math.round(total)}"/>
    <label class="fl">Customer (optional)</label><input class="input" id="c-cust" placeholder="Walk-in"/>
    <div style="height:14px"></div><button class="btn" type="submit" id="c-done">Complete sale</button></form>`, { title: 'Payment', sub: `${cart.length} item(s)` });
  $('#cf', f).onsubmit = async (e) => { e.preventDefault();
    const method = $('#c-method', f).value, paid = +$('#c-paid', f).value || 0, cust = $('#c-cust', f).value.trim() || null;
    const payload = { client_uid: uuidv4(), items: cart.map((c) => ({ product_id: c.product_id, qty: c.qty })), payment_method: method, amount_paid: paid, customer_name: cust, sale_date: today() };
    const localSale = { pending: true, receipt_no: null, items: cart.map((c) => ({ name: c.name, qty: c.qty, price: c.price, amount: c.qty * c.price })),
      total, payment_method: method, amount_paid: paid, balance: Math.max(0, total - paid), customer_name: cust, sale_date: today(),
      tenant: { name: active().name }, site: { name: isSiteMgr() ? siteName(active().site_id) : '' } };
    const btn = $('#c-done', f); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>Saving…';
    try {
      const sale = await api('/pos/sales?tenant=' + State.tenant, { method: 'POST', body: payload });
      State.online = true; cart = []; closeModal(); showReceipt({ ...localSale, pending: false, receipt_no: sale.receipt_no });
    } catch (er) {
      if (isNetErr(er)) {            // no signal → keep the sale; print now, sync later
        State.online = false; queueSale(State.tenant, payload); cart = []; closeModal();
        showReceipt(localSale); toast('Saved offline — will sync when back online', 'info', 4000);
      } else { toast(er.message, 'err'); btn.disabled = false; btn.textContent = 'Complete sale'; }
    }
  };
}
function showReceipt(sale) {
  const html = receiptHTML(sale);
  const b = modal(`<div style="background:#fff;padding:8px;border-radius:8px">${html}</div>
    <button class="btn" id="rBt" style="margin-top:12px">🖨 Print to Bluetooth printer</button>
    <div class="grid2" style="margin-top:8px"><button class="btn ghost" id="rNew">New sale</button><button class="btn ghost" id="rPrint">Browser print</button></div>`,
    { title: sale.pending ? 'Receipt · pending sync' : 'Receipt #' + sale.receipt_no });
  $('#rBt', b).onclick = () => btPrintReceipt(sale);
  $('#rPrint', b).onclick = () => printReceipt(html);
  $('#rNew', b).onclick = () => { closeModal(); viewSell(); };
}
function receiptHTML(sale) {
  const t = sale.tenant || {}; const items = sale.items || [];
  return `<div style="font-family:'Courier New',monospace;font-size:13px;width:280px;margin:auto;color:#000">
    <div style="text-align:center"><div style="font-weight:bold;font-size:16px">${esc(t.name || '')}</div>
    ${sale.site && sale.site.name ? `<div>${esc(sale.site.name)}</div>` : ''}<div>${sale.sale_date} · #${sale.receipt_no || 'PENDING'}</div>
    ${sale.pending ? '<div style="font-size:11px">⚡ offline — syncs when online</div>' : ''}</div>
    <div style="border-top:1px dashed #000;margin:6px 0"></div>
    ${items.map((i) => `<div style="display:flex;justify-content:space-between"><span>${esc(i.name)} ×${i.qty}</span><span>${ngn(i.amount)}</span></div>`).join('')}
    <div style="border-top:1px dashed #000;margin:6px 0"></div>
    <div style="display:flex;justify-content:space-between;font-weight:bold"><span>TOTAL</span><span>${ngn(sale.total)}</span></div>
    <div style="display:flex;justify-content:space-between"><span>${esc(sale.payment_method)} paid</span><span>${ngn(sale.amount_paid)}</span></div>
    ${sale.balance > 0 ? `<div style="display:flex;justify-content:space-between"><span>Balance</span><span>${ngn(sale.balance)}</span></div>` : ''}
    ${sale.customer_name ? `<div>Customer: ${esc(sale.customer_name)}</div>` : ''}
    <div style="text-align:center;margin-top:8px">Thank you!</div></div>`;
}
function printReceipt(html) {
  const w = window.open('', '_blank', 'width=320,height=600'); if (!w) { toast('Allow pop-ups to print', 'err'); return; }
  w.document.write(`<html><head><title>Receipt</title><style>@media print{@page{margin:0}}body{margin:0;padding:8px}</style></head><body onload="window.print();setTimeout(()=>window.close(),300)">${html}</body></html>`);
  w.document.close();
}

/* ── Bluetooth thermal printing (Web Bluetooth + ESC/POS) ────────────────────
   Works on Android Chrome. Connects to a BLE thermal printer, then streams raw
   ESC/POS bytes. The printer is remembered for the session after first pairing. */
const BT = {
  device: null, char: null,
  // serial-data GATT services used by common cheap ESC/POS BLE printers
  services: ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb',
    '49535343-fe7d-4ae5-8fa9-9fafd205e455', '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000ffe0-0000-1000-8000-00805f9b34fb'],
  supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); },
  async _findChar(server) {
    for (const s of await server.getPrimaryServices()) {
      for (const c of await s.getCharacteristics()) {
        if (c.properties.write || c.properties.writeWithoutResponse) return c;
      }
    }
    return null;
  },
  async connect() {
    if (!this.supported()) throw new Error('Bluetooth printing needs Android + Chrome. (iPhone browsers can’t print over Bluetooth.)');
    const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: this.services });
    const server = await dev.gatt.connect();
    const ch = await this._findChar(server);
    if (!ch) throw new Error('No printable channel found on that device — is it an ESC/POS printer?');
    this.device = dev; this.char = ch;
    dev.addEventListener('gattserverdisconnected', () => { this.char = null; });
    localStorage.setItem('daybook_printer', dev.name || 'Bluetooth printer');
    return dev.name || 'printer';
  },
  async ensure() {
    if (this.char && this.device && this.device.gatt.connected) return;
    if (this.device && !this.device.gatt.connected) {        // reconnect a paired printer
      const server = await this.device.gatt.connect();
      this.char = await this._findChar(server);
      if (this.char) return;
    }
    await this.connect();
  },
  async write(bytes) {
    await this.ensure();
    const CH = 180;
    for (let i = 0; i < bytes.length; i += CH) {
      const slice = bytes.slice(i, i + CH);
      if (this.char.properties.writeWithoutResponse) await this.char.writeValueWithoutResponse(slice);
      else await this.char.writeValue(slice);
      await new Promise((r) => setTimeout(r, 18));            // pace BLE writes so the buffer keeps up
    }
  },
};
// Minimal ESC/POS encoder. `lines` items: string, or {text,align,bold,big}.
const ESC = {
  enc: new TextEncoder(),
  build(lines) {
    const out = [0x1B, 0x40];                                 // initialise
    const push = (...b) => out.push(...b);
    for (const ln of lines) {
      const o = typeof ln === 'string' ? { text: ln } : ln;
      push(0x1B, 0x61, o.align === 'center' ? 1 : o.align === 'right' ? 2 : 0);
      push(0x1B, 0x45, o.bold ? 1 : 0);
      push(0x1D, 0x21, o.big ? 0x11 : 0x00);
      const t = (o.text || '').replace(/₦/g, 'NGN').replace(/[^\x20-\x7E]/g, '');  // printers lack ₦ glyph
      for (const c of this.enc.encode(t)) push(c);
      push(0x0A);
    }
    push(0x1D, 0x21, 0x00, 0x1B, 0x45, 0x00, 0x1B, 0x61, 0x00, 0x0A, 0x0A, 0x0A);
    push(0x1D, 0x56, 0x42, 0x00);                             // partial cut (ignored if unsupported)
    return Uint8Array.from(out);
  },
};
const nairaPlain = (n) => 'NGN ' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
function receiptESC(sale, width = 32) {
  const t = sale.tenant || {}, items = sale.items || [];
  const row = (l, r) => { const s = String(l), e = String(r); return s + ' '.repeat(Math.max(1, width - s.length - e.length)) + e; };
  const L = [];
  L.push({ text: t.name || 'Receipt', align: 'center', bold: true, big: true });
  if (sale.site && sale.site.name) L.push({ text: sale.site.name, align: 'center' });
  L.push({ text: `${sale.sale_date}  #${sale.receipt_no || 'PENDING'}`, align: 'center' });
  if (sale.pending) L.push({ text: '** offline - will sync **', align: 'center' });
  L.push('-'.repeat(width));
  for (const i of items) L.push(row(`${i.name} x${i.qty}`, nairaPlain(i.amount)));
  L.push('-'.repeat(width));
  L.push({ text: row('TOTAL', nairaPlain(sale.total)), bold: true });
  L.push(row(`${sale.payment_method} paid`, nairaPlain(sale.amount_paid)));
  if (sale.balance > 0) L.push(row('Balance', nairaPlain(sale.balance)));
  if (sale.customer_name) L.push('Customer: ' + sale.customer_name);
  L.push({ text: 'Thank you!', align: 'center' });
  return ESC.build(L);
}
async function btPrint(bytes) {
  try { toast('Sending to printer…', 'info', 2000); await BT.write(bytes); toast('Printed ✓', 'ok'); }
  catch (e) { if (e && (e.name === 'NotFoundError' || e.name === 'AbortError')) return; toast('Print failed: ' + e.message, 'err', 6000); }
}
const btPrintReceipt = (sale) => btPrint(receiptESC(sale));
// Generic: print arbitrary text lines to the thermal printer (anything in the app).
const btPrintLines = (lines) => btPrint(ESC.build(Array.isArray(lines) ? lines : [String(lines)]));

/* ── Staff attendance kiosk (photo + signature + GPS clock-in) ───────────────
   Runs on one shared device per site — no staff phone needed. The site manager
   captures the staff member's photo + on-screen signature + GPS as daily proof. */
async function openAttendance() {
  const site = isSiteMgr() ? active().site_id : staffSite;
  const b = modal(`<div class="row" style="gap:8px;margin-bottom:10px"><input class="input" id="at-date" type="date" value="${today()}" style="flex:1"/></div>
    <div id="at-list"><div class="skel"></div><div class="skel"></div></div>`, { title: '📸 Attendance', sub: active().name });
  const load = async () => {
    const list = $('#at-list', b); if (!list) return; list.innerHTML = '<div class="skel"></div><div class="skel"></div>';
    const date = $('#at-date', b).value;
    try {
      const sp = '/staff' + (!isSiteMgr() && site ? '?site=' + site : '');
      const ap = '/attendance?date=' + date + (!isSiteMgr() && site ? '&site=' + site : '');
      const [staff, att] = await Promise.all([api(scoped(sp)), api(scoped(ap))]);
      const byId = {}; att.forEach((a) => (byId[a.staff_id] = a));
      if (!staff.length) { list.innerHTML = '<div class="muted" style="text-align:center;padding:18px">No staff for this site yet</div>'; return; }
      list.innerHTML = staff.map((s) => {
        const a = byId[s.id];
        const status = a ? (a.clock_out ? `Out ${clock(a.clock_out)}` : `In ${clock(a.clock_in)}`) : 'Not clocked in';
        const action = !a || (!a.clock_in && !a.clock_out) ? 'in' : (a.clock_in && !a.clock_out ? 'out' : 'done');
        return `<div class="list-item"><div class="av">${a ? '🟢' : '⚪'}</div><div class="meta"><div class="t">${esc(s.full_name)}</div><div class="s">${esc(s.role_title || '')}${s.role_title ? ' · ' : ''}${status}</div></div>
          ${action === 'done' ? `<span class="pill-cat" style="background:#dcfce7;color:#166534">✓ done</span>`
            : `<button class="btn ${action === 'out' ? 'ghost' : ''}" data-staff="${s.id}" data-name="${esc(s.full_name)}" data-kind="${action}" style="width:auto;padding:8px 13px">${action === 'out' ? 'Clock out' : 'Clock in'}</button>`}</div>`;
      }).join('');
      $$('[data-staff]', list).forEach((btn) => btn.onclick = () => captureClock(btn.dataset.staff, btn.dataset.name, btn.dataset.kind, date, load));
    } catch (e) { list.innerHTML = errBox(e); }
  };
  $('#at-date', b).onchange = load; load();
}
let _camStream = null;
function stopCam() { if (_camStream) { _camStream.getTracks().forEach((t) => t.stop()); _camStream = null; } }
async function startCam(video) {
  try { _camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch { _camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
  video.srcObject = _camStream;
}
async function captureClock(staffId, name, kind, date, after) {
  const b = modal(`
    <div class="muted" style="margin-bottom:8px">${esc(name)} · <b>${kind === 'out' ? 'Clock out' : 'Clock in'}</b></div>
    <div style="position:relative;background:#000;border-radius:12px;overflow:hidden;aspect-ratio:4/3">
      <video id="cam" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover"></video>
      <img id="shot" style="display:none;width:100%;height:100%;object-fit:cover"/></div>
    <div class="row" style="gap:8px;margin-top:8px"><button class="btn ghost" id="cap-retake" style="display:none">Retake</button><button class="btn" id="cap-photo">📷 Capture photo</button></div>
    <label class="fl" style="margin-top:12px">Signature</label>
    <canvas id="sig" style="width:100%;height:120px;border:1.5px dashed var(--line);border-radius:10px;touch-action:none;background:#fff"></canvas>
    <div class="muted" id="cap-geo" style="font-size:12px;margin-top:8px">📍 locating…</div>
    <div class="cap-bar"><button type="button" class="btn ghost" id="sig-clear">Clear sign</button><button class="btn" id="cap-save" disabled>Save ${kind === 'out' ? 'clock-out' : 'clock-in'}</button></div>`,
    { title: '📸 ' + (kind === 'out' ? 'Clock out' : 'Clock in') });
  let photo = null, geo = null, signed = false;
  const video = $('#cam', b), shot = $('#shot', b), saveBtn = $('#cap-save', b);
  const updateSave = () => { saveBtn.disabled = !(photo && signed); };
  try { await startCam(video); } catch { $('#cap-photo', b).disabled = true; toast('No camera available', 'err'); }
  $('#cap-photo', b).onclick = () => {
    const w = 480, h = Math.round(w * (video.videoHeight || 480) / (video.videoWidth || 640));
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(video, 0, 0, w, h);
    photo = c.toDataURL('image/jpeg', 0.6); shot.src = photo; shot.style.display = 'block'; video.style.display = 'none'; stopCam();
    $('#cap-photo', b).style.display = 'none'; $('#cap-retake', b).style.display = 'block'; updateSave();
  };
  $('#cap-retake', b).onclick = async () => {
    photo = null; shot.style.display = 'none'; video.style.display = 'block';
    $('#cap-photo', b).style.display = 'block'; $('#cap-retake', b).style.display = 'none';
    try { await startCam(video); } catch {} updateSave();
  };
  // signature pad
  const sig = $('#sig', b), ctx = sig.getContext('2d'); let drawing = false;
  setTimeout(() => { const r = sig.getBoundingClientRect(); sig.width = r.width; sig.height = r.height; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111'; }, 60);
  const at = (e) => { const r = sig.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return [p.clientX - r.left, p.clientY - r.top]; };
  sig.addEventListener('pointerdown', (e) => { drawing = true; signed = true; const [x, y] = at(e); ctx.beginPath(); ctx.moveTo(x, y); e.preventDefault(); updateSave(); });
  sig.addEventListener('pointermove', (e) => { if (!drawing) return; const [x, y] = at(e); ctx.lineTo(x, y); ctx.stroke(); e.preventDefault(); });
  window.addEventListener('pointerup', () => { drawing = false; });
  $('#sig-clear', b).onclick = () => { ctx.clearRect(0, 0, sig.width, sig.height); signed = false; updateSave(); };
  // geolocation
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(
    (p) => { geo = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }; const g = $('#cap-geo', b); if (g) g.textContent = `📍 ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)} (±${Math.round(geo.accuracy)}m)`; },
    () => { const g = $('#cap-geo', b); if (g) g.textContent = '📍 location unavailable'; }, { enableHighAccuracy: true, timeout: 8000 });
  else $('#cap-geo', b).textContent = '📍 no GPS on this device';
  saveBtn.onclick = async () => {
    saveBtn.disabled = true; saveBtn.innerHTML = '<span class="spin"></span>';
    try {
      await api(scoped('/attendance/clock'), { method: 'POST', body: { staff_id: staffId, kind, work_date: date, photo, signature: signed ? sig.toDataURL('image/png') : null, lat: geo && geo.lat, lng: geo && geo.lng, accuracy: geo && geo.accuracy } });
      stopCam(); closeModal(); toast(`${name} clocked ${kind === 'out' ? 'out' : 'in'} ✓`, 'ok'); if (after) after();
    } catch (e) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; toast(isNetErr(e) ? 'Need a connection to record attendance' : e.message, 'err', 5000); }
  };
}
async function manageCatalog() {
  const products = await api(scoped('/products'));
  const b = modal(`<div class="row between" style="margin-bottom:8px"><b>Products</b>${isGMup() ? `<button class="btn ghost sm" id="addProd">＋ Product</button>` : ''}</div>
    <div>${products.map((p) => `<div class="list-item"><div class="meta"><div class="t">${esc(p.name)}</div><div class="s">${ngn(p.price)}${p.track_stock ? ' · stock ' + p.stock_qty + ' ' + esc(p.unit || '') : ''} · ${p.status}</div></div><button class="btn ghost sm" data-stock="${p.id}">Stock</button></div>`).join('') || '<div class="muted">No products</div>'}</div>
    <div style="height:10px"></div><button class="btn ghost" id="custBtn">👥 Customers</button>`, { title: 'Catalog', sub: active().name });
  if ($('#addProd', b)) $('#addProd', b).onclick = prodForm;
  $('#custBtn', b).onclick = manageCustomers;
  $$('[data-stock]', b).forEach((el) => el.onclick = () => stockForm(el.dataset.stock, products.find((p) => p.id === el.dataset.stock)));
}
function prodForm() {
  const f = modal(`<form id="pf"><label class="fl">Name</label><input class="input" id="p-name"/>
    <div class="grid2"><div><label class="fl">Price (₦)</label><input class="input" id="p-price" type="number" inputmode="decimal"/></div>
      <div><label class="fl">Cost (₦)</label><input class="input" id="p-cost" type="number" inputmode="decimal"/></div></div>
    <div class="grid2"><div><label class="fl">Category</label><input class="input" id="p-cat"/></div><div><label class="fl">Unit</label><input class="input" id="p-unit" value="unit"/></div></div>
    <label class="fl row"><input type="checkbox" id="p-track" checked style="width:auto;margin-right:8px"/> Track stock</label>
    <label class="fl">Opening stock</label><input class="input" id="p-stock" type="number" inputmode="decimal" value="0"/>
    <div style="height:14px"></div><button class="btn" type="submit">Add product</button></form>`, { title: 'New product' });
  $('#pf', f).onsubmit = async (e) => { e.preventDefault(); const name = $('#p-name', f).value.trim(); if (!name) { toast('Name required', 'err'); return; }
    try { await api('/products?tenant=' + State.tenant, { method: 'POST', body: { name, price: +$('#p-price', f).value || 0, cost: +$('#p-cost', f).value || 0, category: $('#p-cat', f).value.trim(), unit: $('#p-unit', f).value.trim() || 'unit', track_stock: $('#p-track', f).checked, stock_qty: +$('#p-stock', f).value || 0 } });
      toast('Product added', 'ok'); closeModal(); manageCatalog(); } catch (er) { toast(er.message, 'err'); } };
}
function stockForm(id, p) {
  const f = modal(`<form id="kf"><div class="muted" style="margin-bottom:8px">Current: <b>${p.stock_qty} ${esc(p.unit || '')}</b></div>
    <label class="fl">Type</label><select class="input" id="k-type"><option value="PURCHASE">Stock in (purchase)</option><option value="ADJUST">Adjustment</option></select>
    <label class="fl">Quantity (use − for removal)</label><input class="input" id="k-qty" type="number" inputmode="decimal"/>
    <label class="fl">Note</label><input class="input" id="k-note"/>
    <div style="height:14px"></div><button class="btn" type="submit">Save</button></form>`, { title: 'Stock · ' + p.name });
  $('#kf', f).onsubmit = async (e) => { e.preventDefault(); const qty = +$('#k-qty', f).value; if (!qty) { toast('Qty required', 'err'); return; }
    try { await api('/products/' + id + '/stock?tenant=' + State.tenant, { method: 'POST', body: { qty, type: $('#k-type', f).value, note: $('#k-note', f).value.trim() } });
      toast('Stock updated', 'ok'); closeModal(); manageCatalog(); } catch (er) { toast(er.message, 'err'); } };
}
async function manageCustomers() {
  const custs = await api(scoped('/customers'));
  const b = modal(`<div>${custs.map((c) => `<div class="list-item"><div class="av">👤</div><div class="meta"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.phone || '')} ${esc(c.email || '')}</div></div></div>`).join('') || '<div class="muted">No customers</div>'}</div>
    <form id="ncf" style="margin-top:10px"><label class="fl">Add customer</label><input class="input" id="nc-name" placeholder="Name"/>
      <div class="grid2"><input class="input" id="nc-phone" placeholder="Phone"/><input class="input" id="nc-email" placeholder="Email"/></div>
      <div style="height:10px"></div><button class="btn" type="submit">Add</button></form>`, { title: 'Customers' });
  attachTypeahead($('#nc-name', b), 'customers', (it) => { if (it.phone && !$('#nc-phone', b).value) $('#nc-phone', b).value = it.phone; });
  $('#ncf', b).onsubmit = async (e) => { e.preventDefault(); const name = $('#nc-name', b).value.trim(); if (!name) { toast('Name required', 'err'); return; }
    try { await api('/customers?tenant=' + State.tenant, { method: 'POST', body: { name, phone: $('#nc-phone', b).value.trim(), email: $('#nc-email', b).value.trim() } }); toast('Added', 'ok'); manageCustomers(); } catch (er) { toast(er.message, 'err'); } };
}

/* ── TRIAL BANNER ────────────────────────────────────── */
function trialBanner() {
  const t = active(); if (!t || t.plan === 'OWNER' || t.trial_days_left == null) return '';
  const d = t.trial_days_left;
  const cta = isAdmin() ? `<button class="btn" onclick="dbkBilling()" style="width:auto;padding:7px 13px;font-size:13px">Subscribe</button>` : '';
  if (d > 3) return `<div class="card" style="background:#ecfdf5;border-color:#a7f3d0;margin-bottom:12px;padding:11px 14px"><div class="row between"><b style="color:#065f46">✨ Free trial · ${d} days left</b>${cta}</div></div>`;
  if (d > 0) return `<div class="card" style="background:#fffbeb;border-color:#fde68a;margin-bottom:12px;padding:11px 14px"><div class="row between"><div><b style="color:#92400e">⏳ Trial ends in ${d} day(s)</b><div class="muted" style="font-size:12px">Subscribe to keep your data.</div></div>${cta}</div></div>`;
  return `<div class="card" style="background:#fef2f2;border-color:#fecaca;margin-bottom:12px;padding:11px 14px"><div class="row between"><div><b style="color:#991b1b">Trial ended</b><div class="muted" style="font-size:12px">Workspace suspended. Subscribe to reactivate before data is removed.</div></div>${cta}</div></div>`;
}
window.dbkBilling = () => { const t = active(); if (isAdmin() && t && t.plan !== 'OWNER') adminBilling(); };

/* ── GENERATORS ──────────────────────────────────────── */
async function manageGenerators() {
  await loadSites();
  let gens = []; try { gens = await api(scoped('/generators')); } catch {}
  const siteOpts = State.sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const b = modal(`<div id="genList">${gens.length ? gens.map(genRow).join('') : '<div class="muted" style="padding:8px">No generators yet</div>'}</div>
    <div style="height:12px"></div><button class="btn" id="addGen">＋ Register generator</button>`, { title: '🔌 Generators', sub: active()?.name });
  $$('[data-gen]', b).forEach((el) => el.onclick = () => genDetail(el.dataset.gen, gens.find((g) => g.id === el.dataset.gen)));
  $('#addGen', b).onclick = () => {
    const f = modal(`<form id="gf">
      ${isSiteMgr() ? '' : `<label class="fl">Site</label><select class="input" id="g-site">${siteOpts}</select>`}
      <label class="fl">Name / label</label><input class="input" id="g-name" placeholder="e.g. 100KVA Cummins"/>
      <label class="fl">Fuel</label><select class="input" id="g-fuel"><option>DIESEL</option><option>PETROL</option><option>GAS</option></select>
      <div class="grid2"><div><label class="fl">Make / model</label><input class="input" id="g-model"/></div><div><label class="fl">Capacity (KVA)</label><input class="input" id="g-kva" type="number" inputmode="decimal"/></div></div>
      <div class="grid2"><div><label class="fl">Serial no</label><input class="input" id="g-serial"/></div><div><label class="fl">Bought date</label><input class="input" id="g-date" type="date"/></div></div>
      <label class="fl">Purchase cost (₦)</label><input class="input" id="g-cost" type="number" inputmode="decimal"/>
      <div style="height:14px"></div><button class="btn" type="submit">Register</button></form>`, { title: 'Register generator' });
    $('#gf', f).onsubmit = async (e) => { e.preventDefault(); const name = $('#g-name', f).value.trim(); if (!name) { toast('Name required', 'err'); return; }
      try { await api('/generators?tenant=' + State.tenant, { method: 'POST', body: { name, fuel_type: $('#g-fuel', f).value, make_model: $('#g-model', f).value.trim(), capacity_kva: +$('#g-kva', f).value || null, serial_no: $('#g-serial', f).value.trim(), purchase_date: $('#g-date', f).value || null, purchase_cost: +$('#g-cost', f).value || null, site_id: isSiteMgr() ? active().site_id : ($('#g-site', f) && $('#g-site', f).value) } });
        toast('Generator registered', 'ok'); closeModal(); manageGenerators(); } catch (er) { toast(er.message, 'err'); } };
  };
}
const genRow = (g) => `<div class="card tap" data-gen="${g.id}" style="padding:12px"><div class="list-item" style="border:none;padding:0"><div class="av">🔌</div><div class="meta"><div class="t">${esc(g.name)}</div><div class="s">${esc(g.fuel_type)}${g.capacity_kva ? ' · ' + g.capacity_kva + 'KVA' : ''}${g.site_id ? ' · ' + esc(siteName(g.site_id)) : ''}</div></div><span>›</span></div></div>`;
async function genDetail(id, g) {
  let data = { logs: [], diesel_total: { litres: 0, cost: 0 } }; try { data = await api('/generators/' + id + '/logs'); } catch {}
  const logs = data.logs.map((l) => `<div class="list-item"><div class="av">${l.type === 'DIESEL' ? '⛽' : l.type === 'MAINTENANCE' ? '🔧' : '📝'}</div>
    <div class="meta"><div class="t">${l.type === 'DIESEL' ? (l.litres || 0) + ' L' : esc(l.detail || l.type)}</div>
    <div class="s">${l.log_date}${l.cost ? ' · ' + ngn(l.cost) : ''}${l.runtime_hours ? ' · ' + l.runtime_hours + 'h' : ''}</div></div></div>`).join('') || '<div class="muted">No logs yet</div>';
  const b = modal(`<div class="card" style="background:var(--brand-l);border:none"><div class="row between"><b>Total diesel</b><b>${data.diesel_total.litres || 0} L · ${ngn(data.diesel_total.cost || 0)}</b></div></div>
    <div class="grid2" style="margin:10px 0"><button class="btn sm" id="logDiesel">⛽ Add diesel</button><button class="btn ghost sm" id="logMaint">🔧 Maintenance</button></div>
    <div class="section-title" style="margin-left:0">History</div>${logs}`, { title: g.name, sub: `${g.fuel_type}${g.make_model ? ' · ' + g.make_model : ''}` });
  $('#logDiesel', b).onclick = () => genLogForm(id, 'DIESEL');
  $('#logMaint', b).onclick = () => genLogForm(id, 'MAINTENANCE');
}
function genLogForm(id, type) {
  const isD = type === 'DIESEL';
  const f = modal(`<form id="lf"><label class="fl">Date</label><input class="input" id="l-date" type="date" value="${today()}"/>
    ${isD ? `<div class="grid2"><div><label class="fl">Litres</label><input class="input" id="l-litres" type="number" inputmode="decimal"/></div><div><label class="fl">Cost (₦)</label><input class="input" id="l-cost" type="number" inputmode="decimal"/></div></div><label class="fl">Runtime hours (optional)</label><input class="input" id="l-hours" type="number" inputmode="decimal"/>`
    : `<label class="fl">Maintenance detail</label><textarea class="input" id="l-detail" rows="3" placeholder="What was done / required"></textarea><label class="fl">Cost (₦, optional)</label><input class="input" id="l-cost" type="number" inputmode="decimal"/>`}
    <div style="height:14px"></div><button class="btn" type="submit">Save ${isD ? 'diesel' : 'maintenance'}</button></form>`, { title: isD ? 'Add diesel' : 'Maintenance' });
  $('#lf', f).onsubmit = async (e) => { e.preventDefault();
    const body = { type, log_date: $('#l-date', f).value, cost: +($('#l-cost', f) && $('#l-cost', f).value) || null };
    if (isD) { body.litres = +$('#l-litres', f).value || null; body.runtime_hours = +($('#l-hours', f) && $('#l-hours', f).value) || null; } else { body.detail = $('#l-detail', f).value.trim(); }
    try { await api('/generators/' + id + '/logs?tenant=' + State.tenant, { method: 'POST', body }); toast('Logged', 'ok'); closeModal(); }
    catch (er) { toast(er.message, 'err'); } };
}

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
  const greeting = aiHistory.length ? '' : (active()
    ? `<div class="bub sys">Ask me anything about ${esc(active().name)} — live sales, expenses, payroll, staff, generators or reports, for any site or date. e.g. “Tell me about Swali today”.</div>`
    : `<div class="bub sys">Pick a company at the top, then ask me anything about its sales, staff, expenses or reports.</div>`);
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
      const r = await api(scoped('/ai/chat'), { method: 'POST', body: { message: q, history: aiHistory.slice(0, -1) } });
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

/* ── STAFF CHAT (WhatsApp-style; team + per-site channels; offline-safe) ────── */
const chatOutbox = () => lsGet('daybook_chat_outbox', []);
const setChatOutbox = (a) => localStorage.setItem('daybook_chat_outbox', JSON.stringify(a));
const ChatUI = { open: false, channel: 'team', last: 0, timer: null, channels: [] };
function mountChat() {
  const btn = $('#chatBtn'); if (!btn) return;
  btn.classList.remove('hidden'); btn.onclick = openChat;
}
async function openChat() {
  try { ChatUI.channels = await api(scoped('/chat/channels')); }
  catch { ChatUI.channels = [{ id: 'team', name: 'Team', kind: 'team' }]; }
  if (!ChatUI.channels.find((c) => c.id === ChatUI.channel)) ChatUI.channel = 'team';
  const chips = ChatUI.channels.map((c) => `<button class="chan ${c.id === ChatUI.channel ? 'on' : ''}" data-ch="${c.id}">${c.kind === 'team' ? '👥 ' : '📍 '}${esc(c.name)}</button>`).join('');
  const body = modal(`
    <div class="chan-bar" id="chanBar">${chips}</div>
    <div class="chat" id="cChat"><div class="skel"></div></div>
    <div class="chat-input">
      <textarea class="input" id="cInput" rows="1" placeholder="Message your team…"></textarea>
      <button class="btn" id="cSend" style="width:auto;padding:13px 16px">➤</button>
    </div>`, { title: '💬 Staff chat', sub: active() ? active().name : '' });
  ChatUI.open = true; ChatUI.last = 0;
  const chat = $('#cChat', body), input = $('#cInput', body), send = $('#cSend', body);
  $$('#chanBar .chan', body).forEach((c) => c.onclick = () => { ChatUI.channel = c.dataset.ch; ChatUI.last = 0; chat.innerHTML = ''; $$('#chanBar .chan', body).forEach((x) => x.classList.toggle('on', x === c)); loadChat(chat, true); });
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; };
  input.oninput = grow;
  const submit = async () => {
    const txt = input.value.trim(); if (!txt) return;
    input.value = ''; grow();
    const cuid = uuidv4();
    appendMsgs(chat, [{ id: cuid, body: txt, user_name: 'You', mine: true, created_at: Math.floor(Date.now() / 1000), pending: true }]);
    const payload = { channel: ChatUI.channel, body: txt, client_uid: cuid };
    try {
      await api(scoped('/chat/messages'), { method: 'POST', body: payload });
      const node = $(`[data-mid="${cuid}"]`, chat); if (node) node.classList.remove('pending');
    } catch (e) {
      if (isNetErr(e)) { const o = chatOutbox(); o.push({ tenant: State.tenant, payload }); setChatOutbox(o); toast('Offline — message queued', 'info'); }
      else toast(e.message, 'err');
    }
  };
  send.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };
  chat.innerHTML = '';
  await loadChat(chat, true);
  // Mark chat notifications read on open.
  api(scoped('/notifications/read'), { method: 'POST', body: {} }).then(pollNotifs).catch(() => {});
  clearInterval(ChatUI.timer);
  ChatUI.timer = setInterval(() => { if (ChatUI.open && $('#cChat')) loadChat($('#cChat'), false); else { clearInterval(ChatUI.timer); ChatUI.open = false; } }, 4000);
  setTimeout(() => input.focus(), 100);
}
async function loadChat(chat, scrollEnd) {
  try {
    const msgs = await api(scoped(`/chat/messages?channel=${encodeURIComponent(ChatUI.channel)}&since=${ChatUI.last}`));
    if (msgs.length) { ChatUI.last = msgs[msgs.length - 1].created_at; appendMsgs(chat, msgs, scrollEnd); }
    else if (scrollEnd && !chat.children.length) chat.innerHTML = '<div class="bub sys">No messages yet — say hello 👋</div>';
  } catch (e) { if (scrollEnd && !chat.children.length) chat.innerHTML = `<div class="bub sys">${esc(isNetErr(e) ? 'Offline — messages will load when reconnected.' : e.message)}</div>`; }
}
const clock = (s) => new Date((s || 0) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function appendMsgs(chat, msgs, scrollEnd = true) {
  const sys = $('.bub.sys', chat); if (sys) sys.remove();
  for (const m of msgs) {
    if (m.id && $(`[data-mid="${m.id}"]`, chat)) continue;
    chat.insertAdjacentHTML('beforeend', `<div class="msg ${m.mine ? 'me' : ''} ${m.pending ? 'pending' : ''}" data-mid="${m.id || ''}">${m.mine ? '' : `<div class="who">${esc(m.user_name || '')}</div>`}<div class="bub ${m.mine ? 'u' : 'a'}">${esc(m.body)}</div><div class="tm">${clock(m.created_at)}</div></div>`);
  }
  if (scrollEnd) chat.scrollTop = chat.scrollHeight;
}
async function syncChatOutbox() {
  if (!State.token || !State.online) return;
  const o = chatOutbox(); if (!o.length) return;
  const remain = [];
  for (const it of o) { try { await api('/chat/messages?tenant=' + it.tenant, { method: 'POST', body: it.payload }); } catch { remain.push(it); } }
  setChatOutbox(remain);
}

/* ── NOTIFICATIONS (bell) ──────────────────────────────── */
function mountNotifications() {
  const btn = $('#bellBtn'); if (!btn) return;
  btn.classList.remove('hidden'); btn.onclick = openNotifs;
  clearInterval(State.notifTimer);
  State.notifTimer = setInterval(() => { if (State.online && State.token) pollNotifs(); }, 30000);
}
async function pollNotifs() {
  try {
    const r = await api(scoped('/notifications'));
    State.notifs = r.list || [];
    const badge = $('#bellBadge'); if (!badge) return;
    badge.textContent = r.unread > 99 ? '99+' : r.unread;
    badge.classList.toggle('hidden', !r.unread);
  } catch { /* offline — leave as-is */ }
}
async function openNotifs() {
  const body = modal('<div id="ntfList"><div class="skel"></div></div>', { title: '🔔 Notifications' });
  let r; try { r = await api(scoped('/notifications')); } catch (e) { $('#ntfList', body).innerHTML = `<div class="empty">${esc(isNetErr(e) ? 'Offline' : e.message)}</div>`; return; }
  const list = r.list || [];
  $('#ntfList', body).innerHTML = list.length ? list.map((n) => `
    <button class="ntf ${n.read ? '' : 'unread'}" data-link="${esc(n.link || '')}">
      <div class="ntf-ic">${n.type === 'chat' ? '💬' : n.type === 'report' ? '🧾' : '🔔'}</div>
      <div class="ntf-tx"><div class="ntf-t">${esc(n.title || '')}</div><div class="ntf-b">${esc(n.body || '')}</div><div class="ntf-d">${timeAgo(n.created_at)}</div></div>
    </button>`).join('') : '<div class="empty">No notifications yet.</div>';
  $$('#ntfList .ntf', body).forEach((el) => el.onclick = () => {
    const link = el.dataset.link || '';
    closeModal();
    if (link.startsWith('chat:')) { ChatUI.channel = link.slice(5) || 'team'; openChat(); }
    else if (link) go(link);
  });
  if (r.unread) api(scoped('/notifications/read'), { method: 'POST', body: {} }).then(pollNotifs).catch(() => {});
}
function timeAgo(s) {
  const d = Math.floor(Date.now() / 1000) - (s || 0);
  if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago'; return Math.floor(d / 86400) + 'd ago';
}

/* ── start ───────────────────────────────────────────── */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
initGoogle();
if (State.token) boot().catch(() => logout());
