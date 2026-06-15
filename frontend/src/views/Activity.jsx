import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn, getToken, today } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

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
    case 'CLOCK_IN':     return { icon: '🟢', text: `Clocked in ${m.staff || 'staff'}` };
    case 'CLOCK_OUT':    return { icon: '🔵', text: `Clocked out ${m.staff || 'staff'}` };
    case 'FACE_ENROLL':  return { icon: '🙂', text: 'Enrolled a staff face' };
    case 'REMOVE_MEMBER': return { icon: '👤', text: 'Removed a member' };
    case 'SALE':         return { icon: '🧾', text: `Rang up sale${m.receipt_no ? ` #${m.receipt_no}` : ''}${m.total != null ? ` — ${ngn(m.total)}` : ''}` };
    case 'LOGIN':        return { icon: '🔑', text: 'Signed in' };
    default:             return { icon: '•', text: `${a.action} ${a.entity || ''}`.trim() };
  }
}

export default function Activity() {
  const { tenant } = useStore();
  const role = useRole();
  const isMgrUp = role && atLeast(role, 'GENERAL_MANAGER');
  const [data, setData] = useState(null);
  const [team, setTeam] = useState([]);
  const [teamEnd, setTeamEnd] = useState(false);
  const [filters, setFilters] = useState({ user_id: '', from: '', to: '' });
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('activity');

  useEffect(() => {
    setLoading(true);
    api(scoped('/me/activity')).then(setData).catch(() => setData({ audits: [], emails: [] })).finally(() => setLoading(false));
    if (isMgrUp) api(scoped('/members')).then((d) => setMembers(d.members || [])).catch(() => {});
  }, [tenant, isMgrUp]);

  const fetchTeam = useCallback(async ({ before = null, append = false } = {}) => {
    if (!isMgrUp) return;
    const p = new URLSearchParams();
    if (filters.user_id) p.set('user_id', filters.user_id);
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    if (before) p.set('before', before);
    const rows = await api(scoped(`/activity/all?${p}`)).catch(() => []);
    setTeam((prev) => (append ? [...prev, ...rows] : rows));
    setTeamEnd(rows.length < 100);
  }, [isMgrUp, filters]);
  useEffect(() => { fetchTeam({}); }, [fetchTeam]);
  const loadMore = () => { if (team.length) fetchTeam({ before: team[team.length - 1].created_at, append: true }); };

  const exportCsv = async () => {
    const p = new URLSearchParams();
    if (filters.user_id) p.set('user_id', filters.user_id);
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    if (tenant) p.set('tenant', tenant);
    try {
      const res = await fetch(`/api/activity/all.csv?${p}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('export failed');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `activity_${filters.from || 'all'}_${filters.to || today()}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  };

  const audits = data?.audits || [];
  const emails = data?.emails || [];

  return (
    <div>
      <div className="section-title" style={{ marginTop: 0 }}>Activity</div>
      <div className="seg" style={{ marginBottom: 14, overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`seg-b${tab === 'activity' ? ' on' : ''}`} onClick={() => setTab('activity')}>🕑 My activity</button>
        {isMgrUp && <button className={`seg-b${tab === 'team' ? ' on' : ''}`} onClick={() => setTab('team')}>👥 Team</button>}
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
      ) : tab === 'team' ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <select className="input" style={{ flex: '1 1 140px' }} value={filters.user_id} onChange={(e) => setFilters((f) => ({ ...f, user_id: e.target.value }))}>
              <option value="">Everyone</option>
              {members.map((m) => <option key={m.user_id || m.id} value={m.user_id || m.id}>{m.name || m.email}</option>)}
            </select>
            <input type="date" className="input" style={{ flex: '1 1 110px' }} value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
            <input type="date" className="input" style={{ flex: '1 1 110px' }} value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
            <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 12px' }} onClick={exportCsv} disabled={team.length === 0}>⬇ CSV</button>
          </div>
          {team.length === 0 ? (
            <div className="empty"><div className="ic">👥</div><p>No matching activity</p></div>
          ) : (
            <>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {team.map((a, i) => {
                  const d = describe(a);
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', borderBottom: '1px solid var(--line)' }}>
                      <div style={{ fontSize: 18 }}>{d.icon}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{d.text}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          <strong style={{ color: 'var(--ink)' }}>{a.actor_name || a.actor_email || 'Someone'}</strong> · {when(a.created_at)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!teamEnd && <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={loadMore}>Load more</button>}
            </>
          )}
        </>
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
