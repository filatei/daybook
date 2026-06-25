import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, ngn, today, getToken } from '../api.js';
import { useStore, useRole, atLeast, useBackHandler } from '../store.jsx';
import { useBTPrinter } from '../hooks/useBTPrinter.js';
import ReceiptPreview from '../components/ReceiptPreview.jsx';
import OpsForm from './OpsForm.jsx';

const STATUS_LABEL = { DRAFT: 'draft', SUBMITTED: 'submitted', EMAILED: 'emailed' };

// Consolidated morning-report status: which sites have submitted today's ops report.
function MorningReportStatus({ date }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    api(scoped(`/reports/ops/status?date=${encodeURIComponent(date)}`))
      .then((r) => { if (live) setData(r); })
      .catch(() => { if (live) setData({ sites: [] }); });
    return () => { live = false; };
  }, [date]);
  if (!data || !data.sites || data.sites.length <= 1) return null;
  const done = data.sites.filter((s) => s.submitted).length;
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <strong>Morning reports · {date === today() ? 'today' : date}</strong>
        <span style={{ fontWeight: 800 }}>{done}/{data.sites.length} in</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {data.sites.map((s) => (
          <span key={s.site_id} style={{
            fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
            background: s.submitted ? 'rgba(22,163,74,.12)' : (s.has_report ? 'rgba(234,179,8,.14)' : 'var(--surface2, #f3f4f6)'),
            color: s.submitted ? 'var(--ok, #16a34a)' : (s.has_report ? '#a16207' : 'var(--muted)'),
          }} title={s.submitted_at ? new Date(s.submitted_at * 1000).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) : (s.has_report ? 'draft started' : 'not started')}>
            {s.submitted ? '✓' : (s.has_report ? '✎' : '○')} {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

// Files attached to a daily report. Saved with the report and included as email
// attachments whenever the report is emailed (the email routes pull documents by
// report_id). Shown in the report editor and the read-only archive detail.
function ReportAttachments({ reportId, siteId, canEdit = true }) {
  const { toast } = useStore();
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(() => {
    if (!reportId) return;
    api(scoped(`/documents?report_id=${reportId}`)).then((r) => setDocs(Array.isArray(r) ? r : [])).catch(() => setDocs([]));
  }, [reportId]);
  useEffect(() => { load(); }, [load]);

  const onPick = async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append('files', f));
      fd.append('report_id', reportId);
      fd.append('category', 'DAILY_REPORT');
      if (siteId) fd.append('site_id', siteId);
      await api(scoped('/documents'), { method: 'POST', form: fd });
      toast(`Attached ${files.length} file${files.length > 1 ? 's' : ''} ✓`, 'ok');
      load();
    } catch (err) { toast(err.message || 'Upload failed', 'err'); }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const download = async (d) => {
    try {
      const res = await fetch(`/api/documents/${d.id}/download`, { headers: { Authorization: 'Bearer ' + getToken() } });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = d.file_name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) { toast(e.message || 'Could not download', 'err'); }
  };
  const remove = async (d) => {
    try { await api(scoped(`/documents/${d.id}`), { method: 'DELETE' }); load(); }
    catch (e) { toast(e.message || 'Could not remove', 'err'); }
  };

  const fmtSize = (n) => !n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  if (!reportId) {
    return <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>📎 Save the report first, then you can attach files.</div>;
  }
  return (
    <div style={{ marginTop: 12 }}>
      <label className="fl" style={{ marginTop: 0 }}>📎 Attachments <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· emailed with the report</span></label>
      {docs.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>No files attached.</div>}
      {docs.map((d) => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 9, marginBottom: 6 }}>
          <button onClick={() => download(d)} title="Download" style={{ flex: 1, minWidth: 0, border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {d.file_name}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{fmtSize(d.size)}{d.uploader ? ` · ${d.uploader}` : ''}</div>
          </button>
          {canEdit && <button title="Remove" onClick={() => remove(d)} style={{ border: 'none', background: '#fee2e2', color: 'var(--err)', borderRadius: 7, width: 28, height: 28, cursor: 'pointer' }}>✕</button>}
        </div>
      ))}
      {canEdit && (
        <>
          <input ref={fileRef} type="file" multiple onChange={onPick} style={{ display: 'none' }}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.md,.json,.xml,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff,.svg,.heic,.heif,.zip,image/*" />
          <button className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? <span className="spin" /> : '＋ Attach file'}
          </button>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, textAlign: 'center' }}>
            PDF, images, Office docs (Word/Excel/PowerPoint), CSV, text or ZIP · up to 25&nbsp;MB each
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ k, v, accent }) {
  return (
    <div className="stat" style={accent ? { background: '#fffbeb' } : undefined}>
      <div className="k" style={accent ? { color: '#92400e' } : undefined}>{k}</div>
      <div className="v" style={{ fontSize: 18, ...(accent ? { color: '#92400e' } : {}) }}>{v}</div>
    </div>
  );
}

const opsHas = (o) => o && Object.values(o).some((v) => v !== '' && v != null && v !== 0);
// Module-level so its identity is stable across renders (no remount/flicker).
function KV({ title, obj, rows }) {
  if (!opsHas(obj)) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>{title}</div>
      {rows.map(([label, key]) => (obj[key] === '' || obj[key] == null) ? null : (
        <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
          <span style={{ color: 'var(--muted)' }}>{label}</span><span>{String(obj[key])}</span>
        </div>
      ))}
    </div>
  );
}

// Day-operations detail (bags, rolls, crates, water, NEPA hours, generators, RO,
// materials…) — the numbers the site keyed in. Shown in the archive detail so a
// reviewer sees the full report, not just a "captured" note.
function DayOpsView({ ops }) {
  if (!ops || typeof ops !== 'object') return null;
  const txt = (v) => v != null && String(v).trim() !== '';
  const gens = Array.isArray(ops.generators) ? ops.generators.filter((g) => g && g.name) : [];
  const ros = Array.isArray(ops.ro) ? ops.ro.filter((r) => r && (r.unit || r.pure !== '' || r.waste !== '')) : [];

  return (
    <div className="card" style={{ marginTop: 8, padding: '10px 14px' }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>🛠 Day operations</div>
      <KV title="Packing bags" obj={ops.packing} rows={[['Opening', 'opening'], ['Received', 'received'], ['Used for production', 'used_production'], ['Sales bags', 'sales'], ['Re-bagging', 'rebagging'], ['Damage replacement', 'damage_replacement'], ['Available', 'available']]} />
      <KV title="Bag adjustments" obj={ops.bags} rows={[['Leakage', 'leakage'], ['Staff water', 'staff_water'], ['Extra / bonus', 'extra'], ['Re-bagging', 'rebagging'], ['Damage', 'damage']]} />
      <KV title="Rolls (number / kg)" obj={ops.rolls} rows={[['Opening (no.)', 'opening_count'], ['Opening (kg)', 'opening_kg'], ['Received (no.)', 'received_count'], ['Received (kg)', 'received_kg'], ['Used (no.)', 'used_count'], ['Used (kg)', 'used_kg'], ['Available (no.)', 'available_count'], ['Available (kg)', 'available_kg']]} />
      <KV title="Crates" obj={ops.crates} rows={[['50cl available', 'c50_available'], ['50cl sold', 'c50_sold'], ['60cl available', 'c60_available'], ['75cl available', 'c75_available'], ['Dispenser available', 'dispenser_available']]} />
      <KV title="Water analysis" obj={ops.water} rows={[['PH', 'ph'], ['TDS', 'tds']]} />
      <KV title="Public power (NEPA)" obj={ops.power} rows={[['NEPA hours today', 'nepa_hours']]} />
      {gens.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>Generator status</div>
          {gens.map((g, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
              <span>{g.name}</span><span style={{ fontWeight: 600 }}>{g.status || '—'}</span>
            </div>
          ))}
        </div>
      )}
      {ros.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>RO readings</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px', gap: 4, fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>
            <span>Unit</span><span style={{ textAlign: 'right' }}>Pure</span><span style={{ textAlign: 'right' }}>Waste</span>
          </div>
          {ros.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px', gap: 4, fontSize: 13, padding: '2px 0' }}>
              <span>{r.unit || '—'}</span><span style={{ textAlign: 'right' }}>{String(r.pure ?? '')}</span><span style={{ textAlign: 'right' }}>{String(r.waste ?? '')}</span>
            </div>
          ))}
        </div>
      )}
      {txt(ops.materials) && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>Materials supplied to other locations</div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{ops.materials}</div>
        </div>
      )}
      {txt(ops.expired_docs) && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 2 }}>Expired documents</div>
          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{ops.expired_docs}</div>
        </div>
      )}
    </div>
  );
}

// Bag (finished water) stock — day running balance with the LESS breakdown
// matching the site's paper report. Lets a manager set the opening B/F once.
function BagReportCard({ bagReport: r, siteId }) {
  const { toast } = useStore();
  const role = useRole();
  const canSeed = role && atLeast(role, 'SITE_MANAGER');
  const [openSeed, setOpenSeed] = useState(false);
  const [qty, setQty] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [saving, setSaving] = useState(false);
  const n = (v) => (Number(v) || 0).toLocaleString();
  const line = (k, v, opts = {}) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0', ...opts }}>
      <span style={{ color: 'var(--muted)' }}>{k}</span><span>{v}</span>
    </div>
  );
  const saveSeed = async () => {
    setSaving(true);
    try {
      await api(scoped('/reports/fg-opening'), { method: 'PUT', body: { site: siteId, opening_qty: Number(qty) || 0, as_of_date: asOf } });
      toast('Opening stock set ✓ — regenerate to update', 'ok');
      setOpenSeed(false);
      window.dispatchEvent(new CustomEvent('fg-opening-saved'));
    } catch (e) { toast(e.message || 'Save failed', 'err'); }
    setSaving(false);
  };
  const ded = (r.sold || 0) + (r.extra || 0) + (r.staff || 0) + (r.incentive || 0) + (r.leakage || 0);
  return (
    <div className="card" style={{ marginTop: 8, padding: '10px 14px' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>Production — {r.product || 'bags'}</div>
      {line('Bags B/F (opening)', n(r.opening))}
      {line('Produced', n(r.produced))}
      {line('Total', n(r.total), { fontWeight: 700 })}
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>Less:</div>
      {line('Sales', n(r.sold))}
      {(r.extra || 0) > 0 && line('Extra / bonus', n(r.extra))}
      {(r.staff || 0) > 0 && line('Staff water', n(r.staff))}
      {(r.incentive || 0) > 0 && line('Incentive', n(r.incentive))}
      {(r.leakage || 0) > 0 && line('Leakage', n(r.leakage))}
      {line('Total deductions', `(${n(ded)})`, { color: 'var(--err)' })}
      {line('Available', n(r.available), { fontWeight: 800, borderTop: '1px solid var(--line)', paddingTop: 4, marginTop: 2 })}

      {!r.seeded ? (
        <div style={{ marginTop: 8, fontSize: 12 }}>
          <div style={{ color: 'var(--err)' }}>⚠️ Opening stock (B/F) not set — balance starts from today.</div>
          {canSeed && siteId && !openSeed && <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => setOpenSeed(true)}>Set opening B/F</button>}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>Running balance since {r.as_of}. Available = B/F + produced − (sales + extra + staff + incentive + leakage).{canSeed && siteId && !openSeed ? <> · <a role="button" tabIndex={0} style={{ cursor: 'pointer', color: 'var(--brand)' }} onClick={() => setOpenSeed(true)}>adjust B/F</a></> : null}</div>
      )}

      {openSeed && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', marginTop: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 110px' }}>
            <label className="fl" style={{ marginTop: 0, fontSize: 11 }}>Opening bags (B/F)</label>
            <input type="number" inputMode="numeric" className="input" value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <div style={{ flex: '1 1 130px' }}>
            <label className="fl" style={{ marginTop: 0, fontSize: 11 }}>As of date</label>
            <input type="date" className="input" value={asOf} max={today()} onChange={(e) => setAsOf(e.target.value)} />
          </div>
          <button className="btn btn-sm" style={{ width: 'auto', padding: '0 14px' }} onClick={saveSeed} disabled={saving}>{saving ? <span className="spin" /> : 'Save'}</button>
        </div>
      )}
    </div>
  );
}

// Rich read-only body of a generated/saved daily report — shared by the
// Generate modal and the archive detail view so they always render identically.
function GeneratedReportBody({ gen, ov = null }) {
  // When the user is correcting stock totals, show their live values.
  const ovPacking = ov && ov.packing_available !== '' ? Number(ov.packing_available) : null;
  const ovRollsKg = ov && ov.rolls_available_kg !== '' ? Number(ov.rolls_available_kg) : null;
  const s = gen?.summary;
  if (!gen || !s) return null;
  return (
    <>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{gen.site_name} · {gen.report_date}</div>
      <div className="stat-grid" style={{ marginBottom: 8 }}>
        <Stat k="Total Sales" v={ngn(s.totalSales)} />
        <Stat k="Orders" v={(s.orders || 0).toLocaleString()} />
        <Stat k="Cash" v={ngn(s.cash)} />
        <Stat k="POS / Card" v={ngn(s.pos)} />
        <Stat k="Transfer" v={ngn(s.transfer)} />
        {s.incentive > 0 && <Stat k="🎁 Incentive (bonus)" v={ngn(s.incentive)} accent />}
      </div>

      {(s.totalLoaded > 0 || s.totalBagged > 0) && (
        <div className="card" style={{ marginTop: 8, padding: '10px 14px' }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Production — loaded {s.totalLoaded.toLocaleString()} · bagged {s.totalBagged.toLocaleString()}</div>
          {s.loaders.length > 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>Loaders</div>}
          {s.loaders.map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
              <span>{l.name}</span><span style={{ fontWeight: 600 }}>{l.loaded.toLocaleString()} loaded</span>
            </div>
          ))}
          {s.baggers.length > 0 && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>Baggers</div>}
          {s.baggers.map((b, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
              <span>{b.name}</span><span style={{ fontWeight: 600 }}>{b.bagged.toLocaleString()} bagged</span>
            </div>
          ))}
        </div>
      )}

      {s.bagReport && <BagReportCard bagReport={s.bagReport} siteId={gen.site_id} />}

      {(s.diesel > 0 || s.expenses > 0) && (
        <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--muted)', margin: '8px 2px' }}>
          <span>Diesel: <strong style={{ color: 'var(--ink)' }}>{ngn(s.diesel)}</strong></span>
          <span>Other expenses: <strong style={{ color: 'var(--ink)' }}>{ngn(s.expenses)}</strong></span>
        </div>
      )}

      {gen.scope === 'ALL' && (gen.bySite || []).some((r) => r.totalSales > 0 || r.incentive > 0) && (
        <div className="card" style={{ marginTop: 8, padding: '10px 14px' }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Sales distribution</div>
          {(gen.bySite || []).filter((r) => r.totalSales > 0 || r.incentive > 0).sort((a, b) => b.totalSales - a.totalSales).map((r) => (
            <div key={r.site_id || r.site_name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', borderTop: '1px solid var(--line)' }}>
              <span>{r.site_name}</span>
              <span style={{ fontWeight: 600 }}>{ngn(r.totalSales)}{r.incentive > 0 ? ` · 🎁${ngn(r.incentive)}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      {gen.scope === 'ALL' && gen.summary?.bagBySite && gen.summary.bagBySite.length > 0 && (
        <div className="card" style={{ marginTop: 8, padding: '10px 14px' }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Bags — all sites <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)' }}>(sold excl. bonus)</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px', gap: 4, fontSize: 11, color: 'var(--muted)', fontWeight: 700, borderBottom: '1px solid var(--line)', paddingBottom: 3 }}>
            <span>Site</span><span style={{ textAlign: 'right' }}>Sold</span><span style={{ textAlign: 'right' }}>Avail</span>
          </div>
          {gen.summary.bagBySite.map((r) => (
            <div key={r.site_id} style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px', gap: 4, fontSize: 13, padding: '2px 0' }}>
              <span>{r.site_name}</span><span style={{ textAlign: 'right' }}>{(r.sold || 0).toLocaleString()}</span><span style={{ textAlign: 'right' }}>{(r.available || 0).toLocaleString()}</span>
            </div>
          ))}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px', gap: 4, fontSize: 13, fontWeight: 800, borderTop: '1px solid var(--line)', paddingTop: 3 }}>
            <span>Total</span><span style={{ textAlign: 'right' }}>{(gen.summary.bagTotals?.sold || 0).toLocaleString()}</span><span style={{ textAlign: 'right' }}>{(gen.summary.bagTotals?.available || 0).toLocaleString()}</span>
          </div>
          {gen.summary.stockTotals && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
              Packing bags: used {(gen.summary.stockTotals.packing_used || 0).toLocaleString()} · avail {((ovPacking != null ? ovPacking : gen.summary.stockTotals.packing_available) || 0).toLocaleString()} · Rolls: used {(gen.summary.stockTotals.rolls_used_count || 0).toLocaleString()} ({(gen.summary.stockTotals.rolls_used_kg || 0).toLocaleString()}kg) · avail {(gen.summary.stockTotals.rolls_available_count || 0).toLocaleString()} ({((ovRollsKg != null ? ovRollsKg : gen.summary.stockTotals.rolls_available_kg) || 0).toLocaleString()}kg)
            </div>
          )}
        </div>
      )}

      {gen.scope !== 'ALL' && (gen.summary?.ops
        ? <DayOpsView ops={gen.summary.ops} />
        : (
          <div style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 2px' }}>
            No day operations captured yet — use 🛠 Day ops to add bags/rolls/generators/RO.
          </div>
        ))}
    </>
  );
}

// Read-only archive view of one saved daily report. Re-derives the rich detail
// from /reports/generate for that site+date, then shows status + saved notes.
function ReportDetail({ report, canEdit, onEdit, onClose }) {
  const { toast } = useStore();
  const [gen, setGen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [emailing, setEmailing] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const qs = new URLSearchParams({ date: report.report_date });
        if (report.site_id) qs.set('site', report.site_id);
        const r = await api(scoped(`/reports/generate?${qs}`));
        if (alive) setGen(r);
      } catch (e) { if (alive) toast(e.message || 'Could not load report', 'err'); }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [report.report_date, report.site_id]);

  const emailReport = async () => {
    if (emailing) return;   // ignore repeat taps — send exactly once
    setEmailing(true);
    try {
      const r = await api(scoped('/reports/generate/email'), { method: 'POST', body: { date: report.report_date, site: report.site_id || 'ALL', incidents: (report.notes || '').trim() } });
      const who = (r.to || []).join(', ');
      if (r.queued) toast(`Report queued — sending shortly to ${who}`, 'info');
      else toast(`Report emailed ✓ → ${who}`, 'ok');
    } catch (e) { toast(e.message || 'Email failed', 'err'); }
    setEmailing(false);
  };

  return (
    <div>
      <div className="grip" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{report.site_name}</h3>
        <span className={`badge ${STATUS_LABEL[report.status] || 'draft'}`}>{report.status}</span>
      </div>
      <p className="sub" style={{ marginTop: 2 }}>
        {report.report_date}{report.tenant_name ? ` · ${report.tenant_name}` : ''}
        {report.emailed_at ? ' · ✉️ emailed' : ''}
      </p>

      {loading ? <div className="skel" style={{ marginTop: 12 }} /> : (
        <>
          <GeneratedReportBody gen={gen} />
          {report.notes && (
            <div className="card" style={{ marginTop: 8, padding: '10px 14px' }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Incidents / notes</div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: 'var(--ink)' }}>{report.notes}</div>
            </div>
          )}
          <ReportAttachments reportId={report.id} siteId={report.site_id} canEdit={canEdit} />
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Close</button>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={emailReport} disabled={emailing}>{emailing ? <><span className="spin" /> Sending…</> : '✉️ Email'}</button>
            {canEdit && <button className="btn" style={{ flex: '1 1 100%' }} onClick={onEdit}>✎ Edit report</button>}
          </div>
        </>
      )}
    </div>
  );
}

function ReportForm({ report, sites, onSave, onClose }) {
  const { toast, setDirty } = useStore();
  const role = useRole();
  const isGM = atLeast(role, 'GENERAL_MANAGER');
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    report_date: report?.report_date || today(),
    site_id: report?.site_id || sites[0]?.id || '',
    total_cash: report?.total_cash ?? '',
    total_deposit: report?.total_deposit ?? '',
    diesel: report?.diesel ?? '',
    expenses: report?.expenses ?? '',
    sales: report?.sales_json ? JSON.parse(report.sales_json) : [{ label: 'Pump Sales', amount: '' }],
    notes: report?.notes || '',
    submit: false,
  });

  const setField = (k, v) => { setDirty(true); setF((p) => ({ ...p, [k]: v })); };
  const totalSales = f.sales.reduce((s, l) => s + (+l.amount || 0), 0);

  const save = async (submit = false) => {
    setSaving(true);
    try {
      const body = { ...f, submit };
      if (report?.id) {
        await api(scoped(`/reports/${report.id}`), { method: 'PATCH', body });
      } else {
        await api(scoped('/reports'), { method: 'POST', body });
      }
      toast(submit ? 'Report submitted ✓' : 'Saved', 'ok');
      onSave();
      onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3>{report?.id ? 'Edit Report' : 'New Report'}</h3>
      <p className="sub">{f.report_date} · {sites.find((s) => s.id === f.site_id)?.name}</p>

      <div className="grid2">
        <div>
          <label className="fl">Date</label>
          <input type="date" className="input" value={f.report_date} max={today()}
            onChange={(e) => setField('report_date', e.target.value)} />
        </div>
        {(isGM || sites.length > 1) && (
          <div>
            <label className="fl">Site</label>
            <select className="input" value={f.site_id} onChange={(e) => setField('site_id', e.target.value)}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <label className="fl">Sales lines</label>
      {f.sales.map((line, i) => (
        <div className="line" key={i}>
          <input className="input" placeholder="Label" value={line.label}
            onChange={(e) => setF((p) => { const s = [...p.sales]; s[i] = { ...s[i], label: e.target.value }; return { ...p, sales: s }; })} />
          <input className="input" type="number" inputMode="decimal" placeholder="0" value={line.amount}
            onChange={(e) => setF((p) => { const s = [...p.sales]; s[i] = { ...s[i], amount: e.target.value }; return { ...p, sales: s }; })} />
          <button className="x" onClick={() => setF((p) => ({ ...p, sales: p.sales.filter((_, j) => j !== i) }))}>✕</button>
        </div>
      ))}
      <button className="btn btn-ghost btn-sm" style={{ marginBottom: 12 }}
        onClick={() => setF((p) => ({ ...p, sales: [...p.sales, { label: '', amount: '' }] }))}>
        + Add line
      </button>

      <div className="grid2">
        <div>
          <label className="fl">Cash Received</label>
          <input type="number" className="input" value={f.total_cash} onChange={(e) => setField('total_cash', e.target.value)} />
        </div>
        <div>
          <label className="fl">Deposit</label>
          <input type="number" className="input" value={f.total_deposit} onChange={(e) => setField('total_deposit', e.target.value)} />
        </div>
        <div>
          <label className="fl">Diesel</label>
          <input type="number" className="input" value={f.diesel} onChange={(e) => setField('diesel', e.target.value)} />
        </div>
        <div>
          <label className="fl">Other Expenses</label>
          <input type="number" className="input" value={f.expenses} onChange={(e) => setField('expenses', e.target.value)} />
        </div>
      </div>

      <label className="fl">Notes</label>
      <textarea className="input" rows={3} value={f.notes} onChange={(e) => setField('notes', e.target.value)} />

      <div style={{ background: 'var(--brand-l)', borderRadius: 12, padding: '10px 14px', margin: '12px 0', fontWeight: 700 }}>
        Total Sales: {ngn(totalSales)}
      </div>

      <ReportAttachments reportId={report?.id} siteId={report?.site_id || f.site_id} />

      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={() => save(false)} disabled={saving}>Save draft</button>
        <button className="btn" onClick={() => save(true)} disabled={saving}>
          {saving ? <span className="spin" /> : null} Submit
        </button>
      </div>
    </div>
  );
}

// Auto-generate a daily report from the day's data — sales by cash/POS/transfer,
// incentive, production per loader/bagger — then add incidents and submit.
function GenerateReportModal({ sites, siteBound, onSaved, onClose }) {
  const { toast } = useStore();
  const [date, setDate] = useState(today());
  const [siteId, setSiteId] = useState(siteBound ? '' : 'ALL');   // default to the global roll-up
  const [gen, setGen] = useState(null);
  const [loading, setLoading] = useState(false);
  const [incidents, setIncidents] = useState('');
  const [saving, setSaving] = useState(false);
  const [emailing, setEmailing] = useState(false);
  // Manual corrections for the two stock figures that can't be auto-derived.
  const [ov, setOv] = useState({ packing_available: '', rolls_available_kg: '' });

  const generate = async () => {
    setLoading(true); setGen(null);
    try {
      const qs = new URLSearchParams({ date });
      if (!siteBound && siteId) qs.set('site', siteId);
      const g = await api(scoped(`/reports/generate?${qs}`));
      setGen(g);
      const st = g?.summary?.stockTotals;
      if (g?.scope === 'ALL') {
        setOv({
          packing_available: st?.packing_available ?? '',
          rolls_available_kg: st?.rolls_available_kg ?? '',
        });
      }
    } catch (e) { toast(e.message || 'Could not generate', 'err'); }
    setLoading(false);
  };
  // Re-generate after the opening B/F is set so the stock figures update.
  useEffect(() => {
    const h = () => { if (gen) generate(); };
    window.addEventListener('fg-opening-saved', h);
    return () => window.removeEventListener('fg-opening-saved', h);
  });

  const emailReport = async () => {
    if (emailing) return;   // ignore repeat taps — send exactly once
    setEmailing(true);
    try {
      // Auto-save the manual stock corrections first so the emailed report uses them.
      if (gen?.scope === 'ALL') {
        await api(scoped('/reports/stock-override'), { method: 'PUT', body: { date, packing_available: ov.packing_available, rolls_available_kg: ov.rolls_available_kg } }).catch(() => {});
      }
      const r = await api(scoped('/reports/generate/email'), { method: 'POST', body: { date, site: siteId, incidents: incidents.trim() } });
      const who = (r.to || []).join(', ');
      if (r.queued) toast(`Report queued — sending shortly to ${who}`, 'info');
      else toast(`Report emailed ✓ → ${who}`, 'ok');
    } catch (e) { toast(e.message || 'Email failed', 'err'); }
    setEmailing(false);
  };

  const save = async (submit) => {
    if (!gen) return;
    setSaving(true);
    try {
      await api(scoped('/reports'), { method: 'POST', body: { ...gen.prefill, notes: incidents.trim() || null, submit } });
      toast(submit ? 'Report submitted ✓' : 'Saved as draft', 'ok');
      onSaved(); onClose();
    } catch (e) { toast(e.message || 'Save failed', 'err'); }
    setSaving(false);
  };

  const s = gen?.summary;

  return (
    <div onClick={() => !saving && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 130 }}>
      <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 460, margin: 0, maxHeight: '92vh', overflowY: 'auto', borderRadius: '20px 20px 0 0', paddingBottom: 'calc(16px + var(--safe-b))' }}>
        <div className="grip" />
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>Generate daily report</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>Auto-built from the day's sales, production and expenses. Add incidents, then submit.</p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <label className="fl">Date</label>
            <input type="date" className="input" value={date} max={today()} onChange={(e) => { setDate(e.target.value); setGen(null); }} />
          </div>
          {!siteBound && sites.length > 0 && (
            <div style={{ flex: 1 }}>
              <label className="fl">Site</label>
              <select className="input" value={siteId} onChange={(e) => { setSiteId(e.target.value); setGen(null); }}>
                <option value="ALL">🌍 All sites</option>
                {sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
          )}
        </div>
        <button className="btn" onClick={generate} disabled={loading} style={{ marginBottom: 12 }}>
          {loading ? <span className="spin" /> : '✨ '}{gen ? 'Regenerate' : 'Generate'}
        </button>

        {gen && s && (
          <>
            <GeneratedReportBody gen={gen} ov={gen.scope === 'ALL' ? ov : null} />

            {gen.scope === 'ALL' && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Correct stock totals</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>The auto figures below can be off — enter the real totals; they’re saved and used in the email.</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label className="fl">Total available packing bags</label>
                    <input type="number" inputMode="decimal" className="input" value={ov.packing_available}
                      onChange={(e) => setOv((p) => ({ ...p, packing_available: e.target.value }))} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="fl">Total available rolls (kg)</label>
                    <input type="number" inputMode="decimal" className="input" value={ov.rolls_available_kg}
                      onChange={(e) => setOv((p) => ({ ...p, rolls_available_kg: e.target.value }))} />
                  </div>
                </div>
              </div>
            )}

            <label className="fl">Incidents / notes</label>
            <textarea className="input" rows={3} value={incidents} onChange={(e) => setIncidents(e.target.value)}
              placeholder="Anything notable today — incidents, breakdowns, shortages…" />

            {gen.scope === 'ALL' ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Close</button>
                <button className="btn" style={{ flex: 1 }} onClick={emailReport} disabled={emailing}>{emailing ? <><span className="spin" /> Sending…</> : '✉️ Email report'}</button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => save(false)} disabled={saving}>Save draft</button>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={emailReport} disabled={emailing}>{emailing ? <><span className="spin" /> Sending…</> : '✉️ Email'}</button>
                <button className="btn" style={{ flex: '1 1 100%' }} onClick={() => save(true)} disabled={saving}>{saving ? <span className="spin" /> : 'Submit'}</button>
              </div>
            )}
          </>
        )}
        {!gen && <button className="btn btn-ghost" onClick={onClose}>Cancel</button>}
      </div>
    </div>
  );
}

export default function Reports() {
  const { openModal, closeModal, sites, tenant, tenants, toast } = useStore();
  const role = useRole();
  const isSM = role && !atLeast(role, 'SNR_ACCOUNTANT');   // site-bound = below Snr Accountant
  const isGM = atLeast(role, 'GENERAL_MANAGER');
  const bt = useBTPrinter();
  const activeTenant = (tenants || []).find((t) => String(t.id) === String(tenant));
  const [reports, setReports] = useState([]);
  const [pos, setPos] = useState(null);
  const [orders, setOrders] = useState([]);
  const [orderQ, setOrderQ] = useState('');
  const [viewOrder, setViewOrder] = useState(null);   // order open in the receipt modal
  const [readOnly, setReadOnly] = useState(false);    // fido drill-down orders can't be deleted
  const [askDelete, setAskDelete] = useState(false);  // animated delete confirm step
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState(null);           // orders drill-down list (or null = closed)
  const [drillLoading, setDrillLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  // Default the report to today (start + end). User can widen the range or
  // clear both dates / tap "All time" for the lifetime totals.
  const [filters, setFilters] = useState({ site: '', from: today(), to: today() });
  const [genOpen, setGenOpen] = useState(false);
  // Hardware Back steps up one level (close detail → close drill list) not exit.
  useBackHandler(genOpen, () => setGenOpen(false));
  useBackHandler(!!drill, () => setDrill(null));
  useBackHandler(!!viewOrder, () => { setViewOrder(null); setReadOnly(false); });
  useBackHandler(askDelete, () => setAskDelete(false));   // deepest sub-step first

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.site) params.set('site', filters.site);
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      const [data, posData, ord] = await Promise.all([
        api(scoped(`/reports?${params}`)),
        api(scoped(`/pos/range?${params}`)).catch(() => null),  // imported + live POS sales
        api(scoped(`/pos/sales?source=app&${params}`)).catch(() => []),  // in-app orders only
      ]);
      setReports(data); setPos(posData); setOrders(ord || []);
    } catch { setReports([]); }
    setLoading(false);
  }, [tenant, filters]);

  // Build the print/preview payload for an order row (tolerates both the in-app
  // pos_sales shape and the live-fido /pos/orders shape).
  const receiptOf = (o) => {
    const when = o.created_at ? new Date(o.created_at * 1000) : (o.at ? new Date(o.at) : new Date(`${o.sale_date}T00:00:00`));
    let items = Array.isArray(o.items) ? o.items : [];
    if (!Array.isArray(o.items) && o.items_json) { try { items = JSON.parse(o.items_json); } catch { items = []; } }
    const total = o.total ?? o.amount ?? 0;
    return {
      company: activeTenant?.name || 'FIDO WATER',
      site_name: o.site_name || o.site || null,
      receipt_no: o.receipt_no ?? o.order_no,
      date_str: when.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' }),
      time_str: when.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }),
      items,
      total,
      payment_method: o.payment_method,
      amount_paid: o.amount_paid ?? total,
      change: Math.max(0, (o.amount_paid || 0) - total),
      customer_name: o.customer_name || o.customer || null,
      served_by: o.sold_by_name || null,
    };
  };

  const openOrder = (o, deleteFirst = false, ro = false) => { setViewOrder(o); setAskDelete(deleteFirst); setReadOnly(ro); };
  const closeOrder = () => { setViewOrder(null); setAskDelete(false); setBusy(false); setReadOnly(false); };

  // Drill-down: list all individual orders for the current range + site.
  const openOrdersList = async () => {
    setDrill([]); setDrillLoading(true);
    try {
      const p = new URLSearchParams();
      if (filters.site) p.set('site', filters.site);
      p.set('from', filters.from || today());
      p.set('to', filters.to || today());
      setDrill(await api(scoped(`/pos/orders?${p}`)));
    } catch { setDrill([]); }
    setDrillLoading(false);
  };

  const printViewed = async () => {
    if (!viewOrder) return;
    setBusy(true);
    try {
      if (bt.status !== 'ready') await bt.connect();   // user gesture → connect printer
      await bt.print(receiptOf(viewOrder));
      toast(`Receipt #${viewOrder.receipt_no} printed ✓`, 'ok');
    } catch (e) { toast(e.message || 'Print failed', 'err'); }
    setBusy(false);
  };

  const confirmDelete = async () => {
    if (!viewOrder) return;
    setBusy(true);
    try {
      await api(scoped(`/pos/sales/${viewOrder.id}`), { method: 'DELETE' });
      setOrders((p) => p.filter((x) => x.id !== viewOrder.id));
      toast('Order deleted', 'ok');
      closeOrder();
    } catch (e) { toast(e.message || 'Delete failed', 'err'); setBusy(false); }
  };

  const shownOrders = orders.filter((o) => {
    const q = orderQ.trim().toLowerCase(); if (!q) return true;
    return String(o.receipt_no).includes(q)
      || (o.customer_name || '').toLowerCase().includes(q)
      || (o.sold_by_name || '').toLowerCase().includes(q);
  });

  useEffect(() => { load(); }, [load]);

  const openForm = (report = null) => {
    openModal(
      <ReportForm
        report={report}
        sites={sites}
        onSave={load}
        onClose={closeModal}
      />,
      { guard: true }
    );
  };

  // Tapping a saved report opens its full read-only detail (the archive view).
  // From there the user can Email it or jump into Edit. Site-bound staff can
  // edit their own site's reports; everyone Snr Accountant+ can edit any.
  const openDetail = (report) => {
    openModal(
      <ReportDetail
        report={report}
        canEdit={!isSM || String(report.site_id) === String(sites[0]?.id)}
        onEdit={() => { closeModal(); openForm(report); }}
        onClose={closeModal}
      />,
      { guard: true }
    );
  };

  return (
    <div>
      {/* Filters row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input type="date" className="input" style={{ flex: '1 1 120px' }}
          value={filters.from} onChange={(e) => setFilters((p) => ({ ...p, from: e.target.value }))} />
        <input type="date" className="input" style={{ flex: '1 1 120px' }}
          value={filters.to} onChange={(e) => setFilters((p) => ({ ...p, to: e.target.value }))} />
        {!isSM && sites.length > 1 && (
          <select className="input" style={{ flex: '1 1 140px' }}
            value={filters.site} onChange={(e) => setFilters((p) => ({ ...p, site: e.target.value }))}>
            <option value="">All sites</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          <button className={`btn btn-ghost btn-sm${filters.from === today() && filters.to === today() ? ' on' : ''}`} style={{ width: 'auto', padding: '0 12px' }}
            onClick={() => setFilters((p) => ({ ...p, from: today(), to: today() }))}>Today</button>
          <button className={`btn btn-ghost btn-sm${!filters.from && !filters.to ? ' on' : ''}`} style={{ width: 'auto', padding: '0 12px' }}
            onClick={() => setFilters((p) => ({ ...p, from: '', to: '' }))}>All time</button>
        </div>
      </div>

      {/* End-of-day: auto-generate a daily report from the app's data */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="btn" style={{ flex: 1 }} onClick={() => setGenOpen(true)}>✨ Generate daily report</button>
        <button className="btn btn-ghost" style={{ flex: '0 0 auto' }} onClick={() => openModal(
          <OpsForm sites={sites} siteBound={isSM} defaultDate={filters.from || today()} defaultSite={filters.site} onClose={closeModal} />, { guard: true })}>🛠 Day ops</button>
      </div>

      {/* Who has submitted the morning report (all-sites overview) */}
      {!isSM && (
        <MorningReportStatus date={(filters.from && filters.from === filters.to) ? filters.from : today()} />
      )}

      {/* POS sales summary (imported Fido history + live in-app sales) */}
      {pos && pos.totals.orders > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <strong>POS sales · {(!filters.from && !filters.to) ? 'all time'
              : (filters.from && filters.to && filters.from === filters.to) ? (filters.from === today() ? 'today' : filters.from)
              : `${filters.from || '…'} → ${filters.to || '…'}`}</strong>
            <span style={{ fontWeight: 800 }}>{ngn(pos.totals.sales)}</span>
          </div>
          <div className="stat-grid" style={{ marginBottom: pos.bySite.length > 1 ? 8 : 0 }}>
            <button className="stat" onClick={openOrdersList} style={{ cursor: 'pointer', textAlign: 'left', border: '1px solid var(--brand-l)' }} title="Tap to list orders">
              <div className="k">Orders ›</div><div className="v" style={{ fontSize: 18 }}>{pos.totals.orders.toLocaleString()}</div>
            </button>
            <div className="stat"><div className="k">Cash</div><div className="v" style={{ fontSize: 18 }}>{ngn(pos.totals.cash)}</div></div>
            <div className="stat"><div className="k">Transfer/POS</div><div className="v" style={{ fontSize: 18 }}>{ngn(pos.totals.transfer)}</div></div>
          </div>
          {pos.bySite.length > 1 && pos.bySite.map((b) => (
            <div key={b.code} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
              <span style={{ color: 'var(--muted)' }}>{b.site}</span>
              <span style={{ fontWeight: 600 }}>{ngn(b.sales)} · {b.orders.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* In-app orders — search, reprint, delete */}
      {!loading && orders.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
            <strong style={{ fontSize: 14 }}>In-app orders</strong>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{shownOrders.length}/{orders.length}</span>
          </div>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
            <input className="input" placeholder="Search receipt #, customer or cashier…"
              value={orderQ} onChange={(e) => setOrderQ(e.target.value)} />
          </div>
          {shownOrders.length === 0 ? (
            <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--muted)' }}>No matching orders</div>
          ) : shownOrders.map((o) => (
            <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
              <button onClick={() => openOrder(o)} title="View receipt"
                style={{ flex: 1, minWidth: 0, border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
                <div style={{ fontWeight: 700 }}>#{String(o.receipt_no).padStart(4, '0')} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>{o.customer_name || 'Walk-in'}</span></div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {o.sale_date} · {o.site_name || '—'} · {o.payment_method}{o.sold_by_name ? ` · ${o.sold_by_name}` : ''}
                </div>
              </button>
              <div style={{ fontWeight: 800, whiteSpace: 'nowrap', marginRight: 4 }}>{ngn(o.total)}</div>
              <button title="Print receipt" onClick={() => openOrder(o)}
                style={{ border: 'none', background: '#e0f2fe', color: '#0369a1', borderRadius: 7, width: 30, height: 30, fontSize: 15, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>🖨</button>
              {isGM && (
                <button title="Delete order" onClick={() => openOrder(o, true)}
                  style={{ border: 'none', background: '#fee2e2', color: 'var(--err)', borderRadius: 7, width: 30, height: 30, fontSize: 15, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>🗑</button>
              )}
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : reports.length === 0 ? (
        <div className="empty"><div className="ic">🧾</div><p>{pos && pos.totals.orders > 0 ? 'No daily reports yet — POS sales shown above' : 'No reports found'}</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
            <strong style={{ fontSize: 14 }}>📑 Daily report archive</strong>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {(!filters.from && !filters.to) ? 'all dates'
                : (filters.from && filters.from === filters.to) ? (filters.from === today() ? 'today' : filters.from)
                : `${filters.from || '…'} → ${filters.to || '…'}`} · {reports.length}
            </span>
          </div>
          {reports.map((r) => (
            <button key={r.id} onClick={() => openDetail(r)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{r.site_name} <span className={`badge ${STATUS_LABEL[r.status] || 'draft'}`}>{r.status}</span></div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{r.report_date} · {r.tenant_name}</div>
              </div>
              <div style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{ngn(r.total_sales)}</div>
            </button>
          ))}
        </div>
      )}

      <button className="fab" onClick={() => openForm()}>+</button>

      {genOpen && <GenerateReportModal sites={sites} siteBound={isSM} onSaved={load} onClose={() => setGenOpen(false)} />}

      {/* Orders drill-down — list every order for the range + site */}
      {drill !== null && (
        <div onClick={() => setDrill(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 110, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, margin: 0, maxHeight: '86vh', overflowY: 'auto', padding: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: '#fff' }}>
              <strong>Orders {filters.site ? `· ${sites.find((s) => s.id === filters.site)?.name || ''}` : ''}</strong>
              <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => setDrill(null)}>✕</button>
            </div>
            {drillLoading ? (
              <div style={{ padding: 16 }}>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</div>
            ) : drill.length === 0 ? (
              <div className="empty" style={{ padding: 24 }}><div className="ic">🧾</div><p>No orders in this range</p></div>
            ) : drill.map((o) => (
              <button key={o.id} onClick={() => { setDrill(null); openOrder(o, false, true); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', borderBottom: '1px solid var(--line)', width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{o.order_no ? `#${o.order_no}` : '—'} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>{o.customer || 'Walk-in'}</span></div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{o.payment_method}{o.items?.length ? ` · ${o.items.length} item${o.items.length > 1 ? 's' : ''}` : ''} · {o.at ? new Date(o.at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }) : ''}</div>
                </div>
                <div style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{ngn(o.amount)}</div>
                <span style={{ color: 'var(--muted)' }}>›</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Order receipt modal — preview, print (with confirm), animated delete */}
      {viewOrder && (
        <div onClick={closeOrder}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 120, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 340, margin: 0, maxHeight: '90vh', overflowY: 'auto' }}>
            <ReceiptPreview receipt={receiptOf(viewOrder)} />

            {!askDelete ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
                <button className="btn" onClick={printViewed} disabled={busy}>
                  {busy ? <span className="spin" /> : '🖨 '}{bt.status === 'ready' ? 'Print receipt' : 'Connect printer & print'}
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ flex: 1 }} onClick={closeOrder} disabled={busy}>Close</button>
                  {isGM && !readOnly && (
                    <button className="btn" style={{ flex: 1, background: '#fee2e2', color: 'var(--err)' }} onClick={() => setAskDelete(true)} disabled={busy}>🗑 Delete</button>
                  )}
                </div>
              </div>
            ) : (
              <div className="pop-in" style={{ marginTop: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: 14, textAlign: 'center' }}>
                <div style={{ fontWeight: 700, color: '#991b1b' }}>Delete order #{viewOrder.receipt_no}?</div>
                <div style={{ fontSize: 13, color: '#b91c1c', margin: '4px 0 12px' }}>{ngn(viewOrder.total)} · stock will be restored. This cannot be undone.</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setAskDelete(false)} disabled={busy}>Cancel</button>
                  <button className="btn" style={{ flex: 1, background: 'var(--err)' }} onClick={confirmDelete} disabled={busy}>
                    {busy ? <span className="spin" /> : 'Delete'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
