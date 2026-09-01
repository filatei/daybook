#!/usr/bin/env node
/**
 * Dry-run August 2026 sheet parse + staff auto-create logic (no DB).
 * Usage: node scripts/test-august-sheet-staff.js [path/to/workbook.xls]
 */
'use strict';

const path = require('path');
const XLSX = require('xlsx');
const { nameKey } = require('../backend/staffIdentity');

const xlsNorm = (k) => String(k || '').trim().toUpperCase();
const xlsNum = (v) => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[, ₦]/g, ''));
  return isNaN(n) ? null : n;
};
const xlsGet = (row, names) => {
  for (const k of Object.keys(row)) if (names.includes(xlsNorm(k))) return row[k];
  return undefined;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function payConfigScore(st) {
  const pt = String(st?.pay_type || '').toUpperCase();
  const rate = Number(st?.daily_rate) || 0;
  if (pt === 'MONTHLY' && rate > 0) return 300 + rate;
  if (pt === 'DAILY' && rate > 0) return 200 + rate;
  if (pt === 'PIECE' && (rate > 0 || ['BAGGER', 'LOADER'].includes(String(st?.staff_type || '').toUpperCase()))) return 100 + rate;
  if (pt === 'MONTHLY') return 10;
  return 0;
}
function pickPayrollHead(members) {
  return members.reduce((best, m) => (payConfigScore(m) > payConfigScore(best) ? m : best), members[0]);
}

function resolveStaffForSheet(ext, full, staffPool, opts = {}) {
  const extNorm = ext ? String(ext).replace(/\.0$/, '').trim() : '';
  const nk = nameKey(full);
  const { workspaceTenantId, preferredTenantId, siteByName, location } = opts;
  let candidates = [];
  if (extNorm) {
    candidates = staffPool.filter((s) => {
      const e = s.ext_people_id == null ? '' : String(s.ext_people_id).replace(/\.0$/, '').trim();
      return e === extNorm;
    });
  }
  if (!candidates.length && nk) {
    candidates = staffPool.filter((s) => nameKey(s.full_name) === nk);
  }
  if (!candidates.length) {
    return { staff: null, reason: extNorm ? `no staff with ID ${extNorm}` : (full ? 'name not on the roster' : 'no Staff ID or name') };
  }
  if (candidates.length === 1) return { staff: candidates[0], reason: null };
  const loc = String(location || '').trim().toLowerCase();
  let locTenant = null;
  if (loc && siteByName?.[loc]?.length) {
    const matches = siteByName[loc];
    const site = matches.length === 1 ? matches[0]
      : matches.find((m) => m.tenant_id === preferredTenantId) || matches[0];
    locTenant = site?.tenant_id || null;
  }
  const pickFrom = (list, subset) => (subset.length ? subset : list);
  let pool = candidates;
  if (locTenant) pool = pickFrom(pool, pool.filter((s) => s.tenant_id === locTenant));
  if (workspaceTenantId) pool = pickFrom(pool, pool.filter((s) => s.tenant_id === workspaceTenantId));
  if (preferredTenantId) pool = pickFrom(pool, pool.filter((s) => s.tenant_id === preferredTenantId));
  return { staff: pickPayrollHead(pool), reason: null, resolved_ambiguous: true };
}

const TARGETS = [
  'ABEL AYIBATARI', 'ANETOROFA ABAREOWEI AINA', 'ANNABEL MATTHEW', 'DELIGHT AMADI',
  'DOUBRA DIVINE SUNDAY', 'EKPARAZIBA JUSTUS', 'ESTHER TOBORE FRANK', 'FYNEFACE MORRIS FYNFACE',
  'JOY EDWIN', 'PASCAL CHIBUIKE OCHINANWATA', 'PATRICK ODEY',
];

const file = process.argv[2]
  || path.join(process.env.HOME, 'Downloads/FIDO SALARY SCHEDULE AUGUST 2026.xls');
const wb = XLSX.readFile(file);

const lines = [];
for (const kind of ['REGULAR', 'BAGGERS', 'LOADERS']) {
  const sheetName = Object.keys(wb.Sheets).find((n) => xlsNorm(n) === kind);
  if (!sheetName) continue;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const ext = String(xlsGet(row, ['ID', 'STAFF ID', 'EXT ID']) ?? '').replace(/\.0$/, '').trim();
    const full = [xlsGet(row, ['FIRST NAME']), xlsGet(row, ['MIDDLE NAME']), xlsGet(row, ['LAST NAME'])]
      .map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
    if (/^total$/i.test(full) || (!ext && !full)) continue;
    if (/HIRED/i.test(full)) continue;
    const ded = xlsNum(xlsGet(row, ['DEDUCTION', 'SALARY ADV', 'ADVANCE'])) || 0;
    let gross = 0; let net = 0; let bagged = 0; let loaded = 0; let days = 0;
    if (kind === 'REGULAR') {
      days = xlsNum(xlsGet(row, ['DAYS WORKED', 'DAYS'])) || 0;
      net = xlsNum(xlsGet(row, ['NET SALARY', 'NET PAY', 'NET'])) || 0;
      gross = xlsNum(xlsGet(row, ['GROSS', 'GROSS PAY'])) || (net + ded);
    } else if (kind === 'BAGGERS') {
      bagged = xlsNum(xlsGet(row, ['QTY', 'BAGS BAGGED', 'BAGGED'])) || 0;
      gross = xlsNum(xlsGet(row, ['COMMISSION', 'GROSS', 'NET PAY (COMMISSION)'])) || 0;
      net = xlsNum(xlsGet(row, ['NET PAY (COMMISSION)', 'NET', 'NET PAY'])) || Math.max(0, gross - ded);
    } else {
      loaded = xlsNum(xlsGet(row, ['BAGS LOADED', 'QTY', 'LOADED'])) || 0;
      gross = xlsNum(xlsGet(row, ['NET PAY (COMMISSION)', 'COMMISSION', 'GROSS'])) || 0;
      net = xlsNum(xlsGet(row, ['NET', 'NET PAY'])) || Math.max(0, gross - ded);
    }
    if (!(gross > 0 || net > 0 || days > 0 || loaded > 0 || bagged > 0)) continue;
    lines.push({
      name: full, ext_people_id: ext || null, sheet_kind: kind,
      sheet_row: `${kind}:${i + 2}`, net: round2(net), gross: round2(gross),
      location: String(xlsGet(row, ['LOCATION', 'SITE']) ?? '').trim(),
    });
  }
}

