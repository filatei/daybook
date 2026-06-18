import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, today } from '../api.js';
import { useStore, useBackHandler } from '../store.jsx';

const EMPTY = () => ({
  bags: { leakage: '', staff_water: '', extra: '', rebagging: '', damage: '' },
  packing: { opening: '', received: '', used_production: '', sales: '', rebagging: '', damage_replacement: '', available: '' },
  rolls: { opening_count: '', opening_kg: '', received_count: '', received_kg: '', used_count: '', used_kg: '', available_count: '', available_kg: '' },
  crates: { c50_available: '', c50_sold: '', c60_available: '', c75_available: '', dispenser_available: '' },
  water: { ph: '', tds: '' },
  power: { nepa_hours: '' },   // hours of NEPA / public-utility power for the day
  generators: [],
  ro: [],
  materials: '',
  expired_docs: '',
});
const GEN_STATUS = ['WORKING', 'NOT WORKING', 'UNDER REPAIR', 'REPAIRED NOT TESTED'];

// ── Stable field components (MODULE-LEVEL) ──────────────────────────────────────
// Defining these outside the component is essential: components declared inside a
// render get a new identity on every keystroke, so React remounts the <input>
// and focus is lost after a single character (the "one number at a time" bug).
function Num({ label, value, onChange }) {
  return (
    <div style={{ flex: '1 1 30%', minWidth: 96 }}>
      <label className="fl" style={{ fontSize: 11, marginTop: 0 }}>{label}</label>
      <input type="number" inputMode="decimal" className="input" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
function Group({ title, children }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

const STEPS = ['Setup & bags', 'Packing bags', 'Rolls', 'Crates · water · power', 'Generators', 'RO & notes'];

export default function OpsForm({ sites, siteBound, defaultDate, defaultSite, onClose }) {
  const { toast } = useStore();
  const [date, setDate] = useState(defaultDate || today());
  const [siteId, setSiteId] = useState(siteBound ? '' : (defaultSite && defaultSite !== 'ALL' ? defaultSite : (sites[0]?.id || '')));
  const [d, setD] = useState(EMPTY());
  const [gens, setGens] = useState([]);   // generators registered for this site
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState(0);
  // Hardware Back steps back through the wizard instead of closing the form.
  useBackHandler(step > 0, () => setStep((s) => Math.max(0, s - 1)));

  // Pull the site's generators so the user only selects (never re-types names).
  useEffect(() => {
    if (!siteBound && !siteId) { setGens([]); return; }
    const qs = (!siteBound && siteId) ? `?site=${encodeURIComponent(siteId)}` : '';
    api(scoped(`/generators${qs}`)).then((r) => setGens(Array.isArray(r) ? r : [])).catch(() => setGens([]));
  }, [siteId, siteBound]);

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

  const last = STEPS.length - 1;
  const next = () => setStep((s) => Math.min(last, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  return (
    <div>
      <div className="grip" />
      <h3 style={{ marginBottom: 2 }}>Day operations</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
        Step {step + 1} of {STEPS.length} · {STEPS[step]}
      </p>

      {/* Progress bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        {STEPS.map((_, i) => (
          <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= step ? 'var(--brand)' : 'var(--line)' }} />
        ))}
      </div>

      {loading ? <div className="skel" style={{ marginTop: 12 }} /> : (
        <>
          {/* STEP 1 — date/site + bag adjustments */}
          {step === 0 && (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label className="fl">Date</label>
                  <input type="date" className="input" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
                </div>
                {!siteBound && (
                  <div style={{ flex: 1 }}>
                    <label className="fl">Site</label>
                    <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                      <option value="">Select…</option>
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                )}
              </div>
              <Group title="Bag adjustments">
                <Num label="Leakage" value={d.bags.leakage} onChange={(v) => setG('bags', 'leakage', v)} />
                <Num label="Staff water" value={d.bags.staff_water} onChange={(v) => setG('bags', 'staff_water', v)} />
                <Num label="Extra / bonus" value={d.bags.extra} onChange={(v) => setG('bags', 'extra', v)} />
                <Num label="Re-bagging" value={d.bags.rebagging} onChange={(v) => setG('bags', 'rebagging', v)} />
                <Num label="Damage" value={d.bags.damage} onChange={(v) => setG('bags', 'damage', v)} />
              </Group>
            </>
          )}

          {/* STEP 2 — packing bags */}
          {step === 1 && (
            <Group title="Packing bags">
              <Num label="Opening" value={d.packing.opening} onChange={(v) => setG('packing', 'opening', v)} />
              <Num label="Received" value={d.packing.received} onChange={(v) => setG('packing', 'received', v)} />
              <Num label="Used (prod)" value={d.packing.used_production} onChange={(v) => setG('packing', 'used_production', v)} />
              <Num label="Sales bags" value={d.packing.sales} onChange={(v) => setG('packing', 'sales', v)} />
              <Num label="Re-bagging" value={d.packing.rebagging} onChange={(v) => setG('packing', 'rebagging', v)} />
              <Num label="Damage repl." value={d.packing.damage_replacement} onChange={(v) => setG('packing', 'damage_replacement', v)} />
              <Num label="Available" value={d.packing.available} onChange={(v) => setG('packing', 'available', v)} />
            </Group>
          )}

          {/* STEP 3 — rolls (number & kg) */}
          {step === 2 && (
            <Group title="Rolls — number & kg">
              <Num label="Opening (no.)" value={d.rolls.opening_count} onChange={(v) => setG('rolls', 'opening_count', v)} />
              <Num label="Opening (kg)" value={d.rolls.opening_kg} onChange={(v) => setG('rolls', 'opening_kg', v)} />
              <Num label="Received (no.)" value={d.rolls.received_count} onChange={(v) => setG('rolls', 'received_count', v)} />
              <Num label="Received (kg)" value={d.rolls.received_kg} onChange={(v) => setG('rolls', 'received_kg', v)} />
              <Num label="Used (no.)" value={d.rolls.used_count} onChange={(v) => setG('rolls', 'used_count', v)} />
              <Num label="Used (kg)" value={d.rolls.used_kg} onChange={(v) => setG('rolls', 'used_kg', v)} />
              <Num label="Available (no.)" value={d.rolls.available_count} onChange={(v) => setG('rolls', 'available_count', v)} />
              <Num label="Available (kg)" value={d.rolls.available_kg} onChange={(v) => setG('rolls', 'available_kg', v)} />
            </Group>
          )}

          {/* STEP 4 — crates + water + power */}
          {step === 3 && (
            <>
              <Group title="Crates">
                <Num label="50cl avail" value={d.crates.c50_available} onChange={(v) => setG('crates', 'c50_available', v)} />
                <Num label="50cl sold" value={d.crates.c50_sold} onChange={(v) => setG('crates', 'c50_sold', v)} />
                <Num label="60cl avail" value={d.crates.c60_available} onChange={(v) => setG('crates', 'c60_available', v)} />
                <Num label="75cl avail" value={d.crates.c75_available} onChange={(v) => setG('crates', 'c75_available', v)} />
                <Num label="Dispenser" value={d.crates.dispenser_available} onChange={(v) => setG('crates', 'dispenser_available', v)} />
              </Group>
              <Group title="Water analysis">
                <Num label="PH" value={d.water.ph} onChange={(v) => setG('water', 'ph', v)} />
                <Num label="TDS" value={d.water.tds} onChange={(v) => setG('water', 'tds', v)} />
              </Group>
              <Group title="Public power (NEPA)">
                <Num label="NEPA hours today" value={d.power.nepa_hours} onChange={(v) => setG('power', 'nepa_hours', v)} />
              </Group>
            </>
          )}

          {/* STEP 5 — generators */}
          {step === 4 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>Generator status</div>
              {d.generators.map((g, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <select className="input" value={g.name || ''} style={{ flex: 2 }}
                    onChange={(e) => setD((p) => ({ ...p, generators: p.generators.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))}>
                    <option value="">Select generator…</option>
                    {gens.map((x) => <option key={x.id} value={x.name}>{x.name}{x.capacity_kva ? ` (${x.capacity_kva}KVA)` : ''}</option>)}
                    {g.name && !gens.some((x) => x.name === g.name) && <option value={g.name}>{g.name}</option>}
                  </select>
                  <select className="input" value={g.status || ''} style={{ flex: 1 }}
                    onChange={(e) => setD((p) => ({ ...p, generators: p.generators.map((x, j) => j === i ? { ...x, status: e.target.value } : x) }))}>
                    <option value="">—</option>
                    {GEN_STATUS.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <button className="btn btn-ghost" style={{ width: 'auto', padding: '0 10px', color: 'var(--err)' }}
                    onClick={() => setD((p) => ({ ...p, generators: p.generators.filter((_, j) => j !== i) }))}>×</button>
                </div>
              ))}
              {gens.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>No generators registered for this site — add them in More → Generators first.</div>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => setD((p) => ({ ...p, generators: [...p.generators, { name: '', status: '' }] }))}>＋ Add generator</button>
              )}
            </div>
          )}

          {/* STEP 6 — RO + materials + expired docs */}
          {step === 5 && (
            <>
              <div style={{ marginTop: 4 }}>
                <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 6 }}>RO readings (pure / waste)</div>
                {d.ro.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    <input className="input" placeholder="Unit e.g. 6TON RO1" value={r.unit || ''} style={{ flex: 2 }}
                      onChange={(e) => setD((p) => ({ ...p, ro: p.ro.map((x, j) => j === i ? { ...x, unit: e.target.value } : x) }))} />
                    <input type="number" inputMode="decimal" className="input" placeholder="Pure" value={r.pure ?? ''} style={{ flex: 1 }}
                      onChange={(e) => setD((p) => ({ ...p, ro: p.ro.map((x, j) => j === i ? { ...x, pure: e.target.value } : x) }))} />
                    <input type="number" inputMode="decimal" className="input" placeholder="Waste" value={r.waste ?? ''} style={{ flex: 1 }}
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
            </>
          )}

          {/* Wizard navigation */}
          <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={step === 0 ? onClose : back} disabled={saving}>
              {step === 0 ? 'Close' : '‹ Back'}
            </button>
            {step < last ? (
              <button className="btn" style={{ flex: 2 }} onClick={next} disabled={step === 0 && !siteBound && !siteId}>Next ›</button>
            ) : (
              <button className="btn" style={{ flex: 2 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Save operations'}</button>
            )}
          </div>
          {step < last && (
            <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={save} disabled={saving || (!siteBound && !siteId)}>
              {saving ? <span className="spin" /> : 'Save & finish now'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
