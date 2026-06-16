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
  const [itemId, setItemId] = useState(item?.id || null);   // when picked from typeahead
  const [itemName, setItemName] = useState(item?.name || '');
  const [unit, setUnit] = useState(item?.unit || 'unit');
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const fetchVendors = useCallback(async (q) => {
    try { return (await api(scoped(`/suggest/vendors?q=${encodeURIComponent(q)}`))).map((r) => ({ label: r.vendor || r.label, sub: r.sub || '' })); } catch { return []; }
  }, [tenant]);
  const fetchItems = useCallback(async (q) => {
    try { return (await api(scoped(`/inventory/items/suggest?q=${encodeURIComponent(q)}`))).map((r) => ({ id: r.id, label: r.label, sub: r.sub })); } catch { return []; }
  }, [tenant]);
  const save = async () => {
    if (!item && !itemName.trim()) return toast('Pick or name a stock item', 'err');
    if (!(+f.qty > 0) && type !== 'ADJUST') return toast('Enter a quantity', 'err');
    setSaving(true);
    try {
      await api(scoped('/inventory/moves'), { method: 'POST', body: {
        item_id: itemId || undefined, item_name: itemId ? undefined : itemName.trim(), unit,
        type, qty: +f.qty || 0, unit_cost: +f.unit_cost || 0,
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
    <Modal onClose={onClose} title={item ? item.name : 'Stock movement'}>
      {!item && (
        <>
          <label className="fl">Stock item</label>
          <div style={{ marginBottom: 10 }}>
            <Typeahead value={itemName} onChange={(v) => { setItemName(v); setItemId(null); }}
              onPick={(it) => { setItemName(it.label); setItemId(it.id); }}
              fetchFn={fetchItems} allowCreate minChars={1}
              createLabel={(q) => `➕ New item “${q}”`} placeholder="Search or add an item…" />
          </div>
        </>
      )}
      <div className="seg" style={{ marginBottom: 10 }}>
        {['RECEIVE', 'ISSUE', 'ADJUST'].map((t) => <button key={t} className={`seg-b${type === t ? ' on' : ''}`} onClick={() => setType(t)}>{TYPES[t]}</button>)}
      </div>
      <label className="fl">{type === 'ADJUST' ? 'Adjustment (+/−)' : `Quantity (${unit || 'unit'})`}</label>
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

// ── Finished goods: production (bagged auto + logged) vs sold → per-site stock ─
const FG_RANGES = [{ label: 'Today', d: 0 }, { label: 'This week', d: 7 }, { label: 'This month', d: 30 }];
const fgAgo = (n) => { const x = new Date(); x.setDate(x.getDate() - n); return x.toISOString().slice(0, 10); };

function ProductionForm({ sites, siteBound, onSaved, onClose }) {
  const { toast, tenant } = useStore();
  const [products, setProducts] = useState([]);
  const [f, setF] = useState({ product_id: '', qty: '', site_id: sites[0]?.id || '', date: today(), note: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { api(scoped('/products')).then((p) => { const a = (p || []).filter((x) => x.status !== 'INACTIVE'); setProducts(a); setF((s) => ({ ...s, product_id: a[0]?.id || '' })); }).catch(() => {}); }, [tenant]);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const save = async () => {
    if (!f.product_id) return toast('Pick a product', 'err');
    if (!(+f.qty > 0)) return toast('Enter a quantity', 'err');
    setSaving(true);
    try { await api(scoped('/inventory/production'), { method: 'POST', body: { product_id: f.product_id, qty: +f.qty, site_id: siteBound ? undefined : (f.site_id || null), date: f.date, note: f.note.trim() || null } }); toast('Production recorded ✓', 'ok'); onSaved(); onClose(); }
    catch (e) { toast(e.message || 'Failed', 'err'); }
    setSaving(false);
  };
  return (
    <Modal onClose={onClose} title="Record production">
      <label className="fl">Product (e.g. 50cl / 75cl bottle)</label>
      <select className="input" value={f.product_id} onChange={set('product_id')} style={{ marginBottom: 10 }}>
        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className="grid2">
        <div><label className="fl">Quantity produced</label><input className="input" type="number" inputMode="decimal" value={f.qty} onChange={set('qty')} placeholder="0" /></div>
        <div><label className="fl">Date</label><input className="input" type="date" max={today()} value={f.date} onChange={set('date')} /></div>
      </div>
      {!siteBound && sites.length > 1 && (
        <><label className="fl">Site</label><select className="input" value={f.site_id} onChange={set('site_id')}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></>
      )}
      <label className="fl">Note</label>
      <input className="input" value={f.note} onChange={set('note')} placeholder="optional" />
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn" style={{ flex: 1 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Save'}</button>
      </div>
    </Modal>
  );
}

function FinishedGoods() {
  const { tenant, go, openModal, closeModal, sites } = useStore();
  const role = useRole();
  const canManage = role && atLeast(role, 'SECRETARY');
  const siteBound = role && !atLeast(role, 'SNR_ACCOUNTANT');
  const [ri, setRi] = useState(0);
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    const from = fgAgo(FG_RANGES[ri].d), to = today();
    try { setData(await api(scoped(`/inventory/finished?from=${from}&to=${to}`))); } catch { setData({ configured: false, products: [] }); }
  }, [tenant, ri]);
  useEffect(() => { load(); }, [load]);
  const openProd = () => openModal(<ProductionForm sites={sites} siteBound={siteBound} onSaved={load} onClose={closeModal} />);
  if (data === null) return <>{[...Array(3)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <div className="seg" style={{ flex: 1 }}>{FG_RANGES.map((r, i) => <button key={r.label} className={`seg-b${ri === i ? ' on' : ''}`} onClick={() => setRi(i)}>{r.label}</button>)}</div>
      </div>
      {canManage && <button className="btn" style={{ marginBottom: 12 }} onClick={openProd}>＋ Record production (bottles…)</button>}

      {!data.configured ? (
        <div className="empty"><div className="ic">🏭</div><p>No finished product set up yet.</p>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>Map the bagged product in <b>Admin → Settings</b>, and/or record production above for bottles.</div>
          <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 14px', marginTop: 10 }} onClick={() => go('admin')}>Open Admin → Settings</button>
        </div>
      ) : data.products.map((p) => (
        <div key={p.id} style={{ marginBottom: 14 }}>
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', marginBottom: 6 }}>
            <div><div style={{ fontWeight: 700 }}>{p.name} {p.auto && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: '#eff6ff', color: '#1e40af' }}>AUTO (bagged)</span>}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>on hand · all sites</div></div>
            <strong style={{ fontSize: 19, color: p.on_hand_total < 0 ? 'var(--err)' : 'var(--ink)' }}>{fmtNum(p.on_hand_total)} {p.unit || ''}</strong>
          </div>
          {p.sites.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {p.sites.map((s) => (
                <div key={s.site_id} style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 13.5 }}>{s.site}</strong>
                    <strong style={{ fontSize: 13.5, color: s.on_hand < 0 ? 'var(--err)' : '#166534' }}>{fmtNum(s.on_hand)} {p.unit || ''}</strong>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>{FG_RANGES[ri].label}: produced {fmtNum(s.produced_period)} · sold {fmtNum(s.sold_period)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {data.configured && <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>On-hand = all-time produced − all-time sold, per site. AUTO products come from the daily bagged count; others from recorded production. Sold matched by product name on receipts.</p>}
    </div>
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
  const openMove = () => openModal(<MoveForm item={null} sites={sites} siteBound={siteBound} onSaved={load} onClose={closeModal} />);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Inventory</div>
        {canManage && <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 14px' }} onClick={openNew}>＋ Item</button>}
      </div>
      {canManage && <button className="btn" style={{ marginBottom: 12 }} onClick={openMove}>⬇ Receive / Issue stock</button>}
      <div className="seg" style={{ marginBottom: 12, overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`seg-b${tab === 'all' ? ' on' : ''}`} onClick={() => setTab('all')}>📦 Items</button>
        <button className={`seg-b${tab === 'low' ? ' on' : ''}`} onClick={() => setTab('low')}>⚠️ Low{lowCount ? ` (${lowCount})` : ''}</button>
        <button className={`seg-b${tab === 'finished' ? ' on' : ''}`} onClick={() => setTab('finished')}>🏭 Finished</button>
      </div>
      {tab === 'finished' && <FinishedGoods />}
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
