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

/** Aggregate one site's sales for one day from `fidoorders`. */
async function getSales(siteCode, dateStr) {
  const db = await getDb();
  const { start, end } = dayRange(dateStr);
  const match = { site: siteRegex(siteCode), createdAt: { $gte: start, $lt: end }, status: { $in: SALE_STATUS } };
  const [res] = await db.collection('fidoorders').aggregate([
    { $match: match },
    { $addFields: { _amt: num('$txn_amount') } },
    { $facet: {
      byPayment: [{ $group: { _id: '$paymentMethod', amount: { $sum: '$_amt' }, count: { $sum: 1 } } }, { $sort: { amount: -1 } }],
      byProduct: [{ $unwind: { path: '$products', preserveNullAndEmptyArrays: false } },
        { $group: { _id: '$products.name', qty: { $sum: num('$products.qty') }, amount: { $sum: num('$products.amount') } } },
        { $sort: { amount: -1 } }],
      byType: [{ $group: { _id: '$orderType', amount: { $sum: '$_amt' }, count: { $sum: 1 } } }],
      total: [{ $group: { _id: null, amount: { $sum: '$_amt' }, orders: { $sum: 1 } } }],
    } },
  ]).toArray();

  const byPayment = (res?.byPayment || []).map((p) => ({ method: p._id || 'UNKNOWN', amount: p.amount, count: p.count }));
  const lines = (res?.byProduct || []).map((p) => ({ product: p._id || 'UNKNOWN', qty: p.qty, amount: p.amount }));
  const total = res?.total?.[0]?.amount || 0;
  const orders = res?.total?.[0]?.orders || 0;
  const total_cash = byPayment.filter((p) => CASH_METHODS.includes(p.method)).reduce((a, p) => a + p.amount, 0);
  const total_deposit = total - total_cash;
  return { site: siteCode, date: dateStr, total, orders, total_cash, total_deposit, payments: byPayment, lines, incentive: (res?.byType || []).find((t) => t._id === 'INCENTIVE')?.amount || 0 };
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

/**
 * Flexible read-only aggregation over fidoorders — the surface the AI tool calls.
 * args: { from:'YYYY-MM-DD', to:'YYYY-MM-DD', site?, groupBy?:'site'|'paymentMethod'|'product'|'day' }
 */
async function query({ from, to, site, sites, groupBy = 'site' }) {
  const db = await getDb();
  const start = new Date(`${from}T00:00:00.000${TZ()}`);
  const end = new Date(new Date(`${to}T00:00:00.000${TZ()}`).getTime() + 24 * 3600 * 1000);
  const match = { createdAt: { $gte: start, $lt: end }, status: { $in: SALE_STATUS } };
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

module.exports = { salesEnabled, getSales, getExpensesTotal, getPayroll, getStaff, query, queryExpenses, payrollAgg, staffCount, ping };
