/**
 * Sell.jsx — Fido Water front-desk POS
 *
 * - Product grid (tap to add)
 * - Typed qty inputs for large quantities (not +/-)
 * - Payment: Cash / Transfer / POS terminal
 * - Cash: shows change calculation
 * - Bluetooth ESC/POS receipt printing (Xprinter + Epson TM)
 * - Idempotent via client_uid
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore } from '../store.jsx';
import { useBTPrinter } from '../hooks/useBTPrinter.js';

const PAY = ['CASH', 'TRANSFER', 'POS'];
const PAY_LABELS = { CASH: '💵 Cash', TRANSFER: '🏦 Transfer', POS: '💳 POS' };

const genUid = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : Math.random().toString(36).slice(2) + Date.now());

// ── Bluetooth status pill ─────────────────────────────────────────────────────
function BTPill({ status, error, onConnect, onDisconnect }) {
  const cfg = {
    idle:       { bg: '#f1f5f9', color: '#64748b', label: 'Connect Printer', icon: '🖨' },
    connecting: { bg: '#fef3c7', color: '#92400e', label: 'Connecting…',     icon: '⏳' },
    ready:      { bg: '#dcfce7', color: '#166534', label: 'Printer ready',   icon: '✓' },
    printing:   { bg: '#dbeafe', color: '#1e40af', label: 'Printing…',       icon: '🖨' },
    error:      { bg: '#fee2e2', color: '#dc2626', label: 'Retry connection', icon: '⚠️' },
  };
  const c = cfg[status] || cfg.idle;
  const isClickable = status === 'idle' || status === 'error';
  const isReady = status === 'ready';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {error && status === 'error' && (
        <span style={{ fontSize: 11, color: 'var(--err)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={error}>{error}</span>
      )}
      <button
        onClick={isReady ? onDisconnect : isClickable ? onConnect : undefined}
        disabled={status === 'connecting' || status === 'printing'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 999, border: 'none', background: c.bg, color: c.color, fontWeight: 700, fontSize: 12, cursor: isClickable || isReady ? 'pointer' : 'default' }}
      >
        <span>{c.icon}</span>
        <span>{c.label}</span>
      </button>
    </div>
  );
}

// ── Cart line ─────────────────────────────────────────────────────────────────
function CartLine({ line, onChange, onRemove }) {
  const { product, qty } = line;
  const lineTotal = (product.price || 0) * (parseFloat(qty) || 0);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 88px 28px', gap: 8, alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{product.name}</div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{ngn(product.price)} each</div>
      </div>
      <input
        type="number" min="0" inputMode="numeric"
        className="input"
        style={{ padding: '8px 10px', fontSize: 16, textAlign: 'center', fontWeight: 700 }}
        value={qty}
        onChange={(e) => onChange(product.id, e.target.value)}
        onFocus={(e) => e.target.select()}
      />
      <div style={{ fontWeight: 800, textAlign: 'right', fontSize: 14 }}>{ngn(lineTotal)}</div>
      <button
        onClick={() => onRemove(product.id)}
        style={{ width: 28, height: 28, border: 'none', background: '#fee2e2', color: 'var(--err)', borderRadius: 7, font: 'inherit', fontSize: 16, cursor: 'pointer', display: 'grid', placeItems: 'center' }}
      >×</button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Sell() {
  const { tenant, toast, tenants } = useStore();
  const activeTenant = (tenants || []).find((t) => String(t.id) === String(tenant));
  const bt = useBTPrinter();

  const [products,  setProducts]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [cart,      setCart]      = useState([]); // [{ product, qty: string }]
  const [custName,  setCustName]  = useState('');
  const [payMethod, setPayMethod] = useState('CASH');
  const [tendered,  setTendered]  = useState('');
  const [posting,   setPosting]   = useState(false);
  const [lastSale,  setLastSale]  = useState(null);
  const clientUid = useRef(genUid());

  // Load products
  const load = useCallback(async () => {
    setLoading(true);
    try { setProducts(await api(scoped('/products'))); } catch { setProducts([]); }
    setLoading(false);
  }, [tenant]);

  useEffect(() => { load(); }, [load]);

  // Derived
  const cartLines   = cart.filter((c) => parseFloat(c.qty) > 0);
  const subtotal    = cartLines.reduce((s, c) => s + (c.product.price || 0) * (parseFloat(c.qty) || 0), 0);
  const tenderedAmt = payMethod === 'CASH' ? (parseFloat(tendered) || 0) : subtotal;
  const change      = payMethod === 'CASH' ? Math.max(0, tenderedAmt - subtotal) : 0;
  const canCharge   = cartLines.length > 0 && !posting && (payMethod !== 'CASH' || tenderedAmt >= subtotal);

  const filtered = products.filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  // Cart actions
  const addProduct = (product) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => c.product.id === product.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: String(parseFloat(next[idx].qty || 0) + 1) };
        return next;
      }
      return [...prev, { product, qty: '1' }];
    });
  };

  const updateQty = (productId, val) => {
    if (val === '' || val === '0') {
      setCart((p) => p.filter((c) => c.product.id !== productId));
      return;
    }
    setCart((p) => p.map((c) => c.product.id === productId ? { ...c, qty: val } : c));
  };

  const removeItem = (productId) => {
    setCart((p) => p.filter((c) => c.product.id !== productId));
  };

  const newSale = () => {
    setCart([]); setCustName(''); setTendered('');
    setLastSale(null); setPayMethod('CASH');
    clientUid.current = genUid();
  };

  // Charge (and optionally print)
  const charge = async (withPrint = false) => {
    if (!canCharge) return;
    setPosting(true);
    try {
      const items = cartLines.map((c) => ({
        product_id: c.product.id,
        qty:        parseFloat(c.qty),
        price:      c.product.price,
      }));
      const sale = await api(scoped('/pos/sales'), {
        method: 'POST',
        body: {
          items,
          payment_method: payMethod,
          amount_paid: payMethod === 'CASH' ? tenderedAmt : subtotal,
          sale_date: today(),
          client_uid: clientUid.current,
          customer_name: custName.trim() || null,
        },
      });

      setLastSale(sale);

      if (withPrint && bt.status === 'ready') {
        const now = new Date();
        await bt.print({
          company:        activeTenant?.name || 'FIDO WATER',
          receipt_no:     sale.receipt_no,
          date_str:       now.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' }),
          time_str:       now.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }),
          items:          JSON.parse(sale.items_json || '[]'),
          total:          sale.total,
          payment_method: payMethod,
          amount_paid:    payMethod === 'CASH' ? tenderedAmt : sale.total,
          change:         payMethod === 'CASH' ? change : 0,
          customer_name:  custName.trim() || null,
        });
        toast(`Receipt #${sale.receipt_no} printed ✓`, 'ok');
      } else {
        toast(`Sale #${sale.receipt_no} saved ✓`, 'ok');
      }

      // Reset cart, new uid for next transaction
      setCart([]); setCustName(''); setTendered('');
      clientUid.current = genUid();
    } catch (e) {
      toast(e.message || 'Charge failed', 'err');
    }
    setPosting(false);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Top bar: title + BT status */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div className="section-title" style={{ margin: 0 }}>New Sale</div>
        <BTPill
          status={bt.status} error={bt.error}
          onConnect={bt.connect} onDisconnect={bt.disconnect}
        />
      </div>

      {/* Last sale banner */}
      {lastSale && (
        <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 12, padding: '10px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, color: '#166534', fontSize: 14 }}>
            ✓ Receipt #{lastSale.receipt_no} — {ngn(lastSale.total)}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={newSale}>New Sale</button>
        </div>
      )}

      {/* Customer name */}
      <input
        className="input" placeholder="Customer name (optional)"
        value={custName} onChange={(e) => setCustName(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      {/* Product search */}
      <input
        className="input" placeholder="Search products…"
        value={search} onChange={(e) => setSearch(e.target.value)}
        style={{ marginBottom: 10 }}
      />

      {/* Product grid */}
      {loading ? (
        <div className="skel" style={{ height: 160 }} />
      ) : filtered.length === 0 ? (
        <div className="empty">
          <div className="ic">🛒</div>
          <p>{products.length === 0 ? 'No products — add some in Admin' : 'No match'}</p>
        </div>
      ) : (
        <div className="prodgrid" style={{ marginBottom: 16 }}>
          {filtered.map((p) => (
            <button
              key={p.id} className="prodcard"
              onClick={() => addProduct(p)}
              disabled={p.track_stock && p.stock_qty === 0}
            >
              <div className="pn">{p.name}</div>
              <div className="pp">{ngn(p.price)}</div>
              {p.track_stock && (
                <div className={`ps${p.stock_qty === 0 ? ' out' : ''}`}>
                  {p.stock_qty === 0 ? 'Out of stock' : `${p.stock_qty} left`}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Order card */}
      {cart.length > 0 && (
        <div className="card" style={{ marginTop: 0 }}>
          {/* Cart header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <div style={{ fontWeight: 700 }}>Order</div>
            <button className="btn btn-ghost btn-sm" onClick={() => setCart([])}>Clear</button>
          </div>

          {/* Grid header */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 88px 28px', gap: 8, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', paddingBottom: 4 }}>
            <span>Product</span><span style={{ textAlign: 'center' }}>Qty</span><span style={{ textAlign: 'right' }}>Amount</span><span />
          </div>

          {/* Line items */}
          {cart.map((line) => (
            <CartLine key={line.product.id} line={line} onChange={updateQty} onRemove={removeItem} />
          ))}

          {/* Total */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, fontWeight: 800, fontSize: 22 }}>
            <span>Total</span>
            <span style={{ color: 'var(--brand-d)' }}>{ngn(subtotal)}</span>
          </div>

          {/* Payment method */}
          <div className="seg" style={{ marginTop: 14 }}>
            {PAY.map((m) => (
              <button key={m} className={`seg-b${payMethod === m ? ' on' : ''}`} onClick={() => setPayMethod(m)}>
                {PAY_LABELS[m]}
              </button>
            ))}
          </div>

          {/* Cash tendered */}
          {payMethod === 'CASH' && (
            <div style={{ marginTop: 10 }}>
              <label className="fl">Amount Tendered (₦)</label>
              <input
                type="number" inputMode="decimal" className="input"
                placeholder="0" value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                onFocus={(e) => e.target.select()}
              />
              {parseFloat(tendered) > 0 && (
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  marginTop: 10, padding: '10px 14px', borderRadius: 10,
                  background: tenderedAmt >= subtotal ? '#dcfce7' : '#fee2e2',
                }}>
                  <span style={{ fontWeight: 700, color: tenderedAmt >= subtotal ? '#166534' : '#dc2626' }}>
                    {tenderedAmt >= subtotal ? 'Change' : 'Short'}
                  </span>
                  <span style={{ fontWeight: 800, fontSize: 18, color: tenderedAmt >= subtotal ? '#166534' : '#dc2626' }}>
                    {tenderedAmt >= subtotal ? ngn(change) : ngn(subtotal - tenderedAmt)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Charge buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: bt.status === 'ready' ? '1fr 1.5fr' : '1fr', gap: 8, marginTop: 16 }}>
            {bt.status === 'ready' && (
              <button className="btn btn-ghost" onClick={() => charge(false)} disabled={!canCharge || posting}>
                {posting ? <span className="spin" /> : null} Charge only
              </button>
            )}
            <button className="btn" onClick={() => charge(bt.status === 'ready')} disabled={!canCharge || posting}>
              {posting ? <span className="spin" /> : (bt.status === 'ready' ? '🖨 ' : null)}
              {bt.status === 'ready' ? 'Charge & Print' : 'Charge'} {ngn(subtotal)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
