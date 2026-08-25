/* Daybook service worker — Vite React PWA
   Strategy:
   - App shell (JS/CSS): cache-first after first load (Vite hashes = long-lived)
   - Navigation requests: network-first, fall back to cached /index.html (SPA)
   - /api/*: network-only (never cache)
   - Images / icons: stale-while-revalidate
*/
const CACHE = 'daybook-v6';
const STATIC = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(STATIC.map((u) => fetch(u, { cache: 'reload' }).then((r) => r.ok ? c.put(u, r) : null).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept API calls or non-GET
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigation — SPA fallback to index.html
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); return r; })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Vite hashed assets (/assets/...) — cache-first
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((r) => {
          if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
          return r;
        });
      })
    );
    return;
  }

  // Stale-while-revalidate for icons and static
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(e.request);
      const fresh = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
      return cached || fresh;
    })
  );
});

// Receive SKIP_WAITING / deep-link messages from the app
self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// ── Web Push ────────────────────────────────────────────────────────────────
// Server sends { title, body, url|link, type, promptInstall }.
// Body may include \n — Android/Chrome show multi-line; iOS truncates.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  const title = d.title || 'Daybook';
  const url = d.url || d.link || '/';
  const options = {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // Spread extras first so url/link/type are never overwritten by payload.data.
    data: {
      ...(d.data && typeof d.data === 'object' ? d.data : {}),
      url,
      link: url,
      type: d.type || 'general',
      promptInstall: d.promptInstall !== false,
    },
    tag: d.type || 'daybook',
    renotify: true,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

/** Absolute https URL under this SW's scope (openWindow rejects relative URLs). */
function absoluteAppUrl(raw, { promptInstall } = {}) {
  const base = self.registration.scope || self.location.origin + '/';
  let u;
  try {
    u = new URL(raw || '/', base);
  } catch (_) {
    u = new URL('/', base);
  }
  // Stay same-origin / under scope — never open an API or external URL from a tap.
  const scopeOrigin = new URL(base).origin;
  if (u.origin !== scopeOrigin) {
    u = new URL('/', base);
  }
  if (promptInstall !== false) u.searchParams.set('install', '1');
  return u.href;
}

function sameOriginClient(client, scopeOrigin) {
  if (!client || !client.url) return false;
  try {
    return new URL(client.url).origin === scopeOrigin;
  } catch (_) {
    return false;
  }
}

/**
 * notificationclick: close, then focus a visible same-origin window (navigate /
 * postMessage) or openWindow(absoluteUrl).
 *
 * Android pitfall (esp. Chrome): matchAll often returns a *hidden* WindowClient
 * for a minimized/killed PWA. Focusing it can no-op or fail while openWindow is
 * never reached — notification dismisses, app stays closed. Prefer visible
 * clients; on focus/navigate failure always fall through to openWindow.
 */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  const nd = e.notification.data || {};
  const raw = nd.url || nd.link || '/';
  const targetUrl = absoluteAppUrl(raw, { promptInstall: nd.promptInstall });
  const scopeOrigin = new URL(self.registration.scope || self.location.origin + '/').origin;

  console.log('[sw] notificationclick', { raw, targetUrl, promptInstall: nd.promptInstall });

  e.waitUntil((async () => {
    let all = [];
    try {
      all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    } catch (err) {
      console.warn('[sw] matchAll failed', err);
    }
    console.log('[sw] window clients', all.map((c) => ({
      url: c.url, visibility: c.visibilityState, focused: c.focused,
    })));

    const ours = all.filter((c) => sameOriginClient(c, scopeOrigin));
    const visible = ours.find((c) => c.visibilityState === 'visible') || null;
    // Only trust a hidden client if we can focus it; otherwise openWindow
    // (Chrome Android reuses the installed standalone app for openWindow).
    const candidate = visible || ours[0] || null;

    if (candidate && 'focus' in candidate) {
      try {
        const focused = await candidate.focus();
        const client = focused || candidate;
        console.log('[sw] focused client', client && client.url);

        if (client && typeof client.navigate === 'function') {
          try {
            const nav = await client.navigate(targetUrl);
            console.log('[sw] navigate result', nav ? nav.url : null);
            if (nav) return nav;
          } catch (navErr) {
            console.warn('[sw] navigate failed, postMessage', navErr);
            try {
              client.postMessage({ type: 'DAYBOOK_NOTIFICATION_CLICK', url: targetUrl });
            } catch (_) { /* ignore */ }
          }
        } else if (client && 'postMessage' in client) {
          try {
            client.postMessage({ type: 'DAYBOOK_NOTIFICATION_CLICK', url: targetUrl });
          } catch (_) { /* ignore */ }
        }

        // If we had a visible client, focus(+message) is enough.
        if (visible) return client;
        // Hidden client: focus may have been a no-op on Android — still openWindow.
        console.log('[sw] no visible client after focus; openWindow fallback');
      } catch (focusErr) {
        console.warn('[sw] focus failed, openWindow fallback', focusErr);
      }
    }

    if (!clients.openWindow) {
      console.warn('[sw] clients.openWindow unavailable');
      return null;
    }

    try {
      const win = await clients.openWindow(targetUrl);
      console.log('[sw] openWindow', targetUrl, '→', win ? win.url : null);
      if (win) return win;
      // Some engines return null for query-heavy URLs; retry bare start_url.
      const fallback = absoluteAppUrl('/', { promptInstall: nd.promptInstall });
      if (fallback !== targetUrl) {
        console.log('[sw] openWindow null; retry', fallback);
        return clients.openWindow(fallback);
      }
      return null;
    } catch (openErr) {
      console.error('[sw] openWindow threw', openErr);
      return null;
    }
  })());
});
