import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today, getToken, downloadFile } from '../api.js';
import { useStore, useBackHandler, useRole, atLeast } from '../store.jsx';
import Typeahead from '../components/Typeahead.jsx';
import SearchSelect from '../components/SearchSelect.jsx';
import Cash from './Cash.jsx';

const CATS = ['Fuel', 'Maintenance', 'Utilities', 'Supplies', 'Salary', 'Transport', 'Other'];

// First day of the current month — the default start for a vendor statement.
const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

function ExpenseForm({ expense, sites, onSave, onClose }) {
  const { toast, tenant, setDirty, confirm } = useStore();
  const [saving, setSaving] = useState(false);
  // Editing from the combined Group view → pin to this ticket's workspace.
  const ts = (path) => expense?.tenant_id
    ? path + (path.includes('?') ? '&' : '?') + 'tenant=' + expense.tenant_id
    : scoped(path);
  const fetchVendors = useCallback(async (q) => {
    const rows = await api(ts(`/suggest/vendors?q=${encodeURIComponent(q)}`));
    return rows.map((r) => ({ label: r.vendor || r.label, sub: r.sub || '' }));
  }, [tenant]); // eslint-disable-line react-hooks/exhaustive-deps
  const fetchItems = useCallback(async (q) => {
    try { return (await api(ts(`/suggest/expense-items?q=${encodeURIComponent(q)}`))).map((r) => ({ label: r.label })); }
    catch { return []; }
  }, [tenant]); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState({
    // Category is no longer chosen by staff (they often pick the wrong one).
    // Existing tickets keep their category on edit; new ones are left blank and
    // the backend defaults to OTHER — future AI will categorise from the items.
    category: expense?.category || '',
    description: expense?.description || '',
    expense_date: expense?.expense_date || today(),
    site_id: expense?.site_id || sites[0]?.id || '',
    vendor: expense?.vendor || '',
    kind: expense?.kind || 'NON_IMPREST',
  });
  const set = (k, v) => { setDirty(true); setF((p) => ({ ...p, [k]: v })); };

  // Line items: item name, qty, rate → amount = qty × rate.
  const [rows, setRows] = useState(() => {
    let init = [];
    try { init = expense?.items_json ? JSON.parse(expense.items_json) : []; } catch { init = []; }
    if (init.length) return init.map((it) => ({ name: it.name || '', qty: it.qty ?? '', price: it.price ?? '' }));
    // legacy single-amount expense → one item from its amount
    if (expense && expense.amount) return [{ name: expense.description || expense.category || 'Item', qty: '1', price: String(expense.amount) }];
    return [{ name: '', qty: '1', price: '' }];
  });
  const setRow = (i, k, v) => { setDirty(true); setRows((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r))); };
  const addRow = () => { setDirty(true); setRows((p) => [...p, { name: '', qty: '1', price: '' }]); };
  const delRow = (i) => setRows((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : p));
  const lineAmt = (r) => (parseFloat(r.qty) || 0) * (parseFloat(r.price) || 0);
  const total = rows.reduce((s, r) => s + lineAmt(r), 0);
  // Valid to save only with a date and ≥1 line that has a name + amount.
  const canSave = !!f.expense_date && rows.some((r) => r.name.trim() && lineAmt(r) > 0);

  const save = async () => {
    const items = rows.filter((r) => r.name.trim() && lineAmt(r) > 0).map((r) => ({ name: r.name.trim(), qty: +r.qty || 0, price: +r.price || 0 }));
    if (!items.length) return toast('Add at least one item with a name, quantity and rate', 'err');
    if (!f.expense_date) return toast('Date required', 'err');
    if (!await confirm({ title: expense?.id ? 'Save changes to this expense?' : 'Create this expense?', message: `${ngn(total)} · ${items.length} item${items.length > 1 ? 's' : ''}${f.vendor ? ` · ${f.vendor}` : ''}`, confirmText: 'Save' })) return;
    setSaving(true);
    try {
      const body = { ...f, items, amount: total };
      if (expense?.id) await api(ts(`/expenses/${expense.id}`), { method: 'PATCH', body });
      else await api(scoped('/expenses'), { method: 'POST', body });
      toast('Saved ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };

  // ── Incremental payments against this ticket ────────────────────────────────
  const [paid, setPaid] = useState(+expense?.amount_paid || 0);
  const [payments, setPayments] = useState([]);
  const [payForm, setPayForm] = useState(null);   // { amount, date, method, bank, memo }
  const [paying, setPaying] = useState(false);
  const billed = +expense?.amount || total;
  const balance = Math.max(0, Math.round((billed - paid) * 100) / 100);
  const loadPayments = useCallback(async () => {
    if (!expense?.id) return;
    try { setPayments(await api(ts(`/expenses/${expense.id}/payments`))); } catch { /* ignore */ }
  }, [expense?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadPayments(); }, [loadPayments]);
  const recordPayment = async () => {
    const amt = +payForm.amount || 0;
    if (!(amt > 0)) return toast('Enter an amount', 'err');
    setPaying(true);
    try {
      const r = await api(ts(`/expenses/${expense.id}/payments`), { method: 'POST', body: { amount: amt, date: payForm.date, method: payForm.method || null, bank: payForm.bank || null, memo: payForm.memo || null } });
      setPaid(r.amount_paid); setPayForm(null); loadPayments(); onSave && onSave();
      toast(r.status === 'PAID' ? 'Fully paid ✓' : 'Payment recorded ✓', 'ok');
    } catch (e) { toast(e.message || 'Payment failed', 'err'); }
    setPaying(false);
  };
  const STBADGE = { PAID: { bg: '#dcfce7', fg: '#166534' }, PART: { bg: '#fef3c7', fg: '#92400e' }, UNPAID: { bg: '#fee2e2', fg: '#991b1b' } };
  const stKey = balance <= 0.01 ? 'PAID' : (paid > 0 ? 'PART' : 'UNPAID');

  return (
    <div>
      <div className="grip" />
      <h3>{expense?.id ? 'Edit Expense' : 'New Expense'}</h3>
      <label className="fl">Type</label>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button type="button" className={`seg-b${f.kind === 'NON_IMPREST' ? ' on' : ''}`} onClick={() => set('kind', 'NON_IMPREST')}>Non-imprest</button>
        <button type="button" className={`seg-b${f.kind === 'IMPREST' ? ' on' : ''}`} onClick={() => set('kind', 'IMPREST')}>Imprest</button>
      </div>
      <label className="fl">Date</label>
      <input type="date" className="input" style={{ marginBottom: 4 }} value={f.expense_date} max={today()}
        onChange={(e) => set('expense_date', e.target.value)} />
      <label className="fl">Items</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 88px 70px 26px', gap: 6, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', padding: '0 2px 4px' }}>
        <span>Item</span><span style={{ textAlign: 'center' }}>Qty</span><span style={{ textAlign: 'right' }}>Rate</span><span style={{ textAlign: 'right' }}>Amount</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 56px 88px 70px 26px', gap: 6, alignItems: 'center', marginBottom: 6 }}>
          <Typeahead value={r.name} onChange={(v) => setRow(i, 'name', v)} fetchFn={fetchItems}
            allowCreate minChars={1} createLabel={(q) => `➕ Add item “${q}”`} placeholder="Item name" />
          <input className="input" style={{ padding: '8px 6px', textAlign: 'center' }} type="number" inputMode="numeric" value={r.qty} onChange={(e) => setRow(i, 'qty', e.target.value)} />
          <input className="input" style={{ padding: '8px 8px', textAlign: 'right' }} type="number" inputMode="decimal" placeholder="0" value={r.price} onChange={(e) => setRow(i, 'price', e.target.value)} />
          <div style={{ textAlign: 'right', fontWeight: 700, fontSize: 13 }}>{ngn(lineAmt(r))}</div>
          <button onClick={() => delRow(i)} style={{ border: 'none', background: '#fee2e2', color: 'var(--err)', borderRadius: 6, width: 26, height: 26, cursor: 'pointer', fontSize: 14 }}>×</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 8 }} onClick={addRow}>+ Add item</button>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 800, fontSize: 18, padding: '6px 2px 4px' }}>
        <span>Total</span><span style={{ color: 'var(--brand-d)' }}>{ngn(total)}</span>
      </div>

      <label className="fl">Description / note</label>
      <input type="text" className="input" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="optional" />
      <label className="fl">Vendor</label>
      <Typeahead
        value={f.vendor}
        onChange={(v) => set('vendor', v)}
        fetchFn={fetchVendors}
        allowCreate
        createLabel={(q) => `➕ Add new vendor “${q}”`}
        placeholder="Vendor name"
        minChars={1}
      />
      {sites.length > 1 && <>
        <label className="fl">Site</label>
        <SearchSelect value={f.site_id} onChange={(val) => set('site_id', val)} options={sites.map((s) => ({ value: s.id, label: s.name }))} placeholder="Select site" />
      </>}

      {/* Payments — incremental ticket payments + vendor balance */}
      {expense?.id && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong>Payments <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: STBADGE[stKey].bg, color: STBADGE[stKey].fg }}>{stKey}</span></strong>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>paid {ngn(paid)} · <strong style={{ color: balance > 0 ? 'var(--err)' : '#166534' }}>owed {ngn(balance)}</strong></span>
          </div>
          {payments.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ color: 'var(--muted)' }}>{p.pay_date}{p.bank ? ` · ${p.bank}` : ''}{p.memo ? ` · ${p.memo}` : ''}</span>
              <strong>{ngn(p.amount)}</strong>
            </div>
          ))}
          {balance > 0.01 && (payForm ? (
            <div style={{ marginTop: 10, background: 'var(--brand-l)', borderRadius: 10, padding: 10 }}>
              <div className="grid2">
                <div><label className="fl">Amount (₦)</label><input className="input" type="number" inputMode="decimal" value={payForm.amount} onChange={(e) => setPayForm((p) => ({ ...p, amount: e.target.value }))} /></div>
                <div><label className="fl">Date</label><input className="input" type="date" max={today()} value={payForm.date} onChange={(e) => setPayForm((p) => ({ ...p, date: e.target.value }))} /></div>
              </div>
              <div className="grid2">
                <div><label className="fl">Method</label>
                  <select className="input" value={payForm.method} onChange={(e) => setPayForm((p) => ({ ...p, method: e.target.value }))}>
                    <option value="">—</option><option>CASH</option><option>TRANSFER</option><option>POS</option><option>CHEQUE</option>
                  </select></div>
                <div><label className="fl">Bank (optional)</label><input className="input" value={payForm.bank} onChange={(e) => setPayForm((p) => ({ ...p, bank: e.target.value }))} placeholder="e.g. GTB" /></div>
              </div>
              <input className="input" style={{ marginTop: 6 }} value={payForm.memo} onChange={(e) => setPayForm((p) => ({ ...p, memo: e.target.value }))} placeholder="memo (optional)" />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setPayForm(null)} disabled={paying}>Cancel</button>
                <button className="btn" style={{ flex: 1 }} onClick={recordPayment} disabled={paying || !((+payForm.amount || 0) > 0)}>{paying ? <span className="spin" /> : 'Record payment'}</button>
              </div>
            </div>
          ) : (
            <button className="btn btn-sm" style={{ marginTop: 10, width: 'auto', padding: '6px 14px' }}
              onClick={() => setPayForm({ amount: String(balance), date: today(), method: '', bank: '', memo: '' })}>＋ Record payment</button>
          ))}
        </div>
      )}

      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving || !canSave}>
          {saving ? <span className="spin" /> : null} Save
        </button>
      </div>
    </div>
  );
}

