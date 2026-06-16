/**
 * SiteMessages.jsx — a private channel from a site user to the admin.
 * A user posts a message; only that user and admins can see it. The sender can
 * remove their own copy; an admin removing it only hides the admin's copy.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { api, scoped } from '../api.js';
import { useStore } from '../store.jsx';

const when = (s) => { try { return new Date((s || 0) * 1000).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

export default function SiteMessages() {
  const { tenant, toast } = useStore();
  const [data, setData] = useState(null);     // { is_admin, messages }
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api(scoped('/site-messages'))); } catch { setData({ is_admin: false, messages: [] }); }
  }, [tenant]);
  useEffect(() => { load(); }, [load]);

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setSending(true);
    try { await api(scoped('/site-messages'), { method: 'POST', body: { body: text } }); setBody(''); toast('Message sent ✓', 'ok'); load(); }
    catch (e) { toast(e.message || 'Could not send', 'err'); }
    setSending(false);
  };

  const remove = async () => {
    try { await api(scoped(`/site-messages/${confirmDel.id}`), { method: 'DELETE' }); setConfirmDel(null); toast('Removed', 'ok'); load(); }
    catch (e) { toast(e.message || 'Could not remove', 'err'); }
  };

  const isAdmin = data?.is_admin;
  const msgs = data?.messages || [];

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>Site messages</div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0, marginBottom: 14 }}>
        {isAdmin ? 'Private messages from your site users. Only you and the sender can see each one.' : 'Send a private message to the admin. Only you and the admin can see it.'}
      </p>

      {!isAdmin && (
        <div className="card" style={{ marginBottom: 14 }}>
          <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="Write a message to the admin…" />
          <button className="btn" style={{ marginTop: 10 }} onClick={send} disabled={sending || !body.trim()}>
            {sending ? <span className="spin" /> : 'Send to admin'}
          </button>
        </div>
      )}

      {data === null ? (
        <>{[...Array(3)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : msgs.length === 0 ? (
        <div className="empty"><div className="ic">✉️</div><p>{isAdmin ? 'No messages yet' : 'No messages yet — send your first above'}</p></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {msgs.map((m) => (
            <div key={m.id} className="card" style={{ padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                <strong style={{ fontSize: 13 }}>
                  {isAdmin ? (m.sender_name || m.sender_email || 'User') : 'You'}
                  {m.site_name ? <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · {m.site_name}</span> : null}
                </strong>
                <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{when(m.created_at)}</span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{m.body}</div>
              {(m.mine || isAdmin) && (
                <div style={{ textAlign: 'right', marginTop: 6 }}>
                  <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '3px 10px', color: 'var(--err)' }}
                    onClick={() => setConfirmDel(m)} title={m.mine ? 'Remove your copy' : 'Remove from your view'}>Remove</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {confirmDel && (
        <div onClick={() => setConfirmDel(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', display: 'grid', placeItems: 'center', zIndex: 130, padding: 16 }}>
          <div className="card pop-in" onClick={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 320, margin: 0, textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 4 }}>✉️</div>
            <div style={{ fontWeight: 800, fontSize: 16 }}>Remove this message?</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', margin: '6px 0 16px' }}>
              {confirmDel.mine ? 'It disappears from your view; the admin still keeps their copy.' : 'It disappears from your view only; the sender still keeps their copy.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDel(null)}>Cancel</button>
              <button className="btn" style={{ flex: 1, background: 'var(--err)' }} onClick={remove}>Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
