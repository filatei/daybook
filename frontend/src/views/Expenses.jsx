import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore } from '../store.jsx';
import Typeahead from '../components/Typeahead.jsx';

const CATS = ['Fuel', 'Maintenance', 'Utilities', 'Supplies', 'Salary', 'Transport', 'Other'];

function ExpenseForm({ expense, sites, onSave, onClose }) {
  const { toast, tenant } = useStore();
  const [saving, setSaving] = useState(false);
  const fetchVendors = useCallback(async (q) => {
    const rows = await api(scoped(`/suggest/vendors?q=${encodeURIComponent(q)}`));
    return rows.map((r) => ({ label: r.label }));
  }, [tenant]);
  const [f, setF] = useState({
    category: expense?.category || CATS[0],
    amount: expense?.amount ?? '',
    description: expense?.description || '',
    expense_date: expense?.expense_date || today(),
    site_id: expense?.site_id || sites[0]?.id || '',
    vendor: expense?.vendor || '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    if (!f.amount || !f.expense_date) return toast('Amount and date required', 'err');
    setSaving(true);
    try {
      if (expense?.id) {
        await api(scoped(`/expenses/${expense.id}`), { method: 'PATCH', body: f });
      } else {
        await api(scoped('/expenses'), { method: 'POST', body: f });
      }
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
          <select className="input" value={f.category} onChange={(e) => set('category', e.target.value)}>
            {CATS.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <label className="fl">Amount (₦)</label>
      <input type="number" className="input" value={f.amount} onChange={(e) => set('amount', e.target.value)} />
      <label className="fl">Description</label>
      <input type="text" className="input" value={f.description} onChange={(e) => set('description', e.target.value)} />
      <label className="fl">Vendor</label>
      <Typeahead
        value={f.vendor}
        onChange={(v) => set('vendor', v)}
        fetchFn={fetchVendors}
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

const CAT_ICONS = { Fuel: '⛽', Maintenance: '🔧', Utilities: '💡', Supplies: '📦', Salary: '👷', Transport: '🚛', Other: '💸' };

export default function Expenses() {
  const { openModal, closeModal, tenant, sites } = useStore();
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ cat: '', from: '', to: '' });

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
    openModal(<ExpenseForm expense={exp} sites={sites} onSave={load} onClose={closeModal} />);
  };

  const total = expenses.reduce((s, e) => s + (+e.amount || 0), 0);

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select className="input" style={{ flex: '1 1 120px' }} value={filter.cat}
          onChange={(e) => setFilter((p) => ({ ...p, cat: e.target.value }))}>
          <option value="">All categories</option>
          {CATS.map((c) => <option key={c}>{c}</option>)}
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
              <div className="av" style={{ fontSize: 22 }}>{CAT_ICONS[e.category] || '💸'}</div>
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
