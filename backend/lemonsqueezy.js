/* Lemon Squeezy recurring-subscription rail — mirrors VOTE's subscriptions.ts,
 * mapped onto Daybook tenants. Same env var names across Torama apps. When an
 * LS subscription is active, the tenant is ACTIVE and paid_until tracks renews_at. */
'use strict';
const { createHmac, timingSafeEqual } = require('crypto');
const { getDb } = require('./db');

const LS_API = 'https://api.lemonsqueezy.com/v1';
const API_KEY = process.env.LEMONSQUEEZY_API_KEY || '';
const STORE_ID = process.env.LEMONSQUEEZY_STORE_ID || '';
const VARIANT_ID = process.env.LEMONSQUEEZY_VARIANT_ID || '';
const WEBHOOK_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
const PRICE_LABEL = process.env.SUBSCRIPTION_PRICE_LABEL || '$8 / month';
const SUBSCRIPTIONS_ENABLED = process.env.SUBSCRIPTIONS_ENABLED === '1' || process.env.SUBSCRIPTIONS_ENABLED === 'true';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

const lsConfigured = () => !!(API_KEY && STORE_ID && VARIANT_ID);
const subscriptionsEnabled = () => SUBSCRIPTIONS_ENABLED && lsConfigured();
const priceLabel = () => PRICE_LABEL;

const lsHeaders = (write) => ({
  Authorization: `Bearer ${API_KEY}`, Accept: 'application/vnd.api+json',
  ...(write ? { 'Content-Type': 'application/vnd.api+json' } : {}),
});

// Active access: active/on_trial, or cancelled/past_due but still inside the paid window.
function hasActiveSubscription(t) {
  const s = t.subscription_status;
  if (!s) return false;
  if (s === 'active' || s === 'on_trial') return true;
  if ((s === 'cancelled' || s === 'past_due') && t.subscription_ends_at) return t.subscription_ends_at * 1000 > Date.now();
  return false;
}

// Create a hosted LS checkout for this tenant; returns the URL to redirect to.
async function createCheckout({ tenantId, email }) {
  if (!subscriptionsEnabled()) return null;
  const body = { data: { type: 'checkouts', attributes: {
    checkout_data: { email, custom: { tenant_id: String(tenantId) } },
    product_options: { redirect_url: `${PUBLIC_BASE_URL}/?sub=success` },
  }, relationships: {
    store: { data: { type: 'stores', id: String(STORE_ID) } },
    variant: { data: { type: 'variants', id: String(VARIANT_ID) } },
  } } };
  const resp = await fetch(`${LS_API}/checkouts`, { method: 'POST', headers: lsHeaders(true), body: JSON.stringify(body) });
  if (!resp.ok) throw new Error('Lemon Squeezy checkout failed');
  const json = await resp.json().catch(() => null);
  return (json && json.data && json.data.attributes && json.data.attributes.url) || null;
}

async function cancelSubscription(subscriptionId) {
  if (!API_KEY) return false;
  const resp = await fetch(`${LS_API}/subscriptions/${subscriptionId}`, { method: 'DELETE', headers: lsHeaders(false) });
  return resp.ok;
}

// Verify the LS X-Signature header (HMAC-SHA256 of the raw body).
function verifyWebhookSignature(raw, signature) {
  if (!WEBHOOK_SECRET || !raw) return false;
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(signature || '');
  return a.length === b.length && timingSafeEqual(a, b);
}

const toEpoch = (s) => (s ? Math.floor(new Date(s).getTime() / 1000) : null);

// Apply a subscription_* webhook to the matching tenant. Idempotent.
function applySubscriptionEvent(raw) {
  const db = getDb();
  const evt = JSON.parse(raw.toString('utf8'));
  const name = (evt.meta && evt.meta.event_name) || '';
  if (!name.startsWith('subscription')) return; // ignore order_*, etc.
  const attrs = (evt.data && evt.data.attributes) || {};
  let tenantId = evt.meta && evt.meta.custom_data && evt.meta.custom_data.tenant_id;
  if (!tenantId) return;
  const status = attrs.status || null;
  const ends = toEpoch(attrs.ends_at);
  const renews = toEpoch(attrs.renews_at);
  const active = status === 'active' || status === 'on_trial';
  // paid_until tracks renews_at while active, else ends_at (grace) — drives existing trial enforcement.
  const paid_until = active ? (renews || ends) : ends;
  db.prepare(`UPDATE tenants SET subscription_status=?, ls_subscription_id=?, subscription_renews_at=?, subscription_ends_at=?,
      customer_portal_url=COALESCE(?, customer_portal_url),
      paid_until=COALESCE(?, paid_until), status=CASE WHEN ? THEN 'ACTIVE' ELSE status END
    WHERE id=?`)
    .run(status, (evt.data && evt.data.id) || null, renews, ends,
      (attrs.urls && attrs.urls.customer_portal) || null, paid_until, active ? 1 : 0, tenantId);
}

module.exports = { lsConfigured, subscriptionsEnabled, priceLabel, createCheckout, cancelSubscription, verifyWebhookSignature, applySubscriptionEvent, hasActiveSubscription };
