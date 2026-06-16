/**
 * Daybook — Expense lifecycle notifications.
 *
 * On creation and on every state change we notify the people who must action
 * the ticket next (in-app notification + email), per Fido's rules:
 *   - Site managers create most tickets and receive EVERY status update.
 *   - DRAFT      → managers validate
 *   - REVIEWED   → Admin / General Manager approve (or decline)
 *   - APPROVED   → managers / accountants / GM / admin pay (+ attach receipt)
 *   - PAID       → managers deliver the funds
 *   - DELIVERED / DECLINED → status update only
 *
 * Best-effort: failures are logged, never thrown, so the API call still succeeds.
 */
'use strict';

const { v4: uuid } = require('uuid');
const { qall, qrun } = require('./db');
const mailer = require('./mailer');

const ngn = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });

const STATE_LABEL = {
  DRAFT: 'Draft', REVIEWED: 'Reviewed', APPROVED: 'Approved',
  PAID: 'Paid', DELIVERED: 'Delivered', DECLINED: 'Declined',
};
const ACTION_NEEDED = {
  DRAFT: 'Validate this expense to send it for approval',
  REVIEWED: 'Approve or decline this expense',
  APPROVED: 'Pay this expense and attach the receipt',
  PAID: 'Deliver the funds to the receiver',
  DELIVERED: '',
  DECLINED: '',
};
const EVENT_TEXT = {
  create: 'created this expense',
  validate: 'validated this expense',
  approve: 'approved this expense',
  decline: 'declined this expense',
  pay: 'marked this expense paid',
  deliver: 'marked the funds delivered',
  reset: 'reset this expense to draft',
};

// Resolve the recipient user-ids for a target state. `mem` = membership rows.
function recipientsFor(mem, expense, targetState) {
  const ids = new Set();
  const add = (rows) => rows.forEach((r) => r.user_id && ids.add(r.user_id));
  // Managers at this site (or company-wide managers) — they get EVERY update.
  const managersAtSite = mem.filter((r) => r.role === 'SITE_MANAGER' && (!r.site_id || r.site_id === expense.site_id));
  add(managersAtSite);
  if (expense.recorded_by) ids.add(expense.recorded_by);           // the creator

  if (targetState === 'REVIEWED') {
    add(mem.filter((r) => r.role === 'ADMIN' || r.role === 'GENERAL_MANAGER'));
  } else if (targetState === 'APPROVED') {
    add(mem.filter((r) => ['ADMIN', 'GENERAL_MANAGER', 'SNR_ACCOUNTANT', 'ACCOUNTANT'].includes(r.role)));
  }
  // DRAFT / PAID / DELIVERED / DECLINED → managers + creator (already added)
  return ids;
}

async function notifyExpenseEvent({ tenant_id, expense, targetState, action, actorId, actorName }) {
  try {
    if (!tenant_id || !expense) return;
    const state = targetState || expense.wf_state || 'DRAFT';
    const mem = await qall('SELECT user_id, role, site_id FROM memberships WHERE tenant_id=? AND status=? AND user_id IS NOT NULL', [tenant_id, 'ACTIVE']);
    const ids = recipientsFor(mem, expense, state);
    ids.delete(actorId);                                            // don't notify the actor
    const userIds = [...ids];
    if (!userIds.length) return;

    const tenant = await qall('SELECT name, brand_color FROM tenants WHERE id=?', [tenant_id]).then((r) => r[0] || {});
    const site = expense.site_id ? await qall('SELECT name FROM sites WHERE id=?', [expense.site_id]).then((r) => r[0]) : null;
    const ref = '#' + (expense.ext_id || String(expense.id).slice(0, 6));
    const label = STATE_LABEL[state] || state;
    const need = ACTION_NEEDED[state] || '';
    const evt = `${actorName || 'Someone'} ${EVENT_TEXT[action] || 'updated this expense'}.`;
    const amt = ngn(expense.amount);

    // 1) In-app notifications
    const title = `Expense ${ref} · ${label}`;
    const body = `${amt}${expense.vendor ? ' · ' + expense.vendor : ''}${need ? ' — ' + need : ''}`;
    for (const u of userIds) {
      await qrun('INSERT INTO notifications (id,tenant_id,user_id,type,title,body,link) VALUES (?,?,?,?,?,?,?)',
        [uuid(), tenant_id, u, 'expense', title, body, 'expenses']);
    }

    // 2) Email — single message to all who must see it
    const ph = userIds.map(() => '?').join(',');
    const users = await qall(`SELECT email FROM users WHERE id IN (${ph})`, userIds);
    const emails = [...new Set(users.map((u) => u.email).filter(Boolean))];
    if (emails.length) {
      await mailer.sendExpenseNotice({
        to: emails,
        tenantName: tenant.name || 'Daybook',
        brand: tenant.brand_color || '#2563eb',
        expense: { ref, amount: expense.amount, vendor: expense.vendor, category: expense.category, description: expense.description, site: site && site.name, date: expense.expense_date },
        stateLabel: label,
        actionNeeded: need,
        actorName,
        eventText: evt,
      }).catch((e) => console.error('[notifyExpense] email failed:', e.message));
    }
  } catch (e) {
    console.error('[notifyExpense] failed:', e.message);
  }
}

module.exports = { notifyExpenseEvent };