const CAT_ICONS = { FUEL: '⛽', DIESEL: '⛽', MAINTENANCE: '🔧', UTILITIES: '💡', SUPPLIES: '📦', SALARY: '👷', TRANSPORT: '🚛', OTHER: '💸' };
const catIcon = (c) => CAT_ICONS[(c || '').toUpperCase()] || '💸';
const ST = { PAID: { bg: '#dcfce7', fg: '#166534' }, PART: { bg: '#fef3c7', fg: '#92400e' }, UNPAID: { bg: '#fee2e2', fg: '#991b1b' } };
const stOf = (e) => (Number(e.balance) <= 0.01 ? 'PAID' : (Number(e.amount_paid) > 0 ? 'PART' : 'UNPAID'));

// Lifecycle (Fido): DRAFT→REVIEWED→APPROVED→PAID→DELIVERED, plus DECLINED.
const WF = {
  DRAFT:     { bg: '#e2e8f0', fg: '#334155', label: 'DRAFT' },
  VALIDATED: { bg: '#fef9c3', fg: '#854d0e', label: 'VALIDATED' },
  REVIEWED:  { bg: '#dbeafe', fg: '#1e40af', label: 'REVIEWED' },
  APPROVED:  { bg: '#ede9fe', fg: '#5b21b6', label: 'APPROVED' },
  PAID:      { bg: '#dcfce7', fg: '#166534', label: 'PAID' },
  DELIVERED: { bg: '#bbf7d0', fg: '#14532d', label: 'DELIVERED' },
  DECLINED:  { bg: '#fee2e2', fg: '#991b1b', label: 'DECLINED' },
};
const WF_ACTION = {
  validate: { label: '✓ Validate', kind: '' },
  review:   { label: '✓ Review', kind: '' },
  approve:  { label: '✓ Approve', kind: '' },
  decline:  { label: '✗ Decline', kind: 'danger' },
  pay:      { label: '💵 Pay', kind: '' },
  reset:    { label: '↺ Reset', kind: 'ghost' },
  // Admin-only: undo an approval and send the ticket back to draft to correct it.
  unapprove: { label: '↺ Back to draft', kind: 'danger' },
};

// Vendor payables — how much we owe each vendor; tap to see their open tickets
// and most recent payments, and drill into any ticket to make corrections.
// ── Receipts ──────────────────────────────────────────────────────────────────
// Every proof-of-payment / receipt in one place, newest first, each one linked to
// the ticket it belongs to. Tap the file to view it; tap the row to open the
// expense behind it. This is what you reach for when a vendor says "we never got
// paid on the 18th" — the bank slip is right here.
function ReceiptsView() {
  const { tenant, toast } = useStore();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [paidOnly, setPaidOnly] = useState(false);   // only slips pinned to a payment
  const [openExp, setOpenExp] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQd(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useBackHandler(!!openExp, () => setOpenExp(null));

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (qd) p.set('q', qd);
    if (paidOnly) p.set('paid', '1');
    api(scoped(`/expenses/attachments?${p}`)).then(setRows).catch(() => setRows([]));
  }, [tenant, qd, paidOnly]);
  useEffect(() => { load(); }, [load]);

  // Fetch with the bearer token, then hand the browser a blob URL — the file route
  // is auth-guarded, so a plain <a href> would 401.
  const view = async (r, download) => {
    try {
      const res = await fetch(
        `/api/expenses/${r.expense_id}/attachments/${r.id}/file${download ? '?download=1&' : '?'}tenant=${tenant || ''}`,
        { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error('Could not open the file');
      const url = URL.createObjectURL(await res.blob());
      if (download) { const x = document.createElement('a'); x.href = url; x.download = r.file_name || 'receipt'; x.click(); }
      else window.open(url, '_blank');
    } catch (e) { toast(e.message || 'Could not open the file', 'err'); }
  };
  const openTicket = async (id) => { try { setOpenExp(await api(scoped(`/expenses/${id}`))); } catch { /* ignore */ } };
  const icon = (m, n) => {
    const s = `${m || ''} ${n || ''}`.toLowerCase();
    if (s.includes('pdf')) return '📕';
    if (/(image|png|jpe?g|gif|webp|heic)/.test(s)) return '🖼';
    if (/(sheet|excel|xls|csv)/.test(s)) return '📊';
    return '📎';
  };
  const kb = (n) => (n ? `${Math.max(1, Math.round(Number(n) / 1024))} KB` : '');

  if (rows === null) return <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="🔍 Search vendor, description, file name…" style={{ marginBottom: 12 }} />
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
          {rows.length} receipt{rows.length !== 1 ? 's' : ''}
        </span>
        <label style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={paidOnly} onChange={(e) => setPaidOnly(e.target.checked)} />
          Payment proofs only
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="empty"><div className="ic">📎</div><p>No receipts uploaded yet</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((r) => (
            <div key={r.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderBottom: '1px solid var(--line)' }}>
              <button onClick={() => view(r, false)} title="View file"
                style={{ fontSize: 22, border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}>
                {icon(r.mime, r.file_name)}
              </button>
              <button onClick={() => openTicket(r.expense_id)}
                style={{ flex: 1, minWidth: 0, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
                <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.vendor || r.description || r.category}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {/* If the slip is pinned to a payment, show THAT payment — the
                      exact transfer it proves. Otherwise fall back to the ticket. */}
                  {r.payment_id ? (
                    <span style={{ color: '#166534', fontWeight: 600 }}>
                      Pays {ngn(r.pay_amount)} on {r.pay_date}
                      {r.pay_bank ? ` · ${r.pay_bank}` : r.pay_method ? ` · ${r.pay_method}` : ''}
                    </span>
                  ) : (
                    <>{r.expense_date} · {ngn(r.amount)}{r.last_payment_date ? ` · last pay ${r.last_payment_date}` : ' · unpaid'}</>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.file_name || 'file'}{r.size ? ` · ${kb(r.size)}` : ''} · uploaded {new Date(Number(r.created_at) * 1000).toLocaleDateString()}
                  {r.uploaded_by_name ? ` by ${r.uploaded_by_name}` : ''}
                  {r.note ? ` · ${r.note}` : ''}
                </div>
              </button>
              <button className="btn btn-ghost" onClick={() => view(r, true)} title="Download"
                style={{ padding: '6px 9px', fontSize: 12 }}>⬇</button>
            </div>
          ))}
        </div>
      )}

      {openExp && (
        <div onClick={() => setOpenExp(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 140, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, margin: 0, maxHeight: '90vh', overflowY: 'auto' }}>
            <ExpenseDetail expense={openExp} onClose={() => setOpenExp(null)} onChanged={load} />
          </div>
        </div>
      )}
    </div>
  );
}

