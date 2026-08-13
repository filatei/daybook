import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast, useBackHandler } from '../store.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

// Structured maintenance checklist — matches legacy Fido genmaints fields.
const MAINT_ITEMS = [
  { key: 'oil', label: 'Oil changed' },
  { key: 'oilfilters', label: 'Oil filter' },
  { key: 'fuelfilters', label: 'Fuel filter' },
  { key: 'radiator', label: 'Radiator cleaned' },
  { key: 'rings', label: 'Rings' },
  { key: 'pistons', label: 'Pistons' },
  { key: 'turboCharger', label: 'Turbo charger' },
  { key: 'fuelPump', label: 'Fuel pump' },
  { key: 'crankShaft', label: 'Crank shaft' },
  { key: 'metals', label: 'Metals' },
];
const emptyMaint = () => Object.fromEntries(MAINT_ITEMS.map(({ key }) => [key, false]));

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
        <SearchSelect value={f.site_id} onChange={(val) => set('site_id', val)} options={sites.map((s) => ({ value: s.id, label: s.name }))} placeholder="Select…" />
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

function DieselLogForm({ gen, onSave, onClose }) {
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ log_date: today(), type: 'DIESEL', litres: '', cost: '', runtime_hours: '', detail: '' });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      await api(scoped(`/generators/${gen.id}/logs`), { method: 'POST', body: f });
      toast('Diesel logged ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>⛽ Add diesel — {gen.name}</h3>
      <label className="fl">Date</label>
      <input type="date" className="input" value={f.log_date} max={today()} onChange={(e) => set('log_date', e.target.value)} />
      <div className="grid2">
        <div><label className="fl">Litres</label><input type="number" className="input" value={f.litres} onChange={(e) => set('litres', e.target.value)} /></div>
        <div><label className="fl">Cost (₦)</label><input type="number" className="input" value={f.cost} onChange={(e) => set('cost', e.target.value)} /></div>
      </div>
      <label className="fl">Runtime hours (optional)</label>
      <input type="number" className="input" value={f.runtime_hours} onChange={(e) => set('runtime_hours', e.target.value)} />
      <label className="fl">Remarks (optional)</label>
      <input className="input" value={f.detail} onChange={(e) => set('detail', e.target.value)} />
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
      </div>
    </div>
  );
}

function NoteLogForm({ gen, onSave, onClose }) {
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ log_date: today(), type: 'NOTE', detail: '' });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    if (!f.detail.trim()) return toast('Enter a note', 'err');
    setSaving(true);
    try {
      await api(scoped(`/generators/${gen.id}/logs`), { method: 'POST', body: f });
      toast('Note saved ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>📝 Add note — {gen.name}</h3>
      <label className="fl">Date</label>
      <input type="date" className="input" value={f.log_date} max={today()} onChange={(e) => set('log_date', e.target.value)} />
      <label className="fl">Note *</label>
      <textarea className="input" rows={3} value={f.detail} onChange={(e) => set('detail', e.target.value)} placeholder="Observation or follow-up" />
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
      </div>
    </div>
  );
}

