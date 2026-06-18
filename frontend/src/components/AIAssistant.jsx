import React, { useState, useRef, useEffect } from 'react';
import { api, scoped } from '../api.js';
import { useStore } from '../store.jsx';

// Admin-only assistant — asks the backend /ai/chat, which reads THIS company's
// data (live POS/expenses/payroll/staff + Daybook reports) scoped to the user.
export default function AIAssistant({ onClose }) {
  const { toast } = useStore();
  const [msgs, setMsgs] = useState([
    { role: 'assistant', content: 'Hi! Ask me about your data — e.g. “sales by site this week”, “which site has the highest diesel cost?”, “staff headcount”, or “summarise yesterday’s reports”.' },
  ]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  const send = async () => {
    const text = q.trim();
    if (!text || busy) return;
    const history = msgs.filter((m) => m.role === 'user' || m.role === 'assistant');
    setMsgs((m) => [...m, { role: 'user', content: text }]);
    setQ(''); setBusy(true);
    try {
      const r = await api(scoped('/ai/chat'), { method: 'POST', body: { message: text, history } });
      setMsgs((m) => [...m, { role: 'assistant', content: r.reply || '(no answer)' }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: 'assistant', content: `⚠️ ${e.message || 'AI is unavailable right now.'}` }]);
      if (/not configured|unavailable/i.test(e.message || '')) toast('AI assistant is not configured on the server', 'err');
    }
    setBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '82vh' }}>
      <div className="grip" />
      <h3 style={{ margin: '0 0 8px' }}>🤖 Daybook Assistant</h3>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 2px', minHeight: 200 }}>
        {msgs.map((m, i) => {
          const mine = m.role === 'user';
          return (
            <div key={i} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
              <div style={{ background: mine ? 'var(--brand)' : '#f1f5f9', color: mine ? '#fff' : 'var(--ink)', padding: '9px 13px', borderRadius: 14, borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4, fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {m.content}
              </div>
            </div>
          );
        })}
        {busy && <div style={{ alignSelf: 'flex-start', color: 'var(--muted)', fontSize: 13, padding: '4px 6px' }}><span className="spin" /> thinking…</div>}
        <div ref={endRef} />
      </div>

      <div style={{ display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--line)', marginTop: 8 }}>
        <input className="input" placeholder="Ask about your sales, expenses, staff…" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} autoFocus />
        <button className="btn" style={{ width: 'auto', padding: '0 18px' }} onClick={send} disabled={busy || !q.trim()}>{busy ? <span className="spin" /> : 'Ask'}</button>
      </div>
      <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={onClose}>Close</button>
    </div>
  );
}
