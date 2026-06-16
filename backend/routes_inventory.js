/**
 * Daybook — Inventory / stock management.
 *
 * Stock items (raw materials: preforms, caps, labels, film, …) + signed stock
 * movements (RECEIVE +, ISSUE -, ADJUST ±). Current on-hand = Σ(qty). A receive
 * from a vendor can simultaneously create a vendor payable (expense ticket).
 *
 * Mounted at /api/inventory.
 */
'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { qone, qall, qrun, withTransaction } = require('./db');
const { requireAuth, contextFor, requestedTenant, atLeast, siteBound } = require('./auth');

const router = express.Router();
const nowDate = () => new Date().toLocaleDateString('en-CA', { timeZone: process.env.SALES_TZ || 'Africa/Lagos' });

async function ctx(req, res, minRole = 'SECRETARY') {
  const tid = requestedTenant(req) || req.body?.tenant_id;
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  const c = await contextFor(req.user, tid);
  if (!c || !atLeast(c.role, minRole)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return c;
}

// ── Stock items (catalogue) with current on-hand ──────────────────────────────
router.get('/items', requireAuth, async (req, res) => {
  const c = await ctx(req, res, 'GATEMAN'); if (!c) return;   // read for anyone in the tenant
  // Site-bound users see on-hand at their site; cross-site users see the total.
  const onHand = siteBound(c)
    ? '(SELECT COALESCE(SUM(qty),0) FROM stock_moves m WHERE m.item_id=si.id AND m.site_id=?)'
    : '(SELECT COALESCE(SUM(qty),0) FROM stock_moves m WHERE m.item_id=si.id)';
  const args = siteBound(c) ? [c.site_id, c.tenant_id] : [c.tenant_id];
  // last_cost = most recent receive unit cost (for stock valuation).
  const lastCost = "(SELECT m2.unit_cost FROM stock_moves m2 WHERE m2.item_id=si.id AND m2.unit_cost>0 ORDER BY m2.move_date DESC, m2.created_at DESC LIMIT 1)";
  const rows = await qall(
    `SELECT si.*, ${onHand} AS on_hand, ${lastCost} AS last_cost FROM stock_items si
      WHERE si.tenant_id=? AND COALESCE(si.status,'ACTIVE')<>'INACTIVE' ORDER BY si.name`, args);
  res.json(rows.map((r) => {
    const on_hand = Number(r.on_hand), last_cost = Number(r.last_cost) || 0;
    return { ...r, on_hand, last_cost, value: Math.round(on_hand * last_cost * 100) / 100, low: r.reorder_level > 0 && on_hand <= Number(r.reorder_level) };
  }));
});

router.get('/items/suggest', requireAuth, async (req, res) => {
  const c = await ctx(req, res, 'GATEMAN'); if (!c) return;
  const q = (req.query.q || '').toString().trim(); if (q.length < 1) return res.json([]);
  const rows = await qall("SELECT id,name,unit FROM stock_items WHERE tenant_id=? AND name ILIKE ? AND COALESCE(status,'ACTIVE')<>'INACTIVE' ORDER BY name LIMIT 12", [c.tenant_id, `%${q}%`]);
  res.json(rows.map((r) => ({ id: r.id, label: r.name, sub: r.unit || '' })));
});

router.post('/items', requireAuth, async (req, res) => {
  const c = await ctx(req, res, 'SECRETARY'); if (!c) return;
  const b = req.body || {};
  if (!String(b.name || '').trim()) return res.status(400).json({ error: 'name required' });
  const id = uuid();
  try {
    await qrun('INSERT INTO stock_items (id,tenant_id,name,category,unit,sku,barcode,reorder_level) VALUES (?,?,?,?,?,?,?,?)',
      [id, c.tenant_id, b.name.trim(), b.category || null, b.unit || 'unit', b.sku || null, b.barcode || null, +b.reorder_level || 0]);
  } catch { return res.status(409).json({ error: 'a stock item with that name already exists' }); }
  res.status(201).json(await qone('SELECT * FROM stock_items WHERE id=?', [id]));
});

router.patch('/items/:id', requireAuth, async (req, res) => {
  const c = await ctx(req, res, 'SECRETARY'); if (!c) return;
  const it = await qone('SELECT * FROM stock_items WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!it) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  await qrun('UPDATE stock_items SET name=?,category=?,unit=?,sku=?,barcode=?,reorder_level=?,status=? WHERE id=?',
    [b.name ?? it.name, b.category ?? it.category, b.unit ?? it.unit, b.sku ?? it.sku, b.barcode ?? it.barcode,
      b.reorder_level != null ? +b.reorder_level : it.reorder_level, b.status ?? it.status, it.id]);
  res.json(await qone('SELECT * FROM stock_items WHERE id=?', [it.id]));
});

// Movement history for one item.
router.get('/items/:id/moves', requireAuth, async (req, res) => {
  const c = await ctx(req, res, 'GATEMAN'); if (!c) return;
  const it = await qone('SELECT * FROM stock_items WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!it) return res.status(404).json({ error: 'not found' });
  const where = ['m.item_id=?'], args = [it.id];
  if (siteBound(c)) { where.push('(m.site_id=? OR m.site_id IS NULL)'); args.push(c.site_id); }
  res.json(await qall(`SELECT m.*, s.name site_name FROM stock_moves m LEFT JOIN sites s ON s.id=m.site_id
    WHERE ${where.join(' AND ')} ORDER BY m.move_date DESC, m.created_at DESC LIMIT 300`, args));
});

// Low-stock list (on-hand ≤ reorder level).
router.get('/levels/low', requireAuth, async (req, res) => {
  const c = await ctx(req, res, 'GATEMAN'); if (!c) return;
  const onHand = siteBound(c)
    ? '(SELECT COALESCE(SUM(qty),0) FROM stock_moves m WHERE m.item_id=si.id AND m.site_id=?)'
    : '(SELECT COALESCE(SUM(qty),0) FROM stock_moves m WHERE m.item_id=si.id)';
  const args = siteBound(c) ? [c.site_id, c.tenant_id] : [c.tenant_id];
  const rows = await qall(`SELECT si.*, ${onHand} on_hand FROM stock_items si
    WHERE si.tenant_id=? AND COALESCE(si.status,'ACTIVE')<>'INACTIVE' AND si.reorder_level>0 ORDER BY si.name`, args);
  res.json(rows.map((r) => ({ ...r, on_hand: Number(r.on_hand) })).filter((r) => r.on_hand <= r.reorder_level));
});

// ── Stock movement: RECEIVE / ISSUE / ADJUST (optionally creates a payable) ────
router.post('/moves', requireAuth, async (req, res) => {
  const c = await ctx(req, res, 'SECRETARY'); if (!c) return;
  const b = req.body || {};
  // Pick an existing item by id, else find-or-create by name (create on the fly).
  let item = b.item_id ? await qone('SELECT * FROM stock_items WHERE id=? AND tenant_id=?', [b.item_id, c.tenant_id]) : null;
  if (!item && String(b.item_name || '').trim()) {
    const name = String(b.item_name).trim();
    item = await qone('SELECT * FROM stock_items WHERE tenant_id=? AND lower(name)=lower(?)', [c.tenant_id, name]);
    if (!item) {
      await qrun('INSERT INTO stock_items (id,tenant_id,name,unit) VALUES (?,?,?,?) ON CONFLICT (tenant_id, lower(name)) DO NOTHING',
        [uuid(), c.tenant_id, name, b.unit || 'unit']).catch(() => {});
      item = await qone('SELECT * FROM stock_items WHERE tenant_id=? AND lower(name)=lower(?)', [c.tenant_id, name]);
    }
  }
  if (!item) return res.status(400).json({ error: 'pick or name a stock item' });
  const type = ['RECEIVE', 'ISSUE', 'ADJUST'].includes(String(b.type || '').toUpperCase()) ? String(b.type).toUpperCase() : 'RECEIVE';
  const mag = Math.abs(+b.qty || 0);
  if (!mag && type !== 'ADJUST') return res.status(400).json({ error: 'quantity required' });
  // RECEIVE adds, ISSUE subtracts, ADJUST takes the signed qty as given.
  const qty = type === 'RECEIVE' ? mag : type === 'ISSUE' ? -mag : (+b.qty || 0);
  const site_id = siteBound(c) ? c.site_id : (b.site_id || null);
  const move_date = (b.date || nowDate()).slice(0, 10);
  const unit_cost = +b.unit_cost || 0;
  const vendor = (b.vendor || '').toString().trim() || null;
  const moveId = uuid();
  let expense_id = null;

  await withTransaction(async () => {
    // Optionally raise a vendor payable for a credit purchase.
    if (type === 'RECEIVE' && b.create_payable && vendor && unit_cost > 0) {
      expense_id = uuid();
      const amount = Math.round(mag * unit_cost * 100) / 100;
      await qrun(`INSERT INTO vendors (id,tenant_id,name) VALUES (?,?,?) ON CONFLICT (tenant_id, lower(name)) DO NOTHING`, [uuid(), c.tenant_id, vendor]).catch(() => {});
      await qrun(`INSERT INTO expenses (id,tenant_id,site_id,expense_date,category,description,vendor,items_json,amount,amount_paid,status,recorded_by)
        VALUES (?,?,?,?,?,?,?,?,?,0,'UNPAID',?)`,
        [expense_id, c.tenant_id, site_id, move_date, 'INVENTORY', `Stock: ${item.name}`, vendor,
          JSON.stringify([{ name: item.name, qty: mag, price: unit_cost, amount }]), amount, req.user.id]);
    }
    await qrun(`INSERT INTO stock_moves (id,tenant_id,item_id,site_id,type,qty,unit_cost,vendor,ref,note,move_date,expense_id,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [moveId, c.tenant_id, item.id, site_id, type, qty, unit_cost, vendor, b.ref || null, b.note || null, move_date, expense_id, req.user.id]);
  });
  res.status(201).json({ id: moveId, expense_id, qty });
});

router.delete('/moves/:id', requireAuth, async (req, res) => {
  const c = await ctx(req, res, 'SITE_MANAGER'); if (!c) return;
  const m = await qone('SELECT * FROM stock_moves WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!m) return res.status(404).json({ error: 'not found' });
  await qrun('DELETE FROM stock_moves WHERE id=?', [m.id]);
  res.json({ ok: true });
});

module.exports = router;
