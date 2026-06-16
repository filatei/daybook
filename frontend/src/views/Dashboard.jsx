import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore } from '../store.jsx';
import { useRealtime } from '../hooks/useRealtime.js';
import { OrdersListModal, OrderDetailModal, BankBreakdownModal } from '../components/OrderViews.jsx';

const clock = (s) => new Date((s || Date.now() / 1000) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const RANGES = [
  { label: 'Today',      days: 0 },
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
  const [day, setDay] = useState('');      // a specific picked day (overrides the range)
  const [data, setData] = useState(null);
  const [pos, setPos] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState(null);     // { title, query } orders-list modal
  const [detailId, setDetailId] = useState(null); // single order detail (from live line)
  const [bankDrill, setBankDrill] = useState(null); // { query } transfer/POS breakdown

  // Live sales feed (streamed from the still-running fido POS, pre-cutover).
  const [live, setLive] = useState({ total: 0, count: 0, feed: [] });
  const flash = useRef(0);
  const { connected } = useRealtime((evt) => {
    if (evt.type !== 'fido.sale' && evt.type !== 'sale.created') return;
    const amount = Number(evt.payload?.amount ?? evt.payload?.total ?? 0);
    setLive((p) => ({
      total: p.total + amount,
      count: p.count + 1,
      feed: [{ id: `${evt.seq}-${Date.now()}`, oid: evt.payload?.id || evt.payload?.sale_id || null, site: evt.payload?.site || '', amount, pm: evt.payload?.payment_method || '', at: evt.payload?.at ? Math.floor(new Date(evt.payload.at).getTime() / 1000) : Math.floor(Date.now() / 1000) }, ...p.feed].slice(0, 8),
    }));
    flash.current += 1;
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const from = day || daysAgo(RANGES[rangeIdx].days);   // a picked day overrides the range
      const to = day || today();
      const [d, p] = await Promise.all([
        api(scoped(`/dashboard?from=${from}&to=${to}`)),
        api(scoped(`/pos/range?from=${from}&to=${to}`)).catch(() => null),  // imported + live POS sales
      ]);
      setData(d); setPos(p);
    } catch { /* tenant not selected */ }
    setLoading(false);
  }, [tenant, rangeIdx, day]);

  useEffect(() => { load(); }, [load]);

  const t = data?.totals;
  // Prefer real POS sales for the headline numbers; fall back to daily-report totals.
  const usePos = pos && pos.totals.orders > 0;
  const sales = usePos ? pos.totals.sales : (t?.sales || 0);
  const cash = usePos ? pos.totals.cash : (t?.cash || 0);
  const transfer = usePos ? pos.totals.transfer : (t?.deposit || 0);
  const byDay = usePos ? pos.byDay : data?.byDay;
  const bySite = usePos ? pos.bySite : data?.bySite;

  // Build the orders-drill query for the current date range (+ extra filters).
  const rangeQS = () => {
    const from = day || daysAgo(RANGES[rangeIdx].days);
    const to = day || today();
    return `from=${from}&to=${to}`;
  };
  const openOrders = (title, extra = '') => setDrill({ title, query: rangeQS() + (extra ? `&${extra}` : '') });

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
                <button key={s.id} onClick={() => s.oid && setDetailId(s.oid)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '3px 0', color: 'var(--ink)', width: '100%', border: 'none', background: 'none', cursor: s.oid ? 'pointer' : 'default', textAlign: 'left' }}>
                  <span style={{ color: 'var(--muted)' }}>{s.site}{s.pm ? ` · ${s.pm}` : ''} · {clock(s.at)}</span>
                  <span style={{ fontWeight: 700 }}>{ngn(s.amount)}{s.oid ? ' ›' : ''}</span>
                </button>
              ))}
            </div>
          )}
          {live.feed.length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Waiting for the next sale…</div>}
        </div>
      )}

      <div className="seg" style={{ marginBottom: 10 }}>
        {RANGES.map((r, i) => (
          <button key={r.label} className={`seg-b${(!day && rangeIdx === i) ? ' on' : ''}`} onClick={() => { setDay(''); setRangeIdx(i); }}>
            {r.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Pick a day</span>
        <input type="date" className="input" style={{ flex: 1, maxWidth: 200 }} value={day} max={today()} onChange={(e) => setDay(e.target.value)} />
        {day && <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }} onClick={() => setDay('')}>Clear</button>}
      </div>

      {loading ? (
        <>{[...Array(4)].map((_, i) => <div className="skel" key={i} style={{ height: 72 }} />)}</>
      ) : (!t && !usePos) ? (
        <div className="empty"><div className="ic">📊</div><p>Select a workspace to see data</p></div>
      ) : (
        <>
          <div className="stat-grid">
            <button className="stat accent" onClick={() => usePos && openOrders('All orders')} style={{ cursor: usePos ? 'pointer' : 'default', textAlign: 'left', border: 'none' }}>
              <div className="k">Total Sales{usePos ? ' ›' : ''}</div>
              <div className="v">{ngn(sales)}</div>
            </button>
            <button className="stat" onClick={() => usePos && openOrders('Cash orders', 'method=CASH')} style={{ cursor: usePos ? 'pointer' : 'default', textAlign: 'left', border: 'none' }}>
              <div className="k">Cash{usePos ? ' ›' : ''}</div>
              <div className="v">{ngn(cash)}</div>
            </button>
            <button className="stat" onClick={() => usePos && setBankDrill(rangeQS())} style={{ cursor: usePos ? 'pointer' : 'default', textAlign: 'left', border: 'none' }}>
              <div className="k">{usePos ? 'Transfer/POS ›' : 'Deposits'}</div>
              <div className="v">{ngn(transfer)}</div>
            </button>
            <button className="stat" onClick={() => usePos && openOrders('All orders')} style={{ cursor: usePos ? 'pointer' : 'default', textAlign: 'left', border: 'none' }}>
              <div className="k">{usePos ? 'Orders ›' : 'Costs'}</div>
              <div className="v">{usePos ? pos.totals.orders.toLocaleString() : ngn(t?.costs || 0)}</div>
            </button>
          </div>

          {usePos && pos.totals.incentive > 0 && (
            <button className="stat" onClick={() => openOrders('Incentive orders', 'method=INCENTIVE')}
              style={{ cursor: 'pointer', textAlign: 'left', border: 'none', width: '100%', marginBottom: 12, background: '#fffbeb' }}>
              <div className="k" style={{ color: '#92400e' }}>🎁 Incentive (bonus — not in cash/sales) ›</div>
              <div className="v" style={{ color: '#92400e' }}>{ngn(pos.totals.incentive)}</div>
            </button>
          )}

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
                <button className="list-item" key={s.site} onClick={() => usePos && openOrders(s.site, `site_code=${encodeURIComponent(s.code || s.site)}`)}
                  style={{ width: '100%', border: 'none', background: 'none', cursor: usePos ? 'pointer' : 'default', textAlign: 'left' }}>
                  <div className="av" style={{ borderRadius: 8, fontSize: 14, fontWeight: 800 }}>{i + 1}</div>
                  <div className="meta"><div className="t">{s.site}{usePos ? ' ›' : ''}</div></div>
                  <div className="amt">{ngn(s.sales)}</div>
                </button>
              ))}
            </div>
          )}

          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {usePos ? `${pos.totals.orders.toLocaleString()} orders` : `${t?.reports || 0} report${t?.reports !== 1 ? 's' : ''}`} · {day || RANGES[rangeIdx].label}
          </div>
        </>
      )}

      {bankDrill && (
        <BankBreakdownModal
          title="Transfer / POS breakdown"
          query={bankDrill}
          onClose={() => setBankDrill(null)}
          onPick={(r) => {
            const f = r.terminal ? `terminal=${encodeURIComponent(r.terminal)}` : (r.bank ? `bank=${encodeURIComponent(r.bank)}` : '');
            setBankDrill(null);
            openOrders(`${r.kind === 'POS' ? '💳' : '🏦'} ${r.terminal || r.bank || 'Unspecified'}`, `method=NONCASH${f ? '&' + f : ''}`);
          }}
        />
      )}
      {drill && <OrdersListModal title={drill.title} query={drill.query} onClose={() => setDrill(null)} />}
      {detailId && <OrderDetailModal orderId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
