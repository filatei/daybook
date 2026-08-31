import React, { useEffect, useState, useCallback } from 'react';
import { api, scopedAny, ngn, today, getToken, downloadFile, isNetErr } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Kpansia B80 · Okutukutu B40" — the per-site split behind a worker's bag total.
const siteSplitLabel = (bySite) => (bySite || []).map((s) => {
  const parts = [];
  if (s.loaded > 0) parts.push(`L${s.loaded}`);
  if (s.bagged > 0) parts.push(`B${s.bagged}`);
  return `${s.site_name} ${parts.join('/')}`;
}).join(' · ');
const UNASSIGNED_SITE = 'Unassigned';
// Group-by-site uses the staff's home site, not where bags were recorded.
const groupSiteKey = (l) => {
  const ps = (l.primary_site_name || '').trim();
  if (ps && ps !== '—') return ps;
  const sn = (l.site_name || '').trim();
  if (sn && sn !== '—') return sn;
  return UNASSIGNED_SITE;
};
const sitesForSearch = (l) => {
  const out = new Set([groupSiteKey(l)]);
  (l.by_site || []).forEach((s) => { if (s.site_name && s.site_name !== '—') out.add(s.site_name); });
  return [...out];
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Full-month commission cycle: 28th of the previous month → 27th of this one. The
// "current" completed cycle ends on the 27th of this month once we're past the
// 27th, otherwise last month's 27th.
const fullMonthWindow = () => {
  const n = new Date();
  let ey = n.getFullYear(), em = n.getMonth(); // 0-based month
  if (n.getDate() <= 27) { em -= 1; if (em < 0) { em = 11; ey -= 1; } }
  const to = new Date(ey, em, 27);
  const from = new Date(ey, em - 1, 28);
  return { from: ymd(from), to: ymd(to) };
};
// Mid-month incentive cycle: 16th of the previous month → 15th of this one.
// Overlaps the full-month window on purpose — two payments, not one split cycle.
const midMonthWindow = () => {
  const n = new Date();
  let ey = n.getFullYear(), em = n.getMonth(); // 0-based month
  if (n.getDate() <= 15) { em -= 1; if (em < 0) { em = 11; ey -= 1; } }
  const to = new Date(ey, em, 15);
  const from = new Date(ey, em - 1, 16);
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
    try { await api(scopedAny('/payroll/advances'), { method: 'POST', body: { staff_id: staff.id, amount: +amount, reason, date } }); toast('Advance recorded ✓', 'ok'); onSaved && onSaved(); onClose(); }
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
    api(scopedAny(`/payroll/staff-detail?ids=${encodeURIComponent(ids)}&from=${from}&to=${to}`))
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
      {row('Primary site', bd ? (bd.primary_site || '—') : '…')}
      {(() => {
        if (!bd) return null;
        const all = Array.from(new Set([...(bd.days || []), ...(bd.production || [])].map((r) => r.site_name).filter(Boolean)));
        const others = all.filter((n) => n !== bd.primary_site);
        return others.length ? row('Also worked at', others.join(', ')) : null;
      })()}
      {piece
        ? row('Bags', `${line.bags_loaded} loaded · ${line.bags_bagged} bagged`)
        : row('Days clocked-in', `${line.days_present} of ${line.period_days}`)}
      {row('Gross', ngn(line.gross))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>Deduction</span>
        <input type="number" className="input" style={{ width: 120, textAlign: 'right', padding: '6px 8px' }} value={ded} onChange={(e) => setDed(e.target.value)} />
      </div>
      {row('Net pay', ngn(net))}

      {/* Without this, an overridden worker shows a big bag total up top and an
          empty day-by-day list below it, which reads as a bug or a missing
          payment rather than as "these came from the sheet". */}
      {bd?.override && (
        <div style={{ marginTop: 12, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, fontSize: 12 }}>
          <strong>📄 From the accountant&apos;s sheet</strong>
          <div style={{ color: 'var(--muted)', marginTop: 2 }}>
            {Number(bd.override.bags_loaded).toLocaleString()} loaded · {Number(bd.override.bags_bagged).toLocaleString()} bagged
            {bd.override.site_name ? ` · ${bd.override.site_name}` : ''} — for {bd.override.period_from} → {bd.override.period_to}.
            Daily records below are whatever the site itself entered, and are not what is being paid.
          </div>
        </div>
      )}

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
function StaffFromSheetNote({ staffFromSheet }) {
  if (!staffFromSheet?.created_count) return null;
  const list = staffFromSheet.created || [];
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: '#ecfdf5', border: '1px solid #6ee7b7', fontSize: 12.5 }}>
      <strong style={{ color: '#065f46' }}>
        Created {staffFromSheet.created_count} new staff from sheet
        {staffFromSheet.updated_count ? ` · ${staffFromSheet.updated_count} existing updated` : ''}
      </strong>
      <div style={{ color: '#047857', marginTop: 2 }}>
        They are linked to this upload — Generate payroll from sheet will include them in the bank file.
      </div>
      {list.slice(0, 12).map((u, i) => (
        <div key={`${u.id || u.name}-${i}`} style={{ fontSize: 12, marginTop: 2 }}>
          {u.name}{u.ext_people_id ? ` · ID ${u.ext_people_id}` : ''}
          {u.staff_type ? ` · ${u.staff_type}` : ''}
          {u.net ? ` · ${ngn(u.net)}` : ''}
        </div>
      ))}
      {list.length > 12 && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
          +{list.length - 12} more
        </div>
      )}
    </div>
  );
}

function UnmatchedSheetNote({ summary, compact }) {
  if (!summary?.unmatched_count) return null;
  return (
    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fcd34d', fontSize: 12.5 }}>
      <strong style={{ color: '#92400e' }}>
        {summary.unmatched_count} sheet row{summary.unmatched_count === 1 ? '' : 's'} still unmatched
        {summary.unmatched_net ? ` · ${ngn(summary.unmatched_net)} left out of the bank file` : ''}
      </strong>
      <div style={{ color: '#92400e', marginTop: 2 }}>
        Usually ambiguous names/IDs or missing Staff ID and name. Fix the roster or the sheet row, then re-upload.
      </div>
      {!compact && (summary.unmatched || []).slice(0, 12).map((u, i) => (
        <div key={`${u.name}-${i}`} style={{ fontSize: 12, marginTop: 2 }}>
          {u.name}{u.ext_people_id ? ` · ID ${u.ext_people_id}` : ''} · {ngn(u.net)}
        </div>
      ))}
      {!compact && summary.unmatched_count > 12 && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
          +{summary.unmatched_count - 12} more — Sheet history lists every row
        </div>
      )}
    </div>
  );
}

