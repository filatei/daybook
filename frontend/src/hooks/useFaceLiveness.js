/**
 * useFaceLiveness — face detection + blink + head-turn challenge using face-api.js
 *
 * Challenge sequence: BLINK → TURN_LEFT → TURN_RIGHT → done
 * Uses TinyFaceDetector + FaceLandmark68TinyNet (loaded from CDN).
 */
import { useEffect, useRef, useState, useCallback } from 'react';

// Self-hosted face-api models + library (served from our own origin → works at
// sites with weak internet, and offline after the first load via the SW cache).
const MODEL_URL = '/face/models';
const FACEAPI_SRC = '/face/face-api.js';

// Eye landmark indices in the 68-point model
const LEFT_EYE  = [36, 37, 38, 39, 40, 41];
const RIGHT_EYE = [42, 43, 44, 45, 46, 47];

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function ear(pts) {
  // EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
  return (dist(pts[1], pts[5]) + dist(pts[2], pts[4])) / (2 * dist(pts[0], pts[3]));
}

// A single, fast liveness check for floor use: one blink. (Dropped the head-turn
// step — and the earlier blink+left+right — which kept getting stuck for users.)
const CHALLENGES = ['BLINK'];
const CHALLENGE_TEXT = {
  BLINK: 'Blink your eyes',
  TURN: 'Turn your head left or right',
  DONE: 'Verified ✓',
};

const EAR_THRESHOLD  = 0.24;  // below this = eyes closed (a touch more forgiving)
const TURN_THRESHOLD = 0.12;  // nose displacement / face width — easier to satisfy
const MIN_FACE_CONF  = 0.5;   // detect faces more readily on phone cameras

