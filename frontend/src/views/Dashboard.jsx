import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore } from '../store.jsx';
import { useRealtime } from '../hooks/useRealtime.js';

const clock = (s) => new Date((s || Date.now() / 1000) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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
  const [pos, setPos] = useState(null);
  const [loading, setLoading] = useState(true);

  // Live sales feed (streamed from the still-running fido POS, pre-cutover).
  const [live, setLive] = useState({ total: 0, count: 0, feed: [] });
  const flash = useRef(0);
  const { connected } = useRealtime((evt) => {
    if (evt.type !== 'fido.sale' && evt.type !== 'sale.created') return;
    const amount = Number(evt.payload?.amount ?? evt.payload?.total ?? 0);
    setLive((p) => ({
      total: p.total + amount,
      count: p.count + 1,
      feed: [{ id: `${evt.seq}-${Date.now()}`, site: evt.payload?.site || '', amount, pm: evt.payload?.payment_method || '', at: evt.payload?.at ? Math.floor(new Date(evt.payload.at).getTime() / 1000) : Math.floor(Date.now() / 1000) }, ...p.feed].slice(0, 8),
    }));
    flash.current += 1;
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const from = daysAgo(RANGES[rangeIdx].days);
      const to = today();
      const [d, p] = await Promise.all([
        api(scoped(`/dashboard?from=${from}&to=${to}`)),
        api(scoped(`/pos/range?from=${from}&to=${to}`)).catch(() => null),  // imported + live POS sales
      ]);
      setData(d); setPos(p);
    } catch { /* tenant not selected */ }
    setLoading(false);
  }, [tenant, rangeIdx]);

  useEffect(() => { load(); }, [load]);

  const t = data?.totals;
  // Prefer real POS sales for the headline numbers; fall back to daily-report totals.
  const usePos = pos && pos.totals.orders > 0;
  const sales = usePos ? pos.totals.sales : (t?.sales || 0);
  const cash = usePos ? pos.totals.cash : (t?.cash || 0);
  const transfer = usePos ? pos.totals.transfer : (t?.deposit || 0);
  const byDay = usePos ? pos.byDay : data?.byDay;
  const bySite = usePos ? pos.bySite : data?.bySite;

  return (
    <div>
      {/* Live sales feed — streams from the running fido POS before cutover */}
      {(connected || live.count > 0) && (
        <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid #16a34a' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#16a34a' : '#94a3b8', boxShadow: connected ? '0 0 0 4px rgba(22,163,74,.18)' : 'none', display: 'inline-block' }} />
              LIVE SALES{connected ? '' : ' (reconnecting…)'}
            </span>
            <span style={{ fontWeight: 800 }}>{ngn(live.total)} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>· {live.count}</span></span>
          </div>
          {live.feed.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {live.feed.map((s) => (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '3px 0', color: 'var(--ink)' }}>
                  <span style={{ color: 'var(--muted)' }}>{s.site}{s.pm ? ` · ${s.pm}` : ''} · {clock(s.at)}</span>
                  <span style={{ fontWeight: 700 }}>{ngn(s.amount)}</span>
                </div>
              ))}
            </div>
          )}
          {live.feed.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Waiting for the next sale…</div>}
        </div>
      )}

      <div className="seg" style={{ marginBottom: 14 }}>
        {RANGES.map((r, i) => (
          <button key={r.label} className={`seg-b${rangeIdx === i ? ' on' : ''}`} onClick={() => setRangeIdx(i)}>
            {r.label}
          </button>
        ))}
      </div>

      {loading ? (
        <>{[...Array(4)].map((_, i) => <div className="skel" key={i} style={{ height: 72 }} />)}</>
      ) : (!t && !usePos) ? (
        <div className="empty"><div className="ic">📊</div><p>Select a workspace to see data</p></div>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat accent">
              <div className="k">Total Sales</div>
              <div className="v">{ngn(sales)}</div>
            </div>
            <div className="stat">
              <div className="k">Cash</div>
              <div className="v">{ngn(cash)}</div>
            </div>
            <div className="stat">
              <div className="k">{usePos ? 'Transfer/POS' : 'Deposits'}</div>
              <div className="v">{ngn(transfer)}</div>
            </div>
            <div className="stat">
              <div className="k">{usePos ? 'Orders' : 'Costs'}</div>
              <div className="v">{usePos ? pos.totals.orders.toLocaleString() : ngn(t?.costs || 0)}</div>
            </div>
          </div>

          {byDay?.length > 0 && (
            <div className="card" style={{ paddingBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
                Daily Sales Trend
              </div>
              <BarChart data={byDay} />
            </div>
          )}

          {bySite?.length > 0 && (
            <div className="card">
              <div className="section-title" style={{ marginTop: 0 }}>By Site</div>
              {bySite.map((s, i) => (
                <div className="list-item" key={s.site}>
                  <div className="av" style={{ borderRadius: 8, fontSize: 14, fontWeight: 800 }}>{i + 1}</div>
                  <div className="meta"><div className="t">{s.site}</div></div>
                  <div className="amt">{ngn(s.sales)}</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {usePos ? `${pos.totals.orders.toLocaleString()} orders` : `${t?.reports || 0} report${t?.reports !== 1 ? 's' : ''}`} · {RANGES[rangeIdx].label}
          </div>
        </>
      )}
    </div>
  );
}
