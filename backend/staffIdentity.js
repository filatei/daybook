/**
 * Staff identity helpers — payroll merge, staff create/import, bank export.
 *
 * Duplicate roster rows are the same person typed differently:
 *   case          "AJIBADE DANIEL" vs "Ajibade Daniel"
 *   extra spaces  "BLESSING  FELIX" vs "BLESSING FELIX"
 *   word order    "CHINEYE OKARA" vs "OKARA CHINEYE"
 *   bank-in-acct  account stored as "FCMB-5933484012" vs "5933484012"
 *
 * nameKey: lowercase, collapse whitespace, sort tokens.
 * accountDigits: digits only (never a Number — that drops leading zeros).
 */
'use strict';

function nameKey(full) {
  return String(full || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
}

function accountDigits(raw) {
  const s = String(raw == null ? '' : raw);
  const seqs = s.match(/\d+/g) || [];
  if (!seqs.length) return '';
  // Prefer a 10-digit NUBAN so "0pay 9020949208" does not keep the 0 from "Opay".
  const ten = seqs.filter((x) => x.length === 10);
  if (ten.length) return ten[ten.length - 1];
  const long = [...seqs].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length);
  if (long.length) return long[0];
  return seqs.join('');
}

/** Pull bank hint + digits from messy "FCMB-0123" / "Access bank / 1755" values. */
function parseBankFields(rawAccount, rawBank) {
  const raw = String(rawAccount == null ? '' : rawAccount).trim();
  const digits = accountDigits(raw);
  let bank = String(rawBank == null ? '' : rawBank).trim();
  if (!bank && raw) {
    const hint = raw
      .replace(/[0-9].*$/, '')
      .replace(/[-_/|,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (hint && /[a-zA-Z]/.test(hint)) bank = hint;
  }
  return { bank_name: bank || null, bank_account: digits || null };
}

/** CSV cell Excel will not coerce to a number (keeps leading zeros). */
function csvAccountText(raw) {
  const d = accountDigits(raw);
  if (!d) return '';
  return `="${d}"`;
}

function findRoot(parent, i) {
  while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
  return i;
}

/**
 * Cluster staff records that are the same person: same nameKey, or the same
 * ≥9-digit account (catches "ISREAL"/"ISRAEL" twins that share a NUBAN).
 */
function groupStaff(staff) {
  const n = staff.length;
  const parent = staff.map((_, i) => i);
  const union = (a, b) => {
    const ra = findRoot(parent, a), rb = findRoot(parent, b);
    if (ra !== rb) parent[rb] = ra;
  };
  const byName = Object.create(null);
  const byAcct = Object.create(null);
  for (let i = 0; i < n; i++) {
    const nk = nameKey(staff[i].full_name);
    if (nk) {
      if (byName[nk] != null) union(i, byName[nk]);
      else byName[nk] = i;
    }
    const ac = accountDigits(staff[i].bank_account);
    if (ac.length >= 9) {
      if (byAcct[ac] != null) union(i, byAcct[ac]);
      else byAcct[ac] = i;
    }
  }
  const groups = Object.create(null);
  for (let i = 0; i < n; i++) {
    const r = findRoot(parent, i);
    (groups[r] = groups[r] || []).push(staff[i]);
  }
  return Object.values(groups);
}

function pickHead(members, sourceIds) {
  if (!members.length) return null;
  let best = members[0], bestScore = -1;
  for (const m of members) {
    const raw = String(m.bank_account || '');
    const d = accountDigits(raw);
    let s = 0;
    if (sourceIds && sourceIds.has(m.id)) s += 100;
    if (d.length === 10) s += 20;
    if (d && !/[a-zA-Z]/.test(raw)) s += 10;
    if (m.bank_name) s += 5;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

function personGroups(staff, sourceIds) {
  return groupStaff(staff).map((members) => {
    const head = pickHead(members, sourceIds);
    const memberIds = members.map((m) => m.id);
    const fromSheet = !!(sourceIds && memberIds.some((id) => sourceIds.has(id)));
    const bagIds = fromSheet ? memberIds.filter((id) => sourceIds.has(id)) : memberIds;
    return { head, members, memberIds, fromSheet, bagIds };
  });
}

/** SQL expression: token-sorted lowercase name of `full_name` (Postgres). */
const STAFF_NAME_KEY_SQL = 'staff_name_key(full_name)';

module.exports = {
  nameKey, accountDigits, parseBankFields, csvAccountText,
  groupStaff, pickHead, personGroups, STAFF_NAME_KEY_SQL,
};
