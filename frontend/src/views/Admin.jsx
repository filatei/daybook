import React, { useEffect, useState, useCallback } from 'react';
import { api, scoped, ngn } from '../api.js';
import { useStore, useRole, atLeast } from '../store.jsx';
import Staff from './Staff.jsx';
import Documents from './Documents.jsx';
import Reconcile from './Reconcile.jsx';

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
        <option value="GATE">Gate / Security (scan & release only)</option>
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

// ── Product form ────────────────────────────────────────────────────────────
function ProductForm({ product, onSave, onClose }) {
  const { toast } = useStore();
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
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

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
  const [products, setProducts] = useState([]);
  const [loading,  setLoading]  = useState(true);

  const loadSites = useCallback(async () => {
    try { setSites(await api(scoped('/sites'))); } catch { setSites([]); }
  }, [tenant]);

  const loadMembers = useCallback(async () => {
    try {
      const data = await api(scoped('/members'));
      setMembers(data.members || []);
    } catch { setMembers([]); }
  }, [tenant]);

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
    openModal(<ProductForm product={product} onSave={loadProducts} onClose={closeModal} />);
  };

  const inviteMember = async (email, inviteRole) => {
    await api(scoped('/members'), { method: 'POST', body: { email, role: inviteRole } });
    toast(`Invited ${email}`, 'ok');
    await loadMembers();
  };

  const activeProducts   = products.filter((p) => p.status !== 'INACTIVE');
  const inactiveProducts = products.filter((p) => p.status === 'INACTIVE');

  return (
    <div>
      <div className="seg" style={{ marginBottom: 16, overflowX: 'auto', flexWrap: 'nowrap' }}>
        <button className={`seg-b${tab === 'sites'    ? ' on' : ''}`} onClick={() => setTab('sites')}>🏗️ Sites</button>
        <button className={`seg-b${tab === 'members'  ? ' on' : ''}`} onClick={() => setTab('members')}>👥 Members</button>
        <button className={`seg-b${tab === 'products' ? ' on' : ''}`} onClick={() => setTab('products')}>🛒 Products</button>
        <button className={`seg-b${tab === 'staff'     ? ' on' : ''}`} onClick={() => setTab('staff')}>👷 Staff</button>
        <button className={`seg-b${tab === 'documents' ? ' on' : ''}`} onClick={() => setTab('documents')}>📁 Docs</button>
        <button className={`seg-b${tab === 'reconcile' ? ' on' : ''}`} onClick={() => setTab('reconcile')}>🏦 Reconcile</button>
      </div>

      {tab === 'staff' ? <Staff /> : tab === 'documents' ? <Documents /> : tab === 'reconcile' ? <Reconcile /> : loading ? (
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