export function useFaceLiveness({ videoRef, canvasRef, enabled = true }) {
  const [step, setStep]         = useState(0);   // index into CHALLENGES (3 = done)
  const [status, setStatus]     = useState('loading'); // loading | ready | detecting | done | error
  const [instruction, setInst]  = useState('Loading face detector…');
  const [capturedFrame, setCaptured] = useState(null); // base64 data URL on success
  const [capturedDescriptor, setDescriptor] = useState(null); // 128-number array on success

  const fapi     = useRef(null);
  const rafId    = useRef(null);
  const blinkState = useRef({ wasOpen: true, closed: false });
  const stepRef  = useRef(0);

  // Sync stepRef with step
  useEffect(() => { stepRef.current = step; }, [step]);

  // Load face-api.js dynamically from CDN (not bundled — too large)
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const loadFaceApi = async () => {
      try {
        // Only load once
        if (!window.faceapi) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = FACEAPI_SRC;
            s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
          });
        }
        if (cancelled) return;

        fapi.current = window.faceapi;
        const fa = fapi.current;

        await fa.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await fa.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await fa.nets.faceRecognitionNet.loadFromUri(MODEL_URL);   // 128-D descriptors for identity match

        if (cancelled) return;
        setStatus('ready');
        setInst('Position your face in the oval');
      } catch (e) {
        if (!cancelled) { setStatus('error'); setInst('Could not load face detector'); }
      }
    };

    loadFaceApi();
    return () => { cancelled = true; };
  }, [enabled]);

  // Detection loop
  const startDetection = useCallback(async () => {
    const fa = fapi.current;
    if (!fa || !videoRef.current || !canvasRef.current) return;

    setStatus('detecting');
    setInst(CHALLENGE_TEXT[CHALLENGES[0]]);

    const detect = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || stepRef.current >= CHALLENGES.length) return;

      const opts = new fa.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: MIN_FACE_CONF });
      const result = await fa.detectSingleFace(video, opts).withFaceLandmarks();

      if (result) {
        const dims = fa.matchDimensions(canvas, video, true);
        const resized = fa.resizeResults(result, dims);

        // Draw overlay
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        fa.draw.drawDetections(canvas, [resized]);

        const pts = resized.landmarks.positions;
        const lEye = LEFT_EYE.map((i) => pts[i]);
        const rEye = RIGHT_EYE.map((i) => pts[i]);
        const earVal = (ear(lEye) + ear(rEye)) / 2;

        const box = result.detection.box;
        const noseTip = pts[30];
        const faceCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const horizontalShift = (noseTip.x - faceCenter.x) / box.width; // negative = left

        const challenge = CHALLENGES[stepRef.current];

        if (challenge === 'BLINK') {
          const eyesClosed = earVal < EAR_THRESHOLD;
          if (!eyesClosed && !blinkState.current.wasOpen) {
            // Eyes reopened after being closed = completed blink
            blinkState.current = { wasOpen: true, closed: false };
            advanceStep();
          } else {
            blinkState.current.wasOpen = !eyesClosed;
          }
        } else if (challenge === 'TURN') {
          if (Math.abs(horizontalShift) > TURN_THRESHOLD) advanceStep();   // either direction
        }
      } else {
        // No face — clear canvas
        const ctx = canvasRef.current?.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      if (stepRef.current < CHALLENGES.length) {
        rafId.current = requestAnimationFrame(() => setTimeout(detect, 100));
      }
    };

    detect();
  }, []);

  const advanceStep = useCallback(() => {
    const next = stepRef.current + 1;
    stepRef.current = next;
    setStep(next);
    if (next < CHALLENGES.length) {
      setInst(CHALLENGE_TEXT[CHALLENGES[next]]);
    } else {
      // All done — capture frame
      finishLiveness();
    }
  }, []);

  // Grab a 128-D face descriptor from the current video frame (null if no face).
  const grabDescriptor = useCallback(async () => {
    const fa = fapi.current, video = videoRef.current;
    if (!fa || !video) return null;
    const opts = new fa.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: MIN_FACE_CONF });
    const det = await fa.detectSingleFace(video, opts).withFaceLandmarks().withFaceDescriptor();
    return det && det.descriptor ? Array.from(det.descriptor) : null;
  }, [videoRef]);

  const finishLiveness = useCallback(async () => {
    if (rafId.current) cancelAnimationFrame(rafId.current);

    const video = videoRef.current;
    const cap = document.createElement('canvas');
    cap.width = video.videoWidth || 640;
    cap.height = video.videoHeight || 480;
    cap.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = cap.toDataURL('image/jpeg', 0.85);
    setCaptured(dataUrl);
    setStatus('matching');
    setInst('Verifying identity…');
    try { setDescriptor(await grabDescriptor()); } catch { setDescriptor(null); }
    setStatus('done');
    setInst(CHALLENGE_TEXT.DONE);
  }, [grabDescriptor]);

  /**
   * Enrollment helper — average a few descriptors from the live video for a
   * stable face template. Returns { descriptor:number[], frame:dataURL } or null.
   */
  const captureForEnroll = useCallback(async (samples = 4) => {
    const fa = fapi.current, video = videoRef.current;
    if (!fa || !video) return null;
    const got = [];
    for (let i = 0; i < samples; i++) {
      const d = await grabDescriptor();
      if (d) got.push(d);
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!got.length) return null;
    const avg = got[0].map((_, i) => got.reduce((s, d) => s + d[i], 0) / got.length);
    const cap = document.createElement('canvas');
    cap.width = video.videoWidth || 640; cap.height = video.videoHeight || 480;
    cap.getContext('2d').drawImage(video, 0, 0);
    return { descriptor: avg, frame: cap.toDataURL('image/jpeg', 0.85), samples: got.length };
  }, [grabDescriptor]);

  // Stop loop on unmount
  useEffect(() => () => { if (rafId.current) cancelAnimationFrame(rafId.current); }, []);

  const reset = useCallback(() => {
    if (rafId.current) cancelAnimationFrame(rafId.current);
    setStep(0); stepRef.current = 0;
    setCaptured(null); setDescriptor(null);
    blinkState.current = { wasOpen: true, closed: false };
    setStatus('ready');
    setInst('Position your face in the oval');
  }, []);

  return {
    status,        // loading | ready | detecting | matching | done | error
    instruction,
    step,          // 0-3
    totalSteps: CHALLENGES.length,
    capturedFrame,      // data URL when done
    capturedDescriptor, // 128-number array when done (for identity match)
    startDetection,
    captureForEnroll,   // enrollment: average descriptor from live video
    reset,
    challengeLabels: CHALLENGES.map((c) => CHALLENGE_TEXT[c]),
  };
}

// Euclidean distance between two 128-D descriptors; < ~0.55 ≈ same person.
export function faceDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}
export const FACE_MATCH_THRESHOLD = 0.55;
