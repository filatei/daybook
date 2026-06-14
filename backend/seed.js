/**
 * Daybook — first-boot seed (idempotent)
 *
 * On an empty database it creates:
 *  - platform superadmins (you): SUPERADMIN_EMAILS (default filatei@gmail.com,
 *    filatei@torama.money) — they see and manage every tenant.
 *  - the two starter client companies: Fido Water and Fiafia Water, each with
 *    its real sites (from the daily report) and the default report recipient.
 *
 * Everyone signs in with Google; there are no passwords. New companies can
 * also self-onboard from the app, so this seed only bootstraps your own.
 */
'use strict';

const { v4: uuid } = require('uuid');
const { qone, qall, qrun } = require('./db');

const TENANTS = [
  { slug: 'fido', name: 'Fido Water', brand_color: '#0ea5e9', industry: 'Water production',
    sites: [
      { code: 'KPANSIA', name: 'Kpansia HQ', is_hq: 1 },
      { code: 'KPANSIA-E', name: 'Kpansia East' },
      { code: 'OBUNNA', name: 'Obunna' },
      { code: 'OKUTUKUTU', name: 'Okutukutu' },
      { code: 'SWALI', name: 'Swali' },
      { code: 'YENEGWE', name: 'Yenegwe' },
    ] },
  { slug: 'fiafia', name: 'Fiafia Water', brand_color: '#16a34a', industry: 'Water production',
    sites: [
      { code: 'AKENFA', name: 'Akenfa' },
      { code: 'MBIAMA', name: 'Mbiama' },
    ] },
];

async function ensureSeed() {
  // ── platform superadmins ──────────────────────────────────────────────────
  const supers = (process.env.SUPERADMIN_EMAILS || 'filatei@gmail.com,filatei@torama.money')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const email of supers) {
    const u = await qone('SELECT * FROM users WHERE lower(email)=lower(?)', [email]);
    if (!u) {
      await qrun('INSERT INTO users (id,email,name,is_superadmin) VALUES (?,?,?,1)', [uuid(), email, 'Platform Admin']);
      console.log(`[seed] superadmin ${email}`);
    } else if (!u.is_superadmin) {
      await qrun('UPDATE users SET is_superadmin=1 WHERE id=?', [u.id]);
    }
  }

  // ── starter tenants + sites + default recipient ───────────────────────────
  const recipients = (process.env.DEFAULT_REPORT_RECIPIENTS || 'dailyreports@gtsng.com')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of TENANTS) {
    let tenant = await qone('SELECT * FROM tenants WHERE slug=?', [t.slug]);
    if (!tenant) {
      const id = uuid();
      await qrun('INSERT INTO tenants (id,slug,name,brand_color,industry,plan,pos_source) VALUES (?,?,?,?,?,?,?)',
        [id, t.slug, t.name, t.brand_color, t.industry, 'OWNER', 'FIDO']);
      tenant = { id };
      console.log(`[seed] tenant ${t.name}`);
    } else if (!tenant.pos_source) {
      // backfill existing Fido/Fiafia rows with the POS link + owner plan
      await qrun("UPDATE tenants SET pos_source='FIDO', plan='OWNER' WHERE id=?", [tenant.id]);
    }
    for (const s of t.sites) {
      const exists = await qone('SELECT 1 FROM sites WHERE tenant_id=? AND code=?', [tenant.id, s.code]);
      if (!exists)
        await qrun('INSERT INTO sites (id,tenant_id,code,name,is_hq) VALUES (?,?,?,?,?)',
          [uuid(), tenant.id, s.code, s.name, s.is_hq ? 1 : 0]);
    }
    for (const email of recipients)
      await qrun('INSERT INTO recipients (id,tenant_id,email,name) VALUES (?,?,?,?) ON CONFLICT (tenant_id,email) DO NOTHING',
        [uuid(), tenant.id, email, null]);
  }
}

module.exports = { ensureSeed };
if (require.main === module) {
  const { initDb } = require('./db');
  initDb().then(ensureSeed).then(() => { console.log('[seed] done'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
