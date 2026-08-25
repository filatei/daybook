/* Daybook service worker — Vite React PWA
   Strategy:
   - App shell (JS/CSS): cache-first after first load (Vite hashes = long-lived)
   - Navigation requests: network-first, fall back to cached /index.html (SPA)
   - /api/*: network-only (never cache)
   - Images / icons: stale-while-revalidate
*/
const CACHE = 'daybook-v5';
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

// Receive SKIP_WAITING message from the app
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
    data: {
      url,
      link: url,
      type: d.type || 'general',
      promptInstall: d.promptInstall !== false,
      ...(d.data && typeof d.data === 'object' ? d.data : {}),
    },
    tag: d.type || 'daybook',
    renotify: true,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // Limitation: browsers cannot force-install a PWA from a notification click.
  // Best effort — open the same-origin app URL (standalone if already installed;
  // otherwise the browser). When promptInstall is set, append ?install=1 so the
  // web app can surface beforeinstallprompt / More → Install.
  const nd = e.notification.data || {};
  const raw = nd.url || nd.link || '/';
  const targetUrl = (() => {
    try {
      const u = new URL(raw, self.registration.scope);
      if (nd.promptInstall !== false) u.searchParams.set('install', '1');
      return u.href;
    } catch (_) {
      return raw;
    }
  })();

  e.waitUntil((async () => {
    const scope = self.registration.scope;
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (!c.url || !c.url.startsWith(scope)) continue;
      if ('focus' in c) {
        try { if ('navigate' in c) await c.navigate(targetUrl); } catch (_) { /* some browsers block navigate */ }
        return c.focus();
      }
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});
