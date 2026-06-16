/**
 * ReceiptPreview — on-screen render of a receipt exactly as it prints on the
 * thermal printer, including a real Code 128 barcode of the receipt number.
 * Pure presentational; takes the same payload object used by useBTPrinter.print.
 */
import React from 'react';
import { ngn } from '../api.js';
import QRCode from './QRCode.jsx';

// ── Code 128 (subset B) symbol width table — 0..106 (106 = stop) ──────────────
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
  const vals = [104];                       // Start Code B
  for (const ch of String(text)) vals.push(ch.charCodeAt(0) - 32);
  let sum = 104;
  for (let i = 1; i < vals.length; i++) sum += vals[i] * i;
  vals.push(sum % 103);                      // checksum
  vals.push(106);                            // stop
  const widths = [];
  for (const v of vals) for (const d of C128[v]) widths.push(parseInt(d, 10));
  return widths;                             // alternating bar,space,bar,…
}

function Barcode({ value, height = 46 }) {
  const s = String(value || '');
  if (!s || !/^[\x20-\x7e]+$/.test(s)) return null;
  const widths = encode128B(s);
  const total = widths.reduce((a, w) => a + w, 0);
  const bars = [];
  let x = 0;
  widths.forEach((w, i) => { if (i % 2 === 0) bars.push(<rect key={i} x={x} y={0} width={w} height={height} fill="#000" />); x += w; });
  return (
    <svg viewBox={`0 0 ${total} ${height}`} width="80%" height={height} preserveAspectRatio="none" style={{ display: 'block', margin: '0 auto' }} shapeRendering="crispEdges">
      {bars}
    </svg>
  );
}

const Row = ({ l, r, bold }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontWeight: bold ? 700 : 400 }}>
    <span style={{ whiteSpace: 'pre-wrap' }}>{l}</span><span>{r}</span>
  </div>
);
const Hr = () => <div style={{ borderTop: '1px dashed #94a3b8', margin: '6px 0' }} />;

export default function ReceiptPreview({ receipt: r }) {
  if (!r) return null;
  const items = r.items || [];
  const rno = r.receipt_no === 'OFFLINE' ? 'OFFLINE' : `#${String(r.receipt_no || '').padStart(4, '0')}`;
  return (
    <div style={{
      background: '#fff', color: '#0f172a', width: 280, maxWidth: '100%', margin: '0 auto',
      padding: '14px 16px', borderRadius: 6, border: '1px solid var(--line)',
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', fontSize: 12.5, lineHeight: 1.5,
      boxShadow: 'inset 0 0 0 1px #f1f5f9',
    }}>
      <div style={{ textAlign: 'center', fontWeight: 800, fontSize: 16 }}>{r.company || 'FIDO WATER'}</div>
      {r.site_name && <div style={{ textAlign: 'center' }}>{r.site_name}</div>}
      <Hr />
      <Row l="Receipt:" r={rno} />
      {r.date_str && <Row l="Date:" r={r.date_str} />}
      {r.time_str && <Row l="Time:" r={r.time_str} />}
      {r.customer_name && <Row l="Customer:" r={r.customer_name} />}
      {r.served_by && <Row l="Served by:" r={r.served_by} />}
      <Hr />
      {items.map((it, i) => (
        <div key={i}>
          <div style={{ fontWeight: 700 }}>{it.name}</div>
          <Row l={`  ${it.qty} x ${ngn(it.price)}`} r={ngn(it.amount)} />
        </div>
      ))}
      <Hr />
      <Row l="TOTAL" r={ngn(r.total)} bold />
      <Row l="Payment:" r={r.payment_method} />
      {r.terminal && <Row l="Terminal:" r={r.terminal} />}
      {r.bank && <Row l="Bank:" r={r.bank} />}
      {r.payment_method === 'CASH' && r.amount_paid > 0 && (
        <>
          <Row l="Tendered" r={ngn(r.amount_paid)} />
          <Row l="Change" r={ngn(r.change || 0)} />
        </>
      )}
      <Hr />
      <div style={{ textAlign: 'center', fontWeight: 800 }}>TAKE TO LOADING POINT</div>
      <div style={{ textAlign: 'center', marginBottom: 4 }}>Receipt {rno}</div>
      {r.receipt_no !== 'OFFLINE' && (
        <div style={{ width: 120, height: 120, margin: '0 auto' }}><QRCode value={String(r.receipt_no)} size={120} /></div>
      )}
      <Hr />
    </div>
  );
}
