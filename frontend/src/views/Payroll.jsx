import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today, getToken, downloadFile } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Kpansia B80 · Okutukutu B40" — the per-site split behind a worker's bag total.
const siteSplitLabel = (bySite) => (bySite || []).map((s) => {
  const parts = [];
  if (s.loaded > 0) parts.push(`L${s.loaded}`);
  if (s.bagged > 0) parts.push(`B${s.bagged}`);
  return `${s.site_name} ${parts.join('/')}`;
}).join(' · ');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const eom = (y, m) => ymd(new Date(y, m, 0));
// Payroll cycle = 28th of previous month → 27th of current month. The "current"
// completed cycle ends on the 27th of this month once we're past the 27th,
// otherwise last month's 27th.
const fullMonthWindow = () => {
  const n = new Date();
  let ey = n.getFullYear(), em = n.getMonth(); // 0-based month
  if (n.getDate() <= 27) { em -= 1; if (em < 0) { em = 11; ey -= 1; } }
  const to = new Date(ey, em, 27);
  const from = new Date(ey, em - 1, 28);
  return { from: ymd(from), to: ymd(to) };
};
const dl = async (path, name) => {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) return; const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
};

// ── Advance / deduction entry ─────────────────────────────────────────────────
function AdvanceForm({ staff, onSaved, onClose }) {
  const { toast } = useStore();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!(+amount > 0)) return toast('Enter an amount', 'err');
    setSaving(true);
    try { await api(scoped('/payroll/advances'), { method: 'POST', body: { staff_id: staff.id, amount: +amount, reason, date } }); toast('Advance recorded ✓', 'ok'); onSaved && onSaved(); onClose(); }
    catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>Advance — {staff.full_name}</h3>
      <p className="sub">Deducted from their next payroll automatically.</p>
      <label className="fl">Amount (₦)</label>
      <input type="number" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <label className="fl">Date</label>
      <input type="date" className="input" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
      <label className="fl">Reason</label>
      <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="optional" />
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
      </div>
    </div>
  );
}

// ── Per-staff payslip detail + day-by-day breakdown (drill-down) ──────────────
function StaffPayDetail({ line, from, to, onDeduction, onClose }) {
  const [ded, setDed] = useState(line.deduction || 0);
  const [bd, setBd] = useState(null);
  const ids = (line.member_ids && line.member_ids.length ? line.member_ids : [line.staff_id]).join(',');
  const piece = (line.pay_type || '').toUpperCase() === 'PIECE';
  useEffect(() => {
    api(scoped(`/payroll/staff-detail?ids=${encodeURIComponent(ids)}&from=${from}&to=${to}`))
      .then(setBd).catch(() => setBd({ days: [], production: [] }));
  }, []);
  const net = Math.max(0, (line.gross || 0) - (+ded || 0));
  const row = (k, v) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ color: 'var(--muted)', fontSize: 13 }}>{k}</span><strong style={{ fontSize: 13 }}>{v}</strong>
    </div>
  );
  return (
    <div className="modal-card" style={{ maxWidth: 460 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <strong style={{ fontSize: 16 }}>{line.full_name}</strong>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 10px' }} onClick={onClose}>✕</button>
      </div>
      {row('Pay type', line.pay_type || '—')}
      {(line.tenants?.length || (line.by_site?.length)) ? row('Sites', (line.by_site || []).map((s) => s.site_name).join(', ') || (line.tenants || []).length + ' tenant(s)') : null}
      {piece
        ? row('Bags', `${line.bags_loaded} loaded · ${line.bags_bagged} bagged`)
        : row('Days clocked-in', `${line.days_present} of ${line.period_days}`)}
      {row('Gross', ngn(line.gross))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>Deduction</span>
        <input type="number" className="input" style={{ width: 120, textAlign: 'right', padding: '6px 8px' }} value={ded} onChange={(e) => setDed(e.target.value)} />
      </div>
      {row('Net pay', ngn(net))}

      <div style={{ marginTop: 12, fontWeight: 700, fontSize: 13 }}>{piece ? 'Bags by day' : 'Days worked'}</div>
      {!bd ? <div className="skel" /> : piece ? (
        bd.production.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No bag records.</div> :
          bd.production.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{p.work_date} · {p.site_name}</span><span>L{p.bags_loaded} / B{p.bags_bagged}</span>
            </div>
          ))
      ) : (
        bd.days.length === 0 ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No clock-ins.</div> :
          bd.days.map((d, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{d.work_date}</span><span style={{ color: 'var(--muted)' }}>{d.site_name}</span>
            </div>
          ))
      )}
      <button className="btn" style={{ marginTop: 12 }} onClick={() => { onDeduction(+ded || 0); onClose(); }}>Done</button>
    </div>
  );
}

