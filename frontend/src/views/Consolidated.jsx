import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

// Consolidated end-of-day report — Snr Accountant / GM / Admin only.
// Auto-aggregates the all-sites roll-up; the accountant fills/overrides the
// manual figures (imprest balance, NEPA alarm, notes) and emails it.
const N = (v) => Number(v) || 0;

// Module-level so React keeps a stable component identity across renders.
function Row({ label, value, strong, neg }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)', fontWeight: strong ? 800 : 500 }}>
      <span>{label}</span>
      <span style={{ color: neg ? 'var(--err)' : 'inherit' }}>{neg ? `(${ngn(Math.abs(value))})` : ngn(value)}</span>
    </div>
  );
}

export default function Consolidated() {
  const { go, toast } = useStore();
  const role = useRole();
  const allowed = role && atLeast(role, 'SNR_ACCOUNTANT');
  const [date, setDate] = useState(today());
  const [p, setP] = useState(null);
  const [m, setM] = useState({ imprest_balance: '', nepa_alarm: '', diesel_override: '', notes: '' });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api(scoped(`/reports/consolidated?date=${date}`));
      setP(r);
      setM({
        imprest_balance: r.manual?.imprest_balance ?? '',
        nepa_alarm: r.manual?.nepa_alarm ?? '',
        diesel_override: r.manual?.diesel_override ?? '',
        notes: r.manual?.notes ?? '',
      });
    } catch (e) { toast(e.message || 'Load failed', 'err'); setP(null); }
    setLoading(false);
  }, [date]);
  useEffect(() => { if (allowed) load(); }, [load, allowed]);

  if (!allowed) {
    return <div className="empty"><div className="ic">🔒</div><p>The consolidated report is for Snr Accountant, GM and Admin.</p></div>;
  }

  const auto = p?.auto;
  const s = auto?.summary || {};
  const totalSales = N(s.totalSales);
  const dieselAmt = m.diesel_override !== '' ? N(m.diesel_override) : (N(p?.diesel?.amount) || N(s.diesel));
  const imprest = N(m.imprest_balance);
  const nepa = N(m.nepa_alarm);
  const balance = totalSales - dieselAmt - imprest - nepa;
  const netDeposit = N(s.cash) - dieselAmt - imprest - nepa;

  const save = async (status) => {
    setBusy(true);
    try {
      await api(scoped('/reports/consolidated'), { method: 'PUT', body: { date, status, manual: m } });
      toast(status === 'FINAL' ? 'Marked final ✓' : 'Saved ✓', 'ok'); load();
    } catch (e) { toast(e.message || 'Save failed', 'err'); }
    setBusy(false);
  };
  const email = async () => {
    setBusy(true);
    try {
      await api(scoped('/reports/consolidated'), { method: 'PUT', body: { date, status: 'FINAL', manual: m } });
      const r = await api(scoped('/reports/consolidated/email'), { method: 'POST', body: { date } });
      toast(r.queued ? 'Queued — will send when online' : 'Emailed ✓', 'ok'); load();
    } catch (e) { toast(e.message || 'Email failed', 'err'); }
    setBusy(false);
  };

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => go('more')}>← More</button>
      <div className="section-title" style={{ marginTop: 0 }}>Consolidated report</div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label className="fl">Date</label>
          <input type="date" className="input" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </div>
        {p?.status && <span className="badge" style={{ marginBottom: 8 }}>{p.status}{p.emailed_at ? ' · emailed' : ''}</span>}
      </div>

      {loading ? <div className="skel" /> : !auto ? (
        <div className="empty"><div className="ic">📭</div><p>No site data for this date yet.</p></div>
      ) : (
        <>
          {/* Financial summary */}
          <div className="card" style={{ marginBottom: 12 }}>
            <Row label="Total sales" value={totalSales} strong />
            <div className="grid2" style={{ marginTop: 8 }}>
              <div><label className="fl">Diesel (override)</label><input type="number" className="input" value={m.diesel_override} placeholder={String(N(p?.diesel?.amount) || N(s.diesel))} onChange={(e) => setM((x) => ({ ...x, diesel_override: e.target.value }))} /></div>
              <div><label className="fl">Imprest balance</label><input type="number" className="input" value={m.imprest_balance} onChange={(e) => setM((x) => ({ ...x, imprest_balance: e.target.value }))} /></div>
            </div>
            <div className="grid2">
              <div><label className="fl">NEPA alarm</label><input type="number" className="input" value={m.nepa_alarm} onChange={(e) => setM((x) => ({ ...x, nepa_alarm: e.target.value }))} /></div>
            </div>
            <div style={{ marginTop: 8 }}>
              <Row label="Diesel" value={dieselAmt} neg />
              <Row label="Imprest balance" value={imprest} neg />
              <Row label="NEPA alarm" value={nepa} neg />
              <Row label="Balance (sales − deductions)" value={balance} strong />
            </div>
          </div>

          {/* Cash → deposit */}
          <div className="card" style={{ marginBottom: 12 }}>
            <Row label="Total cash" value={N(s.cash)} />
            <Row label="Transfer" value={N(s.transfer)} />
            {/* POS split by acquiring bank (Moniepoint / GTB / …) for reconciliation. */}
            {Array.isArray(s.posByBank) && s.posByBank.length > 0
              ? s.posByBank.map((b) => <Row key={b.bank} label={`POS · ${b.bank}`} value={N(b.amount)} />)
              : <Row label="POS" value={N(s.pos)} />}
            {Array.isArray(s.posByBank) && s.posByBank.length > 0 && <Row label="POS total" value={N(s.pos)} strong />}
            <Row label="Incentive" value={N(s.incentive)} />
            <Row label="Net cash deposit" value={netDeposit} strong />
          </div>

          {/* Sales distribution by site */}
          {auto.bySite?.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Sales distribution</div>
              {auto.bySite.map((r) => <Row key={r.site_id} label={r.site_name} value={N(r.totalSales)} />)}
            </div>
          )}

          {/* Pure water production (entered in morning reports) */}
          {s.productionTotals && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Pure water production — all sites</div>
              <Row label="Opening bags" value={N(s.productionTotals.opening)} />
              <Row label="Add — production" value={N(s.productionTotals.produced)} />
              {N(s.productionTotals.sales) > 0 && <Row label="Less — Sales" value={N(s.productionTotals.sales)} neg />}
              {N(s.productionTotals.bonus) > 0 && <Row label="Less — Bonus" value={N(s.productionTotals.bonus)} neg />}
              {N(s.productionTotals.incentive) > 0 && <Row label="Less — Incentive" value={N(s.productionTotals.incentive)} neg />}
              {N(s.productionTotals.staff_water) > 0 && <Row label="Less — Staff water" value={N(s.productionTotals.staff_water)} neg />}
              <Row label="Closing bags" value={N(s.productionTotals.closing)} strong />
            </div>
          )}

          {/* Bags / production totals */}
          {s.bagTotals && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Bags ({s.bagTotals.product || 'product'})</div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Opening {N(s.bagTotals.opening).toLocaleString()} · Produced {N(s.bagTotals.produced).toLocaleString()} · Sold {N(s.bagTotals.sold).toLocaleString()} · <b style={{ color: 'var(--ink)' }}>Available {N(s.bagTotals.available).toLocaleString()}</b>
              </div>
            </div>
          )}

          {/* Stock: packing + rolls */}
          {s.stockTotals && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Stock ({s.stockTotals.sites} sites reported)</div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Packing available {N(s.stockTotals.packing_available).toLocaleString()} · used {N(s.stockTotals.packing_used).toLocaleString()}<br />
                Rolls available {N(s.stockTotals.rolls_available_count)} ({N(s.stockTotals.rolls_available_kg).toLocaleString()}kg) · used {N(s.stockTotals.rolls_used_count)} ({N(s.stockTotals.rolls_used_kg).toLocaleString()}kg)
              </div>
            </div>
          )}

          {/* Diesel litres */}
          <div className="card" style={{ marginBottom: 12 }}>
            <Row label={`Diesel entered (${N(p?.diesel?.litres).toLocaleString()} L)`} value={N(p?.diesel?.amount)} />
          </div>

          {/* Generator status by site */}
          {s.gensBySite?.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Generator status</div>
              {s.gensBySite.map((g, i) => (
                <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>
                  <b>{g.site}</b>: {g.gens.map((x) => `${x.name}${x.status ? ` (${x.status})` : ''}`).join(', ')}
                </div>
              ))}
            </div>
          )}

          {/* RO totals */}
          {s.roTotals && (s.roTotals.pure || s.roTotals.waste) ? (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>RO readings</div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>Pure {N(s.roTotals.pure)} · Waste {N(s.roTotals.waste)}</div>
            </div>
          ) : null}

          {/* Incidents combined */}
          {s.incidentsBySite?.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Incidents</div>
              {s.incidentsBySite.map((it, i) => (
                <div key={i} style={{ fontSize: 13, marginBottom: 6 }}><b>{it.site}:</b> {it.text}</div>
              ))}
            </div>
          )}

          <label className="fl">Notes / additional figures (e.g. other company)</label>
          <textarea className="input" rows={3} value={m.notes} onChange={(e) => setM((x) => ({ ...x, notes: e.target.value }))} placeholder="Anything to add or correct manually…" />

          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={() => save('DRAFT')}>Save draft</button>
            <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={email}>{busy ? <span className="spin" /> : 'Finalize & email'}</button>
          </div>
        </>
      )}
    </div>
  );
}
