/**
 * Daybook — Logistics module (Phase 3)
 *
 * Covers the Fido gate/loading/dispatch flow:
 *   Distributor → assigns Vehicle → Loading Order (PENDING)
 *   → Gate approves (LOADED) → Truck departs (DISPATCHED)
 *   → Delivery confirmed (DELIVERED) → Cashback settled (SETTLED)
 *
 * Mounted at /api/logistics
 */
'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');
const { requireAuth, contextFor, requestedTenant, atLeast } = require('./auth');

const router = express.Router();
const nowS = () => Math.floor(Date.now() / 1000);

// ── shared helpers ────────────────────────────────────────────────────────────
async function needCtx(req, res, minRole = 'SITE_MANAGER') {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  const c = await contextFor(req.user, tid);
  if (!c || !atLeast(c.role, minRole)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISTRIBUTORS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/distributors', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const where = ['d.tenant_id=?'], args = [c.tenant_id];
  if (c.role === 'SITE_MANAGER') { where.push('d.site_id=?'); args.push(c.site_id); }
  else if (req.query.site) { where.push('d.site_id=?'); args.push(req.query.site); }
  const rows = await qall(
    `SELECT d.*, s.name site_name, s.code site_code,
       (SELECT COUNT(*) FROM vehicles v WHERE v.distributor_id=d.id AND v.status='ACTIVE') vehicle_count
     FROM distributors d LEFT JOIN sites s ON s.id=d.site_id
     WHERE ${where.join(' AND ')} ORDER BY d.name`,
    args);
  res.json(rows);
});

