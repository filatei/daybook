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
 *   --collection  orders|expenses|staff|customers|products|vendors|terminals|stockitems|inventory|generators|payroll|all  (default: all)
 *   --from        YYYY-MM-DD   (default: 2020-01-01)
 *   --to          YYYY-MM-DD   (default: today)
 *   --dry-run                  count + validate, no writes
 *   --verify                   reconcile Mongo↔Postgres (counts + ₦ per site), no writes
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
const VERIFY     = has('--verify');
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
// Postgres TEXT rejects NUL () bytes — strip them and coerce to a trimmed string|null.
const clean = (v) => { if (v == null) return null; const s = (typeof v === 'string' ? v : String(v)).replace(/\u0000/g, '').trim(); return s.length ? s : null; };
// First usable string from a scalar or array of strings/objects (Fido phones[]/emails[]).
const firstStr = (v) => {
  if (typeof v === 'string') return clean(v);
  if (Array.isArray(v)) { for (const x of v) { const s = clean(x && typeof x === 'object' ? (x.number || x.phone || x.value || '') : x); if (s) return s; } }
  return null;
};

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
      const active = !p.status || String(p.status).toUpperCase() === 'ACTIVE';
      const r = await qrun(
        `INSERT INTO staff (id,tenant_id,site_id,full_name,role_title,phone,pay_type,staff_type,department,bank_name,bank_account,ext_people_id,status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,site_id,full_name) DO UPDATE SET
           ext_people_id=COALESCE(EXCLUDED.ext_people_id, staff.ext_people_id),
           role_title=COALESCE(EXCLUDED.role_title, staff.role_title),
           phone=COALESCE(EXCLUDED.phone, staff.phone),
           department=COALESCE(EXCLUDED.department, staff.department),
           bank_name=COALESCE(EXCLUDED.bank_name, staff.bank_name),
           bank_account=COALESCE(EXCLUDED.bank_account, staff.bank_account),
           status=EXCLUDED.status`,
        [uuid(), site.tenant_id, site.id, name,
          clean(p.jobName) || clean(p.category) || null, p.phone || null, 'DAILY', 'REGULAR',
          clean(p.department) || null, clean(p.bankName) || null, clean(p.bankAccount) || null, ext_id,
          active ? 'ACTIVE' : 'INACTIVE']);
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
  const cursor = mongoDB.collection('customers').find({}).batchSize(BATCH_SIZE);
  for await (const c of cursor) {
    stats.scanned++;
    const ext_id = String(c._id);
    const site = resolveSiteByOid(oidMap, c.site) || resolveSiteByName(nameMap, norm, c.siteName || c.site);
    const tenantId = (site && site.tenant_id) || defaultTenantId;
    const name = clean(c.name); if (!name) { stats.skipped++; continue; }
    if (!tenantId) { stats.skipped++; continue; }              // no site AND no default tenant
    try {
      const r = await qrun(
        // Dedupe on the unique (tenant_id, lower(name)) index — Fido has ~2k
        // duplicate-named customers that merge into one Daybook customer (keep
        // the first ext_id so re-runs stay idempotent; backfill phone/email).
        `INSERT INTO customers (id,tenant_id,name,phone,email,ext_id)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET
           ext_id = COALESCE(customers.ext_id, EXCLUDED.ext_id),
           phone  = COALESCE(EXCLUDED.phone, customers.phone),
           email  = COALESCE(EXCLUDED.email, customers.email)`,
        [uuid(), tenantId, name, clean(c.phone) || firstStr(c.phones), clean(c.email) || firstStr(c.emails), ext_id]);
      if (r.rowCount) stats.inserted++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] customers error:', e.message.slice(0, 140)); }
    progress('customers', stats.scanned, 0);
  }
  done('customers', stats);
  return stats;
}

