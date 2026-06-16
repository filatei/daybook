import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today, getToken } from '../api.js';
import { useStore } from '../store.jsx';
import Typeahead from '../components/Typeahead.jsx';

const CATS = ['Fuel', 'Maintenance', 'Utilities', 'Supplies', 'Salary', 'Transport', 'Other'];

function ExpenseForm({ expense, sites, categories = [], onSave, onClose }) {
  const { toast, tenant, setDirty } = useStore();
  const [saving, setSaving] = useState(false);
  const fetchVendors = useCallback(async (q) => {
    const rows = await api(scoped(`/suggest/vendors?q=${encodeURIComponent(q)}`));
    return rows.map((r) => ({ label: r.vendor || r.label, sub: r.sub || '' }));
  }, [tenant]);
  const fetchItems = useCallback(async (q) => {
    try { return (await api(scoped(`/suggest/expense-items?q=${encodeURIComponent(q)}`))).map((r) => ({ label: r.label })); }
    catch { return []; }
  }, [tenant]);
  const [f, setF] = useState({
    category: expense?.category || categories[0] || 'OTHER',
    description: expense?.description || '',
    expense_date: expense?.expense_date || today(),
    site_id: expense?.site_id || sites[0]?.id || '',
    vendor: expense?.vendor || '',
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

  const save = async () => {
    const items = rows.filter((r) => r.name.trim() && lineAmt(r) > 0).map((r) => ({ name: r.name.trim(), qty: +r.qty || 0, price: +r.price || 0 }));
    if (!items.length) return toast('Add at least one item with a name, quantity and rate', 'err');
    if (!f.expense_date) return toast('Date required', 'err');
    setSaving(true);
    try {
      const body = { ...f, items, amount: total };
      if (expense?.id) await api(scoped(`/expenses/${expense.id}`), { method: 'PATCH', body });
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
    try { setPayments(await api(scoped(`/expenses/${expense.id}/payments`))); } catch { /* ignore */ }
  }, [expense?.id]);
  useEffect(() => { loadPayments(); }, [loadPayments]);
  const recordPayment = async () => {
    const amt = +payForm.amount || 0;
    if (!(amt > 0)) return toast('Enter an amount', 'err');
    setPaying(true);
    try {
      const r = await api(scoped(`/expenses/${expense.id}/payments`), { method: 'POST', body: { amount: amt, date: payForm.date, method: payForm.method || null, bank: payForm.bank || null, memo: payForm.memo || null } });
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
      <div className="grid2">
        <div>
          <label className="fl">Date</label>
          <input type="date" className="input" value={f.expense_date} max={today()}
            onChange={(e) => set('expense_date', e.target.value)} />
        </div>
        <div>
          <label className="fl">Category</label>
          <input className="input" list="exp-cats" value={f.category} placeholder="Pick or type"
            onChange={(e) => set('category', e.target.value)} />
          <datalist id="exp-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </div>
      </div>
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
        <select className="input" value={f.site_id} onChange={(e) => set('site_id', e.target.value)}>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
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
                <button className="btn" style={{ flex: 1 }} onClick={recordPayment} disabled={paying}>{paying ? <span className="spin" /> : 'Record payment'}</button>
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
        <button className="btn" onClick={save} disabled={saving}>
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

// Vendor payables — how much we owe each vendor; tap to see their open tickets.
function PayablesView({ onOpenExpense }) {
  const { tenant } = useStore();
  const [rows, setRows] = useState(null);
  const [vendor, setVendor] = useState(null);   // drilled vendor → their unpaid expenses
  const [items, setItems] = useState(null);
  useEffect(() => { api(scoped('/expenses/vendors/balances')).then(setRows).catch(() => setRows([])); }, [tenant]);
  const openVendor = async (v) => {
    setVendor(v); setItems(null);
    try { setItems(await api(scoped(`/expenses?vendor=${encodeURIComponent(v.vendor)}&unpaid=1`))); } catch { setItems([]); }
  };
  const totalOwed = (rows || []).reduce((a, r) => a + r.owed, 0);

  if (rows === null) return <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>We owe {rows.length} vendor{rows.length !== 1 ? 's' : ''}</span>
        <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--err)' }}>{ngn(totalOwed)}</span>
      </div>
      {rows.length === 0 ? <div className="empty"><div className="ic">🏦</div><p>Nothing owed — all vendors settled</p></div> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((r) => (
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
            {items === null ? <div className="skel" style={{ height: 60 }} /> : items.length === 0 ? <div className="empty"><p>No open tickets</p></div> : items.map((e) => (
              <button key={e.id} onClick={() => { setVendor(null); onOpenExpense(e); }}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description || e.category}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{e.expense_date} · billed {ngn(e.amount)} · paid {ngn(e.amount_paid)}</div>
                </div>
                <strong style={{ color: 'var(--err)', whiteSpace: 'nowrap' }}>{ngn(e.balance)} ›</strong>
              </button>
            ))}
            <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => setVendor(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// View-first detail: read the ticket, attach receipts/notes, then choose to edit.
function ExpenseDetail({ expense, sites, onEdit, onClose }) {
  const { toast } = useStore();
  const [pays, setPays] = useState([]);
  const [atts, setAtts] = useState([]);
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  let items = [];
  try { items = expense?.items_json ? JSON.parse(expense.items_json) : []; } catch { items = []; }
  const billed = +expense?.amount || 0;
  const paid = +expense?.amount_paid || 0;
  const balance = Math.max(0, Math.round((billed - paid) * 100) / 100);
  const st = stOf({ balance, amount_paid: paid });
  const siteName = (sites || []).find((s) => s.id === expense?.site_id)?.name;

  const loadPays = useCallback(async () => {
    try { setPays(await api(scoped(`/expenses/${expense.id}/payments`))); } catch { /* ignore */ }
  }, [expense.id]);
  const loadAtts = useCallback(async () => {
    try { setAtts(await api(scoped(`/expenses/${expense.id}/attachments`))); } catch { /* ignore */ }
  }, [expense.id]);
  useEffect(() => { loadPays(); loadAtts(); }, [loadPays, loadAtts]);

  const addAttachment = async () => {
    if (!file && !note.trim()) { toast('Attach a receipt or write a note', 'err'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('file', file);
      if (note.trim()) fd.append('note', note.trim());
      await api(scoped(`/expenses/${expense.id}/attachments`), { method: 'POST', form: fd });
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
    if (!window.confirm('Remove this receipt/note?')) return;
    try { await api(scoped(`/expenses/${expense.id}/attachments/${a.id}`), { method: 'DELETE' }); loadAtts(); }
    catch (e) { toast(e.message || 'Could not remove', 'err'); }
  };

  const fileIcon = (m) => (m || '').startsWith('image/') ? '🖼️' : (m || '').includes('pdf') ? '📄' : m ? '📎' : '📝';

  return (
    <div>
      <div className="grip" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div className="av" style={{ fontSize: 24 }}>{catIcon(expense.category)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ margin: 0 }}>{expense.description || expense.category}</h3>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{expense.expense_date} · {expense.category}{expense.vendor ? ` · ${expense.vendor}` : ''}{siteName ? ` · ${siteName}` : ''}</div>
        </div>
        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20, background: ST[st].bg, color: ST[st].fg }}>{st}</span>
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        {[['Billed', billed], ['Paid', paid], ['Owed', balance]].map(([k, v]) => (
          <div key={k} style={{ flex: 1, background: 'var(--bg)', borderRadius: 10, padding: '8px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>{k}</div>
            <div style={{ fontWeight: 800, fontSize: 15 }}>{ngn(v)}</div>
          </div>
        ))}
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
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 4 }}>Payments</div>
          {pays.map((p) => (
            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{p.pay_date} · {p.method || '—'}{p.bank ? ` · ${p.bank}` : ''}</span><span style={{ fontWeight: 700 }}>{ngn(p.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Footer: receipts & notes — kept on the server for dispute records */}
      <div style={{ borderTop: '2px solid var(--line)', marginTop: 12, paddingTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>🧾 Receipts & notes <span style={{ color: 'var(--muted)', fontWeight: 600 }}>({atts.length})</span></div>
        {atts.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <span style={{ fontSize: 18 }}>{fileIcon(a.mime)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {a.file_name && <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.file_name}</div>}
              {a.note && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{a.note}</div>}
            </div>
            {a.has_file && <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => openReceipt(a, false)}>View</button>}
            {a.has_file && <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => openReceipt(a, true)}>⬇</button>}
            <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12, color: 'var(--err)' }} onClick={() => delAttachment(a)}>×</button>
          </div>
        ))}
        {atts.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>No receipts yet — attach one below.</div>}

        <input id="exp-att-file" type="file" accept="image/*,.pdf,.xls,.xlsx,.doc,.docx,.txt"
          onChange={(e) => setFile(e.target.files[0] || null)} style={{ fontSize: 12, marginTop: 8, width: '100%' }} />
        <textarea className="input" rows={2} placeholder="Note (e.g. paid Flexplast in cash, ref…)"
          value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 6, resize: 'vertical' }} />
        <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={addAttachment} disabled={busy}>
          {busy ? <span className="spin" /> : '＋ Attach receipt / note'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Close</button>
        <button className="btn" style={{ flex: 1 }} onClick={onEdit}>✏️ Edit / pay</button>
      </div>
    </div>
  );
}

export default function Expenses() {
  const { openModal, closeModal, tenant, sites } = useStore();
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState(CATS.map((c) => c.toUpperCase()));
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ cat: '', from: '', to: '' });
  const [tab, setTab] = useState('list');   // list | payables

  useEffect(() => {
    api(scoped('/expenses/categories')).then((c) => { if (Array.isArray(c) && c.length) setCategories(c); }).catch(() => {});
  }, [tenant]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (filter.cat) p.set('category', filter.cat);
      if (filter.from) p.set('from', filter.from);
      if (filter.to) p.set('to', filter.to);
      setExpenses(await api(scoped(`/expenses?${p}`)));
    } catch { setExpenses([]); }
    setLoading(false);
  }, [tenant, filter]);

  useEffect(() => { load(); }, [load]);

  const openForm = (exp = null) => {
    openModal(<ExpenseForm expense={exp} sites={sites} categories={categories} onSave={load} onClose={closeModal} />, { guard: true });
  };
  // Clicking a ticket opens a read-only view first; Edit switches to the form.
  const openDetail = (exp) => {
    openModal(<ExpenseDetail expense={exp} sites={sites} onEdit={() => openForm(exp)} onClose={closeModal} />);
  };

  const total = expenses.reduce((s, e) => s + (+e.amount || 0), 0);

  return (
    <div>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={`seg-b${tab === 'list' ? ' on' : ''}`} onClick={() => setTab('list')}>💸 Expenses</button>
        <button className={`seg-b${tab === 'payables' ? ' on' : ''}`} onClick={() => setTab('payables')}>🏦 Payables</button>
      </div>

      {tab === 'payables' ? <PayablesView onOpenExpense={openDetail} /> : (
      <>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select className="input" style={{ flex: '1 1 120px' }} value={filter.cat}
          onChange={(e) => setFilter((p) => ({ ...p, cat: e.target.value }))}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c}>{c}</option>)}
        </select>
        <input type="date" className="input" style={{ flex: '1 1 110px' }} value={filter.from}
          onChange={(e) => setFilter((p) => ({ ...p, from: e.target.value }))} />
        <input type="date" className="input" style={{ flex: '1 1 110px' }} value={filter.to}
          onChange={(e) => setFilter((p) => ({ ...p, to: e.target.value }))} />
      </div>

      {!loading && expenses.length > 0 && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{expenses.length} expenses</span>
          <span style={{ fontWeight: 800, fontSize: 18 }}>{ngn(total)}</span>
        </div>
      )}

      {loading ? (
        <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : expenses.length === 0 ? (
        <div className="empty"><div className="ic">💸</div><p>No expenses found</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {expenses.map((e) => (
            <button key={e.id} onClick={() => openDetail(e)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
              <div className="av" style={{ fontSize: 22 }}>{catIcon(e.category)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{e.description || e.category} {Number(e.balance) > 0.01 && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: ST[stOf(e)].bg, color: ST[stOf(e)].fg }}>{stOf(e)}</span>}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {e.expense_date} · {e.category}{e.vendor ? ` · ${e.vendor}` : ''}{Number(e.balance) > 0.01 ? ` · owed ${ngn(e.balance)}` : ''}
                </div>
              </div>
              <div style={{ fontWeight: 800 }}>{ngn(e.amount)}</div>
            </button>
          ))}
        </div>
      )}
      </>
      )}

      <button className="fab" onClick={() => openForm()}>+</button>
    </div>
  );
}
