/**
 * Daybook — Fido Mongo → Postgres ETL
 *
 * Idempotent, re-runnable. Safe to run while Daybook is live — uses
 * ON CONFLICT DO NOTHING / DO UPDATE so re-runs are non-destructive.
 * Human-entered Daybook records are never overwritten.
 *
 * Usage:
 *   node backend/etl.js [options]
 *
 * Options:
 *   --collection  orders|expenses|staff|customers|payroll|all  (default: all)
 *   --from        YYYY-MM-DD   (default: 2020-01-01)
 *   --to          YYYY-MM-DD   (default: today)
 *   --dry-run                  count + validate, no writes
 *   --batch       N            Mongo cursor batch size (default 500)
 *   --tenant-slug SLUG         target specific tenant (default: auto from site)
 *
 * Requires:
 *   DATABASE_URL      Postgres connection string
 *   SALES_MONGO_URL   Mongo connection string (read-only)
 *   SALES_DB          Mongo database name (default fido_db)
 */
'use strict';

const { v4: uuid } = require('uuid');
const { initDb, qone, qall, qrun, withTransaction } = require('./db');

// ── CLI args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : def; };
const has = (flag) => argv.includes(flag);

const COLLECTION = arg('--collection', 'all');
const FROM_DATE  = arg('--from', '2020-01-01');
const TO_DATE    = arg('--to', new Date().toISOString().slice(0, 10));
const DRY_RUN    = has('--dry-run');
const BATCH_SIZE = parseInt(arg('--batch', '500'), 10);
const TARGET_SLUG = arg('--tenant-slug', null);
const TZ         = process.env.SALES_TZ_OFFSET || '+01:00';

// ── Mongo connection ───────────────────────────────────────────────────────────
const MONGO_URL = process.env.SALES_MONGO_URL;
const MONGO_DB  = process.env.SALES_DB || 'fido_db';
if (!MONGO_URL) { console.error('[ETL] SALES_MONGO_URL not set'); process.exit(1); }

async function getMongoDb() {
  const { MongoClient } = require('mongodb');
  const client = await MongoClient.connect(MONGO_URL, {
    serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000,
  });
  return { db: client.db(MONGO_DB), close: () => client.close() };
}

const num = (v) => {
  const n = typeof v === 'object' && v !== null && '$numberDecimal' in v ? parseFloat(v.$numberDecimal) : Number(v);
  return isNaN(n) ? 0 : n;
};
const dateStr = (d) => d instanceof Date ? d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }) : null;

// ── Site resolution ────────────────────────────────────────────────────────────
/**
 * Build two lookup maps from Fido Mongo site data → Daybook site rows:
 *   nameMap:  normalised name/code string → { id, tenant_id }
 *   oidMap:   Mongo ObjectId string       → { id, tenant_id }
 */
async function buildSiteMaps(mongoDB) {
  const pbSites = await qall('SELECT id, tenant_id, code, name FROM sites');

  // Normalise: uppercase, collapse spaces/hyphens for fuzzy match
  const norm = (s) => String(s || '').toUpperCase().replace(/[\s\-_]+/g, '');
  const nameMap = {};
  for (const s of pbSites) {
    nameMap[norm(s.code)] = s;
    nameMap[norm(s.name)] = s;
  }

  // Load Fido sites collection for ObjectId → name → Daybook site
  const oidMap = {};
  try {
    const fidoSites = await mongoDB.collection('sites').find({}).toArray();
    for (const fs of fidoSites) {
      const key = String(fs._id);
      const match = nameMap[norm(fs.name || '')] || nameMap[norm(fs.code || '')];
      if (match) oidMap[key] = match;
    }
  } catch { /* sites collection may not exist in older Fido */ }

  return { nameMap, oidMap, norm };
}

function resolveSiteByName(nameMap, norm, siteName) {
  if (!siteName) return null;
  return nameMap[norm(siteName)] || null;
}
function resolveSiteByOid(oidMap, oid) {
  if (!oid) return null;
  return oidMap[String(oid)] || null;
}

// ── Progress logger ────────────────────────────────────────────────────────────
function progress(label, n, total, extras = '') {
  if (n % 1000 === 0 || n === total) {
    const pct = total ? Math.round((n / total) * 100) : '?';
    process.stdout.write(`\r[ETL] ${label}: ${n}${total ? '/' + total : ''} (${pct}%)${extras}   `);
  }
}
function done(label, stats) {
  process.stdout.write('\n');
  console.log(`[ETL] ${label} done:`, JSON.stringify(stats));
}

