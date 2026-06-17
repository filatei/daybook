/**
 * Daybook — external sales source (fido.torama.ng POS MongoDB, read-only)
 *
 * Reached over an SSH tunnel (127.0.0.1:27018 → fido mongod). Configured by:
 *   SALES_MONGO_URL   mongodb://daybook_ro:***@127.0.0.1:27018/fido_db?authSource=admin&directConnection=true&readPreference=secondaryPreferred
 *   SALES_DB          default fido_db
 *   SALES_TZ_OFFSET   business day timezone, default +01:00 (Africa/Lagos)
 *
 * If SALES_MONGO_URL is unset, every function reports disabled (the app still
 * runs; managers just enter reports manually).
 *
 * ACTIVE collections (verified): fidoorders (all sites' sales), expenses,
 * payrolls, peoples, sites. Amounts are sometimes stored as strings → coerced.
 */
'use strict';

let _client = null, _connecting = null;
const URL = () => process.env.SALES_MONGO_URL || '';
const DBNAME = () => process.env.SALES_DB || 'fido_db';
const TZ = () => process.env.SALES_TZ_OFFSET || '+01:00';
const salesEnabled = () => !!URL();

async function getDb() {
  if (!URL()) throw Object.assign(new Error('Sales source not configured (SALES_MONGO_URL)'), { code: 'no_sales_source', httpStatus: 503 });
  if (_client) return _client.db(DBNAME());
  if (!_connecting) {
    const { MongoClient } = require('mongodb');
    _connecting = MongoClient.connect(URL(), { serverSelectionTimeoutMS: 6000, connectTimeoutMS: 6000 })
      .then((c) => { _client = c; c.on('close', () => { _client = null; }); return c; })
      .catch((e) => { _connecting = null; throw Object.assign(new Error('Cannot reach sales DB — is the SSH tunnel up? ' + e.message), { code: 'sales_unreachable', httpStatus: 502 }); });
  }
  await _connecting;
  return _client.db(DBNAME());
}

