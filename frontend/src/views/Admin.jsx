import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';

function SiteForm({ site, onSave, onClose }) {
  const { toast } = useStore();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({ code: site?.code || '', name: site?.name || '', address: site?.address || '', is_hq: site?.is_hq || false });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    if (!f.code || !f.name) return toast('Code and name required', 'err');
    setSaving(true);
    try {
      if (site?.id) await api(scoped(`/sites/${site.id}`), { method: 'PATCH', body: f });
      else await api(scoped('/sites'), { method: 'POST', body: f });
      toast('Saved ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>{site?.id ? 'Edit Site' : 'New Site'}</h3>
      <label className="fl">Code</label>
      <input className="input" value={f.code} maxLength={10} placeholder="e.g. HQ" onChange={(e) => set('code', e.target.value.toUpperCase())} />
      <label className="fl">Name</label>
      <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
      <label className="fl">Address</label>
      <input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} />
      <label className="fl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={f.is_hq} onChange={(e) => set('is_hq', e.target.checked)} /> HQ / Head office
      </label>
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
      </div>
    </div>
  );
}

function MemberForm({ members, onInvite, onClose }) {
  const { toast } = useStore();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('SITE_MANAGER');
  const [saving, setSaving] = useState(false);
  const invite = async () => {
    if (!email) return;
    setSaving(true);
    try { await onInvite(email, role); onClose(); }
    catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>Invite Member</h3>
      <label className="fl">Email</label>
      <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label className="fl">Role</label>
      <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="SITE_MANAGER">Site Manager</option>
        <option value="GENERAL_MANAGER">General Manager</option>
        <option value="ADMIN">Admin</option>
      </select>
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={invite} disabled={saving}>{saving ? <span className="spin" /> : null} Invite</button>
      </div>
    </div>
  );
}

export default function Admin() {
  const { openModal, closeModal, toast, tenant } = useStore();
  const role = useRole();
  const isAdmin = atLeast(role, 'ADMIN');
  const [tab, setTab] = useState('sites');
  const [sites, setSites] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadSites = useCallback(async () => {
    try { setSites(await api(scoped('/sites'))); } catch { setSites([]); }
  }, [tenant]);

  const loadMembers = useCallback(async () => {
    try { setMembers(await api(scoped('/members'))); } catch { setMembers([]); }
  }, [tenant]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadSites(), loadMembers()]).finally(() => setLoading(false));
  }, [tenant]);

  const openSiteForm = (site = null) => {
    openModal(<SiteForm site={site} onSave={loadSites} onClose={closeModal} />);
  };

  const inviteMember = async (email, inviteRole) => {
    await api(scoped('/members/invite'), { method: 'POST', body: { email, role: inviteRole } });
    toast(`Invited ${email}`, 'ok');
    await loadMembers();
  };

  return (
    <div>
      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={`seg-b${tab === 'sites' ? ' on' : ''}`} onClick={() => setTab('sites')}>🏗️ Sites</button>
        <button className={`seg-b${tab === 'members' ? ' on' : ''}`} onClick={() => setTab('members')}>👥 Members</button>
      </div>

      {loading ? (
        <>{[...Array(4)].map((_, i) => <div className="skel" key={i} />)}</>
      ) : tab === 'sites' ? (
        <>
          {sites.length === 0 ? (
            <div className="empty"><div className="ic">🏗️</div><p>No sites yet</p></div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {sites.map((s) => (
                <button key={s.id} onClick={() => openSiteForm(s)}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }}>
                  <div className="av" style={{ fontSize: 14, fontWeight: 800 }}>{s.code}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{s.name} {s.is_hq ? '⭐' : ''}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{s.address || 'No address'}</div>
                  </div>
                  <span style={{ color: 'var(--muted)' }}>›</span>
                </button>
              ))}
            </div>
          )}
          {isAdmin && <button className="fab" onClick={() => openSiteForm()}>+</button>}
        </>
      ) : (
        <>
          {members.length === 0 ? (
            <div className="empty"><div className="ic">👥</div><p>No members yet</p></div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {members.map((m) => (
                <div key={m.id || m.user_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                  <div className="av">{(m.name || m.email || '?')[0].toUpperCase()}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>{m.name || m.email}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.email} · {m.role}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {isAdmin && (
            <button className="fab" onClick={() => openModal(<MemberForm members={members} onInvite={inviteMember} onClose={closeModal} />)}>+</button>
          )}
        </>
      )}
    </div>
  );
}
