/**
 * Badges.jsx — design & print scannable staff ID badges. Each badge carries the
 * company logo, the staff name/role/site and a Code 128 barcode of their badge
 * code, which is scanned at the Staff → Badge screen to clock in/out.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, scoped } from '../api.js';
import { useStore, useRole, atLeast, useActiveTenant } from '../store.jsx';
import QRCode from '../components/QRCode.jsx';
import { brandFor, printBadges } from '../badge.js';

export default function Badges() {
  const { tenant, sites } = useStore();
  const role = useRole();
  const active = useActiveTenant();
  const canManage = role && atLeast(role, 'SECRETARY');
  const siteBound = role && !atLeast(role, 'SNR_ACCOUNTANT');
  const [staff, setStaff] = useState(null);
  const [siteFilter, setSiteFilter] = useState('');
  const brand = brandFor(active);

  const load = useCallback(async () => {
    try { const params = siteFilter ? `?site=${siteFilter}` : ''; setStaff(await api(scoped(`/staff${params}`))); }
    catch { setStaff([]); }
  }, [tenant, siteFilter]);
  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => (staff || []).filter((s) => s.status !== 'INACTIVE' && s.badge_code), [staff]);
  const siteName = (id) => sites.find((x) => x.id === id)?.name || '';
  const print = (items) => printBadges(items, brand, siteName);

  if (!canManage) return <div className="empty"><div className="ic">🔒</div><p>You don't have access to staff badges</p></div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Staff badges</div>
        <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 14px' }} onClick={() => print(list)} disabled={!list.length}>🖨 Print all {list.length || ''}</button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0, marginBottom: 12 }}>
        Print these ID cards for each staff member. The barcode is scanned at Staff → Badge to clock in and out.
      </p>

      {!siteBound && sites.length > 1 && (
        <select className="input" style={{ marginBottom: 12 }} value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}>
          <option value="">All sites</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}

      {staff === null ? (
        <>{[...Array(3)].map((_, i) => <div className="skel" key={i} style={{ height: 120 }} />)}</>
      ) : list.length === 0 ? (
        <div className="empty"><div className="ic">🪪</div><p>No staff with badges yet</p></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
          {list.map((s) => (
            <div key={s.id} style={{ background: '#fff', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)', boxShadow: '0 1px 4px rgba(15,23,42,.06)' }}>
              <div style={{ height: 6, background: brand.color }} />
              <div style={{ textAlign: 'center', padding: '10px 6px 4px' }}>
                <img src={brand.logo} alt="" style={{ height: 38, maxWidth: '82%', objectFit: 'contain' }} />
                <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: .4, marginTop: 2, color: brand.color }}>{brand.name}</div>
              </div>
              <div style={{ textAlign: 'center', padding: '2px 8px 4px' }}>
                <div style={{ width: 44, height: 44, borderRadius: '50%', background: brand.color, color: '#fff', fontSize: 21, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 6px' }}>{(s.full_name || '?').trim().charAt(0).toUpperCase()}</div>
                <div style={{ fontWeight: 800, fontSize: 14, lineHeight: 1.15 }}>{s.full_name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.role_title || s.staff_type || 'Staff'}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{siteName(s.site_id)}</div>
              </div>
              <div style={{ padding: '4px 10px 8px', borderTop: `1px dashed ${brand.color}`, textAlign: 'center' }}>
                <div style={{ width: 96, height: 96, margin: '4px auto 0' }}><QRCode value={s.badge_code} size={96} /></div>
                <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fontWeight: 700, letterSpacing: 1, marginTop: 2 }}>{s.badge_code}</div>
              </div>
              <button onClick={() => print([s])} title="Print this badge"
                style={{ width: '100%', border: 'none', borderTop: '1px solid var(--line)', background: '#f8fafc', color: brand.color, fontWeight: 700, fontSize: 12.5, padding: '8px 0', cursor: 'pointer' }}>
                🖨 Print badge
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
