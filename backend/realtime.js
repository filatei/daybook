/**
 * Realtime gateway — durable event log + WebSocket fan-out.
 *
 * emitEvent() writes an ordered event (BIGSERIAL seq) and pushes it to every
 * subscribed client. On (re)connect a client sends its last_seq and we replay
 * everything it missed from the events table — the MT5 resume protocol, so a
 * reconnecting gate/loading screen catches up without a full reload.
 *
 * Single container = in-process fan-out (no Redis/NOTIFY needed yet). When the
 * gateway is split out for scale, swap broadcast() for Redis pub/sub.
 */
'use strict';
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { qone, qall } = require('./db');
const { JWT_SECRET, contextFor, siteBound } = require('./auth');

const clients = new Set(); // { ws, tenant_id, site_id (null = all sites), alive }

// Persist + broadcast an event. site_id null = tenant-wide (visible to all sites).
async function emitEvent(tenant_id, site_id, type, payload) {
  if (!tenant_id || !type) return;
  try {
    const row = await qone('INSERT INTO events (tenant_id, site_id, type, payload) VALUES (?,?,?,?) RETURNING seq, created_at',
      [tenant_id, site_id || null, type, JSON.stringify(payload || {})]);
    broadcast({ seq: Number(row.seq), tenant_id, site_id: site_id || null, type, payload: payload || {}, created_at: Number(row.created_at) });
  } catch (e) { console.error('[rt] emit failed:', e.message); }
}

// A site manager sees their own site + tenant-wide events; GM/admin see all.
function visibleTo(c, e) {
  if (c.tenant_id !== e.tenant_id) return false;
  if (!c.site_id) return true;
  return e.site_id == null || e.site_id === c.site_id;
}
function broadcast(e) {
  const msg = JSON.stringify({ t: 'event', seq: e.seq, tenant_id: e.tenant_id, site_id: e.site_id, type: e.type, payload: e.payload, created_at: e.created_at });
  for (const c of clients) if (c.ws.readyState === 1 && visibleTo(c, e)) { try { c.ws.send(msg); } catch { /* dropped */ } }
}

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws, req) => {
    try {
      const url = new URL(req.url, 'http://x');
      const token = url.searchParams.get('token');
      const tenant = url.searchParams.get('tenant');
      const lastSeq = parseInt(url.searchParams.get('last_seq') || '0', 10) || 0;
      if (!token || !tenant) return ws.close(4001, 'auth');
      let claims; try { claims = jwt.verify(token, JWT_SECRET); } catch { return ws.close(4001, 'auth'); }
      const user = await qone('SELECT * FROM users WHERE id=?', [claims.sub]);
      if (!user || user.status !== 'ACTIVE') return ws.close(4001, 'auth');
      const ctx = await contextFor(user, tenant);
      if (!ctx) return ws.close(4003, 'no access');
      const site_id = siteBound(ctx) ? ctx.site_id : null;

      const client = { ws, tenant_id: tenant, site_id, alive: true };
      clients.add(client);
      ws.on('pong', () => { client.alive = true; });
      ws.on('close', () => clients.delete(client));
      ws.on('error', () => clients.delete(client));
      ws.send(JSON.stringify({ t: 'ready', tenant, site_id }));

      // Resume: replay missed events (scoped), capped so a long-dead client gets
      // a fresh baseline rather than a huge backlog.
      const where = ['tenant_id=?', 'seq>?'], args = [tenant, lastSeq];
      if (site_id) { where.push('(site_id=? OR site_id IS NULL)'); args.push(site_id); }
      const missed = await qall(`SELECT seq, site_id, type, payload, created_at FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT 1000`, args);
      for (const m of missed) ws.send(JSON.stringify({ t: 'event', seq: Number(m.seq), tenant_id: tenant, site_id: m.site_id, type: m.type, payload: m.payload, created_at: Number(m.created_at) }));
    } catch (e) { try { ws.close(1011); } catch { /* */ } }
  });

  // Heartbeat: ping every 25s; drop silently-dead sockets.
  const hb = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch { /* */ } clients.delete(c); continue; }
      c.alive = false; try { c.ws.ping(); } catch { /* */ }
    }
  }, 25000);
  wss.on('close', () => clearInterval(hb));
  return wss;
}

// Broadcast an ephemeral event WITHOUT persisting it (seq 0). Used for the
// high-frequency live fido feed — a reconnecting client re-baselines from
// /pos/range, so these don't need to live in the durable event log.
function broadcastLive(tenant_id, site_id, type, payload) {
  if (!tenant_id || !type) return;
  broadcast({ seq: 0, tenant_id, site_id: site_id || null, type, payload: payload || {}, created_at: Math.floor(Date.now() / 1000) });
}

module.exports = { attach, emitEvent, broadcastLive };
