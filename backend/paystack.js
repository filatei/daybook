/* Paystack billing helper — checkout init, verify, webhook signature, pricing.
 * Test-ready: set PAYSTACK_SECRET_KEY (sk_test_… or sk_live_…) to switch on.
 * No money moves here — the customer pays on Paystack's hosted page; we only
 * initialise the transaction and react to the verified result. */
'use strict';
const crypto = require('crypto');

const SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || '';
const BASE = 'https://api.paystack.co';
const CURRENCY = process.env.PAYSTACK_CURRENCY || 'NGN';

const paystackEnabled = () => !!SECRET;

// Monthly price per plan, in the major currency unit (₦). Override via env.
const PLANS = {
  STANDARD: { name: 'Standard', price: parseInt(process.env.PRICE_STANDARD || '15000', 10),
    blurb: 'Daily reports, staff & generators, AI assistant' },
  PRO: { name: 'Pro', price: parseInt(process.env.PRICE_PRO || '40000', 10),
    blurb: 'Everything in Standard + in-app POS, receipts, payroll' },
};
const planList = () => Object.entries(PLANS).map(([code, p]) => ({ code, ...p, currency: CURRENCY }));
const priceFor = (plan, months) => {
  const p = PLANS[plan]; if (!p) return null;
  const m = Math.max(1, Math.min(24, parseInt(months, 10) || 1));
  return { naira: p.price * m, kobo: p.price * m * 100, months: m };
};

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

// Create a hosted-checkout transaction. Returns { authorization_url, reference }.
function initTransaction({ email, amountKobo, reference, metadata, callback_url }) {
  return ps('/transaction/initialize', {
    method: 'POST',
    body: { email, amount: amountKobo, reference, currency: CURRENCY, metadata, callback_url },
  });
}

// Confirm a transaction server-side (source of truth for "did they actually pay").
const verifyTransaction = (reference) => ps(`/transaction/verify/${encodeURIComponent(reference)}`);

// Validate the x-paystack-signature header (HMAC-SHA512 of the raw body, keyed by the secret).
function verifySignature(rawBody, signature) {
  if (!SECRET || !signature || !rawBody) return false;
  const digest = crypto.createHmac('sha512', SECRET).update(rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature)); } catch { return false; }
}

module.exports = { paystackEnabled, PLANS, planList, priceFor, initTransaction, verifyTransaction, verifySignature, CURRENCY, PUBLIC };
