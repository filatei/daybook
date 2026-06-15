import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const KIND_LABEL = { TRANSFER: 'Transfer', POS: 'POS/Card', CARD: 'Card', CASH_DEPOSIT: 'Cash deposit' };
const KIND_BADGE = { TRANSFER: '#0ea5e9', POS: '#7c3aed', CARD: '#7c3aed', CASH_DEPOSIT: '#16a34a' };
const STATUS_BADGE = { PENDING: ['#92400e', '#fef3c7'], CONFIRMED: ['#166534', '#dcfce7'], FLAGGED: ['#991b1b', '#fee2e2'] };

// ── Record a cash deposit ──────────────────────────────────────────────────────
function DepositForm({ sites, isGM, onSave, onClose }) {
  const { toast } = useStore();
  const [f, setF] = useState({ txn_date: today(), amount: '', account_name: '', bank: '', site_id: sites[0]?.id || '', ref: '' });
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    if (!(+f.amount > 0)) { toast('Enter an amount', 'err'); return; }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('kind', 'CASH_DEPOSIT');
      Object.entries(f).forEach(([k, v]) => v && fd.append(k, v));
      if (file) fd.append('image', file);
      await api(scoped('/reconciliations'), { method: 'POST', form: fd });
      toast('Deposit recorded ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>Record cash deposit</h3>
      <div className="grid2">
        <div><label className="fl">Date</label><input type="date" className="input" value={f.txn_date} max={today()} onChange={(e) => set('txn_date', e.target.value)} /></div>
        <div><label className="fl">Amount (₦)</label><input type="number" inputMode="decimal" className="input" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0" /></div>
      </div>
      {isGM && sites.length > 1 && (
        <><label className="fl">Site</label>
        <select className="input" value={f.site_id} onChange={(e) => set('site_id', e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></>
      )}
      <label className="fl">Depositor</label><input className="input" value={f.account_name} onChange={(e) => set('account_name', e.target.value)} placeholder="Who banked it" />
      <label className="fl">Bank / account</label><input className="input" value={f.bank} onChange={(e) => set('bank', e.target.value)} placeholder="e.g. GTB fidochem" />
      <label className="fl">Deposit slip (photo)</label>
      <input type="file" accept="image/*" className="input" onChange={(e) => setFile(e.target.files[0] || null)} />
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save deposit</button>
      </div>
    </div>
  );
}

export default function Reconcile() {
  const { openModal, closeModal, sites, tenant, toast } = useStore();
  const role = useRole();
  const isGM = atLeast(role, 'GENERAL_MANAGER');
  const isSM = role && !isGM;
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ from: '', to: '', kind: '', status: '', site: '' });

  const qs = useCallback(() => {
    const p = new URLSearchParams();
    ['from', 'to', 'kind', 'status', 'site'].forEach((k) => filters[k] && p.set(k, filters[k]));
    return p.toString();
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, sum] = await Promise.all([
        api(scoped(`/reconciliations?${qs()}`)),
        api(scoped(`/reconciliations/summary?${qs()}`)).catch(() => ({ byKind: [] })),
      ]);
      setRows(list); setSummary(sum.byKind || []);
    } catch { setRows([]); setSummary([]); }
    setLoading(false);
  }, [tenant, qs]);
  useEffect(() => { load(); }, [load]);

  const setStatus = async (r, status) => {
    try { await api(scoped(`/reconciliations/${r.id}`), { method: 'PATCH', body: { status } }); toast(`Marked ${status.toLowerCase()}`, 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const addDeposit = () => openModal(<DepositForm sites={sites} isGM={isGM} onSave={load} onClose={closeModal} />);

  return (
    <div>
      {/* Summary */}
      {summary.length > 0 && (
        <div className="stat-grid" style={{ marginBottom: 12 }}>
          {summary.map((k) => (
            <div className="stat" key={k.kind}>
              <div className="k">{KIND_LABEL[k.kind] || k.kind}</div>
              <div className="v" style={{ fontSize: 18 }}>{ngn(k.amount)}</div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>{k.pending} pending · {k.confirmed} ✓</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <input type="date" className="input" style={{ flex: '1 1 110px' }} value={filters.from} onChange={(e) => setFilters((p) => ({ ...p, from: e.target.value }))} />
        <input type="date" className="input" style={{ flex: '1 1 110px' }} value={filters.to} onChange={(e) => setFilters((p) => ({ ...p, to: e.target.value }))} />
        <select className="input" style={{ flex: '1 1 120px' }} value={filters.kind} onChange={(e) => setFilters((p) => ({ ...p, kind: e.target.value }))}>
          <option value="">All types</option><option value="TRANSFER">Transfer</option><option value="POS">POS/Card</option><option value="CASH_DEPOSIT">Cash deposit</option>
        </select>
        <select className="input" style={{ flex: '1 1 120px' }} value={filters.status} onChange={(e) => setFilters((p) => ({ ...p, status: e.target.value }))}>
          <option value="">Any status</option><option value="PENDING">Pending</option><option value="CONFIRMED">Confirmed</option><option value="FLAGGED">Flagged</option>
        </select>
        {!isSM && sites.length > 1 && (
          <select className="input" style={{ flex: '1 1 130px' }} value={filters.site} onChange={(e) => setFilters((p) => ({ ...p, site: e.target.value }))}>
            <option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : rows.length === 0 ? (
        <div className="empty"><div className="ic">🏦</div><p>No reconciliations found</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((r) => {
            const [fg, bg] = STATUS_BADGE[r.status] || STATUS_BADGE.PENDING;
            return (
              <div key={r.id} style={{ display: 'flex', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--line)', alignItems: 'flex-start' }}>
                <span style={{ width: 8, alignSelf: 'stretch', borderRadius: 4, background: KIND_BADGE[r.kind] || '#94a3b8', flex: '0 0 4px' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <b>{ngn(r.amount)}</b>
                    <span className="badge" style={{ color: fg, background: bg }}>{r.status}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                    {KIND_LABEL[r.kind] || r.kind} · {r.txn_date || '—'}{r.site_name ? ' · ' + r.site_name : ''}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {[r.account_name, r.bank, r.ref, r.customer_name].filter(Boolean).join(' · ') || '—'}
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 6, alignItems: 'center' }}>
                    {r.image && <a href={`/api/reconciliations/${r.id}/image`} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--brand-d)' }}>📎 proof</a>}
                    {isGM && r.status !== 'CONFIRMED' && <button className="btn btn-sm" onClick={() => setStatus(r, 'CONFIRMED')} style={{ width: 'auto', padding: '4px 10px' }}>Confirm</button>}
                    {isGM && r.status !== 'FLAGGED' && <button className="btn btn-ghost btn-sm" onClick={() => setStatus(r, 'FLAGGED')} style={{ width: 'auto', padding: '4px 10px', color: 'var(--err)' }}>Flag</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button className="fab" onClick={addDeposit}>+</button>
    </div>
  );
}