function RunTab({ sites, onSaved, onGenerated, onShowSheetHistory }) {
  const { toast, openModal, closeModal, isGroup } = useStore();
  const fm = fullMonthWindow();
  const [from, setFrom] = useState(fm.from);
  const [to, setTo] = useState(fm.to);
  const [site, setSite] = useState('');
  // In the Group roll-up the run is combined by definition — there is no single
  // workspace to fall back to, so the toggle is forced on and hidden.
  const [combinedRaw, setCombined] = useState(true); // Fido + Fiafia in one run
  const combined = isGroup ? true : combinedRaw;
  const [lines, setLines] = useState(null);
  // The override batch behind this period, if any — shown as a banner so the run
  // cannot be approved without knowing the bags came from a spreadsheet.
  const [override, setOverride] = useState(null);
  const [sheetUpload, setSheetUpload] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [showComparison, setShowComparison] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [q, setQ] = useState('');
  const [bySiteView, setBySiteView] = useState(false);
  const [openSites, setOpenSites] = useState({});
  // Mid-month pays per-bag commission only, so it lists baggers/loaders and
  // nothing else. Regular staff are on monthly salary and are paid at month-end.
  const [pieceOnly, setPieceOnly] = useState(false);

  const preset = (kind) => {
    // mid  = 16th prev → 15th, piece workers only, ₦1/bag incentive
    // month = 28th prev → 27th, everyone, ₦6/bag full commission
    const w = kind === 'mid' ? midMonthWindow() : fullMonthWindow();
    setFrom(w.from); setTo(w.to); setPieceOnly(kind === 'mid');
    setLines(null); setOverride(null); setSheetUpload(null); setComparison(null);
  };
  const fetchSheetUpload = useCallback(async (f, t, mid) => {
    if (!f || !t || mid) { setSheetUpload(null); return; }
    try {
      const p = new URLSearchParams({ period_from: f, period_to: t, kind: 'REGULAR' });
      const r = await api(scopedAny(`/payroll/sheet-upload?${p}`));
      setSheetUpload(r.upload
        ? { ...r.upload, sheet_summary: r.sheet_summary, totals: r.totals }
        : null);
    } catch { setSheetUpload(null); }
  }, []);
  useEffect(() => { fetchSheetUpload(from, to, pieceOnly); }, [from, to, pieceOnly, fetchSheetUpload]);
  const loadComparison = useCallback(async () => {
    if (!from || !to || !lines?.length) { setComparison(null); return; }
    try {
      const p = new URLSearchParams({ period_from: from, period_to: to, kind: pieceOnly ? 'MIDMONTH' : 'REGULAR' });
      if (combined) p.set('combined', '1');
      if (pieceOnly) p.set('piece_only', '1');
      setComparison(await api(scopedAny(`/payroll/compare?${p}`)));
    } catch { setComparison(null); }
  }, [from, to, lines, combined, pieceOnly]);
  useEffect(() => { if (lines?.length && sheetUpload) loadComparison(); else setComparison(null); }, [lines, sheetUpload, loadComparison]);
  // `err` is kept on screen. A toast alone is missed: a failed compute answers in
  // ~40ms, so the spinner never registers and the page looks like nothing happened.
  const [err, setErr] = useState(null);
  const run = async () => {
    if (!from || !to) return toast('Pick both dates first', 'err');
    if (from > to) return toast('“From” is after “To”', 'err');
    setBusy(true); setErr(null); setLines(null); setOverride(null); setComparison(null);
    try {
      const r = await api(scopedAny('/payroll/compute2'), { method: 'POST', body: { from, to, site: site || undefined, combined, piece_only: pieceOnly } });
      setLines(r.lines.map((l) => ({ ...l, deduction: l.advance || 0 })));
      setOverride(r.override || null);
      setSheetUpload(r.sheet_upload || null);
      if (!r.lines.length) toast('No one to pay for this period', 'err');
    } catch (e) {
      const msg = isNetErr(e) ? 'No connection — check your network and try again.' : (e.message || 'Compute failed');
      setErr(msg); toast(msg, 'err');
    }
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
      return bags + (zero ? ' · set the per-bag rate in Setup' : '');
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
      await api(scopedAny('/payroll/runs2'), { method: 'POST', body: { from, to, site: site || undefined, deductions, combined, piece_only: pieceOnly } });
      toast('Payroll saved as draft ✓', 'ok'); setLines(null); setOverride(null); onSaved && onSaved();
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => preset('mid')}>Mid-month incentive (16→15)</button>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => preset('month')}>Full month (28→27)</button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
        <input type="checkbox" checked={pieceOnly} onChange={(e) => { setPieceOnly(e.target.checked); setLines(null); setOverride(null); }} />
        Mid-month incentive — baggers &amp; loaders only, at the mid-month per-bag rate
      </label>
      {pieceOnly && (
        <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--bg-soft, #f4f6f8)', fontSize: 12, color: 'var(--muted)' }}>
          Pays the <b>mid-month incentive rate</b> for bags done 16th of last month → 15th of this one.
          Regular staff are excluded — they are on monthly salary and are paid in the month-end run; for one who needs
          money now, record a <b>salary advance</b> instead. The full ₦/bag commission is paid separately in the
          month-end run (28→27), which covers these bags again — that overlap is intended.
        </div>
      )}
      {!pieceOnly && (
        <div className="card" style={{ padding: '10px 12px', marginBottom: 10, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
          <strong style={{ display: 'block', marginBottom: 4 }}>Month-end bank file — same as mid-month</strong>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            1. Upload the accountant&apos;s Excel → 2. Generate payroll from sheet → 3. <b>Saved</b>: Approve → <b>Bank portal file</b>.
            The bank file uses the <b>uploaded</b> amounts. Computed figures are an optional check and do not need to match.
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input type="date" className="input" style={{ flex: '1 1 120px' }} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="input" style={{ flex: '1 1 120px' }} value={to} max={today()} onChange={(e) => setTo(e.target.value)} />
        {sites.length > 1 && (
          <SearchSelect style={{ flex: '1 1 120px' }} value={site} onChange={(val) => setSite(val)} options={[{ value: '', label: combined ? 'All sites (Fido + Fiafia)' : 'All sites' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} placeholder="All sites" />
        )}
        {pieceOnly && (
          <button className="btn" style={{ width: 'auto', padding: '8px 16px', minWidth: 116 }} onClick={run} disabled={busy}>
            {busy ? <><span className="spin" /> Computing…</> : 'Compute'}
          </button>
        )}
      </div>
      {/* Failures must stay on screen — a toast is gone before you look up. */}
      {err && (
        <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 8, background: '#fee2e2', color: '#991b1b', fontSize: 13 }}>
          <strong>Couldn’t compute payroll.</strong> {err}
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 10px', marginLeft: 8 }} onClick={run}>Retry</button>
        </div>
      )}
      {busy && <div className="skel" style={{ marginBottom: 10 }} />}
      {isGroup ? (
        <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
          🏢 Group run — every workspace in one payroll; the same person working across both is merged into one payslip.
        </div>
      ) : (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
          <input type="checkbox" checked={combined} onChange={(e) => setCombined(e.target.checked)} />
          Combined payroll (Fido + Fiafia in one run; same person merged)
        </label>
      )}
      {pieceOnly && (
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '6px 12px', marginBottom: 10 }}
          onClick={() => downloadFile(scopedAny(`/payroll/template.xlsx?from=${from}&to=${to}&combined=${combined ? 1 : 0}&piece_only=${pieceOnly ? 1 : 0}${site ? `&site=${site}` : ''}`), `${pieceOnly ? 'midmonth-payroll' : 'payroll'}-${from}_${to}.xlsx`).catch((e) => toast(e.message || 'Download failed', 'err'))}>
          ⬇ Excel template (Regular / Baggers / Loaders)
        </button>
      )}

      <OverrideBanner override={override} />

      <SheetUploadCard from={from} to={to} pieceOnly={pieceOnly} combined={combined} upload={sheetUpload}
        onUploaded={(r) => {
          setSheetUpload({
            id: r.id,
            file_name: r.file_name || r.upload?.file_name,
            line_count: r.line_count,
            uploaded_at: Math.floor(Date.now() / 1000),
            sheet_summary: r.sheet_summary,
            totals: r.totals,
            staff_from_sheet: r.staff_from_sheet || null,
          });
        }}
        onDeleted={() => { setSheetUpload(null); setComparison(null); }}
        onGenerated={(r) => { onGenerated ? onGenerated(r) : (onSaved && onSaved()); }}
        onCompare={() => setShowComparison(true)}
        onShowHistory={onShowSheetHistory} />

      {!pieceOnly && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600, marginBottom: 6 }}>
            Optional — preview computed from attendance (does not build the bank file)
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-ghost" style={{ width: 'auto', padding: '8px 16px' }} onClick={run} disabled={busy}>
              {busy ? <><span className="spin" /> Computing…</> : 'Preview computed'}
            </button>
            <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '6px 12px' }}
              onClick={() => downloadFile(scopedAny(`/payroll/template.xlsx?from=${from}&to=${to}&combined=${combined ? 1 : 0}&piece_only=0${site ? `&site=${site}` : ''}`), `payroll-${from}_${to}.xlsx`).catch((e) => toast(e.message || 'Download failed', 'err'))}>
              ⬇ Excel template
            </button>
          </div>
        </div>
      )}

      {lines && sheetUpload && comparison && (
        <div className="card" style={{ padding: '10px 12px', marginBottom: 10, background: '#f8fafc', border: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12.5 }}>
              <strong>Optional check — computed vs sheet</strong>
              <div style={{ color: 'var(--muted)', marginTop: 2 }}>
                Computed {ngn(comparison.totals?.computed?.net)} vs uploaded {ngn(comparison.totals?.uploaded?.net)}
                {comparison.sheet_summary?.unmatched_count
                  ? ` · bank file will pay matched ${ngn(comparison.sheet_summary.matched_net)}`
                  : ''}
                {' · '}{(comparison.diffs || []).filter((d) => Math.abs(d.delta) > 0.01).length} difference(s)
              </div>
              <div style={{ color: 'var(--muted)', marginTop: 2, fontSize: 12 }}>
                Totals do not need to match. Generate from sheet uses uploaded figures for the bank file.
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
              onClick={() => setShowComparison(true)}>View diff table</button>
          </div>
        </div>
      )}

      {showComparison && (
        <div onClick={() => setShowComparison(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()}>
            <PayrollComparison from={from} to={to} pieceOnly={pieceOnly} combined={combined} onClose={() => setShowComparison(false)} />
          </div>
        </div>
      )}

      {lines && (() => {
        if (lines.length === 0) return <div className="empty"><div className="ic">💰</div><p>Nothing to pay</p></div>;
        const term = q.trim().toLowerCase();
        // Search matches name OR primary site OR any work site the person bagged at.
        const match = (l) => !term
          || String(l.full_name || '').toLowerCase().includes(term)
          || sitesForSearch(l).join(' ').toLowerCase().includes(term);
        const paid = lines.filter((l) => (l.gross || 0) > 0 && match(l));
        const others = lines.filter((l) => (l.gross || 0) <= 0 && match(l));

        const rowBtn = (l) => {
          const site = groupSiteKey(l);
          const title = (l.role_title || l.pay_type || '').toString();
          const meta = [title, site !== UNASSIGNED_SITE ? site : null].filter(Boolean).join(' · ');
          return (
            <button key={l.staff_id} onClick={() => openDetail(l)}
              style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--line)', background: 'transparent', border: 'none', borderBottomStyle: 'solid', textAlign: 'left', cursor: 'pointer' }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.full_name}</span>
                {meta && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</span>}
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>{summary(l)}</span>
              </span>
              <span style={{ textAlign: 'right', fontWeight: 800, whiteSpace: 'nowrap' }}>{ngn(net(l))} ›</span>
            </button>
          );
        };

        // Distinct primary sites among paid rows (Unassigned last).
        const siteNames = Array.from(new Set(paid.map(groupSiteKey)))
          .sort((a, b) => (a === UNASSIGNED_SITE ? 1 : b === UNASSIGNED_SITE ? -1 : a.localeCompare(b)));
        const toggleSite = (s) => setOpenSites((o) => ({ ...o, [s]: !o[s] }));

        return (
          <>
            <div className="card" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
                {paid.length} paid · {siteNames.length} site{siteNames.length === 1 ? '' : 's'} · Gross {ngn(totGross)}
              </span>
              <span style={{ fontWeight: 800 }}>Net {ngn(totNet)}</span>
            </div>

            <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
              <input className="input" style={{ flex: '1 1 180px' }} placeholder="Search name or site (e.g. Mbiama)…" value={q} onChange={(e) => setQ(e.target.value)} />
              <button className={`btn btn-sm ${bySiteView ? '' : 'btn-ghost'}`} style={{ width: 'auto', padding: '8px 14px' }}
                onClick={() => { setBySiteView((v) => !v); if (!bySiteView) setOpenSites(Object.fromEntries(siteNames.map((s) => [s, true]))); }}>
                {bySiteView ? '✓ Grouped by site' : 'Group by site'}
              </button>
            </div>

            {bySiteView && paid.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }} onClick={() => setOpenSites(Object.fromEntries(siteNames.map((s) => [s, true])))}>Expand all</button>
                <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
                  onClick={() => setOpenSites(Object.fromEntries(siteNames.map((s) => [s, false])))}>Collapse all</button>
              </div>
            )}

            {paid.length === 0
              ? <div className="empty"><div className="ic">💰</div><p>{term ? `No paid staff match “${q}”.` : 'No one has pay this period. Set rates/salaries under Rates.'}</p></div>
              : bySiteView
                ? siteNames.map((s) => {
                  const rows = paid.filter((l) => groupSiteKey(l) === s);
                  const subtotal = rows.reduce((a, l) => a + net(l), 0);
                  // Absent key = open. Collapse all therefore has to write false
                  // for every site; clearing the object would re-open them all.
                  const open = openSites[s] ?? true;
                  return (
                    <div key={s} className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 10 }}>
                      <button onClick={() => toggleSite(s)}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', border: 'none', background: '#f8fafc', padding: '11px 14px', cursor: 'pointer', textAlign: 'left', borderBottom: open ? '1px solid var(--line)' : 'none' }}>
                        <strong>{open ? '▾' : '▸'} {s} <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {rows.length}</span></strong>
                        <strong>{ngn(subtotal)}</strong>
                      </button>
                      {open && rows.map(rowBtn)}
                    </div>
                  );
                })
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
function RunsTab({ initialOpenId, onConsumedOpenId }) {
  const { tenant, toast, confirm, sites } = useStore();
  const role = useRole();
  const isGM = role && atLeast(role, 'GENERAL_MANAGER');
  const [runs, setRuns] = useState([]);
  const [open, setOpen] = useState(null);   // run detail
  const [siteFilter, setSiteFilter] = useState('');
  const [bySiteView, setBySiteView] = useState(false);
  // Who in this run cannot be paid as recorded. Fetched alongside the run so
  // the warning is on screen BEFORE the accountant downloads and submits.
  const [bankCheck, setBankCheck] = useState(null);
  const [editLine, setEditLine] = useState(null); // line being adjusted
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [compareRun, setCompareRun] = useState(null);

  const importFile = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api(scopedAny(`/payroll/runs2/${open.id}/import`), { method: 'POST', form: fd });
      const fresh = await api(scopedAny(`/payroll/runs2/${open.id}`)); setOpen(fresh); load();
      toast(`Imported: ${r.updated} updated${r.unmatched?.length ? `, ${r.unmatched.length} unmatched ID(s)` : ''}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    setImporting(false);
  };

  const saveLine = async (patch) => {
    try {
      await api(scopedAny(`/payroll/runs2/${open.id}/lines/${editLine.id}`), { method: 'PATCH', body: patch });
      const fresh = await api(scopedAny(`/payroll/runs2/${open.id}`));
      setOpen(fresh); setEditLine(null); toast('Line updated ✓', 'ok'); load();
    } catch (e) { toast(e.message, 'err'); }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try { setRuns(await api(scopedAny('/payroll/runs2'))); } catch { setRuns([]); }
    setLoading(false);
  }, [tenant]);
  useEffect(() => { load(); }, [load]);

  const view = async (id) => {
    try {
      setBankCheck(null);
      setOpen(await api(scopedAny(`/payroll/runs2/${id}`)));
      api(scopedAny(`/payroll/runs2/${id}/bank-check`)).then(setBankCheck).catch(() => setBankCheck(null));
    } catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => {
    if (!initialOpenId) return;
    view(initialOpenId);
    onConsumedOpenId && onConsumedOpenId();
  }, [initialOpenId]);
  const setStatus = async (status) => {
    try { const r = await api(scopedAny(`/payroll/runs2/${open.id}/status`), { method: 'POST', body: { status } }); setOpen((o) => ({ ...o, ...r })); toast(`Marked ${status.toLowerCase()} ✓`, 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };

  // A draft freezes its figures at compute time — it does NOT pick up a later rate
  // change or staff correction. Recompute rebuilds it in place; delete throws it
  // away (needed when the PERIOD itself is wrong, which recompute keeps).
  const [acting, setActing] = useState(false);
  // Emailing is a deliberate act, confirmed, because it puts figures in front of
  // people who will act on them. It used to fire automatically on save.
  const sendEmail = async () => {
    const ok = await confirm({
      title: 'Email this run to the accountants?',
      message: `${open.period_from} → ${open.period_to} · ${(open.lines || []).length} staff · ${ngn(open.total_net)}. `
        + 'They will receive the summary and the Fido-format CSV.',
      confirmText: 'Send',
    });
    if (!ok) return;
    setActing(true);
    try {
      const r = await api(scopedAny(`/payroll/runs2/${open.id}/email`), { method: 'POST' });
      toast(r.recipients ? `Sent to ${r.recipients} ✓` : 'Sent ✓', 'ok');
    } catch (e) { toast(e.message || 'Could not send', 'err'); }
    setActing(false);
  };

  const recompute = async () => {
    setActing(true);
    try {
      const r = await api(scopedAny(`/payroll/runs2/${open.id}/recompute`), { method: 'POST' });
      const moved = ngn(r.total_gross - (r.was_gross || 0));
      toast(`Recomputed at ₦${r.rates?.bagged}/bag — ${r.count} staff, gross ${ngn(r.total_gross)} (${(r.total_gross - (r.was_gross || 0)) >= 0 ? '+' : ''}${moved})`, 'ok');
      await view(open.id); load();
    } catch (e) { toast(e.message || 'Recompute failed', 'err'); }
    setActing(false);
  };
  const del = async () => {
    const ok = await confirm({
      title: 'Delete this draft?',
      message: `${open.period_from} → ${open.period_to} · gross ${ngn(open.total_gross)}. Nothing is paid from a draft, so this is safe — rebuild it from the Run or Mid-month tab. Any advances it claimed are released.`,
      confirmText: 'Delete draft',
      danger: true,
    });
    if (!ok) return;
    setActing(true);
    try { await api(scopedAny(`/payroll/runs2/${open.id}`), { method: 'DELETE' }); toast('Draft deleted ✓', 'ok'); setOpen(null); load(); }
    catch (e) { toast(e.message || 'Delete failed', 'err'); }
    setActing(false);
  };
  const badge = { DRAFT: '#f1f5f9', APPROVED: '#dbeafe', PAID: '#dcfce7' };
  const visibleLines = (open?.lines || []).filter((l) => !siteFilter || groupSiteKey(l) === sites.find((s) => s.id === siteFilter)?.name);
  const siteNames = Array.from(new Set((open?.lines || []).map(groupSiteKey)))
    .sort((a, b) => (a === UNASSIGNED_SITE ? 1 : b === UNASSIGNED_SITE ? -1 : a.localeCompare(b)));

  if (loading && !open) return <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' }}>
        Same for mid-month and month-end: open the draft, Approve, then <b>Bank portal file</b>.
        A SHEET run pays the accountant&apos;s Excel (matched staff) — computed does not need to match.
      </p>
      {runs.length === 0 ? <div className="empty"><div className="ic">🧾</div><p>No saved payroll runs</p></div> : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {runs.map((r) => (
            <div key={r.id} onClick={() => view(r.id)} role="button" tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && view(r.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--line)', width: '100%', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{r.period_from} → {r.period_to} <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: badge[r.status] || '#f1f5f9' }}>{r.status}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: r.pay_source === 'SHEET' ? '#dbeafe' : '#f1f5f9', marginLeft: 4 }}>{r.pay_source === 'SHEET' ? 'SHEET' : 'COMPUTED'}</span>
                  {r.sheet_upload_id && r.pay_source !== 'SHEET' && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#e0e7ff', marginLeft: 4 }}>Sheet uploaded</span>}
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.site_name || 'All sites'} · net {ngn(r.total_net)}
                  {r.pay_source === 'SHEET'
                    ? <span style={{ marginLeft: 6 }}>· open → Bank portal file</span>
                    : (r.sheet_upload_id && (
                    <span className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '0 6px', marginLeft: 6, fontSize: 11, display: 'inline-block' }}
                      onClick={(e) => { e.stopPropagation(); setCompareRun(r); }} role="button" tabIndex={0}>Optional check vs computed</span>
                    ))}
                </div>
              </div>
              <span style={{ color: 'var(--muted)' }}>›</span>
            </div>
          ))}
        </div>
      )}

      {compareRun && (
        <div onClick={() => setCompareRun(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()}>
            <PayrollComparison from={compareRun.period_from} to={compareRun.period_to}
              pieceOnly={compareRun.kind === 'MIDMONTH'} combined onClose={() => setCompareRun(null)} />
          </div>
        </div>
      )}

      {open && (
        <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, margin: 0, maxHeight: '88vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{open.period_from} → {open.period_to}</strong>
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {open.pay_source === 'SHEET' && <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: '#dbeafe' }}>SHEET</span>}
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: badge[open.status] }}>{open.status}</span>
              </span>
            </div>
            {open.pay_source === 'SHEET' && (
              <div style={{ fontSize: 12.5, marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                📄 Paid from the accountant&apos;s sheet — same as mid-month: Approve, then download the <b>Bank portal file</b>.
                Computed figures do not need to match.
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>Gross {ngn(open.total_gross)} · deductions {ngn(open.total_deductions)} · net {ngn(open.total_net)}{open.site_name ? ` · ${open.site_name}` : ' · All sites'}</div>
            {open.pay_source === 'SHEET' && open.sheet_summary?.unmatched_count > 0 && (
              <UnmatchedSheetNote summary={open.sheet_summary} />
            )}
            {(sites.length > 1 || siteNames.length > 1) && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                {sites.length > 1 && (
                  <SearchSelect style={{ flex: '1 1 140px' }} value={siteFilter} onChange={setSiteFilter}
                    options={[{ value: '', label: 'All sites' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} placeholder="Filter by site" />
                )}
                <button className={`btn btn-sm ${bySiteView ? '' : 'btn-ghost'}`} style={{ width: 'auto', padding: '6px 12px' }} onClick={() => setBySiteView((v) => !v)}>
                  {bySiteView ? '✓ Grouped by site' : 'Group by site'}
                </button>
              </div>
            )}
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
              {/* Provenance survives to the saved run, and stays visible even if
                  the batch has since been removed — an approved payroll whose
                  numbers cannot be explained is the thing to avoid. */}
              {(open.override || open.override_removed) && (
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
                  <strong>📄 Paid from the accountant&apos;s sheet</strong>
                  <div style={{ color: 'var(--muted)' }}>
                    {open.override
                      ? `${open.override.matched} staff · ${open.override.file_name || 'uploaded sheet'}`
                      : 'The override batch behind this run has since been removed — recompute to rebuild it from recorded production.'}
                  </div>
                </div>
              )}
              {(bySiteView
                ? siteNames.filter((sn) => !siteFilter || sn === (sites.find((s) => s.id === siteFilter)?.name || sn)).map((sn) => {
                  const rows = visibleLines.filter((l) => groupSiteKey(l) === sn);
                  if (!rows.length) return null;
                  return (
                    <div key={sn}>
                      <div style={{ padding: '8px 12px', background: '#f8fafc', fontWeight: 700, fontSize: 12, borderBottom: '1px solid var(--line)' }}>{sn} · {rows.length}</div>
                      {rows.map((l) => (
                        <button key={l.id} onClick={() => open.status === 'DRAFT' && setEditLine(l)}
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--line)', fontSize: 13, width: '100%', border: 'none', background: 'none', textAlign: 'left', cursor: open.status === 'DRAFT' ? 'pointer' : 'default' }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {l.remarks ? <span title={l.remarks} style={{ marginRight: 4 }}>ℹ️</span> : null}
                            {l.bags_source === 'SHEET' ? <span title="Bags came from the accountant's sheet" style={{ marginRight: 4 }}>📄</span> : null}
                            {l.staff_name}<span style={{ color: 'var(--muted)' }}> · {l.pay_type === 'PIECE' ? `L${l.bags_loaded}/B${l.bags_bagged}` : `${l.days_present}d`}{l.deductions ? ` − ${ngn(l.deductions)}` : ''}</span>
                          </span>
                          <strong style={{ whiteSpace: 'nowrap' }}>{ngn(l.net)}{open.status === 'DRAFT' ? ' ›' : ''}</strong>
                        </button>
                      ))}
                    </div>
                  );
                })
                : visibleLines.map((l) => (
                <button key={l.id} onClick={() => open.status === 'DRAFT' && setEditLine(l)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '1px solid var(--line)', fontSize: 13, width: '100%', border: 'none', background: 'none', textAlign: 'left', cursor: open.status === 'DRAFT' ? 'pointer' : 'default' }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.remarks ? <span title={l.remarks} style={{ marginRight: 4 }}>ℹ️</span> : null}
                    {l.bags_source === 'SHEET' ? <span title="Bags came from the accountant's sheet, not recorded production" style={{ marginRight: 4 }}>📄</span> : null}
                    {l.staff_name}{(l.primary_site_name || l.site_name) ? <span style={{ color: 'var(--muted)' }}> · {l.primary_site_name || l.site_name}</span> : null}
                    <span style={{ color: 'var(--muted)' }}> · {l.pay_type === 'PIECE' ? `L${l.bags_loaded}/B${l.bags_bagged}` : `${l.days_present}d`}{l.deductions ? ` − ${ngn(l.deductions)}` : ''}</span>
                  </span>
                  <strong style={{ whiteSpace: 'nowrap' }}>{ngn(l.net)}{open.status === 'DRAFT' ? ' ›' : ''}</strong>
                </button>
              )))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button className="btn" style={{ flex: 1, ...(bankCheck?.at_risk ? { background: '#b45309' } : {}) }}
                onClick={() => downloadFile(scopedAny(`/payroll/runs2/${open.id}/bank.xlsx`), `bank_payment_${open.period_from}.xlsx`).catch((e) => toast(e.message || 'Download failed', 'err'))}
                title="Workbook for the bank payroll portal — same file mid-month uses">
                🏦 Bank portal file{bankCheck?.at_risk ? ` (${bankCheck.at_risk}⚠)` : ''}
              </button>
              {open.status === 'DRAFT' && <button className="btn" style={{ flex: 1 }} onClick={() => setStatus('APPROVED')}>Approve</button>}
              {open.status === 'APPROVED' && isGM && <button className="btn" style={{ flex: 1, background: '#16a34a' }} onClick={() => setStatus('PAID')}>Mark paid</button>}
              {open.status === 'DRAFT' && open.pay_source !== 'SHEET' && (
                <label className="btn btn-ghost" style={{ flex: 1, cursor: 'pointer', textAlign: 'center' }}>
                  {importing ? <span className="spin" /> : '⬆ Upload sheet'}
                  <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} disabled={importing}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importFile(f); }} />
                </label>
              )}
              {open.status === 'DRAFT' && open.pay_source !== 'SHEET' && (
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={recompute} disabled={acting}
                  title="Rebuild this draft from today’s rates and staff — same period">
                  {acting ? <span className="spin" /> : '↻'} Recompute
                </button>
              )}
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => dl(`/payroll/runs2/${open.id}/export.csv?tenant=${tenant}`, `payroll_${open.period_from}.csv`)}>⬇ CSV</button>
              {open.kind === 'MIDMONTH' && <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => dl(`/payroll/runs2/${open.id}/fido.csv?tenant=${tenant}`, `midmonth_${open.period_from}.csv`)}>⬇ Fido format</button>}
              {open.kind === 'MIDMONTH' && (
                <button className="btn btn-ghost" style={{ flex: 1 }} disabled={acting} onClick={sendEmail}
                  title="Email this run and the Fido CSV to the accountants — nothing is sent unless you press this">
                  {acting ? <span className="spin" /> : '✉️'} Send to accountants
                </button>
              )}
            </div>

            {bankCheck && bankCheck.at_risk > 0 && (
              <div className="card" style={{ padding: '10px 14px', marginTop: 10, background: '#fffbeb', border: '1px solid #fcd34d' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e' }}>
                  ⚠ {bankCheck.at_risk} of {bankCheck.payees} payees may be rejected by the bank
                  {bankCheck.at_risk_amount ? ` — ${ngn(bankCheck.at_risk_amount)} at risk` : ''}
                </div>
                <div style={{ fontSize: 11.5, color: '#92400e', marginTop: 3 }}>
                  The file still downloads with everyone in it. Fix these records and re-download,
                  or the bank will bounce those rows.
                </div>
                <div style={{ marginTop: 8, maxHeight: 190, overflowY: 'auto' }}>
                  {bankCheck.problems.map((p) => (
                    <div key={p.staff_id || p.name} style={{ fontSize: 12, padding: '4px 0', borderTop: '1px solid #fde68a' }}>
                      <strong>{p.name}</strong>
                      <span style={{ color: 'var(--muted)' }}>{p.site ? ` · ${p.site}` : ''} · {ngn(p.amount)}</span>
                      <div style={{ color: '#b45309' }}>{p.issues.join(' · ')}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {open.status === 'DRAFT' && (
                <button className="btn btn-ghost" style={{ width: 'auto', padding: '8px 12px', color: '#b91c1c' }} onClick={del} disabled={acting}
                  title="Throw this draft away — use when the period itself is wrong">🗑 Delete</button>
              )}
              <button className="btn btn-ghost" style={{ width: 'auto', padding: '8px 12px' }} onClick={() => setOpen(null)}>Close</button>
            </div>
            {open.status === 'DRAFT' && open.pay_source === 'SHEET' && (
              <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, marginBottom: 0 }}>
                This draft is the accountant&apos;s sheet. Approve, then download the <b>Bank portal file</b> (same as mid-month).
                To change figures, go to <b>Run</b>, re-upload, and Generate payroll from sheet again.
              </p>
            )}
            {open.status === 'DRAFT' && open.pay_source !== 'SHEET' && (
              <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8, marginBottom: 0 }}>
                A draft keeps the figures it was built with — it does not pick up a later rate change or staff correction.
                <b> Recompute</b> rebuilds it for the same period; <b>Delete</b> it and start again if the period itself is wrong.
              </p>
            )}
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

// ── Mid-month: auto piece-worker incentive (16th prev → 15th) from production ──
const thisMonth = () => today().slice(0, 7);

// Read-only payslip detail for a mid-month line: identity, bank, bags, per-site
// split, and the day-by-day production behind the total.
function MidMonthDetail({ line, from, to, onClose }) {
  const [bd, setBd] = useState(null);
  useEffect(() => {
    api(scopedAny(`/payroll/staff-detail?ids=${encodeURIComponent(line.staff_id)}&from=${from}&to=${to}`))
      .then(setBd).catch(() => setBd({ days: [], production: [] }));
  }, [line.staff_id]);
  const row = (k, v) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
      <span style={{ color: 'var(--muted)', fontSize: 13 }}>{k}</span><strong style={{ fontSize: 13, textAlign: 'right' }}>{v}</strong>
    </div>
  );
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
      <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, margin: 0, maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <strong style={{ fontSize: 16 }}>{line.full_name}</strong>
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 10px' }} onClick={onClose}>✕</button>
        </div>
        {row('Designation', (line.designation || '—').toString())}
        {row('Site', line.location || '—')}
        {line.ext_id ? row('Staff ID', line.ext_id) : null}
        {line.account ? row('Bank', line.account) : null}
        {row('Bags', `${(line.bags_loaded || 0).toLocaleString()} loaded · ${(line.bags_bagged || 0).toLocaleString()} bagged`)}
        {(line.by_site || []).length > 1 && row('By site', siteSplitLabel(line.by_site))}
        {row('Commission', ngn(line.commission))}

        <div style={{ marginTop: 12, fontWeight: 700, fontSize: 13 }}>Bags by day</div>
        {!bd ? <div className="skel" /> : (bd.production || []).length === 0
          ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>No day-by-day records.</div>
          : bd.production.map((p, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              <span>{p.work_date} · {p.site_name}</span><span>L{p.bags_loaded} / B{p.bags_bagged}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
// Module-level (stable identity → no remount/flicker).
// `flush` = rendered inside a SiteGroup, so drop the card chrome and shrink the header.
// `onRow` = open a detail view when a row is clicked.
function PayrollSection({ title, rows, qtyLabel, flush = false, onRow }) {
  return (
    <div className={flush ? '' : 'card'} style={{ padding: 0, overflow: 'hidden', marginBottom: flush ? 0 : 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: flush ? '7px 14px' : '10px 14px', borderBottom: '1px solid var(--line)', background: flush ? '#fbfdff' : '#f8fafc', fontSize: flush ? 12 : undefined, color: flush ? 'var(--muted)' : undefined }}>
        <strong>{title} ({rows.length})</strong>
        <strong>{ngn(rows.reduce((a, l) => a + l.commission, 0))}</strong>
      </div>
      {rows.length === 0 ? <div style={{ padding: 14, fontSize: 13, color: 'var(--muted)' }}>None with production this period</div>
        : rows.map((l) => (
          <button key={l.staff_id} onClick={() => onRow && onRow(l)}
            style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--line)', fontSize: 13, background: 'transparent', border: 'none', textAlign: 'left', cursor: onRow ? 'pointer' : 'default' }}>
            <span style={{ minWidth: 0, paddingRight: 8 }}>
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {l.full_name}<span style={{ color: 'var(--muted)' }}> · {(l.designation || '').toLowerCase()} · {l.location} · {qtyLabel} {l.qty.toLocaleString()}</span>
              </span>
              {(l.by_site || []).length > 1 && (
                <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{siteSplitLabel(l.by_site)}</span>
              )}
            </span>
            <strong style={{ whiteSpace: 'nowrap' }}>{ngn(l.commission)}{onRow ? ' ›' : ''}</strong>
          </button>
        ))}
    </div>
  );
}

// One collapsible site group: its baggers + loaders with a per-site subtotal.
function SiteGroup({ site, baggers, loaders, open, onToggle, onRow }) {
  const total = [...baggers, ...loaders].reduce((a, l) => a + l.commission, 0);
  const count = baggers.length + loaders.length;
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 10 }}>
      <button onClick={onToggle}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', border: 'none', background: '#f8fafc', padding: '11px 14px', cursor: 'pointer', textAlign: 'left', borderBottom: open ? '1px solid var(--line)' : 'none' }}>
        <strong>{open ? '▾' : '▸'} {site} <span style={{ color: 'var(--muted)', fontWeight: 600 }}>· {count} staff</span></strong>
        <strong>{ngn(total)}</strong>
      </button>
      {open && (
        <>
          {baggers.length > 0 && <PayrollSection title="Baggers" rows={baggers} qtyLabel="bagged" flush onRow={onRow} />}
          {loaders.length > 0 && <PayrollSection title="Loaders" rows={loaders} qtyLabel="loaded" flush onRow={onRow} />}
        </>
      )}
    </div>
  );
}

function MidMonthTab({ onSaved }) {
  const { tenant, toast, openModal, closeModal } = useStore();
  useRole();
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [bySite, setBySite] = useState(false);
  const [openSites, setOpenSites] = useState({});

  const preview = useCallback(async () => {
    setLoading(true); setData(null);
    try { setData(await api(scopedAny(`/payroll/midmonth/preview?month=${month}`))); }
    catch (e) { toast(e.message || 'Could not preview', 'err'); }
    setLoading(false);
  }, [tenant, month]);
  useEffect(() => { preview(); }, [preview]);

  const showDetail = (l) => openModal(<MidMonthDetail line={l} from={data?.from} to={data?.to} onClose={closeModal} />);

  const generate = async () => {
    setBusy(true);
    // No email on save. The draft goes to Saved, where there is a Send button.
    try { const r = await api(scopedAny('/payroll/midmonth/generate'), { method: 'POST', body: { month } }); toast(`Mid-month draft saved (${r.count} staff) — not emailed ✓`, 'ok'); onSaved && onSaved(); }
    catch (e) { toast(e.message || 'Generate failed', 'err'); }
    setBusy(false);
  };

  // Search filters on name OR primary site, so "mbiama" isolates that site's workers.
  const needle = q.trim().toLowerCase();
  const midSite = (l) => groupSiteKey({ primary_site_name: l.primary_site_name || l.location });
  const match = (l) => !needle || (l.full_name || '').toLowerCase().includes(needle) || midSite(l).toLowerCase().includes(needle);
  const baggers = (data?.baggers || []).filter(match);
  const loaders = (data?.loaders || []).filter(match);
  const shownTotal = [...baggers, ...loaders].reduce((a, l) => a + l.commission, 0);

  // Every primary site present in the result — grouping is by home site, not work site.
  const sites = Array.from(new Set([...baggers, ...loaders].map(midSite)))
    .sort((a, b) => (a === UNASSIGNED_SITE ? 1 : b === UNASSIGNED_SITE ? -1 : a.localeCompare(b)));
  const forSite = (rows, s) => rows.filter((l) => midSite(l) === s);
  const toggleSite = (s) => setOpenSites((o) => ({ ...o, [s]: !o[s] }));

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label className="fl">Month (pays 16th prev → 15th)</label>
          <input type="month" className="input" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value)} />
        </div>
        <button className="btn" style={{ width: 'auto', padding: '10px 16px' }} onClick={generate} disabled={busy || loading || !data || !data.count}>
          {busy ? <span className="spin" /> : '💾'} Save draft
        </button>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0, marginBottom: 12 }}>
        Baggers &amp; loaders across <strong>every workspace</strong> (Fido + Fiafia), paid at the mid-month incentive
        rate for bags done 16th of last month → 15th of this one. Built automatically from recorded production — no
        Excel upload. Save the draft, then approve under <strong>Saved</strong>, and download the
        <strong>Bank portal file</strong> (and Fido-format CSV) there. Saving does <strong>not</strong> email anyone — send it from <strong>Saved</strong>
        when the figures are agreed.
      </p>

      {loading ? <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
        : !data ? null
          : (
            <>
              <OverrideBanner override={data.override} />
              {/* Search + group toggle */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input className="input" style={{ flex: '1 1 180px' }} value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder="Search name or site (e.g. Mbiama)…" />
                <button className={`btn btn-sm ${bySite ? '' : 'btn-ghost'}`} style={{ width: 'auto', padding: '8px 14px' }}
                  onClick={() => { setBySite((v) => !v); if (!bySite) setOpenSites(Object.fromEntries(sites.map((s) => [s, true]))); }}>
                  {bySite ? '✓ Grouped by site' : 'Group by site'}
                </button>
              </div>

              <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', marginBottom: 12 }}>
                <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
                  {baggers.length + loaders.length}{needle ? ` of ${data.count}` : ''} staff · {sites.length} site{sites.length === 1 ? '' : 's'} · {data.from} → {data.to}
                </span>
                <span style={{ fontWeight: 800, fontSize: 18 }}>{ngn(shownTotal)}</span>
              </div>

              {bySite && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
                    onClick={() => setOpenSites(Object.fromEntries(sites.map((s) => [s, true])))}>Expand all</button>
                  <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
                    onClick={() => setOpenSites(Object.fromEntries(sites.map((s) => [s, false])))}>Collapse all</button>
                </div>
              )}

              {baggers.length + loaders.length === 0 ? (
                <div className="empty"><div className="ic">🔍</div><p>No baggers or loaders match “{q}”.</p></div>
              ) : bySite ? (
                sites.map((s) => (
                  <SiteGroup key={s} site={s} baggers={forSite(baggers, s)} loaders={forSite(loaders, s)}
                    open={openSites[s] ?? true} onToggle={() => toggleSite(s)} onRow={showDetail} />
                ))
              ) : (
                <>
                  <PayrollSection title="Baggers" rows={baggers} qtyLabel="bagged" onRow={showDetail} />
                  <PayrollSection title="Loaders" rows={loaders} qtyLabel="loaded" onRow={showDetail} />
                </>
              )}
            </>
          )}
    </div>
  );
}

// Side-by-side computed vs uploaded payroll comparison.
function PayrollComparison({ from, to, pieceOnly, combined, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const p = new URLSearchParams({ period_from: from, period_to: to, kind: pieceOnly ? 'MIDMONTH' : 'REGULAR' });
    if (combined) p.set('combined', '1');
    if (pieceOnly) p.set('piece_only', '1');
    api(scopedAny(`/payroll/compare?${p}`)).then(setData).catch((e) => setErr(e.message || 'Could not load comparison'));
  }, [from, to, pieceOnly, combined]);
  const term = q.trim().toLowerCase();
  const diffs = (data?.diffs || []).filter((d) => !term || String(d.name || '').toLowerCase().includes(term));
  const badge = (p) => ({ computed: 'Computed only', uploaded: 'Sheet only', both: 'Both' }[p] || p);
  const badgeColor = (p) => ({ computed: '#e0e7ff', uploaded: '#fef3c7', both: '#dcfce7' }[p] || '#f1f5f9');
  return (
    <div className="modal-card" style={{ maxWidth: 520, maxHeight: '88vh', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <strong>Optional check — computed vs uploaded sheet</strong>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 10px' }} onClick={onClose}>✕</button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
        {from} → {to}. These totals do not need to match. <b>Generate payroll from sheet</b> pays the uploaded amounts
        for staff linked to the sheet (including people auto-created on upload); that draft is what the <b>Bank portal file</b> uses.
      </div>
      {err && <div style={{ padding: 10, background: '#fee2e2', borderRadius: 8, fontSize: 13, color: '#991b1b', marginBottom: 10 }}>{err}</div>}
      {!data ? <div className="skel" /> : (
        <>
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 12 }}>
              <div><b>Computed</b> (attendance, optional) {ngn(data.totals?.computed?.net)}</div>
              {data.upload ? (
                <>
                  <div style={{ marginTop: 4 }}><b>Uploaded sheet</b> (all rows) {ngn(data.totals?.uploaded?.net)}</div>
                  <div style={{ marginTop: 4 }}><b>Bank file will pay</b> (matched) {ngn(data.sheet_summary?.matched_net ?? data.totals?.uploaded?.matched_net)}</div>
                </>
              ) : <div style={{ marginTop: 4, color: 'var(--muted)' }}>No sheet uploaded</div>}
            </div>
            {data.upload && (
              <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
                {data.upload.file_name}<br />{data.upload.line_count} lines
              </div>
            )}
          </div>
          <UnmatchedSheetNote summary={data.sheet_summary} compact />
          {data.upload && (
            <>
              <input className="input" style={{ marginBottom: 8 }} placeholder="Search name…" value={q} onChange={(e) => setQ(e.target.value)} />
              <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 72px 72px 64px 70px', gap: 4, padding: '6px 10px', background: '#f8fafc', fontSize: 11, fontWeight: 700 }}>
                  <span>Name</span><span style={{ textAlign: 'right' }}>Comp.</span><span style={{ textAlign: 'right' }}>Sheet</span><span style={{ textAlign: 'right' }}>Δ</span><span />
                </div>
                {diffs.map((d) => (
                  <div key={d.staff_id || d.ext_people_id || d.name} style={{ display: 'grid', gridTemplateColumns: '1fr 72px 72px 64px 70px', gap: 4, padding: '7px 10px', borderTop: '1px solid var(--line)', fontSize: 12, alignItems: 'center' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    <span style={{ textAlign: 'right' }}>{d.presence === 'uploaded' ? '—' : ngn(d.computed_net)}</span>
                    <span style={{ textAlign: 'right' }}>{d.presence === 'computed' ? '—' : ngn(d.uploaded_net)}</span>
                    <span style={{ textAlign: 'right', fontWeight: 700, color: Math.abs(d.delta) > 0.01 ? '#b45309' : 'inherit' }}>{d.presence === 'both' ? ngn(d.delta) : '—'}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10, background: badgeColor(d.presence), textAlign: 'center' }}>{badge(d.presence).split(' ')[0]}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Month-end sheet upload — store alongside computed payroll, or generate a draft run.
function SheetUploadCard({ from, to, pieceOnly, upload, onUploaded, onDeleted, onGenerated, onCompare, onShowHistory }) {
  const { toast, confirm } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (pieceOnly) return null;
  const summary = upload?.sheet_summary;
  const staffFromSheet = upload?.staff_from_sheet;

  const uploadFile = async (file) => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('period_from', from);
      fd.append('period_to', to);
      fd.append('kind', 'REGULAR');
      const r = await api(scopedAny('/payroll/sheet-upload'), { method: 'POST', form: fd });
      const createdN = r.staff_from_sheet?.created_count || 0;
      const still = r.sheet_summary?.unmatched_count || 0;
      if (createdN) {
        toast(`Sheet stored — created ${createdN} new staff from sheet · ${r.line_count} lines${still ? ` · ${still} still unmatched` : ''} ✓`, still ? 'err' : 'ok');
      } else if (still) {
        toast(`Sheet stored — ${r.line_count} lines · ${still} unmatched (${ngn(r.sheet_summary.unmatched_net)})`, 'err');
      } else {
        toast(`Sheet stored — ${r.line_count} lines ✓`, 'ok');
      }
      onUploaded && onUploaded(r);
    } catch (e) { setErr(e.message || 'Upload failed'); }
    setBusy(false);
  };

  const generateFromSheet = async () => {
    if (!upload?.id && !from) return;
    const um = summary?.unmatched_count || 0;
    const ok = await confirm({
      title: 'Generate payroll from sheet?',
      message: `Create a DRAFT for ${from} → ${to} using the uploaded workbook (not computed attendance). `
        + 'Next, on Saved: Approve → Bank portal file — same as mid-month.'
        + (um
          ? `\n\n⚠ ${um} sheet row(s) totaling ${ngn(summary.unmatched_net)} are still unmatched (ambiguous ID/name or missing identity) and will be LEFT OUT of the bank file.`
          : ''),
      confirmText: um ? 'Generate without unmatched' : 'Generate draft',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      const r = await api(scopedAny('/payroll/runs2/from-sheet'), {
        method: 'POST',
        body: { from, to, upload_id: upload?.id },
      });
      if (r.unmatched_count) {
        toast(`Draft created — ${r.line_count} staff, net ${ngn(r.total_net)}. ${r.unmatched_count} unmatched row(s) (${ngn(r.unmatched_net)}) are not in the bank file.`, 'err');
      } else {
        toast(`Draft from sheet — ${r.line_count} staff, net ${ngn(r.total_net)}. Opening Saved: Approve → Bank portal file.`, 'ok');
      }
      onGenerated && onGenerated(r);
    } catch (e) { setErr(e.message || 'Could not generate from sheet'); }
    setBusy(false);
  };

  const remove = async () => {
    if (!upload?.id) return;
    const ok = await confirm({
      title: 'Remove uploaded sheet?',
      message: `This removes the stored workbook for ${from} → ${to}. Computed payroll is not affected.`,
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(scopedAny(`/payroll/sheet-upload/${upload.id}`), { method: 'DELETE' });
      toast('Sheet removed ✓', 'ok');
      onDeleted && onDeleted();
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <div className="card" style={{ padding: '12px 14px', marginBottom: 10, borderLeft: '3px solid #2563eb' }}>
      <strong style={{ display: 'block', marginBottom: 2 }}>Month-end: pay from the accountant&apos;s Excel</strong>
      <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
        Same as mid-month: upload sheet → generate → bank file. The bank portal file uses these uploaded amounts.
      </span>
      <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Step 1 — Upload Excel</div>
      {upload ? (
        <div style={{ marginTop: 6, fontSize: 12.5 }}>
          <b>{upload.file_name || 'Uploaded sheet'}</b>
          <span style={{ color: 'var(--muted)' }}>
            {' · '}{upload.line_count} lines
            {summary?.uploaded_net != null ? ` · sheet ${ngn(summary.uploaded_net)}` : ''}
            {summary?.matched_net != null ? ` · matched ${ngn(summary.matched_net)}` : ''}
            {upload.uploaded_at ? ` · ${new Date((upload.uploaded_at || 0) * 1000).toLocaleDateString()}` : ''}
          </span>
          <StaffFromSheetNote staffFromSheet={staffFromSheet} />
          <UnmatchedSheetNote summary={summary} />
          <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Step 2 — Generate payroll from sheet</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <button className="btn" style={{ width: 'auto', padding: '8px 16px' }} onClick={generateFromSheet} disabled={busy}>
              {busy ? <span className="spin" /> : '📋'} Generate payroll from sheet
            </button>
            {onCompare && (
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '8px 12px' }} onClick={onCompare} disabled={busy}>
                Optional check vs computed
              </button>
            )}
            <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '8px 12px' }} onClick={remove} disabled={busy}>Remove</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
            Step 3 — opens <b>Saved</b>: Approve, then <b>Bank portal file</b>.
          </div>
        </div>
      ) : (
        <label className="btn" style={{ marginTop: 8, cursor: 'pointer', width: 'auto', display: 'inline-flex' }}>
          {busy ? <span className="spin" /> : '⬆ Choose Excel (.xls/.xlsx)'}
          <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadFile(f); }} />
        </label>
      )}
      {err && <div style={{ marginTop: 8, fontSize: 12, color: '#991b1b' }}>{err}</div>}
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 0', marginTop: 8, fontSize: 12 }}
        onClick={() => onShowHistory && onShowHistory()}>View sheet upload history →</button>
    </div>
  );
}

// Past month-end workbook uploads — retained for audit and re-download.
function SheetHistoryTab({ onOpenRun }) {
  const { toast, isGroup } = useStore();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState(null);
  const [linesBusy, setLinesBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api(scopedAny('/payroll/sheet-upload/history'));
      setRows(r.uploads || []);
    } catch (e) {
      toast(e.message || 'Could not load sheet history', 'err');
      setRows([]);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const viewLines = async (id) => {
    setLinesBusy(true);
    try {
      setViewing(await api(scopedAny(`/payroll/sheet-upload/${id}/lines`)));
    } catch (e) { toast(e.message || 'Could not load lines', 'err'); }
    setLinesBusy(false);
  };

  const statusPill = (u) => {
    if (u.is_active) return { label: 'Active', bg: '#dcfce7', color: '#166534' };
    if (u.status === 'DELETED') return { label: 'Removed', bg: '#fee2e2', color: '#991b1b' };
    return { label: 'Superseded', bg: '#f3f4f6', color: '#4b5563' };
  };

  const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '—');
  const fmtSize = (n) => {
    if (!n) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 12px' }}>
        Every month-end workbook uploaded for payroll is kept here. Re-uploading the same period marks the previous file as superseded but does not delete it.
      </p>
      {loading ? <div className="skel" /> : !rows.length ? (
        <div className="empty"><div className="ic">📁</div><p>No sheet uploads yet</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((u) => {
            const pill = statusPill(u);
            return (
              <div key={u.id} style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{u.file_name || 'Uploaded sheet'}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {u.period_from} → {u.period_to}
                      {u.kind === 'MIDMONTH' ? ' · mid-month' : ' · month-end'}
                      {isGroup && u.tenant_name ? ` · ${u.tenant_name}` : ''}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      {fmtDate(u.uploaded_at)} · {u.uploaded_by_name || '—'} · {u.line_count || 0} lines · {fmtSize(u.file_size)}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: pill.bg, color: pill.color, alignSelf: 'flex-start' }}>
                    {pill.label}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {u.has_file ? (
                    <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
                      onClick={() => downloadFile(scopedAny(`/payroll/sheet-upload/${u.id}/download`), u.file_name || 'payroll-sheet.xlsx').catch((e) => toast(e.message, 'err'))}>
                      ⬇ Download
                    </button>
                  ) : (
                    <span style={{ fontSize: 11.5, color: 'var(--muted)', alignSelf: 'center' }}>File not stored</span>
                  )}
                  <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
                    onClick={() => viewLines(u.id)} disabled={linesBusy}>
                    {linesBusy ? <span className="spin" /> : '👁'} View lines
                  </button>
                  {u.run_id && (
                    <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
                      onClick={() => onOpenRun && onOpenRun(u)}>
                      🧾 Run {u.run_status || 'DRAFT'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewing && (
        <div onClick={() => setViewing(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: 'min(720px, 100%)', maxHeight: '85vh', overflow: 'auto', padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
              <div>
                <strong>{viewing.upload?.file_name || 'Sheet lines'}</strong>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {viewing.upload?.period_from} → {viewing.upload?.period_to} · sheet {ngn(viewing.totals?.net)}
                  {viewing.sheet_summary?.unmatched_count
                    ? ` · ${viewing.sheet_summary.unmatched_count} unmatched (${ngn(viewing.sheet_summary.unmatched_net)})`
                    : ''}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto' }} onClick={() => setViewing(null)}>Close</button>
            </div>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '6px 4px' }}>Name</th>
                  <th style={{ padding: '6px 4px' }}>Kind</th>
                  <th style={{ padding: '6px 4px', textAlign: 'right' }}>Net</th>
                </tr>
              </thead>
              <tbody>
                {(viewing.lines || []).map((l) => (
                  <tr key={l.id} style={{ borderBottom: '1px solid var(--line)', background: l.staff_id ? undefined : '#fffbeb' }}>
                    <td style={{ padding: '6px 4px' }}>{l.name || '—'}{!l.staff_id ? ' · unmatched' : ''}</td>
                    <td style={{ padding: '6px 4px', color: 'var(--muted)' }}>{l.sheet_kind || '—'}</td>
                    <td style={{ padding: '6px 4px', textAlign: 'right', fontWeight: 700 }}>{ngn(l.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Silently paying from an override is exactly the sort of thing that is fine
// until the one time it is not.
function OverrideBanner({ override }) {
  if (!override) return null;
  return (
    <div className="card" style={{ padding: '9px 12px', marginBottom: 10, borderLeft: '3px solid var(--warn, #c98a00)' }}>
      <div style={{ fontSize: 12.5, fontWeight: 700 }}>
        📄 Bag figures for {override.period_from} → {override.period_to} come from the accountant&apos;s sheet
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
        {override.matched} staff on the sheet{override.unmatched ? ` · ${override.unmatched} sheet row(s) unmatched` : ''}
        {override.file_name ? ` · ${override.file_name}` : ''} — for this period the sheet is the whole bag payroll:
        recorded production is not used, and anyone not on the sheet earns no commission.
      </div>
    </div>
  );
}

// ── Accountant's spreadsheet override ─────────────────────────────────────────
// Lets the Snr Accountant's payroll workbook stand in for `production` for ONE
// pay period, for the sites whose bags never got entered.
//
// The card is deliberately unglamorous and states what it is. It is a bridge for
// sites that are not yet recording production, not a normal way to run payroll,
// and the copy should keep saying so.
function SheetOverrideCard() {
  const { toast, confirm, tenant } = useStore();
  const role = useRole();
  const isAdmin = role && atLeast(role, 'ADMIN');
  const [state, setState] = useState({ enabled: false, batches: [] });
  const [preview, setPreview] = useState(null);   // dry-run result + the File
  const [busy, setBusy] = useState(false);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [showBank, setShowBank] = useState(false);
  // Kept on screen, not toasted. A parse failure answers in ~100ms, so the
  // spinner never registers and a missed toast looks exactly like "I clicked
  // upload and nothing happened".
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null);        // result of the applied import
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    try { setState(await api(scopedAny('/payroll/production-override'))); } catch { /* leave as-is */ }
  }, [tenant]);
  // Re-read on workspace change, and whenever the window regains focus — an Admin
  // usually flips the flag in another session, and a stale "Disabled" pill leaves
  // the accountant staring at a greyed-out Apply button for no visible reason.
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // No `kind` is sent. The cycle decides the rate (₦1 vs ₦6 a bag), and the sheet
  // states it in its own PAY TYPE column — the server reads it there. Guessing it
  // here and echoing the guess back would label every sheet mid-month.
  const send = async (file, dry) => {
    const fd = new FormData();
    fd.append('file', file);
    if (dry) fd.append('dry_run', '1');
    return api(scopedAny('/payroll/production-override/import'), { method: 'POST', form: fd });
  };

  // Always dry-run first. The Admin's enable is good for exactly one upload, so
  // finding a bad column name AFTER spending it is a bad trade.
  const pick = async (file) => {
    if (!file) return;
    setBusy(true); setShowUnmatched(false); setShowBank(false); setErr(null); setDone(null); setQ('');
    try {
      const r = await send(file, true);
      setPreview({ ...r, file });
      if (!r.matched) setErr('The file was read, but no row matched anyone on the roster. Check the ID and name columns.');
    } catch (e) { setErr(e.message || 'Could not read that file'); setPreview(null); }
    setBusy(false);
  };

  const apply = async () => {
    if (!preview) return;
    const ok = await confirm({
      title: 'Override production for this period?',
      message: `For ${preview.period_from} → ${preview.period_to}, this sheet becomes the whole bag payroll: `
          + `${preview.matched} staff paid ${ngn(preview.total_amount)}, and anyone NOT on it earns no commission `
          + 'for the period. Daily production records are not changed.',
      confirmText: 'Override',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      const r = await send(preview.file, false);
      setDone(r); setPreview(null); load();
      toast(`Override loaded — ${r.matched} staff ✓`, 'ok');
    } catch (e) { setErr(e.message || 'Import failed'); }
    setBusy(false);
  };

  const toggle = async (on) => {
    setBusy(true);
    try {
      await api(scopedAny('/payroll/production-override/enable'), { method: 'POST', body: { enabled: on } });
      load();
    } catch (e) { toast(e.message, 'err'); }
    setBusy(false);
  };

  const drop = async (b) => {
    const ok = await confirm({
      title: 'Remove this override?',
      message: `Payroll for ${b.period_from} → ${b.period_to} goes back to using what the sites recorded. `
          + 'Any run already computed from it must be recomputed.',
      confirmText: 'Remove', danger: true,
    });
    if (!ok) return;
    try { await api(scopedAny(`/payroll/production-override/${b.id}`), { method: 'DELETE' }); toast('Override removed ✓', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
      <strong style={{ display: 'block', marginBottom: 2 }}>Accountant&apos;s payroll sheet</strong>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
        Loads the Snr Accountant&apos;s workbook (BAGGERS + LOADERS) as <strong>the</strong> bag figures for one pay
        period. Recorded production is then ignored for that period entirely — anyone not on the sheet earns no
        commission — so the run reconciles to the workbook. Daily production records are left untouched.
        Use it only while a site is still not entering production.
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12 }}>
        <span className="pill" style={{ background: state.enabled ? 'var(--ok-bg, #e7f7ec)' : 'var(--line)', fontWeight: 700 }}>
          {state.enabled ? '🔓 Enabled for one upload' : '🔒 Disabled'}
        </span>
        {isAdmin ? (
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '3px 10px' }}
            disabled={busy} onClick={() => toggle(!state.enabled)}>
            {state.enabled ? 'Disable' : 'Enable for one upload'}
          </button>
        ) : !state.enabled && (
          <span style={{ color: 'var(--muted)' }}>An Admin must enable it before you can apply a sheet.</span>
        )}
      </div>

      <div style={{ marginTop: 10 }}>
        <label className="btn btn-ghost btn-sm" style={{ cursor: 'pointer', textAlign: 'center' }}>
          {busy && !preview ? <span className="spin" /> : '⬆ Upload sheet to check'}
          <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; pick(f); }} />
        </label>
        <span style={{ fontSize: 11, color: 'var(--muted)', marginLeft: 8 }}>
          Reads the file and shows you the totals. Nothing is saved until you press Save.
        </span>
      </div>

      {/* A failed read must say so on the page. A toast for a 100ms failure is
          indistinguishable from the upload doing nothing at all. */}
      {err && (
        <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid #f0c0c0', background: '#fdf3f3', fontSize: 12.5 }}>
          ⚠ {err}
        </div>
      )}

      {done && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, border: '1px solid #bfe3c8', background: '#f2fbf5' }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>✓ Override loaded</div>
          <div style={{ fontSize: 12, marginTop: 3 }}>
            {done.period_from} → {done.period_to} · {done.kind === 'MONTHEND' ? 'Month-end' : 'Mid-month'} ·{' '}
            <strong>{done.matched} staff</strong> · <strong>{ngn(done.total_amount)}</strong>
            {done.unmatched ? <span style={{ color: '#b45309' }}> · {done.unmatched} row(s) not matched</span> : null}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            Now go to <strong>Run</strong> (or <strong>Mid-month</strong>), set the same dates and Compute — the run will
            use these figures. Uploading again needs an Admin to enable it once more.
          </div>
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 10, border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
          {/* The verdict and the Apply button sit ABOVE the list. The accountant's
              question is "did this work and is the total right" — that has to be
              answerable without scrolling past 126 names. */}
          <div style={{ padding: 10, borderBottom: '1px solid var(--line)' }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              ✓ Sheet read · {preview.period_from} → {preview.period_to} · {preview.kind === 'MONTHEND' ? 'Month-end' : 'Mid-month'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {preview.matched} staff · {Number(preview.total_bagged).toLocaleString()} bagged ·{' '}
                {Number(preview.total_loaded).toLocaleString()} loaded
              </span>
              <strong style={{ fontSize: 15 }}>{ngn(preview.total_amount)}</strong>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              at ₦{preview.rates?.bagged}/bag bagged, ₦{preview.rates?.loaded}/bag loaded — compare this total with your workbook
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-sm" style={{ flex: 1 }} disabled={busy || !state.enabled} onClick={apply}>
                {busy ? <span className="spin" /> : (state.enabled ? `Save override — ${preview.matched} staff` : 'Save (needs Admin to enable)')}
              </button>
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }}
                disabled={busy} onClick={() => { setPreview(null); setErr(null); }}>Discard</button>
            </div>

            {preview.unmatched > 0 && (
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 8px', fontSize: 12, marginTop: 8, color: '#b45309' }}
                onClick={() => setShowUnmatched((v) => !v)}>
                ⚠ {preview.unmatched} row(s) not matched — {showUnmatched ? 'hide' : 'these people will NOT be paid'}
              </button>
            )}

            {/* Bank details. Filling a blank is a quiet win; a conflict is money
                going somewhere unexpected, so it is stated and left alone. */}
            {(preview.bank_filled || preview.bank_conflicts || preview.bank_missing) ? (
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 8px', fontSize: 12, marginTop: 6, display: 'block' }}
                onClick={() => setShowBank((v) => !v)}>
                🏦 {preview.bank_filled ? `${preview.bank_filled} account(s) will be filled in` : 'bank details'}
                {preview.bank_conflicts ? ` · ${preview.bank_conflicts} differ from the roster (kept as-is)` : ''}
                {preview.bank_missing ? ` · ${preview.bank_missing} still with no account` : ''}
                {showBank ? ' — hide' : ' — details'}
              </button>
            ) : null}
          </div>

          {showBank && (
            <div style={{ maxHeight: 180, overflowY: 'auto', padding: '6px 10px', background: '#f6f9ff', fontSize: 12 }}>
              {(preview.bank_notes || []).map((b, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ flex: 1 }}>{b.full_name}</span>
                  <span style={{ color: 'var(--muted)', textAlign: 'right', flex: 2 }}>{b.note}</span>
                </div>
              ))}
            </div>
          )}

          {showUnmatched && (
            <div style={{ maxHeight: 200, overflowY: 'auto', padding: '6px 10px', background: '#fffaf2', fontSize: 12 }}>
              {(preview.unmatched_rows || []).map((u, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ flex: 1 }}>{u.full_name || u.ext_id || '—'}{u.location ? ` · ${u.location}` : ''}</span>
                  <span style={{ color: 'var(--muted)', textAlign: 'right' }}>{u.bags ? Number(u.bags).toLocaleString() : ''} · {u.reason}</span>
                </div>
              ))}
            </div>
          )}

          {/* Only the people in the file — this list IS the sheet, matched to the
              roster, so it can be read straight against the workbook. */}
          <div style={{ padding: '8px 10px' }}>
            <input className="input" style={{ padding: '6px 8px', fontSize: 12.5 }} value={q}
              onChange={(e) => setQ(e.target.value)} placeholder="Search these staff (e.g. Mbiama)…" />
          </div>
          {(() => {
            const term = q.trim().toLowerCase();
            const list = (preview.rows || []).filter((r) => !term
              || r.full_name.toLowerCase().includes(term) || (r.site_name || '').toLowerCase().includes(term));
            return (
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {list.length === 0 ? <div style={{ padding: 10, fontSize: 12, color: 'var(--muted)' }}>No match.</div> : null}
                {list.map((r) => (
                  <div key={r.staff_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 10px', borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.full_name}
                      <span style={{ color: 'var(--muted)' }}>
                        {' · '}{r.site_name}{' · '}
                        {r.designation === 'LOADER' ? `L${Number(r.bags_loaded).toLocaleString()}` : `B${Number(r.bags_bagged).toLocaleString()}`}
                        {r.account ? ` · ${r.account}` : ' · ⚠ no account'}
                      </span>
                    </span>
                    <strong style={{ whiteSpace: 'nowrap' }}>{ngn(r.amount)}</strong>
                  </div>
                ))}
                {term && list.length ? (
                  <div style={{ padding: '6px 10px', borderTop: '1px solid var(--line)', fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--muted)' }}>{list.length} shown</span>
                    <strong>{ngn(list.reduce((a, r) => a + r.amount, 0))}</strong>
                  </div>
                ) : null}
              </div>
            );
          })()}
        </div>
      )}

      {(state.batches || []).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4 }}>Loaded periods</div>
          {state.batches.map((b) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{b.period_from} → {b.period_to} · {b.kind === 'MONTHEND' ? 'Month-end' : 'Mid-month'}</div>
                <div style={{ color: 'var(--muted)' }}>
                  {b.matched} staff{b.unmatched ? ` · ${b.unmatched} unmatched` : ''}
                  {b.file_name ? ` · ${b.file_name}` : ''}
                </div>
              </div>
              {isAdmin && (
                <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 10px' }}
                  onClick={() => drop(b)}>Remove</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Setup: pay rates + advances ───────────────────────────────────────────────
function SetupTab({ sites }) {
  const { tenant, toast, openModal, closeModal, isGroup, confirm } = useStore();
  const [rows, setRows] = useState([]);
  const [site, setSite] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

  // Shared per-bag rates (global, apply to ALL loaders/baggers across Fido+Fiafia).
  // TWO pairs: the full month-end commission and the smaller mid-month incentive.
  const [bag, setBag] = useState({ loaded: 0, bagged: 0 });
  const [bagMid, setBagMid] = useState({ loaded: 0, bagged: 0 });
  const [bagBusy, setBagBusy] = useState(false);
  // Rates are LOCKED by default. They set what every bagger and loader is paid, so
  // an open text box invites an accidental keystroke that silently changes payroll
  // for the whole business — which is exactly what happened (month-end sat at ₦1).
  // Read-only until Edit is pressed; saving locks them again.
  const [ratesEdit, setRatesEdit] = useState(false);
  const [ratesSavedAt, setRatesSavedAt] = useState(null);
  const applyRates = (r) => { setBag(r.monthend || r); setBagMid(r.midmonth || { loaded: 0, bagged: 0 }); };
  useEffect(() => { api(scopedAny('/payroll/bag-rates')).then(applyRates).catch(() => {}); }, [tenant]);
  const saveBag = async () => {
    const vals = [bag.loaded, bag.bagged, bagMid.loaded, bagMid.bagged].map((v) => +v || 0);
    if (vals.some((v) => v <= 0)) return toast('A rate of 0 pays nobody — every worker would drop off the run', 'err');
    if (+bagMid.bagged > +bag.bagged || +bagMid.loaded > +bag.loaded) {
      return toast('Mid-month incentive is higher than the full month rate — check the fields', 'err');
    }
    const ok = await confirm({
      title: 'Change what every worker is paid?',
      message: `Full month ₦${+bag.loaded || 0}/bag loaded · ₦${+bag.bagged || 0}/bag bagged\nMid-month ₦${+bagMid.loaded || 0}/bag loaded · ₦${+bagMid.bagged || 0}/bag bagged\n\nApplies to every bagger and loader across Fido + Fiafia. Existing drafts keep their old figures until recomputed.`,
      confirmText: 'Save rates',
    });
    if (!ok) return;
    setBagBusy(true);
    try {
      applyRates(await api(scopedAny('/payroll/bag-rates'), { method: 'PUT', body: {
        rate_loaded: +bag.loaded || 0, rate_bagged: +bag.bagged || 0,
        rate_loaded_mid: +bagMid.loaded || 0, rate_bagged_mid: +bagMid.bagged || 0,
      } }));
      toast('Per-bag rates saved ✓', 'ok');
      setRatesEdit(false); setRatesSavedAt(Date.now());
    }
    catch (e) { toast(e.message, 'err'); }
    setBagBusy(false);
  };
  // Leaving edit mode without saving must not keep the typed-but-unsaved numbers
  // on screen — they would look live.
  const cancelRates = async () => {
    setRatesEdit(false);
    try { applyRates(await api(scopedAny('/payroll/bag-rates'))); } catch { /* keep what we have */ }
  };

  const [importingStaff, setImportingStaff] = useState(false);
  const importStaff = async (file) => {
    if (!file) return;
    setImportingStaff(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api(scopedAny('/payroll/staff-import'), { method: 'POST', form: fd });
      const skipped = r.skipped_no_site?.length
        ? ` · ⚠ ${r.skipped_no_site.length} skipped (no site — fix LOCATION & re-import)` : '';
      toast(`Staff: ${r.created} added, ${r.updated} updated${r.sites_unmatched?.length ? ` · location(s) not matched: ${r.sites_unmatched.join(', ')}` : ''}${skipped}`, r.skipped_no_site?.length ? 'err' : 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
    setImportingStaff(false);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try { const p = new URLSearchParams(); if (site) p.set('site', site); setRows(await api(scopedAny(`/payroll/pay-config?${p}`))); }
    catch { setRows([]); }
    setLoading(false);
  }, [tenant, site]);
  useEffect(() => { load(); }, [load]);

  const setVal = (i, k, v) => setRows((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async (r) => {
    try { await api(scopedAny(`/payroll/pay-config/${r.id}`), { method: 'PATCH', body: { pay_type: r.pay_type, daily_rate: +r.daily_rate || 0, rate_loaded: +r.rate_loaded || 0, rate_bagged: +r.rate_bagged || 0 } }); toast(`${r.full_name} saved ✓`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  if (loading) return <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>;
  return (
    <div>
      {(() => {
        // Locked look: greyed, not editable, until Edit is pressed.
        const ro = !ratesEdit;
        const inp = (val, on, label) => (
          <div style={{ flex: 1 }}>
            <label className="fl">{label}</label>
            <input type="number" min="0" step="0.01" className="input" value={val ?? 0} readOnly={ro} disabled={ro}
              onChange={(e) => on(e.target.value)}
              style={ro ? { background: '#f1f5f9', color: 'var(--muted)', cursor: 'not-allowed' } : undefined} />
          </div>
        );
        return (
          <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <strong style={{ display: 'block', marginBottom: 2 }}>
                  Per-bag rates (loaders &amp; baggers) {ro && <span title="Locked — press Edit to change" style={{ fontSize: 12 }}>🔒</span>}
                </strong>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Shared across Fido + Fiafia. Every loader/bagger is paid bags × these rates.</span>
              </div>
              {ro && (
                <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '6px 14px' }} onClick={() => setRatesEdit(true)}>✏️ Edit</button>
              )}
            </div>

            <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Full month — 28th prev → 27th <span style={{ fontWeight: 500 }}>· standard ₦6/bag</span></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'flex-end' }}>
              {inp(bag.loaded, (v) => setBag((b) => ({ ...b, loaded: v })), '₦ / bag loaded')}
              {inp(bag.bagged, (v) => setBag((b) => ({ ...b, bagged: v })), '₦ / bag bagged')}
            </div>

            <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>Mid-month incentive — 16th prev → 15th <span style={{ fontWeight: 500 }}>· standard ₦1/bag</span></div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'flex-end' }}>
              {inp(bagMid.loaded, (v) => setBagMid((b) => ({ ...b, loaded: v })), '₦ / bag loaded')}
              {inp(bagMid.bagged, (v) => setBagMid((b) => ({ ...b, bagged: v })), '₦ / bag bagged')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
              The mid-month incentive is paid <b>in addition to</b> the full month-end commission — the two cycles cover
              the same bags on purpose.
            </div>

            {ratesEdit ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-ghost" style={{ width: 'auto', padding: '10px 16px' }} onClick={cancelRates} disabled={bagBusy}>Cancel</button>
                <button className="btn" style={{ width: 'auto', padding: '10px 16px' }} onClick={saveBag} disabled={bagBusy}>
                  {bagBusy ? <><span className="spin" /> Saving…</> : 'Save rates'}
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 10, fontSize: 12, fontWeight: 700, color: '#166534' }}>
                ✓ Saved{ratesSavedAt ? ' just now' : ''} — these rates are live. Press <b>Edit</b> to change them.
              </div>
            )}
          </div>
        );
      })()}
      <SheetOverrideCard />
      {/* Import creates staff in ONE workspace — the Group roll-up has no single
          workspace to own them, so it is offered only inside Fido or Fiafia. */}
      <div className="card" style={{ padding: '12px 14px', marginBottom: 12 }}>
        <strong style={{ display: 'block', marginBottom: 2 }}>Staff roster</strong>
        {isGroup ? (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Importing staff adds them to a specific workspace — switch to <strong>Fido</strong> or <strong>Fiafia</strong> (top-left) to import.
            Rates above, and the payroll runs themselves, cover every workspace.
          </span>
        ) : (
          <>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Upload an Excel (REGULAR / BAGGERS / LOADERS) to add or update staff in this workspace. Matches by ID; REGULAR base salary is saved.</span>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-ghost btn-sm" style={{ flex: 1 }}
                onClick={() => downloadFile(scopedAny('/payroll/staff-template.xlsx'), 'staff-template.xlsx').catch((e) => toast(e.message || 'Download failed', 'err'))}>⬇ Template</button>
              <label className="btn btn-sm" style={{ flex: 1, cursor: 'pointer', textAlign: 'center' }}>
                {importingStaff ? <span className="spin" /> : '⬆ Import staff'}
                <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} disabled={importingStaff}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; importStaff(f); }} />
              </label>
            </div>
          </>
        )}
      </div>
      {sites.length > 1 && (
        <SearchSelect style={{ marginBottom: 12 }} value={site} onChange={(val) => setSite(val)} options={[{ value: '', label: 'All sites' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} placeholder="All sites" />
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
  const [openRunId, setOpenRunId] = useState(null);
  const [summary, setSummary] = useState(null);

  useEffect(() => { if (allowed && tab === 'history') api(scopedAny('/payroll/imported/summary')).then(setSummary).catch(() => {}); }, [allowed, tab]);

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
        <button className={`seg-b${tab === 'sheets' ? ' on' : ''}`} onClick={() => setTab('sheets')}>📁 Sheet history</button>
      </div>

      {tab === 'run' ? <RunTab sites={sites} onSaved={() => setTab('runs')}
        onGenerated={(r) => { if (r?.id) setOpenRunId(r.id); setTab('runs'); }}
        onShowSheetHistory={() => setTab('sheets')} />
        : tab === 'mid' ? <MidMonthTab onSaved={() => setTab('runs')} />
        : tab === 'runs' ? <RunsTab initialOpenId={openRunId} onConsumedOpenId={() => setOpenRunId(null)} />
          : tab === 'setup' ? <SetupTab sites={sites} />
            : tab === 'sheets' ? <SheetHistoryTab onOpenRun={() => setTab('runs')} />
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
