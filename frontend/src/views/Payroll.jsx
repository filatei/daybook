import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function Payroll() {
  const { tenant, go } = useStore();
  const role = useRole();
  const allowed = role && atLeast(role, 'GENERAL_MANAGER');
  const [tab, setTab] = useState('history');   // history | runs
  const [summary, setSummary] = useState(null);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!allowed) { setLoading(false); return; }
    setLoading(true);
    try {
      const [sum, r] = await Promise.all([
        api(scoped('/payroll/imported/summary')).catch(() => null),
        api(scoped('/payroll/runs')).catch(() => []),
      ]);
      setSummary(sum); setRuns(r || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [tenant, allowed]);

  useEffect(() => { load(); }, [load]);

  if (!allowed) {
    return <div className="empty"><div className="ic">🔒</div><p>Payroll is restricted to General Managers and Admins.</p></div>;
  }

  const totalGross = (summary?.byMonth || []).reduce((a, m) => a + Number(m.gross || 0), 0);

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => go('more')}>← More</button>
      <div className="section-title" style={{ marginTop: 0 }}>Payroll</div>

      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={`seg-b${tab === 'history' ? ' on' : ''}`} onClick={() => setTab('history')}>📜 History</button>
        <button className={`seg-b${tab === 'runs' ? ' on' : ''}`} onClick={() => setTab('runs')}>🧮 Runs</button>
      </div>

      {loading ? (
        <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : tab === 'history' ? (
        !summary || !(summary.byMonth || []).length ? (
          <div className="empty"><div className="ic">💰</div><p>No payroll history yet</p></div>
        ) : (
          <>
            <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>Total gross (last 24 months)</span>
              <span style={{ fontWeight: 800, fontSize: 18 }}>{ngn(totalGross)}</span>
            </div>
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
            {(summary.bySite || []).length > 1 && (
              <div className="card">
                <div className="section-title" style={{ marginTop: 0 }}>By site</div>
                {summary.bySite.map((s) => (
                  <div key={s.site} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                    <span style={{ color: 'var(--muted)' }}>{s.site || '—'}</span>
                    <span style={{ fontWeight: 700 }}>{ngn(s.gross)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )
      ) : (
        runs.length === 0 ? (
          <div className="empty"><div className="ic">🧮</div><p>No payroll runs computed yet</p></div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {runs.map((r) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{r.site_name || 'All sites'} <span className="badge">{r.status}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.period_start} → {r.period_end}</div>
                </div>
                <div style={{ fontWeight: 800 }}>{ngn(r.total_net ?? r.total_gross ?? 0)}</div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
