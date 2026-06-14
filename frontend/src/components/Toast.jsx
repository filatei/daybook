import React from 'react';
import { useStore } from '../store.jsx';

export default function Toast() {
  const { toast } = useStore();
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.kind}`}>
      {toast.msg}
    </div>
  );
}
