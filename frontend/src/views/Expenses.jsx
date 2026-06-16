import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
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

export default function Expenses() {
  const { openModal, closeModal, tenant, sites } = useStore();
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState(CATS.map((c) => c.toUpperCase()));
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ cat: '', from: '', to: '' });

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

  const total = expenses.reduce((s, e) => s + (+e.amount || 0), 0);

  return (
    <div>
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
            <button key={e.id} onClick={() => openForm(e)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
              <div className="av" style={{ fontSize: 22 }}>{catIcon(e.category)}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{e.description || e.category}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {e.expense_date} · {e.category}{e.vendor ? ` · ${e.vendor}` : ''}
                </div>
              </div>
              <div style={{ fontWeight: 800 }}>{ngn(e.amount)}</div>
            </button>
          ))}
        </div>
      )}

      <button className="fab" onClick={() => openForm()}>+</button>
    </div>
  );
}