// ── contacts → vendors ─────────────────────────────────────────────────────────
// Fido vendors/payees live in the global `contacts` collection (no site).  They
// belong to the primary (Fido) tenant — pass its id as the default.  Deduped on
// the unique (tenant_id, lower(name)) index.
async function etlVendors(mongoDB, { nameMap, oidMap, norm }, defaultTenantId) {
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  if (DRY_RUN) {
    stats.scanned = await mongoDB.collection('contacts').countDocuments();
    done('vendors (dry-run)', stats);
    return stats;
  }
  const cursor = mongoDB.collection('contacts').find({}).batchSize(BATCH_SIZE);
  for await (const c of cursor) {
    stats.scanned++;
    const ext_id = String(c._id);
    const site = resolveSiteByName(nameMap, norm, c.site);
    const tenantId = (site && site.tenant_id) || defaultTenantId;
    const name = clean(c.name); if (!name) { stats.skipped++; continue; }
    if (!tenantId) { stats.skipped++; continue; }
    const ba = c.bank_account || {};
    try {
      const r = await qrun(
        `INSERT INTO vendors (id,tenant_id,name,phone,email,bank,account_no,category,ext_id)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET
           ext_id  = COALESCE(vendors.ext_id, EXCLUDED.ext_id),
           phone   = COALESCE(EXCLUDED.phone, vendors.phone),
           email   = COALESCE(EXCLUDED.email, vendors.email),
           bank    = COALESCE(EXCLUDED.bank, vendors.bank),
           account_no = COALESCE(EXCLUDED.account_no, vendors.account_no),
           category   = COALESCE(EXCLUDED.category, vendors.category)`,
        [uuid(), tenantId, name, clean(c.phone) || firstStr(c.phones), clean(c.email) || firstStr(c.emails),
          clean(ba.bank), clean(ba.acct_number) || clean(c.bankAcct), clean(c.category) || clean(c.type), ext_id]);
      if (r.rowCount) stats.inserted++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] vendors error:', e.message.slice(0, 140)); }
    progress('vendors', stats.scanned, 0);
  }
  done('vendors', stats);
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
  // Resolve fido vendor ObjectId → vendor name via the already-imported vendors.
  const vendorByExt = {};
  for (const v of await qall('SELECT ext_id, name FROM vendors WHERE ext_id IS NOT NULL')) vendorByExt[v.ext_id] = v.name;
  const cursor = mongoDB.collection('expenses').find(match).batchSize(BATCH_SIZE);
  for await (const e of cursor) {
    stats.scanned++;
    const ext_id = String(e._id);
    const site = resolveSiteByOid(oidMap, e.site) || resolveSiteByName(nameMap, norm, e.site);
    if (!site) { stats.skipped++; continue; }
    const expDate = dateStr(e.createdAt);
    if (!expDate) { stats.skipped++; continue; }
    const amount = num(e.txn_amount);
    const vendorName = e.vendor ? (vendorByExt[String(e.vendor)] || null) : null;
    // Fido expense line items (products[]): name, qty, price, amount, category, unit.
    const rawItems = Array.isArray(e.products) ? e.products : [];
    const items = rawItems.map((p) => ({
      name: clean(p.name) || 'Item',
      category: clean(p.category) || null,
      qty: num(p.qty) || null,
      unit: clean(p.unit) || null,
      price: num(p.price) || (num(p.amount) && num(p.qty) ? num(p.amount) / num(p.qty) : null),
      amount: num(p.amount) || null,
    }));
    // Category: explicit expense category, else the first line item's category.
    const category = clean((e.category || (items[0] && items[0].category) || 'OTHER').toUpperCase().slice(0, 40)) || 'OTHER';
    // Imprest vs non-imprest: honour an explicit fido flag, else infer from text.
    const kind = (e.imprest === true || e.isImprest === true
      || /IMPREST/i.test(String(e.expenseType || e.type || e.expense_type || ''))
      || /IMPREST/.test(category)) ? 'IMPREST' : 'NON_IMPREST';
    // Incremental payments → amount_paid + status; ledger rows migrated below.
    const payHistory = Array.isArray(e.payHistory) ? e.payHistory : [];
    const paid = Math.round(payHistory.reduce((a, p) => a + num(p.paidAmount), 0) * 100) / 100;
    const status = paid <= 0.01 ? 'UNPAID' : (paid >= amount - 0.01 ? 'PAID' : 'PART');
    try {
      const row = await qone(
        `INSERT INTO expenses (id,tenant_id,site_id,ext_id,expense_date,category,description,vendor,items_json,amount,amount_paid,status,kind,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
           vendor=COALESCE(EXCLUDED.vendor, expenses.vendor),
           items_json=COALESCE(EXCLUDED.items_json, expenses.items_json),
           category=EXCLUDED.category, amount_paid=EXCLUDED.amount_paid, status=EXCLUDED.status
         RETURNING id`,
        [uuid(), site.tenant_id, site.id, ext_id, expDate, category,
          clean(e.description || e.remarks || e.note || (items[0] && items[0].name)), vendorName,
          items.length ? JSON.stringify(items) : null, amount, paid, status, kind,
          Math.floor((e.createdAt instanceof Date ? e.createdAt : new Date()).getTime() / 1000)]);
      stats.inserted++;
      // Migrate each payment in the ticket's history (idempotent on ext_id).
      const expId = row && row.id;
      for (let i = 0; i < payHistory.length; i++) {
        const p = payHistory[i]; const amt = num(p.paidAmount); if (!amt || !expId) continue;
        const pdate = dateStr(p.paymentDate || p.date) || expDate;
        await qrun(
          `INSERT INTO expense_payments (id,tenant_id,expense_id,pay_date,amount,method,bank,memo,paid_by,ext_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (tenant_id,ext_id) WHERE ext_id IS NOT NULL DO NOTHING`,
          [uuid(), site.tenant_id, expId, pdate, amt, null, clean(p.bankAcct) || null, clean(p.memo) || null, clean(p.payer) || null, `${ext_id}:${i}`]).catch(() => {});
      }
    } catch (e2) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] expenses error:', e2.message.slice(0, 140)); }
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
         ON CONFLICT (tenant_id,ext_id) WHERE ext_id IS NOT NULL DO NOTHING`,
        [uuid(), site.tenant_id, site.id,
          staffRow ? staffRow.id : null,
          ext_id, extStaffId, clean(row.staffName),
          clean(String(row.month)), String(row.year),
          num(row.grossPay), num(row.netPay), num(row.deductions),
          num(row.daysWorked), num(row.bagsBagged),
          row.status || 'FINAL',
          Math.floor(Date.now() / 1000)]);
      if (r.rowCount) stats.inserted++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] payroll error:', e.message.slice(0, 140)); }
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
  const stats = { scanned: 0, inserted: 0, duplicate: 0, skipped: 0, errors: 0, quarantined: 0 };

  // A fido order is fit to migrate only if it has a usable timestamp AND a Fido
  // order id. Rejects are recorded in etl_quarantine (auditable) and NOT imported.
  const fidoOrderNo = (o) => (o.fidoOrderId ?? o.orderId ?? null);
  const quarantine = async (reason, order, siteName) => {
    stats.quarantined++;
    if (DRY_RUN) return;
    try {
      await qrun(
        `INSERT INTO etl_quarantine (id,tenant_id,source,ext_id,reason,site,amount,raw)
         VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (source,ext_id) DO UPDATE SET reason=EXCLUDED.reason`,
        [uuid(), null, 'fidoorders', String(order._id), reason, siteName || order.site || null,
          num(order.txn_amount), JSON.stringify({ order_no: fidoOrderNo(order), status: order.status, paymentMethod: order.paymentMethod })]);
    } catch (e) { if (stats.errors <= 5) console.warn('\n[ETL] quarantine error:', e.message.slice(0, 120)); }
  };

  if (DRY_RUN) {
    stats.scanned = total;
    done('orders (dry-run)', stats);
    return stats;
  }

  // Pre-load customer ext_id → id per tenant
  const custRows = await qall('SELECT id, tenant_id, ext_id, name FROM customers WHERE ext_id IS NOT NULL');
  const custByExt = {}, custNameByExt = {};
  for (const c of custRows) { const k = `${c.tenant_id}:${c.ext_id}`; custByExt[k] = c.id; if (c.name) custNameByExt[k] = c.name; }

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

    // Quarantine (don't import) errant orders: no usable timestamp, or no Fido
    // order id. These are the id-less / undated rows seen in the live list.
    const saleDate = dateStr(order.createdAt);
    if (!saleDate) { await quarantine('NO_TIMESTAMP', order, site.name); continue; }
    if (fidoOrderNo(order) == null) { await quarantine('NO_ORDER_ID', order, site.name); continue; }
    const total_amount = num(order.txn_amount);
    const rawPm = clean((order.paymentMethod || 'CASH').toUpperCase()) || 'CASH';
    // Incentive (monthly bonus, no cash collected) is bucketed apart from sales/cash.
    const incentive = String(order.orderType || '').toUpperCase() === 'INCENTIVE' || rawPm === 'INCENTIVE';
    const pm = incentive ? 'INCENTIVE' : rawPm;
    const isCash = !incentive && CASH_METHODS.includes(pm);
    const custExtId = order.customer ? String(order.customer) : null;
    const custId = custExtId ? (custByExt[`${site.tenant_id}:${custExtId}`] || null) : null;
    // Real name: the migrated customer record, else the transfer depositor name.
    // (Fido orders have NO customerName field — customer is an ObjectId ref.)
    const custName = (custExtId && custNameByExt[`${site.tenant_id}:${custExtId}`])
      || clean(order.transfer_from_account_name) || null;

    // Map fido products[] to items_json
    const rawItems = Array.isArray(order.products) ? order.products : [];
    const items = rawItems.map((p) => ({
      name: clean(p.name) || 'Unknown',
      qty: num(p.qty),
      price: num(p.price || (p.amount && p.qty ? num(p.amount) / num(p.qty) : 0)),
      amount: num(p.amount),
    }));

    const createdAt = Math.floor((order.createdAt instanceof Date ? order.createdAt : new Date()).getTime() / 1000);
    const bank = isCash ? null : ((clean(order.acquirer || order.card_bank || order.bank || order.transfer_from_bank) || '').toUpperCase() || null);
    const terminal = isCash ? null : ((clean(order.terminal_location) || '').toUpperCase() || null);

    try {
      // On re-run, backfill bank/terminal onto already-imported rows (only when
      // currently blank — never overwrite). xmax=0 ⇒ this was a fresh insert.
      const row = await qone(
        `INSERT INTO pos_sales
          (id,tenant_id,site_id,receipt_no,customer_id,customer_name,items_json,
           subtotal,discount,total,payment_method,amount_paid,balance,status,
           sale_date,bank,terminal,ext_id,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
           bank          = COALESCE(pos_sales.bank, EXCLUDED.bank),
           terminal      = COALESCE(pos_sales.terminal, EXCLUDED.terminal),
           customer_name = COALESCE(pos_sales.customer_name, EXCLUDED.customer_name),
           customer_id   = COALESCE(pos_sales.customer_id, EXCLUDED.customer_id)
         RETURNING (xmax = 0) AS inserted`,
        [uuid(), site.tenant_id, site.id, nextReceipt(site.tenant_id),
          custId, custName, JSON.stringify(items),
          total_amount, 0, total_amount, pm, total_amount, 0, 'PAID',
          saleDate, bank, terminal, ext_id, createdAt]);
      if (row && row.inserted) stats.inserted++;
      else { stats.duplicate++; if (bank || terminal) stats.backfilled = (stats.backfilled || 0) + 1; }
    } catch (e) {
      // Fallback: ext_id conflict index may not be active yet — log and continue
      stats.errors++;
      if (stats.errors <= 5) console.warn('\n[ETL] orders error:', e.message.slice(0, 120));
    }
    progress('orders', stats.scanned, total, `  inserted=${stats.inserted} dup=${stats.duplicate} quar=${stats.quarantined}`);
  }

  // Sweep undated orders that fall outside ANY date range (they have no
  // createdAt at all, so the ranged cursor never sees them) into quarantine so
  // the audit list of errant Fido rows is complete.
  if (!DRY_RUN) {
    const undated = mongoDB.collection('fidoorders')
      .find({ status: { $in: SALE_STATUS }, $or: [{ createdAt: { $exists: false } }, { createdAt: null }] })
      .batchSize(BATCH_SIZE);
    for await (const order of undated) {
      const site = resolveSiteByName(nameMap, norm, order.site);
      await quarantine('NO_TIMESTAMP', order, site ? site.name : order.site);
    }
  }

  done('orders', stats);
  return stats;
}

// ── recuploads → reconciliations (transfer/POS payment confirmations) ──────────
// recuploads have no site; they belong to the primary (Fido) tenant. The proof
// `image` is an external URL on the old fido server (migrated at cutover).
async function etlRecuploads(mongoDB, maps, defaultTenantId) {
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  const total = await mongoDB.collection('recuploads').countDocuments();
  if (DRY_RUN) { stats.scanned = total; done('recuploads (dry-run)', stats); return stats; }
  if (!defaultTenantId) { console.warn('[ETL] recuploads: no default tenant — skipping'); return stats; }
  const custRows = await qall('SELECT id, ext_id FROM customers WHERE tenant_id=? AND ext_id IS NOT NULL', [defaultTenantId]);
  const custByExt = {}; for (const c of custRows) custByExt[c.ext_id] = c.id;
  const cursor = mongoDB.collection('recuploads').find({}).batchSize(BATCH_SIZE);
  for await (const r of cursor) {
    stats.scanned++;
    const ext_id = String(r._id);
    const kind = clean((r.pay_type || 'POS').toUpperCase()) || 'POS';
    const custId = r.customer ? (custByExt[String(r.customer)] || null) : null;
    const txnDate = dateStr(r.trans_date) || dateStr(r.createdAt);
    try {
      const res = await qrun(
        `INSERT INTO reconciliations (id,tenant_id,site_id,customer_id,ext_id,kind,txn_date,amount,amount_confirmed,bank,account_name,ref,status,action_taken,remarks,image)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,ext_id) WHERE ext_id IS NOT NULL DO NOTHING`,
        [uuid(), defaultTenantId, null, custId, ext_id, kind, txnDate,
          num(r.txn_amount), r.amt_teller != null ? num(r.amt_teller) : null,
          clean(r.transfer_from_bank), clean(r.transfer_from_account_name) || clean(r.name_teller),
          clean(r.rrn) || clean(r.stan) || clean(r.tx_ref) || clean(r.trans_id),
          r.amt_teller != null ? 'CONFIRMED' : 'PENDING',
          clean(r.action_taken), clean(r.remarks), clean(r.image)]);
      if (res.rowCount) stats.inserted++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] recuploads error:', e.message.slice(0, 140)); }
    progress('recuploads', stats.scanned, total);
  }
  done('recuploads', stats);
  return stats;
}

// ── cashdeposits → reconciliations (cash bankings with deposit-slip image) ─────
async function etlCashDeposits(mongoDB, { nameMap, norm }, defaultTenantId) {
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  const total = await mongoDB.collection('cashdeposits').countDocuments();
  if (DRY_RUN) { stats.scanned = total; done('cashdeposits (dry-run)', stats); return stats; }
  const cursor = mongoDB.collection('cashdeposits').find({}).batchSize(BATCH_SIZE);
  for await (const d of cursor) {
    stats.scanned++;
    const ext_id = String(d._id);
    const site = resolveSiteByName(nameMap, norm, d.site);
    const tenantId = (site && site.tenant_id) || defaultTenantId;
    if (!tenantId) { stats.skipped++; continue; }
    try {
      const res = await qrun(
        `INSERT INTO reconciliations (id,tenant_id,site_id,ext_id,kind,txn_date,amount,bank,account_name,status,image)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id,ext_id) WHERE ext_id IS NOT NULL DO NOTHING`,
        [uuid(), tenantId, site ? site.id : null, ext_id, 'CASH_DEPOSIT', dateStr(d.createdAt),
          num(d.amount), clean(d.payeeAcct), clean(d.depositor),
          d.status === 'SEEN' ? 'CONFIRMED' : 'PENDING', clean(d.image)]);
      if (res.rowCount) stats.inserted++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] cashdeposits error:', e.message.slice(0, 140)); }
    progress('cashdeposits', stats.scanned, total);
  }
  done('cashdeposits', stats);
  return stats;
}

// ── products / fiaproducts → products ───────────────────────────────────────────
// Fido keeps a GLOBAL product catalogue (no site).  Daybook mirrors the same
// catalogue per tenant.  Upsert on (tenant_id, name) and keep price/category in
// sync — fido stays the source of truth until cutover.  track_stock=0 so a
// missing stock figure never blocks a sale.
async function etlProductsFrom(mongoDB, collName, tenantId, label) {
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  if (!tenantId) { console.log(`[ETL] ${label}: no tenant — skipped`); return stats; }
  const total = await mongoDB.collection(collName).countDocuments();
  if (DRY_RUN) { stats.scanned = total; done(`${label} (dry-run)`, stats); return stats; }
  const cursor = mongoDB.collection(collName).find({}).batchSize(BATCH_SIZE);
  for await (const p of cursor) {
    stats.scanned++;
    const name = clean(p.name); if (!name) { stats.skipped++; continue; }
    try {
      const r = await qrun(
        `INSERT INTO products (id,tenant_id,name,category,price,cost,sku,unit,track_stock,status)
         VALUES (?,?,?,?,?,?,?,?,0,'ACTIVE')
         ON CONFLICT (tenant_id, name) DO UPDATE SET
           price=EXCLUDED.price, cost=EXCLUDED.cost,
           category=COALESCE(EXCLUDED.category, products.category),
           sku=COALESCE(EXCLUDED.sku, products.sku),
           status='ACTIVE'`,
        [uuid(), tenantId, name, clean(p.category) || clean(p.group), num(p.price), num(p.costprice), clean(p.barcode), 'unit']);
      if (r.rowCount) stats.inserted++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn(`\n[ETL] ${label} error:`, e.message.slice(0, 140)); }
    progress(label, stats.scanned, total);
  }
  done(label, stats);
  return stats;
}
async function etlProducts(mongoDB, defaultTenantId) {
  const fido = await etlProductsFrom(mongoDB, 'products', defaultTenantId, 'products(fido)');
  let fiafia = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  const fiaT = await qone("SELECT id FROM tenants WHERE slug='fiafia'");
  if (fiaT && fiaT.id) {
    try { fiafia = await etlProductsFrom(mongoDB, 'fiaproducts', fiaT.id, 'products(fiafia)'); }
    catch (e) { console.warn('[ETL] fiaproducts skipped:', e.message.slice(0, 100)); }
  }
  return { fido, fiafia };
}

// ── gens → generators ; gendiesels/genmaints → generator_logs ────────────────────
async function etlGenerators(mongoDB, { oidMap, nameMap, norm }) {
  const stats = { gens: 0, logs: 0, skipped: 0, errors: 0 };
  if (DRY_RUN) {
    stats.gens = await mongoDB.collection('gens').countDocuments();
    done('generators (dry-run)', stats); return stats;
  }
  // 1) Generators
  for await (const g of mongoDB.collection('gens').find({}).batchSize(BATCH_SIZE)) {
    const site = resolveSiteByOid(oidMap, g.site) || resolveSiteByName(nameMap, norm, g.siteName);
    const name = clean(g.name);
    if (!site || !name) { stats.skipped++; continue; }
    const makeModel = [clean(g.brand), clean(g.model)].filter(Boolean).join(' ') || null;
    try {
      const r = await qrun(
        `INSERT INTO generators (id,tenant_id,site_id,name,fuel_type,make_model,capacity_kva,serial_no,notes,ext_id,status)
         VALUES (?,?,?,?,'DIESEL',?,?,?,?,?,'ACTIVE')
         ON CONFLICT (tenant_id, ext_id) WHERE ext_id IS NOT NULL DO NOTHING`,
        [uuid(), site.tenant_id, site.id, name, makeModel, num(g.kva) || null, clean(g.sn), clean(g.description), String(g._id)]);
      if (r.rowCount) stats.gens++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] generators error:', e.message.slice(0, 140)); }
    progress('generators', stats.gens, 0);
  }
  // 2) Map fido gen _id → Daybook generator row
  const genMap = {};
  for (const row of await qall('SELECT id, ext_id, tenant_id, site_id FROM generators WHERE ext_id IS NOT NULL')) genMap[row.ext_id] = row;

  const importLogs = async (coll, type, fields) => {
    for await (const d of mongoDB.collection(coll).find({}).batchSize(BATCH_SIZE)) {
      const g = genMap[String(d.gen)];
      const logDate = dateStr(d.date);
      if (!g || !logDate) { stats.skipped++; continue; }
      try {
        const r = await qrun(
          `INSERT INTO generator_logs (id,tenant_id,generator_id,site_id,log_date,type,litres,runtime_hours,detail,ext_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (tenant_id, ext_id) WHERE ext_id IS NOT NULL DO NOTHING`,
          [uuid(), g.tenant_id, g.id, g.site_id, logDate, type, fields.litres(d), fields.hours(d), fields.detail(d), String(d._id)]);
        if (r.rowCount) stats.logs++;
      } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn(`\n[ETL] ${coll} error:`, e.message.slice(0, 140)); }
      progress('gen-logs', stats.logs, 0);
    }
  };
  await importLogs('gendiesels', 'DIESEL', { litres: (d) => num(d.diesel_litres) || null, hours: (d) => num(d.diesel_hours) || null, detail: (d) => clean(d.remarks) });
  await importLogs('genmaints',  'MAINTENANCE', { litres: () => null, hours: (d) => num(d.maintenance_hour) || null, detail: (d) => clean(d.remarks) });
  done('generators', stats);
  return stats;
}

// ── terminals → pos_terminals (POS machines: bank + location per terminal) ─────
async function etlTerminals(mongoDB, { nameMap, norm }, defaultTenantId) {
  const stats = { scanned: 0, inserted: 0, updated: 0, skipped: 0, errors: 0 };
  if (DRY_RUN) {
    stats.scanned = await mongoDB.collection('terminals').countDocuments();
    done('terminals (dry-run)', stats); return stats;
  }
  for await (const t of mongoDB.collection('terminals').find({}).batchSize(BATCH_SIZE)) {
    stats.scanned++;
    const location = clean(t.terminal_location);
    const site = resolveSiteByName(nameMap, norm, location) || resolveSiteByName(nameMap, norm, t.company);
    const tenantId = site ? site.tenant_id : defaultTenantId;
    if (!tenantId) { stats.skipped++; continue; }
    const bank = (clean(t.bank) || '').toUpperCase() || null;
    const label = [bank, location].filter(Boolean).join(' · ') || clean(t.terminal_id) || clean(t.sn) || 'Terminal';
    try {
      const r = await qrun(
        `INSERT INTO pos_terminals (id,tenant_id,site_id,ext_id,terminal_id,bank,location,sn,company,label)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
           bank=EXCLUDED.bank, location=EXCLUDED.location, sn=EXCLUDED.sn,
           company=EXCLUDED.company, label=EXCLUDED.label, site_id=COALESCE(EXCLUDED.site_id, pos_terminals.site_id)`,
        [uuid(), tenantId, site ? site.id : null, String(t._id), clean(t.terminal_id) || null,
          bank, location || null, clean(t.sn) || null, (clean(t.company) || '').toUpperCase() || null, label]);
      if (r.rowCount) stats.inserted++; else stats.updated++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] terminals error:', e.message.slice(0, 140)); }
    progress('terminals', stats.scanned, 0);
  }
  done('terminals', stats);
  return stats;
}

// ── stockitems → stock_items (raw-material catalogue) ─────────────────────────
async function etlStockItems(mongoDB, defaultTenantId) {
  const stats = { scanned: 0, inserted: 0, updated: 0, dup_name: 0, errors: 0 };
  if (!defaultTenantId) { console.warn('[ETL] stockitems: no default tenant'); return stats; }
  if (DRY_RUN) { stats.scanned = await mongoDB.collection('stockitems').countDocuments(); done('stockitems (dry-run)', stats); return stats; }
  for await (const s of mongoDB.collection('stockitems').find({}).batchSize(BATCH_SIZE)) {
    stats.scanned++;
    const name = clean(s.name); if (!name) continue;
    try {
      const r = await qrun(
        `INSERT INTO stock_items (id,tenant_id,name,category,unit,barcode,ext_id)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
           category=COALESCE(EXCLUDED.category, stock_items.category),
           unit=COALESCE(EXCLUDED.unit, stock_items.unit)`,
        [uuid(), defaultTenantId, name, clean(s.category) || null, clean(s.unit) || 'unit', clean(s.barcode) || null, String(s._id)]);
      if (r.rowCount) stats.inserted++; else stats.updated++;
    } catch (e) {
      // Two fido stock items can share a name (different _id) → name-unique clash.
      // That's expected; the catalogue keeps one. Count it, don't treat as error.
      if (e.code === '23505' || /idx_stock_items_name/.test(e.message)) stats.dup_name++;
      else { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] stockitems error:', e.message.slice(0, 140)); }
    }
    progress('stockitems', stats.scanned, 0);
  }
  done('stockitems', stats);
  return stats;
}

// ── inventories → stock_moves (received-from / issued-to movements) ────────────
async function etlInventory(mongoDB, { nameMap, norm }, defaultTenantId) {
  const stats = { scanned: 0, inserted: 0, skipped: 0, errors: 0 };
  if (!defaultTenantId) { console.warn('[ETL] inventory: no default tenant'); return stats; }
  if (DRY_RUN) { stats.scanned = await mongoDB.collection('inventories').countDocuments(); done('inventory (dry-run)', stats); return stats; }
  const itemByExt = {};
  for (const r of await qall('SELECT id, ext_id FROM stock_items WHERE ext_id IS NOT NULL')) itemByExt[r.ext_id] = r.id;
  const vendorByExt = {};
  for (const v of await qall('SELECT ext_id, name FROM vendors WHERE ext_id IS NOT NULL')) vendorByExt[v.ext_id] = v.name;
  for await (const m of mongoDB.collection('inventories').find({}).batchSize(BATCH_SIZE)) {
    stats.scanned++;
    const itemId = itemByExt[String(m.name)];   // inventory.name → Stockitem _id
    if (!itemId) { stats.skipped++; continue; }
    const qtyMag = num(m.qty); if (!qtyMag) { stats.skipped++; continue; }
    const ops = (clean(m.ops) || '').toUpperCase();
    const isIssue = /ISSUE|OUT|USED|CONSUM|PRODUC/.test(ops);
    const type = isIssue ? 'ISSUE' : 'RECEIVE';
    const qty = isIssue ? -qtyMag : qtyMag;
    const vendor = m.sender ? (vendorByExt[String(m.sender)] || null) : null;
    const site = resolveSiteByName(nameMap, norm, m.store);
    const moveDate = dateStr(m.dateReceived || m.createdAt) || dateStr(new Date());
    try {
      const r = await qrun(
        `INSERT INTO stock_moves (id,tenant_id,item_id,site_id,type,qty,vendor,note,move_date,ext_id)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id, ext_id) WHERE ext_id IS NOT NULL DO NOTHING`,
        [uuid(), defaultTenantId, itemId, site ? site.id : null, type, qty, vendor, clean(m.remarks) || null, moveDate, String(m._id)]);
      if (r.rowCount) stats.inserted++;
    } catch (e) { stats.errors++; if (stats.errors <= 5) console.warn('\n[ETL] inventory error:', e.message.slice(0, 140)); }
    progress('inventory', stats.scanned, 0);
  }
  done('inventory', stats);
  return stats;
}

// ── Verify: reconcile Mongo (source) ↔ Postgres (imported rows) ─────────────────
// Compares row counts per collection, and for orders the total ₦ per site, so you
// get a clear pass/fail instead of eyeballing. Only counts IMPORTED rows in
// Postgres (ext_id IS NOT NULL) so human-entered Daybook records don't skew it.
async function verify(mongoDB, { nameMap, norm }) {
  const from = new Date(`${FROM_DATE}T00:00:00.000${TZ}`);
  const to   = new Date(`${TO_DATE}T23:59:59.999${TZ}`);
  const SALE_STATUS = ['DELIVERED', 'PAID', 'LOADED', 'COMPLETED'];
  const pgN = async (sql) => Number((await qone(sql)).count);
  const fmt = (n) => '₦' + Math.round(n).toLocaleString('en-NG');
  const line = (label, m, p) => {
    const d = p - m; const ok = d === 0;
    console.log(`  ${label.padEnd(12)} mongo ${String(m).padStart(8)} | pg ${String(p).padStart(8)} | Δ ${String(d).padStart(7)} ${ok ? '✓' : (d < 0 ? '(pg short — re-run / skips)' : '(pg extra)')}`);
  };
  console.log('\n=== VERIFY (counts: source vs imported) ===');
  line('staff', await mongoDB.collection('peoples').countDocuments(),
    await pgN('SELECT COUNT(*) FROM staff WHERE ext_people_id IS NOT NULL'));
  line('customers', await mongoDB.collection('customers').countDocuments(),
    await pgN('SELECT COUNT(*) FROM customers WHERE ext_id IS NOT NULL'));
  line('expenses', await mongoDB.collection('expenses').countDocuments({ createdAt: { $gte: from, $lte: to } }),
    await pgN('SELECT COUNT(*) FROM expenses WHERE ext_id IS NOT NULL'));
  line('payroll', await mongoDB.collection('payrolls').countDocuments(),
    await pgN('SELECT COUNT(*) FROM payroll WHERE ext_id IS NOT NULL'));
  const mOrders = await mongoDB.collection('fidoorders').countDocuments({ createdAt: { $gte: from, $lte: to }, status: { $in: SALE_STATUS } });
  line('orders', mOrders, await pgN('SELECT COUNT(*) FROM pos_sales WHERE ext_id IS NOT NULL'));

  // Money reconciliation per site (orders)
  console.log('\n=== VERIFY (orders ₦ per site) ===');
  const mAgg = await mongoDB.collection('fidoorders').aggregate([
    { $match: { createdAt: { $gte: from, $lte: to }, status: { $in: SALE_STATUS } } },
    { $group: { _id: '$site', amt: { $sum: '$txn_amount' }, n: { $sum: 1 } } },
  ]).toArray();
  const pgAgg = await qall(`SELECT s.code, COALESCE(SUM(p.total),0) amt, COUNT(*) n
    FROM pos_sales p JOIN sites s ON s.id=p.site_id WHERE p.ext_id IS NOT NULL GROUP BY s.code`);
  const pgBy = {}; for (const r of pgAgg) pgBy[norm(r.code)] = { amt: Number(r.amt), n: Number(r.n) };
  let mTot = 0, pTot = 0;
  for (const m of mAgg.sort((a, b) => Number(b.amt) - Number(a.amt))) {
    const key = norm(m._id); const pg = pgBy[key] || { amt: 0, n: 0 };
    const ma = Number(m.amt), d = pg.amt - ma; mTot += ma; pTot += pg.amt;
    console.log(`  ${String(m._id).padEnd(12)} mongo ${fmt(ma).padStart(16)} (${m.n}) | pg ${fmt(pg.amt).padStart(16)} (${pg.n}) | Δ ${fmt(d)} ${d === 0 ? '✓' : ''}`);
  }
  console.log(`  ${'TOTAL'.padEnd(12)} mongo ${fmt(mTot).padStart(16)}        | pg ${fmt(pTot).padStart(16)}        | Δ ${fmt(pTot - mTot)} ${pTot === mTot ? '✓ EXACT' : `(${((pTot / mTot) * 100).toFixed(2)}% imported)`}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('[ETL] starting', { COLLECTION, FROM_DATE, TO_DATE, DRY_RUN, VERIFY, BATCH_SIZE });
  await initDb();
  const { db: mongoDB, close } = await getMongoDb();
  const maps = await buildSiteMaps(mongoDB);
  console.log(`[ETL] site map: ${Object.keys(maps.nameMap).length} name keys, ${Object.keys(maps.oidMap).length} OID keys`);

  if (VERIFY) { await verify(mongoDB, maps); await close(); console.log('\n[ETL] verify complete'); return; }

  // Default tenant for site-less records (e.g. the global customer pool):
  // --tenant-slug if given, else the primary POS tenant 'fido'.
  const defTenant = await qone('SELECT id, slug FROM tenants WHERE slug=? ', [TARGET_SLUG || 'fido']);
  const defaultTenantId = defTenant ? defTenant.id : null;
  console.log(`[ETL] default tenant for site-less rows: ${defTenant ? defTenant.slug : '(none — site-less customers will be skipped)'}`);

  const run = COLLECTION === 'all' ? ['staff', 'customers', 'products', 'vendors', 'terminals', 'stockitems', 'inventory', 'generators', 'expenses', 'payroll', 'orders', 'recuploads', 'cashdeposits'] : [COLLECTION];
  const allStats = {};
  for (const col of run) {
    switch (col) {
      case 'staff':        allStats.staff        = await etlStaff(mongoDB, maps);     break;
      case 'customers':    allStats.customers    = await etlCustomers(mongoDB, maps, defaultTenantId); break;
      case 'products':     allStats.products     = await etlProducts(mongoDB, defaultTenantId); break;
      case 'vendors':      allStats.vendors      = await etlVendors(mongoDB, maps, defaultTenantId); break;
      case 'terminals':    allStats.terminals    = await etlTerminals(mongoDB, maps, defaultTenantId); break;
      case 'stockitems':   allStats.stockitems   = await etlStockItems(mongoDB, defaultTenantId); break;
      case 'inventory':    allStats.inventory    = await etlInventory(mongoDB, maps, defaultTenantId); break;
      case 'generators':   allStats.generators   = await etlGenerators(mongoDB, maps); break;
      case 'expenses':     allStats.expenses     = await etlExpenses(mongoDB, maps);  break;
      case 'payroll':      allStats.payroll      = await etlPayroll(mongoDB, maps);   break;
      case 'orders':       allStats.orders       = await etlOrders(mongoDB, maps);    break;
      case 'recuploads':   allStats.recuploads   = await etlRecuploads(mongoDB, maps, defaultTenantId); break;
      case 'cashdeposits': allStats.cashdeposits = await etlCashDeposits(mongoDB, maps, defaultTenantId); break;
      default: console.warn('[ETL] unknown collection:', col);
    }
  }
  await close();
  console.log('\n[ETL] complete:', JSON.stringify(allStats, null, 2));
}

main().catch((e) => { console.error('[ETL] fatal:', e.message); process.exit(1); });
