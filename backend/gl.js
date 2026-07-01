/**
 * Daybook — General Ledger (double-entry).
 *
 * Daybook's operational tables (pos_sales, expenses, expense_payments,
 * cash_deposits, pay_runs) are the *subledgers*. This module posts balanced
 * journals from them into a proper double-entry GL, idempotently: every derived
 * journal carries (source_type, source_id) with a UNIQUE index, so syncFromRecords
 * can run repeatedly (on demand or nightly) without double-posting.
 *
 * Manual journals (source_type='manual') are also supported for adjustments,
 * depreciation, opening balances, etc.
 */
'use strict';

const { v4: uuid } = require('uuid');
const { qone, qall, qrun, withTransaction, pq } = require('./db');

// ── Chart of accounts (seeded per tenant) ──────────────────────────────────
const CHART = [
  ['1000', 'Cash on hand', 'ASSET', 'D'],
  ['1010', 'Bank', 'ASSET', 'D'],
  ['1100', 'Accounts receivable', 'ASSET', 'D'],
  ['1200', 'Inventory — finished goods', 'ASSET', 'D'],
  ['1210', 'Inventory — consumables', 'ASSET', 'D'],
  ['1500', 'Property, plant & equipment', 'ASSET', 'D'],
  ['1590', 'Accumulated depreciation', 'ASSET', 'C'],   // contra-asset
  ['2000', 'Accounts payable', 'LIABILITY', 'C'],
  ['2100', 'Payroll payable', 'LIABILITY', 'C'],
  ['2200', 'Statutory payable (PAYE/NSITF/ITF/pension)', 'LIABILITY', 'C'],
  ['3000', "Owner's equity", 'EQUITY', 'C'],
  ['3900', 'Retained earnings', 'EQUITY', 'C'],
  ['4000', 'Sales revenue', 'INCOME', 'C'],
  ['5000', 'Cost of goods sold', 'EXPENSE', 'D'],
  ['6000', 'Operating expenses', 'EXPENSE', 'D'],
  ['6100', 'Staff costs', 'EXPENSE', 'D'],
  ['6200', 'Depreciation expense', 'EXPENSE', 'D'],
];
const ACCT_NAME = Object.fromEntries(CHART.map(([c, n]) => [c, n]));

