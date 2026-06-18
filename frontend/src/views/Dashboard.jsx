import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useBackHandler } from '../store.jsx';
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

const ngnK = (n) => n >= 1000 ? `₦${Math.round(n / 1000)}k` : `₦${Math.round(n)}`;
const hourLabel = (h) => { if (h == null) return '—'; const ap = h < 12 ? 'a' : 'p'; const hr = h % 12 === 0 ? 12 : h % 12; return `${hr}${ap}`; };
const peakHour = (byHour) => (byHour || []).reduce((b, h) => (h.sales > (b?.sales ?? -1) ? h : b), null)?.hour;
const peakHourSales = (byHour) => (byHour || []).reduce((m, h) => Math.max(m, h.sales || 0), 0);
// Build a continuous hour series (first→last active hour) so gaps read as a trend.
function hourItems(byHour) {
  const map = new Map((byHour || []).map((h) => [h.hour, +h.sales || 0]));
  const active = [...map.keys()].filter((h) => map.get(h) > 0);
  if (!active.length) return [];
  const lo = Math.min(...active), hi = Math.max(...active);
  const out = [];
  for (let h = lo; h <= hi; h++) out.push({ label: h % 3 === 0 ? hourLabel(h) : '', value: map.get(h) || 0, strong: false });
  return out;
}