function PayablesView() {
  const { tenant, sites, toast } = useStore();
  const role = useRole();
  const canRestore = !!(role && atLeast(role, 'SNR_ACCOUNTANT'));
  const [rows, setRows] = useState(null);
  const [vendor, setVendor] = useState(null);   // drilled vendor → their open tickets + recent payments
  const [items, setItems] = useState(null);
  const [recent, setRecent] = useState(null);   // up to 10 most recent payments to this vendor
  const [trash, setTrash] = useState(null);     // recently deleted tickets for this vendor (restorable)
  const [openExp, setOpenExp] = useState(null);  // nested ticket detail, stacked ON TOP of the vendor drill
  // Vendor statement (PDF) — date range, so it can be reconciled line-for-line
  // against the vendor's own ledger.
  const [stmtOpen, setStmtOpen] = useState(false);
  const [stmtFrom, setStmtFrom] = useState(monthStart());
  const [stmtTo, setStmtTo] = useState(today());
  const [stmtBusy, setStmtBusy] = useState(false);

  const downloadStatement = async () => {
    if (!vendor || !stmtFrom || !stmtTo) return;
    if (stmtFrom > stmtTo) { toast('Start date is after the end date', 'err'); return; }
    setStmtBusy(true);
    try {
      const q = `from=${stmtFrom}&to=${stmtTo}`;
      await downloadFile(
        scoped(`/expenses/vendors/${encodeURIComponent(vendor.vendor)}/ledger.pdf?${q}`),
        `ledger-${vendor.vendor.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${stmtFrom}-to-${stmtTo}.pdf`,
      );
      setStmtOpen(false);
    } catch (e) { toast(e.message || 'Could not generate the statement', 'err'); }
    setStmtBusy(false);
  };
  // Back closes the top layer first (ticket detail), then the vendor drill.
  useBackHandler(!!vendor || !!openExp, () => { if (openExp) setOpenExp(null); else setVendor(null); });
  const loadRows = useCallback(() => { api(scoped('/expenses/vendors/balances')).then(setRows).catch(() => setRows([])); }, [tenant]);
  useEffect(() => { loadRows(); }, [loadRows]);
  const loadVendor = useCallback(async (v) => {
    try { setItems(await api(scoped(`/expenses?vendor=${encodeURIComponent(v.vendor)}&unpaid=1`))); } catch { setItems([]); }
    try { setRecent(await api(scoped(`/expenses/vendors/${encodeURIComponent(v.vendor)}/recent-payments`))); } catch { setRecent([]); }
    try { setTrash(await api(scoped(`/expenses/deleted?vendor=${encodeURIComponent(v.vendor)}`))); } catch { setTrash([]); }
  }, []);
  const openVendor = (v) => { setVendor(v); setItems(null); setRecent(null); setTrash(null); loadVendor(v); };
  // Undo a delete. Nothing was destroyed — the ticket comes back exactly as it was,
  // attachments and payment history intact.
  const restore = async (e) => {
    try {
      await api(scoped(`/expenses/${e.id}/restore`), { method: 'POST' });
      toast('Expense restored', 'ok');
      loadRows(); if (vendor) loadVendor(vendor);
    } catch (err) { toast(err.message || 'Could not restore', 'err'); }
  };
  const openTicket = async (expenseId) => {
    try { setOpenExp(await api(scoped(`/expenses/${expenseId}`))); } catch { /* ignore */ }
  };
  const afterChange = () => { loadRows(); if (vendor) loadVendor(vendor); };
  const totalOwed = (rows || []).reduce((a, r) => a + r.owed, 0);
  const [pq, setPq] = useState('');   // free-text filter over the payables list
  const q = pq.trim().toLowerCase();
  const shown = q ? (rows || []).filter((r) => (r.vendor || '').toLowerCase().includes(q)) : (rows || []);

  if (rows === null) return <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>We owe {rows.length} vendor{rows.length !== 1 ? 's' : ''}</span>
        <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--err)' }}>{ngn(totalOwed)}</span>
      </div>
      {rows.length > 0 && (
        <input className="input" value={pq} onChange={(e) => setPq(e.target.value)}
          placeholder="🔍 Search vendor…" style={{ marginBottom: 12 }} />
      )}
      {rows.length === 0 ? <div className="empty"><div className="ic">🏦</div><p>Nothing owed — all vendors settled</p></div> : shown.length === 0 ? (
        <div className="empty"><div className="ic">🔍</div><p>No vendor matches “{pq}”</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {shown.map((r) => (
            <button key={r.vendor} onClick={() => openVendor(r)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
              <div className="av" style={{ borderRadius: 8 }}>{(r.vendor || '?').charAt(0).toUpperCase()}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{r.vendor}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>billed {ngn(r.billed)} · paid {ngn(r.paid)} · {r.open_count} open</div>
              </div>
              <div style={{ fontWeight: 800, color: 'var(--err)' }}>{ngn(r.owed)} ›</div>
            </button>
          ))}
        </div>
      )}

      {vendor && (
        <div onClick={() => setVendor(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, margin: 0, maxHeight: '86vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <strong>{vendor.vendor}</strong><strong style={{ color: 'var(--err)' }}>owe {ngn(vendor.owed)}</strong>
            </div>

            {/* Statement of account — reconcile our record against the vendor's own ledger. */}
            <button className="btn btn-ghost" style={{ width: '100%', marginBottom: 10 }}
              onClick={() => { setStmtFrom(monthStart()); setStmtTo(today()); setStmtOpen(true); }}>
              📄 Statement of account (PDF)
            </button>

            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', margin: '4px 0 2px' }}>Open tickets</div>
            {items === null ? <div className="skel" style={{ height: 60 }} /> : items.length === 0 ? <div className="empty" style={{ padding: '8px 0' }}><p>No open tickets</p></div> : items.map((e) => (
              <button key={e.id} onClick={() => openTicket(e.id)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || e.category}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {e.expense_date} · billed {ngn(e.amount)} · paid {ngn(e.amount_paid)}
                    {/* When it was last settled — the question you actually ask of an open ticket. */}
                    {e.last_payment_date ? <span style={{ color: '#166534' }}> · last pay {e.last_payment_date}</span> : ''}
                  </div>
                </div>
                <strong style={{ color: 'var(--err)', whiteSpace: 'nowrap' }}>{ngn(e.balance)} ›</strong>
              </button>
            ))}

            {/* Most recent payments — tap one to open its ticket and correct it. */}
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', margin: '14px 0 2px' }}>Recent payments</div>
            {recent === null ? <div className="skel" style={{ height: 40 }} /> : recent.length === 0 ? <div style={{ fontSize: 13, color: 'var(--muted)', padding: '6px 4px' }}>No payments yet</div> : recent.map((p) => (
              <button key={p.id} onClick={() => openTicket(p.expense_id)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '9px 4px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.description || p.category}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{p.pay_date}{p.method ? ` · ${p.method}` : ''}{p.bank ? ` · ${p.bank}` : ''}</div>
                </div>
                <strong style={{ color: 'var(--brand-d)', whiteSpace: 'nowrap' }}>{ngn(p.amount)} ›</strong>
              </button>
            ))}

            {/* Recently deleted — deletes are reversible for 30 days. Nothing is
                destroyed on delete, so a mistake is one tap away from being undone. */}
            {trash && trash.length > 0 && (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', margin: '14px 0 2px' }}>
                  🗑 Recently deleted
                </div>
                {trash.map((e) => (
                  <div key={e.id}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '9px 4px', borderBottom: '1px solid var(--line)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'line-through', color: 'var(--muted)' }}>
                        {e.description || e.category}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {e.expense_date} · {ngn(e.amount)} · deleted {new Date(Number(e.deleted_at) * 1000).toLocaleDateString()}
                        {e.deleted_by_name ? ` by ${e.deleted_by_name}` : ''}
                      </div>
                      {e.deleted_reason ? <div style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>“{e.deleted_reason}”</div> : null}
                    </div>
                    {canRestore ? (
                      <button className="btn btn-ghost" style={{ padding: '6px 10px', fontSize: 12, whiteSpace: 'nowrap' }}
                        onClick={() => restore(e)}>↩ Restore</button>
                    ) : null}
                  </div>
                ))}
              </>
            )}

            <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => setVendor(null)}>Close</button>
          </div>

          {/* Statement date range — stacked above the vendor drill (z 120). */}
          {stmtOpen && (
            <div onClick={(e) => { if (e.target === e.currentTarget && !stmtBusy) setStmtOpen(false); }}
              style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(15,23,42,.55)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center', padding: 16 }}>
              <div onClick={(e) => e.stopPropagation()}
                style={{ background: 'var(--card, #fff)', borderRadius: 16, padding: 20, width: '100%', maxWidth: 380, boxShadow: '0 20px 60px rgba(15,23,42,.28)' }}>
                <h3 style={{ margin: '0 0 4px' }}>Statement of account</h3>
                <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
                  A ledger for <b>{vendor.vendor}</b> — opening balance, bills, payments and closing balance —
                  laid out like their own statement so you can compare line by line.
                </p>
                <div className="grid2">
                  <div>
                    <label className="fl">From</label>
                    <input type="date" className="input" value={stmtFrom} onChange={(e) => setStmtFrom(e.target.value)} />
                  </div>
                  <div>
                    <label className="fl">To</label>
                    <input type="date" className="input" value={stmtTo} onChange={(e) => setStmtTo(e.target.value)} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 8, marginTop: 14 }}>
                  <button className="btn btn-ghost" disabled={stmtBusy} onClick={() => setStmtOpen(false)}>Cancel</button>
                  <button className="btn" disabled={stmtBusy || !stmtFrom || !stmtTo} onClick={downloadStatement}>
                    {stmtBusy ? <span className="spin" /> : '📄 Download PDF'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Nested ticket detail — stacked above the vendor drill (z 140 > 120).
          Closing it returns to the vendor drill; corrections refresh both. */}
      {openExp && (
        <div onClick={() => setOpenExp(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 140, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, margin: 0, maxHeight: '90vh', overflowY: 'auto' }}>
            <ExpenseDetail
              expense={openExp}
              sites={sites}
              onEdit={() => {}}
              onClose={() => setOpenExp(null)}
              onChanged={afterChange}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// View-first detail: read the ticket, attach receipts/notes, then choose to edit.
function ExpenseDetail({ expense, sites, onEdit, onClose, onChanged }) {
  const { toast, confirm, user, tenants } = useStore();
  const role = useRole();
  // Pin every request to THIS expense's workspace so the detail + approval flow
  // works from the combined Group view too (no single active tenant there).
  const ts = (path) => expense.tenant_id
    ? path + (path.includes('?') ? '&' : '?') + 'tenant=' + expense.tenant_id
    : scoped(path);
  const [pays, setPays] = useState([]);
  const [atts, setAtts] = useState([]);
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [wf, setWf] = useState(expense.wf_state || 'DRAFT');
  const [actions, setActions] = useState([]);
  const [, setLog] = useState([]);
  const [acting, setActing] = useState('');
  // Un-approve dialog — a real in-app modal stacked ON TOP of this ticket modal
  // (the global modal store holds only one, so opening another would REPLACE
  // this one). No browser prompt/alert.
  const [unapOpen, setUnapOpen] = useState(false);
  const [unapReason, setUnapReason] = useState('');
  // Pay form (opened from the Pay action): amount, source bank account, note, receipt.
  const [payOpen, setPayOpen] = useState(false);
  const [payAmt, setPayAmt] = useState('');
  const [payBank, setPayBank] = useState('');
  const [bankQuery, setBankQuery] = useState('');   // searchable input text for the bank picker
  const [payNote, setPayNote] = useState('');
  const [payFile, setPayFile] = useState(null);
  const [banks, setBanks] = useState([]);

  let items = [];
  try { items = expense?.items_json ? JSON.parse(expense.items_json) : []; } catch { items = []; }
  const billed = +expense?.amount || 0;
  const [paid, setPaid] = useState(+expense?.amount_paid || 0);
  const balance = Math.max(0, Math.round((billed - paid) * 100) / 100);
  const st = stOf({ balance, amount_paid: paid });
  const siteName = (sites || []).find((s) => s.id === expense?.site_id)?.name;

  const loadPays = useCallback(async () => {
    try { setPays(await api(ts(`/expenses/${expense.id}/payments`))); } catch { /* ignore */ }
  }, [expense.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadAtts = useCallback(async () => {
    try { setAtts(await api(ts(`/expenses/${expense.id}/attachments`))); } catch { /* ignore */ }
  }, [expense.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadLog = useCallback(async () => {
    try { const r = await api(ts(`/expenses/${expense.id}/log`)); setWf(r.wf_state); setActions(r.actions || []); setLog(r.log || []); }
    catch { /* ignore */ }
  }, [expense.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadPays(); loadAtts(); loadLog(); }, [loadPays, loadAtts, loadLog]);
  // List bank accounts from EVERY workspace the user has (Fido + Fiafia), so any
  // company's account can be picked as the payment source; tag multi-workspace rows.
  useEffect(() => {
    const list = Array.isArray(tenants) ? tenants : [];
    const multi = list.length > 1;
    const tag = (rows, tname) => (Array.isArray(rows) ? rows.filter((b) => b.active) : []).map((b) => ({ ...b, _tenant: multi ? tname : null }));
    if (list.length) {
      Promise.all(list.map((t) => api(`/bank-accounts?tenant=${t.id}`).then((r) => tag(r, t.name)).catch(() => [])))
        .then((parts) => setBanks(parts.flat()));
    } else {
      api(ts('/bank-accounts')).then((r) => setBanks(tag(r, null))).catch(() => setBanks([]));
    }
  }, [expense.id, tenants]); // eslint-disable-line react-hooks/exhaustive-deps

  // Record a (partial or full) payment from the Pay form; attach the receipt and,
  // when it clears the balance, move the ticket to PAID — all in one go.
  const submitPay = async () => {
    const amt = Math.round((parseFloat(payAmt) || 0) * 100) / 100;
    if (!(amt > 0)) return toast('Enter an amount', 'err');
    if (amt > balance + 0.01) return toast(`Max ₦${balance.toLocaleString()} — that's the balance`, 'err');
    setBusy(true);
    try {
      const created = await api(ts(`/expenses/${expense.id}/payments`), { method: 'POST', body: { amount: amt, method: payBank ? 'TRANSFER' : 'CASH', bank: payBank || null, memo: payNote.trim() || null } });
      // Pin the slip to THIS payment, not just the ticket — so a receipt can always
      // be matched back to the exact transfer that left the bank.
      if (payFile) {
        const fd = new FormData();
        fd.append('file', payFile);
        if (payNote.trim()) fd.append('note', payNote.trim());
        if (created && created.id) fd.append('payment_id', created.id);
        await api(ts(`/expenses/${expense.id}/attachments`), { method: 'POST', form: fd }).catch(() => {});
      }
      const newPaid = Math.round((paid + amt) * 100) / 100;
      const newBal = Math.max(0, Math.round((billed - newPaid) * 100) / 100);
      if (newBal <= 0.01 && wf === 'APPROVED') { try { await api(ts(`/expenses/${expense.id}/transition`), { method: 'POST', body: { action: 'pay' } }); } catch { /* keep going */ } }
      setPaid(newPaid);
      setPayOpen(false); setPayAmt(''); setPayBank(''); setPayNote(''); setPayFile(null);
      const inp = document.getElementById('exp-pay-file'); if (inp) inp.value = '';
      loadPays(); loadAtts(); loadLog();
      onChanged && onChanged();
      toast(newBal <= 0.01 ? 'Paid in full ✓' : `Part payment ${ngn(amt)} recorded — ${ngn(newBal)} left`, 'ok');
    } catch (e) { toast(e.message || 'Payment failed', 'err'); }
    setBusy(false);
  };

  const runAction = async (action) => {
    // Pay is not a bare state flip — open the pay form (amount, bank, receipt).
    if (action === 'pay') { setPayAmt(String(balance || '')); setPayOpen(true); return; }
    // Un-approving is destructive and must be explained — collect the reason in a
    // proper in-app dialog stacked over this modal, not a browser prompt.
    if (action === 'unapprove') { setUnapReason(''); setUnapOpen(true); return; }
    let note2;
    if (action === 'decline') {
      // Declining requires a reason — it's a rejection the vendor/owner must understand.
      note2 = (window.prompt('Reason for declining this expense (required):') || '').trim();
      if (!note2) { toast('A reason is required to decline', 'err'); return; }
    } else if (action === 'reset') {
      note2 = window.prompt('Reason for reset (optional):') || '';
    }
    await applyTransition(action, note2);
  };

  // Shared: run one transition and refresh the ticket.
  const applyTransition = async (action, note2) => {
    setActing(action);
    try {
      const r = await api(ts(`/expenses/${expense.id}/transition`), { method: 'POST', body: { action, note: note2 } });
      setWf(r.wf_state); setActions(r.actions || []);
      loadLog();
      onChanged && onChanged();
      const done = { validate: 'Validated ✓', review: 'Reviewed ✓', approve: 'Approved ✓', decline: 'Declined', pay: 'Marked paid ✓', deliver: 'Delivered ✓', reset: 'Reset to draft', unapprove: 'Sent back to draft' };
      toast(done[action] || 'Updated ✓', action === 'decline' ? 'info' : 'ok');
      // Validate / Approve advance the ticket — close the modal back to the preceding screen.
      if (action === 'validate' || action === 'approve') { onClose && onClose(); return; }
    } catch (e) { toast(e.message || 'Action failed', 'err'); }
    setActing('');
  };

  // Confirm from the stacked un-approve dialog.
  const confirmUnapprove = async () => {
    const reason = unapReason.trim();
    if (!reason) { toast('A reason is required', 'err'); return; }
    setUnapOpen(false);
    await applyTransition('unapprove', reason);
  };

  const addAttachment = async () => {
    // A note is required on every entry (so receipts are always explained).
    if (!note.trim()) { toast('Write a note describing this receipt', 'err'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('file', file);
      if (note.trim()) fd.append('note', note.trim());
      await api(ts(`/expenses/${expense.id}/attachments`), { method: 'POST', form: fd });
      setNote(''); setFile(null);
      const inp = document.getElementById('exp-att-file'); if (inp) inp.value = '';
      loadAtts();
      toast('Receipt saved ✓');
    } catch (e) { toast(e.message || 'Upload failed', 'err'); }
    setBusy(false);
  };
  const openReceipt = async (a, download) => {
    try {
      const res = await fetch(`/api/expenses/${expense.id}/attachments/${a.id}/file${download ? '?download=1&' : '?'}tenant=${expense.tenant_id || ''}`,
        { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      if (download) { const x = document.createElement('a'); x.href = url; x.download = a.file_name || 'receipt'; x.click(); }
      else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast('Could not open receipt', 'err'); }
  };
  const delAttachment = async (a) => {
    if (!await confirm({ title: 'Remove this receipt/note?', confirmText: 'Remove', danger: true })) return;
    try { await api(ts(`/expenses/${expense.id}/attachments/${a.id}`), { method: 'DELETE' }); loadAtts(); }
    catch (e) { toast(e.message || 'Could not remove', 'err'); }
  };

  const fileIcon = (m) => (m || '').startsWith('image/') ? '🖼️' : (m || '').includes('pdf') ? '📄' : m ? '📎' : '📝';

  // Delete rule: a ticket can be deleted only before approval (draft / validated
  // / reviewed) and while unpaid. Snr Accountant / GM / Admin may delete any such
  // ticket regardless of age; the recorder is limited to one week. Backend
  // re-enforces this.
  const isSnrPlus = !!(role && atLeast(role, 'SNR_ACCOUNTANT'));
  const notApproved = ['DRAFT', 'VALIDATED', 'REVIEWED'].includes(wf);
  const unpaid = paid <= 0 && notApproved;
  const fresh = (Date.now() / 1000 - Number(expense.created_at || 0)) <= 7 * 86400;
  const canDelete = unpaid && (isSnrPlus || (expense.recorded_by === user?.id && fresh));
  const del = async () => {
    // Not permanent any more — the ticket goes to the trash (receipts and all) and a
    // Snr Accountant / GM / Admin can restore it from the vendor's Payables drill.
    if (!await confirm({ title: 'Delete this expense?', message: 'It moves to Recently deleted and can be restored for 30 days. Nothing is destroyed.', confirmText: 'Delete', danger: true })) return;
    setBusy(true);
    try { await api(ts(`/expenses/${expense.id}`), { method: 'DELETE' }); toast('Expense deleted', 'ok'); onChanged && onChanged(); onClose(); }
    catch (e) { toast(e.message || 'Could not delete', 'err'); }
    setBusy(false);
  };

  // Reverse one payment line. If it drops a fully-paid ticket below its total the
  // backend returns it to APPROVED (balance owed again).
  const reversePayment = async (p) => {
    if (!await confirm({ title: 'Reverse this payment?', message: `Remove the ${ngn(p.amount)} payment. If the ticket was fully paid, it returns to Approved with the balance owed.`, confirmText: 'Reverse', danger: true })) return;
    setBusy(true);
    try {
      const r = await api(ts(`/expenses/payments/${p.id}`), { method: 'DELETE' });
      setPaid((v) => Math.max(0, Math.round((v - (+p.amount || 0)) * 100) / 100));
      if (r?.wf_state) setWf(r.wf_state);
      toast('Payment reversed', 'ok'); loadPays(); loadLog(); onChanged && onChanged();
    } catch (e) { toast(e.message || 'Could not reverse payment', 'err'); }
    setBusy(false);
  };
  // Reset ALL payments — returns the full amount as outstanding and rolls a paid
  // ticket back to Approved. Snr Accountant / GM / Admin only.
  const canResetPay = !!(role && atLeast(role, 'SNR_ACCOUNTANT'));
  const resetPayments = async () => {
    if (!await confirm({ title: 'Reset all payments?', message: 'Removes every payment on this ticket and returns the full amount as outstanding. The ticket goes back to Approved (owing).', confirmText: 'Reset payments', danger: true })) return;
    setBusy(true);
    try {
      const r = await api(ts(`/expenses/${expense.id}/reset-payments`), { method: 'POST' });
      setPaid(0);
      if (r?.wf_state) setWf(r.wf_state);
      toast('Payments reset — amount now outstanding', 'ok'); loadPays(); loadLog(); onChanged && onChanged();
    } catch (e) { toast(e.message || 'Could not reset payments', 'err'); }
    setBusy(false);
  };

  return (
    <div>
      <div className="grip" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div className="av" style={{ fontSize: 24 }}>{catIcon(expense.category)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{expense.description || expense.category} {expense.kind === 'IMPREST' && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: '#e0e7ff', color: '#3730a3' }}>IMPREST</span>}</h3>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{expense.expense_date}{expense.vendor ? ` · ${expense.vendor}` : ''}{siteName ? ` · ${siteName}` : ''}</div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 20, background: (WF[wf] || WF.DRAFT).bg, color: (WF[wf] || WF.DRAFT).fg }}>{(WF[wf] || WF.DRAFT).label}</span>
        {canDelete && <button className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', color: 'var(--err)' }} disabled={busy} onClick={del} title="Delete this unapproved expense">🗑</button>}
      </div>

      {expense.kind === 'IMPREST' && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '8px 0 0' }}>
          Cash-at-hand — Snr Accountant & GM can approve, then Pay to close.
        </div>
      )}

      {/* Lifecycle actions — server decides which the current user may run */}
      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 2px' }}>
          {actions.map((act) => (
            <button key={act} className={`btn${WF_ACTION[act]?.kind === 'ghost' ? ' btn-ghost' : ''}`}
              style={{ flex: '1 1 auto', minWidth: 92, ...(WF_ACTION[act]?.kind === 'danger' ? { background: 'var(--err)' } : {}) }}
              disabled={!!acting} onClick={() => runAction(act)}>
              {acting === act ? <span className="spin" /> : (WF_ACTION[act]?.label || act)}
            </button>
          ))}
        </div>
      )}

      {/* Pay form — partial or full; shows resulting balance, source bank, receipt */}
      {payOpen && (
        <div className="card" style={{ marginTop: 10, padding: 14, background: 'var(--bg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <div style={{ fontWeight: 800 }}>Record payment</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Owed {ngn(balance)}</div>
          </div>
          <label className="fl">Amount</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="input" type="number" inputMode="decimal" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} placeholder="0" onFocus={(e) => e.target.select()} />
            <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '0 12px', whiteSpace: 'nowrap' }} onClick={() => setPayAmt(String(balance))}>Full</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 2px 0' }}>
            Balance after: <b style={{ color: 'var(--ink)' }}>{ngn(Math.max(0, Math.round((balance - (parseFloat(payAmt) || 0)) * 100) / 100))}</b>
            {(parseFloat(payAmt) || 0) >= balance - 0.01 && (parseFloat(payAmt) || 0) > 0 ? ' · will mark PAID' : ''}
          </div>
          <label className="fl" style={{ marginTop: 8 }}>Paid from (bank account)</label>
          <Typeahead
            value={bankQuery}
            onChange={setBankQuery}
            minChars={0}
            placeholder="Search bank account… (blank = cash)"
            fetchFn={async (q) => {
              const s = (q || '').trim().toLowerCase();
              const match = (b) => [b.label, b.bank_name, b.account_number, b._tenant].filter(Boolean).join(' ').toLowerCase().includes(s);
              const rows = (s ? banks.filter(match) : banks).slice(0, 50).map((b) => ({
                label: b._tenant ? `${b.label} (${b._tenant})` : b.label,   // stored as the payment's `bank`
                sub: [b.bank_name, b.account_number, b._tenant].filter(Boolean).join(' · '),
              }));
              return [{ label: 'Cash / unspecified', sub: 'No bank — cash payment', _cash: true }, ...rows];
            }}
            onPick={(item) => { const v = item._cash ? '' : item.label; setPayBank(v); setBankQuery(item._cash ? '' : item.label); }}
          />
          {payBank
            ? <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Paying from <b style={{ color: 'var(--ink)' }}>{payBank}</b> · <button type="button" onClick={() => { setPayBank(''); setBankQuery(''); }} style={{ background: 'none', border: 'none', color: 'var(--brand-d)', cursor: 'pointer', padding: 0, fontSize: 12 }}>use cash instead</button></div>
            : <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>No bank selected — will record as cash.</div>}
          <label className="fl" style={{ marginTop: 8 }}>Note (optional)</label>
          <input className="input" value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="e.g. transfer ref, teller no." />
          <label className="fl" style={{ marginTop: 8 }}>Receipt (optional)</label>
          <input id="exp-pay-file" type="file" className="input"
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.xls,.xlsx,.doc,.docx,.txt,image/*"
            onChange={(e) => setPayFile(e.target.files?.[0] || null)} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 8, marginTop: 12 }}>
            <button className="btn btn-ghost" disabled={busy} onClick={() => { setPayOpen(false); setPayFile(null); }}>Cancel</button>
            <button className="btn" disabled={busy || !((parseFloat(payAmt) || 0) > 0) || (parseFloat(payAmt) || 0) > balance + 0.01} onClick={submitPay}>{busy ? <span className="spin" /> : `💵 Pay ${ngn(Math.round((parseFloat(payAmt) || 0) * 100) / 100)}`}</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        {[['Billed', billed], ['Paid', paid], ['Owed', balance]].map(([k, v]) => (
          <div key={k} style={{ flex: 1, background: 'var(--bg)', borderRadius: 10, padding: '8px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>{k}</div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{ngn(v)}</div>
          </div>
        ))}
      </div>
      {/* payment status chip — distinct from lifecycle */}
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 8 }}>
        Payment: <span style={{ fontWeight: 700, color: ST[st].fg }}>{st}</span>
      </div>

      {items.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>Line items</div>
          {items.map((it, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{it.name}{it.qty ? ` ×${it.qty}` : ''}</span><span>{ngn(it.amount || (it.qty * it.price) || 0)}</span>
            </div>
          ))}
        </div>
      )}

      {pays.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Payments ({pays.length})</div>
            {canResetPay && <button type="button" disabled={busy} onClick={resetPayments}
              style={{ background: 'none', border: 'none', color: 'var(--err)', cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 700 }}
              title="Remove all payments and return the amount as outstanding">↺ Reset payments</button>}
          </div>
          {pays.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ flex: 1, minWidth: 0 }}>{p.pay_date} · {p.method || '—'}{p.bank ? ` · ${p.bank}` : ''}</span>
              <span style={{ fontWeight: 700 }}>{ngn(p.amount)}</span>
              {canResetPay && <button type="button" disabled={busy} onClick={() => reversePayment(p)} title="Reverse this payment"
                style={{ border: 'none', background: '#fee2e2', color: 'var(--err)', borderRadius: 6, width: 24, height: 24, cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>✕</button>}
            </div>
          ))}
        </div>
      )}

      {/* Footer: receipts & notes — kept on the server for dispute records */}
      <div style={{ borderTop: '2px solid var(--line)', marginTop: 12, paddingTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>🧾 Receipts & notes <span style={{ color: 'var(--muted)', fontWeight: 600 }}>({atts.length})</span></div>
        {atts.map((a) => {
          const sqBtn = { border: 'none', borderRadius: 7, width: 30, height: 30, cursor: 'pointer', fontSize: 13, display: 'grid', placeItems: 'center', flexShrink: 0, lineHeight: 1 };
          return (
            <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ fontSize: 18, lineHeight: '20px', flexShrink: 0 }}>{fileIcon(a.mime)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {a.file_name && <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.file_name}</div>}
                {/* Which payment this slip proves — the whole point of keeping it. */}
                {a.payment_id && a.pay_date && (
                  <div style={{ fontSize: 12, color: '#166534', fontWeight: 600 }}>
                    Proof of {ngn(a.pay_amount)} paid {a.pay_date}{a.pay_bank ? ` · ${a.pay_bank}` : a.pay_method ? ` · ${a.pay_method}` : ''}
                  </div>
                )}
                {a.note && <div style={{ fontSize: 12.5, color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.note}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                {a.has_file && <button title="View" style={{ ...sqBtn, background: '#eff6ff', color: '#1e40af' }} onClick={() => openReceipt(a, false)}>👁</button>}
                {a.has_file && <button title="Download" style={{ ...sqBtn, background: '#eff6ff', color: '#1e40af' }} onClick={() => openReceipt(a, true)}>⬇</button>}
                <button title="Remove" style={{ ...sqBtn, background: '#fee2e2', color: 'var(--err)' }} onClick={() => delAttachment(a)}>🗑</button>
              </div>
            </div>
          );
        })}
        {atts.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>No receipts yet — attach one below.</div>}

        <input id="exp-att-file" type="file" accept="image/*,.pdf,.xls,.xlsx,.doc,.docx,.txt"
          onChange={(e) => setFile(e.target.files[0] || null)} style={{ fontSize: 12, marginTop: 8, width: '100%' }} />
        <textarea className="input" rows={2} placeholder="Note (required — e.g. paid Flexplast in cash, ref…)"
          value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 6, resize: 'vertical' }} />
        <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={addAttachment} disabled={busy || !note.trim()}>
          {busy ? <span className="spin" /> : '＋ Attach receipt / note'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Close</button>
        {/* Editing is only possible in DRAFT — reset the ticket first to change it. */}
        {wf === 'DRAFT' && <button className="btn" style={{ flex: 1 }} onClick={onEdit}>✏️ Edit</button>}
      </div>

      {/* ── Un-approve dialog — stacked ON TOP of this ticket modal ──────────
          The global modal store holds only one modal, so opening another there
          would REPLACE the ticket. This is a local overlay at a higher z-index
          than .modal-bg (50), so it layers over the open ticket instead. */}
      {unapOpen && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !acting) setUnapOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 500,
            background: 'rgba(15,23,42,.55)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--card, #fff)', borderRadius: 16, padding: 20, width: '100%', maxWidth: 380, boxShadow: '0 20px 60px rgba(15,23,42,.28)' }}>
            <h3 style={{ margin: '0 0 6px', color: 'var(--err)' }}>Send back to draft?</h3>
            <p style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--muted)', lineHeight: 1.5 }}>
              This <b>undoes the approval</b> so the ticket can be corrected. It will have to be
              validated, reviewed and approved again.
            </p>
            <label className="fl">Reason (required)</label>
            <textarea className="input" rows={3} autoFocus
              value={unapReason} onChange={(e) => setUnapReason(e.target.value)}
              placeholder="Why is this being sent back? (recorded in the audit log)"
              style={{ resize: 'vertical' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.4fr', gap: 8, marginTop: 14 }}>
              <button className="btn btn-ghost" disabled={!!acting} onClick={() => setUnapOpen(false)}>Cancel</button>
              <button className="btn" style={{ background: 'var(--err)' }}
                disabled={!!acting || !unapReason.trim()} onClick={confirmUnapprove}>
                {acting === 'unapprove' ? <span className="spin" /> : '↺ Back to draft'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Expenses() {
  const { openModal, closeModal, toast, tenant, sites, isGroup, groupTenants } = useStore();
  const role = useRole();
  const canBulk = role && atLeast(role, 'SNR_ACCOUNTANT');   // Snr Accountant / GM / Admin
  const [selMode, setSelMode] = useState(false);
  const [openGroups, setOpenGroups] = useState({});   // status → expanded? (FAQ-style)
  const toggleGroupOpen = (st) => setOpenGroups((p) => ({ ...p, [st]: !p[st] }));
  const [sel, setSel] = useState(() => new Set());
  const [bulking, setBulking] = useState(false);
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState(CATS.map((c) => c.toUpperCase()));
  const [loading, setLoading] = useState(true);
  // Default the date range to today so admins land on "today across all sites".
  const [filter, setFilter] = useState({ cat: '', from: today(), to: today(), kind: '' });
  const [search, setSearch] = useState('');   // free-text: id / vendor / site
  const [qDebounced, setQDebounced] = useState('');   // debounced → server search (all history)
  const [tab, setTab] = useState('list');   // list | cash | payables | receipts
  useEffect(() => { const t = setTimeout(() => setQDebounced(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const [imprest, setImprest] = useState(null);   // per-site imprest summary

  // Stable key so the per-tenant group fetch effect doesn't loop on array identity.
  const groupKey = groupTenants.map((t) => t.id).join(',');

  useEffect(() => {
    if (isGroup) return;   // categories are per-tenant; group view uses the defaults
    api(scoped('/expenses/categories')).then((c) => { if (Array.isArray(c) && c.length) setCategories(c); }).catch(() => {});
  }, [tenant, isGroup]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = () => {
      const p = new URLSearchParams();
      if (qDebounced) { p.set('q', qDebounced); return p; }   // search overrides date/category filters (all history)
      if (filter.cat) p.set('category', filter.cat);
      if (filter.from) p.set('from', filter.from);
      if (filter.to) p.set('to', filter.to);
      if (filter.kind) p.set('kind', filter.kind);
      return p;
    };
    try {
      if (isGroup) {
        // Combined view (Snr Accountant/GM/Admin): fetch each member tenant and
        // merge, tagging every row with its workspace name.
        const parts = await Promise.all(groupTenants.map(async (t) => {
          const p = qs(); p.set('tenant', t.id);
          try { return (await api(`/expenses?${p}`)).map((e) => ({ ...e, tenant_name: t.name })); }
          catch { return []; }
        }));
        const merged = parts.flat().sort((a, b) => (a.expense_date < b.expense_date ? 1 : a.expense_date > b.expense_date ? -1 : 0));
        setExpenses(merged);
      } else {
        setExpenses(await api(scoped(`/expenses?${qs()}`)));
      }
    } catch { setExpenses([]); }
    setLoading(false);
  }, [tenant, filter, isGroup, groupKey, qDebounced]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // When viewing imprests, show each site's daily total (→ transfer to Snr Acct).
  useEffect(() => {
    if (filter.kind !== 'IMPREST') { setImprest(null); return; }
    const buildQs = () => { const p = new URLSearchParams(); if (filter.from) p.set('from', filter.from); if (filter.to) p.set('to', filter.to); return p; };
    if (isGroup) {
      Promise.all(groupTenants.map(async (t) => {
        const p = buildQs(); p.set('tenant', t.id);
        try { const r = await api(`/expenses/imprest-summary?${p}`); return (r.sites || []).map((s) => ({ ...s, site_name: `${s.site_name || '—'} · ${t.name}` })); }
        catch { return []; }
      })).then((parts) => {
        const merged = parts.flat().sort((a, b) => b.total - a.total);
        setImprest({ grand: merged.reduce((a, s) => a + Number(s.total || 0), 0), sites: merged });
      }).catch(() => setImprest(null));
      return;
    }
    api(scoped(`/expenses/imprest-summary?${buildQs()}`)).then(setImprest).catch(() => setImprest(null));
  }, [tenant, filter.kind, filter.from, filter.to, expenses, isGroup, groupKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const openForm = (exp = null) => {
    openModal(<ExpenseForm expense={exp} sites={sites} categories={categories} onSave={load} onClose={closeModal} />, { guard: true });
  };
  // Clicking a ticket opens a read-only view first; Edit switches to the form.
  const openDetail = (exp) => {
    openModal(<ExpenseDetail expense={exp} sites={sites} onEdit={() => openForm(exp)} onChanged={load} onClose={closeModal} />);
  };

  // Free-text filter: expense ID (ext_id or short uuid), vendor, site (+ description/category).
  const shown = (() => {
    const q = search.trim().toLowerCase();
    if (!q) return expenses;
    return expenses.filter((e) => [
      e.ext_id, String(e.id || '').slice(0, 8), e.vendor, e.site_name, e.description, e.category, e.tenant_name, e.items_json,
    ].some((v) => (v || '').toString().toLowerCase().includes(q)));
  })();
  const total = shown.reduce((s, e) => s + (+e.amount || 0), 0);

  // Group the (filtered) list by workflow status, in lifecycle order.
  const STATE_ORDER = ['DRAFT', 'VALIDATED', 'REVIEWED', 'APPROVED', 'PAID', 'DECLINED'];
  const NEXT = { DRAFT: 'validate', VALIDATED: 'review', REVIEWED: 'approve', APPROVED: 'pay' };
  // Legacy DELIVERED tickets are effectively paid — show them under PAID.
  const groupState = (e) => { const s = e.wf_state || 'DRAFT'; return s === 'DELIVERED' ? 'PAID' : s; };
  const groups = STATE_ORDER
    .map((st) => ({ state: st, rows: shown.filter((e) => groupState(e) === st) }))
    .filter((g) => g.rows.length);

  const toggleSel = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleGroup = (rows) => setSel((s) => { const n = new Set(s); const all = rows.every((r) => n.has(r.id)); rows.forEach((r) => (all ? n.delete(r.id) : n.add(r.id))); return n; });
  const selCount = (rows) => rows.reduce((a, r) => a + (sel.has(r.id) ? 1 : 0), 0);
  const bulkApply = async (state, rows) => {
    const action = NEXT[state]; if (!action) return;
    const ids = rows.filter((r) => sel.has(r.id)).map((r) => r.id);
    if (!ids.length) return toast('Select at least one ticket', 'err');
    setBulking(true);
    try {
      const r = await api('/expenses/bulk-transition', { method: 'POST', body: { ids, action } });
      toast(`${r.moved} moved${r.skipped ? ` · ${r.skipped} skipped` : ''}`, r.moved ? 'ok' : 'err');
      setSel(new Set()); load();
    } catch (e) { toast(e.message || 'Bulk action failed', 'err'); }
    setBulking(false);
  };

  return (
    <div>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={`seg-b${tab === 'list' ? ' on' : ''}`} onClick={() => setTab('list')}>💸 Expenses</button>
        <button className={`seg-b${tab === 'cash' ? ' on' : ''}`} onClick={() => setTab('cash')}>💵 Cash deposits</button>
        {!isGroup && <button className={`seg-b${tab === 'payables' ? ' on' : ''}`} onClick={() => setTab('payables')}>🏦 Payables</button>}
        {/* Receipts are per-workspace files, so not offered in the combined group view. */}
        {!isGroup && <button className={`seg-b${tab === 'receipts' ? ' on' : ''}`} onClick={() => setTab('receipts')}>📎 Receipts</button>}
      </div>

      {tab === 'cash' ? <Cash /> : tab === 'payables' ? <PayablesView /> : tab === 'receipts' ? <ReceiptsView /> : (
      <>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select className="input" style={{ flex: '1 1 110px' }} value={filter.kind}
          onChange={(e) => setFilter((p) => ({ ...p, kind: e.target.value }))}>
          <option value="">All types</option>
          <option value="IMPREST">Imprest</option>
          <option value="NON_IMPREST">Non-imprest</option>
        </select>
        <SearchSelect style={{ flex: '1 1 120px' }} value={filter.cat} onChange={(val) => setFilter((p) => ({ ...p, cat: val }))} options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))]} placeholder="All categories" />
        <input type="date" className="input" style={{ flex: '1 1 110px' }} value={filter.from}
          onChange={(e) => setFilter((p) => ({ ...p, from: e.target.value }))} />
        <input type="date" className="input" style={{ flex: '1 1 110px' }} value={filter.to}
          onChange={(e) => setFilter((p) => ({ ...p, to: e.target.value }))} />
      </div>

      {/* Free-text search — id / vendor / site / description / item names */}
      <input className="input" style={{ marginBottom: 12 }} value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder="🔍 Search by ID, vendor, site, description or item…" />

      {/* Imprest summary — what each site transfers to the Snr Accountant */}
      {filter.kind === 'IMPREST' && imprest && imprest.sites && imprest.sites.length > 0 && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>Imprest to transfer → Snr Accountant</span>
            <span style={{ fontWeight: 800, fontSize: 18 }}>{ngn(imprest.grand)}</span>
          </div>
          {imprest.sites.map((s) => (
            <div key={s.site_id || s.site_name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', borderTop: '1px solid var(--line)' }}>
              <span style={{ color: 'var(--muted)' }}>{s.site_name || '—'} <span style={{ fontSize: 11 }}>({s.count})</span></span>
              <span style={{ fontWeight: 700 }}>{ngn(s.total)}</span>
            </div>
          ))}
        </div>
      )}

      {!loading && shown.length > 0 && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '12px 16px' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{shown.length} expense{shown.length === 1 ? '' : 's'}{search.trim() ? ' matched' : ''}</span>
          <span style={{ flex: 1 }} />
          {canBulk && (
            <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
              onClick={() => { setSelMode((v) => !v); setSel(new Set()); }}>
              {selMode ? '✕ Done' : '☑︎ Select'}
            </button>
          )}
          <span style={{ fontWeight: 800, fontSize: 18 }}>{ngn(total)}</span>
        </div>
      )}

      {loading ? (
        <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : shown.length === 0 ? (
        <div className="empty"><div className="ic">💸</div><p>{search.trim() ? `No expenses match “${search.trim()}”` : 'No expenses found'}</p></div>
      ) : (
        groups.map((g) => {
          const wf = WF[g.state] || WF.DRAFT;
          const gTotal = g.rows.reduce((a, r) => a + (+r.amount || 0), 0);
          const nextAct = NEXT[g.state];
          const nSel = selCount(g.rows);
          const open = selMode || !!openGroups[g.state];   // selection mode forces groups open
          return (
            <div key={g.state} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 4px 6px' }}>
                <button onClick={() => toggleGroupOpen(g.state)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', padding: 0 }}>
                  <span style={{ color: 'var(--muted)', width: 12, display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: wf.bg, color: wf.fg }}>{wf.label}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{g.rows.length} · {ngn(gTotal)}</span>
                </button>
                {canBulk && selMode && (
                  <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '3px 10px' }} onClick={() => toggleGroup(g.rows)}>
                    {g.rows.every((r) => sel.has(r.id)) ? 'Clear' : 'All'}
                  </button>
                )}
                {canBulk && selMode && nextAct && (
                  <button className="btn btn-sm" style={{ width: 'auto', padding: '3px 12px' }} disabled={bulking || nSel === 0}
                    onClick={() => bulkApply(g.state, g.rows)}>
                    {bulking ? <span className="spin" /> : `${WF_ACTION[nextAct]?.label || nextAct} (${nSel})`}
                  </button>
                )}
              </div>
              {open && (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {g.rows.map((e) => (
                  <div key={e.id} style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--line)' }}>
                    {canBulk && selMode && (
                      <label style={{ padding: '0 2px 0 14px', display: 'flex', alignItems: 'center', cursor: 'pointer' }} onClick={(ev) => ev.stopPropagation()}>
                        <input type="checkbox" checked={sel.has(e.id)} onChange={() => toggleSel(e.id)} style={{ width: 18, height: 18 }} />
                      </label>
                    )}
                    <button onClick={() => (selMode ? toggleSel(e.id) : openDetail(e))}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', flex: 1, minWidth: 0, cursor: 'pointer', textAlign: 'left' }}>
                      <div className="av" style={{ fontSize: 22 }}>{catIcon(e.category)}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700 }}>{e.description || e.category}{e.kind === 'IMPREST' && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: '#e0e7ff', color: '#3730a3', marginLeft: 4 }}>IMPREST</span>}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          #{e.ext_id || String(e.id).slice(0, 6)} · {e.expense_date}{e.site_name ? ` · ${e.site_name}` : ''}{e.vendor ? ` · ${e.vendor}` : ''}{isGroup && e.tenant_name ? ` · ${e.tenant_name}` : ''}{Number(e.balance) > 0.01 ? ` · owed ${ngn(e.balance)}` : ''}
                          {/* Last payment date — so you can see at a glance when a ticket was last settled. */}
                          {e.last_payment_date ? <span style={{ color: '#166534' }}> · paid {e.last_payment_date}</span> : ''}
                        </div>
                      </div>
                      <div style={{ fontWeight: 800 }}>{ngn(e.amount)}</div>
                    </button>
                  </div>
                ))}
              </div>
              )}
            </div>
          );
        })
      )}
      </>
      )}

      {/* Group view is a read-only roll-up — new expenses are added inside a workspace. */}
      {!isGroup && <button className="fab" onClick={() => openForm()}>+</button>}
    </div>
  );
}