router.post('/distributors', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'GENERAL_MANAGER'); if (!c) return;
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const site_id = b.site_id || null;
  if (site_id) {
    const site = await qone('SELECT id FROM sites WHERE id=? AND tenant_id=?', [site_id, c.tenant_id]);
    if (!site) return res.status(400).json({ error: 'invalid site' });
  }
  const id = uuid();
  try {
    await qrun(
      `INSERT INTO distributors (id,tenant_id,site_id,name,phone,bank_name,account_no,account_name,cashback_rate)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, c.tenant_id, site_id, b.name.trim(), b.phone || null,
        b.bank_name || null, b.account_no || null, b.account_name || null,
        parseFloat(b.cashback_rate) || 0]);
  } catch { return res.status(409).json({ error: 'distributor name already exists' }); }
  res.status(201).json(await qone('SELECT * FROM distributors WHERE id=?', [id]));
});

router.patch('/distributors/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'GENERAL_MANAGER'); if (!c) return;
  const d = await qone('SELECT * FROM distributors WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!d) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  await qrun(
    `UPDATE distributors SET name=?,phone=?,bank_name=?,account_no=?,account_name=?,cashback_rate=?,status=?,site_id=? WHERE id=?`,
    [b.name ?? d.name, b.phone ?? d.phone, b.bank_name ?? d.bank_name,
      b.account_no ?? d.account_no, b.account_name ?? d.account_name,
      b.cashback_rate != null ? parseFloat(b.cashback_rate) : d.cashback_rate,
      b.status ?? d.status, b.site_id !== undefined ? b.site_id : d.site_id, d.id]);
  res.json(await qone('SELECT * FROM distributors WHERE id=?', [d.id]));
});

// ═══════════════════════════════════════════════════════════════════════════════
// VEHICLES
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/vehicles', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { distributor } = req.query;
  const where = ['v.tenant_id=?'], args = [c.tenant_id];
  if (distributor) { where.push('v.distributor_id=?'); args.push(distributor); }
  const rows = await qall(
    `SELECT v.*, d.name distributor_name FROM vehicles v
       LEFT JOIN distributors d ON d.id=v.distributor_id
      WHERE ${where.join(' AND ')} ORDER BY d.name, v.plate`,
    args);
  res.json(rows);
});

router.post('/vehicles', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'GENERAL_MANAGER'); if (!c) return;
  const b = req.body || {};
  if (!b.plate || !b.distributor_id) return res.status(400).json({ error: 'plate and distributor_id required' });
  const dist = await qone('SELECT id FROM distributors WHERE id=? AND tenant_id=?', [b.distributor_id, c.tenant_id]);
  if (!dist) return res.status(400).json({ error: 'invalid distributor' });
  const id = uuid();
  try {
    await qrun(
      `INSERT INTO vehicles (id,tenant_id,distributor_id,plate,capacity,model) VALUES (?,?,?,?,?,?)`,
      [id, c.tenant_id, b.distributor_id, b.plate.toUpperCase().trim(),
        b.capacity ? parseFloat(b.capacity) : null, b.model || null]);
  } catch { return res.status(409).json({ error: 'vehicle plate already registered' }); }
  res.status(201).json(await qone('SELECT * FROM vehicles WHERE id=?', [id]));
});

router.patch('/vehicles/:id', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'GENERAL_MANAGER'); if (!c) return;
  const v = await qone('SELECT * FROM vehicles WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!v) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  await qrun('UPDATE vehicles SET plate=?,capacity=?,model=?,status=?,distributor_id=? WHERE id=?',
    [b.plate ? b.plate.toUpperCase().trim() : v.plate, b.capacity != null ? parseFloat(b.capacity) : v.capacity,
      b.model ?? v.model, b.status ?? v.status,
      b.distributor_id ?? v.distributor_id, v.id]);
  res.json(await qone('SELECT * FROM vehicles WHERE id=?', [v.id]));
});

// ═══════════════════════════════════════════════════════════════════════════════
// LOADING ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

const loadingOrderView = async (orderId) => {
  const order = await qone(
    `SELECT lo.*, s.name site_name, s.code site_code,
       v.plate vehicle_plate, d.name distributor_name,
       u.name creator_name
     FROM loading_orders lo
     LEFT JOIN sites s ON s.id=lo.site_id
     LEFT JOIN vehicles v ON v.id=lo.vehicle_id
     LEFT JOIN distributors d ON d.id=lo.distributor_id
     LEFT JOIN users u ON u.id=lo.created_by
     WHERE lo.id=?`, [orderId]);
  if (!order) return null;
  order.items = await qall(
    `SELECT li.*, p.name product_name FROM loading_items li
       LEFT JOIN products p ON p.id=li.product_id
      WHERE li.loading_order_id=? ORDER BY li.product_name`,
    [orderId]);
  return order;
};

router.get('/loading-orders', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const { from, to, site, status, distributor } = req.query;
  const where = ['lo.tenant_id=?'], args = [c.tenant_id];
  if (c.role === 'SITE_MANAGER') { where.push('lo.site_id=?'); args.push(c.site_id); }
  else if (site) { where.push('lo.site_id=?'); args.push(site); }
  if (from)        { where.push('lo.load_date>=?'); args.push(from); }
  if (to)          { where.push('lo.load_date<=?'); args.push(to); }
  if (status)      { where.push('lo.status=?'); args.push(status.toUpperCase()); }
  if (distributor) { where.push('lo.distributor_id=?'); args.push(distributor); }
  const rows = await qall(
    `SELECT lo.*, s.name site_name, v.plate vehicle_plate, d.name distributor_name
     FROM loading_orders lo
     LEFT JOIN sites s ON s.id=lo.site_id
     LEFT JOIN vehicles v ON v.id=lo.vehicle_id
     LEFT JOIN distributors d ON d.id=lo.distributor_id
     WHERE ${where.join(' AND ')} ORDER BY lo.load_date DESC, lo.created_at DESC LIMIT 300`,
    args);
  res.json(rows);
});

router.get('/loading-orders/:id', requireAuth, async (req, res) => {
  const order = await loadingOrderView(req.params.id);
  if (!order) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, order.tenant_id);
  if (!c || (c.role === 'SITE_MANAGER' && order.site_id && order.site_id !== c.site_id))
    return res.status(404).json({ error: 'not found' });
  res.json(order);
});

router.post('/loading-orders', requireAuth, async (req, res) => {
  const c = await needCtx(req, res); if (!c) return;
  const b = req.body || {};
  const site_id = c.role === 'SITE_MANAGER' ? c.site_id : (b.site_id || null);
  if (!site_id)         return res.status(400).json({ error: 'site_id required' });
  if (!b.vehicle_id)    return res.status(400).json({ error: 'vehicle_id required' });
  if (!b.distributor_id) return res.status(400).json({ error: 'distributor_id required' });

  const [site, vehicle, dist] = await Promise.all([
    qone('SELECT id FROM sites WHERE id=? AND tenant_id=?', [site_id, c.tenant_id]),
    qone('SELECT id FROM vehicles WHERE id=? AND tenant_id=?', [b.vehicle_id, c.tenant_id]),
    qone('SELECT * FROM distributors WHERE id=? AND tenant_id=?', [b.distributor_id, c.tenant_id]),
  ]);
  if (!site)    return res.status(400).json({ error: 'invalid site' });
  if (!vehicle) return res.status(400).json({ error: 'invalid vehicle' });
  if (!dist)    return res.status(400).json({ error: 'invalid distributor' });

  const items = Array.isArray(b.items) ? b.items.filter((i) => i.product_name && +i.qty > 0) : [];
  if (!items.length) return res.status(400).json({ error: 'at least one item required' });

  const total_bags   = items.reduce((a, i) => a + (+i.qty || 0), 0);
  const total_amount = items.reduce((a, i) => a + (+i.qty * (+i.unit_price || 0)), 0);
  const cashback_amount = total_bags * (dist.cashback_rate || 0);

  const id = uuid();
  const load_date = b.load_date || new Date().toISOString().slice(0, 10);
  await qrun(
    `INSERT INTO loading_orders
       (id,tenant_id,site_id,vehicle_id,distributor_id,load_date,
        total_bags,total_amount,cashback_amount,notes,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, c.tenant_id, site_id, b.vehicle_id, b.distributor_id, load_date,
      total_bags, total_amount, cashback_amount, b.notes || null, req.user.id]);

  for (const item of items) {
    await qrun(
      `INSERT INTO loading_items (id,loading_order_id,tenant_id,product_id,product_name,qty,unit_price,amount)
       VALUES (?,?,?,?,?,?,?,?)`,
      [uuid(), id, c.tenant_id, item.product_id || null, item.product_name.trim(),
        +item.qty, +item.unit_price || 0, +item.qty * (+item.unit_price || 0)]);
  }

  res.status(201).json(await loadingOrderView(id));
});

