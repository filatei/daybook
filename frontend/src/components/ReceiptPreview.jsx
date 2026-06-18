/**
 * ReceiptPreview — on-screen render of a receipt exactly as it prints on the
 * thermal printer, including a real Code 128 barcode of the receipt number.
 * Pure presentational; takes the same payload object used by useBTPrinter.print.
 */
import React from 'react';
import { ngn } from '../api.js';
import QRCode from './QRCode.jsx';

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
