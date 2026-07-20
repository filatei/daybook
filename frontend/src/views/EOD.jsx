import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, scopedAny, ngn, today, getToken } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';
import SearchSelect from '../components/SearchSelect.jsx';
import ReceiptCamera from '../components/ReceiptCamera.jsx';
import { shrinkImage, kb } from '../lib/shrinkImage.js';

// End-of-day POS capture: photograph each terminal's EOD slip, AI reads the
// figures, the user fixes anything unclear, and the day rolls up per site with
// the variance against what was actually keyed into Daybook.

const shiftDay = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const prettyDay = (d) => (d === today()

  ? 'today'
  : new Date(d + 'T00:00:00').toLocaleDateString('en-NG', { weekday: 'short', day: '2-digit', month: 'short' }));

// Defined at module scope, not inside EOD. A component declared during render is
// a brand-new type on every render, so React unmounts and remounts the whole
// subtree — which would throw away the expanded-site state on every tick of the
// parent. eslint react/no-unstable-nested-components catches exactly this.
const vColor = (v) => (Math.abs(v) < 1 ? 'var(--muted)' : (v > 0 ? '#b91c1c' : '#b45309'));

function TerminalRow({ r, inset, canDelete, onSlip, onDelete }) {
  return (
    <div style={{ padding: inset ? '10px 14px 10px 26px' : '11px 14px', borderTop: '1px solid var(--line)', background: inset ? '#fbfdff' : undefined }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ minWidth: 0 }}>
          <strong>{r.terminal_id || '—'}</strong>
          <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{r.bank ? ` · ${r.bank}` : ''}</span>
        </span>
        <strong style={{ whiteSpace: 'nowrap' }}>{ngn(r.eod_total)}</strong>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
        Card {ngn(r.p_approved)} ({r.p_successful}/{r.p_volume}) · Transfer {ngn(r.t_approved)} ({r.t_approved_n}/{r.t_volume})
      </div>
      <div style={{ fontSize: 12, marginTop: 3, color: vColor(r.variance) }}>
        Daybook {ngn(r.recorded_total)} ({r.recorded_count}) · variance {r.variance > 0 ? '+' : ''}{ngn(r.variance)}
      </div>
      {(r.captured_by_name || r.slip_time) ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
          {r.slip_time ? `Slip ${r.slip_time}` : ''}{r.slip_time && r.captured_by_name ? ' · ' : ''}
          {r.captured_by_name ? `captured by ${r.captured_by_name}` : ''}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        {r.stored_name ? (
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '3px 10px' }} onClick={() => onSlip(r.id)}>🖼 Slip</button>
        ) : null}
        {canDelete ? (
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '3px 10px', color: '#b91c1c' }} onClick={() => onDelete(r)}>Delete</button>
        ) : null}
        {(r.unclear || []).length > 0 ? (
          <span style={{ fontSize: 11.5, color: '#b45309', alignSelf: 'center' }}>⚠ {r.unclear.length} field(s) were unclear</span>
        ) : null}
      </div>
    </div>
  );
}

