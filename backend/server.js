/**
 * Daybook — Express entry point
 *
 * Runs in its own container (port 8090). Apache proxies daybook.torama.money
 * to it. Serves the PWA frontend + REST API from one process.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

function mustEnv(name, hint) {
  if (!process.env[name]) { console.error(`[FATAL] missing env ${name} — ${hint}`); process.exit(1); }
}
mustEnv('JWT_SECRET', 'HS256 session signing key. Generate: openssl rand -hex 32');
if (!process.env.GOOGLE_CLIENT_ID) console.warn('[WARN] GOOGLE_CLIENT_ID not set — Google sign-in will be disabled until it is configured.');

const { getDb } = require('./db');
const { ensureSeed } = require('./seed');

getDb();
ensureSeed(); // first-boot: superadmins + Fido/Fiafia tenants & sites if DB empty

const api = require('./routes');

const PORT = process.env.PORT || 8090;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// tiny cookie parser (only needs daybook_token; express.res.cookie/clearCookie are built in)
app.use((req, _res, next) => {
  req.cookies = {};
  const c = req.headers.cookie;
  if (c) for (const part of c.split(';')) { const i = part.indexOf('='); if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  next();
});

// keep the raw body so payment webhooks can verify their HMAC signatures; the
// larger limit accommodates attendance photo + signature captures (base64).
app.use(express.json({ limit: '6mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// security headers
app.use((_req, res, next) => {
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'daybook' }));

app.use('/api', api);

// ── static PWA frontend ────────────────────────────────────────────────────
const FRONTEND = path.join(__dirname, '../frontend');
// The service worker must always be revalidated so code updates are detected
// immediately (no stale worker held for up to an hour in the HTTP cache).
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript').sendFile(path.join(FRONTEND, 'sw.js'));
});
app.use(express.static(FRONTEND, { maxAge: '1h', index: false }));
// SPA fallback (everything not /api or a real file → index.html). index.html is
// no-cache so it always points at the current service worker / shell.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(FRONTEND, 'index.html'));
});

// multer + generic error handler
app.use((err, _req, res, _next) => {
  if (err) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(code).json({ error: err.message || 'request error' });
  }
});

app.listen(PORT, () => {
  console.log(`[Daybook] listening on :${PORT} (${process.env.NODE_ENV || 'development'})`);
  try { require('./scheduler').start(); } catch (e) { console.error('[sync] scheduler not started:', e.message); }
});