// Labeled bar chart — value on the tallest bar, sparse x-labels, last/peak bold.
function SalesBars({ items }) {
  if (!items?.length) return null;
  const max = Math.max(...items.map((d) => d.value), 1);
  const W = 340, H = 96, gap = 2;
  const bw = Math.max(2, (W / items.length) - gap);
  const peakI = items.reduce((bi, d, i) => (d.value > items[bi].value ? i : bi), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 96 }} aria-hidden>
      {items.map((d, i) => {
        const h = Math.max(2, Math.round((d.value / max) * (H - 34)));
        const x = i * (W / items.length);
        const top = H - h - 16;
        const hot = i === peakI || d.strong;
        return (
          <g key={i}>
            <rect x={x + gap / 2} y={top} width={bw} height={h} rx={2} fill={hot ? 'var(--brand-d)' : 'var(--brand-l)'} />
            {i === peakI && <text x={x + bw / 2} y={top - 3} fontSize={9} fill="var(--ink)" textAnchor="middle" fontWeight="700">{ngnK(d.value)}</text>}
            {d.label && <text x={x + bw / 2} y={H - 3} fontSize={9} fill="var(--muted)" textAnchor="middle">{d.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// FAQ-style foldable breakdown card — tap the header to reveal/hide its rows.
function FoldSection({ title, count, open, onToggle, children }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button onClick={onToggle} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', border: 'none', background: 'none', cursor: 'pointer', padding: '14px 16px', textAlign: 'left' }}>
        <span className="section-title" style={{ margin: 0 }}>{title}{count != null ? <span style={{ color: 'var(--muted)', fontWeight: 600 }}> · {count}</span> : null}</span>
        <span style={{ color: 'var(--muted)', fontSize: 18, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .18s' }}>›</span>
      </button>
      {open && <div style={{ padding: '0 16px 10px' }}>{children}</div>}
    </div>
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
  // Hardware Back steps up one drill level instead of leaving the screen/app.
  useBackHandler(!!drill, () => setDrill(null));
  useBackHandler(!!bankDrill, () => setBankDrill(null));
  useBackHandler(!!detailId, () => setDetailId(null));   // deepest → declared last → closed first

  // Live sales feed (streamed from the still-running fido POS, pre-cutover).
  // Only genuinely live sales are shown: the card auto-hides when none have
  // arrived in the last few minutes, and stale/look-back events are ignored.
  const LIVE_FRESH_MS = 5 * 60 * 1000;   // a sale is "live" for 5 minutes
  const [live, setLive] = useState({ total: 0, count: 0, feed: [], lastAt: 0 });
  const flash = useRef(0);
  const [, setTick] = useState(0);   // re-render every 30s so the card can expire
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  const { connected } = useRealtime((evt) => {
    if (evt.type !== 'fido.sale' && evt.type !== 'sale.created') return;
    // Ignore events whose sale time is well in the past — a reconnect/look-back
    // burst is not "sales going on now".
    const atMs = evt.payload?.at ? new Date(evt.payload.at).getTime() : Date.now();
    if (Number.isFinite(atMs) && Date.now() - atMs > LIVE_FRESH_MS) return;
    const amount = Number(evt.payload?.amount ?? evt.payload?.total ?? 0);
    setLive((p) => ({
      total: p.total + amount,
      count: p.count + 1,
      lastAt: Date.now(),
      feed: [{ id: `${evt.seq}-${Date.now()}`, oid: evt.payload?.id || evt.payload?.sale_id || null, site: evt.payload?.site || '', amount, pm: evt.payload?.payment_method || '', at: Math.floor((Number.isFinite(atMs) ? atMs : Date.now()) / 1000) }, ...p.feed].slice(0, 8),
    }));
    flash.current += 1;
  });
  // The feed is "live" only while a sale arrived recently; otherwise hide it.
  const liveActive = live.lastAt > 0 && (Date.now() - live.lastAt) < LIVE_FRESH_MS;

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
  const byProduct = usePos ? (pos.byProduct || []) : [];
  const byCustomer = usePos ? (pos.byCustomer || []) : [];
  const byHour = usePos ? (pos.byHour || []) : [];
  // A single calendar day is selected (Today or a picked day) → show hourly; a
  // multi-day range → show the daily trend.
  const isSingleDay = !!day || RANGES[rangeIdx].days === 0;

  // FAQ-style foldable breakdowns: Site open by default, Product/Customer hidden.
  const [openSec, setOpenSec] = useState({ site: true, product: false, customer: false });
  const toggleSec = (k) => setOpenSec((p) => ({ ...p, [k]: !p[k] }));

  // Build the orders-drill query for the current date range (+ extra filters).
  const rangeQS = () => {
    const from = day || daysAgo(RANGES[rangeIdx].days);
    const to = day || today();
    return `from=${from}&to=${to}`;
  };
  const openOrders = (title, extra = '') => setDrill({ title, query: rangeQS() + (extra ? `&${extra}` : '') });

  return (
    <div>
      {/* Live sales feed — only while sales are actually happening now */}
      {liveActive && (
        <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid #16a34a' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#16a34a' : '#94a3b8', boxShadow: connected ? '0 0 0 4px rgba(22,163,74,.18)' : 'none', display: 'inline-block' }} />
              LIVE SALES{connected ? '' : ' (reconnecting…)'}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontWeight: 800 }}>{ngn(live.total)} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>· {live.count}</span></span>
              {live.count > 0 && (
                <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 10px', fontSize: 12 }}
                  onClick={() => setLive({ total: 0, count: 0, feed: [] })}>Clear</button>
              )}
            </span>
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

          {isSingleDay && byHour.some((h) => h.sales > 0) ? (
            <div className="card" style={{ paddingBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Sales by hour · {day || 'today'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>peak {hourLabel(peakHour(byHour))} · {ngn(peakHourSales(byHour))}</div>
              </div>
              <SalesBars items={hourItems(byHour)} />
            </div>
          ) : (byDay?.length > 1) ? (
            <div className="card" style={{ paddingBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>Daily sales trend</div>
              <SalesBars items={(byDay || []).map((d, i) => ({ label: (d.day || '').slice(5), value: +d.sales || 0, strong: i === byDay.length - 1 }))} />
            </div>
          ) : null}

          {bySite?.length > 0 && (
            <FoldSection title="By Site" count={bySite.length} open={openSec.site} onToggle={() => toggleSec('site')}>
              {bySite.map((s, i) => (
                <button className="list-item" key={s.site} onClick={() => usePos && openOrders(s.site, `site_code=${encodeURIComponent(s.code || s.site)}`)}
                  style={{ width: '100%', border: 'none', background: 'none', cursor: usePos ? 'pointer' : 'default', textAlign: 'left' }}>
                  <div className="av" style={{ borderRadius: 8, fontSize: 14, fontWeight: 800 }}>{i + 1}</div>
                  <div className="meta"><div className="t">{s.site}{usePos ? ' ›' : ''}</div></div>
                  <div className="amt">{ngn(s.sales)}</div>
                </button>
              ))}
            </FoldSection>
          )}

          {byProduct.length > 0 && (
            <FoldSection title="By Product" count={byProduct.length} open={openSec.product} onToggle={() => toggleSec('product')}>
              {byProduct.map((p, i) => (
                <button className="list-item" key={p.product + i} onClick={() => openOrders(p.product, `product=${encodeURIComponent(p.product)}`)}
                  style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                  <div className="av" style={{ borderRadius: 8, fontSize: 14, fontWeight: 800 }}>{i + 1}</div>
                  <div className="meta"><div className="t">{p.product} ›</div>{p.qty ? <div className="s" style={{ fontSize: 12, color: 'var(--muted)' }}>{Number(p.qty).toLocaleString()} sold</div> : null}</div>
                  <div className="amt">{ngn(p.sales)}</div>
                </button>
              ))}
            </FoldSection>
          )}

          {byCustomer.length > 0 && (
            <FoldSection title="By Customer" count={byCustomer.length} open={openSec.customer} onToggle={() => toggleSec('customer')}>
              {byCustomer.map((c, i) => (
                <button className="list-item" key={(c.customer_id || c.customer) + i} onClick={() => openOrders(c.customer, `customer=${encodeURIComponent(c.customer_id || c.customer)}`)}
                  style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                  <div className="av" style={{ borderRadius: 8, fontSize: 14, fontWeight: 800 }}>{i + 1}</div>
                  <div className="meta"><div className="t">{c.customer} ›</div>{c.orders ? <div className="s" style={{ fontSize: 12, color: 'var(--muted)' }}>{Number(c.orders).toLocaleString()} order{c.orders > 1 ? 's' : ''}</div> : null}</div>
                  <div className="amt">{ngn(c.sales)}</div>
                </button>
              ))}
            </FoldSection>
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
