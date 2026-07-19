/**
 * ReceiptCamera — snap a POS slip with the device camera.
 *
 * Unlike PhotoCapture (passport crop for staff badges) a receipt must be captured
 * WHOLE and at high resolution: the figures are small printed text on thermal
 * paper. So we request the rear camera at the highest sensible resolution, keep
 * the full frame (no crop), and hand back a File — the caller shrinks it before
 * upload just like a chosen file.
 *
 * Returns via onCapture(file). Falls back gracefully: if the camera can't open
 * (no permission, no device, insecure context) the user is told and can still use
 * the file picker behind this modal.
 */
import React, { useEffect, useRef, useState } from 'react';

export default function ReceiptCamera({ onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState(null);
  const [shot, setShot] = useState(null);     // { url, file } preview before accepting

  useEffect(() => {
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setErr(window.isSecureContext === false
        ? 'Camera needs a secure (https) connection.'
        : 'This device/browser has no camera support.');
      return undefined;
    }
    // Rear camera, as much detail as the device will give — small print needs it.
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    }).then((stream) => {
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
      setReady(true);
    }).catch((e) => {
      setErr(e.name === 'NotAllowedError' ? 'Camera permission denied — allow it, or choose a file instead.'
        : e.name === 'NotFoundError' ? 'No camera found on this device.'
          : (e.message || 'Could not open the camera.'));
    });
    return () => { cancelled = true; streamRef.current?.getTracks().forEach((t) => t.stop()); };
  }, []);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    // Full frame at the sensor's resolution — no cropping, the slip fills it.
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d').drawImage(v, 0, 0);
    cv.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `slip-${Date.now()}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      setShot({ url: URL.createObjectURL(blob), file });
    }, 'image/jpeg', 0.92);   // high quality here; the caller downsizes for upload
  };

  // Release the preview blob URL when it's replaced or the modal closes. The File
  // handed to onCapture is independent of this URL, so revoking is always safe.
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  const retake = () => setShot(null);
  const accept = () => {
    if (!shot) return;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    onCapture(shot.file);
    onClose();
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.75)', display: 'grid', placeItems: 'center', zIndex: 150, padding: 12 }}>
      <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 440, margin: 0, textAlign: 'center' }}>
        <div style={{ fontWeight: 800, fontSize: 17, marginBottom: 2 }}>Snap the slip</div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 0 }}>
          Fill the frame with the slip, hold steady, good light — the print is small.
        </p>

        {err ? (
          <div style={{ padding: '18px 10px', fontSize: 13, color: '#b91c1c' }}>{err}</div>
        ) : (
          <div style={{ position: 'relative', width: '100%', aspectRatio: '3 / 4', maxHeight: '58vh', margin: '0 auto', borderRadius: 12, overflow: 'hidden', background: '#0f172a' }}>
            {shot ? (
              <img src={shot.url} alt="captured slip" style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#0f172a' }} />
            ) : (
              <>
                <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                {/* Framing guide — keeps the whole slip inside the readable area. */}
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                  <div style={{ width: '78%', height: '88%', border: '2px dashed rgba(255,255,255,.65)', borderRadius: 8 }} />
                </div>
                {!ready && (
                  <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 13 }}>
                    <span><span className="spin" /> Starting camera…</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          {shot ? (
            <>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={retake}>Retake</button>
              <button className="btn" style={{ flex: 1.4 }} onClick={accept}>Use this photo</button>
            </>
          ) : (
            <button className="btn" style={{ flex: 1.4 }} onClick={snap} disabled={!ready || !!err}>📷 Capture</button>
          )}
        </div>
      </div>
    </div>
  );
}
