import React, { useState } from 'react';
import { api, scoped } from '../api.js';
import { useStore } from '../store.jsx';

// Contact us — sends to all admins (email + their in-app Alerts inbox).
const DEFAULT_SUBJECT = 'Contact from Daybook app';

export default function ContactForm({ onClose }) {
  const { toast } = useStore();
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!message.trim()) return toast('Type your message first', 'err');
    setSending(true);
    try {
      const r = await api(scoped('/contact'), { method: 'POST', body: { subject: DEFAULT_SUBJECT, message: message.trim() } });
      toast(r.recipients ? 'Sent to your admins ✓' : 'Sent ✓', 'ok');
      onClose();
    } catch (e) { toast(e.message || 'Could not send', 'err'); }
    setSending(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3 style={{ marginBottom: 2 }}>Contact us</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>Just type your message — it goes to your company admins by email and in their in-app Alerts.</p>
      <textarea className="input" rows={6} value={message} onChange={(e) => setMessage(e.target.value)} autoFocus
        placeholder="Tell us what you need, a problem you found, or feedback…" style={{ resize: 'vertical', marginTop: 6 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={sending}>Cancel</button>
        <button className="btn" style={{ flex: 1 }} onClick={send} disabled={sending}>{sending ? <span className="spin" /> : 'Send'}</button>
      </div>
    </div>
  );
}
