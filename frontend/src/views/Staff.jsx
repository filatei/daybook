import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api, scoped, today } from '../api.js';
import { useStore } from '../store.jsx';
import { useFaceLiveness, faceDistance, FACE_MATCH_THRESHOLD } from '../hooks/useFaceLiveness.js';

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
    api(scoped(`/staff/${staff.id}/face`)).then((r) => setEnrolled(r.descriptor || null)).catch(() => setEnrolled(null));
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
      if (!capturedDescriptor || dist > FACE_MATCH_THRESHOLD) {
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

// ── Staff list ─────────────────────────────────────────────────────────────────
export default function Staff() {
  const { openModal, closeModal, tenant, sites } = useStore();
  const [staff, setStaff] = useState([]);
  const [attendance, setAttendance] = useState({});
  const [loading, setLoading] = useState(true);
  const [siteFilter, setSiteFilter] = useState('');

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
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat accent"><div className="k">Present Today</div><div className="v">{present}</div></div>
        <div className="stat"><div className="k">Total Staff</div><div className="v">{staff.length}</div></div>
      </div>

      {sites.length > 1 && (
        <select className="input" style={{ marginBottom: 12 }} value={siteFilter}
          onChange={(e) => setSiteFilter(e.target.value)}>
          <option value="">All sites</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
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
    </div>
  );
}
