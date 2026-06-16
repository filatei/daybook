import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today, getToken } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const ST = {
  NOT_SEEN:  { bg: '#fee2e2', fg: '#991b1b', label: 'NOT SEEN' },
  SEEN:      { bg: '#fef3c7', fg: '#92400e', label: 'SEEN' },
  VALIDATED: { bg: '#dcfce7', fg: '#166534', label: 'VALIDATED' },
};
const when = (s) => new Date((s || 0) * 1000).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// ── Add / record a cash entry ───────────────────────────────────────────────
function CashForm({ sites, accounts, onSave, onClose }) {
  const { toast, tenant } = useStore();
  const [f, setF] = useState({ amount: '', depositor: '', site_id: sites[0]?.id || '', payee_account: '', memo: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!(parseFloat(f.amount) > 0)) return toast('Enter an amount', 'err');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('amount', f.amount);
      if (f.depositor) fd.append('depositor', f.depositor);
      if (f.site_id) fd.append('site_id', f.site_id);
      if (f.payee_account) fd.append('payee_account', f.payee_account);
      if (f.memo) fd.append('memo', f.memo);
      if (tenant) fd.append('tenant_id', tenant);
      if (file) fd.append('file', file);
      await api(scoped('/cash'), { method: 'POST', form: fd });
      toast('Cash recorded ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3>Add Cash Payment</h3>
      <label className="fl">Amount</label>
      <input type="number" inputMode="decimal" className="input" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0" autoFocus />
      <label className="fl">Depositor / agent</label>
      <input className="input" value={f.depositor} onChange={(e) => set('depositor', e.target.value)} placeholder="Who paid it in" />
      <div className="grid2">
        <div>
          <label className="fl">Site</label>
          <select className="input" value={f.site_id} onChange={(e) => set('site_id', e.target.value)}>
            <option value="">Select site</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="fl">Payee account (bank)</label>
          <input className="input" list="cash-accts" value={f.payee_account} onChange={(e) => set('payee_account', e.target.value)} placeholder="e.g. fidofluidsGTB" />
          <datalist id="cash-accts">{accounts.map((a) => <option key={a} value={a} />)}</datalist>
        </div>
      </div>
      <label className="fl">Note (optional)</label>
      <input className="input" value={f.memo} onChange={(e) => set('memo', e.target.value)} placeholder="reference / remark" />
      <label className="fl">Transfer receipt</label>
      <input type="file" accept="image/*,.pdf" capture="environment" onChange={(e) => setFile(e.target.files[0] || null)} style={{ fontSize: 13, width: '100%' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" style={{ flex: 1 }} onClick={submit} disabled={busy}>{busy ? <span className="spin" /> : 'Submit'}</button>
      </div>
    </div>
  );
}

// ── Cash detail — review (SEEN / VALIDATE) + receipts ───────────────────────
function CashDetail({ id, onChanged, onClose }) {
  const { toast } = useStore();
  const role = useRole();
  const canReview = role && atLeast(role, 'SNR_ACCOUNTANT');
  const canValidate = role && atLeast(role, 'ADMIN');
  const canDelete = role && atLeast(role, 'SITE_MANAGER');
  const [d, setD] = useState(null);
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await api(scoped(`/cash/${id}`))); } catch (e) { toast(e.message || 'Could not load', 'err'); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const act = async (path2, body, ok) => {
    setBusy(true);
    try { await api(scoped(`/cash/${id}/${path2}`), { method: 'POST', body }); toast(ok, 'ok'); load(); onChanged && onChanged(); }
    catch (e) { toast(e.message || 'Failed', 'err'); }
    setBusy(false);
  };
  const addReceipt = async () => {
    if (!file && !note.trim()) return toast('Attach a receipt or note', 'err');
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('file', file);
      if (note.trim()) fd.append('note', note.trim());
      await api(scoped(`/cash/${id}/attachments`), { method: 'POST', form: fd });
      setNote(''); setFile(null);
      const inp = document.getElementById('cash-att'); if (inp) inp.value = '';
      load(); toast('Receipt added ✓', 'ok');
    } catch (e) { toast(e.message || 'Upload failed', 'err'); }
    setBusy(false);
  };
  const openReceipt = async (a, dl) => {
    try {
      const res = await fetch(`/api/cash/${id}/attachments/${a.id}/file${dl ? '?download=1&' : '?'}tenant=${d.tenant_id || ''}`, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      if (dl) { const x = document.createElement('a'); x.href = url; x.download = a.file_name || 'receipt'; x.click(); } else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast('Could not open receipt', 'err'); }
  };
  const remove = async () => {
    if (!window.confirm('Delete this cash entry?')) return;
    try { await api(scoped(`/cash/${id}`), { method: 'DELETE' }); toast('Deleted', 'ok'); onChanged && onChanged(); onClose(); }
    catch (e) { toast(e.message || 'Could not delete', 'err'); }
  };

  if (!d) return <div><div className="grip" /><div className="skel" /><div className="skel" /></div>;
  const st = ST[d.status] || ST.NOT_SEEN;
  const fileIcon = (m) => (m || '').startsWith('image/') ? '🖼️' : (m || '').includes('pdf') ? '📄' : '📎';

  return (
    <div>
      <div className="grip" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Cash detail</h3>
        <span style={{ fontSize: 11, fontWeight: 800, padding: '3px 10px', borderRadius: 20, background: st.bg, color: st.fg }}>{st.label}</span>
        {canDelete && <button className="btn btn-ghost" style={{ width: 'auto', padding: '4px 8px', color: 'var(--err)' }} onClick={remove}>🗑</button>}
      </div>

      {(canReview || canValidate) && (
        <div style={{ display: 'flex', gap: 8, margin: '12px 0 4px', flexWrap: 'wrap' }}>
          {canReview && d.status !== 'VALIDATED' && (
            d.status === 'SEEN'
              ? <button className="btn btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={() => act('seen', { seen: false }, 'Marked not seen')}>Mark not seen</button>
              : <button className="btn btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={() => act('seen', { seen: true }, 'Marked seen ✓')}>✓ Mark seen</button>
          )}
          {canValidate && d.status !== 'VALIDATED' && (
            <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => act('validate', {}, 'Validated ✓')}>✓ Validate</button>
          )}
        </div>
      )}

      <div style={{ background: 'var(--bg)', borderRadius: 10, padding: 12, margin: '10px 0' }}>
        {[['Amount', ngn(d.amount)], ['Date', d.deposit_date], ['Site', d.site_name || '—'], ['Depositor', d.depositor || '—'], ['Payee account', d.payee_account || '—']].map(([k, v]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 14 }}>
            <span style={{ color: 'var(--muted)' }}>{k}</span><span style={{ fontWeight: 700 }}>{v}</span>
          </div>
        ))}
        {d.memo && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>{d.memo}</div>}
      </div>

      <div style={{ borderTop: '2px solid var(--line)', paddingTop: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>🧾 Transfer receipts <span style={{ color: 'var(--muted)', fontWeight: 600 }}>({(d.receipts || []).length})</span></div>
        {(d.receipts || []).map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <span style={{ fontSize: 18 }}>{fileIcon(a.mime)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {a.file_name && <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.file_name}</div>}
              {a.note && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{a.note}</div>}
            </div>
            {a.has_file && <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => openReceipt(a, false)}>View</button>}
            {a.has_file && <button className="btn btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => openReceipt(a, true)}>⬇</button>}
          </div>
        ))}
        {(d.receipts || []).length === 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>No receipts yet.</div>}
        <input id="cash-att" type="file" accept="image/*,.pdf" capture="environment" onChange={(e) => setFile(e.target.files[0] || null)} style={{ fontSize: 12, marginTop: 8, width: '100%' }} />
        <button className="btn" style={{ width: '100%', marginTop: 6 }} disabled={busy} onClick={addReceipt}>{busy ? <span className="spin" /> : '＋ Add receipt'}</button>
      </div>

      <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12 }} onClick={onClose}>Close</button>
    </div>
  );
}