// ── Status transitions ────────────────────────────────────────────────────────
const TRANSITIONS = {
  PENDING:    ['LOADED', 'CANCELLED'],
  LOADED:     ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED'],
  DELIVERED:  ['SETTLED'],
};

router.post('/loading-orders/:id/status', requireAuth, async (req, res) => {
  const order = await qone('SELECT * FROM loading_orders WHERE id=?', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, order.tenant_id);
  if (!c || (c.role === 'SITE_MANAGER' && order.site_id && order.site_id !== c.site_id))
    return res.status(404).json({ error: 'not found' });

  const newStatus = (req.body?.status || '').toUpperCase();
  const allowed = TRANSITIONS[order.status] || [];
  if (!allowed.includes(newStatus))
    return res.status(400).json({ error: `Cannot move from ${order.status} to ${newStatus}`, allowed });

  // Managers must approve LOADED; anyone with site access can dispatch/deliver
  if (newStatus === 'LOADED' && !atLeast(c.role, 'GENERAL_MANAGER'))
    return res.status(403).json({ error: 'only a General Manager or Admin can approve loading' });
  if (newStatus === 'SETTLED' && !atLeast(c.role, 'GENERAL_MANAGER'))
    return res.status(403).json({ error: 'only a General Manager or Admin can settle cashback' });

  const updates = { status: newStatus };
  if (newStatus === 'LOADED')      updates.approved_by = req.user.id;
  if (newStatus === 'DISPATCHED')  updates.dispatched_at = nowS();
  if (newStatus === 'DELIVERED')   updates.delivered_at = nowS();

  await qrun(
    `UPDATE loading_orders SET status=?,approved_by=COALESCE(?,approved_by),
       dispatched_at=COALESCE(?,dispatched_at),delivered_at=COALESCE(?,delivered_at) WHERE id=?`,
    [updates.status, updates.approved_by || null,
      updates.dispatched_at || null, updates.delivered_at || null, order.id]);

  // Auto-create cashback record when delivered
  if (newStatus === 'DELIVERED' && order.cashback_amount > 0) {
    await qrun(
      `INSERT INTO cashbacks
         (id,tenant_id,distributor_id,site_id,loading_order_id,period_date,bags,rate,amount)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING`,
      [uuid(), order.tenant_id, order.distributor_id, order.site_id, order.id,
        new Date().toISOString().slice(0, 10),
        order.total_bags,
        order.total_bags > 0 ? +(order.cashback_amount / order.total_bags).toFixed(4) : 0,
        order.cashback_amount]);
  }

  res.json(await loadingOrderView(order.id));
});

