import React, { useEffect, useState } from 'react';
import { api, scoped, ngn } from '../api.js';

const fmt = (at) => {
  if (!at) return '';
  try { return new Date(typeof at === 'number' ? at * 1000 : at).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

const Backdrop = ({ onClose, children, z = 120 }) => (
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: z, padding: 16 }}>
    <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, margin: 0, maxHeight: '88vh', overflowY: 'auto' }}>{children}</div>
  </div>
);

// Full order detail — customer, entry person, site, time, payment, line items.
export function OrderDetailModal({ order, orderId, onClose }) {
  const [o, setO] = useState(order || null);
  const [loading, setLoading] = useState(!order);
  useEffect(() => {
    if (order || !orderId) return;
    api(scoped(`/pos/orders/${orderId}`)).then(setO).catch(() => setO(null)).finally(() => setLoading(false));
  }, [order, orderId]);

  const Row = ({ k, v }) => v ? (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', fontSize: 13.5 }}>
      <span style={{ color: 'var(--muted)' }}>{k}</span><span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  ) : null;

  return (
    <Backdrop onClose={onClose} z={130}>
      {loading ? <div className="skel" style={{ height: 80 }} /> : !o ? (
        <div className="empty"><div className="ic">🧾</div><p>Order not found</p></div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <strong style={{ fontSize: 18 }}>{o.order_no ? `#${o.order_no}` : 'Order'}</strong>
            <strong style={{ fontSize: 18, color: 'var(--brand-d)' }}>{ngn(o.amount)}</strong>
          </div>
          <Row k="Customer" v={o.customer || 'Walk-in'} />
          <Row k="Entered by" v={o.entry_by} />
          <Row k="Site" v={o.site} />
          <Row k="Payment" v={o.payment_method} />
          <Row k="Time" v={fmt(o.at)} />
          {Array.isArray(o.items) && o.items.length > 0 && (
            <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', marginBottom: 4 }}>Items</div>
              {o.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                  <span>{it.name}{it.qty ? ` ×${it.qty}` : ''}</span>
                  <span style={{ fontWeight: 600 }}>{ngn(it.amount)}</span>
                </div>
              ))}
            </div>
          )}
          <button className="btn btn-ghost" style={{ marginTop: 14 }} onClick={onClose}>Close</button>
        </>
      )}
    </Backdrop>
  );
}

// Orders list for a filter (site/method/date range) → click a row for detail.
export function OrdersListModal({ title, query, onClose }) {
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(null);
  useEffect(() => { api(scoped(`/pos/orders?${query}`)).then(setRows).catch(() => setRows([])); }, [query]);

  return (
    <>
      <Backdrop onClose={onClose}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong>{title || 'Orders'}</strong>
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={onClose}>✕</button>
        </div>
        {rows === null ? <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
          : rows.length === 0 ? <div className="empty"><div className="ic">🧾</div><p>No orders</p></div>
            : rows.map((o) => (
              <button key={o.id} onClick={() => setSel(o)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{o.order_no ? `#${o.order_no}` : '—'} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>{o.customer || 'Walk-in'}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{o.payment_method}{o.entry_by ? ` · ${o.entry_by}` : ''} · {fmt(o.at)}</div>
                </div>
                <div style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{ngn(o.amount)}</div>
                <span style={{ color: 'var(--muted)' }}>›</span>
              </button>
            ))}
      </Backdrop>
      {sel && <OrderDetailModal order={sel} onClose={() => setSel(null)} />}
    </>
  );
}