// Build a case-insensitive regex matching a Daybook site code against the POS
// site string (e.g. code "KPANSIA-E" matches "KPANSIA E").
function siteRegex(code) {
  const esc = String(code).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[ \\-]?');
  return new RegExp('^' + esc + '$', 'i');
}
function dayRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00.000${TZ()}`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start, end };
}
const num = (path) => ({ $convert: { input: path, to: 'double', onError: 0, onNull: 0 } });
const SALE_STATUS = ['DELIVERED', 'PAID', 'LOADED', 'COMPLETED'];
const CASH_METHODS = ['CASH'];
// INCENTIVE orders are a monthly customer-bonus programme: goods given out with
// NO cash collected. Fido excludes them from sales & cash entirely (they are
// tracked separately). An order is incentive if its orderType OR paymentMethod
// says so. Mongo match fragment to keep only NORMAL (revenue) orders:
const NOT_INCENTIVE = { orderType: { $ne: 'INCENTIVE' }, paymentMethod: { $ne: 'INCENTIVE' } };
const IS_INCENTIVE = { $or: [{ orderType: 'INCENTIVE' }, { paymentMethod: 'INCENTIVE' }] };
const isIncentiveOrder = (o) => String(o && o.orderType || '').toUpperCase() === 'INCENTIVE' || String(o && o.paymentMethod || '').toUpperCase() === 'INCENTIVE';

/** Aggregate one site's sales for one day from `fidoorders`. */
async function getSales(siteCode, dateStr) {
  const db = await getDb();
  const { start, end } = dayRange(dateStr);
  const match = { site: siteRegex(siteCode), createdAt: { $gte: start, $lt: end }, status: { $in: SALE_STATUS } };
  const [res] = await db.collection('fidoorders').aggregate([
    { $match: match },
    { $addFields: { _amt: num('$txn_amount') } },
    { $facet: {
      // Sales/cash/products count only NORMAL (revenue) orders — incentive excluded.
      byPayment: [{ $match: NOT_INCENTIVE }, { $group: { _id: '$paymentMethod', amount: { $sum: '$_amt' }, count: { $sum: 1 } } }, { $sort: { amount: -1 } }],
      byProduct: [{ $match: { ...NOT_INCENTIVE, 'products.name': { $ne: 'INCENTIVE' } } },
        { $unwind: { path: '$products', preserveNullAndEmptyArrays: false } },
        { $match: { 'products.name': { $ne: 'INCENTIVE' } } },
        { $group: { _id: '$products.name', qty: { $sum: num('$products.qty') }, amount: { $sum: num('$products.amount') } } },
        { $sort: { amount: -1 } }],
      total: [{ $match: NOT_INCENTIVE }, { $group: { _id: null, amount: { $sum: '$_amt' }, orders: { $sum: 1 } } }],
      incentive: [{ $match: IS_INCENTIVE }, { $group: { _id: null, amount: { $sum: '$_amt' }, orders: { $sum: 1 } } }],
    } },
  ]).toArray();

  const byPayment = (res?.byPayment || []).map((p) => ({ method: p._id || 'UNKNOWN', amount: p.amount, count: p.count }));
  const lines = (res?.byProduct || []).map((p) => ({ product: p._id || 'UNKNOWN', qty: p.qty, amount: p.amount }));
  const total = res?.total?.[0]?.amount || 0;
  const orders = res?.total?.[0]?.orders || 0;
  const total_cash = byPayment.filter((p) => CASH_METHODS.includes(p.method)).reduce((a, p) => a + p.amount, 0);
  const total_deposit = total - total_cash;
  return { site: siteCode, date: dateStr, total, orders, total_cash, total_deposit, payments: byPayment, lines, incentive: res?.incentive?.[0]?.amount || 0, incentive_orders: res?.incentive?.[0]?.orders || 0 };
}

/**
 * Individual recent orders for a day (newest first) — powers the live "today's
 * sales" ticker.  Returns lightweight rows: site, customer, amount, method, time.
 */
async function recentOrders({ sites, date, limit = 40 }) {
  const db = await getDb();
  const { start, end } = dayRange(date || new Date().toISOString().slice(0, 10));
  const match = { createdAt: { $gte: start, $lt: end }, status: { $in: SALE_STATUS } };
  if (Array.isArray(sites) && sites.length) match.$or = sites.map((c) => ({ site: siteRegex(c) }));
  const rows = await db.collection('fidoorders')
    .find(match, { projection: { site: 1, txn_amount: 1, paymentMethod: 1, orderType: 1, customer: 1, customerName: 1, customer_name: 1, transfer_from_account_name: 1, products: 1, createdAt: 1 } })
    .sort({ createdAt: -1 }).limit(Math.min(+limit || 40, 100)).toArray();
  const n = (v) => { const x = typeof v === 'object' && v && '$numberDecimal' in v ? parseFloat(v.$numberDecimal) : Number(v); return isNaN(x) ? 0 : x; };
  const nameMap = await customerNameMap(db, rows);
  return rows.map((o) => ({
    id: String(o._id),
    site: o.site || '',
    customer: orderCustomer(o, nameMap),
    amount: Math.round(n(o.txn_amount)),
    payment_method: isIncentiveOrder(o) ? 'INCENTIVE' : String(o.paymentMethod || 'CASH').toUpperCase(),
    items: Array.isArray(o.products) ? o.products.length : 0,
    at: o.createdAt,
  }));
}

/**
 * Individual orders across a date range (newest first), WITH line items — powers
 * the "orders for this site" drill-down and printable per-order detail.
 */
const n2 = (v) => { const x = typeof v === 'object' && v && '$numberDecimal' in v ? parseFloat(v.$numberDecimal) : Number(v); return isNaN(x) ? 0 : x; };
const ORDER_PROJ = { site: 1, txn_amount: 1, paymentMethod: 1, orderType: 1, customer: 1, customerName: 1, customer_name: 1, transfer_from_account_name: 1, contactPhone: 1, products: 1, createdAt: 1, fidoOrderId: 1, orderId: 1, userName: 1, tellerId: 1, acquirer: 1, bank: 1, card_bank: 1, transfer_from_bank: 1, terminal_location: 1 };

// Fido orders reference a Customer by ObjectId (the name lives in the customers
// collection); transfers also carry the depositor's bank-account name. Resolve a
// best-effort display name for a batch of orders → Map(orderId → name).
async function customerNameMap(db, rows) {
  const { ObjectId } = require('mongodb');
  const ids = [...new Set(rows.map((o) => o && o.customer).filter(Boolean).map(String))];
  const byCust = new Map();
  if (ids.length) {
    const oids = ids.map((s) => { try { return new ObjectId(s); } catch { return null; } }).filter(Boolean);
    for (const coll of ['customers', 'fiacustomers', 'fia_customers']) {
      try {
        const docs = await db.collection(coll).find({ _id: { $in: oids } }, { projection: { name: 1 } }).toArray();
        for (const d of docs) { const nm = String(d.name || '').trim(); if (nm) byCust.set(String(d._id), nm); }
      } catch { /* collection may not exist for this tenant */ }
    }
  }
  return byCust;
}
// Best display name for one order, given the resolved customer-name map.
const orderCustomer = (o, nameMap) =>
  (o.customer && nameMap && nameMap.get(String(o.customer)))
  || String(o.customerName || o.customer_name || o.transfer_from_account_name || '').trim()
  || null;
// Which bank/terminal a payment went through: POS uses the acquirer/card bank +
// terminal location; transfer uses the source bank.
const orderBank = (o) => String(o.acquirer || o.card_bank || o.bank || o.transfer_from_bank || '').trim().toUpperCase() || null;
const mapOrder = (o, nameMap) => ({
  id: String(o._id),
  order_no: o.fidoOrderId ?? o.orderId ?? null,
  site: o.site || '',
  customer: orderCustomer(o, nameMap),
  entry_by: String(o.userName || '').trim() || null,
  amount: Math.round(n2(o.txn_amount)),
  payment_method: isIncentiveOrder(o) ? 'INCENTIVE' : String(o.paymentMethod || 'CASH').toUpperCase(),
  bank: orderBank(o),
  terminal: String(o.terminal_location || '').trim().toUpperCase() || null,
  items: (Array.isArray(o.products) ? o.products : []).map((p) => ({
    name: p.name || 'Item', qty: n2(p.qty), price: n2(p.price), amount: Math.round(n2(p.amount) || n2(p.qty) * n2(p.price)),
  })),
  at: o.createdAt,
});
// `method`: 'CASH' | 'TRANSFER' | 'POS' | 'NONCASH' (transfer+pos)
function methodMatch(method) {
  if (!method) return null;
  const m = String(method).toUpperCase();
  if (m === 'CASH') return { paymentMethod: siteRegex('CASH') };
  if (m === 'NONCASH') return { paymentMethod: { $not: siteRegex('CASH') } };
  return { paymentMethod: siteRegex(m) };
}
const exactRegex = (s) => new RegExp(`^${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
async function listOrders({ from, to, sites, method, bank, terminal, limit = 500 }) {
  const db = await getDb();
  const start = new Date(`${from}T00:00:00.000${TZ()}`);
  const end = new Date(new Date(`${to}T00:00:00.000${TZ()}`).getTime() + 24 * 3600 * 1000);
  const match = { createdAt: { $gte: start, $lt: end }, status: { $in: SALE_STATUS } };
  const ands = [];
  if (Array.isArray(sites) && sites.length) ands.push({ $or: sites.map((c) => ({ site: siteRegex(c) })) });
  // Show incentive orders only when explicitly asked; otherwise exclude them so
  // lists match the (incentive-free) sales/cash/transfer totals.
  if (String(method || '').toUpperCase() === 'INCENTIVE') Object.assign(match, IS_INCENTIVE);
  else { Object.assign(match, NOT_INCENTIVE); const mm = methodMatch(method); if (mm) Object.assign(match, mm); }
  // Filter by which bank / POS terminal the payment went through.
  if (bank) ands.push({ $or: ['acquirer', 'card_bank', 'bank', 'transfer_from_bank'].map((f) => ({ [f]: exactRegex(bank) })) });
  if (terminal) match.terminal_location = exactRegex(terminal);
  if (ands.length) match.$and = ands;
  const rows = await db.collection('fidoorders')
    .find(match, { projection: ORDER_PROJ })
    .sort({ createdAt: -1 }).limit(Math.min(+limit || 500, 1000)).toArray();
  const nameMap = await customerNameMap(db, rows);
  return rows.map((o) => mapOrder(o, nameMap));
}

// Non-cash sales grouped by POS terminal / transfer bank, for the dashboard drill.
async function bankBreakdown({ from, to, sites }) {
  const db = await getDb();
  const start = new Date(`${from}T00:00:00.000${TZ()}`);
  const end = new Date(new Date(`${to}T00:00:00.000${TZ()}`).getTime() + 24 * 3600 * 1000);
  const match = {
    createdAt: { $gte: start, $lt: end }, status: { $in: SALE_STATUS },
    orderType: { $ne: 'INCENTIVE' },
    paymentMethod: { $not: siteRegex('CASH'), $ne: 'INCENTIVE' },
  };
  if (Array.isArray(sites) && sites.length) match.$or = sites.map((c) => ({ site: siteRegex(c) }));
  const rows = await db.collection('fidoorders').aggregate([
    { $match: match },
    { $addFields: {
      _amt: num('$txn_amount'),
      _bank: { $toUpper: { $ifNull: ['$acquirer', { $ifNull: ['$card_bank', { $ifNull: ['$bank', { $ifNull: ['$transfer_from_bank', ''] }] }] }] } },
      _term: { $toUpper: { $ifNull: ['$terminal_location', ''] } },
      _pos: { $regexMatch: { input: { $toUpper: { $ifNull: ['$paymentMethod', ''] } }, regex: 'POS|CARD' } },
    } },
    { $group: { _id: { bank: '$_bank', term: '$_term', pos: '$_pos' }, amount: { $sum: '$_amt' }, orders: { $sum: 1 } } },
    { $sort: { amount: -1 } }, { $limit: 200 },
  ]).toArray();
  return rows.map((r) => ({
    kind: r._id.pos ? 'POS' : 'TRANSFER',
    bank: r._id.bank || null, terminal: r._id.term || null,
    amount: Math.round(r.amount || 0), orders: r.orders,
  }));
}
/** One order by its Mongo _id (for the live-line / order-detail drill-down). */
async function getOrder(id) {
  const db = await getDb();
  let _id; try { _id = new (require('mongodb').ObjectId)(id); } catch { return null; }
  const o = await db.collection('fidoorders').findOne({ _id }, { projection: ORDER_PROJ });
  if (!o) return null;
  const nameMap = await customerNameMap(db, [o]);
  return mapOrder(o, nameMap);
}

/** Sum a site's expenses for one day from `expenses`. */
async function getExpensesTotal(siteCode, dateStr) {
  const db = await getDb();
  const { start, end } = dayRange(dateStr);
  const [r] = await db.collection('expenses').aggregate([
    { $match: { site: siteRegex(siteCode), createdAt: { $gte: start, $lt: end } } },
    { $group: { _id: null, total: { $sum: num('$txn_amount') }, count: { $sum: 1 } } },
  ]).toArray();
  return { total: r?.total || 0, count: r?.count || 0 };
}

/** Read computed payroll rows (already finalised in the POS) for a month/year. */
async function getPayroll({ month, year, siteName }) {
  const db = await getDb();
  const q = {};
  if (month) q.month = month;
  if (year) q.year = String(year);
  const rows = await db.collection('payrolls').aggregate([
    { $match: q },
    { $lookup: { from: 'peoples', localField: 'payee', foreignField: '_id', as: 'p' } },
    { $lookup: { from: 'sites', localField: 'site', foreignField: '_id', as: 's' } },
    { $addFields: { staff: { $ifNull: [{ $arrayElemAt: ['$p.name', 0] }, 'Unknown'] }, siteName: { $arrayElemAt: ['$s.name', 0] } } },
    ...(siteName ? [{ $match: { siteName: new RegExp('^' + String(siteName).replace(/[\s-]+/g, '[ \\-]?') + '$', 'i') } }] : []),
    { $project: { _id: 0, staff: 1, siteName: 1, month: 1, year: 1, status: 1,
      grossPay: num('$grossPay'), netPay: num('$netPay'), deductions: num('$deductions'),
      daysWorked: num('$daysWorked'), bagsBagged: num('$bagsBagged') } },
    { $sort: { siteName: 1, staff: 1 } }, { $limit: 1000 },
  ]).toArray();
  return rows;
}

/** Active staff (peoples) with resolved site name — for the import feature. */
async function getStaff() {
  const db = await getDb();
  return db.collection('peoples').aggregate([
    { $match: { $or: [{ status: 'ACTIVE' }, { status: { $exists: false } }] } },
    { $lookup: { from: 'sites', localField: 'site', foreignField: '_id', as: 's' } },
    { $project: { _id: 0, ext_id: { $toString: '$_id' }, name: 1, siteName: { $arrayElemAt: ['$s.name', 0] }, jobName: 1 } },
    { $limit: 2000 },
  ]).toArray();
}

const rxEscape = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Type-ahead over fido `peoples` (staff) by name. */
async function searchStaff(q, limit = 8) {
  const db = await getDb();
  const rx = new RegExp(rxEscape(q), 'i');
  const rows = await db.collection('peoples').find({ name: rx }, { projection: { _id: 1, name: 1, jobName: 1, department: 1, phone: 1 } }).limit(limit).toArray();
  return rows.map((r) => ({ ext_id: String(r._id), name: r.name, role: r.jobName || r.department || null, phone: r.phone || null }));
}
/** Type-ahead over fido `customers` by name. */
async function searchCustomers(q, limit = 8) {
  const db = await getDb();
  const rx = new RegExp(rxEscape(q), 'i');
  const rows = await db.collection('customers').find({ name: rx }, { projection: { _id: 1, name: 1, phone: 1 } }).limit(limit).toArray();
  return rows.map((r) => ({ ext_id: String(r._id), name: r.name, phone: r.phone || null }));
}

/**
 * Flexible read-only aggregation over fidoorders — the surface the AI tool calls.
 * args: { from:'YYYY-MM-DD', to:'YYYY-MM-DD', site?, groupBy?:'site'|'paymentMethod'|'product'|'day' }
 */
async function query({ from, to, site, sites, groupBy = 'site' }) {
  const db = await getDb();
  const start = new Date(`${from}T00:00:00.000${TZ()}`);
  const end = new Date(new Date(`${to}T00:00:00.000${TZ()}`).getTime() + 24 * 3600 * 1000);
  const match = { createdAt: { $gte: start, $lt: end }, status: { $in: SALE_STATUS }, ...NOT_INCENTIVE };
  // Tenant isolation: when a site allowlist is given, restrict to those sites.
  if (Array.isArray(sites) && sites.length) match.$or = sites.map((c) => ({ site: siteRegex(c) }));
  else if (site) match.site = siteRegex(site);
  let pipeline;
  if (groupBy === 'product') {
    pipeline = [{ $match: match }, { $unwind: '$products' },
      { $group: { _id: '$products.name', amount: { $sum: num('$products.amount') }, qty: { $sum: num('$products.qty') } } }];
  } else {
    const key = groupBy === 'paymentMethod' ? '$paymentMethod'
      : groupBy === 'day' ? { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ() } } : '$site';
    pipeline = [{ $match: match }, { $addFields: { _amt: num('$txn_amount') } },
      { $group: { _id: key, amount: { $sum: '$_amt' }, orders: { $sum: 1 } } }];
  }
  pipeline.push({ $sort: { amount: -1 } }, { $limit: 100 });
  const rows = await db.collection('fidoorders').aggregate(pipeline).toArray();
  return rows.map((r) => ({ group: r._id, amount: Math.round(r.amount || 0), orders: r.orders, qty: r.qty }));
}

