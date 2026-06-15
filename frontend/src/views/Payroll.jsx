import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d) => d.toISOString().slice(0, 10);
const eom = (y, m) => ymd(new Date(y, m, 0));   // m is 1-based

// ── Run: compute a payroll for a period ───────────────────────────────────────
function RunTab({ sites }) {
  const { toast } = useStore();
  const now = new Date();
  const [from, setFrom] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
  const [to, setTo] = useState(today());
  const [site, setSite] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);

  const preset = (kind) => {
    const y = now.getFullYear(), m = now.getMonth() + 1, mm = String(m).padStart(2, '0');
    if (kind === 'mid') { setFrom(`${y}-${mm}-01`); setTo(`${y}-${mm}-15`); }
    else if (kind === 'second') { setFrom(`${y}-${mm}-16`); setTo(eom(y, m)); }
    else { setFrom(`${y}-${mm}-01`); setTo(eom(y, m)); }
  };

  const run = async () => {
    setBusy(true);
    try { setRes(await api(scoped('/payroll/compute2'), { method: 'POST', body: { from, to, site: site || undefined } })); }
    catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };

  const exportCsv = () => {
    if (!res) return;
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Staff', 'Role', 'Pay type', 'Days present', 'Bags loaded', 'Bags bagged', 'Gross'];
    const lines = [head.join(','), ...res.lines.map((l) => [l.full_name, l.role_title, l.pay_type, l.days_present, l.bags_loaded, l.bags_bagged, l.gross].map(q).join(','))];
    const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `payroll_${from}_${to}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => preset('mid')}>1–15 (mid-month)</button>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => preset('second')}>16–end</button>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => preset('month')}>Full month</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input type="date" className="input" style={{ flex: '1 1 120px' }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="input" style={{ flex: '1 1 120px' }} value={to} max={today()} onChange={(e) => setTo(e.target.value)} />
        {sites.length > 1 && (
          <select className="input" style={{ flex: '1 1 120px' }} value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All sites</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <button className="btn" style={{ width: 'auto', padding: '8px 18px' }} onClick={run} disabled={busy}>{busy ? <span className="spin" /> : null} Compute</button>
      </div>

      {res && (
        res.lines.length === 0 ? <div className="empty"><div className="ic">💰</div><p>Nothing to pay in this period</p></div> : (
          <>
            <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{res.lines.length} staff · {from} → {to}</span>
              <span style={{ fontWeight: 800, fontSize: 18 }}>{ngn(res.total)}</span>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {res.lines.map((l) => (
                <div key={l.staff_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{l.full_name}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {l.pay_type === 'PIECE' ? `loaded ${l.bags_loaded} · bagged ${l.bags_bagged}` : `${l.days_present} day${l.days_present === 1 ? '' : 's'} present`}
                    </div>
                  </div>
                  <div style={{ fontWeight: 800 }}>{ngn(l.gross)}</div>
                </div>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 10, width: 'auto', padding: '6px 14px' }} onClick={exportCsv}>⬇ Export CSV</button>
          </>
        )
      )}
    </div>
  );
}

// ── Setup: pay rates per staff ────────────────────────────────────────────────
function SetupTab({ sites }) {
  const { tenant, toast } = useStore();
  const [rows, setRows] = useState([]);
  const [site, setSite] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const p = new URLSearchParams(); if (site) p.set('site', site); setRows(await api(scoped(`/payroll/pay-config?${p}`))); }
    catch { setRows([]); }
    setLoading(false);
  }, [tenant, site]);
  useEffect(() => { load(); }, [load]);

  const setVal = (i, k, v) => setRows((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async (r) => {
    try {
      await api(scoped(`/payroll/pay-config/${r.id}`), { method: 'PATCH', body: { pay_type: r.pay_type, daily_rate: +r.daily_rate || 0, rate_loaded: +r.rate_loaded || 0, rate_bagged: +r.rate_bagged || 0 } });
      toast(`${r.full_name} saved ✓`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  if (loading) return <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      {sites.length > 1 && (
        <select className="input" style={{ marginBottom: 12 }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      {rows.map((r, i) => (
        <div key={r.id} className="card" style={{ padding: '10px 14px', marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong>{r.full_name}</strong>
            <select className="input" style={{ width: 'auto', padding: '4px 8px' }} value={r.pay_type || 'DAILY'} onChange={(e) => setVal(i, 'pay_type', e.target.value)}>
              <option value="DAILY">Daily (regular)</option>
              <option value="PIECE">Piece (loader/bagger)</option>
            </select>
          </div>
          {r.pay_type === 'PIECE' ? (
            <div className="grid2">
              <div><label className="fl">₦ / bag loaded</label><input type="number" className="input" value={r.rate_loaded ?? 0} onChange={(e) => setVal(i, 'rate_loaded', e.target.value)} /></div>
              <div><label className="fl">₦ / bag bagged</label><input type="number" className="input" value={r.rate_bagged ?? 0} onChange={(e) => setVal(i, 'rate_bagged', e.target.value)} /></div>
            </div>
          ) : (
            <div><label className="fl">₦ / day present</label><input type="number" className="input" value={r.daily_rate ?? 0} onChange={(e) => setVal(i, 'daily_rate', e.target.value)} /></div>
          )}
          <button className="btn btn-sm" style={{ marginTop: 8, width: 'auto', padding: '4px 14px' }} onClick={() => save(r)}>Save</button>
        </div>
      ))}
    </div>
  );
}

export default function Payroll() {
  const { go, sites } = useStore();
  const role = useRole();
  const allowed = role && atLeast(role, 'SNR_ACCOUNTANT');
  const [tab, setTab] = useState('run');
  const [summary, setSummary] = useState(null);

  useEffect(() => { if (allowed && tab === 'history') api(scoped('/payroll/imported/summary')).then(setSummary).catch(() => {}); }, [allowed, tab]);

  if (!allowed) return <div className="empty"><div className="ic">🔒</div><p>Payroll is restricted to Snr Accountants and above.</p></div>;

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => go('more')}>← More</button>
      <div className="section-title" style={{ marginTop: 0 }}>Payroll</div>
      <div className="seg" style={{ marginBottom: 14, overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`seg-b${tab === 'run' ? ' on' : ''}`} onClick={() => setTab('run')}>🧮 Run</button>
        <button className={`seg-b${tab === 'setup' ? ' on' : ''}`} onClick={() => setTab('setup')}>⚙️ Rates</button>
        <button className={`seg-b${tab === 'history' ? ' on' : ''}`} onClick={() => setTab('history')}>📜 History</button>
      </div>

      {tab === 'run' ? <RunTab sites={sites} />
        : tab === 'setup' ? <SetupTab sites={sites} />
          : !summary || !(summary.byMonth || []).length ? (
            <div className="empty"><div className="ic">📜</div><p>No imported payroll history</p></div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {summary.byMonth.map((m) => (
                <div key={`${m.year}-${m.month}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{MONTHS[+m.month] || m.month} {m.year}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.staff} staff · net {ngn(m.net)}</div>
                  </div>
                  <div style={{ fontWeight: 800 }}>{ngn(m.gross)}</div>
                </div>
              ))}
            </div>
          )}
    </div>
  );
}
