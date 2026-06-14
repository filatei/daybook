/* Daybook service worker — Vite React PWA
   Strategy:
   - App shell (JS/CSS): cache-first after first load (Vite hashes = long-lived)
   - Navigation requests: network-first, fall back to cached /index.html (SPA)
   - /api/*: network-only (never cache)
   - Images / icons: stale-while-revalidate
*/
const CACHE = 'daybook-v1';
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
        .then((r) => { caches.open(CACHE).then((c) => c.put('/index.html', r.clone())); return r; })
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
          if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
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
