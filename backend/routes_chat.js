/**
 * Daybook — Staff chat (1-to-1 direct messages)
 *
 * Realtime delivery rides the existing WS gateway (realtime.js): a sent message
 * is pushed to the recipient's live sockets + the sender's other devices, and
 * presence (online/offline) is broadcast by the gateway. This table is the
 * durable history + unread source. Broadcast/group channels come later.
 *
 * Mounted at /api/chat
 */
'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');
const { requireAuth, contextFor, requestedTenant } = require('./auth');
const { sendToUsers, usersOnline } = require('./realtime');

const router = express.Router();
const nowS = () => Math.floor(Date.now() / 1000);

// Resolve the caller's membership in the requested tenant (any active member may chat).
async function chatCtx(req, res) {
  const tid = requestedTenant(req);
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  const c = await contextFor(req.user, tid);
  if (!c) { res.status(403).json({ error: 'no access' }); return null; }
  return { tenant_id: tid, me: req.user.id };
}

// Roster: every active member of the tenant (except me) with online state + the
// number of unread messages they've sent me + last message preview/time.
router.get('/users', requireAuth, async (req, res) => {
  const ctx = await chatCtx(req, res); if (!ctx) return;
  const { tenant_id, me } = ctx;
  const rows = await qall(
    `SELECT u.id, u.name, u.email, m.role, s.name AS site_name
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN sites s ON s.id = m.site_id
      WHERE m.tenant_id = ? AND m.status = 'ACTIVE' AND u.id <> ?
      ORDER BY u.name NULLS LAST, u.email`, [tenant_id, me]);
  const unread = await qall(
    `SELECT from_user, COUNT(*)::int n, MAX(created_at) last_at
       FROM chat_messages WHERE tenant_id = ? AND to_user = ? AND read_at IS NULL
       GROUP BY from_user`, [tenant_id, me]);
  const last = await qall(
    `SELECT CASE WHEN from_user = ? THEN to_user ELSE from_user END AS other,
            MAX(created_at) last_at
       FROM chat_messages
      WHERE tenant_id = ? AND (from_user = ? OR to_user = ?)
      GROUP BY other`, [me, tenant_id, me, me]);
  const unreadBy = Object.fromEntries(unread.map((r) => [r.from_user, r.n]));
  const lastBy = Object.fromEntries(last.map((r) => [r.other, Number(r.last_at)]));
  const online = new Set(usersOnline(tenant_id));

  // Always surface anyone I have a conversation with OR who has sent me an unread
  // message, even if they're no longer an active member — otherwise an unread
  // count could exist with no row to open (the "1 unread but nothing shows" bug).
  const known = new Set(rows.map((u) => u.id));
  const extraIds = [...new Set([...last.map((r) => r.other), ...unread.map((r) => r.from_user)])]
    .filter((id) => id && !known.has(id));
  let extra = [];
  if (extraIds.length) {
    extra = await qall(`SELECT id, name, email FROM users WHERE id IN (${extraIds.map(() => '?').join(',')})`, extraIds);
  }
  const all = [...rows, ...extra.map((u) => ({ ...u, role: null, site_name: null }))];

  const list = all.map((u) => ({
    id: u.id, name: u.name || u.email, role: u.role, site_name: u.site_name || null,
    online: online.has(u.id), unread: unreadBy[u.id] || 0, last_at: lastBy[u.id] || null,
  })).sort((a, b) => (b.unread - a.unread) || ((b.last_at || 0) - (a.last_at || 0)));
  res.json({ users: list, online: [...online] });
});

// Total unread + per-sender counts — powers the Nav badge.
router.get('/unread', requireAuth, async (req, res) => {
  const ctx = await chatCtx(req, res); if (!ctx) return;
  const rows = await qall(
    `SELECT from_user, COUNT(*)::int n FROM chat_messages
      WHERE tenant_id = ? AND to_user = ? AND read_at IS NULL GROUP BY from_user`,
    [ctx.tenant_id, ctx.me]);
  res.json({ total: rows.reduce((a, r) => a + r.n, 0), by_user: Object.fromEntries(rows.map((r) => [r.from_user, r.n])) });
});

// Conversation history with one user (oldest→newest); marks their msgs read.
router.get('/thread/:userId', requireAuth, async (req, res) => {
  const ctx = await chatCtx(req, res); if (!ctx) return;
  const { tenant_id, me } = ctx;
  const other = req.params.userId;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
  const rows = await qall(
    `SELECT * FROM (
        SELECT id, from_user, to_user, body, created_at, read_at, reply_to, reply_excerpt, reply_from, client_uid FROM chat_messages
         WHERE tenant_id = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))
         ORDER BY created_at DESC LIMIT ?
     ) t ORDER BY created_at ASC`,
    [tenant_id, me, other, other, me, limit]);
  // Mark their messages to me as read, and tell them (read receipts).
  const upd = await qrun(
    `UPDATE chat_messages SET read_at = ? WHERE tenant_id = ? AND from_user = ? AND to_user = ? AND read_at IS NULL`,
    [nowS(), tenant_id, other, me]);
  if (upd.rowCount) sendToUsers(tenant_id, [other], 'chat.read', { by: me, at: nowS() });
  await clearChatNotices(tenant_id, me, other);
  res.json({ messages: rows.map((m) => ({ ...m, created_at: Number(m.created_at), read_at: m.read_at ? Number(m.read_at) : null })) });
});

