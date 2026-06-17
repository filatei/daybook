import React, { useState } from 'react';
import { api, scoped } from '../api.js';
import { useStore } from '../store.jsx';

// Contact us — sends to all admins (email + their in-app Alerts inbox).
export default function ContactForm({ onClose }) {
  const { toast } = useStore();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!message.trim()) return toast('Write a message first', 'err');
    setSending(true);
    try {
      const r = await api(scoped('/contact'), { method: 'POST', body: { subject: subject.trim(), message: message.trim() } });
      toast(r.recipients ? 'Sent to your admins ✓' : 'Sent ✓', 'ok');
      onClose();
    } catch (e) { toast(e.message || 'Could not send', 'err'); }
    setSending(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3 style={{ marginBottom: 2 }}>Contact us</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>Goes to your company admins — by email and in their in-app Alerts.</p>
      <label className="fl">Subject</label>
      <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What's it about?" />
      <label className="fl">Message</label>
      <textarea className="input" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Tell us what you need, a problem you found, or feedback…" style={{ resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={sending}>Cancel</button>
        <button className="btn" style={{ flex: 1 }} onClick={send} disabled={sending}>{sending ? <span className="spin" /> : 'Send'}</button>
      </div>
    </div>
  );
}
