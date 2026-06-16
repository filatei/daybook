/**
 * PhotoCapture — snap a passport-style staff photo for the ID badge.
 * Center-crops to portrait 3:4, downscales to ~300×400 JPEG, then saves.
 */
import React, { useEffect, useRef, useState } from 'react';
import { api, scoped } from '../api.js';
import { useStore } from '../store.jsx';

export default function PhotoCapture({ staff, onSaved, onClose }) {
  const { toast } = useStore();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [shot, setShot] = useState(null);   // captured data URL
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 } })
      .then((stream) => { streamRef.current = stream; if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); } setReady(true); })
      .catch((e) => setErr(e.name === 'NotAllowedError' ? 'Camera permission denied' : (e.message || 'Cannot open camera')));
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const capture = () => {
    const v = videoRef.current; if (!v || !v.videoWidth) return;
    const OW = 300, OH = 400;                       // portrait 3:4 output
    const srcRatio = v.videoWidth / v.videoHeight, dstRatio = OW / OH;
    let sw = v.videoWidth, sh = v.videoHeight, sx = 0, sy = 0;
    if (srcRatio > dstRatio) { sw = sh * dstRatio; sx = (v.videoWidth - sw) / 2; }   // crop sides
    else { sh = sw / dstRatio; sy = (v.videoHeight - sh) / 2; }                       // crop top/bottom
    const cv = document.createElement('canvas'); cv.width = OW; cv.height = OH;
    cv.getContext('2d').drawImage(v, sx, sy, sw, sh, 0, 0, OW, OH);
    setShot(cv.toDataURL('image/jpeg', 0.72));
  };

  const save = async () => {
    if (!shot) return;
    setSaving(true);
    try { await api(scoped(`/staff/${staff.id}/photo`), { method: 'POST', body: { photo: shot } }); toast(`${staff.full_name}'s photo saved ✓`, 'ok'); onSaved && onSaved(); onClose(); }
    catch (e) { toast(e.message || 'Could not save photo', 'err'); }
    setSaving(false);
  };

  return (
    <div onClick={() => !saving && onClose()} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.6)', display: 'grid', placeItems: 'center', zIndex: 140, padding: 16 }}>
      <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 360, margin: 0, textAlign: 'center' }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>Staff photo</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>{staff.full_name} — line up the face and capture.</p>

        <div style={{ position: 'relative', width: 210, height: 280, margin: '0 auto', borderRadius: 12, overflow: 'hidden', background: '#0f172a' }}>
          {shot ? (
            <img src={shot} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <>
              <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                <div style={{ width: 120, height: 150, border: '2px dashed rgba(255,255,255,.7)', borderRadius: '46% 46% 46% 46%/40% 40% 60% 60%' }} />
              </div>
            </>
          )}
        </div>

        {err && <div style={{ color: 'var(--err)', fontSize: 13, marginTop: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
          {shot ? (
            <>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setShot(null)} disabled={saving}>Retake</button>
              <button className="btn" style={{ flex: 1 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Use photo'}</button>
            </>
          ) : (
            <button className="btn" style={{ flex: 1.4 }} onClick={capture} disabled={!ready}>📸 Capture</button>
          )}
        </div>
      </div>
    </div>
  );
}