// ─── PATCH items ──────────────────────────────────────────────────────────────
router.patch('/loading-orders/:id', requireAuth, async (req, res) => {
  const order = await qone('SELECT * FROM loading_orders WHERE id=?', [req.params.id]);
  if (!order) return res.status(404).json({ error: 'not found' });
  const c = await contextFor(req.user, order.tenant_id);
  if (!c || !atLeast(c.role, 'GENERAL_MANAGER')) return res.status(403).json({ error: 'forbidden' });
  if (!['PENDING', 'LOADED'].includes(order.status))
    return res.status(400).json({ error: 'can only edit PENDING or LOADED orders' });
  const b = req.body || {};
  await qrun('UPDATE loading_orders SET notes=?,vehicle_id=?,distributor_id=? WHERE id=?',
    [b.notes ?? order.notes, b.vehicle_id ?? order.vehicle_id, b.distributor_id ?? order.distributor_id, order.id]);
  res.json(await loadingOrderView(order.id));
});

// ═══════════════════════════════════════════════════════════════════════════════
// CASHBACK
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/cashbacks', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'GENERAL_MANAGER'); if (!c) return;
  const { from, to, distributor, status } = req.query;
  const where = ['cb.tenant_id=?'], args = [c.tenant_id];
  if (distributor) { where.push('cb.distributor_id=?'); args.push(distributor); }
  if (from)   { where.push('cb.period_date>=?'); args.push(from); }
  if (to)     { where.push('cb.period_date<=?'); args.push(to); }
  if (status) { where.push('cb.status=?'); args.push(status.toUpperCase()); }
  const rows = await qall(
    `SELECT cb.*, d.name distributor_name, s.name site_name
     FROM cashbacks cb
     LEFT JOIN distributors d ON d.id=cb.distributor_id
     LEFT JOIN sites s ON s.id=cb.site_id
     WHERE ${where.join(' AND ')} ORDER BY cb.period_date DESC LIMIT 300`,
    args);
  res.json(rows);
});

router.get('/cashbacks/summary', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'GENERAL_MANAGER'); if (!c) return;
  const { from, to } = req.query;
  const where = ['cb.tenant_id=?'], args = [c.tenant_id];
  if (from) { where.push('cb.period_date>=?'); args.push(from); }
  if (to)   { where.push('cb.period_date<=?'); args.push(to); }
  const W = 'WHERE ' + where.join(' AND ');
  const [totals, byDist, byStatus] = await Promise.all([
    qone(`SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(bags),0) bags, COUNT(*) count FROM cashbacks cb ${W}`, args),
    qall(`SELECT d.name distributor, COALESCE(SUM(cb.amount),0) total, COALESCE(SUM(cb.bags),0) bags
          FROM cashbacks cb JOIN distributors d ON d.id=cb.distributor_id
          ${W} GROUP BY d.id, d.name ORDER BY total DESC LIMIT 20`, args),
    qall(`SELECT status, COALESCE(SUM(amount),0) total, COUNT(*) count FROM cashbacks cb ${W} GROUP BY status`, args),
  ]);
  res.json({ totals: { ...totals, count: parseInt(totals.count, 10) }, byDistributor: byDist, byStatus });
});

router.post('/cashbacks/:id/pay', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'GENERAL_MANAGER'); if (!c) return;
  const cb = await qone('SELECT * FROM cashbacks WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!cb) return res.status(404).json({ error: 'not found' });
  if (cb.status !== 'PENDING') return res.status(400).json({ error: 'already settled or cancelled' });
  await qrun(`UPDATE cashbacks SET status='PAID', paid_at=?, notes=? WHERE id=?`,
    [nowS(), req.body?.notes || cb.notes, cb.id]);
  res.json(await qone('SELECT * FROM cashbacks WHERE id=?', [cb.id]));
});

router.post('/cashbacks', requireAuth, async (req, res) => {
  const c = await needCtx(req, res, 'GENERAL_MANAGER'); if (!c) return;
  const b = req.body || {};
  if (!b.distributor_id || !b.period_date || !b.amount)
    return res.status(400).json({ error: 'distributor_id, period_date and amount required' });
  const dist = await qone('SELECT id FROM distributors WHERE id=? AND tenant_id=?', [b.distributor_id, c.tenant_id]);
  if (!dist) return res.status(400).json({ error: 'invalid distributor' });
  const id = uuid();
  await qrun(
    `INSERT INTO cashbacks (id,tenant_id,distributor_id,site_id,period_date,bags,rate,amount,notes)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, c.tenant_id, b.distributor_id, b.site_id || null, b.period_date,
      +b.bags || 0, +b.rate || 0, +b.amount, b.notes || null]);
  res.status(201).json(await qone('SELECT * FROM cashbacks WHERE id=?', [id]));
});

module.exports = router;
