/* Payments abstraction — the canonical Torama pattern (same as VOTE/otuburu).
 * Monnify is the primary NGN rail; Paystack is the automatic fallback. Owns the
 * plan catalogue, pricing, provider selection, and the init/verify dispatch.
 * Lemon Squeezy (recurring) lives separately in lemonsqueezy.js. */
'use strict';
const paystack = require('./paystack');
const monnify = require('./monnify');

const CURRENCY = process.env.PAYMENT_CURRENCY || 'NGN';
const PREFER = (process.env.PAYMENT_PROVIDER || 'monnify').toLowerCase(); // 'monnify' | 'paystack'

// Monthly price per plan in major units (₦). Override via env (same names everywhere).
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

// The rail to use: configured preference when available, else the other as fallback.
function activeProvider() {
  if (PREFER === 'monnify') {
    if (monnify.monnifyConfigured()) return 'monnify';
    if (paystack.paystackEnabled()) return 'paystack';
  } else {
    if (paystack.paystackEnabled()) return 'paystack';
    if (monnify.monnifyConfigured()) return 'monnify';
  }
  return null;
}
const paymentsEnabled = () => activeProvider() !== null;

// Start a checkout on `provider`. Returns { url, providerReference }.
async function initGateway(provider, { email, customerName, reference, price, metadata, callback_url, label, description }) {
  if (provider === 'monnify') {
    const r = await monnify.initTransaction({
      amountMajor: price.naira, currency: CURRENCY, customerName: customerName || email, customerEmail: email,
      paymentReference: reference, paymentDescription: description || label, redirectUrl: callback_url,
    });
    return { url: r.checkoutUrl, providerReference: r.transactionReference };
  }
  const r = await paystack.initTransaction({ email, amountKobo: price.kobo, reference, currency: CURRENCY, metadata, callback_url, label });
  return { url: r.authorization_url, providerReference: reference };
}

// Authoritatively confirm a payment with its gateway. Returns { ok, raw }.
async function verifyGateway(provider, { reference, providerReference, amountNaira }) {
  if (provider === 'monnify') {
    if (!providerReference) return { ok: false, raw: 'missing_reference' };
    const s = await monnify.getTransactionStatus(providerReference);
    const ok = s.paid && s.amountPaidMajor >= amountNaira && (s.currency == null || s.currency === CURRENCY);
    return { ok, raw: s.raw };
  }
  const data = await paystack.verifyTransaction(reference);
  const ok = data && data.status === 'success' && Number(data.amount) >= amountNaira * 100 && (!data.currency || data.currency === CURRENCY);
  return { ok: !!ok, raw: (data && data.status) || 'failed', data };
}

module.exports = { CURRENCY, PLANS, planList, priceFor, activeProvider, paymentsEnabled, initGateway, verifyGateway, paystack, monnify };