async function ensureChart(tenant_id) {
  const have = await qone('SELECT COUNT(*) n FROM gl_accounts WHERE tenant_id=?', [tenant_id]);
  if (Number(have.n) >= CHART.length) return;
  for (let i = 0; i < CHART.length; i++) {
    const [code, name, type, normal] = CHART[i];
    await qrun(
      `INSERT INTO gl_accounts (tenant_id,code,name,type,normal,sort) VALUES (?,?,?,?,?,?)
       ON CONFLICT (tenant_id,code) DO NOTHING`, [tenant_id, code, name, type, normal, i]);
  }
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Post one balanced journal. lines: [{account_code, debit, credit, memo}].
 * Skips (returns null) if a non-manual journal with the same source already exists.
 * Throws if debits ≠ credits.
 */
async function postJournal(tenant_id, { jdate, memo, source_type = 'manual', source_id = null, posted_by = null, lines }) {
  const clean = (lines || [])
    .map((l) => ({ account_code: String(l.account_code), debit: r2(l.debit), credit: r2(l.credit), memo: l.memo || null }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (clean.length < 2) throw new Error('a journal needs at least two lines');
  const dr = r2(clean.reduce((a, l) => a + l.debit, 0));
  const cr = r2(clean.reduce((a, l) => a + l.credit, 0));
  if (dr !== cr) throw new Error(`unbalanced: debits ${dr} ≠ credits ${cr}`);
  if (dr === 0) return null;

  if (source_type && source_type !== 'manual' && source_id) {
    const dup = await qone('SELECT id FROM gl_journals WHERE tenant_id=? AND source_type=? AND source_id=?', [tenant_id, source_type, source_id]);
    if (dup) return null;
  }
  const jid = uuid();
  await withTransaction(async (client) => {
    const run = (sql, p) => client.query(pq(sql), p);
    await run(
      `INSERT INTO gl_journals (id,tenant_id,jdate,memo,source_type,source_id,posted_by) VALUES (?,?,?,?,?,?,?)`,
      [jid, tenant_id, jdate, memo || null, source_type, source_id, posted_by]);
    for (const l of clean) {
      await run(
        `INSERT INTO gl_lines (id,journal_id,tenant_id,account_code,debit,credit,memo) VALUES (?,?,?,?,?,?,?)`,
        [uuid(), jid, tenant_id, l.account_code, l.debit, l.credit, l.memo]);
    }
  });
  return jid;
}

// Which cash/bank account a payment method lands in.
const cashAcct = (method) => /CASH/i.test(method || '') ? '1000' : '1010';

/**
 * Derive journals from the subledgers for [from,to]. Idempotent. Returns counts.
 */
async function syncFromRecords(tenant_id, { from, to, posted_by = null } = {}) {
  await ensureChart(tenant_id);
  const lo = from || '2000-01-01';
  const hi = to || '2999-12-31';
  const out = { sales: 0, expenses: 0, expense_payments: 0, cash_deposits: 0, payroll: 0, payroll_paid: 0 };
  const bump = async (k, p) => { const id = await p; if (id) out[k]++; };

  // 1. Sales — Dr cash/bank, Cr sales revenue (net of incentive/free goods).
  const sales = await qall(
    `SELECT id, sale_date, total, payment_method FROM pos_sales
      WHERE tenant_id=? AND sale_date>=? AND sale_date<=? AND payment_method<>'INCENTIVE' AND total>0`, [tenant_id, lo, hi]);
  for (const s of sales) {
    await bump('sales', postJournal(tenant_id, {
      jdate: s.sale_date, memo: 'POS sale', source_type: 'sale', source_id: s.id, posted_by,
      lines: [{ account_code: cashAcct(s.payment_method), debit: s.total }, { account_code: '4000', credit: s.total }],
    }));
  }

  // 2. Expenses incurred — Dr expense (staff→6100 else 6000), Cr accounts payable.
  const exps = await qall(
    `SELECT id, expense_date, amount, category FROM expenses
      WHERE tenant_id=? AND expense_date>=? AND expense_date<=? AND amount>0`, [tenant_id, lo, hi]);
  for (const e of exps) {
    const acct = /SALAR|WAGE|PAYROLL/i.test(e.category || '') ? '6100' : '6000';
    await bump('expenses', postJournal(tenant_id, {
      jdate: e.expense_date, memo: `Expense — ${e.category || 'uncategorised'}`, source_type: 'expense', source_id: e.id, posted_by,
      lines: [{ account_code: acct, debit: e.amount }, { account_code: '2000', credit: e.amount }],
    }));
  }

  // 3. Expense payments — Dr accounts payable, Cr cash/bank.
  const pays = await qall(
    `SELECT id, pay_date, amount, method FROM expense_payments
      WHERE tenant_id=? AND pay_date>=? AND pay_date<=? AND amount>0`, [tenant_id, lo, hi]);
  for (const p of pays) {
    await bump('expense_payments', postJournal(tenant_id, {
      jdate: p.pay_date, memo: 'Expense payment', source_type: 'exp_pay', source_id: p.id, posted_by,
      lines: [{ account_code: '2000', debit: p.amount }, { account_code: cashAcct(p.method), credit: p.amount }],
    }));
  }

  // 4. Cash deposits — cash collected moved to bank: Dr Bank, Cr Cash on hand.
  const deps = await qall(
    `SELECT id, deposit_date, amount FROM cash_deposits
      WHERE tenant_id=? AND deposit_date>=? AND deposit_date<=? AND amount>0`, [tenant_id, lo, hi]);
  for (const d of deps) {
    await bump('cash_deposits', postJournal(tenant_id, {
      jdate: d.deposit_date, memo: 'Cash banked', source_type: 'cash_dep', source_id: d.id, posted_by,
      lines: [{ account_code: '1010', debit: d.amount }, { account_code: '1000', credit: d.amount }],
    }));
  }

  // 5. Payroll accrual — Dr Staff costs (gross), Cr Payroll payable (net) + Statutory payable (deductions).
  const runs = await qall(
    `SELECT id, period_to, total_gross, total_net, total_deductions, paid_at FROM pay_runs
      WHERE tenant_id=? AND period_from>=? AND period_from<=? AND total_gross>0`, [tenant_id, lo, hi]);
  for (const run of runs) {
    const gross = r2(run.total_gross), net = r2(run.total_net), ded = r2(run.total_deductions);
    const lines = [{ account_code: '6100', debit: gross }, { account_code: '2100', credit: net }];
    if (ded > 0) lines.push({ account_code: '2200', credit: ded });
    // guard: if net+ded ≠ gross, balance the payable leg to gross
    const cr = r2(net + (ded > 0 ? ded : 0));
    if (cr !== gross) { lines.length = 1; lines.push({ account_code: '2100', credit: gross }); }
    await bump('payroll', postJournal(tenant_id, {
      jdate: run.period_to, memo: 'Payroll accrual', source_type: 'payrun', source_id: run.id, posted_by, lines,
    }));
    // 6. Payroll paid — Dr Payroll payable (net), Cr Bank.
    if (run.paid_at && net > 0) {
      await bump('payroll_paid', postJournal(tenant_id, {
        jdate: run.period_to, memo: 'Payroll paid', source_type: 'payrun_pay', source_id: run.id, posted_by,
        lines: [{ account_code: '2100', debit: net }, { account_code: '1010', credit: net }],
      }));
    }
  }
  return out;
}

/** Trial balance as of a date (inclusive). Returns [{code,name,type,normal,debit,credit,balance}]. */
async function trialBalance(tenant_id, asOf) {
  await ensureChart(tenant_id);
  const hi = asOf || '2999-12-31';
  const rows = await qall(
    `SELECT a.code, a.name, a.type, a.normal, a.sort,
            COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
       FROM gl_accounts a
       LEFT JOIN gl_lines l ON l.tenant_id=a.tenant_id AND l.account_code=a.code
       LEFT JOIN gl_journals j ON j.id=l.journal_id AND j.voided=0 AND j.jdate<=?
      WHERE a.tenant_id=?
      GROUP BY a.code,a.name,a.type,a.normal,a.sort
      ORDER BY a.sort`, [hi, tenant_id]);
  return rows.map((r) => {
    const bal = r.normal === 'D' ? r2(r.debit - r.credit) : r2(r.credit - r.debit);
    return { ...r, debit: r2(r.debit), credit: r2(r.credit), balance: bal };
  });
}

/** Ledger lines for one account in [from,to]. */
async function accountLedger(tenant_id, code, { from, to } = {}) {
  const lo = from || '2000-01-01', hi = to || '2999-12-31';
  return qall(
    `SELECT j.jdate, j.memo, j.source_type, l.debit, l.credit, l.memo line_memo
       FROM gl_lines l JOIN gl_journals j ON j.id=l.journal_id
      WHERE l.tenant_id=? AND l.account_code=? AND j.voided=0 AND j.jdate>=? AND j.jdate<=?
      ORDER BY j.jdate, j.created_at`, [tenant_id, code, lo, hi]);
}

module.exports = { CHART, ACCT_NAME, ensureChart, postJournal, syncFromRecords, trialBalance, accountLedger };
