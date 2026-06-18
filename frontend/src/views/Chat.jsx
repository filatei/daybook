import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, scoped, timeAgo, isNetErr, getActiveTenant } from '../api.js';
import { useStore, useBackHandler } from '../store.jsx';
import { useRealtime } from '../hooks/useRealtime.js';
import { queueChat, syncChatOutbox, pendingChat } from '../chatOutbox.js';

const newUid = () => (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const clockOf = (s) => new Date((s || 0) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function Chat() {
  const { user, toast } = useStore();
  const me = user?.id;
  const [users, setUsers] = useState(null);
  const [active, setActive] = useState(null);      // the user object we're chatting with
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);   // message being replied to
  const endRef = useRef(null);
  const inputRef = useRef(null);
  const lpTimer = useRef(null);   // long-press timer (mobile reply)

  const nameOfUser = (uid) => uid === me ? 'You' : (active?.name || 'them');

  useBackHandler(!!active, () => setActive(null));   // hardware back: thread → roster

  const loadRoster = useCallback(() => {
    api(scoped('/chat/users')).then((r) => setUsers(r.users || [])).catch(() => setUsers([]));
  }, []);
  useEffect(() => { loadRoster(); }, [loadRoster]);

  const openThread = useCallback(async (u) => {
    setActive(u); setMessages([]);
    try {
      const r = await api(scoped(`/chat/thread/${u.id}`));
      const server = r.messages || [];
      // Append any still-queued (offline) messages for this conversation.
      const haveUids = new Set(server.map((m) => m.client_uid).filter(Boolean));
      const queued = pendingChat(getActiveTenant(), u.id)
        .filter((p) => !haveUids.has(p.client_uid))
        .map((p) => ({ id: p.client_uid, client_uid: p.client_uid, from_user: me, to_user: u.id, body: p.body, created_at: Math.floor(Date.now() / 1000), read_at: null, reply_to: p.reply_to || null, status: 'queued' }));
      setMessages([...server, ...queued]);
      window.dispatchEvent(new CustomEvent('chat-read'));   // refresh Nav badge
      setUsers((list) => (list || []).map((x) => x.id === u.id ? { ...x, unread: 0 } : x));
    } catch (e) {
      // Offline: still let them open the thread and see/queue messages.
      if (isNetErr(e)) setMessages(pendingChat(getActiveTenant(), u.id).map((p) => ({ id: p.client_uid, client_uid: p.client_uid, from_user: me, to_user: u.id, body: p.body, created_at: Math.floor(Date.now() / 1000), status: 'queued' })));
      else toast(e.message || 'Could not load chat', 'err');
    }
  }, [toast, me]);

  // Flush any queued messages on mount; refresh the open thread once they send.
  useEffect(() => { syncChatOutbox(); }, []);
  useEffect(() => {
    const onSynced = () => { setActive((a) => { if (a) openThread(a); return a; }); loadRoster(); };
    window.addEventListener('chat-synced', onSynced);
    return () => window.removeEventListener('chat-synced', onSynced);
  }, [openThread, loadRoster]);

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
        setMessages((m) => {
          if (p.client_uid && m.some((x) => x.client_uid === p.client_uid)) return m.map((x) => x.client_uid === p.client_uid ? { ...p, status: 'sent' } : x);
          if (m.some((x) => x.id === p.id)) return m;
          return [...m, p];
        });
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
    if (!body || !active) return;
    const reply = replyTo;
    const cuid = newUid();
    const optimistic = {
      id: cuid, client_uid: cuid, from_user: me, to_user: active.id, body,
      created_at: Math.floor(Date.now() / 1000), read_at: null,
      reply_to: reply?.id || null, reply_excerpt: reply ? String(reply.body).slice(0, 120) : null, reply_from: reply?.from_user || null,
      status: 'sending',
    };
    setDraft(''); setReplyTo(null);
    setMessages((m) => [...m, optimistic]);
    setUsers((list) => (list || []).map((x) => x.id === active.id ? { ...x, last_at: optimistic.created_at } : x).sort((a, b) => (b.last_at || 0) - (a.last_at || 0)));
    const payload = { to: active.id, body, reply_to: reply?.id || undefined, client_uid: cuid };
    try {
      const msg = await api(scoped('/chat/send'), { method: 'POST', body: payload });
      setMessages((m) => m.map((x) => x.client_uid === cuid ? { ...msg, status: 'sent' } : x));
    } catch (e) {
      if (isNetErr(e)) {
        queueChat(getActiveTenant(), payload);   // offline → deliver on reconnect
        setMessages((m) => m.map((x) => x.client_uid === cuid ? { ...x, status: 'queued' } : x));
      } else {
        toast(e.message || 'Send failed', 'err');
        setMessages((m) => m.filter((x) => x.client_uid !== cuid));
        setDraft(body); setReplyTo(reply);
      }
    }
  };

  const startReply = (m) => { setReplyTo(m); inputRef.current?.focus(); };
  // Long-press (≈450ms) on a bubble → reply, on touch devices.
  const lpStart = (m) => { lpTimer.current = setTimeout(() => startReply(m), 450); };
  const lpEnd = () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; } };

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
            <div key={m.id} className="chat-row" style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', display: 'flex', flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'center', gap: 4 }}>
              <div style={{ minWidth: 0 }}>
                <div onTouchStart={() => lpStart(m)} onTouchEnd={lpEnd} onTouchMove={lpEnd} onContextMenu={(e) => { e.preventDefault(); startReply(m); }}
                  style={{ background: mine ? 'var(--brand)' : '#f1f5f9', color: mine ? '#fff' : 'var(--ink)', padding: '8px 12px', borderRadius: 14, borderBottomRightRadius: mine ? 4 : 14, borderBottomLeftRadius: mine ? 14 : 4, fontSize: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: m.status === 'queued' || m.status === 'sending' ? 0.7 : 1, userSelect: 'none' }}>
                  {m.reply_to && (
                    <div style={{ borderLeft: `3px solid ${mine ? 'rgba(255,255,255,.6)' : 'var(--brand)'}`, padding: '2px 8px', marginBottom: 5, fontSize: 12, opacity: .85, background: mine ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.04)', borderRadius: 6 }}>
                      <div style={{ fontWeight: 700 }}>{nameOfUser(m.reply_from)}</div>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.reply_excerpt}</div>
                    </div>
                  )}
                  {m.body}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', textAlign: mine ? 'right' : 'left', marginTop: 2 }}>
                  {clockOf(m.created_at)}{mine ? (m.status === 'queued' ? ' · queued ⏳' : m.status === 'sending' ? ' · sending…' : (m.read_at ? ' · read' : ' · sent')) : ''}
                </div>
              </div>
              <button className="chat-reply-btn" title="Reply" onClick={() => startReply(m)}>↩</button>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {replyTo && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderLeft: '3px solid var(--brand)', background: 'var(--brand-l)', borderRadius: 8, margin: '6px 0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>Replying to {nameOfUser(replyTo.from_user)}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyTo.body}</div>
          </div>
          <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '2px 8px' }} onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <input ref={inputRef} className="input" placeholder="Message…" value={draft}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn" style={{ width: 'auto', padding: '0 18px' }} onClick={send} disabled={!draft.trim()}>Send</button>
      </div>
    </div>
  );
}
