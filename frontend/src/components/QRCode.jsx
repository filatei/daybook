/**
 * QRCode — compact QR (error-corrected, omnidirectional) for staff badges.
 * Better than a 1-D barcode for phone-camera scanning. Synchronous SVG output.
 */
import React from 'react';
import qrcode from 'qrcode-generator';

// QR as an SVG markup string (for print windows / dangerouslySetInnerHTML).
export function qrSvg(value, { color = '#000', margin = 2 } = {}) {
  const s = String(value || '');
  if (!s) return '';
  const qr = qrcode(0, 'M');   // type auto, medium error correction (~15%)
  qr.addData(s); qr.make();
  const n = qr.getModuleCount();
  const dim = n + margin * 2;
  let rects = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.isDark(r, c)) rects += `<rect x="${c + margin}" y="${r + margin}" width="1" height="1"/>`;
  }
  return `<svg viewBox="0 0 ${dim} ${dim}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="${color}">${rects}</g></svg>`;
}

export default function QRCode({ value, size = 120, color = '#000' }) {
  if (!value) return null;
  return <div style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: qrSvg(value, { color }) }} />;
}
