/**
 * Barcode128 — renders a Code 128-B barcode as crisp SVG. Used on printed staff
 * badges (and shareable elsewhere). Encodes ASCII 32–126.
 */
import React from 'react';

const C128 = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

function encode128B(text) {
  const vals = [104];
  for (const ch of String(text)) vals.push(ch.charCodeAt(0) - 32);
  let sum = 104;
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103);
  vals.push(106);
  const widths = [];
  for (const v of vals) for (const d of C128[v]) widths.push(parseInt(d, 10));
  return widths;
}

// Same barcode as an SVG markup string (for print windows / export).
export function barcode128Svg(value, { height = 60, color = '#000' } = {}) {
  const s = String(value || '');
  if (!s || !/^[\x20-\x7e]+$/.test(s)) return '';
  const widths = encode128B(s);
  const total = widths.reduce((a, w) => a + w, 0);
  let x = 0, rects = '';
  widths.forEach((w, i) => { if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w}" height="${height}" fill="${color}"/>`; x += w; });
  return `<svg viewBox="0 0 ${total} ${height}" width="100%" height="${height}" preserveAspectRatio="none" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
}

export default function Barcode128({ value, height = 60, width = '100%', color = '#000' }) {
  const s = String(value || '');
  if (!s || !/^[\x20-\x7e]+$/.test(s)) return null;
  const widths = encode128B(s);
  const total = widths.reduce((a, w) => a + w, 0);
  const bars = [];
  let x = 0;
  widths.forEach((w, i) => { if (i % 2 === 0) bars.push(<rect key={i} x={x} y={0} width={w} height={height} fill={color} />); x += w; });
  return (
    <svg viewBox={`0 0 ${total} ${height}`} width={width} height={height} preserveAspectRatio="none" shapeRendering="crispEdges" style={{ display: 'block' }}>
      {bars}
    </svg>
  );
}
