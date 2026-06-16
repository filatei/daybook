import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api, scoped, today, getToken } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';
import { useFaceLiveness, faceDistance, FACE_MATCH_THRESHOLD } from '../hooks/useFaceLiveness.js';
import BarcodeScanner from '../components/BarcodeScanner.jsx';

// ── Badge clock-in/out — scan a staff badge to toggle attendance ──────────────
function BadgeClock() {
  const { toast } = useStore();
  const [scanning, setScanning] = useState(false);
  const [last, setLast] = useState(null);
  const onDetect = async (code) => {
    setScanning(false);
    try {
      const r = await api(scoped('/attendance/badge'), { method: 'POST', body: { badge_code: code } });
      setLast(r);
      if (r.action === 'in') toast(`${r.staff_name} clocked IN ✓`, 'ok');
      else if (r.action === 'out') toast(`${r.staff_name} clocked OUT ✓`, 'ok');
      else toast(r.message || 'Already clocked out today', 'info');
    } catch (e) { setLast({ error: e.message || 'Badge not recognised' }); toast(e.message || 'Badge not recognised', 'err'); }
  };
  const tone = !last ? null : last.error ? { bg: '#fee2e2', fg: '#991b1b' } : last.action === 'out' ? { bg: '#dbeafe', fg: '#1e40af' } : last.action === 'in' ? { bg: '#dcfce7', fg: '#166534' } : { bg: '#fef3c7', fg: '#92400e' };
  return (
    <div>
      <div className="card" style={{ textAlign: 'center', padding: '22px 16px' }}>
        <div style={{ fontSize: 40 }}>🪪</div>
        <div style={{ fontWeight: 800, fontSize: 17, marginTop: 6 }}>Badge clock-in</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '4px 0 14px' }}>Scan a staff ID badge to clock them in, or out if already in.</p>
        <button className="btn" onClick={() => setScanning(true)}>📷 Scan badge</button>
      </div>

      {last && (
        <div className="card pop-in" style={{ marginTop: 12, textAlign: 'center', background: tone.bg, color: tone.fg }}>
          {last.error ? (
            <><div style={{ fontSize: 30 }}>⚠️</div><div style={{ fontWeight: 700 }}>{last.error}</div></>
          ) : (
            <>
              <div style={{ fontSize: 30 }}>{last.action === 'out' ? '🔵' : last.action === 'in' ? '🟢' : '✓'}</div>
              <div style={{ fontWeight: 800, fontSize: 18 }}>{last.staff_name}</div>
              <div style={{ fontWeight: 700, marginTop: 2 }}>
                {last.action === 'in' ? 'Clocked IN' : last.action === 'out' ? 'Clocked OUT' : 'Already clocked out today'}
              </div>
            </>
          )}
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 12, width: 'auto', padding: '6px 16px' }} onClick={() => setScanning(true)}>Scan next</button>
        </div>
      )}

      {scanning && <BarcodeScanner title="Scan the staff badge" accept={/[A-Za-z0-9]{4,}/} onDetect={onDetect} onClose={() => setScanning(false)} />}
    </div>
  );
}

// Common positions for regular staff (free text still allowed via the datalist).
const POSITIONS = ['Secretary', 'Operator', 'Cleaner', 'Security', 'Sales', 'Driver', 'Supervisor', 'Manager', 'Accountant', 'Storekeeper', 'Technician'];