// One site: a summary line that opens to its terminals on tap.
function SiteBlock({ s, rows, open, onToggle, canDelete, onSlip, onDelete }) {
  return (
    <div style={{ borderBottom: '1px solid var(--line)' }}>
      <div role="button" tabIndex={0} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8,
                 padding: '10px 14px', fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'inline-block', width: 13, color: 'var(--muted)',
                         transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
          <strong>{s.site}</strong>
          <span style={{ color: 'var(--muted)' }}> · {s.terminals} terminal(s)</span>
        </span>
        <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <strong>{ngn(s.eod_total)}</strong>
          <span style={{ display: 'block', fontSize: 11.5, color: vColor(s.variance) }}>
            {s.variance > 0 ? '+' : ''}{ngn(s.variance)} vs Daybook
          </span>
        </span>
      </div>
      {open ? (
        <>
          <div style={{ padding: '0 14px 8px 26px', fontSize: 11.5, color: 'var(--muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span>Card {ngn(s.purchase)}</span>
            <span>Transfer {ngn(s.transfer)}</span>
            <span>In Daybook {ngn(s.recorded_total)}</span>
          </div>
          {rows.map((r) => (
            <TerminalRow key={r.id} r={r} inset canDelete={canDelete} onSlip={onSlip} onDelete={onDelete} />
          ))}
        </>
      ) : null}
    </div>
  );
}


const BLANK = {
  terminal_id: '', business_date: '', slip_time: '',
  purchase: { volume: 0, successful: 0, failed: 0, pending: 0, approved_amount: 0, pending_amount: 0, failed_amount: 0 },
  transfer: { volume: 0, approved: 0, rejected: 0, pending: 0, approved_amount: 0, pending_amount: 0, rejected_amount: 0 },
  unclear: [],
};

// A single figure. Fields the AI flagged as unclear are ringed so the user checks
// only those, instead of re-reading the whole slip.
function Num({ label, path, value, unclear, money = false, onChange }) {
  const flagged = unclear.includes(path);
  return (
    <div style={{ flex: '1 1 120px', minWidth: 0 }}>
      <label className="fl" style={{ color: flagged ? '#b45309' : undefined }}>
        {label}{flagged ? ' ⚠' : ''}
      </label>
      <input
        type="number" inputMode="decimal" className="input" value={value}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onChange(money ? e.target.value : e.target.value.replace(/[^\d]/g, ''))}
        style={flagged ? { borderColor: '#f59e0b', background: '#fffbeb' } : undefined} />
    </div>
  );
}

// ── Capture: upload a slip, confirm the figures, save ────────────────────────
function CaptureForm({ sites, day, onSaved, onClose }) {
  const { toast } = useStore();
  const [reading, setReading] = useState(false);
  const [shrunk, setShrunk] = useState(null);   // { from, to } bytes, for reassurance
  const [camOpen, setCamOpen] = useState(false);
  const [snapped, setSnapped] = useState('');   // label when the photo came from the camera
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ ...BLANK, business_date: day });
  const [meta, setMeta] = useState(null);     // { stored_name, file_name, mime }
  const [usageId, setUsageId] = useState(null);   // links the AI spend to this save
  const [aiNote, setAiNote] = useState('');
  const [siteId, setSiteId] = useState('');
  const [matched, setMatched] = useState(null);
  const [note, setNote] = useState('');

  const setP = (k, v) => setF((p) => ({ ...p, purchase: { ...p.purchase, [k]: v } }));
  const setT = (k, v) => setF((p) => ({ ...p, transfer: { ...p.transfer, [k]: v } }));

  // Upload → AI reads it → prefill the form. Never blocks: the read is abortable
  // and self-cancels, so a slow or stuck model can't trap the user — they can
  // always fall back to typing the figures.
  const READ_TIMEOUT_MS = 30000;
  const abortRef = useRef(null);
  const giveUp = (why) => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setReading(false);
    setAiNote(why || 'Enter the figures manually.');
  };
  // Don't leave a request running if the form is closed mid-read.
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  const read = async (chosen) => {
    if (!chosen) return;
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController(); abortRef.current = ac;
    const timer = setTimeout(() => ac.abort(), READ_TIMEOUT_MS);
    setReading(true); setAiNote(''); setShrunk(null);
    try {
      // Shrink first: a 3 MB phone photo becomes ~200 KB with no loss of
      // legibility for printed text. Cuts upload time, model latency (the usual
      // cause of a timeout) and image-token cost. Falls back to the original if
      // resizing isn't possible.
      const small = await shrinkImage(chosen);
      if (small !== chosen) setShrunk({ from: chosen.size, to: small.size });
      const fd = new FormData(); fd.append('file', small);
      const r = await api(scopedAny('/eod/extract'), { method: 'POST', form: fd, signal: ac.signal });
      setMeta(r.file || null);
      setUsageId(r.usage_id || null);
      const x = r.extract || BLANK;
      setF({
        terminal_id: x.terminal_id || '',
        business_date: x.business_date || day,
        slip_time: x.slip_time || '',
        purchase: { ...BLANK.purchase, ...(x.purchase || {}) },
        transfer: { ...BLANK.transfer, ...(x.transfer || {}) },
        unclear: x.unclear || [],
      });
      if (r.terminal) { setMatched(r.terminal); setSiteId(r.terminal.site_id || ''); }
      setAiNote(r.ai
        ? ((x.unclear || []).length ? `Read it — check the ${x.unclear.length} highlighted field(s).` : 'Read it — please confirm the figures.')
        : (r.reason || 'Enter the figures manually.'));
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
      setAiNote(aborted
        ? 'Reading took too long — please enter the figures from the slip.'
        : (e.message || 'Could not read the slip — enter the figures manually.'));
    }
    clearTimeout(timer);
    abortRef.current = null;
    setReading(false);
  };

  const save = async () => {
    if (!String(f.terminal_id || '').trim()) return toast('Terminal ID is required', 'err');
    if (!siteId && !matched) return toast('Pick the site this terminal belongs to', 'err');
    // Saving wins over a still-running read, so a late result can't overwrite
    // what the user just typed.
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; setReading(false); }
    setBusy(true);
    try {
      await api(scopedAny('/eod'), { method: 'POST', body: {
        ...f, site_id: siteId || undefined, note: note.trim() || undefined,
        file_name: meta?.file_name, stored_name: meta?.stored_name, mime: meta?.mime,
        usage_id: usageId || undefined,   // marks that AI read as actually used
        unclear: f.unclear, edited: true,
      } });
      toast('EOD saved ✓', 'ok'); onSaved && onSaved(); onClose();
    } catch (e) { toast(e.message || 'Could not save', 'err'); }
    setBusy(false);
  };

  const u = f.unclear || [];
  const eodTotal = (Number(f.purchase.approved_amount) || 0) + (Number(f.transfer.approved_amount) || 0);

  return (
    <div>
      <div className="grip" />
      <h3 style={{ marginBottom: 2 }}>Capture EOD</h3>
      <p className="sub" style={{ marginTop: 0 }}>Photograph the terminal’s end-of-day slip — the numbers are read for you.</p>

      <label className="fl">Slip photo</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <button className="btn" style={{ width: 'auto', padding: '10px 16px', whiteSpace: 'nowrap' }}
          onClick={() => setCamOpen(true)} disabled={reading || busy}>📷 Take photo</button>
        <input type="file" accept="image/*,.pdf" capture="environment" className="input" style={{ flex: '1 1 180px' }}
          onChange={(e) => { setSnapped(''); read(e.target.files?.[0] || null); }} disabled={reading || busy} />
      </div>
      {snapped && <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '4px 2px 0' }}>{snapped}</div>}
      {camOpen && (
        <ReceiptCamera
          onCapture={(file) => { setSnapped('📷 Photo taken with the camera.'); read(file); }}
          onClose={() => setCamOpen(false)} />
      )}
      {reading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 2px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}><span className="spin" /> Reading the slip… (up to 30s)</span>
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '3px 12px' }}
            onClick={() => giveUp('Skipped — enter the figures from the slip.')}>Enter manually</button>
        </div>
      )}
      {!reading && aiNote && (
        <div style={{ fontSize: 12.5, margin: '6px 2px', color: u.length ? '#b45309' : 'var(--muted)' }}>{aiNote}</div>
      )}
      {shrunk && (
        <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '2px 2px 0' }}>
          Photo compressed {kb(shrunk.from)} → {kb(shrunk.to)} before upload.
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 150px' }}>
          <label className="fl" style={{ color: u.includes('terminal_id') ? '#b45309' : undefined }}>Terminal ID{u.includes('terminal_id') ? ' ⚠' : ''}</label>
          <input className="input" value={f.terminal_id} placeholder="e.g. 2MP1UU1O"
            onChange={(e) => setF((p) => ({ ...p, terminal_id: e.target.value.toUpperCase() }))}
            style={u.includes('terminal_id') ? { borderColor: '#f59e0b', background: '#fffbeb' } : undefined} />
        </div>
        <div style={{ flex: '1 1 130px' }}>
          <label className="fl">Business date</label>
          <input type="date" className="input" value={f.business_date} max={today()}
            onChange={(e) => setF((p) => ({ ...p, business_date: e.target.value }))} />
        </div>
      </div>

      {matched ? (
        <div style={{ fontSize: 12.5, color: '#166534', margin: '6px 2px' }}>
          ✓ Known terminal{matched.label ? ` — ${matched.label}` : ''}{matched.bank ? ` · ${matched.bank}` : ''}
        </div>
      ) : (
        <>
          <label className="fl" style={{ marginTop: 6 }}>Site</label>
          <SearchSelect value={siteId} onChange={setSiteId} placeholder="Which site is this terminal at?"
            options={sites.map((s) => ({ value: s.id, label: s.name }))} />
        </>
      )}

      <div style={{ fontWeight: 800, fontSize: 13, margin: '14px 2px 4px' }}>Purchase (card)</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Num label="Total volume" path="purchase.volume" value={f.purchase.volume} unclear={u} onChange={(v) => setP('volume', v)} />
        <Num label="Successful" path="purchase.successful" value={f.purchase.successful} unclear={u} onChange={(v) => setP('successful', v)} />
        <Num label="Failed" path="purchase.failed" value={f.purchase.failed} unclear={u} onChange={(v) => setP('failed', v)} />
        <Num label="Pending" path="purchase.pending" value={f.purchase.pending} unclear={u} onChange={(v) => setP('pending', v)} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        <Num label="₦ approved" path="purchase.approved_amount" money value={f.purchase.approved_amount} unclear={u} onChange={(v) => setP('approved_amount', v)} />
        <Num label="₦ pending" path="purchase.pending_amount" money value={f.purchase.pending_amount} unclear={u} onChange={(v) => setP('pending_amount', v)} />
        <Num label="₦ failed" path="purchase.failed_amount" money value={f.purchase.failed_amount} unclear={u} onChange={(v) => setP('failed_amount', v)} />
      </div>

      <div style={{ fontWeight: 800, fontSize: 13, margin: '14px 2px 4px' }}>POS transfer</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Num label="Total volume" path="transfer.volume" value={f.transfer.volume} unclear={u} onChange={(v) => setT('volume', v)} />
        <Num label="Approved" path="transfer.approved" value={f.transfer.approved} unclear={u} onChange={(v) => setT('approved', v)} />
        <Num label="Rejected" path="transfer.rejected" value={f.transfer.rejected} unclear={u} onChange={(v) => setT('rejected', v)} />
        <Num label="Pending" path="transfer.pending" value={f.transfer.pending} unclear={u} onChange={(v) => setT('pending', v)} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
        <Num label="₦ approved" path="transfer.approved_amount" money value={f.transfer.approved_amount} unclear={u} onChange={(v) => setT('approved_amount', v)} />
        <Num label="₦ pending" path="transfer.pending_amount" money value={f.transfer.pending_amount} unclear={u} onChange={(v) => setT('pending_amount', v)} />
        <Num label="₦ rejected" path="transfer.rejected_amount" money value={f.transfer.rejected_amount} unclear={u} onChange={(v) => setT('rejected_amount', v)} />
      </div>

      <label className="fl" style={{ marginTop: 10 }}>Note (optional)</label>
      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="anything unusual about this slip" />

      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, padding: '10px 14px' }}>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>Terminal total (card + transfer)</span>
        <strong style={{ fontSize: 17 }}>{ngn(eodTotal)}</strong>
      </div>

      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        {/* Never blocked by `reading` — the user can always type and save. */}
        <button className="btn" onClick={save} disabled={busy}>{busy ? <span className="spin" /> : null} Save EOD</button>
      </div>
    </div>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────
