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
const { v4: uuid } = require('uuid');
const { qall, qone, qrun } = require('./db');
const sales = require('./salesSource');
const { broadcastLive } = require('./realtime');

const POLL_MS = parseInt(process.env.LIVEFEED_POLL_MS || '12000', 10);
// Persist each new fido sale into pos_sales as it arrives (durable history for
// cutover). On by default; set LIVE_PERSIST=0 to disable (display-only feed).
const LIVE_PERSIST = process.env.LIVE_PERSIST !== '0';
const SALE_STATUS = ['DELIVERED', 'PAID', 'LOADED', 'COMPLETED'];
const norm = (s) => String(s || '').toUpperCase().replace(/[\s\-_]+/g, '');
const num = (v) => { const n = typeof v === 'object' && v && '$numberDecimal' in v ? parseFloat(v.$numberDecimal) : Number(v); return isNaN(n) ? 0 : n; };
const dateStrLagos = (d) => { try { return (d instanceof Date ? d : new Date(d)).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); } catch { return null; } };

/**
 * Upsert one live fido order into pos_sales — mirrors the ETL's order mapping so
 * live rows and nightly-ETL rows are identical and dedupe on (tenant_id, ext_id).
 * Returns true when a NEW row was inserted.
 */
async function persistSale(o, site) {
  const ext_id = String(o._id);
  const saleDate = dateStrLagos(o.createdAt); if (!saleDate) return false;
  const totalAmt = num(o.txn_amount);
  const pm = String(o.paymentMethod || 'CASH').toUpperCase();
  const custExt = o.customer ? String(o.customer) : null;
  let custId = null;
  if (custExt) { try { const c = await qone('SELECT id FROM customers WHERE tenant_id=? AND ext_id=?', [site.tenant_id, custExt]); custId = c ? c.id : null; } catch { /* ignore */ } }
  const custName = String(o.customerName || o.customer_name || '').trim() || null;
  const items = (Array.isArray(o.products) ? o.products : []).map((p) => ({
    name: String(p.name || 'Unknown'),
    qty: num(p.qty),
    price: num(p.price) || (num(p.amount) && num(p.qty) ? num(p.amount) / num(p.qty) : 0),
    amount: num(p.amount),
  }));
  const createdAt = Math.floor((o.createdAt instanceof Date ? o.createdAt.getTime() : (new Date(o.createdAt).getTime() || Date.now())) / 1000);
  const nrow = await qone('SELECT COALESCE(MAX(receipt_no),0)+1 n FROM pos_sales WHERE tenant_id=?', [site.tenant_id]);
  const receiptNo = parseInt(nrow.n, 10);
  const r = await qrun(
    `INSERT INTO pos_sales (id,tenant_id,site_id,receipt_no,customer_id,customer_name,items_json,
       subtotal,discount,total,payment_method,amount_paid,balance,status,sale_date,ext_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (tenant_id,ext_id) WHERE ext_id IS NOT NULL DO NOTHING`,
    [uuid(), site.tenant_id, site.id, receiptNo, custId, custName, JSON.stringify(items),
      totalAmt, 0, totalAmt, pm, totalAmt, 0, 'PAID', saleDate, ext_id, createdAt]);
  return !!r.rowCount;
}

// Look back on the first tick so a restart never misses recent sales (idempotent
// upsert de-dupes). Default 180 min; widen via LIVEFEED_LOOKBACK_MIN.
const LOOKBACK_MIN = parseInt(process.env.LIVEFEED_LOOKBACK_MIN || '180', 10);
let lastSeen = new Date(Date.now() - LOOKBACK_MIN * 60 * 1000);
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
    // Durable copy first (idempotent), then the ephemeral live broadcast.
    if (LIVE_PERSIST) { try { await persistSale(o, site); } catch (e) { console.error('[livefeed] persist:', e.message); } }
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
  console.log(`[livefeed] streaming live fido sales every ${POLL_MS}ms${LIVE_PERSIST ? ' + persisting to pos_sales' : ''}`);
  timer = setInterval(() => { poll().catch((e) => console.error('[livefeed]', e.message)); }, POLL_MS);
  poll().catch(() => {});
}

module.exports = { start };
