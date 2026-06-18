import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, timeAgo } from '../api.js';
import { useStore, useBackHandler } from '../store.jsx';
import { useRealtime } from '../hooks/useRealtime.js';

const clockOf = (s) => new Date((s || 0) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function Chat() {
  const { user, toast } = useStore();
  const me = user?.id;
  const [users, setUsers] = useState(null);
  const [active, setActive] = useState(null);      // the user object we're chatting with
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  useBackHandler(!!active, () => setActive(null));   // hardware back: thread → roster

  const loadRoster = useCallback(() => {
    api(scoped('/chat/users')).then((r) => setUsers(r.users || [])).catch(() => setUsers([]));
  }, []);
  useEffect(() => { loadRoster(); }, [loadRoster]);

  const openThread = useCallback(async (u) => {
    setActive(u); setMessages([]);
    try {
      const r = await api(scoped(`/chat/thread/${u.id}`));
      setMessages(r.messages || []);
      window.dispatchEvent(new CustomEvent('chat-read'));   // refresh Nav badge
      setUsers((list) => (list || []).map((x) => x.id === u.id ? { ...x, unread: 0 } : x));
    } catch (e) { toast(e.message || 'Could not load chat', 'err'); }
  }, [toast]);

  // Realtime: incoming DMs, presence, read receipts.
  useRealtime((evt) => {
    const p = evt.payload || {};
    if (evt.type === 'presence.online' || evt.type === 'presence.offline') {
      const on = evt.type === 'presence.online';
      setUsers((list) => (list || []).map((x) => x.id === p.user_id ? { ...x, online: on } : x));
    } else if (evt.type === 'chat.message') {
      const otherId = p.from_user === me ? p.to_user : p.from_user;
      // Append to the open thread (dedupe by id), else bump the roster unread.
      if (active && otherId === active.id) {
        setMessages((m) => m.some((x) => x.id === p.id) ? m : [...m, p]);
        if (p.from_user === active.id) {
          api(scoped(`/chat/read/${active.id}`), { method: 'POST', body: {} }).catch(() => {});
          window.dispatchEvent(new CustomEvent('chat-read'));
        }
      }
      setUsers((list) => (list || []).map((x) => x.id === otherId
        ? { ...x, last_at: p.created_at, unread: (active && otherId === active.id) ? 0 : (p.to_user === me ? (x.unread || 0) + 1 : x.unread) }
        : x).sort((a, b) => (b.last_at || 0) - (a.last_at || 0)));
    } else if (evt.type === 'chat.read') {
      if (active && p.by === active.id) setMessages((m) => m.map((x) => x.from_user === me ? { ...x, read_at: p.at } : x));
    }
  });

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const send = async () => {
    const body = draft.trim();
    if (!body || !active || sending) return;
    setSending(true);
    setDraft('');
    try {
      const msg = await api(scoped('/chat/send'), { method: 'POST', body: { to: active.id, body } });
      setMessages((m) => m.some((x) => x.id === msg.id) ? m : [...m, msg]);
      setUsers((list) => (list || []).map((x) => x.id === active.id ? { ...x, last_at: msg.created_at } : x).sort((a, b) => (b.last_at || 0) - (a.last_at || 0)));
    } catch (e) { toast(e.message || 'Send failed', 'err'); setDraft(body); }
    setSending(false);
  };

  // ── Roster (conversation list) ──────────────────────────────────────────────
  if (!active) {
    return (
      <div>
        <div className="section-title" style={{ marginTop: 0 }}>💬 Chat</div>
        {users === null ? <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
          : users.length === 0 ? <div className="empty"><div className="ic">💬</div><p>No teammates to chat with yet</p></div>
            : (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {users.map((u) => (
                  <button key={u.id} onClick={() => openThread(u)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
                    <div style={{ position: 'relative' }}>
                      <div className="av">{(u.name || '?')[0].toUpperCase()}</div>
                      <span style={{ position: 'absolute', right: -1, bottom: -1, width: 11, height: 11, borderRadius: '50%', background: u.online ? '#16a34a' : '#94a3b8', border: '2px solid #fff' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>{u.name}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{u.online ? 'online' : 'offline'}{u.site_name ? ` · ${u.site_name}` : ''}</div>
                    </div>
                    {u.unread > 0 && <span className="chat-badge">{u.unread}</span>}
                    {u.last_at && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{timeAgo(u.last_at)}</span>}
                  </button>
                ))}
              </div>
            )}
      </div>
    );
  }

  // ── Conversation thread ─────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 200px)', minHeight: 360 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 10, borderBottom: '1px solid var(--line)' }}>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => setActive(null)}>‹</button>
        <div className="av">{(active.name || '?')[0].toUpperCase()}</div>
        <div>
          <div style={{ fontWeight: 800 }}>{active.name}</div>
          <div style={{ fontSize: 12, color: active.online ? 'var(--ok)' : 'var(--muted)' }}>{active.online ? 'online' : 'offline'}</div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 2px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {messages.length === 0 && <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, marginTop: 20 }}>No messages yet — say hello 👋</div>}
        {messages.map((m) => {
          const mine = m.from_user === me;
          return (
            <div key={m.id} style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
              <div style={{ background: mine ? 'var(--brand)' : '#f1f5f9', color: mine ? '#fff' : 'var(--ink)', padding: '8px 12px', borderRadius: 14, borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4, fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {m.body}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', textAlign: mine ? 'right' : 'left', marginTop: 2 }}>
                {clockOf(m.created_at)}{mine ? (m.read_at ? ' · read' : ' · sent') : ''}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <input className="input" placeholder="Message…" value={draft}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn" style={{ width: 'auto', padding: '0 18px' }} onClick={send} disabled={sending || !draft.trim()}>{sending ? <span className="spin" /> : 'Send'}</button>
      </div>
    </div>
  );
}
