import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore } from '../store.jsx';

const RANGES = [
  { label: 'This week',  days: 7 },
  { label: 'This month', days: 30 },
  { label: '90 days',    days: 90 },
];

function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10);
}

function BarChart({ data }) {
  if (!data?.length) return null;
  const max = Math.max(...data.map((d) => +d.sales), 1);
  const W = 340, H = 80, bar = Math.max(2, Math.floor(W / data.length) - 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }} aria-hidden>
      {data.map((d, i) => {
        const h = Math.max(3, Math.round((d.sales / max) * (H - 20)));
        const x = i * (W / data.length);
        return (
          <g key={d.day || i}>
            <rect x={x + 1} y={H - h - 16} width={bar} height={h}
              rx={2} fill={d.sales >= max * 0.9 ? 'var(--brand-d)' : 'var(--brand-l)'} />
          </g>
        );
      })}
      {data.length > 1 && <>
        <text x={2} y={H} fontSize={9} fill="var(--muted)">{data[0]?.day?.slice(5)}</text>
        <text x={W - 2} y={H} fontSize={9} fill="var(--muted)" textAnchor="end">{data[data.length - 1]?.day?.slice(5)}</text>
      </>}
    </svg>
  );
}

export default function Dashboard() {
  const { tenant } = useStore();
  const [rangeIdx, setRangeIdx] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const from = daysAgo(RANGES[rangeIdx].days);
      const to = today();
      const d = await api(scoped(`/dashboard?from=${from}&to=${to}`));
      setData(d);
    } catch { /* tenant not selected */ }
    setLoading(false);
  }, [tenant, rangeIdx]);

  useEffect(() => { load(); }, [load]);

  const t = data?.totals;

  return (
    <div>
      <div className="seg" style={{ marginBottom: 14 }}>
        {RANGES.map((r, i) => (
          <button key={r.label} className={`seg-b${rangeIdx === i ? ' on' : ''}`} onClick={() => setRangeIdx(i)}>
            {r.label}
          </button>
        ))}
      </div>

      {loading ? (
        <>{[...Array(4)].map((_, i) => <div className="skel" key={i} style={{ height: 72 }} />)}</>
      ) : !t ? (
        <div className="empty"><div className="ic">📊</div><p>Select a workspace to see data</p></div>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat accent">
              <div className="k">Total Sales</div>
              <div className="v">{ngn(t.sales)}</div>
            </div>
            <div className="stat">
              <div className="k">Cash</div>
              <div className="v">{ngn(t.cash)}</div>
            </div>
            <div className="stat">
              <div className="k">Deposits</div>
              <div className="v">{ngn(t.deposit)}</div>
            </div>
            <div className="stat">
              <div className="k">Costs</div>
              <div className="v">{ngn(t.costs)}</div>
            </div>
          </div>

          {data.byDay?.length > 0 && (
            <div className="card" style={{ paddingBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                Daily Sales Trend
              </div>
              <BarChart data={data.byDay} />
            </div>
          )}

          {data.bySite?.length > 0 && (
            <div className="card">
              <div className="section-title" style={{ marginTop: 0 }}>By Site</div>
              {data.bySite.map((s, i) => (
                <div className="list-item" key={s.site}>
                  <div className="av" style={{ borderRadius: 8, fontSize: 14, fontWeight: 800 }}>{i + 1}</div>
                  <div className="meta"><div className="t">{s.site}</div></div>
                  <div className="amt">{ngn(s.sales)}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {t.reports} report{t.reports !== 1 ? 's' : ''} · {RANGES[rangeIdx].label}
          </div>
        </>
      )}
    </div>
  );
}
