import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

function GeneratorForm({ gen, sites, onSave, onClose }) {
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    name: gen?.name || '', fuel_type: gen?.fuel_type || 'DIESEL',
    make_model: gen?.make_model || '', capacity_kva: gen?.capacity_kva ?? '',
    site_id: gen?.site_id || sites[0]?.id || '', status: gen?.status || 'ACTIVE',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    if (!f.name) return toast('Name required', 'err');
    setSaving(true);
    try {
      if (gen?.id) await api(scoped(`/generators/${gen.id}`), { method: 'PATCH', body: f });
      else await api(scoped('/generators'), { method: 'POST', body: f });
      toast('Saved ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>{gen?.id ? 'Edit Generator' : 'New Generator'}</h3>
      <label className="fl">Name *</label>
      <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. 100kVA Mikano" />
      <div className="grid2">
        <div>
          <label className="fl">Fuel</label>
          <select className="input" value={f.fuel_type} onChange={(e) => set('fuel_type', e.target.value)}>
            <option>DIESEL</option><option>PETROL</option><option>GAS</option>
          </select>
        </div>
        <div>
          <label className="fl">Capacity (kVA)</label>
          <input type="number" className="input" value={f.capacity_kva} onChange={(e) => set('capacity_kva', e.target.value)} />
        </div>
      </div>
      <label className="fl">Make / Model</label>
      <input className="input" value={f.make_model} onChange={(e) => set('make_model', e.target.value)} />
      {sites.length > 1 && <>
        <label className="fl">Site</label>
        <select className="input" value={f.site_id} onChange={(e) => set('site_id', e.target.value)}>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </>}
      {gen?.id && <>
        <label className="fl">Status</label>
        <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="ACTIVE">Active</option><option value="RETIRED">Retired</option>
        </select>
      </>}
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
      </div>
    </div>
  );
}

function LogForm({ gen, onSave, onClose }) {
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ log_date: today(), type: 'DIESEL', litres: '', cost: '', runtime_hours: '', detail: '' });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      await api(scoped(`/generators/${gen.id}/logs`), { method: 'POST', body: f });
      toast('Logged ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>Log — {gen.name}</h3>
      <div className="grid2">
        <div>
          <label className="fl">Date</label>
          <input type="date" className="input" value={f.log_date} max={today()} onChange={(e) => set('log_date', e.target.value)} />
        </div>
        <div>
          <label className="fl">Type</label>
          <select className="input" value={f.type} onChange={(e) => set('type', e.target.value)}>
            <option>DIESEL</option><option>MAINTENANCE</option><option>NOTE</option>
          </select>
        </div>
      </div>
      {f.type === 'DIESEL' && (
        <div className="grid2">
          <div><label className="fl">Litres</label><input type="number" className="input" value={f.litres} onChange={(e) => set('litres', e.target.value)} /></div>
          <div><label className="fl">Cost (₦)</label><input type="number" className="input" value={f.cost} onChange={(e) => set('cost', e.target.value)} /></div>
        </div>
      )}
      <label className="fl">Runtime hours</label>
      <input type="number" className="input" value={f.runtime_hours} onChange={(e) => set('runtime_hours', e.target.value)} />
      <label className="fl">Detail</label>
      <input className="input" value={f.detail} onChange={(e) => set('detail', e.target.value)} placeholder="optional note" />
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
      </div>
    </div>
  );
}

const LOG_ICON = { DIESEL: '⛽', MAINTENANCE: '🔧', NOTE: '📝' };

export default function Generators() {
  const { openModal, closeModal, tenant, sites, go } = useStore();
  const role = useRole();
  const canEdit = role && atLeast(role, 'SECRETARY');
  const [gens, setGens] = useState([]);
  const [sel, setSel] = useState(null);          // selected generator (logs view)
  const [logs, setLogs] = useState([]);
  const [dieselTotal, setDieselTotal] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setGens(await api(scoped('/generators'))); } catch { setGens([]); }
    setLoading(false);
  }, [tenant]);
  useEffect(() => { load(); }, [load]);

  const openLogs = useCallback(async (g) => {
    setSel(g);
    try { const r = await api(scoped(`/generators/${g.id}/logs`)); setLogs(r.logs || []); setDieselTotal(r.diesel_total || null); }
    catch { setLogs([]); }
  }, [tenant]);

  if (!canEdit) {
    return <div className="empty"><div className="ic">🔒</div><p>Generators are available to managers and above.</p></div>;
  }

  // Logs detail view
  if (sel) {
    return (
      <div>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => { setSel(null); setLogs([]); }}>← Generators</button>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong style={{ fontSize: 16 }}>{sel.name}</strong>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sel.fuel_type}{sel.capacity_kva ? ` · ${sel.capacity_kva} kVA` : ''}</span>
          </div>
          {dieselTotal && (
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--muted)' }}>
              Diesel to date: <strong style={{ color: 'var(--ink)' }}>{Number(dieselTotal.litres || 0).toLocaleString()} L</strong> · {ngn(dieselTotal.cost)}
            </div>
          )}
        </div>
        {logs.length === 0 ? (
          <div className="empty"><div className="ic">⛽</div><p>No logs yet</p></div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {logs.map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ fontSize: 20 }}>{LOG_ICON[l.type] || '📝'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{l.type}{l.litres ? ` · ${l.litres} L` : ''}{l.runtime_hours ? ` · ${l.runtime_hours}h` : ''}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{l.log_date}{l.detail ? ` · ${l.detail}` : ''}</div>
                </div>
                {l.cost != null && <div style={{ fontWeight: 700 }}>{ngn(l.cost)}</div>}
              </div>
            ))}
          </div>
        )}
        <button className="fab" onClick={() => openModal(<LogForm gen={sel} onSave={() => openLogs(sel)} onClose={closeModal} />)}>+</button>
      </div>
    );
  }

  // List view
  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => go('more')}>← More</button>
      <div className="section-title" style={{ marginTop: 0 }}>Generators</div>
      {loading ? (
        <>{[...Array(3)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : gens.length === 0 ? (
        <div className="empty"><div className="ic">🔌</div><p>No generators yet — add your first</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {gens.map((g) => (
            <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
              <button onClick={() => openLogs(g)} style={{ flex: 1, minWidth: 0, border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
                <div style={{ fontWeight: 700 }}>{g.name} {g.status === 'RETIRED' ? <span className="badge">retired</span> : ''}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>📍 {g.site_name || 'Unassigned'} · {g.fuel_type}{g.capacity_kva ? ` · ${g.capacity_kva} kVA` : ''}{g.make_model ? ` · ${g.make_model}` : ''}</div>
              </button>
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => openModal(<GeneratorForm gen={g} sites={sites} onSave={load} onClose={closeModal} />)}>Edit</button>
            </div>
          ))}
        </div>
      )}
      <button className="fab" onClick={() => openModal(<GeneratorForm gen={null} sites={sites} onSave={load} onClose={closeModal} />)}>+</button>
    </div>
  );
}
