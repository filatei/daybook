/**
 * Products.jsx — product catalogue management for Manager+ (SITE_MANAGER and up).
 * Lets managers add products and edit prices (the default unit price), reusing
 * the same ProductForm + backend as the Admin → Products tab.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api, scoped, ngn } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';
import { ProductForm } from './Admin.jsx';

// Module-level (stable identity → no remount/flicker). onOpen passed as a prop.
function ProductRow({ p, dim, onOpen }) {
  return (
    <button onClick={() => onOpen(p)}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', opacity: dim ? 0.55 : 1 }}>
      <div className="av" style={{ fontSize: 20 }}>🛒</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>{p.name}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{ngn(p.price)}{p.unit ? ` · ${p.unit}` : ''}{p.category ? ` · ${p.category}` : ''}{p.track_stock ? ` · ${p.stock_qty} in stock` : ''}</div>
      </div>
      <span style={{ fontWeight: 800 }}>{ngn(p.price)}</span>
      <span style={{ color: 'var(--muted)' }}>›</span>
    </button>
  );
}

export default function Products() {
  const { openModal, closeModal, tenant } = useStore();
  const role = useRole();
  const canManage = role && atLeast(role, 'SITE_MANAGER');
  const [products, setProducts] = useState(null);

  const load = useCallback(async () => {
    try { setProducts(await api(scoped('/products'))); } catch { setProducts([]); }
  }, [tenant]);
  useEffect(() => { load(); }, [load]);

  const openForm = (product = null) => openModal(<ProductForm product={product} onSave={load} onClose={closeModal} />, { guard: true });

  if (!canManage) return <div className="empty"><div className="ic">🔒</div><p>You don't have access to manage products</p></div>;

  const active = (products || []).filter((p) => p.status !== 'INACTIVE');
  const inactive = (products || []).filter((p) => p.status === 'INACTIVE');


  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="section-title" style={{ margin: 0 }}>Products</div>
        <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 14px' }} onClick={() => openForm()}>＋ New</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0, marginBottom: 14 }}>
        Tap a product to edit its price and details. The price here is the default used at the till.
      </p>

      {products === null ? (
        <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : active.length === 0 ? (
        <div className="empty"><div className="ic">🛒</div><p>No products yet — add your first product</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {active.map((p) => <ProductRow key={p.id} p={p} onOpen={openForm} />)}
        </div>
      )}

      {inactive.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', margin: '18px 0 8px' }}>Inactive</div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {inactive.map((p) => <ProductRow key={p.id} p={p} dim onOpen={openForm} />)}
          </div>
        </>
      )}
    </div>
  );
}