// ── Run: compute + save a payroll ─────────────────────────────────────────────
function RunTab({ sites, onSaved }) {
  const { toast, openModal, closeModal } = useStore();
  const now = new Date();
  const fm = fullMonthWindow();
  const [from, setFrom] = useState(fm.from);
  const [to, setTo] = useState(fm.to);
  const [site, setSite] = useState('');
  const [combined, setCombined] = useState(true); // Fido + Fiafia in one run
  const [lines, setLines] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [q, setQ] = useState('');

  const preset = (kind) => {
    const y = now.getFullYear(), m = now.getMonth() + 1, mm = String(m).padStart(2, '0');
    if (kind === 'mid') { setFrom(`${y}-${mm}-01`); setTo(`${y}-${mm}-15`); }
    else if (kind === 'second') { setFrom(`${y}-${mm}-16`); setTo(eom(y, m)); }
    else { const w = fullMonthWindow(); setFrom(w.from); setTo(w.to); } // full cycle = 28th→27th
  };
  const run = async () => {
    setBusy(true);
    try { const r = await api(scoped('/payroll/compute2'), { method: 'POST', body: { from, to, site: combined ? undefined : (site || undefined), combined } });
      setLines(r.lines.map((l) => ({ ...l, deduction: l.advance || 0 }))); }
    catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const setDedById = (id, v) => setLines((p) => p.map((l) => (l.staff_id === id ? { ...l, deduction: v } : l)));
  const net = (l) => Math.max(0, (l.gross || 0) - (+l.deduction || 0));
  const openDetail = (l) => openModal(
    <StaffPayDetail line={l} from={from} to={to} onClose={closeModal} onDeduction={(amt) => setDedById(l.staff_id, amt)} />);
  const summary = (l) => {
    const zero = (l.gross || 0) <= 0;
    if ((l.pay_type || '').toUpperCase() === 'PIECE') {
      const bags = `${l.bags_loaded} loaded · ${l.bags_bagged} bagged`;
      if (!l.bags_loaded && !l.bags_bagged) return 'no bags this period';
      return bags + (zero ? ' · set per-bag rate' : '');
    }
    if (!l.days_present) return 'no clock-ins this period';
    return `${l.days_present} day${l.days_present === 1 ? '' : 's'}${zero ? ' · set monthly salary' : ''}`;
  };
  const totGross = (lines || []).reduce((a, l) => a + (l.gross || 0), 0);
  const totNet = (lines || []).reduce((a, l) => a + net(l), 0);

  const save = async () => {
    if (!lines || !lines.length) return;
    setBusy(true);
    try {
      const deductions = {}; lines.forEach((l) => { deductions[l.staff_id] = +l.deduction || 0; });
      await api(scoped('/payroll/runs2'), { method: 'POST', body: { from, to, site: combined ? undefined : (site || undefined), deductions, combined } });
      toast('Payroll saved as draft ✓', 'ok'); setLines(null); onSaved && onSaved();
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => preset('mid')}>1–15</button>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => preset('second')}>16–end</button>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => preset('month')}>Full month</button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input type="date" className="input" style={{ flex: '1 1 120px' }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="input" style={{ flex: '1 1 120px' }} value={to} max={today()} onChange={(e) => setTo(e.target.value)} />
        {!combined && sites.length > 1 && (
          <select className="input" style={{ flex: '1 1 120px' }} value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <button className="btn" style={{ width: 'auto', padding: '8px 16px' }} onClick={run} disabled={busy}>{busy ? <span className="spin" /> : null} Compute</button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
        <input type="checkbox" checked={combined} onChange={(e) => setCombined(e.target.checked)} />
        Combined payroll (Fido + Fiafia in one run; same person merged)
      </label>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '6px 12px', marginBottom: 10 }}
        onClick={() => downloadFile(scoped(`/payroll/template.xlsx?from=${from}&to=${to}&combined=${combined ? 1 : 0}`), `payroll-${from}_${to}.xlsx`).catch((e) => toast(e.message || 'Download failed', 'err'))}>
        ⬇ Excel template (Regular / Baggers / Loaders)
      </button>

      {lines && (() => {
        const term = q.trim().toLowerCase();
        const match = (l) => !term || String(l.full_name || '').toLowerCase().includes(term);
        const paid = lines.filter((l) => (l.gross || 0) > 0 && match(l));
        const others = lines.filter((l) => (l.gross || 0) <= 0 && match(l));
        if (lines.length === 0) return <div className="empty"><div className="ic">💰</div><p>Nothing to pay</p></div>;
        const rowBtn = (l) => (
          <button key={l.staff_id} onClick={() => openDetail(l)}
            style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--line)', background: 'transparent', border: 'none', borderBottomStyle: 'solid', textAlign: 'left', cursor: 'pointer' }}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.full_name}</span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{summary(l)}</span>
            </span>
            <span style={{ textAlign: 'right', fontWeight: 800, whiteSpace: 'nowrap' }}>{ngn(net(l))} ›</span>
          </button>
        );
        return (
          <>
            <div className="card" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{paid.length} paid · Gross {ngn(totGross)}</span>
              <span style={{ fontWeight: 800 }}>Net {ngn(totNet)}</span>
            </div>
            <input className="input" style={{ margin: '8px 0' }} placeholder="Search staff by name…" value={q} onChange={(e) => setQ(e.target.value)} />
            {paid.length === 0
              ? <div className="empty"><div className="ic">💰</div><p>No one has pay this period. Set rates/salaries under Rates.</p></div>
              : <div className="card" style={{ padding: 0, overflow: 'hidden' }}>{paid.map(rowBtn)}</div>}

            {others.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '6px 12px' }} onClick={() => setShowOthers((v) => !v)}>
                  {showOthers ? '▾' : '▸'} Not paid this period ({others.length}) — review
                </button>
                {showOthers && <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 6 }}>{others.map(rowBtn)}</div>}
              </div>
            )}

            {paid.length > 0 && (
              <button className="btn" style={{ marginTop: 10 }} onClick={save} disabled={busy}>{busy ? <span className="spin" /> : '💾'} Save payroll (draft)</button>
            )}
          </>
        );
      })()}
    </div>
  );
}

