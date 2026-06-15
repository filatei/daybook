/**
 * Live fido feed — streams sales from the still-running fido.torama.ng POS to
 * connected Daybook dashboards in near-real-time, BEFORE cutover.
 *
 * Polls the fido Mongo (via the SSH tunnel / SALES_MONGO_URL) for orders created
 * since the last tick and broadcasts a `fido.sale` event to the matching tenant.
 * Events are ephemeral (broadcast-only) — the authoritative figures still come
 * from /pos/range, which a reconnecting client re-baselines from.
 */
'use strict';
const { qall } = require('./db');
const sales = require('./salesSource');
const { broadcastLive } = require('./realtime');

const POLL_MS = parseInt(process.env.LIVEFEED_POLL_MS || '12000', 10);
const SALE_STATUS = ['DELIVERED', 'PAID', 'LOADED', 'COMPLETED'];
const norm = (s) => String(s || '').toUpperCase().replace(/[\s\-_]+/g, '');
const num = (v) => { const n = typeof v === 'object' && v && '$numberDecimal' in v ? parseFloat(v.$numberDecimal) : Number(v); return isNaN(n) ? 0 : n; };

let lastSeen = new Date(Date.now() - 3 * 60 * 1000); // look back 3 min on first tick
let timer = null;

async function poll() {
  // fido site string → { tenant_id, site_id } for pos_source tenants only
  const siteRows = await qall("SELECT s.id, s.tenant_id, s.code, s.name FROM sites s JOIN tenants t ON t.id=s.tenant_id WHERE t.pos_source IS NOT NULL AND t.status='ACTIVE'");
  if (!siteRows.length) return;
  const siteMap = {};
  for (const s of siteRows) { siteMap[norm(s.code)] = s; siteMap[norm(s.name)] = s; }

  let db; try { db = await sales.getDb(); } catch { return; }
  const now = new Date();
  const rows = await db.collection('fidoorders')
    .find({ createdAt: { $gt: lastSeen, $lte: now }, status: { $in: SALE_STATUS } })
    .sort({ createdAt: 1 }).limit(500).toArray();
  for (const o of rows) {
    const site = siteMap[norm(o.site)];
    if (!site) continue;
    broadcastLive(site.tenant_id, site.id, 'fido.sale', {
      site: o.site, amount: num(o.txn_amount),
      customer: String(o.customerName || o.customer_name || '').trim() || null,
      payment_method: String(o.paymentMethod || 'CASH').toUpperCase(),
      products: Array.isArray(o.products) ? o.products.length : 0,
      at: o.createdAt, source: 'fido',
    });
  }
  lastSeen = now;
}

function start() {
  if (timer) return;
  if (!sales.salesEnabled || !sales.salesEnabled()) { console.log('[livefeed] disabled (no SALES_MONGO_URL)'); return; }
  console.log(`[livefeed] streaming live fido sales every ${POLL_MS}ms`);
  timer = setInterval(() => { poll().catch((e) => console.error('[livefeed]', e.message)); }, POLL_MS);
  poll().catch(() => {});
}

module.exports = { start };
