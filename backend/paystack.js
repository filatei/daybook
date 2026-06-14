/* Paystack gateway client (fallback NGN rail; primary is Monnify).
 * Same env var names as every other Torama app. Charges in kobo. */
'use strict';
const crypto = require('crypto');

const SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || '';
const BASE = 'https://api.paystack.co';

const paystackEnabled = () => !!SECRET;

async function ps(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) throw new Error(json.message || `Paystack error ${res.status}`);
  return json.data;
}

// Create a hosted-checkout transaction. amountKobo in kobo. Channels mirror Otuburu.
// When `plan` (a Paystack plan code) is set, Paystack creates an auto-renewing
// subscription from this first charge.
function initTransaction({ email, amountKobo, reference, currency, metadata, callback_url, label, plan }) {
  const body = {
    email, amount: amountKobo, reference, currency: currency || 'NGN', metadata, callback_url,
    channels: ['card', 'bank', 'ussd', 'bank_transfer'],
    label: label || 'Daybook subscription',
  };
  if (plan) body.plan = plan;               // → recurring subscription (amount comes from the plan)
  return ps('/transaction/initialize', { method: 'POST', body });
}

// Create (or return) a recurring Plan. interval: 'monthly' | 'annually'.
const createPlan = ({ name, amountKobo, interval }) =>
  ps('/plan', { method: 'POST', body: { name, amount: amountKobo, interval, currency: 'NGN' } });

// Disable a subscription (needs the subscription code + email token).
const disableSubscription = ({ code, token }) =>
  ps('/subscription/disable', { method: 'POST', body: { code, token } });

const verifyTransaction = (reference) => ps(`/transaction/verify/${encodeURIComponent(reference)}`);

// Validate the x-paystack-signature header (HMAC-SHA512 of the raw body).
function verifySignature(rawBody, signature) {
  if (!SECRET || !signature || !rawBody) return false;
  const digest = crypto.createHmac('sha512', SECRET).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature)); } catch { return false; }
}

module.exports = { paystackEnabled, initTransaction, createPlan, disableSubscription, verifyTransaction, verifySignature, PUBLIC };