const fido = 'tenant-fido';
const fiafia = 'tenant-fiafia';
// Simulate cross-tenant duplicate imports that blocked the old ambiguous skip.
const roster = [
  { id: 'dup-abel-a', tenant_id: fido, full_name: 'ABEL AYIBATARI', ext_people_id: null, pay_type: 'DAILY', daily_rate: 0, staff_type: 'BAGGER' },
  { id: 'dup-abel-b', tenant_id: fiafia, full_name: 'ABEL  AYIBATARI', ext_people_id: null, pay_type: 'PIECE', daily_rate: 0, staff_type: 'BAGGER' },
  { id: 'dup-pat-a', tenant_id: fido, full_name: 'PATRICK O.', ext_people_id: '3218', pay_type: 'MONTHLY', daily_rate: 90000, staff_type: 'REGULAR' },
  { id: 'dup-pat-b', tenant_id: fiafia, full_name: 'PATRICK ODEY', ext_people_id: '3218', pay_type: 'DAILY', daily_rate: 0, staff_type: 'REGULAR' },
];

const siteByName = {
  okutukutu: [{ id: 's1', tenant_id: fido, name: 'OKUTUKUTU' }],
  mbiama: [{ id: 's2', tenant_id: fido, name: 'MBIAMA' }],
  swali: [{ id: 's3', tenant_id: fido, name: 'SWALI' }],
  obunna: [{ id: 's4', tenant_id: fido, name: 'OBUNNA' }],
  akenfa: [{ id: 's5', tenant_id: fido, name: 'AKENFA' }],
  yenegwe: [{ id: 's6', tenant_id: fido, name: 'YENEGWE' }],
};

const fidoOnlyPool = roster.filter((s) => s.tenant_id === fido);
const bothPool = [...roster];

function simulate(pool, label, workspaceTenantId) {
  let created = 0;
  let linked = 0;
  const still = [];
  for (const line of lines) {
    const ext = line.ext_people_id || '';
    const full = line.name || '';
    const r = resolveStaffForSheet(ext, full, pool, {
      workspaceTenantId, preferredTenantId: fido, siteByName, location: line.location,
    });
    if (r.staff) {
      linked += 1;
      continue;
    }
    // name-only create path
    if (full && line.net > 0) {
      created += 1;
      pool.push({
        id: `new-${created}`, tenant_id: fido, full_name: full, ext_people_id: ext || null,
        pay_type: line.sheet_kind === 'REGULAR' ? 'MONTHLY' : 'PIECE',
        staff_type: line.sheet_kind === 'REGULAR' ? 'REGULAR' : line.sheet_kind.slice(0, -1),
        daily_rate: 0,
      });
      continue;
    }
    still.push({ name: full, reason: r.reason, net: line.net });
  }
  const targetStill = still.filter((s) => TARGETS.includes(s.name));
  console.log(`\n=== ${label} ===`);
  console.log(`Lines: ${lines.length}, linked: ${linked}, would create: ${created}, unmatched: ${still.length}`);
  console.log(`Target rows still unmatched: ${targetStill.length}`);
  if (targetStill.length) console.log(targetStill);
  return targetStill.length;
}

console.log(`Workbook: ${file}`);
console.log(`Parsed pay rows: ${lines.length}, net total: ₦${lines.reduce((a, l) => a + l.net, 0).toLocaleString()}`);

const oldBoth = simulate([...bothPool], 'OLD scope (Fido+Fiafia pool, ambiguous ABEL/PATRICK in roster)', fido);
const newFido = simulate([...fidoOnlyPool], 'NEW scope (Fido-only upload)', fido);
const newBoth = simulate([...bothPool], 'NEW resolve (Fido+Fiafia pool + pick best)', fido);

if (newFido > 0 || newBoth > 0) {
  console.error('\nFAIL: expected all 11 target rows creatable/linkable');
  process.exit(1);
}
console.log('\nOK: August target rows link or create under fixed rules');