export default function Cash() {
  const { openModal, closeModal, tenant, sites } = useStore();
  const role = useRole();
  const isAdminish = role && atLeast(role, 'SNR_ACCOUNTANT');
  const [data, setData] = useState({ rows: [], total: 0 });
  const [accounts, setAccounts] = useState([]);
  const [cashSales, setCashSales] = useState(null);   // today's CASH collected (reconcile)
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api(scoped('/cash'))); } catch { setData({ rows: [], total: 0 }); }
    setLoading(false);
  }, [tenant]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api(scoped('/cash/accounts')).then((a) => setAccounts(Array.isArray(a) ? a : [])).catch(() => {});
    if (isAdminish) {
      const t = today();
      api(scoped(`/pos/range?from=${t}&to=${t}`)).then((r) => setCashSales(r?.totals?.cash ?? null)).catch(() => setCashSales(null));
    }
  }, [tenant, isAdminish]);

  const openForm = () => openModal(<CashForm sites={sites} accounts={accounts} onSave={load} onClose={closeModal} />, { guard: true });
  const openDetail = (row) => openModal(<CashDetail id={row.id} onChanged={load} onClose={closeModal} />);

  const rows = (data.rows || []).filter((r) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return [r.depositor, r.site_name, r.payee_account, String(r.amount)].some((v) => (v || '').toString().toLowerCase().includes(s));
  });
  const variance = cashSales == null ? null : Math.round((Number(data.total) - Number(cashSales)) * 100) / 100;

  return (
    <div>
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>Cash recorded today</span>
        <span style={{ fontWeight: 800, fontSize: 20 }}>{ngn(data.total)}</span>
      </div>

      {isAdminish && cashSales != null && (
        <div className="card" style={{ display: 'flex', gap: 8, padding: 12, marginBottom: 12 }}>
          {[['Cash collected', cashSales], ['Recorded', data.total], ['Variance', variance]].map(([k, v]) => (
            <div key={k} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase' }}>{k}</div>
              <div style={{ fontWeight: 800, fontSize: 14, color: k === 'Variance' ? (Math.abs(v) < 1 ? 'var(--ok)' : 'var(--err)') : 'var(--ink)' }}>{ngn(v)}</div>
            </div>
          ))}
        </div>
      )}

      <input className="input" placeholder="🔍 search depositor / site / account" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />

      {loading ? (
        <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : rows.length === 0 ? (
        <div className="empty"><div className="ic">💵</div><p>No cash entries today</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((r) => {
            const st = ST[r.status] || ST.NOT_SEEN;
            return (
              <button key={r.id} onClick={() => openDetail(r)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 16 }}>{ngn(r.amount)}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {r.site_name || '—'}{r.depositor ? ` · by ${r.depositor}` : ''}{r.payee_account ? ` · ${r.payee_account}` : ''}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{when(r.created_at)}{r.receipts ? ` · 🧾${r.receipts}` : ''}</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: st.bg, color: st.fg }}>{st.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <button className="fab" onClick={openForm}>+</button>
    </div>
  );
}