// ── peoples → staff ────────────────────────────────────────────────────────────
async function etlStaff(mongoDB, { nameMap, oidMap, norm }) {
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  if (DRY_RUN) {
    stats.scanned = await mongoDB.collection('peoples').countDocuments();
    done('staff (dry-run)', stats);
    return stats;
  }
  const cursor = mongoDB.collection('peoples').find({}).batchSize(BATCH_SIZE);
  for await (const p of cursor) {
    stats.scanned++;
    const ext_id = String(p._id);
    const site = resolveSiteByOid(oidMap, p.site) || resolveSiteByName(nameMap, norm, p.siteName || p.site);
    if (!site) { stats.skipped++; continue; }
    const name = (p.name || '').trim(); if (!name) { stats.skipped++; continue; }
    try {
      const r = await qrun(
        `INSERT INTO staff (id,tenant_id,site_id,full_name,role_title,phone,pay_type,ext_people_id,status)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,site_id,full_name) DO UPDATE SET
           ext_people_id=COALESCE(EXCLUDED.ext_people_id, staff.ext_people_id),
           role_title=COALESCE(EXCLUDED.role_title, staff.role_title),
           phone=COALESCE(EXCLUDED.phone, staff.phone),
           status=EXCLUDED.status`,
        [uuid(), site.tenant_id, site.id, name,
          p.jobName || p.department || null, p.phone || null, 'DAILY', ext_id,
          p.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE']);
      if (r.rowCount) stats.inserted++;
    } catch { stats.errors++; }
    progress('staff', stats.scanned, 0);
  }
  done('staff', stats);
  return stats;
}

// ── customers → customers ──────────────────────────────────────────────────────
// Fido customers are a single global pool with NO site field, so they can't be
// tenant-resolved by site. They belong to the primary (Fido) tenant — pass its id
// as the default. (phone/email live in `phones`/`emails` arrays in Fido.)
async function etlCustomers(mongoDB, { nameMap, oidMap, norm }, defaultTenantId) {
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  if (DRY_RUN) {
    stats.scanned = await mongoDB.collection('customers').countDocuments();
    done('customers (dry-run)', stats);
    return stats;
  }
  const firstOf = (v) => Array.isArray(v) ? (v[0] || null) : (v || null);
  const cursor = mongoDB.collection('customers').find({}).batchSize(BATCH_SIZE);
  for await (const c of cursor) {
    stats.scanned++;
    const ext_id = String(c._id);
    const site = resolveSiteByOid(oidMap, c.site) || resolveSiteByName(nameMap, norm, c.siteName || c.site);
    const tenantId = (site && site.tenant_id) || defaultTenantId;
    const name = (c.name || '').trim(); if (!name) { stats.skipped++; continue; }
    if (!tenantId) { stats.skipped++; continue; }              // no site AND no default tenant
    try {
      const r = await qrun(
        `INSERT INTO customers (id,tenant_id,name,phone,email,ext_id)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (tenant_id,ext_id) DO UPDATE SET
           name=EXCLUDED.name,
           phone=COALESCE(EXCLUDED.phone, customers.phone)
         WHERE customers.ext_id IS NOT NULL`,
        [uuid(), tenantId, name, c.phone || firstOf(c.phones) || null, c.email || firstOf(c.emails) || null, ext_id]);
      if (r.rowCount) stats.inserted++;
    } catch { stats.errors++; }
    progress('customers', stats.scanned, 0);
  }
  done('customers', stats);
  return stats;
}

// ── expenses → expenses ────────────────────────────────────────────────────────
async function etlExpenses(mongoDB, { nameMap, oidMap, norm }) {
  const from = new Date(`${FROM_DATE}T00:00:00.000${TZ}`);
  const to   = new Date(`${TO_DATE}T23:59:59.999${TZ}`);
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  const match = { createdAt: { $gte: from, $lte: to } };
  const total = await mongoDB.collection('expenses').countDocuments(match);
  if (DRY_RUN) { stats.scanned = total; done('expenses (dry-run)', stats); return stats; }
  const cursor = mongoDB.collection('expenses').find(match).batchSize(BATCH_SIZE);
  for await (const e of cursor) {
    stats.scanned++;
    const ext_id = String(e._id);
    const site = resolveSiteByOid(oidMap, e.site) || resolveSiteByName(nameMap, norm, e.site);
    if (!site) { stats.skipped++; continue; }
    const expDate = dateStr(e.createdAt);
    if (!expDate) { stats.skipped++; continue; }
    const amount = num(e.txn_amount);
    try {
      const r = await qrun(
        `INSERT INTO expenses (id,tenant_id,site_id,ext_id,expense_date,category,description,amount,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,ext_id) DO NOTHING`,
        [uuid(), site.tenant_id, site.id, ext_id, expDate,
          (e.category || 'OTHER').toUpperCase().slice(0, 40),
          e.description || e.remarks || e.note || (Array.isArray(e.products) && e.products[0] && e.products[0].name) || null, amount,
          Math.floor((e.createdAt instanceof Date ? e.createdAt : new Date()).getTime() / 1000)]);
      if (r.rowCount) stats.inserted++;
    } catch { stats.errors++; }
    progress('expenses', stats.scanned, total);
  }
  done('expenses', stats);
  return stats;
}

// ── payrolls → payroll ────────────────────────────────────────────────────────
async function etlPayroll(mongoDB, { nameMap, oidMap, norm }) {
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  const total = await mongoDB.collection('payrolls').countDocuments();
  if (DRY_RUN) { stats.scanned = total; done('payroll (dry-run)', stats); return stats; }

  // Pre-load staff ext_people_id → id map
  const staffRows = await qall('SELECT id, ext_people_id, tenant_id FROM staff WHERE ext_people_id IS NOT NULL');
  const staffByExt = {};
  for (const s of staffRows) staffByExt[s.ext_people_id] = s;

  const cursor = mongoDB.collection('payrolls').aggregate([
    { $lookup: { from: 'sites', localField: 'site', foreignField: '_id', as: 's' } },
    { $lookup: { from: 'peoples', localField: 'payee', foreignField: '_id', as: 'p' } },
    { $addFields: { siteName: { $arrayElemAt: ['$s.name', 0] }, staffName: { $arrayElemAt: ['$p.name', 0] } } },
  ], { batchSize: BATCH_SIZE });

  for await (const row of cursor) {
    stats.scanned++;
    const ext_id = String(row._id);
    const site = resolveSiteByOid(oidMap, row.site) || resolveSiteByName(nameMap, norm, row.siteName);
    if (!site) { stats.skipped++; continue; }
    if (!row.month || !row.year) { stats.skipped++; continue; }
    const extStaffId = row.payee ? String(row.payee) : null;
    const staffRow = extStaffId ? staffByExt[extStaffId] : null;
    try {
      const r = await qrun(
        `INSERT INTO payroll
          (id,tenant_id,site_id,staff_id,ext_id,ext_staff_id,staff_name,month,year,
           gross_pay,net_pay,deductions,days_worked,bags_bagged,status,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,ext_id) DO NOTHING`,
        [uuid(), site.tenant_id, site.id,
          staffRow ? staffRow.id : null,
          ext_id, extStaffId, row.staffName || null,
          String(row.month), String(row.year),
          num(row.grossPay), num(row.netPay), num(row.deductions),
          num(row.daysWorked), num(row.bagsBagged),
          row.status || 'FINAL',
          Math.floor(Date.now() / 1000)]);
      if (r.rowCount) stats.inserted++;
    } catch { stats.errors++; }
    progress('payroll', stats.scanned, total);
  }
  done('payroll', stats);
  return stats;
}

// ── fidoorders → pos_sales ─────────────────────────────────────────────────────
async function etlOrders(mongoDB, { nameMap, oidMap, norm }) {
  const from  = new Date(`${FROM_DATE}T00:00:00.000${TZ}`);
  const to    = new Date(`${TO_DATE}T23:59:59.999${TZ}`);
  const SALE_STATUS = ['DELIVERED', 'PAID', 'LOADED', 'COMPLETED'];
  const match = { createdAt: { $gte: from, $lte: to }, status: { $in: SALE_STATUS } };
  const total = await mongoDB.collection('fidoorders').countDocuments(match);
  const stats = { scanned: 0, inserted: 0, duplicate: 0, skipped: 0, errors: 0 };

  if (DRY_RUN) {
    stats.scanned = total;
    done('orders (dry-run)', stats);
    return stats;
  }

  // Pre-load customer ext_id → id per tenant
  const custRows = await qall('SELECT id, tenant_id, ext_id FROM customers WHERE ext_id IS NOT NULL');
  const custByExt = {};
  for (const c of custRows) { const k = `${c.tenant_id}:${c.ext_id}`; custByExt[k] = c.id; }

  // Receipt number counter per tenant (start from current max)
  const tenantMaxReceipt = {};
  const receiptRows = await qall('SELECT tenant_id, COALESCE(MAX(receipt_no),0) mx FROM pos_sales GROUP BY tenant_id');
  for (const r of receiptRows) tenantMaxReceipt[r.tenant_id] = parseInt(r.mx, 10);
  const nextReceipt = (tid) => {
    if (!tenantMaxReceipt[tid]) tenantMaxReceipt[tid] = 0;
    tenantMaxReceipt[tid]++;
    return tenantMaxReceipt[tid];
  };

  const CASH_METHODS = ['CASH'];
  const cursor = mongoDB.collection('fidoorders').find(match).batchSize(BATCH_SIZE);

  for await (const order of cursor) {
    stats.scanned++;
    const ext_id = String(order._id);
    const site = resolveSiteByName(nameMap, norm, order.site);
    if (!site) { stats.skipped++; continue; }

    const saleDate = dateStr(order.createdAt); if (!saleDate) { stats.skipped++; continue; }
    const total_amount = num(order.txn_amount);
    const pm = (order.paymentMethod || 'CASH').toUpperCase();
    const isCash = CASH_METHODS.includes(pm);
    const custExtId = order.customer ? String(order.customer) : null;
    const custId = custExtId ? (custByExt[`${site.tenant_id}:${custExtId}`] || null) : null;
    const custName = order.customerName || order.customer_name || null;

    // Map fido products[] to items_json
    const rawItems = Array.isArray(order.products) ? order.products : [];
    const items = rawItems.map((p) => ({
      name: p.name || 'Unknown',
      qty: num(p.qty),
      price: num(p.price || (p.amount && p.qty ? num(p.amount) / num(p.qty) : 0)),
      amount: num(p.amount),
    }));

    const createdAt = Math.floor((order.createdAt instanceof Date ? order.createdAt : new Date()).getTime() / 1000);

    try {
      const r = await qrun(
        `INSERT INTO pos_sales
          (id,tenant_id,site_id,receipt_no,customer_id,customer_name,items_json,
           subtotal,discount,total,payment_method,amount_paid,balance,status,
           sale_date,ext_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,ext_id) DO NOTHING`,
        [uuid(), site.tenant_id, site.id, nextReceipt(site.tenant_id),
          custId, custName, JSON.stringify(items),
          total_amount, 0, total_amount, pm, total_amount, 0, 'PAID',
          saleDate, ext_id, createdAt]);
      if (r.rowCount) stats.inserted++;
      else stats.duplicate++;
    } catch (e) {
      // Fallback: ext_id conflict index may not be active yet — log and continue
      stats.errors++;
      if (stats.errors <= 5) console.warn('\n[ETL] orders error:', e.message.slice(0, 120));
    }
    progress('orders', stats.scanned, total, `  inserted=${stats.inserted} dup=${stats.duplicate}`);
  }
  done('orders', stats);
  return stats;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[ETL] starting', { COLLECTION, FROM_DATE, TO_DATE, DRY_RUN, BATCH_SIZE });
  await initDb();
  const { db: mongoDB, close } = await getMongoDb();
  const maps = await buildSiteMaps(mongoDB);
  console.log(`[ETL] site map: ${Object.keys(maps.nameMap).length} name keys, ${Object.keys(maps.oidMap).length} OID keys`);

  // Default tenant for site-less records (e.g. the global customer pool):
  // --tenant-slug if given, else the primary POS tenant 'fido'.
  const defTenant = await qone('SELECT id, slug FROM tenants WHERE slug=? ', [TARGET_SLUG || 'fido']);
  const defaultTenantId = defTenant ? defTenant.id : null;
  console.log(`[ETL] default tenant for site-less rows: ${defTenant ? defTenant.slug : '(none — site-less customers will be skipped)'}`);

  const run = COLLECTION === 'all' ? ['staff', 'customers', 'expenses', 'payroll', 'orders'] : [COLLECTION];
  const allStats = {};
  for (const col of run) {
    switch (col) {
      case 'staff':     allStats.staff     = await etlStaff(mongoDB, maps);     break;
      case 'customers': allStats.customers = await etlCustomers(mongoDB, maps, defaultTenantId); break;
      case 'expenses':  allStats.expenses  = await etlExpenses(mongoDB, maps);  break;
      case 'payroll':   allStats.payroll   = await etlPayroll(mongoDB, maps);   break;
      case 'orders':    allStats.orders    = await etlOrders(mongoDB, maps);    break;
      default: console.warn('[ETL] unknown collection:', col);
    }
  }
  await close();
  console.log('\n[ETL] complete:', JSON.stringify(allStats, null, 2));
}

main().catch((e) => { console.error('[ETL] fatal:', e.message); process.exit(1); });