/** Sum of INCENTIVE (bonus) orders for a date range — tracked apart from sales. */
async function incentiveTotal({ from, to, site, sites }) {
  const db = await getDb();
  const start = new Date(`${from}T00:00:00.000${TZ()}`);
  const end = new Date(new Date(`${to}T00:00:00.000${TZ()}`).getTime() + 24 * 3600 * 1000);
  const match = { createdAt: { $gte: start, $lt: end }, status: { $in: SALE_STATUS } };
  // IS_INCENTIVE is itself an $or — combine with the sites $or via $and so the
  // incentive filter is never clobbered (otherwise it sums ALL sales).
  if (Array.isArray(sites) && sites.length) match.$and = [{ $or: IS_INCENTIVE.$or }, { $or: sites.map((c) => ({ site: siteRegex(c) })) }];
  else { Object.assign(match, IS_INCENTIVE); if (site) match.site = siteRegex(site); }
  const [r] = await db.collection('fidoorders').aggregate([
    { $match: match }, { $group: { _id: null, amount: { $sum: num('$txn_amount') }, orders: { $sum: 1 } } },
  ]).toArray();
  return { amount: Math.round(r?.amount || 0), orders: r?.orders || 0 };
}

/** Aggregate fido `expenses` by site / category / day for a date range. */
async function queryExpenses({ from, to, site, sites, groupBy = 'site' }) {
  const db = await getDb();
  const start = new Date(`${from}T00:00:00.000${TZ()}`);
  const end = new Date(new Date(`${to}T00:00:00.000${TZ()}`).getTime() + 24 * 3600 * 1000);
  const match = { createdAt: { $gte: start, $lt: end } };
  if (Array.isArray(sites) && sites.length) match.$or = sites.map((c) => ({ site: siteRegex(c) }));
  else if (site) match.site = siteRegex(site);
  const key = groupBy === 'category' ? '$category'
    : groupBy === 'day' ? { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ() } } : '$site';
  const rows = await db.collection('expenses').aggregate([
    { $match: match }, { $group: { _id: key, amount: { $sum: num('$txn_amount') }, count: { $sum: 1 } } },
    { $sort: { amount: -1 } }, { $limit: 100 },
  ]).toArray();
  return rows.map((r) => ({ group: r._id || 'UNKNOWN', amount: Math.round(r.amount || 0), count: r.count }));
}

