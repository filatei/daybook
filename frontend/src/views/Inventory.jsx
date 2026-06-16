/**
 * Inventory.jsx — stock items (raw materials) + movements.
 * Receive (in), Issue (out), Adjust; current on-hand + low-stock alerts.
 * Receiving from a vendor can raise a payable (expense ticket) in one step.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';
import Typeahead from '../components/Typeahead.jsx';

const fmtNum = (n) => Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });

// ── New / edit stock item ─────────────────────────────────────────────────────
function ItemForm({ item, onSaved, onClose }) {
  const { toast } = useStore();
  const [f, setF] = useState({
    name: item?.name || '', category: item?.category || '', unit: item?.unit || 'unit',
    reorder_level: item?.reorder_level ?? '', sku: item?.sku || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const save = async () => {
    if (!f.name.trim()) return toast('Name required', 'err');
    setSaving(true);
    try {
      const body = { name: f.name.trim(), category: f.category.trim() || null, unit: f.unit.trim() || 'unit', reorder_level: +f.reorder_level || 0, sku: f.sku.trim() || null };
      if (item?.id) await api(scoped(`/inventory/items/${item.id}`), { method: 'PATCH', body });
      else await api(scoped('/inventory/items'), { method: 'POST', body });
      toast('Saved ✓', 'ok'); onSaved(); onClose();
    } catch (e) { toast(e.message || 'Could not save', 'err'); }
    setSaving(false);
  };
  return (
    <Modal onClose={onClose} title={item?.id ? 'Edit item' : 'New stock item'}>
      <label className="fl">Name</label>
      <input className="input" value={f.name} onChange={set('name')} placeholder="e.g. 60cl Preform" style={{ marginBottom: 10 }} />
      <div className="grid2">
        <div><label className="fl">Unit</label><input className="input" value={f.unit} onChange={set('unit')} placeholder="bag / roll / piece" /></div>
        <div><label className="fl">Category</label><input className="input" value={f.category} onChange={set('category')} placeholder="optional" /></div>
      </div>
      <div className="grid2">
        <div><label className="fl">Low-stock level</label><input className="input" type="number" inputMode="numeric" value={f.reorder_level} onChange={set('reorder_level')} placeholder="0 = no alert" /></div>
        <div><label className="fl">SKU (optional)</label><input className="input" value={f.sku} onChange={set('sku')} /></div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn" style={{ flex: 1 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Save'}</button>
      </div>
    </Modal>
  );
}

// ── Record a movement: receive / issue / adjust ───────────────────────────────
function MoveForm({ item, sites, siteBound, onSaved, onClose }) {
  const { toast, tenant } = useStore();
  const [type, setType] = useState('RECEIVE');
  const [f, setF] = useState({ qty: '', unit_cost: '', vendor: '', site_id: sites[0]?.id || '', date: today(), note: '', create_payable: false });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const fetchVendors = useCallback(async (q) => {
    try { return (await api(scoped(`/suggest/vendors?q=${encodeURIComponent(q)}`))).map((r) => ({ label: r.vendor || r.label, sub: r.sub || '' })); } catch { return []; }
  }, [tenant]);
  const save = async () => {
    if (!(+f.qty > 0) && type !== 'ADJUST') return toast('Enter a quantity', 'err');
    setSaving(true);
    try {
      await api(scoped('/inventory/moves'), { method: 'POST', body: {
        item_id: item.id, type, qty: +f.qty || 0, unit_cost: +f.unit_cost || 0,
        vendor: f.vendor.trim() || null, site_id: siteBound ? undefined : (f.site_id || null),
        date: f.date, note: f.note.trim() || null, create_payable: type === 'RECEIVE' && f.create_payable,
      } });
      toast(`${type === 'RECEIVE' ? 'Received' : type === 'ISSUE' ? 'Issued' : 'Adjusted'} ✓`, 'ok');
      onSaved(); onClose();
    } catch (e) { toast(e.message || 'Failed', 'err'); }
    setSaving(false);
  };
  const TYPES = { RECEIVE: '⬇ Receive', ISSUE: '⬆ Issue', ADJUST: '⚖ Adjust' };
  return (
    <Modal onClose={onClose} title={item.name}>
      <div className="seg" style={{ marginBottom: 10 }}>
        {['RECEIVE', 'ISSUE', 'ADJUST'].map((t) => <button key={t} className={`seg-b${type === t ? ' on' : ''}`} onClick={() => setType(t)}>{TYPES[t]}</button>)}
      </div>
      <label className="fl">{type === 'ADJUST' ? 'Adjustment (+/−)' : `Quantity (${item.unit || 'unit'})`}</label>
      <input className="input" type="number" inputMode="decimal" value={f.qty} onChange={(e) => set('qty', e.target.value)} placeholder="0" style={{ marginBottom: 10 }} />
      {type === 'RECEIVE' && (
        <>
          <div className="grid2">
            <div><label className="fl">Unit cost (₦)</label><input className="input" type="number" inputMode="decimal" value={f.unit_cost} onChange={(e) => set('unit_cost', e.target.value)} placeholder="0" /></div>
            <div><label className="fl">Vendor</label><Typeahead value={f.vendor} onChange={(v) => set('vendor', v)} fetchFn={fetchVendors} allowCreate minChars={1} placeholder="Supplier" /></div>
          </div>
          <label className="fl" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <input type="checkbox" checked={f.create_payable} onChange={(e) => set('create_payable', e.target.checked)} />
            Raise a payable to this vendor (qty × cost = {ngn((+f.qty || 0) * (+f.unit_cost || 0))})
          </label>
        </>
      )}
      {!siteBound && sites.length > 1 && (
        <><label className="fl">Site / store</label>
          <select className="input" value={f.site_id} onChange={(e) => set('site_id', e.target.value)}>
            <option value="">— none —</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></>
      )}
      <div className="grid2" style={{ marginTop: 6 }}>
        <div><label className="fl">Date</label><input className="input" type="date" max={today()} value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
        <div><label className="fl">Note</label><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="optional" /></div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn" style={{ flex: 1 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Save'}</button>
      </div>
    </Modal>
  );
}

// ── Item detail: on-hand + movements + actions ────────────────────────────────
function ItemDetail({ item, sites, siteBound, canManage, onChanged, onClose }) {
  const { openModal, closeModal } = useStore();
  const [moves, setMoves] = useState(null);
  const load = useCallback(async () => { try { setMoves(await api(scoped(`/inventory/items/${item.id}/moves`))); } catch { setMoves([]); } }, [item.id]);
  useEffect(() => { load(); }, [load]);
  const openMove = () => openModal(<MoveForm item={item} sites={sites} siteBound={siteBound} onSaved={() => { onChanged(); load(); }} onClose={closeModal} />);
  return (
    <Modal onClose={onClose} title={item.name}>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', marginBottom: 12, background: item.low ? '#fef2f2' : '#f8fafc' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>On hand{item.low ? ' · LOW' : ''}</span>
        <strong style={{ fontSize: 20, color: item.low ? 'var(--err)' : 'var(--ink)' }}>{fmtNum(item.on_hand)} {item.unit || ''}</strong>
      </div>
      {canManage && <button className="btn" style={{ marginBottom: 12 }} onClick={openMove}>＋ Receive / Issue / Adjust</button>}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>Movements</div>
      {moves === null ? <div className="skel" style={{ height: 60 }} /> : moves.length === 0 ? <div className="empty"><p>No movements yet</p></div> : (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          {moves.map((m) => (
            <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 2px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
              <span style={{ minWidth: 0 }}>
                <strong style={{ color: m.qty >= 0 ? '#166534' : 'var(--err)' }}>{m.qty >= 0 ? '+' : ''}{fmtNum(m.qty)}</strong>
                <span style={{ color: 'var(--muted)' }}> · {m.move_date} · {m.type}{m.vendor ? ` · ${m.vendor}` : ''}{m.site_name ? ` · ${m.site_name}` : ''}{m.expense_id ? ' · payable' : ''}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={onClose}>Close</button>
    </Modal>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
      <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, margin: 0, maxHeight: '92vh', overflowY: 'auto' }}>
        {title && <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 12 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}

export default function Inventory() {
  const { tenant, sites, openModal, closeModal } = useStore();
  const role = useRole();
  const canManage = role && atLeast(role, 'SECRETARY');
  const siteBound = role && !atLeast(role, 'SNR_ACCOUNTANT');
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');

  const load = useCallback(async () => { try { setItems(await api(scoped('/inventory/items'))); } catch { setItems([]); } }, [tenant]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => (items || []).filter((i) => {
    if (tab === 'low' && !i.low) return false;
    const s = q.trim().toLowerCase();
    return !s || (i.name || '').toLowerCase().includes(s) || (i.category || '').toLowerCase().includes(s);
  }), [items, q, tab]);
  const lowCount = (items || []).filter((i) => i.low).length;
  const totalValue = (items || []).reduce((a, i) => a + (Number(i.value) || 0), 0);

  const openItem = (it) => openModal(<ItemDetail item={it} sites={sites} siteBound={siteBound} canManage={canManage} onChanged={load} onClose={closeModal} />);
  const openNew = () => openModal(<ItemForm onSaved={load} onClose={closeModal} />);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Inventory</div>
        {canManage && <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 14px' }} onClick={openNew}>＋ Item</button>}
      </div>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={`seg-b${tab === 'all' ? ' on' : ''}`} onClick={() => setTab('all')}>📦 All items</button>
        <button className={`seg-b${tab === 'low' ? ' on' : ''}`} onClick={() => setTab('low')}>⚠️ Low stock{lowCount ? ` (${lowCount})` : ''}</button>
      </div>
      {items && items.length > 0 && totalValue > 0 && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', marginBottom: 12 }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>Stock value{tab === 'low' ? ' (low items)' : ''}</span>
          <strong style={{ fontSize: 18 }}>{ngn(shown.reduce((a, i) => a + (Number(i.value) || 0), 0))}</strong>
        </div>
      )}
      {items && items.length > 0 && (
        <input className="input" style={{ marginBottom: 12 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Search items…" />
      )}

      {items === null ? <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
        : shown.length === 0 ? <div className="empty"><div className="ic">📦</div><p>{tab === 'low' ? 'Nothing low on stock 🎉' : items.length === 0 ? 'No stock items yet — add your first' : 'No match'}</p></div>
          : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {shown.map((i) => (
                <button key={i.id} onClick={() => openItem(i)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
                  <div className="av" style={{ borderRadius: 8, background: i.low ? '#fee2e2' : '#eff6ff', color: i.low ? '#991b1b' : '#1e40af' }}>📦</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{i.name} {i.low && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: '#fee2e2', color: '#991b1b' }}>LOW</span>}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{i.category ? `${i.category} · ` : ''}{i.unit || 'unit'}{i.reorder_level > 0 ? ` · reorder ≤ ${fmtNum(i.reorder_level)}` : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <div style={{ fontWeight: 800, color: i.low ? 'var(--err)' : 'var(--ink)' }}>{fmtNum(i.on_hand)} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--muted)' }}>{i.unit || ''}</span></div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{Number(i.value) > 0 ? `${ngn(i.value)} ` : ''}›</div>
                  </div>
                </button>
              ))}
            </div>
          )}
    </div>
  );
}
