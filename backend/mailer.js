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
// In CI / local tests set MAIL_DISABLED=1 to skip real SMTP — every send resolves
// as a no-op so the app logic (which only needs a result) runs without a relay.
const MAIL_DISABLED = process.env.MAIL_DISABLED === '1' || process.env.MAIL_DISABLED === 'true';
function getTransporter() {
  if (MAIL_DISABLED) {
    return { sendMail: async () => ({ messageId: 'disabled', accepted: [], rejected: [], response: 'MAIL_DISABLED' }), verify: async () => true };
  }
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

/**
 * Notify someone they've been added to a company on Daybook, with a sign-in link.
 * @param {object} opts - { to, tenantName, roleLabel, inviterName, brand? }
 */
async function sendInvite({ to, tenantName, roleLabel, inviterName, brand = '#0ea5e9' }) {
  const subject = `You've been added to ${tenantName} on Daybook`;
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#1f2937">
    <div style="background:${brand};color:#fff;padding:22px 24px;border-radius:10px 10px 0 0">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">DAYBOOK</div>
      <div style="font-size:22px;font-weight:800">You've been added to ${esc(tenantName)}</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px">
      <p>${inviterName ? esc(inviterName) + ' added you' : 'You have been added'} to <b>${esc(tenantName)}</b> on Daybook as <b>${esc(roleLabel)}</b>.</p>
      <p>To get started, sign in with this Google account (<b>${esc(to)}</b>) — you'll join the company automatically with your role.</p>
      <p style="text-align:center;margin:26px 0">
        <a href="${PUBLIC_URL}" style="background:${brand};color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:10px;display:inline-block">Sign in to Daybook</a>
      </p>
      <p style="color:#6b7280;font-size:13px">If the button doesn't work, open <a href="${PUBLIC_URL}" style="color:${brand}">${PUBLIC_URL}</a> and choose "Continue with Google".</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="color:#9ca3af;font-size:12px">If you weren't expecting this, you can ignore this email.</p>
    </div>
  </div>`;
  const info = await getTransporter().sendMail({ from: FROM, to, subject, html });
  return { messageId: info.messageId, subject, to };
}

/**
 * Mid-month payroll draft email to accountants / GM / admin.
 * @param opts { tenant, from, to, summary:{count,total,total_baggers,total_loaders,baggers,loaders}, to:[emails], csv:string }
 */
async function sendMidMonthPayroll({ tenant, from, to, summary, to: recipients, csv }) {
  const brand = (tenant && tenant.brand_color) || '#2563eb';
  const name = (tenant && tenant.name) || 'Company';
  const s = summary || {};
  const subject = `Mid-month payroll draft — ${name} (${from} to ${to})`;
  const row = (label, n, amt) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(label)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${n}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:700">${ngn(amt)}</td></tr>`;
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:auto;color:#1f2937">
    <div style="background:${brand};color:#fff;padding:22px 24px;border-radius:10px 10px 0 0">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">DAYBOOK · PAYROLL</div>
      <div style="font-size:22px;font-weight:800">Mid-month payroll draft</div>
      <div style="opacity:.9;margin-top:4px">${esc(name)} · ${esc(from)} to ${esc(to)}</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:24px">
      <p>A mid-month (piece-worker) payroll draft has been generated automatically from production. Review, approve and mark it paid in Daybook.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:14px 0">
        <thead><tr><th style="text-align:left;padding:6px 10px;color:#6b7280">Group</th><th style="text-align:right;padding:6px 10px;color:#6b7280">Staff</th><th style="text-align:right;padding:6px 10px;color:#6b7280">Amount</th></tr></thead>
        <tbody>
          ${row('Baggers', (s.baggers || []).length, s.total_baggers)}
          ${row('Loaders', (s.loaders || []).length, s.total_loaders)}
          <tr><td style="padding:8px 10px;font-weight:800">Total</td><td style="padding:8px 10px;text-align:right;font-weight:800">${s.count || 0}</td><td style="padding:8px 10px;text-align:right;font-weight:800;color:${brand}">${ngn(s.total)}</td></tr>
        </tbody>
      </table>
      <p style="text-align:center;margin:24px 0">
        <a href="${PUBLIC_URL}" style="background:${brand};color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:10px;display:inline-block">Open Daybook → Payroll</a>
      </p>
      <p style="color:#6b7280;font-size:13px">The Fido-format CSV is attached for the bank/payment run.</p>
    </div>
  </div>`;
  const attachments = csv ? [{ filename: `midmonth-payroll-${from}.csv`, content: csv }] : [];
  const info = await getTransporter().sendMail({ from: FROM, to: recipients, subject, html, attachments });
  return { messageId: info.messageId, subject, to: recipients };
}

/**
 * Expense lifecycle notice — sent to whoever must action the ticket next.
 * @param opts { to:[emails], tenantName, brand, expense:{ref,amount,vendor,category,description,site,date},
 *               state, stateLabel, actionNeeded, actorName, eventText }
 */
async function sendExpenseNotice({ to, tenantName, brand = '#2563eb', expense = {}, stateLabel, actionNeeded, actorName, eventText }) {
  if (!to || (Array.isArray(to) && !to.length)) return { skipped: true };
  const e = expense;
  const subject = `[${tenantName || 'Daybook'}] Expense ${e.ref || ''} — ${stateLabel}`;
  const row = (k, v) => v ? `<tr><td style="padding:5px 10px;color:#6b7280">${esc(k)}</td><td style="padding:5px 10px;font-weight:600">${esc(v)}</td></tr>` : '';
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#1f2937">
    <div style="background:${brand};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">DAYBOOK · EXPENSE</div>
      <div style="font-size:21px;font-weight:800">${esc(e.ref || 'Expense')} — ${esc(stateLabel)}</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:22px">
      <p>${esc(eventText || 'This expense was updated.')}</p>
      ${actionNeeded ? `<p style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px;font-weight:700;color:#9a3412">Action needed: ${esc(actionNeeded)}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">
        ${row('Amount', ngn(e.amount))}
        ${row('Vendor', e.vendor)}
        ${row('Category', e.category)}
        ${row('Description', e.description)}
        ${row('Site', e.site)}
        ${row('Date', e.date)}
        ${row('By', actorName)}
      </table>
      <p style="text-align:center;margin:22px 0">
        <a href="${PUBLIC_URL}" style="background:${brand};color:#fff;text-decoration:none;font-weight:700;padding:11px 24px;border-radius:10px;display:inline-block">Open Daybook → Expenses</a>
      </p>
    </div>
  </div>`;
  const info = await getTransporter().sendMail({ from: FROM, to, subject, html });
  return { messageId: info.messageId, subject, to };
}

// Render the operator-keyed operations into report HTML (only non-empty groups).
function opsHtml(ops) {
  if (!ops || typeof ops !== 'object') return '';
  const num = (n) => (n === '' || n == null) ? '' : Number(n).toLocaleString();
  const has = (o) => o && Object.values(o).some((v) => v !== '' && v != null && v !== 0);
  const kv = (label, obj, rows) => !has(obj) ? '' :
    `<div style="font-weight:800;margin:8px 0 4px">${esc(label)}</div>
     <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:10px">${rows.map(([k, key]) => (obj[key] === '' || obj[key] == null) ? '' : `<tr><td style="padding:4px 10px;border-bottom:1px solid #f0f0f0;color:#64748b">${esc(k)}</td><td style="padding:4px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${esc(String(obj[key]))}</td></tr>`).join('')}</table>`;
  let out = '';
  out += kv('Packing bags', ops.packing, [['Opening', 'opening'], ['Received', 'received'], ['Used for production', 'used_production'], ['Sales bags', 'sales'], ['Re-bagging', 'rebagging'], ['Damage replacement', 'damage_replacement'], ['Available', 'available']]);
  out += kv('Bag adjustments', ops.bags, [['Leakage', 'leakage'], ['Staff water', 'staff_water'], ['Extra / bonus', 'extra'], ['Re-bagging', 'rebagging'], ['Damage', 'damage']]);
  out += kv('Rolls (kg)', ops.rolls, [['Opening', 'opening_kg'], ['Received', 'received_kg'], ['Used', 'used_kg'], ['Available', 'available_kg']]);
  out += kv('Crates', ops.crates, [['50cl available', 'c50_available'], ['50cl sold', 'c50_sold'], ['60cl available', 'c60_available'], ['75cl available', 'c75_available'], ['Dispenser available', 'dispenser_available']]);
  out += kv('Water analysis', ops.water, [['PH', 'ph'], ['TDS', 'tds']]);
  if (Array.isArray(ops.generators) && ops.generators.some((g) => g && g.name)) {
    out += `<div style="font-weight:800;margin:8px 0 4px">Generator status</div><table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:10px">${ops.generators.filter((g) => g && g.name).map((g) => `<tr><td style="padding:4px 10px;border-bottom:1px solid #f0f0f0">${esc(g.name)}</td><td style="padding:4px 10px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${esc(g.status || '')}</td></tr>`).join('')}</table>`;
  }
  if (Array.isArray(ops.ro) && ops.ro.some((r) => r && (r.pure !== '' || r.waste !== ''))) {
    out += `<div style="font-weight:800;margin:8px 0 4px">RO readings</div><table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:10px"><thead><tr><th style="text-align:left;padding:4px 10px;color:#6b7280">Unit</th><th style="text-align:right;padding:4px 10px;color:#6b7280">Pure</th><th style="text-align:right;padding:4px 10px;color:#6b7280">Waste</th></tr></thead><tbody>${ops.ro.filter((r) => r && (r.unit || r.pure !== '' || r.waste !== '')).map((r) => `<tr><td style="padding:4px 10px;border-bottom:1px solid #f0f0f0">${esc(r.unit || '')}</td><td style="padding:4px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${esc(String(r.pure ?? ''))}</td><td style="padding:4px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${esc(String(r.waste ?? ''))}</td></tr>`).join('')}</tbody></table>`;
  }
  const text = (label, v) => (v && String(v).trim()) ? `<div style="font-weight:800;margin:8px 0 4px">${esc(label)}</div><div style="white-space:pre-wrap;font-size:13px;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:8px 12px;margin-bottom:10px">${esc(v)}</div>` : '';
  out += text('Materials supplied to other locations', ops.materials);
  out += text('Expired documents', ops.expired_docs);
  return out;
}

/**
 * Email a generated daily report (single site OR the all-sites roll-up).
 * @param opts { tenant, date, report:{scope,site_name,summary,bySite}, incidents, to }
 */
async function sendGeneratedReport({ tenant, date, report, incidents, to }) {
  const brand = (tenant && tenant.brand_color) || '#2563eb';
  const name = (tenant && tenant.name) || 'Company';
  const s = report.summary || {};
  const isAll = report.scope === 'ALL';
  const subject = `Daily report — ${name} · ${isAll ? 'All sites' : report.site_name} · ${date}`;
  const balance = (s.totalSales || 0) - (s.diesel || 0);
  const row = (k, v, bold) => `<tr><td style="padding:5px 10px;border-bottom:1px solid #eee">${esc(k)}</td><td style="padding:5px 10px;border-bottom:1px solid #eee;text-align:right;${bold ? 'font-weight:800' : ''}">${v}</td></tr>`;
  const dist = (report.bySite || []).filter((r) => (r.totalSales || 0) > 0 || (r.incentive || 0) > 0)
    .sort((a, b) => (b.totalSales || 0) - (a.totalSales || 0))
    .map((r) => `<tr>
      <td style="padding:5px 10px;border-bottom:1px solid #f0f0f0">${esc(r.site_name)}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #f0f0f0;text-align:right">${ngn(r.totalSales)}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #f0f0f0;text-align:right;color:#64748b">${ngn(r.cash)}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #f0f0f0;text-align:right;color:#64748b">${ngn(r.pos + r.transfer)}</td>
    </tr>`).join('');
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#1f2937">
    <div style="background:${brand};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">DAYBOOK · DAILY REPORT</div>
      <div style="font-size:22px;font-weight:800">${esc(isAll ? 'All sites' : report.site_name)}</div>
      <div style="opacity:.9;margin-top:2px">${esc(name)} · ${esc(date)}</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:22px">
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:14px">
        ${row('Total sales', ngn(s.totalSales), true)}
        ${row('Cash', ngn(s.cash))}
        ${row('POS / Card', ngn(s.pos))}
        ${row('Transfer', ngn(s.transfer))}
        ${s.incentive ? row('Incentive (bonus)', ngn(s.incentive)) : ''}
        ${row('Diesel', '(' + ngn(s.diesel) + ')')}
        ${row('Other expenses', '(' + ngn(s.expenses) + ')')}
        ${row('Balance (sales − diesel)', ngn(balance), true)}
        ${row('Orders', (s.orders || 0).toLocaleString())}
        ${(s.totalLoaded || s.totalBagged) ? row('Production — loaded / bagged', `${(s.totalLoaded || 0).toLocaleString()} / ${(s.totalBagged || 0).toLocaleString()}`) : ''}
      </table>
      ${s.bagReport ? `<div style="font-weight:800;margin:6px 0">Production — ${esc(s.bagReport.product || 'bags')}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px">
        ${row('Opening', (s.bagReport.opening || 0).toLocaleString())}
        ${row('Production', (s.bagReport.produced || 0).toLocaleString())}
        ${row('Total', (s.bagReport.total || 0).toLocaleString(), true)}
        ${row('Sales', (s.bagReport.sold || 0).toLocaleString())}
        ${row('Available', (s.bagReport.available || 0).toLocaleString(), true)}
      </table>` : ''}
      ${dist ? `<div style="font-weight:800;margin:6px 0">Sales distribution</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px">
        <thead><tr><th style="text-align:left;padding:5px 10px;color:#6b7280">Site</th><th style="text-align:right;padding:5px 10px;color:#6b7280">Sales</th><th style="text-align:right;padding:5px 10px;color:#6b7280">Cash</th><th style="text-align:right;padding:5px 10px;color:#6b7280">Transfer/POS</th></tr></thead>
        <tbody>${dist}</tbody>
      </table>` : ''}
      ${opsHtml(s.ops)}
      ${incidents ? `<div style="font-weight:800;margin:6px 0">Incidents / notes</div>
        <div style="white-space:pre-wrap;font-size:13px;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:10px 12px">${esc(incidents)}</div>` : ''}
      <p style="color:#9ca3af;font-size:12px;margin-top:18px">Auto-generated from Daybook sales, production and expenses for ${esc(date)}.</p>
    </div>
  </div>`;
  const info = await getTransporter().sendMail({ from: FROM, to, subject, html });
  return { messageId: info.messageId, subject, to };
}

// Contact-us message → emailed to all admins (reply-to the sender).
async function sendContactMessage({ to, tenantName, fromName, fromEmail, subject, message }) {
  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#1f2937">
    <div style="background:#0ea5e9;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
      <div style="font-size:13px;letter-spacing:2px;opacity:.85">DAYBOOK · CONTACT</div>
      <div style="font-size:20px;font-weight:800">${esc(subject)}</div>
    </div>
    <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:20px">
      <p style="margin:0 0 10px;color:#6b7280;font-size:13px">From <b>${esc(fromName)}</b> &lt;${esc(fromEmail)}&gt;${tenantName ? ' · ' + esc(tenantName) : ''}</p>
      <div style="white-space:pre-wrap;font-size:14px;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:12px 14px">${esc(message)}</div>
      <p style="color:#9ca3af;font-size:12px;margin-top:16px">Reply directly to this email to respond to ${esc(fromName)}.</p>
    </div>
  </div>`;
  const info = await getTransporter().sendMail({ from: FROM, to, replyTo: fromEmail || undefined, subject: `[Daybook] ${subject}`, html });
  return { messageId: info.messageId, to };
}

async function verifyConnection() {
  try { await getTransporter().verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Send a real test email and surface the SMTP server's verdict (accepted /
// rejected / response) so an admin can see exactly where mail goes.
async function sendTest({ to }) {
  const info = await getTransporter().sendMail({
    from: FROM, to,
    subject: 'Daybook email test ✓',
    html: '<p>This is a <b>Daybook SMTP test</b>. If you received this, email delivery is working. Check your Spam/Promotions folder if it landed there.</p>',
  });
  return { messageId: info.messageId, accepted: info.accepted || [], rejected: info.rejected || [], response: info.response, from: FROM };
}

function safeParse(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

module.exports = { sendDailyReport, sendGeneratedReport, sendInvite, sendMidMonthPayroll, sendExpenseNotice, sendContactMessage, verifyConnection, sendTest, FROM };
