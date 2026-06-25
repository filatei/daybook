import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

// One diesel-consumption entry per site per day: litres × rate = amount.
// Upserts on (site, date) so re-entering the same day overwrites rather than duplicates.
function DieselForm({ sites, defaultSite, onSave, onClose }) {
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    log_date: today(),
    site: defaultSite || sites[0]?.id || '',
    litres: '', rate_per_litre: '', note: '',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const litres = Number(f.litres) || 0;
  const rate = Number(f.rate_per_litre) || 0;
  const amount = Math.round(litres * rate * 100) / 100;

  const save = async () => {
    if (!f.site) return toast('Pick a site', 'err');
    if (litres <= 0) return toast('Enter litres', 'err');
    setSaving(true);
    try {
      await api(scoped('/diesel'), { method: 'PUT', body: { date: f.log_date, site: f.site, litres, rate_per_litre: rate, amount } });
      toast('Diesel saved ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message || 'Save failed', 'err'); }
    setSaving(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3>Daily diesel</h3>
      <div className="grid2">
        <div>
          <label className="fl">Date</label>
          <input type="date" className="input" value={f.log_date} max={today()} onChange={(e) => set('log_date', e.target.value)} />
        </div>
        {sites.length > 1 && (
          <div>
            <label className="fl">Site</label>
            <select className="input" value={f.site} onChange={(e) => set('site', e.target.value)}>
              <option value="">Select…</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
      </div>
      <div className="grid2">
        <div>
          <label className="fl">Litres</label>
          <input type="number" inputMode="decimal" className="input" value={f.litres} onChange={(e) => set('litres', e.target.value)} placeholder="0" />
        </div>
        <div>
          <label className="fl">Rate / litre (₦)</label>
          <input type="number" inputMode="decimal" className="input" value={f.rate_per_litre} onChange={(e) => set('rate_per_litre', e.target.value)} placeholder="0" />
        </div>
      </div>
      <div style={{ margin: '10px 0', padding: '10px 14px', background: 'var(--surface2, #f3f4f6)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 800 }}>
        <span>Amount</span><span>{ngn(amount)}</span>
      </div>
      <label className="fl">Note (optional)</label>
      <input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="supplier, generator, etc." />
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
      </div>
    </div>
  );
}

export default function Diesel() {
  const { openModal, closeModal, tenant, sites, go, toast } = useStore();
  const role = useRole();
  const canEdit = role && atLeast(role, 'SECRETARY');
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState({ litres: 0, amount: 0 });
  const [site, setSite] = useState('ALL');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = site && site !== 'ALL' ? `?site=${encodeURIComponent(site)}` : '';
      const r = await api(scoped(`/diesel${qs}`));
      setRows(r.rows || []);
      setTotal(r.total || { litres: 0, amount: 0 });
    } catch { setRows([]); setTotal({ litres: 0, amount: 0 }); }
    setLoading(false);
  }, [tenant, site]);
  useEffect(() => { load(); }, [load]);

  const del = async (id) => {
    try { await api(scoped(`/diesel/${id}`), { method: 'DELETE' }); toast('Deleted', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };

  if (!canEdit) {
    return <div className="empty"><div className="ic">🔒</div><p>Diesel records are available to managers and above.</p></div>;
  }

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => go('more')}>← More</button>
      <div className="section-title" style={{ marginTop: 0 }}>Diesel</div>

      {sites.length > 1 && (
        <select className="input" style={{ marginBottom: 12 }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="ALL">All sites</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}

      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <div><div style={{ fontSize: 12, color: 'var(--muted)' }}>Total litres</div><strong>{Number(total.litres || 0).toLocaleString()} L</strong></div>
        <div style={{ textAlign: 'right' }}><div style={{ fontSize: 12, color: 'var(--muted)' }}>Total amount</div><strong>{ngn(total.amount)}</strong></div>
      </div>

      {loading ? (
        <>{[...Array(3)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : rows.length === 0 ? (
        <div className="empty"><div className="ic">⛽</div><p>No diesel entries yet</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((l) => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
              <div style={{ fontSize: 20 }}>⛽</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{l.site_name} · {Number(l.litres || 0).toLocaleString()} L @ {ngn(l.rate_per_litre)}/L</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{l.log_date}{l.note ? ` · ${l.note}` : ''}</div>
              </div>
              <div style={{ fontWeight: 700 }}>{ngn(l.amount)}</div>
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 8px', color: 'var(--err)' }} onClick={() => del(l.id)}>×</button>
            </div>
          ))}
        </div>
      )}

      <button className="fab" onClick={() => openModal(<DieselForm sites={sites} defaultSite={site !== 'ALL' ? site : ''} onSave={load} onClose={closeModal} />)}>+</button>
    </div>
  );
}
