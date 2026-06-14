import React, { useEffect } from 'react';
import { useStore } from '../store.jsx';

export default function Modal() {
  const { modal, closeModal } = useStore();

  useEffect(() => {
    if (!modal) return;
    const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, closeModal]);

  if (!modal) return null;
  return (
    <div className="modal-bg" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div className="modal-box">
        <button className="modal-close" onClick={closeModal} aria-label="Close">✕</button>
        {modal}
      </div>
    </div>
  );
}
