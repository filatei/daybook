import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn } from '../api.js';
import { useStore } from '../store.jsx';

const when = (s) => new Date((s || 0) * 1000).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// Human-readable line for an audit action.
function describe(a) {
  const m = a.meta || {};
  switch (a.action) {
    case 'INVITE':       return { icon: '✉️', text: `Invited ${a.entity_id} as ${m.role || 'member'}` };
    case 'ADD_MEMBER':   return { icon: '👥', text: `Added ${m.email || 'member'} as ${m.role || 'member'}` };
    case 'DISMISS_MEMBER': return { icon: '🚫', text: 'Dismissed a member' };
    case 'RESTORE_MEMBER': return { icon: '↩️', text: 'Restored a member' };
    case 'CREATE':       return { icon: '➕', text: `Created ${a.entity}${m.name ? ` “${m.name}”` : ''}${m.code ? ` (${m.code})` : ''}` };
    case 'DELETE':       return { icon: '🗑', text: `Deleted ${a.entity}${m.receipt_no ? ` #${m.receipt_no}` : ''}${m.total ? ` — ${ngn(m.total)}` : ''}` };
    case 'EXIT':         return { icon: '🚪', text: `Released order${m.receipt_no ? ` #${m.receipt_no}` : ''} at gate` };
    case 'LOADED':       return { icon: '📦', text: `Marked order${m.receipt_no ? ` #${m.receipt_no}` : ''} loaded` };
    default:             return { icon: '•', text: `${a.action} ${a.entity || ''}`.trim() };
  }
}

export default function Activity() {
  const { tenant } = useStore();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('activity');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api(scoped('/me/activity'))); } catch { setData({ audits: [], emails: [] }); }
    setLoading(false);
  }, [tenant]);
  useEffect(() => { load(); }, [load]);

  const audits = data?.audits || [];
  const emails = data?.emails || [];

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>Activity</div>
      <div className="seg" style={{ marginBottom: 14 }}>
        <button className={`seg-b${tab === 'activity' ? ' on' : ''}`} onClick={() => setTab('activity')}>🕑 My activity</button>
        <button className={`seg-b${tab === 'messages' ? ' on' : ''}`} onClick={() => setTab('messages')}>✉️ Messages</button>
      </div>

      {loading ? (
        <>{[...Array(5)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : tab === 'activity' ? (
        audits.length === 0 ? (
          <div className="empty"><div className="ic">🕑</div><p>No recent activity</p></div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {audits.map((a, i) => {
              const d = describe(a);
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ fontSize: 18 }}>{d.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{d.text}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{when(a.created_at)}{a.tenant_name ? ` · ${a.tenant_name}` : ''}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        emails.length === 0 ? (
          <div className="empty"><div className="ic">✉️</div><p>No messages sent yet</p></div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {emails.map((e, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--line)' }}>
                <div style={{ fontSize: 18 }}>{e.status === 'SENT' ? '✅' : '⚠️'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.subject || 'Email'}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{e.to_addrs} · {e.status}{e.error ? ` — ${e.error}` : ''} · {when(e.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