// AI spend, per site and per user, with a waste signal (reads that never became
// a saved EOD). Accountant+ — it's cost data.
function AiUsagePanel({ day }) {
  const { tenant } = useStore();
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState('day');   // day | month

  useEffect(() => {
    if (!open) return;
    const from = range === 'month' ? `${day.slice(0, 7)}-01` : day;
    api(scopedAny(`/eod/ai-usage?from=${from}&to=${day}`)).then(setD).catch(() => setD(null));
  }, [open, range, day, tenant]);

  const row = (e) => (
    <div key={e.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 14px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
      <span style={{ minWidth: 0 }}>
        {e.label}
        <span style={{ color: 'var(--muted)', fontSize: 11.5 }}> · {e.reads} read{e.reads === 1 ? '' : 's'}
          {e.wasted > 0 ? ` · ${e.wasted} unused` : ''}{e.failed > 0 ? ` · ${e.failed} failed` : ''}</span>
      </span>
      <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <strong>₦{e.cost_ngn.toLocaleString()}</strong>
        {e.waste_pct >= 40 && e.reads >= 4 && (
          <span style={{ display: 'block', fontSize: 11, color: '#b45309' }}>⚠ {e.waste_pct}% wasted</span>
        )}
      </span>
    </div>
  );

  return (
    <div style={{ marginTop: 14 }}>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '5px 12px' }} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} AI reading cost
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button className={`btn btn-sm ${range === 'day' ? '' : 'btn-ghost'}`} style={{ width: 'auto', padding: '4px 12px' }} onClick={() => setRange('day')}>This day</button>
            <button className={`btn btn-sm ${range === 'month' ? '' : 'btn-ghost'}`} style={{ width: 'auto', padding: '4px 12px' }} onClick={() => setRange('month')}>Month to date</button>
          </div>
          {!d ? <div className="skel" /> : (
            <>
              <div className="card" style={{ padding: '10px 14px', marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{d.totals.reads} slip read(s)</span>
                  <strong style={{ fontSize: 17 }}>₦{d.totals.cost_ngn.toLocaleString()}</strong>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                  {d.totals.used} used · {d.totals.wasted} never saved{d.totals.failed ? ` · ${d.totals.failed} failed` : ''}
                  {' '}· limit {d.limits.per_user_day}/user/day, {d.limits.per_tenant_day}/workspace/day
                </div>
                {d.totals.waste_pct >= 40 && d.totals.reads >= 5 && (
                  <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 4 }}>
                    ⚠ {d.totals.waste_pct}% of paid reads never became a saved EOD — check who is re-scanning without saving.
                  </div>
                )}
              </div>
              {d.sites.length > 0 && (
                <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 10 }}>
                  <div style={{ padding: '8px 14px', background: '#f8fafc', borderBottom: '1px solid var(--line)', fontSize: 12, fontWeight: 800, color: 'var(--muted)' }}>By site</div>
                  {d.sites.map(row)}
                </div>
              )}
              {d.users.length > 0 && (
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  <div style={{ padding: '8px 14px', background: '#f8fafc', borderBottom: '1px solid var(--line)', fontSize: 12, fontWeight: 800, color: 'var(--muted)' }}>By user</div>
                  {d.users.map(row)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function EOD() {
  const { openModal, closeModal, tenant, sites, toast, confirm, go, isGroup } = useStore();
  const role = useRole();
  const canDelete = role && atLeast(role, 'ACCOUNTANT');
  const canSeeCost = role && atLeast(role, 'ACCOUNTANT');
  const [day, setDay] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [site, setSite] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from: day, to: day });
      if (site) p.set('site', site);
      setData(await api(scopedAny(`/eod?${p}`)));
    } catch { setData(null); }
    setLoading(false);
  }, [tenant, day, site]);
  useEffect(() => { load(); }, [load]);

  const capture = () => openModal(<CaptureForm sites={sites} day={day} onSaved={load} onClose={closeModal} />);

  // The photo route needs the Bearer token, so fetch it and open a blob URL
  // rather than linking straight to /api (which would 401).
  const viewSlip = async (id) => {
    try {
      const res = await fetch(`/api/eod/${id}/photo?tenant=${tenant}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('not found');
      window.open(URL.createObjectURL(await res.blob()), '_blank');
    } catch { toast('Slip photo not available', 'err'); }
  };

  const del = async (r) => {
    const ok = await confirm({ title: 'Delete this EOD entry?', message: `${r.terminal_id} · ${r.business_date} · ${ngn(r.eod_total)}`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    try { await api(scoped(`/eod/${r.id}`), { method: 'DELETE' }); toast('Deleted ✓', 'ok'); load(); }
    catch (e) { toast(e.message || 'Could not delete', 'err'); }
  };


  // Which site rows are expanded, keyed by the backend's tenant|site key. A
  // single site is open from the start — there is nothing to collapse away.
  const [open, setOpen] = useState({});
  const toggle = (k) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const isOpen = (k) => (data && data.sites.length === 1 ? true : !!open[k]);

  const siteKey = (r) => `${r.tenant_id}|${r.site_id || '—'}`;

  // Label workspaces only when the roll-up actually spans more than one —
  // inside a single tenant the header would be noise.
  const multiTenant = !!(data && (data.tenants || []).length > 1);


  return (
    <div>
      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px', marginBottom: 12 }} onClick={() => go('more')}>← More</button>
      <div className="section-title" style={{ marginTop: 0 }}>End-of-day POS</div>

      {/* Day picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }} onClick={() => setDay((d) => shiftDay(d, -1))}>‹</button>
        <input type="date" className="input" style={{ flex: 1 }} value={day} max={today()} onChange={(e) => setDay(e.target.value)} />
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }} disabled={day >= today()} onClick={() => setDay((d) => shiftDay(d, 1))}>›</button>
      </div>
      {!isGroup && sites.length > 1 && (
        <SearchSelect style={{ marginBottom: 10 }} value={site} onChange={setSite} placeholder="All sites"
          options={[{ value: '', label: 'All sites' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} />
      )}

      {isGroup ? (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 12, fontSize: 12.5, color: 'var(--muted)' }}>
          Viewing every workspace. Switch to Fido Water or Fiafia Water to capture a slip.
        </div>
      ) : (
        <button className="btn" style={{ marginBottom: 12 }} onClick={capture}>📸 Capture EOD slip</button>
      )}

      {loading ? <>{[...Array(3)].map((_, i) => <div className="skel" key={i} />)}</>
        : !data || !data.rows.length ? (
          <div className="empty"><div className="ic">🧾</div><p>No EOD captured for {prettyDay(day)} yet.</p></div>
        ) : (
          <>
            {/* Day totals */}
            <div className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>
                  {data.totals.terminals} terminal(s) · {data.totals.sites} site(s)
                  {multiTenant ? ` · ${data.totals.tenants} workspaces` : ''} · {prettyDay(day)}
                </span>
                <strong style={{ fontSize: 19 }}>{ngn(data.totals.eod_total)}</strong>
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 12.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
                <span>Card {ngn(data.totals.purchase)}</span>
                <span>Transfer {ngn(data.totals.transfer)}</span>
                <span>In Daybook {ngn(data.totals.recorded_total)}</span>
                <span style={{ color: vColor(data.totals.variance), fontWeight: 700 }}>
                  Variance {data.totals.variance > 0 ? '+' : ''}{ngn(data.totals.variance)}
                </span>
              </div>
              {Math.abs(data.totals.variance) >= 1 && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                  {data.totals.variance > 0
                    ? 'The terminals took more than Daybook has recorded — some sales may not have been entered.'
                    : 'Daybook has more recorded than the terminals report — check for duplicate or mis-tagged entries.'}
                </div>
              )}
            </div>

            {/* Sites, grouped under their workspace when the Group roll-up
                is active. Tap a site to open its terminals. */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {(data.tenants || []).map((t) => (
                <div key={t.tenant_id}>
                  {multiTenant && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                                  padding: '9px 14px', background: '#eef4fb', borderBottom: '1px solid var(--line)' }}>
                      <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: .3, color: '#1e40af' }}>
                        {(t.tenant || '').toUpperCase()}
                      </span>
                      <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <strong style={{ fontSize: 13.5 }}>{ngn(t.eod_total)}</strong>
                        <span style={{ display: 'block', fontSize: 11, color: vColor(t.variance) }}>
                          {t.sites} site(s) · {t.variance > 0 ? '+' : ''}{ngn(t.variance)} vs Daybook
                        </span>
                      </span>
                    </div>
                  )}
                  {data.sites.filter((s) => s.tenant_id === t.tenant_id).map((s) => (
                    <SiteBlock key={s.key} s={s} rows={data.rows.filter((r) => siteKey(r) === s.key)}
                      open={isOpen(s.key)} onToggle={() => toggle(s.key)}
                      canDelete={canDelete} onSlip={viewSlip} onDelete={del} />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

      {canSeeCost && <AiUsagePanel day={day} />}
    </div>
  );
}
