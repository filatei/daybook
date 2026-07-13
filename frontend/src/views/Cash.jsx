import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today, getToken } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';
import Typeahead from '../components/Typeahead.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

const ST = {
  NOT_SEEN:  { bg: '#fee2e2', fg: '#991b1b', label: 'NOT SEEN' },
  SEEN:      { bg: '#fef3c7', fg: '#92400e', label: 'SEEN' },
  VALIDATED: { bg: '#dcfce7', fg: '#166534', label: 'VALIDATED' },
};
const when = (s) => new Date((s || 0) * 1000).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// ── Add / record a cash entry ───────────────────────────────────────────────
function CashForm({ sites, accounts, onSave, onClose }) {
  const { toast, tenant, confirm } = useStore();
  const [f, setF] = useState({ amount: '', depositor: '', site_id: sites[0]?.id || '', payee_account: '', memo: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!(parseFloat(f.amount) > 0)) return toast('Enter an amount', 'err');
    if (!await confirm({ title: 'Record this cash deposit?', message: `${ngn(parseFloat(f.amount) || 0)}${f.payee_account ? ` → ${f.payee_account}` : ''}`, confirmText: 'Record' })) return;
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
      <h3>Record cash deposit</h3>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px' }}>
        Cash collected from customers that staff paid into the bank, or handed to a POS agent who transferred it to our account. Attach the transfer/deposit receipt.
      </p>
      <label className="fl">Amount</label>
      <input type="number" inputMode="decimal" className="input" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0" autoFocus />
      <label className="fl">Depositor / agent</label>
      <input className="input" value={f.depositor} onChange={(e) => set('depositor', e.target.value)} placeholder="Who paid it in" />
      <div className="grid2">
        <div>
          <label className="fl">Site</label>
          <SearchSelect value={f.site_id} onChange={(val) => set('site_id', val)} options={[{ value: '', label: 'Select site' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} placeholder="Select site" />
        </div>
        <div>
          <label className="fl">Payee account (bank)</label>
          <Typeahead
            value={f.payee_account}
            onChange={(v) => set('payee_account', v)}
            fetchFn={async (q) => accounts.filter((a) => a.toLowerCase().includes((q || '').toLowerCase())).map((a) => ({ label: a }))}
            minChars={0}
            placeholder={accounts.length ? 'Select bank account…' : 'No accounts set — ask an admin'}
          />
        </div>
      </div>
      <label className="fl">Note (optional)</label>
      <input className="input" value={f.memo} onChange={(e) => set('memo', e.target.value)} placeholder="reference / remark" />
      <label className="fl">Transfer receipt</label>
      <input type="file" accept="image/*,.pdf" capture="environment" onChange={(e) => setFile(e.target.files[0] || null)} style={{ fontSize: 13, width: '100%' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn" style={{ flex: 1 }} onClick={submit} disabled={busy || !((parseFloat(f.amount) || 0) > 0) || !f.payee_account.trim()}>{busy ? <span className="spin" /> : 'Submit'}</button>
      </div>
    </div>
  );
}

// ── Cash detail — review (SEEN / VALIDATE) + receipts ───────────────────────
function CashDetail({ id, tenantId, onChanged, onClose }) {
  const { toast, confirm } = useStore();
  // Pin to the deposit's workspace so review/validate works from the Group view.
  const ts = (path) => tenantId
    ? path + (path.includes('?') ? '&' : '?') + 'tenant=' + tenantId
    : scoped(path);
  const role = useRole();
  const canReview = role && atLeast(role, 'SNR_ACCOUNTANT');
  const canValidate = role && atLeast(role, 'ADMIN');
  const canDelete = role && atLeast(role, 'SITE_MANAGER');
  const [d, setD] = useState(null);
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await api(ts(`/cash/${id}`))); } catch (e) { toast(e.message || 'Could not load', 'err'); }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const act = async (path2, body, ok) => {
    setBusy(true);
    try { await api(ts(`/cash/${id}/${path2}`), { method: 'POST', body }); toast(ok, 'ok'); load(); onChanged && onChanged(); }
    catch (e) { toast(e.message || 'Failed', 'err'); }
    setBusy(false);
  };
  const addReceipt = async () => {
    if (!note.trim()) return toast('Write a note describing this receipt', 'err');
    setBusy(true);
    try {
      const fd = new FormData();
      if (file) fd.append('file', file);
      if (note.trim()) fd.append('note', note.trim());
      await api(ts(`/cash/${id}/attachments`), { method: 'POST', form: fd });
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
    if (!await confirm({ title: 'Delete this cash entry?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true })) return;
    try { await api(ts(`/cash/${id}`), { method: 'DELETE' }); toast('Deleted', 'ok'); onChanged && onChanged(); onClose(); }
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
        <textarea className="input" rows={2} placeholder="Note (required — e.g. GTB transfer, ref…)" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginTop: 6, resize: 'vertical' }} />
        <button className="btn" style={{ width: '100%', marginTop: 6 }} disabled={busy || !note.trim()} onClick={addReceipt}>{busy ? <span className="spin" /> : '＋ Add receipt'}</button>
      </div>

      <button className="btn btn-ghost" style={{ width: '100%', marginTop: 12 }} onClick={onClose}>Close</button>
    </div>
  );
}

export default function Cash() {
  const { openModal, closeModal, tenant, sites, isGroup, groupTenants } = useStore();
  const role = useRole();
  const isAdminish = role && atLeast(role, 'SNR_ACCOUNTANT');
  const [data, setData] = useState({ rows: [], total: 0 });
  const [accounts, setAccounts] = useState([]);
  const [cashSales, setCashSales] = useState(null);   // today's CASH collected (reconcile)
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const groupKey = groupTenants.map((t) => t.id).join(',');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (isGroup) {
        // Combined deposits across the member workspaces (read + review/validate).
        const parts = await Promise.all(groupTenants.map(async (t) => {
          try { const r = await api(`/cash?tenant=${t.id}`); return (r.rows || []).map((row) => ({ ...row, tenant_name: t.name })); }
          catch { return []; }
        }));
        const rows2 = parts.flat().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        setData({ rows: rows2, total: rows2.reduce((a, r) => a + Number(r.amount || 0), 0) });
      } else {
        setData(await api(scoped('/cash')));
      }
    } catch { setData({ rows: [], total: 0 }); }
    setLoading(false);
  }, [tenant, isGroup, groupKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (isGroup) return;   // recording + per-site reconcile happen inside a workspace
    api(scoped('/bank-accounts')).then((a) => setAccounts(Array.isArray(a) ? a.map((x) => x.label).filter(Boolean) : [])).catch(() => {});
    if (isAdminish) {
      const t = today();
      api(scoped(`/pos/range?from=${t}&to=${t}`)).then((r) => setCashSales(r?.totals?.cash ?? null)).catch(() => setCashSales(null));
    }
  }, [tenant, isAdminish, isGroup]);

  const openForm = () => openModal(<CashForm sites={sites} accounts={accounts} onSave={load} onClose={closeModal} />, { guard: true });
  const openDetail = (row) => openModal(<CashDetail id={row.id} tenantId={row.tenant_id} onChanged={load} onClose={closeModal} />);

  const rows = (data.rows || []).filter((r) => {
    if (!q) return true;
    const s = q.toLowerCase();
    return [r.depositor, r.site_name, r.payee_account, String(r.amount)].some((v) => (v || '').toString().toLowerCase().includes(s));
  });
  const variance = cashSales == null ? null : Math.round((Number(data.total) - Number(cashSales)) * 100) / 100;

  return (
    <div>
      {/* New deposits are recorded inside a workspace; Group is a combined review. */}
      {!isGroup && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button className="btn" style={{ flex: 1 }} onClick={openForm}>＋ Record</button>
        </div>
      )}

      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', marginBottom: 12 }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{isGroup ? 'Cash deposited (all sites)' : 'Cash deposited today'}</span>
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
                    {r.site_name || '—'}{isGroup && r.tenant_name ? ` · ${r.tenant_name}` : ''}{r.depositor ? ` · by ${r.depositor}` : ''}{r.payee_account ? ` · ${r.payee_account}` : ''}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{when(r.created_at)}{r.receipts ? ` · 🧾${r.receipts}` : ''}</div>
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: st.bg, color: st.fg }}>{st.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {!isGroup && <button className="fab" onClick={openForm}>+</button>}
    </div>
  );
}
