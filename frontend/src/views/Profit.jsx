/**
 * Profit.jsx — simple P&L: Revenue (POS sales) − Expenses = Profit, for a period
 * and site. Reuses /pos/range (revenue) + /expenses/summary (costs). Cross-site
 * users get a per-site breakdown; site-bound users see their own site.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const RANGES = [
  { label: 'Today', days: 0 }, { label: 'This week', days: 7 },
  { label: 'This month', days: 30 }, { label: '90 days', days: 90 },
];
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function Profit() {
  const { tenant, sites } = useStore();
  const role = useRole();
  const crossSite = role && atLeast(role, 'SNR_ACCOUNTANT');
  const [rangeIdx, setRangeIdx] = useState(2);   // default This month
  const [site, setSite] = useState('');
  const [pos, setPos] = useState(null);
  const [exp, setExp] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const from = daysAgo(RANGES[rangeIdx].days), to = today();
    const q = new URLSearchParams({ from, to }); if (site) q.set('site', site);
    try {
      const [p, e] = await Promise.all([
        api(scoped(`/pos/range?${q}`)).catch(() => null),
        api(scoped(`/expenses/summary?${q}`)).catch(() => null),
      ]);
      setPos(p); setExp(e);
    } catch { setPos(null); setExp(null); }
    setLoading(false);
  }, [tenant, rangeIdx, site]);
  useEffect(() => { load(); }, [load]);

  const revenue = pos?.totals?.sales || 0;
  const incentive = pos?.totals?.incentive || 0;
  const costs = exp?.totals?.total || 0;
  const profit = revenue - costs;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  // Per-site P&L (cross-site only): match revenue bySite ↔ expense bySite by name.
  const bySite = (() => {
    if (!crossSite || site) return [];
    const rev = {}; (pos?.bySite || []).forEach((b) => { rev[norm(b.site)] = { name: b.site, sales: b.sales }; });
    const ex = {}; (exp?.bySite || []).forEach((b) => { ex[norm(b.site)] = b.total; });
    const keys = new Set([...Object.keys(rev), ...Object.keys(ex)]);
    return [...keys].map((k) => ({ name: rev[k]?.name || (exp?.bySite || []).find((b) => norm(b.site) === k)?.site || '—', sales: rev[k]?.sales || 0, costs: ex[k] || 0 }))
      .map((r) => ({ ...r, profit: r.sales - r.costs })).sort((a, b) => b.profit - a.profit);
  })();

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>Profit & Loss</div>
      <div className="seg" style={{ marginBottom: 10 }}>
        {RANGES.map((r, i) => <button key={r.label} className={`seg-b${rangeIdx === i ? ' on' : ''}`} onClick={() => setRangeIdx(i)}>{r.label}</button>)}
      </div>
      {crossSite && sites.length > 1 && (
        <select className="input" style={{ marginBottom: 12 }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}

      {loading ? <>{[...Array(4)].map((_, i) => <div className="skel" key={i} style={{ height: 64 }} />)}</> : (
        <>
          <div className="card" style={{ textAlign: 'center', padding: '18px 16px', marginBottom: 12, background: profit >= 0 ? '#f0fdf4' : '#fef2f2' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{profit >= 0 ? 'Profit' : 'Loss'} · {RANGES[rangeIdx].label}</div>
            <div style={{ fontSize: 34, fontWeight: 800, color: profit >= 0 ? '#166534' : '#991b1b', margin: '2px 0' }}>{ngn(profit)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>margin {margin.toFixed(1)}%</div>
          </div>

          <div className="stat-grid" style={{ marginBottom: 12 }}>
            <div className="stat accent"><div className="k">Revenue (sales)</div><div className="v">{ngn(revenue)}</div></div>
            <div className="stat"><div className="k">Expenses</div><div className="v">{ngn(costs)}</div></div>
          </div>

          {/* Revenue → expenses → profit waterfall */}
          <div className="card" style={{ marginBottom: 12 }}>
            <Bar label="Revenue" value={revenue} max={Math.max(revenue, costs, 1)} color="var(--brand-d)" />
            <Bar label="Expenses" value={costs} max={Math.max(revenue, costs, 1)} color="#dc2626" />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--line)' }}>
              <span>Profit</span><span style={{ color: profit >= 0 ? '#166534' : '#991b1b' }}>{ngn(profit)}</span>
            </div>
          </div>

          {incentive > 0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', margin: '0 2px 12px' }}>🎁 Incentive (bonus given out, excluded from revenue): {ngn(incentive)}</div>
          )}

          {(exp?.byCategory || []).length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="section-title" style={{ marginTop: 0 }}>Expenses by category</div>
              {exp.byCategory.map((c) => (
                <div key={c.category} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, padding: '5px 0', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ color: 'var(--muted)' }}>{c.category || 'OTHER'}</span><strong>{ngn(c.total)}</strong>
                </div>
              ))}
            </div>
          )}

          {bySite.length > 1 && (
            <div className="card">
              <div className="section-title" style={{ marginTop: 0 }}>By site</div>
              {bySite.map((b) => (
                <div key={b.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
                  <div><div style={{ fontWeight: 700 }}>{b.name}</div><div style={{ fontSize: 11, color: 'var(--muted)' }}>rev {ngn(b.sales)} · exp {ngn(b.costs)}</div></div>
                  <strong style={{ color: b.profit >= 0 ? '#166534' : '#991b1b' }}>{ngn(b.profit)}</strong>
                </div>
              ))}
            </div>
          )}

          <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>Revenue = POS sales (excl. incentive). Expenses = all expense tickets in the period (the full amount, whether or not paid yet). Salaries appear here when booked as expenses.</p>
        </>
      )}
    </div>
  );
}

function Bar({ label, value, max, color }) {
  const pct = Math.max(2, Math.round((value / max) * 100));
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 2 }}><span style={{ color: 'var(--muted)' }}>{label}</span><strong>{ngn(value)}</strong></div>
      <div style={{ height: 8, background: 'var(--line)', borderRadius: 4 }}><div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} /></div>
    </div>
  );
}
