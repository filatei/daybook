import React, { useEffect, useState } from 'react';
import { api, scoped, ngn } from '../api.js';

const toDate = (at) => {
  if (at == null || at === '') return null;
  const ms = typeof at === 'number' ? (at < 1e12 ? at * 1000 : at) : Date.parse(at);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
};
const WAT = 'Africa/Lagos';   // all order times are shown in West Africa Time
const fmt = (at) => {
  const d = toDate(at);
  return d ? d.toLocaleString('en-NG', { timeZone: WAT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
};
// Date only — falls back to a plain YYYY-MM-DD sale_date so legacy orders with no
// usable timestamp still show their day instead of nothing.
const fmtDate = (at, saleDate) => {
  const d = toDate(at) || (saleDate ? toDate(`${saleDate}T00:00:00`) : null);
  return d ? d.toLocaleDateString('en-NG', { timeZone: WAT, day: '2-digit', month: 'short', year: 'numeric' }) : (saleDate || '');
};
// Time only, in WAT (with the label so it's unambiguous). Empty when unknown.
const fmtTime = (at) => {
  const d = toDate(at);
  return d ? `${d.toLocaleTimeString('en-NG', { timeZone: WAT, hour: '2-digit', minute: '2-digit' })} WAT` : '';
};

const Backdrop = ({ onClose, children, z = 120 }) => (
  <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: z, padding: 16 }}>
    <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, margin: 0, maxHeight: '88vh', overflowY: 'auto' }}>{children}</div>
  </div>
);

// Module-level (stable identity → no remount/flicker).
function Row({ k, v }) {
  return v ? (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', fontSize: 13.5 }}>
      <span style={{ color: 'var(--muted)' }}>{k}</span><span style={{ fontWeight: 600, textAlign: 'right' }}>{v}</span>
    </div>
  ) : null;
}

// Full order detail — customer, entry person, site, time, payment, line items.
export function OrderDetailModal({ order, orderId, onClose }) {
  const [o, setO] = useState(order || null);
  const [loading, setLoading] = useState(!order);
  useEffect(() => {
    if (order || !orderId) return;
    api(scoped(`/pos/orders/${orderId}`)).then(setO).catch(() => setO(null)).finally(() => setLoading(false));
  }, [order, orderId]);

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
          <Row k="Terminal" v={o.terminal} />
          <Row k="Bank" v={o.bank} />
          <Row k="Date" v={fmtDate(o.at, o.sale_date)} />
          <Row k="Time" v={fmtTime(o.at)} />
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

// Non-cash sales grouped by OWNER (acquiring bank — GTB, Moniepoint, …) so the
// daybook reconciles per POS owner, summing across that owner's terminals.
// `query` carries the date-range (+ optional site) filter.
const ownerOf = (r) => r.bank || 'Unspecified';

// Aggregate raw /pos/banks rows (one per bank+terminal) into one row per owner.
function byOwner(list) {
  const m = {};
  for (const r of list) {
    const k = ownerOf(r);
    if (!m[k]) m[k] = { bank: r.bank || null, kind: r.kind, amount: 0, orders: 0, terminals: new Set() };
    m[k].amount += Number(r.amount) || 0;
    m[k].orders += Number(r.orders) || 0;
    if (r.terminal) m[k].terminals.add(r.terminal);
  }
  return Object.values(m)
    .map((g) => ({ ...g, terminals: g.terminals.size }))
    .sort((a, b) => b.amount - a.amount);
}

// Module-level (stable identity). Takes onPick as a prop instead of closing over it.
function BankGroup({ heading, list, icon, onPick }) {
  if (list.length === 0) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.5px', margin: '6px 0 2px' }}>{icon} {heading}</div>
      {list.map((r, i) => (
        <button key={i} onClick={() => onPick(r)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 4px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ownerOf(r)}</div>
            {r.terminals > 1 && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.terminals} terminals</div>}
          </div>
          <div style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
            <div style={{ fontWeight: 800 }}>{ngn(r.amount)}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.orders.toLocaleString()} ›</div>
          </div>
        </button>
      ))}
    </div>
  );
}