// ── Add / edit staff form ─────────────────────────────────────────────────────
function StaffForm({ sites, siteBound, defaultSite, onSaved, onClose }) {
  const { toast } = useStore();
  const [f, setF] = useState({
    full_name: '', site_id: defaultSite || (sites[0]?.id || ''), staff_type: 'REGULAR',
    role_title: '', phone: '', daily_rate: '', rate_loaded: '', rate_bagged: '',
    bank_name: '', bank_account: '', pay_type: 'DAILY',
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const isPiece = f.staff_type === 'BAGGER' || f.staff_type === 'LOADER';

  const save = async () => {
    if (!f.full_name.trim()) { toast('Enter the staff name', 'err'); return; }
    if (!f.site_id) { toast('Pick a site', 'err'); return; }
    setSaving(true);
    try {
      await api(scoped('/staff'), { method: 'POST', body: {
        full_name: f.full_name.trim(), site_id: f.site_id, staff_type: f.staff_type,
        role_title: isPiece ? null : (f.role_title.trim() || null), phone: f.phone.trim() || null,
        pay_type: f.pay_type, daily_rate: +f.daily_rate || 0,
        rate_loaded: +f.rate_loaded || 0, rate_bagged: +f.rate_bagged || 0,
        bank_name: f.bank_name.trim() || null, bank_account: f.bank_account.trim() || null,
      } });
      toast('Staff added ✓', 'ok');
      onSaved && onSaved();
      onClose && onClose();
    } catch (e) { toast(e.message || 'Could not add staff', 'err'); }
    setSaving(false);
  };

  const TYPE_LABEL = { REGULAR: '👤 Regular', BAGGER: '📦 Bagger', LOADER: '🏋 Loader' };
  return (
    <div onClick={() => !saving && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
      <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 420, margin: 0, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 12 }}>New staff</div>

        <label className="fl">Full name</label>
        <input className="input" value={f.full_name} onChange={set('full_name')} placeholder="e.g. John Okoro" style={{ marginBottom: 10 }} />

        {!siteBound && sites.length > 0 && (
          <>
            <label className="fl">Site</label>
            <select className="input" value={f.site_id} onChange={set('site_id')} style={{ marginBottom: 10 }}>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </>
        )}

        <label className="fl">Staff type</label>
        <div className="seg" style={{ marginBottom: 10 }}>
          {['REGULAR', 'BAGGER', 'LOADER'].map((t) => (
            <button key={t} className={`seg-b${f.staff_type === t ? ' on' : ''}`} onClick={() => setF((p) => ({ ...p, staff_type: t }))}>{TYPE_LABEL[t]}</button>
          ))}
        </div>

        {f.staff_type === 'REGULAR' ? (
          <>
            <label className="fl">Position</label>
            <input className="input" list="position-list" value={f.role_title} onChange={set('role_title')} placeholder="e.g. Secretary, Operator, Cleaner" style={{ marginBottom: 10 }} />
            <datalist id="position-list">{POSITIONS.map((p) => <option key={p} value={p} />)}</datalist>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label className="fl">Pay basis</label>
                <select className="input" value={f.pay_type} onChange={set('pay_type')}>
                  <option value="DAILY">Daily</option>
                  <option value="MONTHLY">Monthly</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="fl">{f.pay_type === 'MONTHLY' ? 'Monthly (₦)' : 'Daily rate (₦)'}</label>
                <input className="input" type="number" inputMode="numeric" value={f.daily_rate} onChange={set('daily_rate')} placeholder="0" />
              </div>
            </div>
          </>
        ) : (
          <div style={{ marginBottom: 10 }}>
            <label className="fl">{f.staff_type === 'LOADER' ? 'Rate per bag loaded (₦)' : 'Rate per bag bagged (₦)'}</label>
            <input className="input" type="number" inputMode="numeric"
              value={f.staff_type === 'LOADER' ? f.rate_loaded : f.rate_bagged}
              onChange={set(f.staff_type === 'LOADER' ? 'rate_loaded' : 'rate_bagged')} placeholder="0" />
          </div>
        )}

        <label className="fl">Phone (optional)</label>
        <input className="input" value={f.phone} onChange={set('phone')} placeholder="080…" style={{ marginBottom: 10 }} />

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <div style={{ flex: 1.2 }}>
            <label className="fl">Bank (optional)</label>
            <input className="input" value={f.bank_name} onChange={set('bank_name')} placeholder="e.g. GTB" />
          </div>
          <div style={{ flex: 1.5 }}>
            <label className="fl">Account no.</label>
            <input className="input" value={f.bank_account} onChange={set('bank_account')} placeholder="0123456789" />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn" style={{ flex: 1 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Add staff'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Face liveness clock-in modal ──────────────────────────────────────────────
function ClockModal({ staff, todayRecord, onDone, onClose }) {
  const { toast } = useStore();
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [camReady, setCamReady] = useState(false);
  const [clocking, setClocking] = useState(false);
  const [geoPos, setGeoPos] = useState(null);
  const [enrolled, setEnrolled] = useState(undefined); // undefined=loading, null=none, array=descriptor
  const [threshold, setThreshold] = useState(FACE_MATCH_THRESHOLD);
  const [enrolling, setEnrolling] = useState(false);
  const [forceEnroll, setForceEnroll] = useState(false); // re-enrol an already-enrolled face

  const kind = todayRecord?.clock_in && !todayRecord?.clock_out ? 'out' : 'in';
  const enrollMode = enrolled === null || forceEnroll;

  const {
    status, instruction, step, totalSteps, capturedFrame, capturedDescriptor,
    startDetection, captureForEnroll, reset,
  } = useFaceLiveness({ videoRef, canvasRef, enabled: camReady });

  // Load this staff member's enrolled face (if any)
  useEffect(() => {
    api(scoped(`/staff/${staff.id}/face`)).then((r) => { setEnrolled(r.descriptor || null); if (r.threshold != null) setThreshold(r.threshold); }).catch(() => setEnrolled(null));
  }, []);

  // Start camera + best-effort geolocation
  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } })
      .then((stream) => {
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); }
        setCamReady(true);
      })
      .catch(() => toast('Camera access denied', 'err'));
    navigator.geolocation?.getCurrentPosition(
      (p) => setGeoPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => {},
    );
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  // Enrollment: capture an averaged descriptor and save it.
  const doEnroll = async () => {
    setEnrolling(true);
    try {
      const res = await captureForEnroll(5);
      if (!res) { toast('No face detected — face the camera squarely and retry', 'err'); setEnrolling(false); return; }
      await api(scoped(`/staff/${staff.id}/face`), { method: 'POST', body: { descriptor: res.descriptor } });
      setEnrolled(res.descriptor); setForceEnroll(false);
      toast(`${staff.full_name}'s face enrolled ✓`, 'ok');
    } catch (e) { toast(e.message || 'Enrollment failed', 'err'); }
    setEnrolling(false);
  };

  // After liveness: verify identity then clock.
  useEffect(() => {
    if (enrollMode || status !== 'done' || !capturedFrame) return;
    const run = async () => {
      const dist = faceDistance(capturedDescriptor, enrolled);
      if (!capturedDescriptor || dist > threshold) {
        toast(!capturedDescriptor ? 'Could not read the face — retry' : `Face doesn't match ${staff.full_name}`, 'err');
        setTimeout(reset, 900);
        return;
      }
      setClocking(true);
      try {
        const body = { kind, staff_id: staff.id, work_date: today(), photo: capturedFrame, match_score: +dist.toFixed(3) };
        if (geoPos) { body.lat = geoPos.lat; body.lng = geoPos.lng; body.accuracy = geoPos.accuracy; }
        await api(scoped('/attendance/clock'), { method: 'POST', body });
        toast(`Clocked ${kind}: ${staff.full_name} ✓`, 'ok');
        onDone(); onClose();
      } catch (e) { toast(e.message, 'err'); setClocking(false); reset(); }
    };
    run();
  }, [status, capturedFrame]);

  const progressPct = (step / totalSteps) * 100;

  return (
    <div>
      <div className="grip" />
      <h3>{enrollMode ? 'Enrol Face' : `Clock ${kind.toUpperCase()}`} — {staff.full_name}</h3>
      <p className="sub">{staff.role_title || 'Staff'} · {today()}{enrolled && !enrollMode ? ' · face on file ✓' : ''}</p>

      <div className="liveness-box">
        <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
        <div className="liveness-oval">
          <svg width="200" height="240" viewBox="0 0 200 240">
            <ellipse cx="100" cy="120" rx="80" ry="100"
              fill="none" stroke={status === 'done' ? '#16a34a' : 'rgba(255,255,255,0.5)'}
              strokeWidth="3" strokeDasharray={status === 'detecting' ? '8 4' : 'none'} />
          </svg>
        </div>
        <div className="liveness-overlay">
          <div className={`liveness-instruction${status === 'done' ? ' liveness-ok' : ''}`}>
            {clocking ? 'Saving…' : enrollMode ? (enrolling ? 'Capturing face…' : 'Face the camera and capture') : (status === 'matching' ? 'Verifying identity…' : instruction)}
          </div>
          {status === 'detecting' && !enrollMode && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {[...Array(totalSteps)].map((_, i) => (
                <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i < step ? '#16a34a' : 'rgba(255,255,255,0.4)', transition: 'background .3s' }} />
              ))}
            </div>
          )}
        </div>
      </div>

      {status === 'detecting' && !enrollMode && (
        <div style={{ height: 4, background: 'var(--line)', borderRadius: 2, margin: '8px 0' }}>
          <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--brand)', borderRadius: 2, transition: 'width .3s' }} />
        </div>
      )}

      {enrolled === null && !forceEnroll && (
        <p style={{ fontSize: 13, color: 'var(--muted)', textAlign: 'center', margin: '8px 0' }}>
          No face on file. Enrol {staff.full_name}'s face once, then they can clock in by face.
        </p>
      )}

      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose} disabled={clocking || enrolling}>Cancel</button>

        {enrollMode ? (
          <button className="btn" onClick={doEnroll} disabled={!camReady || enrolling || status === 'loading'}>
            {enrolling ? <span className="spin" /> : '📸'} {status === 'loading' ? 'Loading…' : 'Capture & Save Face'}
          </button>
        ) : (
          <>
            {status === 'ready' && enrolled && <button className="btn" onClick={startDetection}>Start Verification</button>}
            {status === 'error' && <button className="btn btn-sm" onClick={reset}>Retry</button>}
            {(status === 'loading' || status === 'detecting' || status === 'matching' || status === 'done') && (
              <button className="btn" disabled>{status === 'loading' ? 'Loading…' : status === 'done' ? 'Verified ✓' : 'Verifying…'}</button>
            )}
          </>
        )}
      </div>

      {enrolled && !enrollMode && status !== 'detecting' && status !== 'matching' && (
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => { setForceEnroll(true); reset(); }}>Re-enrol face</button>
      )}
    </div>
  );
}