// Send a DM → persist + push to recipient and the sender's other devices.
router.post('/send', requireAuth, async (req, res) => {
  const ctx = await chatCtx(req, res); if (!ctx) return;
  const { tenant_id, me } = ctx;
  const to = (req.body && req.body.to) || '';
  const body = ((req.body && req.body.body) || '').toString().trim();
  if (!to || !body) return res.status(400).json({ error: 'recipient and message required' });
  if (to === me) return res.status(400).json({ error: 'cannot message yourself' });
  // Recipient must be a member of this tenant (any status — you can still reply
  // to a disabled member) OR someone you already have a conversation with.
  const member = await qone(`SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ?`, [tenant_id, to]);
  if (!member) {
    const convo = await qone(
      `SELECT 1 FROM chat_messages WHERE tenant_id = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)) LIMIT 1`,
      [tenant_id, me, to, to, me]);
    if (!convo) return res.status(404).json({ error: 'recipient not found' });
  }
  // Optional reply/quote: the quoted message must belong to this conversation.
  let reply_to = null, reply_excerpt = null, reply_from = null;
  const replyId = req.body && req.body.reply_to;
  if (replyId) {
    const q = await qone(
      `SELECT id, body, from_user FROM chat_messages
        WHERE id = ? AND tenant_id = ? AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))`,
      [replyId, tenant_id, me, to, to, me]);
    if (q) { reply_to = q.id; reply_excerpt = String(q.body || '').slice(0, 120); reply_from = q.from_user; }
  }
  const client_uid = (req.body && req.body.client_uid) ? String(req.body.client_uid).slice(0, 64) : null;
  const id = uuid();
  const at = nowS();
  // Idempotent: a queued-then-retried message (same client_uid) inserts once.
  const ins = await qrun(
    `INSERT INTO chat_messages (id, tenant_id, from_user, to_user, body, created_at, reply_to, reply_excerpt, reply_from, client_uid)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tenant_id, client_uid) WHERE client_uid IS NOT NULL DO NOTHING`,
    [id, tenant_id, me, to, body.slice(0, 4000), at, reply_to, reply_excerpt, reply_from, client_uid]);
  if (!ins.rowCount && client_uid) {
    // Already delivered on a previous attempt — return the stored row, don't re-push.
    const ex = await qone(`SELECT * FROM chat_messages WHERE tenant_id=? AND client_uid=?`, [tenant_id, client_uid]);
    if (ex) return res.json({ ...ex, created_at: Number(ex.created_at), read_at: ex.read_at ? Number(ex.read_at) : null });
  }
  const msg = { id, tenant_id, from_user: me, to_user: to, body: body.slice(0, 4000), created_at: at, read_at: null, reply_to, reply_excerpt, reply_from, client_uid };
  sendToUsers(tenant_id, [to, me], 'chat.message', msg);   // recipient + sender's other tabs

  // If the recipient is offline, drop a notification into their in-app inbox
  // (Activity). Collapse per-sender so they get one "New message from X", not a
  // flood. Online users already see the live message + badge, so skip them.
  if (!new Set(usersOnline(tenant_id)).has(to)) {
    const fromName = req.user.name || req.user.email || 'A teammate';
    const title = `New message from ${fromName}`;
    await qrun(`DELETE FROM notifications WHERE user_id=? AND type='chat' AND title=? AND read=0`, [to, title]).catch(() => {});
    await qrun(`INSERT INTO notifications (id,tenant_id,user_id,type,title,body,link) VALUES (?,?,?,?,?,?,?)`,
      [uuid(), tenant_id, to, 'chat', title, body.slice(0, 120), 'chat']).catch(() => {});
  }
  res.status(201).json(msg);
});

// Mark the in-app inbox notifications from `otherId` as read (called when the
// recipient opens that conversation), so the Activity bell clears too.
async function clearChatNotices(tenant_id, me, otherId) {
  const o = await qone('SELECT name, email FROM users WHERE id=?', [otherId]).catch(() => null);
  if (!o) return;
  const title = `New message from ${o.name || o.email}`;
  await qrun(`UPDATE notifications SET read=1 WHERE user_id=? AND type='chat' AND title=? AND read=0`, [me, title]).catch(() => {});
}

// Explicit mark-read (e.g. swipe to clear) without loading the thread.
router.post('/read/:userId', requireAuth, async (req, res) => {
  const ctx = await chatCtx(req, res); if (!ctx) return;
  const { tenant_id, me } = ctx;
  const other = req.params.userId;
  const upd = await qrun(
    `UPDATE chat_messages SET read_at = ? WHERE tenant_id = ? AND from_user = ? AND to_user = ? AND read_at IS NULL`,
    [nowS(), tenant_id, other, me]);
  if (upd.rowCount) sendToUsers(tenant_id, [other], 'chat.read', { by: me, at: nowS() });
  await clearChatNotices(tenant_id, me, other);
  res.json({ cleared: upd.rowCount || 0 });
});

module.exports = router;
