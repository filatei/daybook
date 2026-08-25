/**
 * Web Push (VAPID) — native notifications for the Daybook PWA / TWA on Android.
 *
 * Subscriptions live in push_subscriptions (one row per browser endpoint).
 * sendPushToUser() fans a payload out to every endpoint a user has registered
 * and prunes endpoints the push service reports as gone (404/410).
 *
 * Config (env):
 *   VAPID_PUBLIC_KEY   — safe to expose; the frontend needs it to subscribe.
 *   VAPID_PRIVATE_KEY  — SECRET; must be set in production for sends to work.
 *   VAPID_SUBJECT      — mailto: or https: contact, default mailto:support@torama.money
 *
 * Payload shape (all fields optional except title/body are filled with defaults):
 *   { title, body, type, link, url, data, promptInstall }
 *   - link / url: relative path the SW opens on click (e.g. /?go=reports)
 *   - data: extra deep-link fields (reportId, expenseId, channel, …)
 *   - promptInstall: when true (default), append &install=1 so the web app can
 *     surface the PWA install banner after open (browsers cannot force-install)
 */
'use strict';
const webpush = require('web-push');
const { qall, qrun } = require('./db');

// The public key is not a secret — a default keeps dev working out of the box.
// In production set BOTH keys from the same generated pair (npx web-push generate-vapid-keys).
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY
  || 'BFi_-1wkBAaFyd7I8AZu-nh2qaHJ6gjIh3i8brhwKGWQtcfuxbLQMkWDhGTthUakuEE0Q8tW6c9-ocUQwzj-UE8';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@torama.money';

let _enabled = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    _enabled = true;
  } catch (e) {
    console.error('[push] VAPID setup failed:', e.message);
  }
} else {
  console.warn('[push] VAPID_PRIVATE_KEY not set — push sends are disabled (in-app notifications still work).');
}

function pushEnabled() { return _enabled; }
function getPublicKey() { return VAPID_PUBLIC_KEY; }

// Upsert a subscription for a user. body = { endpoint, keys:{p256dh,auth} }.
async function saveSubscription(userId, sub, ua) {
  if (!userId || !sub || !sub.endpoint || !sub.keys) return false;
  await qrun(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, ua)
     VALUES (?,?,?,?,?)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth, ua = EXCLUDED.ua`,
    [sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, ua || null],
  );
  return true;
}

async function removeSubscription(endpoint) {
  if (!endpoint) return;
  await qrun('DELETE FROM push_subscriptions WHERE endpoint=?', [endpoint]);
}

/** Build the relative open path for notification click (SPA deep-link). */
function buildClickPath(payload) {
  let path = payload.url || payload.link || '/';
  if (path && !path.startsWith('/') && !/^https?:\/\//i.test(path)) {
    path = `/?go=${encodeURIComponent(path)}`;
  }
  const promptInstall = payload.promptInstall !== false;
  if (promptInstall && !/[?&]install=/.test(path)) {
    path += (path.includes('?') ? '&' : '?') + 'install=1';
  }
  return path;
}

// Fan a notification payload out to every endpoint registered for a user.
// Fails soft — never throws to callers.
async function sendPushToUser(userId, payload) {
  if (!_enabled || !userId) return;
  let subs;
  try {
    subs = await qall('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?', [userId]);
  } catch (e) {
    console.error('[push] load subs failed:', e.message);
    return;
  }
  if (!subs || !subs.length) return;

  const clickPath = buildClickPath(payload || {});
  const body = JSON.stringify({
    title: (payload && payload.title) || 'Daybook',
    body: (payload && payload.body) || '',
    link: clickPath,
    url: clickPath,
    type: (payload && payload.type) || 'general',
    promptInstall: !(payload && payload.promptInstall === false),
    data: (payload && payload.data) || {},
  });

  await Promise.all(subs.map(async (s) => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, body);
    } catch (err) {
      // 404/410 = the subscription is gone (uninstalled/expired) → prune it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(s.endpoint).catch(() => {});
      } else {
        console.error('[push] send failed:', err.statusCode || err.message);
      }
    }
  }));
}

module.exports = { pushEnabled, getPublicKey, saveSubscription, removeSubscription, sendPushToUser };
