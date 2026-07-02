/* Daybook service worker — Vite React PWA
   Strategy:
   - App shell (JS/CSS): cache-first after first load (Vite hashes = long-lived)
   - Navigation requests: network-first, fall back to cached /index.html (SPA)
   - /api/*: network-only (never cache)
   - Images / icons: stale-while-revalidate
*/
const CACHE = 'daybook-v3';
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
// Server sends { title, body, link, type }. Show a notification; on click, focus
// an existing window (navigating it to the link) or open a new one.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data && e.data.text() }; }
  const title = d.title || 'Daybook';
  const options = {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { link: d.link || '/' },
    tag: d.type || 'daybook',
    renotify: true,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = (e.notification.data && e.notification.data.link) || '/';
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(link); } catch (_) {} return c.focus(); }
    }
    if (clients.openWindow) return clients.openWindow(link);
  })());
});
