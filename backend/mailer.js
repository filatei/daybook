/**
 * Daybook — Email service
 *
 * Uses the same Google Workspace SMTP relay as otuburu (smtp-relay.gmail.com).
 * Auth is IP-based — the server IP must be whitelisted in
 *   Google Admin → Apps → Gmail → Routing → SMTP relay
 * When whitelisted no password is needed and auth{} is omitted. If SMTP_USER +
 * SMTP_PASS are set (App Password), it falls back to credential auth.
 */
'use strict';

const nodemailer = require('nodemailer');
const path = require('path');

let _transporter;
function getTransporter() {
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST || 'smtp-relay.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const auth = user && pass ? { user, pass } : undefined;
  _transporter = nodemailer.createTransport({ host, port, secure, auth });
  console.log(`[Mailer] SMTP ${host}:${port} | auth: ${auth ? 'credentials' : 'IP-relay (no password)'}`);
  return _transporter;
}

const FROM = process.env.SMTP_FROM || 'Daybook <noreply@torama.money>';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://daybook.torama.money';

const ngn = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });

/**
 * Build + send the daily report email.
 * @param {object} opts
 *  - tenant   {name, brand_color}
 *  - site     {name, code}
 *  - report   daily_reports row (+ parsed sales/production)
 *  - to       array of email strings
 *  - attachments [{filename, path}]
 */
async function sendDailyReport({ tenant, site, report, to, attachments = [] }) {
  const brand = (tenant && tenant.brand_color) || '#2563eb';
  const sales = safeParse(report.sales_json, []);
  const prod = safeParse(report.production_json, {});

  const salesRows = (Array.isArray(sales) ? sales : []).map(
    (s) => `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(s.product || s.label || '')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${s.qty ?? ''}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${ngn(s.amount)}</td>
    </tr>`
  ).join('');

  const prodRows = Object.keys(prod || {}).map(
    (k) => `<tr>
      <td style="padding:5px 10px;border-bottom:1px solid #f0f0f0;color:#555">${esc(k)}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${esc(String(prod[k]))}</td>
    </tr>`
  ).join('');

  const subject = `[${tenant.name}] Daily Report — ${site.name} — ${report.report_date}`;

  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#1f2937">
    <div style="background:${brand};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">${esc(tenant.name).toUpperCase()}</div>
      <div style="font-size:22px;font-weight:800">Daily Report — ${esc(site.name)}</div>
      <div style="opacity:.9">${esc(report.report_date)}</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
        <tr><td style="padding:8px 10px;background:#f9fafb;font-weight:700">TOTAL SALES</td>
            <td style="padding:8px 10px;background:#f9fafb;text-align:right;font-weight:800">${ngn(report.total_sales)}</td></tr>
        <tr><td style="padding:8px 10px;color:#b91c1c">Diesel / Expenses</td>
            <td style="padding:8px 10px;text-align:right;color:#b91c1c">(${ngn((report.diesel || 0) + (report.expenses || 0))})</td></tr>
        <tr><td style="padding:8px 10px;font-weight:700">BALANCE</td>
            <td style="padding:8px 10px;text-align:right;font-weight:700">${ngn(report.balance)}</td></tr>
        <tr><td style="padding:8px 10px;color:#555">Total Cash</td>
            <td style="padding:8px 10px;text-align:right">${ngn(report.total_cash)}</td></tr>
        <tr><td style="padding:8px 10px;color:#555">Total Deposit</td>
            <td style="padding:8px 10px;text-align:right">${ngn(report.total_deposit)}</td></tr>
      </table>

      ${salesRows ? `<h3 style="margin:18px 0 6px;color:${brand}">Sales breakdown</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="text-align:left;color:#6b7280"><th style="padding:6px 10px">Item</th>
          <th style="padding:6px 10px;text-align:right">Qty</th>
          <th style="padding:6px 10px;text-align:right">Amount</th></tr>
        ${salesRows}
      </table>` : ''}

      ${prodRows ? `<h3 style="margin:18px 0 6px;color:${brand}">Production / Inventory</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${prodRows}</table>` : ''}

      ${report.notes ? `<h3 style="margin:18px 0 6px;color:${brand}">Notes</h3>
      <p style="white-space:pre-wrap;color:#374151">${esc(report.notes)}</p>` : ''}

      ${attachments.length ? `<p style="margin-top:16px;color:#6b7280;font-size:13px">📎 ${attachments.length} attachment(s) included.</p>` : ''}

      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="color:#9ca3af;font-size:12px">
        Generated by <a href="${PUBLIC_URL}" style="color:${brand}">Daybook</a> · ${esc(tenant.name)} · torama.money
      </p>
    </div>
  </div>`;

  const info = await getTransporter().sendMail({
    from: FROM,
    to: to.join(', '),
    subject,
    html,
    attachments: attachments.map((a) => ({ filename: a.filename || path.basename(a.path), path: a.path })),
  });
  return { messageId: info.messageId, subject, to };
}

async function verifyConnection() {
  try { await getTransporter().verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function safeParse(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

module.exports = { sendDailyReport, verifyConnection, FROM };
