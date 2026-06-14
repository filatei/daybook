/**
 * useFaceLiveness — face detection + blink + head-turn challenge using face-api.js
 *
 * Challenge sequence: BLINK → TURN_LEFT → TURN_RIGHT → done
 * Uses TinyFaceDetector + FaceLandmark68TinyNet (loaded from CDN).
 */
import { useEffect, useRef, useState, useCallback } from 'react';

// face-api.js models served from jsDelivr CDN
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';

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

const CHALLENGES = ['BLINK', 'TURN_LEFT', 'TURN_RIGHT'];
const CHALLENGE_TEXT = {
  BLINK: 'Blink your eyes',
  TURN_LEFT: 'Turn your head left',
  TURN_RIGHT: 'Turn your head right',
  DONE: 'Liveness verified ✓',
};

const EAR_THRESHOLD  = 0.22;  // below this = eyes closed
const TURN_THRESHOLD = 0.20;  // nose displacement / face width
const MIN_FACE_CONF  = 0.65;

export function useFaceLiveness({ videoRef, canvasRef, enabled = true }) {
  const [step, setStep]         = useState(0);   // index into CHALLENGES (3 = done)
  const [status, setStatus]     = useState('loading'); // loading | ready | detecting | done | error
  const [instruction, setInst]  = useState('Loading face detector…');
  const [capturedFrame, setCaptured] = useState(null); // base64 data URL on success

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
            s.src = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
            s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
          });
        }
        if (cancelled) return;

        fapi.current = window.faceapi;
        const fa = fapi.current;

        await fa.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await fa.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);

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
      const result = await fa.detectSingleFace(video, opts).withFaceLandmarks(true);

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
        } else if (challenge === 'TURN_LEFT') {
          if (horizontalShift < -TURN_THRESHOLD) advanceStep();
        } else if (challenge === 'TURN_RIGHT') {
          if (horizontalShift > TURN_THRESHOLD) advanceStep();
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

  const finishLiveness = useCallback(() => {
    if (rafId.current) cancelAnimationFrame(rafId.current);

    const video = videoRef.current;
    const cap = document.createElement('canvas');
    cap.width = video.videoWidth || 640;
    cap.height = video.videoHeight || 480;
    cap.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = cap.toDataURL('image/jpeg', 0.85);

    setCaptured(dataUrl);
    setStatus('done');
    setInst(CHALLENGE_TEXT.DONE);
  }, []);

  // Stop loop on unmount
  useEffect(() => () => { if (rafId.current) cancelAnimationFrame(rafId.current); }, []);

  const reset = useCallback(() => {
    if (rafId.current) cancelAnimationFrame(rafId.current);
    setStep(0); stepRef.current = 0;
    setCaptured(null);
    blinkState.current = { wasOpen: true, closed: false };
    setStatus('ready');
    setInst('Position your face in the oval');
  }, []);

  return {
    status,        // loading | ready | detecting | done | error
    instruction,
    step,          // 0-3
    totalSteps: CHALLENGES.length,
    capturedFrame, // data URL when done
    startDetection,
    reset,
    challengeLabels: CHALLENGES.map((c) => CHALLENGE_TEXT[c]),
  };
}
