import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn } from '../api.js';
import { useStore, useRole, atLeast, ROLE_LABELS } from '../store.jsx';

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

function MemberForm({ sites = [], onInvite, onClose }) {
  const { toast } = useStore();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('SECRETARY');
  const [siteId, setSiteId] = useState(sites[0]?.id || '');
  const [saving, setSaving] = useState(false);
  const SITE_ROLES = ['SITE_MANAGER', 'SECRETARY', 'GATEMAN', 'SUPERVISOR'];   // site-bound
  const needsSite = role === 'SITE_MANAGER' || role === 'SECRETARY';
  const invite = async () => {
    if (!email) return toast('Email required', 'err');
    if (needsSite && !siteId) return toast('Pick a site for this Manager', 'err');
    setSaving(true);
    try { await onInvite(email, role, SITE_ROLES.includes(role) ? siteId : null); onClose(); }
    catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>Add Member</h3>
      <p className="sub" style={{ marginTop: -4 }}>They auto-join this company with the role you pick the moment they sign in with this Google email. A member can belong to several companies.</p>
      <label className="fl">Email</label>
      <input type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label className="fl">Role</label>
      <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
        <optgroup label="Gate / Loading (gate screen only)">
          <option value="GATEMAN">{ROLE_LABELS.GATEMAN} — scan &amp; release (exit)</option>
          <option value="SUPERVISOR">{ROLE_LABELS.SUPERVISOR} — scan &amp; mark loaded</option>
        </optgroup>
        <optgroup label="Office (privilege ladder)">
          <option value="SECRETARY">{ROLE_LABELS.SECRETARY} — one site: sales, expenses, attendance, generators</option>
          <option value="ACCOUNTANT">{ROLE_LABELS.ACCOUNTANT} — + reconcile</option>
          <option value="SNR_ACCOUNTANT">{ROLE_LABELS.SNR_ACCOUNTANT} — + payroll</option>
          <option value="SITE_MANAGER">{ROLE_LABELS.SITE_MANAGER} — site operations</option>
          <option value="GENERAL_MANAGER">{ROLE_LABELS.GENERAL_MANAGER} — all sites</option>
          <option value="ADMIN">{ROLE_LABELS.ADMIN} — full access</option>
        </optgroup>
      </select>
      {SITE_ROLES.includes(role) && sites.length > 0 && (
        <>
          <label className="fl">Site{needsSite ? ' *' : ' (optional)'}</label>
          <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">— none —</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </>
      )}
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={invite} disabled={saving}>{saving ? <span className="spin" /> : null} Add Member</button>
      </div>
    </div>
  );
}

