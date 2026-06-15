import { useEffect, useRef, useState } from 'react';
import { getToken, getActiveTenant } from '../api.js';

/**
 * Subscribe to the realtime gateway for the active tenant. Calls onEvent for each
 * server event. Reconnects with exponential backoff + jitter (so every client
 * doesn't stampede the gateway after a shared outage), and resumes from the last
 * persisted seq so a reconnecting screen catches up without a reload.
 */
export function useRealtime(onEvent) {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onEvent); cb.current = onEvent;
  const lastSeq = useRef(0);
  const wsRef = useRef(null);
  const tenant = getActiveTenant();

  useEffect(() => {
    if (!tenant) return undefined;
    let stop = false, attempt = 0, timer = null;

    const connect = () => {
      const token = getToken();
      if (!token || stop) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/ws?tenant=${encodeURIComponent(tenant)}&token=${encodeURIComponent(token)}&last_seq=${lastSeq.current}`;
      let ws;
      try { ws = new WebSocket(url); } catch { schedule(); return; }
      wsRef.current = ws;

      ws.onopen = () => { attempt = 0; setConnected(true); };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'event') {
          if (m.seq && m.seq > lastSeq.current) lastSeq.current = m.seq;  // only persisted events advance resume point
          try { cb.current && cb.current(m); } catch { /* */ }
        }
      };
      ws.onclose = () => { setConnected(false); if (!stop) schedule(); };
      ws.onerror = () => { try { ws.close(); } catch { /* */ } };
    };
    const schedule = () => {
      attempt += 1;
      const base = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      const delay = base / 2 + Math.random() * (base / 2);   // jitter
      timer = setTimeout(connect, delay);
    };

    connect();
    const onOnline = () => { if (!wsRef.current || wsRef.current.readyState > 1) { attempt = 0; connect(); } };
    window.addEventListener('online', onOnline);
    return () => {
      stop = true; clearTimeout(timer);
      window.removeEventListener('online', onOnline);
      try { wsRef.current && wsRef.current.close(); } catch { /* */ }
    };
  }, [tenant]);

  return { connected };
}
