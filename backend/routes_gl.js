/**
 * Daybook — General Ledger API. Mounted at /api/gl. Finance-only (Snr Accountant+).
 * Trial balance, per-account ledger, manual journals, and subledger sync.
 */
'use strict';

const express = require('express');
const { requireAuth, contextFor, requestedTenant, atLeast } = require('./auth');
const gl = require('./gl');
const { qall, qone, qrun } = require('./db');

const router = express.Router();

async function ctxFor(req, res, minRole = 'SNR_ACCOUNTANT') {
  const tid = requestedTenant(req);
  if (!tid) { res.status(400).json({ error: 'select a workspace' }); return null; }
  const c = await contextFor(req.user, tid);
  if (!c) { res.status(403).json({ error: 'no access' }); return null; }
  if (!atLeast(c.role, minRole)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return c;
}

// Trial balance (+ chart with balances). as_of=YYYY-MM-DD optional.
router.get('/trial-balance', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res); if (!c) return;
  try {
    const rows = await gl.trialBalance(c.tenant_id, req.query.as_of || null);
    const totals = rows.reduce((a, r) => ({ debit: a.debit + Math.max(r.balance, 0) * (r.normal === 'D' ? 1 : 0), credit: a.credit + Math.max(r.balance, 0) * (r.normal === 'C' ? 1 : 0) }), { debit: 0, credit: 0 });
    res.json({ accounts: rows, totals: { debit: Math.round(totals.debit * 100) / 100, credit: Math.round(totals.credit * 100) / 100 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-account ledger. from/to optional.
router.get('/account/:code', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res); if (!c) return;
  try {
    const lines = await gl.accountLedger(c.tenant_id, req.params.code, { from: req.query.from, to: req.query.to });
    res.json({ code: req.params.code, name: gl.ACCT_NAME[req.params.code] || req.params.code, lines });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent journals.
router.get('/journals', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res); if (!c) return;
  const lo = req.query.from || '2000-01-01', hi = req.query.to || '2999-12-31';
  const js = await qall(
    `SELECT j.id, j.jdate, j.memo, j.source_type, j.voided,
            (SELECT COALESCE(SUM(debit),0) FROM gl_lines WHERE journal_id=j.id) amount
       FROM gl_journals j WHERE j.tenant_id=? AND j.jdate>=? AND j.jdate<=?
      ORDER BY j.jdate DESC, j.created_at DESC LIMIT 300`, [c.tenant_id, lo, hi]);
  res.json(js);
});

// One journal with its lines.
router.get('/journals/:id', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res); if (!c) return;
  const j = await qone('SELECT * FROM gl_journals WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!j) return res.status(404).json({ error: 'not found' });
  j.lines = await qall('SELECT account_code, debit, credit, memo FROM gl_lines WHERE journal_id=? ORDER BY debit DESC', [j.id]);
  res.json(j);
});

// Manual journal entry. body: { jdate, memo, lines:[{account_code,debit,credit,memo}] }.
router.post('/journals', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res); if (!c) return;
  const b = req.body || {};
  if (!b.jdate) return res.status(400).json({ error: 'date required' });
  try {
    const id = await gl.postJournal(c.tenant_id, {
      jdate: b.jdate, memo: b.memo, source_type: 'manual', posted_by: req.user.id, lines: b.lines,
    });
    res.status(201).json({ id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Void a journal (keeps the record, removes it from balances).
router.post('/journals/:id/void', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res); if (!c) return;
  const j = await qone('SELECT * FROM gl_journals WHERE id=? AND tenant_id=?', [req.params.id, c.tenant_id]);
  if (!j) return res.status(404).json({ error: 'not found' });
  if (j.source_type && j.source_type !== 'manual') return res.status(400).json({ error: 'derived journals cannot be voided — fix the source record' });
  await qrun('UPDATE gl_journals SET voided=1 WHERE id=?', [j.id]);
  res.json({ ok: true });
});

// Sync journals from subledgers (idempotent). body: { from, to } optional.
router.post('/sync', requireAuth, async (req, res) => {
  const c = await ctxFor(req, res); if (!c) return;
  const b = req.body || {};
  try {
    const counts = await gl.syncFromRecords(c.tenant_id, { from: b.from, to: b.to, posted_by: req.user.id });
    res.json({ ok: true, posted: counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
