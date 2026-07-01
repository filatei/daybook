import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Web Speech API dictation (Chrome/Android PWA). Returns:
 *   { supported, listening, start, stop }
 * onText(finalTranscript) fires as the user speaks (interim + final).
 */
export function useVoiceInput(onText) {
  const Rec = typeof window !== 'undefined'
    && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const supported = !!Rec;
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const cbRef = useRef(onText);
  cbRef.current = onText;

  const stop = useCallback(() => {
    try { recRef.current && recRef.current.stop(); } catch { /* ignore */ }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (!supported || listening) return;
    const r = new Rec();
    r.lang = 'en-NG';
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      cbRef.current && cbRef.current(t.trim());
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    recRef.current = r;
    try { r.start(); setListening(true); } catch { setListening(false); }
  }, [Rec, supported, listening]);

  useEffect(() => () => { try { recRef.current && recRef.current.abort(); } catch { /* ignore */ } }, []);
  return { supported, listening, start, stop };
}