/** Aggregate fido `payrolls` (gross/net) by site for a month+year. */
async function payrollAgg({ month, year, sites }) {
  const db = await getDb();
  const q = {}; if (month) q.month = month; if (year) q.year = String(year);
  const pipeline = [{ $match: q },
    { $lookup: { from: 'sites', localField: 'site', foreignField: '_id', as: 's' } },
    { $addFields: { siteName: { $arrayElemAt: ['$s.name', 0] } } }];
  if (Array.isArray(sites) && sites.length) pipeline.push({ $match: { $or: sites.map((c) => ({ siteName: siteRegex(c) })) } });
  pipeline.push({ $group: { _id: '$siteName', gross: { $sum: num('$grossPay') }, net: { $sum: num('$netPay') }, staff: { $sum: 1 } } }, { $sort: { net: -1 } }, { $limit: 100 });
  const rows = await db.collection('payrolls').aggregate(pipeline).toArray();
  return rows.map((r) => ({ group: r._id || 'UNKNOWN', gross: Math.round(r.gross || 0), net: Math.round(r.net || 0), staff: r.staff }));
}

/** Count active staff (`peoples`) by site. */
async function staffCount({ sites }) {
  const db = await getDb();
  const pipeline = [{ $lookup: { from: 'sites', localField: 'site', foreignField: '_id', as: 's' } },
    { $addFields: { siteName: { $arrayElemAt: ['$s.name', 0] } } }];
  if (Array.isArray(sites) && sites.length) pipeline.push({ $match: { $or: sites.map((c) => ({ siteName: siteRegex(c) })) } });
  pipeline.push({ $group: { _id: '$siteName', count: { $sum: 1 } } }, { $sort: { count: -1 } });
  const rows = await db.collection('peoples').aggregate(pipeline).toArray();
  return rows.map((r) => ({ group: r._id || 'UNKNOWN', count: r.count }));
}

async function ping() {
  try { await getDb(); await _client.db(DBNAME()).command({ ping: 1 }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { salesEnabled, getDb, getSales, recentOrders, listOrders, getOrder, getExpensesTotal, getPayroll, getStaff, searchStaff, searchCustomers, query, queryExpenses, payrollAgg, staffCount, ping, incentiveTotal, isIncentiveOrder, bankBreakdown };
