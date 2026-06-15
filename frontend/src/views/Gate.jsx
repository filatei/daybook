/**
 * Gate.jsx — Barcode / receipt-number scan station
 *
 * Works for BOTH loading point and exit gate:
 *   PENDING  → "Mark as Loaded"   (loading point confirms goods handed over)
 *   LOADED   → "Mark as Exited"   (gate confirms truck/customer left premises)
 *   EXITED   → read-only summary
 *
 * Barcode scanners (USB/BT HID) work automatically — they type the number
 * + Enter into the auto-focused input.  Staff can also type manually.
 */
import React, { useState, useCallback, useRef, useEffect } from 'react';
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

const STATUS_CFG = {
  PENDING: { label: '⏳ PENDING',  bg: '#fef3c7', color: '#92400e' },
  LOADED:  { label: '📦 LOADED',   bg: '#dbeafe', color: '#1e40af' },
  EXITED:  { label: '✓ EXITED',   bg: '#dcfce7', color: '#166534' },
};

function saleStatus(sale) {
  if (sale?.exited_at) return 'EXITED';
  if (sale?.loaded_at) return 'LOADED';
  return 'PENDING';
}

export default function Gate() {
  const { tenant, toast } = useStore();
  const [query,   setQuery]   = useState('');
  const [sale,    setSale]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [acting,  setActing]  = useState(false);
  const inputRef = useRef(null);

  // Auto-focus so barcode scanner fires immediately
  useEffect(() => { inputRef.current?.focus(); }, []);
  // Re-focus after a sale is cleared
  const reset = () => { setQuery(''); setSale(null); setTimeout(() => inputRef.current?.focus(), 50); };

  const lookup = useCallback(async () => {
    const rn = query.trim();
    if (!rn) return;
    setLoading(true); setSale(null);
    try {
      const data = await api(scoped(`/pos/gate/${encodeURIComponent(rn)}`));
      setSale(data);
    } catch (e) {
      toast(e.message || 'Receipt not found', 'err');
      inputRef.current?.select();
    }
    setLoading(false);
  }, [query, tenant]);

  const markLoaded = useCallback(async () => {
    if (!sale) return;
    setActing(true);
    try {
      const data = await api(scoped(`/pos/sales/${sale.id}/loaded`), { method: 'POST', body: {} });
      setSale(data);
      toast('Marked as loaded ✓', 'ok');
    } catch (e) { toast(e.message || 'Error', 'err'); }
    setActing(false);
  }, [sale, tenant]);

  const markExited = useCallback(async () => {
    if (!sale) return;
    setActing(true);
    try {
      const data = await api(scoped(`/pos/sales/${sale.id}/exit`), { method: 'POST', body: {} });
      setSale(data);
      toast('Marked as exited ✓', 'ok');
    } catch (e) { toast(e.message || 'Error', 'err'); }
    setActing(false);
  }, [sale, tenant]);

  const items  = sale ? (sale.items || []) : [];
  const status = sale ? saleStatus(sale) : null;
  const cfg    = status ? STATUS_CFG[status] : null;

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>Scan / Verify Receipt</div>

      {/* Search bar — auto-focused for barcode scanner */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          ref={inputRef}
          className="input"
          type="number"
          inputMode="numeric"
          placeholder="Scan barcode or enter receipt number…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && lookup()}
          style={{ flex: 1, fontSize: 18, fontWeight: 700 }}
        />
        <button
          className="btn btn-sm" style={{ width: 52 }}
          onClick={lookup} disabled={loading || !query.trim()}
        >
          {loading
            ? <span className="spin" style={{ width: 14, height: 14, borderTopColor: '#fff' }} />
            : '🔍'}
        </button>
        {sale && <button className="btn btn-ghost btn-sm" onClick={reset}>✕</button>}
      </div>

      {/* Result card */}
      {sale && (
        <div className="card">
          {/* Header row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 28, letterSpacing: '-1px' }}>
                #{String(sale.receipt_no || '').padStart(4, '0')}
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
                {sale.sale_date} · {sale.site_name || '—'}
              </div>
            </div>
            <span style={{
              fontSize: 13, fontWeight: 700, padding: '6px 14px',
              borderRadius: 999, background: cfg.bg, color: cfg.color,
            }}>
              {cfg.label}
            </span>
          </div>

          {/* Customer */}
          {sale.customer_name && (
            <div style={{ marginBottom: 10, fontSize: 14 }}>
              👤 <strong>{sale.customer_name}</strong>
            </div>
          )}

          {/* Items */}
          {items.length > 0 && (
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 10, marginBottom: 10 }}>
              {items.map((it, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '7px 0', fontSize: 15, borderBottom: '1px solid var(--line)',
                }}>
                  <span style={{ fontWeight: 700 }}>
                    {it.name}
                    <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>× {it.qty}</span>
                  </span>
                  <span style={{ fontWeight: 700 }}>{ngn(it.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Total */}
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontWeight: 800, fontSize: 20, borderTop: '2px solid var(--ink)',
            paddingTop: 10, marginBottom: 4,
          }}>
            <span>TOTAL</span>
            <span>{ngn(sale.total)}</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 16 }}>
            {sale.payment_method}
          </div>

          {/* Timeline */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {sale.loaded_at && (
              <div style={{ fontSize: 13, padding: '8px 12px', background: '#dbeafe', borderRadius: 10, color: '#1e40af', fontWeight: 600 }}>
                📦 Loaded at {fmtTime(sale.loaded_at)}
              </div>
            )}
            {sale.exited_at && (
              <div style={{ fontSize: 13, padding: '8px 12px', background: '#dcfce7', borderRadius: 10, color: '#166534', fontWeight: 600 }}>
                🚪 Exited at {fmtTime(sale.exited_at)}
              </div>
            )}
          </div>

          {/* Action buttons */}
          {status === 'PENDING' && (
            <button className="btn" onClick={markLoaded} disabled={acting} style={{ background: '#1d4ed8' }}>
              {acting ? <span className="spin" /> : '📦'} Mark as Loaded
            </button>
          )}
          {status === 'LOADED' && (
            <button className="btn" onClick={markExited} disabled={acting}>
              {acting ? <span className="spin" /> : '🚪'} Mark as Exited
            </button>
          )}
          {status === 'EXITED' && (
            <button className="btn btn-ghost" onClick={reset} style={{ marginTop: 4 }}>
              Scan next receipt
            </button>
          )}
        </div>
      )}

      {!sale && !loading && (
        <div className="empty">
          <div className="ic">📷</div>
          <p>Scan receipt barcode or enter number</p>
        </div>
      )}
    </div>
  );
}
