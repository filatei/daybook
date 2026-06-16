/**
 * Shared staff-badge helpers — brand resolution + printable ID-card window.
 * Used by the Staff Badges screen and the per-row print action on Staff.
 */
import { barcode128Svg } from './components/Barcode128.jsx';

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
      <div class="hdr" style="background:${brand.color}">
        <img src="${brand.logo}" alt="logo"/>
        <div class="co">${escapeHtml(brand.name)}</div>
      </div>
      <div class="body">
        <div class="av" style="background:${brand.color}">${escapeHtml((s.full_name || '?').trim().charAt(0).toUpperCase())}</div>
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
  if (!w) return false;
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
  return true;
}
