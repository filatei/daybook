/**
 * Gate.jsx — Gate verification view
 *
 * Staff at the loading gate enter a receipt number to look up the sale,
 * verify it's valid, and mark it as "EXITED" once the customer leaves.
 */
import React, { useState, useCallback } from 'react';
import { api, scoped, ngn } from '../api.js';
import { useStore } from '../store.jsx';

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString('en-NG', {
    timeZone: 'Africa/Lagos',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function Gate() {
  const { tenant, toast } = useStore();
  const [query,   setQuery]   = useState('');
  const [sale,    setSale]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [exiting, setExiting] = useState(false);

  const lookup = useCallback(async () => {
    const rn = query.trim();
    if (!rn) return;
    setLoading(true); setSale(null);
    try {
      const data = await api(scoped(`/pos/gate/${encodeURIComponent(rn)}`));
      setSale(data);
    } catch (e) {
      toast(e.message || 'Receipt not found', 'err');
    }
    setLoading(false);
  }, [query, tenant]);

  const markExited = useCallback(async () => {
    if (!sale) return;
    setExiting(true);
    try {
      const data = await api(`/pos/sales/${sale.id}/exit`, { method: 'POST', body: {} });
      setSale(data);
      toast('Marked as exited ✓', 'ok');
    } catch (e) {
      toast(e.message || 'Error', 'err');
    }
    setExiting(false);
  }, [sale]);

  const reset = () => { setQuery(''); setSale(null); };

  const items = sale ? (sale.items || []) : [];
  const exited = sale?.exited_at;

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>Gate Verification</div>

      {/* Search bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          className="input" type="number" inputMode="numeric"
          placeholder="Enter receipt number…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && lookup()}
          style={{ flex: 1, fontSize: 18, fontWeight: 700 }}
        />
        <button className="btn btn-sm" style={{ width: 52 }} onClick={lookup} disabled={loading || !query.trim()}>
          {loading ? <span className="spin" style={{ width: 14, height: 14, borderTopColor: '#fff' }} /> : '🔍'}
        </button>
        {sale && <button className="btn btn-ghost btn-sm" onClick={reset}>✕</button>}
      </div>

      {/* Result card */}
      {sale && (
        <div className="card">
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 24, letterSpacing: '-1px' }}>
                #{String(sale.receipt_no || '').padStart(4, '0')}
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
                {sale.sale_date} · {sale.site_name || '—'}
              </div>
            </div>
            <span className={`badge ${exited ? 'approved' : 'submitted'}`} style={{ fontSize: 13, padding: '5px 12px' }}>
              {exited ? '✓ EXITED' : '⏳ PENDING'}
            </span>
          </div>

          {/* Customer */}
          {sale.customer_name && (
            <div style={{ marginBottom: 10, fontSize: 14, color: 'var(--muted)' }}>
              👤 {sale.customer_name}
            </div>
          )}

          {/* Items */}
          {items.length > 0 && (
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginBottom: 10 }}>
              {items.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 14, borderBottom: '1px solid var(--line)' }}>
                  <span>
                    {it.name}
                    <span style={{ color: 'var(--muted)', marginLeft: 6 }}>× {it.qty}</span>
                  </span>
                  <span style={{ fontWeight: 700 }}>{ngn(it.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Totals */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 18, borderTop: '2px solid var(--line)', paddingTop: 10 }}>
            <span>TOTAL</span>
            <span>{ngn(sale.total)}</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
            Payment: {sale.payment_method} · {sale.status}
          </div>

          {/* Exit status / action */}
          {exited ? (
            <div style={{ marginTop: 14, padding: '12px 14px', background: '#dcfce7', borderRadius: 12, color: '#166534', fontWeight: 600, fontSize: 14 }}>
              ✓ Exited at {fmtTime(exited)}
            </div>
          ) : (
            <button
              className="btn" style={{ marginTop: 16 }}
              onClick={markExited} disabled={exiting}
            >
              {exiting ? <span className="spin" /> : '🚪'} Mark as Exited
            </button>
          )}
        </div>
      )}

      {!sale && !loading && (
        <div className="empty">
          <div className="ic">🚧</div>
          <p>Enter a receipt number to verify</p>
        </div>
      )}
    </div>
  );
}
