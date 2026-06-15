import React, { useEffect, useState, useRef, useCallback } from 'react';
import { api, scoped, today } from '../api.js';
import { useStore } from '../store.jsx';
import { useFaceLiveness } from '../hooks/useFaceLiveness.js';

// ── Face liveness clock-in modal ──────────────────────────────────────────────
function ClockModal({ staff, todayRecord, onDone, onClose }) {
  const { toast } = useStore();
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [camReady, setCamReady] = useState(false);
  const [clocking, setClocking] = useState(false);
  const [geoPos, setGeoPos] = useState(null);

  const kind = todayRecord?.clock_in && !todayRecord?.clock_out ? 'out' : 'in';

  const {
    status, instruction, step, totalSteps, capturedFrame, startDetection, reset,
  } = useFaceLiveness({ videoRef, canvasRef, enabled: camReady });

  // Start camera
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

  // Submit after liveness done
  useEffect(() => {
    if (status !== 'done' || !capturedFrame) return;
    const doPost = async () => {
      setClocking(true);
      try {
        const body = { kind, staff_id: staff.id, work_date: today(), photo: capturedFrame, signature: null };
        if (geoPos) { body.lat = geoPos.lat; body.lng = geoPos.lng; body.accuracy = geoPos.accuracy; }
        await api(scoped('/attendance/clock'), { method: 'POST', body });
        toast(`Clocked ${kind}: ${staff.full_name}`, 'ok');
        onDone();
        onClose();
      } catch (e) { toast(e.message, 'err'); setClocking(false); reset(); }
    };
    doPost();
  }, [status, capturedFrame]);

  const progressPct = (step / totalSteps) * 100;

  return (
    <div>
      <div className="grip" />
      <h3>Clock {kind.toUpperCase()} — {staff.full_name}</h3>
      <p className="sub" style={{ textTransform: 'capitalize' }}>{staff.position || 'Staff'} · {today()}</p>

      <div className="liveness-box">
        <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />

        {/* Oval guide */}
        <div className="liveness-oval">
          <svg width="200" height="240" viewBox="0 0 200 240">
            <ellipse cx="100" cy="120" rx="80" ry="100"
              fill="none" stroke={status === 'done' ? '#16a34a' : 'rgba(255,255,255,0.5)'}
              strokeWidth="3" strokeDasharray={status === 'detecting' ? '8 4' : 'none'} />
          </svg>
        </div>

        <div className="liveness-overlay">
          <div className={`liveness-instruction${status === 'done' ? ' liveness-ok' : ''}`}>
            {clocking ? 'Saving…' : instruction}
          </div>
          {/* Progress dots */}
          {status === 'detecting' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              {[...Array(totalSteps)].map((_, i) => (
                <div key={i} style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: i < step ? '#16a34a' : 'rgba(255,255,255,0.4)',
                  transition: 'background .3s',
                }} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {status === 'detecting' && (
        <div style={{ height: 4, background: 'var(--line)', borderRadius: 2, margin: '8px 0' }}>
          <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--brand)', borderRadius: 2, transition: 'width .3s' }} />
        </div>
      )}

      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose} disabled={clocking}>Cancel</button>
        {status === 'ready' && (
          <button className="btn" onClick={startDetection}>Start Verification</button>
        )}
        {status === 'error' && (
          <button className="btn btn-danger btn-sm" onClick={reset}>Retry</button>
        )}
        {(status === 'loading' || status === 'detecting' || status === 'done') && (
          <button className="btn" disabled>
            {status === 'loading' ? 'Loading…' : status === 'done' ? 'Verified ✓' : 'Verifying…'}
          </button>
        )}
      </div>
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
                  <div style={{ fontWeight: 700 }}>{s.full_name}</div>
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
