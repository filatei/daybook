/** Daybook API client — mirrors the vanilla JS api() helper */

let _tenant = null;
let _token = null;

export function setToken(t) { _token = t; }
export function getToken() { return _token; }
export function setActiveTenant(id) { _tenant = id; }
export function getActiveTenant() { return _tenant; }

/** Append ?tenant=<id> to paths that need workspace scoping */
export function scoped(path) {
  if (!_tenant) return path;
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
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status, code: json.code });
  return json;
}

export const isNetErr = (e) =>
  !navigator.onLine || /failed to fetch|networkerror|load failed|fetch failed/i.test(e?.message || '');

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
