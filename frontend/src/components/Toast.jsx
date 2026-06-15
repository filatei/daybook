import React from 'react';
import { useStore } from '../store.jsx';

export default function Toast() {
  const { toast } = useStore();
  if (!toast || !toast.msg) return null;   // never render an empty toast (was a stray dark bar)
  return (
    <div className={`toast toast-${toast.kind}`}>
      {toast.msg}
    </div>
  );
}
