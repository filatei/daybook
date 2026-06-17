import React, { useEffect } from 'react';
import { useStore } from '../store.jsx';

// Styled in-app replacement for window.confirm — driven by store.confirm().
export default function ConfirmDialog() {
  const { confirm: cfg, resolveConfirm } = useStore();

  useEffect(() => {
    if (!cfg) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') resolveConfirm(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cfg, resolveConfirm]);

  if (!cfg) return null;
  return (
    <div className="modal-bg" style={{ zIndex: 200, alignItems: 'center', padding: 16 }} onClick={(e) => { if (e.target === e.currentTarget) resolveConfirm(false); }}>
      <div className="confirm-box">
        {cfg.title && <h3 style={{ margin: '0 0 6px' }}>{cfg.title}</h3>}
        {cfg.message && <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>{cfg.message}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => resolveConfirm(false)}>{cfg.cancelText || 'Cancel'}</button>
          <button className="btn" style={{ flex: 1, ...(cfg.danger ? { background: 'var(--err)' } : {}) }} onClick={() => resolveConfirm(true)}>{cfg.confirmText || 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}
