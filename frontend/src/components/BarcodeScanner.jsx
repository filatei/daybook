/**
 * BarcodeScanner — full-screen camera scanner using the native BarcodeDetector
 * API (Chrome/Android, Edge). Falls back to a clear message + manual entry when
 * the API isn't available. Detects Code 128 (our receipt barcodes) and others.
 */
import React, { useEffect, useRef, useState } from 'react';

const FORMATS = ['code_128', 'ean_13', 'ean_8', 'code_39', 'upc_a', 'qr_code'];

export default function BarcodeScanner({ onDetect, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(0);
  const doneRef = useRef(false);
  const [err, setErr] = useState(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    let detector = null;
    const start = async () => {
      if (!('BarcodeDetector' in window)) { setSupported(false); }
      if (!navigator.mediaDevices?.getUserMedia) { setErr('Camera not available on this device/browser.'); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      } catch (e) {
        setErr(e.name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access and retry.' : (e.message || 'Cannot open camera.'));
        return;
      }
      if ('BarcodeDetector' in window) {
        try { detector = new window.BarcodeDetector({ formats: FORMATS }); } catch { detector = new window.BarcodeDetector(); }
        const scan = async () => {
          if (doneRef.current || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const hit = codes.find((c) => c.rawValue && /\d/.test(c.rawValue));
            if (hit) { doneRef.current = true; stop(); onDetect(hit.rawValue.trim()); return; }
          } catch { /* frame not ready */ }
          rafRef.current = requestAnimationFrame(scan);
        };
        rafRef.current = requestAnimationFrame(scan);
      }
    };
    const stop = () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    start();
    return () => { doneRef.current = true; stop(); };
  }, [onDetect]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 200, display: 'flex', flexDirection: 'column' }}>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        {/* Scan frame guide */}
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <div style={{ width: '78%', maxWidth: 360, height: 140, border: '3px solid rgba(255,255,255,.9)', borderRadius: 14, boxShadow: '0 0 0 9999px rgba(0,0,0,.35)' }} />
        </div>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#fff' }}>
          <span style={{ fontWeight: 700 }}>Point at the receipt barcode</span>
          <button onClick={onClose} style={{ border: 'none', background: 'rgba(255,255,255,.2)', color: '#fff', width: 38, height: 38, borderRadius: '50%', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        {(err || !supported) && (
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: 18, background: 'rgba(0,0,0,.6)', color: '#fff', textAlign: 'center' }}>
            {err || 'Live barcode detection isn’t supported in this browser. Use Chrome on Android, or type the receipt number.'}
          </div>
        )}
      </div>
    </div>
  );
}
