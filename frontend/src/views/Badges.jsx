/**
 * Badges.jsx — design & print scannable staff ID badges. Each badge carries the
 * company logo, the staff name/role/site and a Code 128 barcode of their badge
 * code, which is scanned at the Staff → Badge screen to clock in/out.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, scoped } from '../api.js';
import { useStore, useRole, atLeast, useActiveTenant } from '../store.jsx';
import Barcode128, { barcode128Svg } from '../components/Barcode128.jsx';

const BRANDS = {
  fido:   { logo: '/brand/fido.png',   color: '#1d4ed8', accent: '#dc2626', name: 'FIDO WATER',   tagline: 'purity you can trust' },
  fiafia: { logo: '/brand/fiafia.png', color: '#16A6E8', accent: '#0c87c4', name: 'FIAFIA WATER', tagline: 'always refreshing' },
};
const brandFor = (t) => {
  const key = `${t?.slug || ''} ${t?.name || ''}`.toLowerCase();
  if (key.includes('fiafia')) return { ...BRANDS.fiafia, name: (t?.name || BRANDS.fiafia.name).toUpperCase() };
  return { ...BRANDS.fido, name: (t?.name || BRANDS.fido.name).toUpperCase() };
};

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

  const printAll = () => {
    const cards = list.map((s) => `
      <div class="badge">
        <div class="hdr" style="background:${brand.color}">
          <img src="${brand.logo}" alt="logo"/>
          <div class="co">${brand.name}</div>
        </div>
        <div class="body">
          <div class="av" style="background:${brand.color}">${(s.full_name || '?').trim().charAt(0).toUpperCase()}</div>
          <div class="nm">${escapeHtml(s.full_name || '')}</div>
          <div class="rl">${escapeHtml(s.role_title || s.staff_type || 'Staff')}</div>
          <div class="st">${escapeHtml(siteName(s.site_id))}</div>
        </div>
        <div class="ft">
          ${barcode128Svg(s.badge_code, { height: 54, color: '#000' })}
          <div class="code">${escapeHtml(s.badge_code)}</div>
          <div class="tag" style="color:${brand.color}">${escapeHtml(brand.tagline)}</div>
        </div>
      </div>`).join('');
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Staff badges</title>
      <style>
        * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #eef2f7; }
        .sheet { display: flex; flex-wrap: wrap; gap: 8mm; padding: 10mm; }
        .badge { width: 54mm; height: 86mm; background: #fff; border-radius: 4mm; overflow: hidden;
          box-shadow: 0 1px 4px rgba(0,0,0,.18); display: flex; flex-direction: column; border: 1px solid #e2e8f0; }
        .hdr { color: #fff; padding: 4mm 3mm; text-align: center; }
        .hdr img { height: 13mm; width: auto; max-width: 80%; object-fit: contain; filter: brightness(0) invert(1); }
        .hdr .co { font-weight: 800; font-size: 3.4mm; letter-spacing: .4px; margin-top: 1.5mm; }
        .body { flex: 1; text-align: center; padding: 3mm; display: flex; flex-direction: column; align-items: center; }
        .av { width: 18mm; height: 18mm; border-radius: 50%; color: #fff; font-size: 9mm; font-weight: 800;
          display: flex; align-items: center; justify-content: center; margin: 1mm 0 2mm; }
        .nm { font-weight: 800; font-size: 4.2mm; line-height: 1.15; }
        .rl { color: #475569; font-size: 3.2mm; margin-top: 1mm; }
        .st { color: #94a3b8; font-size: 3mm; margin-top: .5mm; }
        .ft { padding: 2.5mm 3mm 3mm; text-align: center; border-top: 1px dashed #cbd5e1; }
        .ft svg { width: 100%; height: 12mm; }
        .code { font-family: ui-monospace, Menlo, monospace; font-size: 3.2mm; letter-spacing: 1px; margin-top: .5mm; font-weight: 700; }
        .tag { font-size: 2.7mm; font-style: italic; margin-top: 1mm; }
        @media print { body { background: #fff; } .badge { box-shadow: none; } @page { margin: 8mm; } }
      </style></head><body><div class="sheet">${cards}</div>
      <script>window.onload=function(){setTimeout(function(){window.print();},350);};</script>
      </body></html>`);
    w.document.close();
  };

  if (!canManage) return <div className="empty"><div className="ic">🔒</div><p>You don't have access to staff badges</p></div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Staff badges</div>
        <button className="btn btn-sm" style={{ width: 'auto', padding: '6px 14px' }} onClick={printAll} disabled={!list.length}>🖨 Print {list.length || ''}</button>
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
              <div style={{ background: brand.color, color: '#fff', textAlign: 'center', padding: '10px 6px' }}>
                <img src={brand.logo} alt="" style={{ height: 34, maxWidth: '78%', objectFit: 'contain', filter: 'brightness(0) invert(1)' }} />
                <div style={{ fontWeight: 800, fontSize: 11, letterSpacing: .4, marginTop: 4 }}>{brand.name}</div>
              </div>
              <div style={{ textAlign: 'center', padding: '8px 8px 4px' }}>
                <div style={{ width: 46, height: 46, borderRadius: '50%', background: brand.color, color: '#fff', fontSize: 22, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 6px' }}>{(s.full_name || '?').trim().charAt(0).toUpperCase()}</div>
                <div style={{ fontWeight: 800, fontSize: 14, lineHeight: 1.15 }}>{s.full_name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{s.role_title || s.staff_type || 'Staff'}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{siteName(s.site_id)}</div>
              </div>
              <div style={{ padding: '4px 10px 10px', borderTop: '1px dashed var(--line)' }}>
                <Barcode128 value={s.badge_code} height={40} />
                <div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, fontWeight: 700, letterSpacing: 1, textAlign: 'center', marginTop: 2 }}>{s.badge_code}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