// ── Edit an existing member's role / site ─────────────────────────────────────
const ROLE_OPTIONS = [
  ['GATEMAN', '— scan & release (exit)'], ['SUPERVISOR', '— scan & mark loaded'],
  ['SECRETARY', '— one site: front office'], ['ACCOUNTANT', '— + reconcile'],
  ['SNR_ACCOUNTANT', '— GM-level + payroll'], ['SITE_MANAGER', '— site operations'],
  ['GENERAL_MANAGER', '— all sites'], ['ADMIN', '— full access'],
];
const SITE_ROLES = ['SITE_MANAGER', 'SECRETARY', 'GATEMAN', 'SUPERVISOR'];
function EditMemberForm({ member, sites = [], onSave, onRemove, onClose }) {
  const { toast } = useStore();
  const [role, setRole] = useState(member.role);
  const [siteId, setSiteId] = useState(member.site_id || '');
  const [saving, setSaving] = useState(false);
  const needsSite = role === 'SITE_MANAGER' || role === 'SECRETARY';
  const save = async () => {
    if (needsSite && !siteId) return toast('Pick a site for this role', 'err');
    setSaving(true);
    try { await onSave(member.id, { role, site_id: SITE_ROLES.includes(role) ? (siteId || null) : null }); onClose(); }
    catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  return (
    <div>
      <div className="grip" />
      <h3>Edit member</h3>
      <p className="sub" style={{ marginTop: -4 }}>{member.name || member.email}</p>
      <label className="fl">Role</label>
      <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
        {ROLE_OPTIONS.map(([v, d]) => <option key={v} value={v}>{ROLE_LABELS[v] || v} {d}</option>)}
      </select>
      {SITE_ROLES.includes(role) && sites.length > 0 && (
        <>
          <label className="fl">Site{needsSite ? ' *' : ' (optional)'}</label>
          <select className="input" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">— none —</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </>
      )}
      {!SITE_ROLES.includes(role) && <p style={{ fontSize: 12, color: 'var(--muted)' }}>This role is cross-site (no single site).</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" style={{ flex: 1, color: 'var(--err)' }} onClick={() => onRemove(member)} disabled={saving}>Remove</button>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn" style={{ flex: 1.3 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : 'Save'}</button>
      </div>
    </div>
  );
}

// ── Settings (face match strictness) ─────────────────────────────────────────
function SettingsTab() {
  const { toast, tenant } = useStore();
  const [thr, setThr] = useState(0.55);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api(scoped('/settings')).then((s) => setThr(s.face_match_threshold ?? 0.55)).catch(() => {}).finally(() => setLoading(false));
  }, [tenant]);
  const save = async () => {
    setSaving(true);
    try { const r = await api(scoped('/settings'), { method: 'PATCH', body: { face_match_threshold: thr } }); setThr(r.face_match_threshold); toast('Saved ✓', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };
  // ── Email diagnostics ──────────────────────────────────────────────────────
  const [emailTo, setEmailTo] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailRes, setEmailRes] = useState(null);
  const checkEmail = async () => {
    setEmailBusy(true); setEmailRes(null);
    try { const h = await api(scoped('/email/health')); setEmailRes({ kind: 'health', ...h }); }
    catch (e) { setEmailRes({ kind: 'health', ok: false, error: e.message }); }
    setEmailBusy(false);
  };
  const testEmail = async () => {
    setEmailBusy(true); setEmailRes(null);
    try { const r = await api(scoped('/email/test'), { method: 'POST', body: { to: emailTo || undefined } }); setEmailRes({ kind: 'test', ...r }); }
    catch (e) { setEmailRes({ kind: 'test', ok: false, error: e.message }); }
    setEmailBusy(false);
  };

  if (loading) return <div className="skel" />;
  return (
    <div>
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="section-title" style={{ marginTop: 0 }}>📧 Email delivery</div>
      <p className="sub">Invite & report emails go through your SMTP relay. Test it here to see exactly what the server reports.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input className="input" style={{ flex: '1 1 200px' }} value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="send test to… (default: you)" />
        <button className="btn btn-sm" style={{ width: 'auto', padding: '8px 14px' }} onClick={testEmail} disabled={emailBusy}>{emailBusy ? <span className="spin" /> : 'Send test'}</button>
        <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '8px 14px' }} onClick={checkEmail} disabled={emailBusy}>Check connection</button>
      </div>
      {emailRes && (
        <div style={{ fontSize: 12.5, background: emailRes.ok ? '#dcfce7' : '#fee2e2', color: emailRes.ok ? '#166534' : '#991b1b', borderRadius: 10, padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {emailRes.kind === 'health'
            ? (emailRes.ok ? `✓ SMTP reachable\nHost ${emailRes.host}:${emailRes.port} · From ${emailRes.from} · auth ${emailRes.auth ? 'password' : 'IP-relay'}` : `✗ Cannot reach SMTP: ${emailRes.error}`)
            : (emailRes.ok ? `✓ Server accepted the test to ${emailRes.to}\nFrom: ${emailRes.from}\nAccepted: ${(emailRes.accepted || []).join(', ') || '—'}\nRejected: ${(emailRes.rejected || []).join(', ') || 'none'}\nServer said: ${emailRes.response || '—'}\n\nIf it accepted but you didn't get it, check Spam, and that ${emailRes.from?.match(/@([^>]+)/)?.[1] || 'the From domain'} is an allowed sender on your relay.` : `✗ Send failed: ${emailRes.error}`)}
        </div>
      )}
    </div>
    <div className="card">
      <div className="section-title" style={{ marginTop: 0 }}>Face-match strictness</div>
      <p className="sub">How close a live face must be to the enrolled face to clock in. Lower = stricter (fewer wrong matches, more retries). Higher = more lenient. Default 0.55.</p>
      <input type="range" min="0.30" max="0.80" step="0.01" value={thr} onChange={(e) => setThr(+e.target.value)} style={{ width: '100%' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        <span>Stricter 0.30</span><strong style={{ color: 'var(--ink)', fontSize: 16 }}>{thr.toFixed(2)}</strong><span>Lenient 0.80</span>
      </div>
      <button className="btn" style={{ marginTop: 14 }} onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
    </div>
    </div>
  );
}

// ── Product form ────────────────────────────────────────────────────────────
export function ProductForm({ product, onSave, onClose }) {
  const { toast, setDirty } = useStore();
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    name:        product?.name        || '',
    category:    product?.category    || '',
    price:       product?.price       ?? '',
    cost:        product?.cost        ?? '',
    sku:         product?.sku         || '',
    unit:        product?.unit        || '',
    track_stock: product?.track_stock ?? false,
    status:      product?.status      || 'ACTIVE',
  });
  const set = (k, v) => { setDirty(true); setF((p) => ({ ...p, [k]: v })); };

  const save = async () => {
    if (!f.name || f.price === '') return toast('Name and price required', 'err');
    setSaving(true);
    try {
      if (product?.id) {
        await api(scoped(`/products/${product.id}`), { method: 'PATCH', body: f });
      } else {
        await api(scoped('/products'), { method: 'POST', body: f });
      }
      toast('Saved ✓', 'ok'); onSave(); onClose();
    } catch (e) { toast(e.message, 'err'); }
    setSaving(false);
  };

  return (
    <div>
      <div className="grip" />
      <h3>{product?.id ? 'Edit Product' : 'New Product'}</h3>
      <label className="fl">Name *</label>
      <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Pure Water Pouch" />
      <div className="grid2">
        <div>
          <label className="fl">Price (₦) *</label>
          <input type="number" className="input" value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="0" />
        </div>
        <div>
          <label className="fl">Cost (₦)</label>
          <input type="number" className="input" value={f.cost} onChange={(e) => set('cost', e.target.value)} placeholder="0" />
        </div>
      </div>
      <div className="grid2">
        <div>
          <label className="fl">Unit</label>
          <input className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder="bag / crate / piece" />
        </div>
        <div>
          <label className="fl">Category</label>
          <input className="input" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="optional" />
        </div>
      </div>
      <label className="fl">SKU</label>
      <input className="input" value={f.sku} onChange={(e) => set('sku', e.target.value)} placeholder="optional" />
      <label className="fl" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={f.track_stock} onChange={(e) => set('track_stock', e.target.checked)} />
        Track stock quantity
      </label>
      {product?.id && (
        <>
          <label className="fl">Status</label>
          <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </>
      )}
      <div className="cap-bar">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : null} Save</button>
      </div>
    </div>
  );
}

// ── Admin ────────────────────────────────────────────────────────────────────
export default function Admin() {
  const { openModal, closeModal, toast, tenant } = useStore();
  const role = useRole();
  const isAdmin = atLeast(role, 'ADMIN');
  const isGM    = atLeast(role, 'GENERAL_MANAGER');
  const [tab, setTab] = useState('sites');
  const [sites,    setSites]    = useState([]);
  const [members,  setMembers]  = useState([]);
  const [invites,  setInvites]  = useState([]);
  const [resendingId, setResendingId] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading,  setLoading]  = useState(true);

  const loadSites = useCallback(async () => {
    try { setSites(await api(scoped('/sites'))); } catch { setSites([]); }
  }, [tenant]);

  const loadMembers = useCallback(async () => {
    try {
      const data = await api(scoped('/members'));
      setMembers(data.members || []);
      setInvites(data.invites || []);
    } catch { setMembers([]); setInvites([]); }
  }, [tenant]);

  const revokeInvite = async (id) => {
    try { await api(scoped(`/invites/${id}`), { method: 'DELETE' }); toast('Pending member removed', 'ok'); loadMembers(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const resendInvite = async (id) => {
    if (resendingId) return;
    setResendingId(id);
    try { const r = await api(scoped(`/invites/${id}/resend`), { method: 'POST', body: {} }); toast(`Email sent to ${r.email} ✓`, 'ok'); }
    catch (e) { toast(e.message || 'Email could not be sent', 'err'); }
    setResendingId(null);
  };

  const loadProducts = useCallback(async () => {
    try { setProducts(await api(scoped('/products'))); } catch { setProducts([]); }
  }, [tenant]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadSites(), loadMembers(), loadProducts()]).finally(() => setLoading(false));
  }, [tenant]);

  const openSiteForm = (site = null) => {
    openModal(<SiteForm site={site} onSave={loadSites} onClose={closeModal} />);
  };
  const openProductForm = (product = null) => {
    openModal(<ProductForm product={product} onSave={loadProducts} onClose={closeModal} />, { guard: true });
  };

  const inviteMember = async (email, inviteRole, site_id) => {
    const r = await api(scoped('/members'), { method: 'POST', body: { email, role: inviteRole, site_id } });
    const base = r.added ? `${email} added` : `${email} invited — joins when they sign in`;
    if (r.emailed) toast(`${base} · email sent ✓`, 'ok');
    else toast(`${base}, but the email didn't send${r.email_error ? ': ' + r.email_error : ''} — test SMTP in Settings`, 'err', 6000);
    await loadMembers();
  };
  const patchMember = async (id, body) => { await api(scoped(`/members/${id}`), { method: 'PATCH', body }); toast('Member updated ✓', 'ok'); await loadMembers(); };
  const removeMember = async (m) => {
    if (!window.confirm(`Remove ${m.name || m.email} from this company?`)) return;
    try { await api(scoped(`/members/${m.id}`), { method: 'DELETE' }); toast('Member removed', 'ok'); closeModal(); await loadMembers(); }
    catch (e) { toast(e.message || 'Could not remove', 'err'); }
  };
  const openEditMember = (m) => openModal(<EditMemberForm member={m} sites={sites} onSave={patchMember} onRemove={removeMember} onClose={closeModal} />);

  const activeProducts   = products.filter((p) => p.status !== 'INACTIVE');
  const inactiveProducts = products.filter((p) => p.status === 'INACTIVE');

  return (
    <div>
      <div className="seg" style={{ marginBottom: 16, overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`seg-b${tab === 'sites'    ? ' on' : ''}`} onClick={() => setTab('sites')}>🏗️ Sites</button>
        <button className={`seg-b${tab === 'members'  ? ' on' : ''}`} onClick={() => setTab('members')}>👥 Members</button>
        <button className={`seg-b${tab === 'products' ? ' on' : ''}`} onClick={() => setTab('products')}>🛒 Products</button>
        {isAdmin && <button className={`seg-b${tab === 'settings' ? ' on' : ''}`} onClick={() => setTab('settings')}>⚙️ Settings</button>}
      </div>

      {tab === 'settings' ? <SettingsTab /> : loading ? (
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
      ) : tab === 'members' ? (
        <>
          {members.length === 0 && invites.length === 0 ? (
            <div className="empty"><div className="ic">👥</div><p>No members yet</p></div>
          ) : (
            <>
              {members.length > 0 && (
                <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  {members.map((m) => (
                    <div key={m.id || m.user_id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                      <div className="av">{(m.name || m.email || '?')[0].toUpperCase()}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700 }}>{m.name || m.email}{m.status === 'DISABLED' ? ' (disabled)' : ''}</div>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{m.email} · {ROLE_LABELS[m.role] || m.role}{m.site_id ? ` · ${sites.find((x) => x.id === m.site_id)?.name || 'site'}` : ''}</div>
                      </div>
                      {isAdmin && <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 12px' }} onClick={() => openEditMember(m)}>Edit</button>}
                    </div>
                  ))}
                </div>
              )}
              {invites.length > 0 && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', margin: '18px 0 8px' }}>Pending — first sign-in</div>
                  <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    {invites.map((iv) => (
                      <div key={iv.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                        <div className="av" style={{ background: '#fef3c7', color: '#92400e' }}>⏳</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{iv.email}</div>
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>Joins as {ROLE_LABELS[iv.role] || iv.role} when they sign in</div>
                        </div>
                        {isAdmin && <button className="btn btn-sm" style={{ width: 'auto', padding: '4px 10px', minWidth: 92 }} onClick={() => resendInvite(iv.id)} disabled={resendingId === iv.id}>{resendingId === iv.id ? <span className="spin" /> : '✉️ Resend'}</button>}
                        {isAdmin && <button className="btn btn-ghost btn-sm" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => revokeInvite(iv.id)} disabled={resendingId === iv.id}>Remove</button>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {isAdmin && (
            <button className="fab" onClick={() => openModal(<MemberForm sites={sites} onInvite={inviteMember} onClose={closeModal} />)}>+</button>
          )}
        </>
      ) : (
        /* ── Products tab ── */
        <>
          {products.length === 0 ? (
            <div className="empty"><div className="ic">🛒</div><p>No products yet — add your first product</p></div>
          ) : (
            <>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {activeProducts.map((p) => (
                  <button key={p.id} onClick={() => isGM ? openProductForm(p) : null}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: isGM ? 'pointer' : 'default', textAlign: 'left' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>{p.name}{p.unit ? ` (${p.unit})` : ''}</div>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {ngn(p.price)}{p.category ? ` · ${p.category}` : ''}
                        {p.track_stock ? ` · Stock: ${p.stock_qty ?? 0}` : ''}
                      </div>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: '#dcfce7', color: '#166534' }}>Active</span>
                    {isGM && <span style={{ color: 'var(--muted)' }}>›</span>}
                  </button>
                ))}
              </div>

              {inactiveProducts.length > 0 && (
                <>
                  <div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', margin: '18px 0 8px' }}>Inactive</div>
                  <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                    {inactiveProducts.map((p) => (
                      <button key={p.id} onClick={() => isGM ? openProductForm(p) : null}
                        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: 'none', background: 'none', width: '100%', borderBottom: '1px solid var(--line)', cursor: isGM ? 'pointer' : 'default', textAlign: 'left', opacity: .55 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700 }}>{p.name}{p.unit ? ` (${p.unit})` : ''}</div>
                          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{ngn(p.price)}</div>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 20, background: '#f1f5f9', color: '#64748b' }}>Inactive</span>
                        {isGM && <span style={{ color: 'var(--muted)' }}>›</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {isGM && <button className="fab" onClick={() => openProductForm()}>+</button>}
        </>
      )}
    </div>
  );
}
