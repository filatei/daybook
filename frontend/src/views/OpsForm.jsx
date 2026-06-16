import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, today } from '../api.js';
import { useStore } from '../store.jsx';

const EMPTY = () => ({
  bags: { leakage: '', staff_water: '', extra: '', rebagging: '', damage: '' },
  packing: { opening: '', received: '', used_production: '', sales: '', rebagging: '', damage_replacement: '', available: '' },
  rolls: { opening_kg: '', received_kg: '', used_kg: '', available_kg: '' },
  crates: { c50_available: '', c50_sold: '', c60_available: '', c75_available: '', dispenser_available: '' },
  water: { ph: '', tds: '' },
  generators: [],
  ro: [],
  materials: '',
  expired_docs: '',
});
const GEN_STATUS = ['WORKING', 'NOT WORKING', 'UNDER REPAIR', 'REPAIRED NOT TESTED'];

export default function OpsForm({ sites, siteBound, defaultDate, defaultSite, onClose }) {
  const { toast } = useStore();
  const [date, setDate] = useState(defaultDate || today());
  const [siteId, setSiteId] = useState(siteBound ? '' : (defaultSite && defaultSite !== 'ALL' ? defaultSite : (sites[0]?.id || '')));
  const [d, setD] = useState(EMPTY());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!siteBound && !siteId) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ date });
      if (!siteBound && siteId) qs.set('site', siteId);
      const r = await api(scoped(`/reports/ops?${qs}`));
      const base = EMPTY();
      const m = r.data || {};
      for (const k of Object.keys(base)) {
        if (Array.isArray(base[k])) base[k] = Array.isArray(m[k]) ? m[k] : [];
        else if (typeof base[k] === 'object') base[k] = { ...base[k], ...(m[k] || {}) };
        else base[k] = m[k] ?? base[k];
      }
      setD(base);
    } catch { setD(EMPTY()); }
    setLoading(false);
  }, [date, siteId, siteBound]);
  useEffect(() => { load(); }, [load]);

  const setG = (group, key, v) => setD((p) => ({ ...p, [group]: { ...p[group], [key]: v } }));
  const save = async () => {
    if (!siteBound && !siteId) return toast('Pick a site', 'err');
    setSaving(true);
    try {
      await api(scoped('/reports/ops'), { method: 'PUT', body: { date, site: siteId, data: d } });
      toast('Operations saved ✓', 'ok'); onClose();
    } catch (e) { toast(e.message || 'Save failed', 'err'); }
    setSaving(false);
  };

  const Num = ({ group, k, label }) => (
    <div style={{ flex: '1 1 30%', minWidth: 92 }}>
      <label className="fl" style={{ fontSize: 11 }}>{label}</label>
      <input type="number" inputMode="decimal" className="input" value={d[group][k]} onChange={(e) => setG(group, k, e.target.value)} />
    </div>
  );
  const Group = ({ title, children }) => (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );

  return (
    <div>
      <div className="grip" />
      <h3 style={{ marginBottom: 2 }}>Day operations</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>Numbers the site keys in at day end — feeds the daily report.</p>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label className="fl">Date</label>
          <input type="date" className="input" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </div>
        {!siteBound && (
          <div style={{ flex: 1 }}>
            <label className="fl">Site</label>
            <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {loading ? <div className="skel" style={{ marginTop: 12 }} /> : (
        <>
          <Group title="Bag adjustments">
            <Num group="bags" k="leakage" label="Leakage" />
            <Num group="bags" k="staff_water" label="Staff water" />
            <Num group="bags" k="extra" label="Extra / bonus" />
            <Num group="bags" k="rebagging" label="Re-bagging" />
            <Num group="bags" k="damage" label="Damage" />
          </Group>

          <Group title="Packing bags">
            <Num group="packing" k="opening" label="Opening" />
            <Num group="packing" k="received" label="Received" />
            <Num group="packing" k="used_production" label="Used (prod)" />
            <Num group="packing" k="sales" label="Sales bags" />
            <Num group="packing" k="rebagging" label="Re-bagging" />
            <Num group="packing" k="damage_replacement" label="Damage repl." />
            <Num group="packing" k="available" label="Available" />
          </Group>

          <Group title="Rolls (kg)">
            <Num group="rolls" k="opening_kg" label="Opening" />
            <Num group="rolls" k="received_kg" label="Received" />
            <Num group="rolls" k="used_kg" label="Used" />
            <Num group="rolls" k="available_kg" label="Available" />
          </Group>

          <Group title="Crates">
            <Num group="crates" k="c50_available" label="50cl avail" />
            <Num group="crates" k="c50_sold" label="50cl sold" />
            <Num group="crates" k="c60_available" label="60cl avail" />
            <Num group="crates" k="c75_available" label="75cl avail" />
            <Num group="crates" k="dispenser_available" label="Dispenser" />
          </Group>

          <Group title="Water analysis">
            <Num group="water" k="ph" label="PH" />
            <Num group="water" k="tds" label="TDS" />
          </Group>

          {/* Generators — dynamic list */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Generator status</div>
            {d.generators.map((g, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input className="input" placeholder="e.g. MARAPCO 150KVA" value={g.name || ''} style={{ flex: 2 }}
                  onChange={(e) => setD((p) => ({ ...p, generators: p.generators.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))} />
                <select className="input" value={g.status || ''} style={{ flex: 1 }}
                  onChange={(e) => setD((p) => ({ ...p, generators: p.generators.map((x, j) => j === i ? { ...x, status: e.target.value } : x) }))}>
                  <option value="">—</option>
                  {GEN_STATUS.map((s) => <option key={s}>{s}</option>)}
                </select>
                <button className="btn btn-ghost" style={{ width: 'auto', padding: '0 10px', color: 'var(--err)' }}
                  onClick={() => setD((p) => ({ ...p, generators: p.generators.filter((_, j) => j !== i) }))}>×</button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={() => setD((p) => ({ ...p, generators: [...p.generators, { name: '', status: '' }] }))}>＋ Add generator</button>
          </div>

          {/* RO readings — dynamic list */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>RO readings (pure / waste)</div>
            {d.ro.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input className="input" placeholder="Unit e.g. 6TON RO1" value={r.unit || ''} style={{ flex: 2 }}
                  onChange={(e) => setD((p) => ({ ...p, ro: p.ro.map((x, j) => j === i ? { ...x, unit: e.target.value } : x) }))} />
                <input type="number" className="input" placeholder="Pure" value={r.pure ?? ''} style={{ flex: 1 }}
                  onChange={(e) => setD((p) => ({ ...p, ro: p.ro.map((x, j) => j === i ? { ...x, pure: e.target.value } : x) }))} />
                <input type="number" className="input" placeholder="Waste" value={r.waste ?? ''} style={{ flex: 1 }}
                  onChange={(e) => setD((p) => ({ ...p, ro: p.ro.map((x, j) => j === i ? { ...x, waste: e.target.value } : x) }))} />
                <button className="btn btn-ghost" style={{ width: 'auto', padding: '0 10px', color: 'var(--err)' }}
                  onClick={() => setD((p) => ({ ...p, ro: p.ro.filter((_, j) => j !== i) }))}>×</button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" onClick={() => setD((p) => ({ ...p, ro: [...p.ro, { unit: '', pure: '', waste: '' }] }))}>＋ Add RO unit</button>
          </div>

          <label className="fl" style={{ marginTop: 12 }}>Materials supplied to other locations</label>
          <textarea className="input" rows={2} value={d.materials} onChange={(e) => setD((p) => ({ ...p, materials: e.target.value }))} />
          <label className="fl">Expired documents</label>
          <textarea className="input" rows={2} value={d.expired_docs} onChange={(e) => setD((p) => ({ ...p, expired_docs: e.target.value }))} />

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Close</button>
            <button className="btn" style={{ flex: 1 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Save operations'}</button>
          </div>
        </>
      )}
    </div>
  );
}
