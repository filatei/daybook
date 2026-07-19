import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, ngn, today, getToken } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';
import SearchSelect from '../components/SearchSelect.jsx';

// End-of-day POS capture: photograph each terminal's EOD slip, AI reads the
// figures, the user fixes anything unclear, and the day rolls up per site with
// the variance against what was actually keyed into Daybook.

const shiftDay = (d, n) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const prettyDay = (d) => (d === today()
  ? 'today'
  : new Date(d + 'T00:00:00').toLocaleDateString('en-NG', { weekday: 'short', day: '2-digit', month: 'short' }));

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
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ ...BLANK, business_date: day });
  const [meta, setMeta] = useState(null);     // { stored_name, file_name, mime }
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
    setReading(true); setAiNote('');
    try {
      const fd = new FormData(); fd.append('file', chosen);
      const r = await api(scoped('/eod/extract'), { method: 'POST', form: fd, signal: ac.signal });
      setMeta(r.file || null);
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
      await api(scoped('/eod'), { method: 'POST', body: {
        ...f, site_id: siteId || undefined, note: note.trim() || undefined,
        file_name: meta?.file_name, stored_name: meta?.stored_name, mime: meta?.mime,
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
      <input type="file" accept="image/*,.pdf" capture="environment" className="input"
        onChange={(e) => read(e.target.files?.[0] || null)} disabled={reading || busy} />
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
export default function EOD() {
  const { openModal, closeModal, tenant, sites, toast, confirm, go } = useStore();
  const role = useRole();
  const canDelete = role && atLeast(role, 'ACCOUNTANT');
  const [day, setDay] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [site, setSite] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from: day, to: day });
      if (site) p.set('site', site);
      setData(await api(scoped(`/eod?${p}`)));
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

  const vColor = (v) => (Math.abs(v) < 1 ? 'var(--muted)' : (v > 0 ? '#b91c1c' : '#b45309'));

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
      {sites.length > 1 && (
        <SearchSelect style={{ marginBottom: 10 }} value={site} onChange={setSite} placeholder="All sites"
          options={[{ value: '', label: 'All sites' }, ...sites.map((s) => ({ value: s.id, label: s.name }))]} />
      )}

      <button className="btn" style={{ marginBottom: 12 }} onClick={capture}>📸 Capture EOD slip</button>

      {loading ? <>{[...Array(3)].map((_, i) => <div className="skel" key={i} />)}</>
        : !data || !data.rows.length ? (
          <div className="empty"><div className="ic">🧾</div><p>No EOD captured for {prettyDay(day)} yet.</p></div>
        ) : (
          <>
            {/* Day totals */}
            <div className="card" style={{ padding: '12px 16px', marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>{data.totals.terminals} terminal(s) · {prettyDay(day)}</span>
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

            {/* Per-site roll-up */}
            {data.sites.length > 1 && (
              <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ padding: '9px 14px', background: '#f8fafc', borderBottom: '1px solid var(--line)', fontSize: 12, fontWeight: 800, color: 'var(--muted)' }}>By site</div>
                {data.sites.map((s) => (
                  <div key={s.site_id || s.site} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '9px 14px', borderBottom: '1px solid var(--line)', fontSize: 13 }}>
                    <span><strong>{s.site}</strong> <span style={{ color: 'var(--muted)' }}>· {s.terminals} terminal(s)</span></span>
                    <span style={{ textAlign: 'right' }}>
                      <strong>{ngn(s.eod_total)}</strong>
                      <span style={{ display: 'block', fontSize: 11.5, color: vColor(s.variance) }}>
                        {s.variance > 0 ? '+' : ''}{ngn(s.variance)} vs Daybook
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Each terminal */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {data.rows.map((r) => (
                <div key={r.id} style={{ padding: '11px 14px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ minWidth: 0 }}>
                      <strong>{r.terminal_id || '—'}</strong>
                      <span style={{ color: 'var(--muted)', fontSize: 12.5 }}> · {r.site_name || '—'}{r.bank ? ` · ${r.bank}` : ''}</span>
                    </span>
                    <strong style={{ whiteSpace: 'nowrap' }}>{ngn(r.eod_total)}</strong>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>
                    Card {ngn(r.p_approved)} ({r.p_successful}/{r.p_volume}) · Transfer {ngn(r.t_approved)} ({r.t_approved_n}/{r.t_volume})
                  </div>
                  <div style={{ fontSize: 12, marginTop: 3, color: vColor(r.variance) }}>
                    Daybook {ngn(r.recorded_total)} ({r.recorded_count}) · variance {r.variance > 0 ? '+' : ''}{ngn(r.variance)}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    {r.stored_name && (
                      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '3px 10px' }} onClick={() => viewSlip(r.id)}>🖼 Slip</button>
                    )}
                    {canDelete && (
                      <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '3px 10px', color: '#b91c1c' }} onClick={() => del(r)}>Delete</button>
                    )}
                    {(r.unclear || []).length > 0 && (
                      <span style={{ fontSize: 11.5, color: '#b45309', alignSelf: 'center' }}>⚠ {r.unclear.length} field(s) were unclear</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
    </div>
  );
}
