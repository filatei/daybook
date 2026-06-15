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
import { api, scoped, ngn, today, isNetErr } from '../api.js';
import { useStore } from '../store.jsx';
import { useBTPrinter } from '../hooks/useBTPrinter.js';
import { useRealtime } from '../hooks/useRealtime.js';
import Typeahead from '../components/Typeahead.jsx';
import ReceiptPreview from '../components/ReceiptPreview.jsx';
import { queueSale, syncOutbox, outboxCount } from '../offline.js';

const saleTime = (at) => { try { return new Date(typeof at === 'number' ? at * 1000 : at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const safeJson = (s, d = []) => { try { return JSON.parse(s || ''); } catch { return d; } };

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
  const { tenant, toast, tenants, user, sites } = useStore();
  const activeTenant = (tenants || []).find((t) => String(t.id) === String(tenant));
  // Cashier label: first name, else the part of the email before '@'.
  const servedBy = (user?.name && user.name.trim().split(/\s+/)[0]) || (user?.email ? user.email.split('@')[0] : null);
  const siteName = (sid) => (sites || []).find((s) => String(s.id) === String(sid))?.name || null;
  const bt = useBTPrinter();

  const [products,  setProducts]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [cart,      setCart]      = useState([]); // [{ product, qty: string }]
  const [custName,  setCustName]  = useState('');
  const [payMethod, setPayMethod] = useState('CASH');
  const [tendered,  setTendered]  = useState('');
  const [tenderedEdited, setTenderedEdited] = useState(false);  // tracks manual override
  const [posting,   setPosting]   = useState(false);
  const [lastSale,  setLastSale]  = useState(null);
  const [pending,   setPending]   = useState(outboxCount());
  const [online,    setOnline]    = useState(navigator.onLine);
  const clientUid = useRef(genUid());
  // Post-sale receipt prompt: holds the built receipt until the cashier okays the print.
  const [receipt, setReceipt] = useState(null);
  const [printingReceipt, setPrintingReceipt] = useState(false);
  const doPrint = async () => {
    if (!receipt) return;
    setPrintingReceipt(true);
    try {
      if (bt.status !== 'ready') await bt.connect();   // user gesture → pick/connect printer
      await bt.print(receipt);
      toast(`Receipt ${receipt.receipt_no === 'OFFLINE' ? '' : '#' + receipt.receipt_no} printed ✓`, 'ok');
      setReceipt(null);
    } catch (e) { toast(e.message || 'Print failed', 'err'); }
    setPrintingReceipt(false);
  };

  // ── Live "today's sales" ticker ────────────────────────────────────────────
  // Seeds with today's sales already on record, then prepends each new sale as
  // it happens (in-app sale.created + live fido.sale from the running POS).
  const [feed, setFeed] = useState([]);
  const seedFeed = useCallback(async () => {
    try { setFeed((await api(scoped('/pos/recent?limit=40'))).map((r) => ({ ...r, src: 'db' }))); } catch { /* not selected / offline */ }
  }, [tenant]);
  useEffect(() => { seedFeed(); }, [seedFeed]);
  // Testing: delete an in-app sale (GM only). Restores stock server-side.
  const [confirmDel, setConfirmDel] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const doDelete = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    try {
      await api(scoped(`/pos/sales/${confirmDel.id}`), { method: 'DELETE' });
      setFeed((f) => f.filter((x) => x.id !== confirmDel.id));
      toast('Sale deleted', 'ok');
      setConfirmDel(null);
    } catch (e) { toast(e.message || 'Delete failed', 'err'); }
    setDeleting(false);
  };
  const { connected: liveConnected } = useRealtime((evt) => {
    if (evt.type !== 'fido.sale' && evt.type !== 'sale.created') return;
    const p = evt.payload || {};
    setFeed((f) => [{
      id: `${evt.seq}-${Date.now()}`, receipt_no: p.receipt_no ?? null,
      site: p.site || '', customer: p.customer || null,
      amount: Number(p.amount ?? p.total ?? 0), payment_method: p.payment_method || '',
      at: p.at || Date.now(), _new: true,
    }, ...f].slice(0, 50));
  });
  const todayTotal = feed.reduce((a, s) => a + (Number(s.amount) || 0), 0);

  // Keep the offline queue badge in sync; flush on reconnect / mount.
  useEffect(() => {
    const refresh = () => setPending(outboxCount());
    const goOnline = () => { setOnline(true); syncOutbox().then(refresh); };
    const goOffline = () => setOnline(false);
    window.addEventListener('pos-outbox', refresh);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    syncOutbox().then(refresh);
    return () => { window.removeEventListener('pos-outbox', refresh); window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, []);
  const doSync = async () => { const n = await syncOutbox(); setPending(outboxCount()); if (n) toast(`Synced ${n} offline sale${n > 1 ? 's' : ''} ✓`, 'ok'); };

  // Customer typeahead: search existing customers, auto-create on charge
  const fetchCustomers = useCallback(async (q) => {
    const rows = await api(scoped(`/suggest/customers?q=${encodeURIComponent(q)}`));
    // backend may return { name, phone } (raw SQL) or { label, sub } (sales module)
    return rows.map((r) => ({ label: r.label || r.name, sub: r.sub || r.phone || '' }));
  }, [tenant]);

  // Product typeahead: search the catalogue server-side, add to cart on pick.
  const fetchProductOpts = useCallback(async (q) => {
    try {
      const rows = await api(scoped(`/products?q=${encodeURIComponent(q)}`));
      return rows.map((p) => ({ label: p.name, sub: `${ngn(p.price)}${p.category ? ' · ' + p.category : ''}`, product: p }));
    } catch { return []; }
  }, [tenant]);

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
  // Tendered defaults to the order total; the cashier can still type a different amount.
  useEffect(() => {
    if (payMethod === 'CASH' && !tenderedEdited) setTendered(subtotal ? String(subtotal) : '');
  }, [subtotal, payMethod, tenderedEdited]);
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
    setCart([]); setCustName(''); setTendered(''); setTenderedEdited(false);
    setLastSale(null); setPayMethod('CASH');
    clientUid.current = genUid();
  };

  // Charge (and optionally print)
  const charge = async (withPrint = false) => {
    if (!canCharge) return;
    setPosting(true);
    const items = cartLines.map((c) => ({
      product_id: c.product.id,
      qty:        parseFloat(c.qty),
      price:      c.product.price,
    }));
    const body = {
      items,
      payment_method: payMethod,
      amount_paid: payMethod === 'CASH' ? tenderedAmt : subtotal,
      sale_date: today(),
      client_uid: clientUid.current,
      customer_name: custName.trim() || null,
    };
    try {
      const sale = await api(scoped('/pos/sales'), { method: 'POST', body });

      setLastSale(sale);
      const now = new Date();
      const rdata = {
        company:        activeTenant?.name || 'FIDO WATER',
        site_name:      siteName(sale.site_id),
        receipt_no:     sale.receipt_no,
        date_str:       now.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' }),
        time_str:       now.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }),
        items:          safeJson(sale.items_json, []),
        total:          sale.total,
        payment_method: payMethod,
        amount_paid:    payMethod === 'CASH' ? tenderedAmt : sale.total,
        change:         payMethod === 'CASH' ? change : 0,
        customer_name:  custName.trim() || null,
        served_by:      servedBy,
      };

      if (withPrint && bt.status === 'ready') {
        await bt.print(rdata);
        toast(`Receipt #${sale.receipt_no} printed ✓`, 'ok');
      } else {
        // No silent print — prompt the cashier to send the receipt to the printer.
        toast(`Sale #${sale.receipt_no} saved ✓`, 'ok');
        setReceipt(rdata);
      }

      // Reset cart, new uid for next transaction
      setCart([]); setCustName(''); setTendered(''); setTenderedEdited(false);
      clientUid.current = genUid();
      seedFeed();   // refresh ticker so the new sale shows (and is deletable while testing)
    } catch (e) {
      if (isNetErr(e)) {
        // Offline: keep the sale in the local outbox (idempotent client_uid) and
        // give the cashier an optimistic receipt so selling never blocks.
        queueSale(tenant, body);
        setPending(outboxCount());
        const items_json = JSON.stringify(cartLines.map((c) => ({ product_id: c.product.id, name: c.product.name, qty: +c.qty, price: c.product.price, amount: +c.qty * c.product.price })));
        setLastSale({ pending: true, receipt_no: null, total: subtotal, items_json });
        const now = new Date();
        const rdata = {
          company: activeTenant?.name || 'FIDO WATER', site_name: siteName(activeTenant?.site_id), receipt_no: 'OFFLINE',
          date_str: now.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' }),
          time_str: now.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }),
          items: cartLines.map((c) => ({ name: c.product.name, qty: +c.qty, price: c.product.price, amount: +c.qty * c.product.price })),
          total: subtotal, payment_method: payMethod,
          amount_paid: payMethod === 'CASH' ? tenderedAmt : subtotal,
          change: payMethod === 'CASH' ? Math.max(0, tenderedAmt - subtotal) : 0,
          customer_name: custName.trim() || null,
          served_by: servedBy,
        };
        if (withPrint && bt.status === 'ready') {
          try { await bt.print(rdata); } catch { /* printer optional */ }
        } else {
          setReceipt(rdata);
        }
        toast('Offline — sale queued, will sync when back online ⚡', 'info');
        setCart([]); setCustName(''); setTendered(''); setTenderedEdited(false);
        clientUid.current = genUid();
      } else {
        toast(e.message || 'Charge failed', 'err');
      }
    }
    setPosting(false);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Offline / pending-sync pill */}
      {(!online || pending > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: online ? '#eff6ff' : '#fffbeb', border: `1px solid ${online ? '#bfdbfe' : '#fde68a'}`, borderRadius: 10, padding: '8px 12px', marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: online ? '#1e40af' : '#92400e' }}>
            {online ? `↻ ${pending} sale${pending > 1 ? 's' : ''} waiting to sync` : `⚡ Offline${pending > 0 ? ` · ${pending} queued` : ''}`}
          </span>
          {online && pending > 0 && <button className="btn btn-sm" style={{ width: 'auto', padding: '4px 12px' }} onClick={doSync}>Sync now</button>}
        </div>
      )}

      {/* Today's live sales ticker */}
      <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid #16a34a', paddingBottom: feed.length ? 6 : 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: liveConnected ? '#16a34a' : '#94a3b8', boxShadow: liveConnected ? '0 0 0 4px rgba(22,163,74,.18)' : 'none' }} />
            TODAY&apos;S SALES{liveConnected ? '' : ' (reconnecting…)'}
          </span>
          <span style={{ fontWeight: 800 }}>{ngn(todayTotal)} <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>· {feed.length}</span></span>
        </div>
        {feed.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>No sales yet today — waiting…</div>
        ) : (
          <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
            {feed.map((s) => (
              <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--line)', background: s._new ? 'rgba(22,163,74,.06)' : 'transparent' }}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>
                  <strong style={{ fontWeight: 700 }}>{s.customer || 'Walk-in'}</strong>
                  <span style={{ color: 'var(--muted)' }}>{s.site ? ` · ${s.site}` : ''}{s.payment_method ? ` · ${s.payment_method}` : ''} · {saleTime(s.at)}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 700 }}>{ngn(s.amount)}</span>
                  {s.src === 'db' && s.receipt_no != null && (
                    <button title="Delete sale (testing)" onClick={() => setConfirmDel(s)}
                      style={{ border: 'none', background: '#fee2e2', color: 'var(--err)', borderRadius: 6, width: 22, height: 22, fontSize: 13, cursor: 'pointer', lineHeight: 1, display: 'grid', placeItems: 'center' }}>🗑</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

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
        <div style={{ background: lastSale.pending ? '#fffbeb' : '#dcfce7', border: `1px solid ${lastSale.pending ? '#fde68a' : '#86efac'}`, borderRadius: 12, padding: '10px 14px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, color: lastSale.pending ? '#92400e' : '#166534', fontSize: 14 }}>
            {lastSale.pending ? `⚡ Saved offline — ${ngn(lastSale.total)} (syncs when online)` : `✓ Receipt #${lastSale.receipt_no} — ${ngn(lastSale.total)}`}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={newSale}>New Sale</button>
        </div>
      )}

      {/* Customer name — typeahead */}
      <Typeahead
        value={custName}
        onChange={setCustName}
        fetchFn={fetchCustomers}
        placeholder="Customer — type to search or add (blank = walk-in)"
        style={{ marginBottom: 12 }}
      />

      {/* Product search — typeahead: pick to add straight to the cart */}
      <Typeahead
        value={search}
        onChange={setSearch}
        onPick={(item) => { addProduct(item.product); setSearch(''); }}
        fetchFn={fetchProductOpts}
        placeholder="Search products…"
        minChars={1}
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
                onChange={(e) => { setTendered(e.target.value); setTenderedEdited(true); }}
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

      {/* Animated delete confirm (replaces browser alert) */}
      {confirmDel && (
        <div onClick={() => !deleting && setConfirmDel(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 320, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 30, marginBottom: 4 }}>🗑</div>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Delete sale {confirmDel.receipt_no ? `#${confirmDel.receipt_no}` : ''}?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 16px' }}>{ngn(confirmDel.amount)} · stock will be restored. This cannot be undone.</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDel(null)} disabled={deleting}>Cancel</button>
              <button className="btn" style={{ flex: 1, background: 'var(--err)' }} onClick={doDelete} disabled={deleting}>
                {deleting ? <span className="spin" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-sale receipt prompt — okay sending the receipt to the printer */}
      {receipt && (
        <div onClick={() => setReceipt(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 16 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 340, margin: 0, textAlign: 'center', maxHeight: '88vh', overflowY: 'auto' }}>
            <div style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600, marginBottom: 10 }}>Sale recorded ✓</div>
            <ReceiptPreview receipt={receipt} />
            <button className="btn" onClick={doPrint} disabled={printingReceipt} style={{ margin: '14px 0 8px' }}>
              {printingReceipt ? <span className="spin" /> : '🖨 '}
              {bt.status === 'ready' ? 'Print receipt' : 'Connect printer & print'}
            </button>
            <button className="btn btn-ghost" onClick={() => setReceipt(null)} disabled={printingReceipt}>
              Skip — no receipt
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
