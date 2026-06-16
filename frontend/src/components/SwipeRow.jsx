/**
 * SwipeRow — declutters a crowded list row on phones.
 *
 * Desktop (≥768px): renders `main` and `actions` inline (plenty of width).
 * Mobile (<768px): shows only `main`; the `actions` sit behind the row and are
 * revealed by swiping the row left (direction-locked so it never fights the
 * vertical scroll). Tap elsewhere / swipe back to close.
 */
import React, { useRef, useState, useEffect } from 'react';

const useIsMobile = () => {
  const [m, setM] = useState(() => (typeof window !== 'undefined' ? window.matchMedia('(max-width:767px)').matches : false));
  useEffect(() => {
    const mq = window.matchMedia('(max-width:767px)');
    const on = () => setM(mq.matches);
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on); };
  }, []);
  return m;
};

export default function SwipeRow({ main, actions, actionsWidth = 132, rowStyle }) {
  const isMobile = useIsMobile();
  const [dx, setDx] = useState(0);
  const start = useRef(null);
  const lock = useRef(null);   // 'h' | 'v' | null

  // Desktop: everything inline, no swipe.
  if (!isMobile) {
    return <div style={{ display: 'flex', alignItems: 'center', gap: 10, ...rowStyle }}>{main}<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{actions}</div></div>;
  }

  const onStart = (e) => { const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY, dx }; lock.current = null; };
  const onMove = (e) => {
    if (!start.current) return;
    const t = e.touches[0];
    const ddx = t.clientX - start.current.x, ddy = t.clientY - start.current.y;
    if (!lock.current) { if (Math.abs(ddx) < 6 && Math.abs(ddy) < 6) return; lock.current = Math.abs(ddx) > Math.abs(ddy) ? 'h' : 'v'; }
    if (lock.current !== 'h') return;                 // vertical → let the list scroll
    let nx = start.current.dx + ddx;
    nx = Math.max(-actionsWidth, Math.min(0, nx));    // only open leftward
    setDx(nx);
  };
  const onEnd = () => { if (lock.current === 'h') setDx(dx < -actionsWidth / 2 ? -actionsWidth : 0); start.current = null; lock.current = null; };

  return (
    <div style={{ position: 'relative', overflow: 'hidden', ...rowStyle }}>
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: actionsWidth, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, paddingRight: 10, background: '#f1f5f9' }}>
        {actions}
      </div>
      <div onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd}
        style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--card, #fff)', transform: `translateX(${dx}px)`, transition: start.current ? 'none' : 'transform .2s ease', position: 'relative', zIndex: 1, willChange: 'transform' }}>
        {main}
        {dx === 0 && actions && <span style={{ color: 'var(--muted)', fontSize: 16, opacity: .5, paddingLeft: 2 }} aria-hidden>‹</span>}
      </div>
    </div>
  );
}
