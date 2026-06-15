import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const STATUS_LABEL = { DRAFT: 'draft', SUBMITTED: 'submitted', EMAILED: 'emailed' };

function ReportForm({ report, sites, onSave, onClose }) {
  const { toast } = useStore();
  const role = useRole();
  const isGM = atLeast(role, 'GENERAL_MANAGER');
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    report_date: report?.report_date || today(),
    site_id: report?.site_id || sites[0]?.id || '',
    total_cash: report?.total_cash ?? '',
    total_deposit: report?.total_deposit ?? '',
    diesel: report?.diesel ?? '',
    expenses: report?.expenses ?? '',
    sales: report?.sales_json ? JSON.parse(report.sales_json) : [{ label: 'Pump Sales', amount: '' }],
    notes: report?.notes || '',
    submit: false,
  });

  const setField = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const totalSales = f.sales.reduce((s, l) => s + (+l.amount || 0), 0);

  const save = async (submit = false) => {
    setSaving(true);
    try {
      const body = { ...f, submit };
      if (report?.id) {
        await api(scoped(`/reports/${report.id}`), { method: 'PATCH', body });
      } else {
        await api(scoped('/reports'), { method: 'POST', body });
      }
      toast(submit ? 'Report submitted ✓' : 'Saved', 'ok');
      onSave();
      onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3>{report?.id ? 'Edit Report' : 'New Report'}</h3>
      <p className="sub">{f.report_date} · {sites.find((s) => s.id === f.site_id)?.name}</p>

      <div className="grid2">
        <div>
          <label className="fl">Date</label>
          <input type="date" className="input" value={f.report_date} max={today()}
            onChange={(e) => setField('report_date', e.target.value)} />
        </div>
        {(isGM || sites.length > 1) && (
          <div>
            <label className="fl">Site</label>
            <select className="input" value={f.site_id} onChange={(e) => setField('site_id', e.target.value)}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <label className="fl">Sales lines</label>
      {f.sales.map((line, i) => (
        <div className="line" key={i}>
          <input className="input" placeholder="Label" value={line.label}
            onChange={(e) => setF((p) => { const s = [...p.sales]; s[i] = { ...s[i], label: e.target.value }; return { ...p, sales: s }; })} />
          <input className="input" type="number" placeholder="0" value={line.amount}
            onChange={(e) => setF((p) => { const s = [...p.sales]; s[i] = { ...s[i], amount: e.target.value }; return { ...p, sales: s }; })} />
          <span />
          <button className="x" onClick={() => setF((p) => ({ ...p, sales: p.sales.filter((_, j) => j !== i) }))}>✕</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }}
        onClick={() => setF((p) => ({ ...p, sales: [...p.sales, { label: '', amount: '' }] }))}>
        + Add line
      </button>

      <div className="grid2">
        <div>
          <label className="fl">Cash Received</label>
          <input type="number" className="input" value={f.total_cash} onChange={(e) => setField('total_cash', e.target.value)} />
        </div>
        <div>
          <label className="fl">Deposit</label>
          <input type="number" className="input" value={f.total_deposit} onChange={(e) => setField('total_deposit', e.target.value)} />
        </div>
        <div>
          <label className="fl">Diesel</label>
          <input type="number" className="input" value={f.diesel} onChange={(e) => setField('diesel', e.target.value)} />
        </div>
        <div>
          <label className="fl">Other Expenses</label>
          <input type="number" className="input" value={f.expenses} onChange={(e) => setField('expenses', e.target.value)} />
        </div>
      </div>

      <label className="fl">Notes</label>
      <textarea className="input" rows={3} value={f.notes} onChange={(e) => setField('notes', e.target.value)} />

      <div style={{ background: 'var(--brand-l)', borderRadius: 12, padding: '10px 14px', margin: '12px 0', fontWeight: 700 }}>
        Total Sales: {ngn(totalSales)}
      </div>

      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={() => save(false)} disabled={saving}>Save draft</button>
        <button className="btn" onClick={() => save(true)} disabled={saving}>
          {saving ? <span className="spin" /> : null} Submit
        </button>
      </div>
    </div>
  );
}

export default function Reports() {
  const { openModal, closeModal, sites, tenant } = useStore();
  const role = useRole();
  const isSM = role && !atLeast(role, 'GENERAL_MANAGER');
  const [reports, setReports] = useState([]);
  const [pos, setPos] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ site: '', from: '', to: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.site) params.set('site', filters.site);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      const [data, posData] = await Promise.all([
        api(scoped(`/reports?${params}`)),
        api(scoped(`/pos/range?${params}`)).catch(() => null),  // imported + live POS sales
      ]);
      setReports(data); setPos(posData);
    } catch { setReports([]); }
    setLoading(false);
  }, [tenant, filters]);

  useEffect(() => { load(); }, [load]);

  const openForm = (report = null) => {
    openModal(
      <ReportForm
        report={report}
        sites={sites}
        onSave={load}
        onClose={closeModal}
      />
    );
  };

  return (
    <div>
      {/* Filters row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input type="date" className="input" style={{ flex: '1 1 120px' }}
          value={filters.from} onChange={(e) => setFilters((p) => ({ ...p, from: e.target.value }))} />
        <input type="date" className="input" style={{ flex: '1 1 120px' }}
          value={filters.to} onChange={(e) => setFilters((p) => ({ ...p, to: e.target.value }))} />
        {!isSM && sites.length > 1 && (
          <select className="input" style={{ flex: '1 1 140px' }}
            value={filters.site} onChange={(e) => setFilters((p) => ({ ...p, site: e.target.value }))}>
            <option value="">All sites</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      {/* POS sales summary (imported Fido history + live in-app sales) */}
      {pos && pos.totals.orders > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <strong>POS sales{filters.from || filters.to ? '' : ' · all time'}</strong>
            <span style={{ fontWeight: 800 }}>{ngn(pos.totals.sales)}</span>
          </div>
          <div className="stat-grid" style={{ marginBottom: pos.bySite.length > 1 ? 8 : 0 }}>
            <div className="stat"><div className="k">Orders</div><div className="v" style={{ fontSize: 18 }}>{pos.totals.orders.toLocaleString()}</div></div>
            <div className="stat"><div className="k">Cash</div><div className="v" style={{ fontSize: 18 }}>{ngn(pos.totals.cash)}</div></div>
            <div className="stat"><div className="k">Transfer/POS</div><div className="v" style={{ fontSize: 18 }}>{ngn(pos.totals.transfer)}</div></div>
          </div>
          {pos.bySite.length > 1 && pos.bySite.map((b) => (
            <div key={b.code} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
              <span style={{ color: 'var(--muted)' }}>{b.site}</span>
              <span style={{ fontWeight: 600 }}>{ngn(b.sales)} · {b.orders.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : reports.length === 0 ? (
        <div className="empty"><div className="ic">🧾</div><p>{pos && pos.totals.orders > 0 ? 'No daily reports yet — POS sales shown above' : 'No reports found'}</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {reports.map((r) => (
            <button key={r.id} onClick={() => openForm(r)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{r.site_name} <span className={`badge ${STATUS_LABEL[r.status] || 'draft'}`}>{r.status}</span></div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.report_date} · {r.tenant_name}</div>
              </div>
              <div style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{ngn(r.total_sales)}</div>
            </button>
          ))}
        </div>
      )}

      <button className="fab" onClick={() => openForm()}>+</button>
    </div>
  );
}
