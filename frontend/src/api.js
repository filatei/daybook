/** Daybook API client — mirrors the vanilla JS api() helper */

let _tenant = null;
let _token = null;

export function setToken(t) { _token = t; }
export function getToken() { return _token; }
export function setActiveTenant(id) { _tenant = id; }
export function getActiveTenant() { return _tenant; }

/** Append ?tenant=<id> to paths that need workspace scoping. The virtual
 *  "Group" workspace (__group__) is not a real tenant, so it is never sent —
 *  group views fetch each member tenant explicitly instead. */
export function scoped(path) {
  if (!_tenant || _tenant === '__group__') return path;
  return path + (path.includes('?') ? '&' : '?') + 'tenant=' + _tenant;
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (_token) headers['Authorization'] = 'Bearer ' + _token;
  let bodyData;
  if (form) {
    bodyData = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyData = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, { method, headers, body: bodyData });
  const json = await res.json().catch(() => ({}));
  // Session expired/invalid → tell the app to sign the user out cleanly instead
  // of leaving every action failing with a generic error for the rest of the day.
  if (res.status === 401 && !path.startsWith('/auth/')) {
    try { window.dispatchEvent(new CustomEvent('daybook-session-expired')); } catch { /* ignore */ }
  }
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status, code: json.code });
  return json;
}

export const isNetErr = (e) =>
  !navigator.onLine || /failed to fetch|networkerror|load failed|fetch failed/i.test(e?.message || '');

// ── Receipt deep-link / install URL ───────────────────────────────────────────
// The QR printed on a receipt encodes a full URL so that a customer scanning it
// with their phone camera is taken to daybook.torama.money (Chrome opens it),
// where they're prompted to install the app. Internally the gate scanner pulls
// the receipt number back out of the same URL, so one QR serves both.
export const RECEIPT_BASE = 'https://daybook.torama.money';
export const receiptUrl = (no) => `${RECEIPT_BASE}/?r=${encodeURIComponent(String(no || ''))}`;
// Extract a receipt number from a scanned value (a bare number, a URL with ?r=,
// or any string containing digits).
export const receiptFromValue = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/[?&]r=([^&#\s]+)/i);
  if (m) { const dec = decodeURIComponent(m[1]); const d = dec.match(/\d+/g); return d ? d.join('') : dec; }
  const d = s.match(/\d+/g);
  return d ? d.join('') : s;
};

export const ngn = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });
export const today = () => new Date().toISOString().slice(0, 10);
export const timeAgo = (s) => {
  if (!s) return '';
  const d = Math.floor(Date.now() / 1000 - s);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
};
export const uuidv4 = () =>
  crypto.randomUUID?.() || 'xxxxxxxxxxxx4xxxyxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
