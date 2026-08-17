/**
 * Resolve who should receive a daily / generated / manual report email.
 *
 * Two lists used to live side-by-side and auto-submit only used one of them:
 *   - `recipients` (the original distribution list, still used by re-email)
 *   - `sites.report_email` / `tenants.report_email_all` (Admin → Report emails)
 * Every send path now merges both, plus the person who generated the report.
 */
'use strict';

const { qall } = require('./db');

const REPORTS_INBOX = process.env.REPORTS_INBOX || 'dailyreports@torama.money';

function splitEmails(...vals) {
  const seen = new Set();
  const out = [];
  for (const v of vals) {
    if (v == null || v === '') continue;
    const parts = Array.isArray(v) ? v : String(v).split(/[,;]+/);
    for (const p of parts) {
      const e = String(p).trim();
      if (!e || !e.includes('@')) continue;
      const key = e.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} [opts.tenant]  tenants row (needs id, report_email_all)
 * @param {object} [opts.site]    sites row (needs report_email); omit for all-sites
 * @param {string} [opts.senderEmail]
 * @param {string[]|string} [opts.extra]
 */
async function resolveReportRecipients({ tenant, site, senderEmail, extra } = {}) {
  const list = [];
  const tid = tenant && tenant.id;
  if (tid) {
    try {
      const recs = await qall('SELECT email FROM recipients WHERE tenant_id=? AND active=1', [tid]);
      list.push(...recs.map((r) => r.email));
    } catch { /* table not ready */ }
  }
  const siteAddr = site && site.report_email;
  const allSites = (tenant && tenant.report_email_all) || REPORTS_INBOX;
  list.push(site ? (siteAddr || allSites) : allSites);
  list.push(senderEmail);
  if (extra) list.push(...(Array.isArray(extra) ? extra : [extra]));
  const to = splitEmails(...list);
  if (to.length) return to;
  return splitEmails(process.env.DEFAULT_REPORT_RECIPIENTS, REPORTS_INBOX);
}

module.exports = { splitEmails, resolveReportRecipients, REPORTS_INBOX };
