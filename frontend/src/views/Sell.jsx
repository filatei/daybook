import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore } from '../store.jsx';

export default function Sell() {
  const { tenant, toast } = useStore();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);   // { product, qty }
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setProducts(await api(scoped('/products'))); } catch { setProducts([]); }
    setLoading(false);
  }, [tenant]);

  useEffect(() => { load(); }, [load]);

  const addToCart = (product) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => c.product.id === product.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [...prev, { product, qty: 1 }];
    });
  };

  const setQty = (productId, qty) => {
    if (qty <= 0) { setCart((p) => p.filter((c) => c.product.id !== productId)); return; }
    setCart((p) => p.map((c) => c.product.id === productId ? { ...c, qty } : c));
  };

  const total = cart.reduce((s, c) => s + c.product.price * c.qty, 0);

  const checkout = async () => {
    if (!cart.length) return;
    setPosting(true);
    try {
      const lines = cart.map((c) => ({ product_id: c.product.id, qty: c.qty, unit_price: c.product.price }));
      await api(scoped('/pos/sales'), { method: 'POST', body: { lines, sale_date: today(), payment_method: 'cash' } });
      toast(`Sale recorded — ${ngn(total)}`, 'ok');
      setCart([]);
    } catch (e) { toast(e.message, 'err'); }
    setPosting(false);
  };

  const filtered = products.filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <input className="input" placeholder="Search products…" value={search}
        onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 12 }} />

      {loading ? (
        <div className="skel" style={{ height: 200 }} />
      ) : (
        <div className="prodgrid">
          {filtered.map((p) => (
            <button key={p.id} className="prodcard" onClick={() => addToCart(p)}
              disabled={p.stock_qty === 0}>
              <div className="pn">{p.name}</div>
              <div className="pp">{ngn(p.price)}</div>
              <div className={`ps${p.stock_qty === 0 ? ' out' : ''}`}>
                {p.stock_qty === 0 ? 'Out of stock' : `Stock: ${p.stock_qty}`}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="empty" style={{ gridColumn: '1/-1' }}>
              <div className="ic">🛒</div><p>No products</p>
            </div>
          )}
        </div>
      )}

      {/* Cart */}
      {cart.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="section-title" style={{ marginTop: 0 }}>Cart</div>
          {cart.map((c) => (
            <div key={c.product.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ flex: 1, fontWeight: 600 }}>{c.product.name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="qb" onClick={() => setQty(c.product.id, c.qty - 1)}>−</button>
                <span style={{ fontWeight: 700, minWidth: 20, textAlign: 'center' }}>{c.qty}</span>
                <button className="qb" onClick={() => setQty(c.product.id, c.qty + 1)}>+</button>
              </div>
              <div style={{ fontWeight: 800, minWidth: 70, textAlign: 'right' }}>{ngn(c.product.price * c.qty)}</div>
            </div>
          ))}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, fontWeight: 800, fontSize: 18 }}>
            <span>Total</span>
            <span style={{ color: 'var(--brand-d)' }}>{ngn(total)}</span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setCart([])}>Clear</button>
            <button className="btn" style={{ flex: 1 }} onClick={checkout} disabled={posting}>
              {posting ? <span className="spin" /> : null} Charge {ngn(total)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
