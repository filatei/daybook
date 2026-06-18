import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, today, getToken } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d) => d.toISOString().slice(0, 10);
const eom = (y, m) => ymd(new Date(y, m, 0));
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

// ── Run: compute + save a payroll ─────────────────────────────────────────────
function RunTab({ sites, onSaved }) {
  const { toast } = useStore();
  const now = new Date();
  const [from, setFrom] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
  const [to, setTo] = useState(today());
  const [site, setSite] = useState('');
  const [lines, setLines] = useState(null);
  const [busy, setBusy] = useState(false);

  const preset = (kind) => {
    const y = now.getFullYear(), m = now.getMonth() + 1, mm = String(m).padStart(2, '0');
    if (kind === 'mid') { setFrom(`${y}-${mm}-01`); setTo(`${y}-${mm}-15`); }
    else if (kind === 'second') { setFrom(`${y}-${mm}-16`); setTo(eom(y, m)); }
    else { setFrom(`${y}-${mm}-01`); setTo(eom(y, m)); }
  };
  const run = async () => {
    setBusy(true);
    try { const r = await api(scoped('/payroll/compute2'), { method: 'POST', body: { from, to, site: site || undefined } });
      setLines(r.lines.map((l) => ({ ...l, deduction: l.advance || 0 }))); }
    catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };
  const setDed = (i, v) => setLines((p) => p.map((l, j) => (j === i ? { ...l, deduction: v } : l)));
  const net = (l) => Math.max(0, (l.gross || 0) - (+l.deduction || 0));
  const totGross = (lines || []).reduce((a, l) => a + (l.gross || 0), 0);
  const totNet = (lines || []).reduce((a, l) => a + net(l), 0);

  const save = async () => {
    if (!lines || !lines.length) return;
    setBusy(true);
    try {
      const deductions = {}; lines.forEach((l) => { deductions[l.staff_id] = +l.deduction || 0; });
      await api(scoped('/payroll/runs2'), { method: 'POST', body: { from, to, site: site || undefined, deductions } });
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
        {sites.length > 1 && (
          <select className="input" style={{ flex: '1 1 120px' }} value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <button className="btn" style={{ width: 'auto', padding: '8px 16px' }} onClick={run} disabled={busy}>{busy ? <span className="spin" /> : null} Compute</button>
      </div>

      {lines && (lines.length === 0 ? <div className="empty"><div className="ic">💰</div><p>Nothing to pay</p></div> : (
        <>
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>Gross {ngn(totGross)}</span>
            <span style={{ fontWeight: 800 }}>Net {ngn(totNet)}</span>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {lines.map((l, i) => (
              <div key={l.staff_id} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 80px', gap: 8, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.full_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{l.pay_type === 'PIECE' ? `L${l.bags_loaded}/B${l.bags_bagged}` : `${l.days_present}d`} · {ngn(l.gross)}</div>
                </div>
                <input type="number" className="input" style={{ padding: '6px 8px', textAlign: 'right' }} value={l.deduction} onChange={(e) => setDed(i, e.target.value)} title="Deduction" />
                <div style={{ textAlign: 'right', fontWeight: 700 }}>{ngn(net(l))}</div>
              </div>
            ))}
          </div>
          <button className="btn" style={{ marginTop: 10 }} onClick={save} disabled={busy}>{busy ? <span className="spin" /> : '💾'} Save payroll (draft)</button>
        </>
      ))}
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
  const [loading, setLoading] = useState(true);

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
                <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 12px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.staff_name}<span style={{ color: 'var(--muted)' }}> · {l.pay_type === 'PIECE' ? `L${l.bags_loaded}/B${l.bags_bagged}` : `${l.days_present}d`}{l.deductions ? ` − ${ngn(l.deductions)}` : ''}</span></span>
                  <strong>{ngn(l.net)}</strong>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              {open.status === 'DRAFT' && <button className="btn" style={{ flex: 1 }} onClick={() => setStatus('APPROVED')}>Approve</button>}
              {open.status === 'APPROVED' && isGM && <button className="btn" style={{ flex: 1, background: '#16a34a' }} onClick={() => setStatus('PAID')}>Mark paid</button>}
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => dl(`/payroll/runs2/${open.id}/export.csv?tenant=${tenant}`, `payroll_${open.period_from}.csv`)}>⬇ CSV</button>
              {open.kind === 'MIDMONTH' && <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => dl(`/payroll/runs2/${open.id}/fido.csv?tenant=${tenant}`, `midmonth_${open.period_from}.csv`)}>⬇ Fido format</button>}
              <button className="btn btn-ghost" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => setOpen(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
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
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>
              {l.full_name}<span style={{ color: 'var(--muted)' }}> · {l.location} · {qtyLabel} {l.qty.toLocaleString()}</span>
            </span>
            <strong>{ngn(l.commission)}</strong>
          </div>
        ))}
    </div>
  );
}

function MidMonthTab({ onSaved }) {
  const { tenant, toast } = useStore();
  const role = useRole();
  const isGM = role && atLeast(role, 'GENERAL_MANAGER');
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
  const [loading, setLoading] = useState(true);

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
      {sites.length > 1 && (
        <select className="input" style={{ marginBottom: 12 }} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      {rows.map((r, i) => (
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
            <div className="grid2">
              <div><label className="fl">₦ / bag loaded</label><input type="number" className="input" value={r.rate_loaded ?? 0} onChange={(e) => setVal(i, 'rate_loaded', e.target.value)} /></div>
              <div><label className="fl">₦ / bag bagged</label><input type="number" className="input" value={r.rate_bagged ?? 0} onChange={(e) => setVal(i, 'rate_bagged', e.target.value)} /></div>
            </div>
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
  const allowed = role && atLeast(role, 'ACCOUNTANT');
  const [tab, setTab] = useState('run');
  const [summary, setSummary] = useState(null);

  useEffect(() => { if (allowed && tab === 'history') api(scoped('/payroll/imported/summary')).then(setSummary).catch(() => {}); }, [allowed, tab]);

  if (!allowed) return <div className="empty"><div className="ic">🔒</div><p>Payroll is restricted to Accountants and above.</p></div>;

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