export function BankBreakdownModal({ title, query, tenants, onClose, onPick }) {
  const [rows, setRows] = useState(null);
  const tkey = Array.isArray(tenants) ? tenants.map((t) => t.id).join(',') : '';
  useEffect(() => {
    if (tkey) {
      Promise.all(tenants.map((t) => api(`/pos/banks?${query}&tenant=${t.id}`).catch(() => [])))
        .then((parts) => setRows(parts.flat()));
    } else {
      api(scoped(`/pos/banks?${query}`)).then(setRows).catch(() => setRows([]));
    }
  }, [query, tkey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pos = byOwner((rows || []).filter((r) => r.kind === 'POS'));
  const tr = byOwner((rows || []).filter((r) => r.kind === 'TRANSFER'));
  return (
    <Backdrop onClose={onClose}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>{title || 'POS by owner'}</strong>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={onClose}>✕</button>
      </div>
      {rows === null ? <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
        : rows.length === 0 ? <div className="empty"><div className="ic">💳</div><p>No transfer/POS sales in this period</p></div>
          : <><BankGroup heading="POS / Card by owner" list={pos} icon="💳" onPick={onPick} /><BankGroup heading="Transfers by bank" list={tr} icon="🏦" onPick={onPick} /></>}
    </Backdrop>
  );
}

// One order line. Module-level (stable identity → no remount/flicker).
function OrderRow({ o, onPick }) {
  return (
    <button onClick={() => onPick(o)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>{o.order_no ? `#${o.order_no}` : '—'} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>{o.customer || 'Walk-in'}</span></div>
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{o.payment_method}{o.entry_by ? ` · ${o.entry_by}` : ''}{o.at ? ` · ${fmt(o.at)}` : (o.sale_date ? ` · ${fmtDate(o.at, o.sale_date)}` : ' · no timestamp')}</div>
      </div>
      <div style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{ngn(o.amount)}</div>
      <span style={{ color: 'var(--muted)' }}>›</span>
    </button>
  );
}

// Group orders by site (and by workspace in the Group view, so two tenants with a
// same-named site never merge). Biggest site first.
function groupBySite(list) {
  const m = new Map();
  for (const o of list) {
    const site = o.site || 'Unspecified site';
    const key = o._tenant ? `${site} · ${o._tenant}` : site;
    if (!m.has(key)) m.set(key, { key, site, tenant: o._tenant || null, orders: [], amount: 0 });
    const g = m.get(key);
    g.orders.push(o);
    g.amount += Number(o.amount) || 0;
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount);
}

// Orders list for a filter (site/method/date range) → click a row for detail.
// Orders are folded by site (FAQ-style): tap a site to expand its orders.
export function OrdersListModal({ title, query, tenants, onClose }) {
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState('');
  const [showUndated, setShowUndated] = useState(false);   // hide timestamp-less orders by default
  const [openSites, setOpenSites] = useState({});          // site fold state (FAQ-style)
  // Group view → fetch each member workspace's orders and merge (tag the tenant).
  const tkey = Array.isArray(tenants) ? tenants.map((t) => t.id).join(',') : '';
  useEffect(() => {
    if (tkey) {
      Promise.all(tenants.map((t) => api(`/pos/orders?${query}&tenant=${t.id}`)
        .then((r) => (r || []).map((o) => ({ ...o, _tenant: t.name }))).catch(() => [])))
        .then((parts) => setRows(parts.flat().sort((a, b) => (b.at || 0) - (a.at || 0))));
    } else {
      api(scoped(`/pos/orders?${query}`)).then(setRows).catch(() => setRows([]));
    }
  }, [query, tkey]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = rows || [];
  const undatedCount = all.filter((o) => !o.at && !o.sale_date).length;
  const needle = q.trim().toLowerCase();
  const shown = all.filter((o) => {
    if (!showUndated && !o.at && !o.sale_date) return false;  // hide fully-undated unless toggled
    if (!needle) return true;
    return String(o.order_no || '').toLowerCase().includes(needle)
      || (o.customer || '').toLowerCase().includes(needle)
      || (o.entry_by || '').toLowerCase().includes(needle);
  });

  const groups = groupBySite(shown);
  // Folded by default. Auto-expand while searching (so matches aren't hidden) and
  // when there's only one site — nothing to choose between.
  const isOpen = (g) => !!needle || groups.length === 1 || !!openSites[g.key];

  return (
    <>
      <Backdrop onClose={onClose}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <strong>{title || 'Orders'}</strong>
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={onClose}>✕</button>
        </div>
        <input className="input" placeholder="Search order #, customer or cashier…" value={q}
          onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} autoFocus />
        {rows === null ? <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
          : all.length === 0 ? <div className="empty"><div className="ic">🧾</div><p>No orders</p></div>
            : (
              <>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                  {shown.length} shown{groups.length > 1 ? ` · ${groups.length} sites` : ''}
                </div>
                {groups.map((g) => {
                  const opened = isOpen(g);
                  return (
                    <div key={g.key}>
                      <button
                        onClick={() => setOpenSites((p) => ({ ...p, [g.key]: !opened }))}
                        aria-expanded={opened}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}
                      >
                        <span style={{ color: 'var(--muted)', display: 'inline-block', transform: opened ? 'rotate(90deg)' : 'none', transition: 'transform .18s' }}>›</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {g.site}
                            {g.tenant ? <span style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 600 }}> · {g.tenant}</span> : null}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{g.orders.length} order{g.orders.length > 1 ? 's' : ''}</div>
                        </div>
                        <div style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{ngn(g.amount)}</div>
                      </button>
                      {opened && (
                        <div style={{ paddingLeft: 14 }}>
                          {g.orders.map((o) => <OrderRow key={o.id} o={o} onPick={setSel} />)}
                        </div>
                      )}
                    </div>
                  );
                })}
                {shown.length === 0 && <div className="empty"><div className="ic">🔍</div><p>No match</p></div>}
                {undatedCount > 0 && (
                  <button className="btn btn-ghost btn-sm" style={{ marginTop: 10, width: '100%' }} onClick={() => setShowUndated((v) => !v)}>
                    {showUndated ? `Hide ${undatedCount} undated order${undatedCount > 1 ? 's' : ''}` : `Show ${undatedCount} undated order${undatedCount > 1 ? 's' : ''}`}
                  </button>
                )}
              </>
            )}
      </Backdrop>
      {sel && <OrderDetailModal order={sel} onClose={() => setSel(null)} />}
    </>
  );
}