// ── Runs: saved runs → approve → mark paid ────────────────────────────────────
function RunsTab() {
  const { tenant, toast } = useStore();
  const role = useRole();
  const isGM = role && atLeast(role, 'GENERAL_MANAGER');
  const [runs, setRuns] = useState([]);
  const [open, setOpen] = useState(null);   // run detail
  const [editLine, setEditLine] = useState(null); // line being adjusted
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);

  const importFile = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api(scoped(`/payroll/runs2/${open.id}/import`), { method: 'POST', form: fd });
      const fresh = await api(scoped(`/payroll/runs2/${open.id}`)); setOpen(fresh); load();
      toast(`Imported: ${r.updated} updated${r.unmatched?.length ? `, ${r.unmatched.length} unmatched ID(s)` : ''}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    setImporting(false);
  };

  const saveLine = async (patch) => {
    try {
      await api(scoped(`/payroll/runs2/${open.id}/lines/${editLine.id}`), { method: 'PATCH', body: patch });
      const fresh = await api(scoped(`/payroll/runs2/${open.id}`));
      setOpen(fresh); setEditLine(null); toast('Line updated ✓', 'ok'); load();
    } catch (e) { toast(e.message, 'err'); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try { setRuns(await api(scoped('/payroll/runs2'))); } catch { setRuns([]); }
    setLoading(false);
  }, [tenant]);
  useEffect(() => { load(); }, [load]);

  const view = async (id) => { try { setOpen(await api(scoped(`/payroll/runs2/${id}`))); } catch (e) { toast(e.message, 'err'); } };
  const setStatus = async (status) => {
    try { const r = await api(scoped(`/payroll/runs2/${open.id}/status`), { method: 'POST', body: { status } }); setOpen((o) => ({ ...o, ...r })); toast(`Marked ${status.toLowerCase()} ✓`, 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const badge = { DRAFT: '#f1f5f9', APPROVED: '#dbeafe', PAID: '#dcfce7' };

  if (loading) return <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      {runs.length === 0 ? <div className="empty"><div className="ic">🧾</div><p>No saved payroll runs</p></div> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {runs.map((r) => (
            <button key={r.id} onClick={() => view(r.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{r.period_from} → {r.period_to} <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: badge[r.status] || '#f1f5f9' }}>{r.status}</span></div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.site_name || 'All sites'} · net {ngn(r.total_net)}</div>
              </div>
              <span style={{ color: 'var(--muted)' }}>›</span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, margin: 0, maxHeight: '88vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{open.period_from} → {open.period_to}</strong>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: badge[open.status] }}>{open.status}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Gross {ngn(open.total_gross)} · deductions {ngn(open.total_deductions)} · net {ngn(open.total_net)}</div>
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
              {(open.lines || []).map((l) => (
                <button key={l.id} onClick={() => open.status === 'DRAFT' && setEditLine(l)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--line)', fontSize: 13, width: '100%', border: 'none', background: 'none', textAlign: 'left', cursor: open.status === 'DRAFT' ? 'pointer' : 'default' }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.remarks ? <span title={l.remarks} style={{ marginRight: 4 }}>ℹ️</span> : null}
                    {l.staff_name}<span style={{ color: 'var(--muted)' }}> · {l.pay_type === 'PIECE' ? `L${l.bags_loaded}/B${l.bags_bagged}` : `${l.days_present}d`}{l.deductions ? ` − ${ngn(l.deductions)}` : ''}</span>
                  </span>
                  <strong style={{ whiteSpace: 'nowrap' }}>{ngn(l.net)}{open.status === 'DRAFT' ? ' ›' : ''}</strong>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {open.status === 'DRAFT' && (
                <label className="btn btn-ghost" style={{ flex: 1, cursor: 'pointer', textAlign: 'center' }}>
                  {importing ? <span className="spin" /> : '⬆ Upload sheet'}
                  <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} disabled={importing}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importFile(f); }} />
                </label>
              )}
              {open.status === 'DRAFT' && <button className="btn" style={{ flex: 1 }} onClick={() => setStatus('APPROVED')}>Approve</button>}
              {open.status === 'APPROVED' && isGM && <button className="btn" style={{ flex: 1, background: '#16a34a' }} onClick={() => setStatus('PAID')}>Mark paid</button>}
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => dl(`/payroll/runs2/${open.id}/export.csv?tenant=${tenant}`, `payroll_${open.period_from}.csv`)}>⬇ CSV</button>
              {open.kind === 'MIDMONTH' && <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => dl(`/payroll/runs2/${open.id}/fido.csv?tenant=${tenant}`, `midmonth_${open.period_from}.csv`)}>⬇ Fido format</button>}
              <button className="btn btn-ghost" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => setOpen(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {editLine && (
        <LineEditor line={editLine} onClose={() => setEditLine(null)} onSave={saveLine} />
      )}
    </div>
  );
}

// Adjust one payslip line on a DRAFT run (deduction + bags/days). Shows the
// daily-recorded baseline so the accountant sees what they're overriding.
function LineEditor({ line, onClose, onSave }) {
  const piece = (line.pay_type || '').toUpperCase() === 'PIECE';
  const [ded, setDed] = useState(line.deductions || 0);
  const [loaded, setLoaded] = useState(line.bags_loaded || 0);
  const [bagged, setBagged] = useState(line.bags_bagged || 0);
  const [days, setDays] = useState(line.days_present || 0);
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
      <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 380, margin: 0 }}>
        <strong style={{ display: 'block', marginBottom: 8 }}>{line.staff_name}</strong>
        {piece ? (
          <>
            <label className="fl">Bags loaded <span style={{ color: 'var(--muted)' }}>(recorded {line.rec_loaded ?? '—'})</span></label>
            <input type="number" className="input" value={loaded} onChange={(e) => setLoaded(e.target.value)} />
            <label className="fl" style={{ marginTop: 8 }}>Bags bagged <span style={{ color: 'var(--muted)' }}>(recorded {line.rec_bagged ?? '—'})</span></label>
            <input type="number" className="input" value={bagged} onChange={(e) => setBagged(e.target.value)} />
          </>
        ) : (
          <>
            <label className="fl">Days worked <span style={{ color: 'var(--muted)' }}>(recorded {line.rec_days ?? '—'})</span></label>
            <input type="number" className="input" value={days} onChange={(e) => setDays(e.target.value)} />
          </>
        )}
        <label className="fl" style={{ marginTop: 8 }}>Deduction (₦)</label>
        <input type="number" className="input" value={ded} onChange={(e) => setDed(e.target.value)} />
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button className="btn" style={{ flex: 1 }} onClick={() => onSave(piece
            ? { bags_loaded: +loaded || 0, bags_bagged: +bagged || 0, deductions: +ded || 0 }
            : { days_present: +days || 0, deductions: +ded || 0 })}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── Mid-month: auto piece-worker payroll (1st–15th) from production ───────────
const thisMonth = () => today().slice(0, 7);
// Module-level (stable identity → no remount/flicker).
function PayrollSection({ title, rows, qtyLabel }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--line)', background: '#f8fafc' }}>
        <strong>{title} ({rows.length})</strong>
        <strong>{ngn(rows.reduce((a, l) => a + l.commission, 0))}</strong>
      </div>
      {rows.length === 0 ? <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)' }}>None with production this period</div>
        : rows.map((l) => (
          <div key={l.staff_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 14px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
            <span style={{ minWidth: 0, paddingRight: 8 }}>
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.full_name}<span style={{ color: 'var(--muted)' }}> · {l.location} · {qtyLabel} {l.qty.toLocaleString()}</span>
              </span>
              {(l.by_site || []).length > 1 && (
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{siteSplitLabel(l.by_site)}</span>
              )}
            </span>
            <strong>{ngn(l.commission)}</strong>
          </div>
        ))}
    </div>
  );
}

function MidMonthTab({ onSaved }) {
  const { tenant, toast } = useStore();
  useRole();
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const preview = useCallback(async () => {
    setLoading(true); setData(null);
    try { setData(await api(scoped(`/payroll/midmonth/preview?month=${month}`))); }
    catch (e) { toast(e.message || 'Could not preview', 'err'); }
    setLoading(false);
  }, [tenant, month]);
  useEffect(() => { preview(); }, [preview]);

  const generate = async () => {
    setBusy(true);
    try { const r = await api(scoped('/payroll/midmonth/generate'), { method: 'POST', body: { month } }); toast(`Mid-month draft saved (${r.count} staff) ✓`, 'ok'); onSaved && onSaved(); }
    catch (e) { toast(e.message || 'Generate failed', 'err'); }
    setBusy(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label className="fl">Month (pays 1st–15th)</label>
          <input type="month" className="input" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <button className="btn" style={{ width: 'auto', padding: '10px 16px' }} onClick={generate} disabled={busy || loading || !data || !data.count}>
          {busy ? <span className="spin" /> : '💾'} Save draft
        </button>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0, marginBottom: 12 }}>
        Built automatically from bags loaded/bagged × each worker's rate — no Excel upload. Save the draft, then approve & mark paid under <strong>Saved</strong>, and download the Fido-format CSV there.
      </p>

      {loading ? <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
        : !data ? null
          : (
            <>
              <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', marginBottom: 12 }}>
                <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{data.count} staff · {data.from} → {data.to}</span>
                <span style={{ fontWeight: 800, fontSize: 18 }}>{ngn(data.total)}</span>
              </div>
              <PayrollSection title="Baggers" rows={data.baggers} qtyLabel="bagged" />
              <PayrollSection title="Loaders" rows={data.loaders} qtyLabel="loaded" />
            </>
          )}
    </div>
  );
}

// ── Setup: pay rates + advances ───────────────────────────────────────────────
function SetupTab({ sites }) {
  const { tenant, toast, openModal, closeModal } = useStore();
  const [rows, setRows] = useState([]);
  const [site, setSite] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  // Shared per-bag rates (global, apply to ALL loaders/baggers across Fido+Fiafia).
  const [bag, setBag] = useState({ loaded: 0, bagged: 0 });
  const [bagBusy, setBagBusy] = useState(false);
  useEffect(() => { api(scoped('/payroll/bag-rates')).then(setBag).catch(() => {}); }, [tenant]);
  const saveBag = async () => {
    setBagBusy(true);
    try { setBag(await api(scoped('/payroll/bag-rates'), { method: 'PUT', body: { rate_loaded: +bag.loaded || 0, rate_bagged: +bag.bagged || 0 } })); toast('Per-bag rates saved ✓', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    setBagBusy(false);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try { const p = new URLSearchParams(); if (site) p.set('site', site); setRows(await api(scoped(`/payroll/pay-config?${p}`))); }
    catch { setRows([]); }
    setLoading(false);
  }, [tenant, site]);
  useEffect(() => { load(); }, [load]);

  const setVal = (i, k, v) => setRows((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async (r) => {
    try { await api(scoped(`/payroll/pay-config/${r.id}`), { method: 'PATCH', body: { pay_type: r.pay_type, daily_rate: +r.daily_rate || 0, rate_loaded: +r.rate_loaded || 0, rate_bagged: +r.rate_bagged || 0 } }); toast(`${r.full_name} saved ✓`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  if (loading) return <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <strong style={{ display: 'block', marginBottom: 2 }}>Per-bag rates (loaders & baggers)</strong>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Shared across Fido + Fiafia. Every loader/bagger is paid bags × this rate.</span>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}><label className="fl">₦ / bag loaded</label><input type="number" className="input" value={bag.loaded ?? 0} onChange={(e) => setBag((b) => ({ ...b, loaded: e.target.value }))} /></div>
          <div style={{ flex: 1 }}><label className="fl">₦ / bag bagged</label><input type="number" className="input" value={bag.bagged ?? 0} onChange={(e) => setBag((b) => ({ ...b, bagged: e.target.value }))} /></div>
          <button className="btn" style={{ width: 'auto', padding: '10px 16px' }} onClick={saveBag} disabled={bagBusy}>{bagBusy ? <span className="spin" /> : null} Save</button>
        </div>
      </div>
      {sites.length > 1 && (
        <select className="input" style={{ marginBottom: 12 }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <input className="input" style={{ marginBottom: 12 }} placeholder="Search staff by name…" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows.map((r, i) => ({ r, i }))
        .filter(({ r }) => !q.trim() || String(r.full_name || '').toLowerCase().includes(q.trim().toLowerCase()))
        .map(({ r, i }) => (
        <div key={r.id} className="card" style={{ padding: '10px 14px', marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong>{r.full_name}</strong>
            <select className="input" style={{ width: 'auto', padding: '4px 8px' }} value={r.pay_type || 'DAILY'} onChange={(e) => setVal(i, 'pay_type', e.target.value)}>
              <option value="DAILY">Daily (regular)</option>
              <option value="MONTHLY">Monthly (fixed salary)</option>
              <option value="PIECE">Piece (loader/bagger)</option>
            </select>
          </div>
          {r.pay_type === 'PIECE' ? (
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Paid by the shared per-bag rates above (all loaders one rate, all baggers one rate).</div>
          ) : r.pay_type === 'MONTHLY' ? (
            <div><label className="fl">Monthly salary (₦) — prorated by attendance</label><input type="number" className="input" value={r.daily_rate ?? 0} onChange={(e) => setVal(i, 'daily_rate', e.target.value)} /></div>
          ) : (
            <div><label className="fl">₦ / day present</label><input type="number" className="input" value={r.daily_rate ?? 0} onChange={(e) => setVal(i, 'daily_rate', e.target.value)} /></div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-sm" style={{ width: 'auto', padding: '4px 14px' }} onClick={() => save(r)}>Save</button>
            <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }} onClick={() => openModal(<AdvanceForm staff={r} onClose={closeModal} />)}>+ Advance</button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Payroll() {
  const { go, sites } = useStore();
  const role = useRole();
  const allowed = role && atLeast(role, 'SNR_ACCOUNTANT');
  const [tab, setTab] = useState('run');
  const [summary, setSummary] = useState(null);

  useEffect(() => { if (allowed && tab === 'history') api(scoped('/payroll/imported/summary')).then(setSummary).catch(() => {}); }, [allowed, tab]);

  if (!allowed) return <div className="empty"><div className="ic">🔒</div><p>Payroll is restricted to Senior Accountant, General Manager and Admin.</p></div>;

  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => go('more')}>← More</button>
      <div className="section-title" style={{ marginTop: 0 }}>Payroll</div>
      <div className="seg" style={{ marginBottom: 14, overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`seg-b${tab === 'run' ? ' on' : ''}`} onClick={() => setTab('run')}>🧮 Run</button>
        <button className={`seg-b${tab === 'mid' ? ' on' : ''}`} onClick={() => setTab('mid')}>📆 Mid-month</button>
        <button className={`seg-b${tab === 'runs' ? ' on' : ''}`} onClick={() => setTab('runs')}>🧾 Saved</button>
        <button className={`seg-b${tab === 'setup' ? ' on' : ''}`} onClick={() => setTab('setup')}>⚙️ Rates</button>
        <button className={`seg-b${tab === 'history' ? ' on' : ''}`} onClick={() => setTab('history')}>📜 History</button>
      </div>

      {tab === 'run' ? <RunTab sites={sites} onSaved={() => setTab('runs')} />
        : tab === 'mid' ? <MidMonthTab onSaved={() => setTab('runs')} />
        : tab === 'runs' ? <RunsTab />
          : tab === 'setup' ? <SetupTab sites={sites} />
            : !summary || !(summary.byMonth || []).length ? (
              <div className="empty"><div className="ic">📜</div><p>No imported payroll history</p></div>
            ) : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {summary.byMonth.map((m) => (
                  <div key={`${m.year}-${m.month}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--line)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700 }}>{MONTHS[+m.month] || m.month} {m.year}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.staff} staff · net {ngn(m.net)}</div>
                    </div>
                    <div style={{ fontWeight: 800 }}>{ngn(m.gross)}</div>
                  </div>
                ))}
              </div>
            )}
    </div>
  );
}
