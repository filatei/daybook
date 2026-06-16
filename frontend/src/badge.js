/**
 * Shared staff-badge helpers — brand resolution + printable ID-card window.
 * Used by the Staff Badges screen and the per-row print action on Staff.
 */
import { qrSvg } from './components/QRCode.jsx';

export const BRANDS = {
  fido:   { logo: '/brand/fido.png',   color: '#1d4ed8', accent: '#dc2626', name: 'FIDO WATER',   tagline: 'purity you can trust' },
  fiafia: { logo: '/brand/fiafia.png', color: '#16A6E8', accent: '#0c87c4', name: 'FIAFIA WATER', tagline: 'always refreshing' },
};

export function brandFor(tenant) {
  const key = `${tenant?.slug || ''} ${tenant?.name || ''}`.toLowerCase();
  if (key.includes('fiafia')) return { ...BRANDS.fiafia, name: (tenant?.name || BRANDS.fiafia.name).toUpperCase() };
  return { ...BRANDS.fido, name: (tenant?.name || BRANDS.fido.name).toUpperCase() };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Open a print window with one CR80 ID card per item. `siteName(id)` resolves
// a site name for the card. Items need: full_name, role_title|staff_type,
// site_id, badge_code.
export function printBadges(items, brand, siteName = () => '') {
  const list = (items || []).filter((s) => s && s.badge_code);
  if (!list.length) return false;
  const cards = list.map((s) => `
    <div class="badge">
      <div class="bar" style="background:${brand.color}"></div>
      <div class="hdr">
        <img src="${brand.logo}" alt="logo"/>
        <div class="co" style="color:${brand.color}">${escapeHtml(brand.name)}</div>
      </div>
      <div class="body">
        ${s.photo
          ? `<div class="ph"><img src="${s.photo}" alt=""/></div>`
          : `<div class="av" style="background:${brand.color}">${escapeHtml((s.full_name || '?').trim().charAt(0).toUpperCase())}</div>`}
        <div class="nm">${escapeHtml(s.full_name || '')}</div>
        <div class="rl">${escapeHtml(s.role_title || s.staff_type || 'Staff')}</div>
        <div class="st">${escapeHtml(siteName(s.site_id))}</div>
      </div>
      <div class="ft" style="border-top-color:${brand.color}">
        <div class="qr">${qrSvg(s.badge_code, { color: '#000' })}</div>
        <div class="code">${escapeHtml(s.badge_code)}</div>
        <div class="tag" style="color:${brand.color}">${escapeHtml(brand.tagline)}</div>
      </div>
    </div>`).join('');
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Staff badges</title>
    <style>
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #eef2f7; }
      .sheet { display: flex; flex-wrap: wrap; gap: 8mm; padding: 10mm; }
      .badge { width: 54mm; height: 86mm; background: #fff; border-radius: 4mm; overflow: hidden;
        box-shadow: 0 1px 4px rgba(0,0,0,.18); display: flex; flex-direction: column; border: 1px solid #e2e8f0; }
      .bar { height: 5mm; }
      .hdr { padding: 3mm 3mm 1mm; text-align: center; }
      .hdr img { height: 15mm; width: auto; max-width: 86%; object-fit: contain; }
      .hdr .co { font-weight: 800; font-size: 3.2mm; letter-spacing: .4px; margin-top: 1mm; }
      .body { flex: 1; text-align: center; padding: 2mm 3mm; display: flex; flex-direction: column; align-items: center; justify-content: center; }
      .av { width: 16mm; height: 16mm; border-radius: 50%; color: #fff; font-size: 8mm; font-weight: 800;
        display: flex; align-items: center; justify-content: center; margin: 0 0 2mm; }
      .ph { width: 22mm; height: 28mm; border-radius: 2mm; overflow: hidden; margin: 0 auto 2mm; border: 1px solid #e2e8f0; }
      .ph img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .nm { font-weight: 800; font-size: 4.2mm; line-height: 1.15; }
      .rl { color: #475569; font-size: 3.2mm; margin-top: 1mm; }
      .st { color: #94a3b8; font-size: 3mm; margin-top: .5mm; }
      .ft { padding: 2.5mm 3mm 3mm; text-align: center; border-top: 1px dashed; }
      .qr { width: 24mm; height: 24mm; margin: 0 auto; }
      .qr svg { display: block; }
      .code { font-family: ui-monospace, Menlo, monospace; font-size: 3.2mm; letter-spacing: 1px; margin-top: 1mm; font-weight: 700; }
      .tag { font-size: 2.7mm; font-style: italic; margin-top: 1mm; }
      @media print { body { background: #fff; } .badge { box-shadow: none; } @page { margin: 8mm; } }
    </style></head><body><div class="sheet">${cards}</div>
    <script>window.onload=function(){setTimeout(function(){window.print();},350);};</script>
    </body></html>`);
  w.document.close();
  return true;
}