function MaintenanceForm({ gen, onSave, onClose }) {
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [f, setF] = useState({ log_date: today(), runtime_hours: '', cost: '', detail: '', items: emptyMaint() });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const toggle = (key) => setF((p) => ({ ...p, items: { ...p.items, [key]: !p.items[key] } }));

  const onFile = (e) => {
    const img = e.target.files?.[0] || null;
    setFile(img);
    setPreview(img ? URL.createObjectURL(img) : '');
  };

  const save = async () => {
    if (!f.runtime_hours && f.runtime_hours !== 0) return toast('Hour reading required', 'err');
    setSaving(true);
    try {
      const done = Object.fromEntries(Object.entries(f.items).filter(([, v]) => v));
      const fd = new FormData();
      fd.append('log_date', f.log_date);
      fd.append('runtime_hours', f.runtime_hours);
      if (f.cost) fd.append('cost', f.cost);
      if (f.detail.trim()) fd.append('detail', f.detail.trim());
      if (Object.keys(done).length) fd.append('maintenance_items', JSON.stringify(done));
      if (file) fd.append('image', file);
      await api(scoped(`/generators/${gen.id}/maintenance`), { method: 'POST', form: fd });
      toast('Maintenance logged ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3>🔧 Log maintenance — {gen.name}</h3>
      <div className="grid2">
        <div>
          <label className="fl">Date</label>
          <input type="date" className="input" value={f.log_date} max={today()} onChange={(e) => set('log_date', e.target.value)} />
        </div>
        <div>
          <label className="fl">Hour reading on gen *</label>
          <input type="number" inputMode="decimal" className="input" value={f.runtime_hours} onChange={(e) => set('runtime_hours', e.target.value)} placeholder="Meter reading" />
        </div>
      </div>
      <div style={{ fontWeight: 800, fontSize: 13, margin: '12px 0 6px' }}>Work done</div>
      <div className="card" style={{ padding: '4px 0', marginBottom: 10 }}>
        {MAINT_ITEMS.map(({ key, label }) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 14px', borderBottom: '1px solid var(--line)', cursor: 'pointer' }}>
            <span style={{ fontSize: 14 }}>{label}</span>
            <input type="checkbox" checked={!!f.items[key]} onChange={() => toggle(key)} />
          </label>
        ))}
      </div>
      <label className="fl">Remarks (optional)</label>
      <textarea className="input" rows={3} value={f.detail} onChange={(e) => set('detail', e.target.value)} placeholder="What was done / still required" />
      <label className="fl">Cost (₦, optional)</label>
      <input type="number" inputMode="decimal" className="input" value={f.cost} onChange={(e) => set('cost', e.target.value)} />
      <label className="fl">Photo (optional)</label>
      <input type="file" accept="image/*" className="input" onChange={onFile} />
      {preview && <img src={preview} alt="Preview" style={{ maxWidth: '100%', maxHeight: 160, marginTop: 8, borderRadius: 8 }} />}
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save maintenance</button>
      </div>
    </div>
  );
}

const LOG_ICON = { DIESEL: '⛽', MAINTENANCE: '🔧', NOTE: '📝' };

function maintSummary(items) {
  if (!items || typeof items !== 'object') return '';
  const done = MAINT_ITEMS.filter(({ key }) => items[key]).map(({ label }) => label);
  return done.length ? done.join(', ') : '';
}

function MaintenanceItemsTable({ items }) {
  if (!items) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Work done</div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {MAINT_ITEMS.map(({ key, label }) => (
          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
            <span>{label}</span>
            <span style={{ fontWeight: 700 }}>{items[key] ? '✓ Changed' : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Generators() {
  const { openModal, closeModal, tenant, sites, go } = useStore();
  const role = useRole();
  const canEdit = role && atLeast(role, 'SECRETARY');
  const [gens, setGens] = useState([]);
  const [sel, setSel] = useState(null);
  const [selLog, setSelLog] = useState(null);
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

  useBackHandler(!!sel && !selLog, () => { setSel(null); setLogs([]); });
  useBackHandler(!!selLog, () => setSelLog(null));

  if (!canEdit) {
    return <div className="empty"><div className="ic">🔒</div><p>Generators are available to Secretary and above.</p></div>;
  }

  if (selLog) {
    const l = selLog;
    const row = (k, v) => v == null || v === '' ? null : (
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '11px 16px', borderBottom: '1px solid var(--line)' }}>
        <span style={{ color: 'var(--muted)' }}>{k}</span>
        <span style={{ fontWeight: 700, textAlign: 'right', maxWidth: '60%' }}>{v}</span>
      </div>
    );
    const imgUrl = l.image ? `/generators/${sel.id}/logs/${l.id}/image` : null;
    return (
      <div>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => setSelLog(null)}>← {sel?.name || 'Logs'}</button>
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 30 }}>{LOG_ICON[l.type] || '📝'}</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800 }}>{l.type === 'MAINTENANCE' ? 'Maintenance' : l.type === 'DIESEL' ? 'Diesel' : 'Note'}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{l.log_date}{sel?.name ? ` · ${sel.name}` : ''}</div>
          </div>
        </div>
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 12 }}>
          {row('Date', l.log_date)}
          {row('Type', l.type)}
          {l.litres != null && row('Litres', `${l.litres} L`)}
          {l.cost != null && row('Cost', ngn(l.cost))}
          {l.runtime_hours != null && row(l.type === 'MAINTENANCE' ? 'Hour reading' : 'Runtime', `${l.runtime_hours} h`)}
          {row('Remarks', l.detail)}
        </div>
        {l.type === 'MAINTENANCE' && <MaintenanceItemsTable items={l.maintenance_items} />}
        {imgUrl && (
          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Attachment</div>
            <a href={`/api${imgUrl}`} target="_blank" rel="noreferrer">
              <img src={`/api${imgUrl}`} alt="Maintenance" style={{ maxWidth: '100%', borderRadius: 8 }} />
            </a>
          </div>
        )}
      </div>
    );
  }

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
        <div className="grid2" style={{ margin: '10px 0' }}>
          <button className="btn btn-sm" onClick={() => openModal(<DieselLogForm gen={sel} onSave={() => openLogs(sel)} onClose={closeModal} />)}>⛽ Add diesel</button>
          <button className="btn btn-sm" onClick={() => openModal(<MaintenanceForm gen={sel} onSave={() => openLogs(sel)} onClose={closeModal} />)}>🔧 Maintenance</button>
        </div>
        <button className="btn btn-ghost btn-sm" style={{ marginBottom: 10 }} onClick={() => openModal(<NoteLogForm gen={sel} onSave={() => openLogs(sel)} onClose={closeModal} />)}>📝 Add note</button>
        {logs.length === 0 ? (
          <div className="empty"><div className="ic">⛽</div><p>No logs yet</p></div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {logs.map((l) => {
              const sub = l.type === 'MAINTENANCE'
                ? [maintSummary(l.maintenance_items), l.detail].filter(Boolean).join(' · ')
                : l.detail;
              return (
                <button key={l.id} onClick={() => setSelLog(l)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer' }}>
                  <div style={{ fontSize: 20 }}>{LOG_ICON[l.type] || '📝'}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>
                      {l.type === 'MAINTENANCE' ? 'Maintenance' : l.type}{l.litres ? ` · ${l.litres} L` : ''}{l.runtime_hours ? ` · ${l.runtime_hours}h` : ''}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{l.log_date}{sub ? ` · ${sub}` : ''}</div>
                  </div>
                  {l.cost != null && <div style={{ fontWeight: 700 }}>{ngn(l.cost)}</div>}
                  <div style={{ color: 'var(--muted)' }}>›</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

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