// ── Attendance report (date range) ───────────────────────────────────────────
const clockTime = (s) => s ? new Date(s * 1000).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' }) : '—';

function AttendanceReport({ siteFilter }) {
  const { tenant, toast } = useStore();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [photo, setPhoto] = useState(null);   // object URL in viewer

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ from, to });
      if (siteFilter) p.set('site', siteFilter);
      setRows(await api(scoped(`/attendance?${p}`)));
    } catch { setRows([]); }
    setLoading(false);
  }, [tenant, from, to, siteFilter]);
  useEffect(() => { load(); }, [load]);

  const viewPhoto = async (id, which) => {
    try {
      const res = await fetch(`/api/attendance/${id}/img/${which}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('not found');
      setPhoto(URL.createObjectURL(await res.blob()));
    } catch { toast('Photo not available', 'err'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input type="date" className="input" value={from} max={today()} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="input" value={to} max={today()} onChange={(e) => setTo(e.target.value)} />
      </div>
      {loading ? (
        <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : rows.length === 0 ? (
        <div className="empty"><div className="ic">🕑</div><p>No attendance in this range</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700 }}>{r.staff || 'Staff'}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {r.work_date} · {r.site || '—'} · in {clockTime(r.clock_in)} · out {clockTime(r.clock_out)}
                  {r.match_score != null ? ` · match ${Number(r.match_score).toFixed(2)}${r.match_score <= 0.55 ? ' ✓' : ' ⚠'}` : ''}
                </div>
              </div>
              {r.has_photo_in && <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 8px' }} onClick={() => viewPhoto(r.id, 'in')}>📷 In</button>}
              {r.has_photo_out && <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 8px' }} onClick={() => viewPhoto(r.id, 'out')}>📷 Out</button>}
            </div>
          ))}
        </div>
      )}
      {photo && (
        <div onClick={() => { URL.revokeObjectURL(photo); setPhoto(null); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.8)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
          <img src={photo} alt="attendance" style={{ maxWidth: '100%', maxHeight: '90vh', borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
}

// ── Daily production entry (bags loaded / bagged) ─────────────────────────────
function ProductionGrid({ siteFilter }) {
  const { tenant, toast } = useStore();
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const p = new URLSearchParams({ date }); if (siteFilter) p.set('site', siteFilter); setRows(await api(scoped(`/payroll/production?${p}`))); }
    catch { setRows([]); }
    setLoading(false);
  }, [tenant, date, siteFilter]);
  useEffect(() => { load(); }, [load]);

  const setVal = (i, k, v) => setRows((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async (r) => {
    try { await api(scoped('/payroll/production'), { method: 'POST', body: { staff_id: r.staff_id, work_date: date, bags_loaded: +r.bags_loaded || 0, bags_bagged: +r.bags_bagged || 0 } }); }
    catch (e) { toast(e.message, 'err'); }
  };
  const totL = rows.reduce((s, r) => s + (+r.bags_loaded || 0), 0);
  const totB = rows.reduce((s, r) => s + (+r.bags_bagged || 0), 0);

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input type="date" className="input" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>Loaded {totL} · Bagged {totB}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px', gap: 6, fontSize: 11, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', padding: '0 2px 4px' }}>
        <span>Staff</span><span style={{ textAlign: 'center' }}>Loaded</span><span style={{ textAlign: 'center' }}>Bagged</span>
      </div>
      {loading ? <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</> : rows.length === 0 ? (
        <div className="empty"><div className="ic">📦</div><p>No staff</p></div>
      ) : (
        <div className="card" style={{ padding: 8 }}>
          {rows.map((r, i) => (
            <div key={r.staff_id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px', gap: 6, alignItems: 'center', padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.full_name}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.pay_type === 'PIECE' ? 'piece' : (r.role_title || 'staff')}</div>
              </div>
              <input className="input" type="number" inputMode="numeric" style={{ padding: '7px 6px', textAlign: 'center' }} value={r.bags_loaded}
                onChange={(e) => setVal(i, 'bags_loaded', e.target.value)} onBlur={() => save(r)} onFocus={(e) => e.target.select()} />
              <input className="input" type="number" inputMode="numeric" style={{ padding: '7px 6px', textAlign: 'center' }} value={r.bags_bagged}
                onChange={(e) => setVal(i, 'bags_bagged', e.target.value)} onBlur={() => save(r)} onFocus={(e) => e.target.select()} />
            </div>
          ))}
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>Counts save as you leave each field. These feed payroll for loaders &amp; baggers.</p>
    </div>
  );
}

// ── Staff list ─────────────────────────────────────────────────────────────────
export default function Staff() {
  const { openModal, closeModal, tenant, sites } = useStore();
  const [staff, setStaff] = useState([]);
  const [attendance, setAttendance] = useState({});
  const [loading, setLoading] = useState(true);
  const [siteFilter, setSiteFilter] = useState('');
  const [mode, setMode] = useState('clock');   // clock | report
  const [showAdd, setShowAdd] = useState(false);
  const role = useRole();
  const canManage = role && atLeast(role, 'SECRETARY');
  const siteBound = role && !atLeast(role, 'SNR_ACCOUNTANT');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = siteFilter ? `?site=${siteFilter}` : '';
      const [staffData, attData] = await Promise.all([
        api(scoped(`/staff${params}`)),
        api(scoped(`/attendance?date=${today()}`)),
      ]);
      setStaff(staffData);
      const byStaff = {};
      (attData || []).forEach((a) => { byStaff[a.staff_id] = a; });
      setAttendance(byStaff);
    } catch { setStaff([]); }
    setLoading(false);
  }, [tenant, siteFilter]);

  useEffect(() => { load(); }, [load]);

  const openClock = (person) => {
    openModal(
      <ClockModal
        staff={person}
        todayRecord={attendance[person.id] || null}
        onDone={load}
        onClose={closeModal}
      />
    );
  };

  const statusIcon = (s) => {
    const a = attendance[s.id];
    if (!a) return { icon: '⬜', label: 'Out', color: 'var(--muted)' };
    if (a.clock_in && !a.clock_out) return { icon: '🟢', label: 'In', color: 'var(--ok)' };
    if (a.clock_out) return { icon: '🔵', label: 'Done', color: 'var(--brand-d)' };
    return { icon: '⬜', label: 'Out', color: 'var(--muted)' };
  };

  const present = staff.filter((s) => attendance[s.id]?.clock_in).length;

  return (
    <div>
      <div className="seg" style={{ marginBottom: 14, overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`seg-b${mode === 'clock' ? ' on' : ''}`} onClick={() => setMode('clock')}>🟢 Clock</button>
        <button className={`seg-b${mode === 'badge' ? ' on' : ''}`} onClick={() => setMode('badge')}>🪪 Badge</button>
        <button className={`seg-b${mode === 'report' ? ' on' : ''}`} onClick={() => setMode('report')}>🕑 Attendance</button>
        <button className={`seg-b${mode === 'production' ? ' on' : ''}`} onClick={() => setMode('production')}>📦 Production</button>
      </div>

      {sites.length > 1 && (
        <select className="input" style={{ marginBottom: 12 }} value={siteFilter}
          onChange={(e) => setSiteFilter(e.target.value)}>
          <option value="">All sites</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}

      {mode === 'badge' ? <BadgeClock /> : mode === 'report' ? <AttendanceReport siteFilter={siteFilter} /> : mode === 'production' ? <ProductionGrid siteFilter={siteFilter} /> : (
      <>
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat accent"><div className="k">Present Today</div><div className="v">{present}</div></div>
        <div className="stat"><div className="k">Total Staff</div><div className="v">{staff.length}</div></div>
      </div>

      {canManage && (
        <button className="btn" style={{ marginBottom: 14 }} onClick={() => setShowAdd(true)}>＋ New staff</button>
      )}

      {loading ? (
        <>{[...Array(6)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : staff.length === 0 ? (
        <div className="empty"><div className="ic">👷</div><p>No staff found</p></div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {staff.map((s) => {
            const st = statusIcon(s);
            return (
              <button key={s.id} onClick={() => openClock(s)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
                <div className="av">{s.full_name?.[0]?.toUpperCase() || '?'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{s.full_name} {s.face_enrolled ? <span title="Face enrolled" style={{ fontSize: 12 }}>🙂</span> : <span title="No face on file" style={{ fontSize: 12, opacity: .5 }}>📷</span>}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.role_title || 'Staff'} · {sites.find((x) => x.id === s.site_id)?.name || '—'}</div>
                </div>
                <div style={{ fontSize: 12, fontWeight: 700, color: st.color, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <span style={{ fontSize: 18 }}>{st.icon}</span>
                  {st.label}
                </div>
              </button>
            );
          })}
        </div>
      )}
      </>
      )}

      {showAdd && (
        <StaffForm
          sites={sites}
          siteBound={siteBound}
          defaultSite={siteFilter || (sites[0]?.id || '')}
          onSaved={load}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
