/* Monnify rail (primary NGN provider) — mirrors VOTE/otuburu's integration.
 * Monnify charges in MAJOR units (naira); Paystack uses kobo. Auth is HTTP-Basic
 * apiKey:secretKey → a bearer token cached in-memory until just before expiry.
 * Same env var names as the other Torama apps. */
'use strict';

const API_KEY = process.env.MONNIFY_API_KEY || '';
const SECRET_KEY = process.env.MONNIFY_SECRET_KEY || '';
const CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE || '';
const BASE = (process.env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com').replace(/\/+$/, '');

const monnifyConfigured = () => !!(API_KEY && SECRET_KEY && CONTRACT_CODE);

let cachedToken = null; // { token, expiresAt }
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token;
  const basic = Buffer.from(`${API_KEY}:${SECRET_KEY}`).toString('base64');
  const resp = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
  });
  const json = await resp.json().catch(() => null);
  const token = json && json.responseBody && json.responseBody.accessToken;
  if (!json || !json.requestSuccessful || !token) throw new Error('Monnify auth failed');
  const expiresInSec = Number(json.responseBody.expiresIn) || 3000;
  cachedToken = { token, expiresAt: now + expiresInSec * 1000 };
  return token;
}

async function authedFetch(path, init = {}) {
  const token = await getAccessToken();
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

// Initialise a hosted checkout. amountMajor is in naira. Returns { checkoutUrl, transactionReference, paymentReference }.
async function initTransaction({ amountMajor, currency, customerName, customerEmail, paymentReference, paymentDescription, redirectUrl }) {
  const resp = await authedFetch('/api/v1/merchant/transactions/init-transaction', {
    method: 'POST',
    body: JSON.stringify({
      amount: amountMajor, customerName, customerEmail, paymentReference, paymentDescription,
      currencyCode: currency, contractCode: CONTRACT_CODE, redirectUrl,
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD'],
    }),
  });
  const json = await resp.json().catch(() => null);
  const body = json && json.responseBody;
  if (!json || !json.requestSuccessful || !body || !body.checkoutUrl || !body.transactionReference) {
    throw new Error('Monnify init-transaction failed');
  }
  return { checkoutUrl: body.checkoutUrl, transactionReference: body.transactionReference, paymentReference: body.paymentReference || paymentReference };
}

// Authoritative status query by Monnify's transactionReference. Returns { paid, amountPaidMajor, currency, raw }.
async function getTransactionStatus(transactionReference) {
  const resp = await authedFetch(`/api/v2/transactions/${encodeURIComponent(transactionReference)}`, { method: 'GET' });
  const json = await resp.json().catch(() => null);
  const body = json && json.responseBody;
  const status = (body && body.paymentStatus) || 'UNKNOWN';
  return {
    paid: !!(json && json.requestSuccessful) && status === 'PAID',
    amountPaidMajor: Number(body && body.amountPaid) || 0,
    currency: (body && (body.currencyCode || body.currency)) || null,
    raw: status,
  };
}

module.exports = { monnifyConfigured, initTransaction, getTransactionStatus, SECRET_KEY };
