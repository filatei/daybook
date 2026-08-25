/**
 * Daybook — Expense lifecycle notifications.
 *
 * On creation and on every state change we notify the people who must action
 * the ticket next (in-app notification + email), per Fido's rules:
 *   - Site managers create most tickets and receive EVERY status update.
 *   - DRAFT      → managers validate
 *   - REVIEWED   → Snr Accountant / GM / Admin approve (or decline)
 *   - APPROVED   → managers / accountants / GM / admin pay (+ attach receipt)
 *   - PAID       → managers deliver the funds
 *   - DELIVERED / DECLINED → status update only
 *
 * Best-effort: failures are logged, never thrown, so the API call still succeeds.
 */
'use strict';

const { v4: uuid } = require('uuid');
const { qall, qone, qrun } = require('./db');

const ngn = (n) => '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 });

const STATE_LABEL = {
  DRAFT: 'Draft', VALIDATED: 'Validated', REVIEWED: 'Reviewed', APPROVED: 'Approved',
  PAID: 'Paid', DELIVERED: 'Delivered', DECLINED: 'Declined',
};
const ACTION_NEEDED = {
  DRAFT: 'Validate this expense',
  VALIDATED: 'Review this expense to send it for approval',
  REVIEWED: 'Approve or decline this expense',
  APPROVED: 'Pay this expense and attach the receipt',
  PAID: 'Deliver the funds to the receiver',
  DELIVERED: '',
  DECLINED: '',
};

// Resolve the recipient user-ids for a target state. `mem` = membership rows.
function recipientsFor(mem, expense, targetState) {
  const ids = new Set();
  const add = (rows) => rows.forEach((r) => r.user_id && ids.add(r.user_id));
  // Managers at this site (or company-wide managers) — they get EVERY update.
  const managersAtSite = mem.filter((r) => r.role === 'SITE_MANAGER' && (!r.site_id || r.site_id === expense.site_id));
  add(managersAtSite);
  if (expense.recorded_by) ids.add(expense.recorded_by);           // the creator

  if (targetState === 'VALIDATED') {
    // Managers review validated tickets — they're already added above; nothing extra.
  } else if (targetState === 'REVIEWED') {
    add(mem.filter((r) => ['ADMIN', 'GENERAL_MANAGER', 'SNR_ACCOUNTANT'].includes(r.role)));
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

    const ref = '#' + (expense.ext_id || String(expense.id).slice(0, 8));
    const label = STATE_LABEL[state] || state;
    const need = ACTION_NEEDED[state] || '';
    const amt = ngn(expense.amount);
    let siteName = expense.site_name || null;
    if (!siteName && expense.site_id) {
      const s = await qone('SELECT name FROM sites WHERE id=?', [expense.site_id]).catch(() => null);
      siteName = s && s.name;
    }

    const title = `Expense ${ref} · ${label}`;
    const bodyLines = [
      `${amt}${expense.vendor ? ' · ' + expense.vendor : ''}`,
      [siteName, expense.category, expense.expense_date].filter(Boolean).join(' · ') || null,
      expense.description ? String(expense.description).trim().slice(0, 120) : null,
      need || null,
      actorName ? `${label} by ${actorName}` : null,
    ].filter(Boolean);
    const body = bodyLines.join('\n');

    for (const u of userIds) {
      await qrun('INSERT INTO notifications (id,tenant_id,user_id,type,title,body,link) VALUES (?,?,?,?,?,?,?)',
        [uuid(), tenant_id, u, 'expense', title, body, 'expenses']);
      require('./push').sendPushToUser(u, {
        type: 'expense',
        title,
        body,
        link: '/?go=expenses',
        data: {
          expenseId: expense.id,
          state,
          amount: Number(expense.amount) || 0,
          vendor: expense.vendor || null,
          siteId: expense.site_id || null,
          siteName: siteName || null,
        },
      }).catch(() => {});
    }

    // Expense workflow events are IN-APP ONLY (notifications inbox + push) — no
    // emails, per request. The email path (sendExpenseNotice) is intentionally
    // not called here.
  } catch (e) {
    console.error('[notifyExpense] failed:', e.message);
  }
}

module.exports = { notifyExpenseEvent };
